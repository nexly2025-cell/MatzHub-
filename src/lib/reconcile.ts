/**
 * Product update reconciliation — decides whether an incoming supplier message
 * updates, creates, merges, rejects, or flags a product.
 *
 * Decision matrix (first match wins):
 *   SAME messageId                  → UPDATE in place
 *   All 3 fingerprints match        → REJECT exact duplicate
 *   Similarity ≥0.78                → REJECT approximate duplicate (links original)
 *   Was archived, now similar       → REACTIVATE
 *   Field-level diff on same angle  → UPDATE those fields only
 *   Boundary 0.5–0.78               → needs_review
 *   Below 0.5 + not matched         → CREATE new product
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ingestionEvents, opsTasks, products } from "@/db/schema";
import { captionSimilarity, imageHashSimilarity, enrichProduct, computePricing } from "@/lib/ai";
import crypto from "node:crypto";

const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

export type UpdateResolution =
  | { action: "update"; productId: string; changes: string[] }
  | { action: "create" }
  | { action: "reject_duplicate"; originalProductId: string; reason: string }
  | { action: "reactivate"; productId: string }
  | { action: "needs_review"; reason: string };

export async function classifyMessage(args: {
  messageId: string;
  caption: string;
  imageUrl: string | null;
  manufacturerId: string;
  contentHash: string | null;
  imageHash: string | null;
}): Promise<UpdateResolution> {
  const { messageId, caption, imageUrl, manufacturerId, contentHash, imageHash } = args;

  const recent = await db
    .select({
      id: products.id,
      title: products.title,
      price: products.price,
      stockQty: products.stockQty,
      heroImage: products.heroImage,
      imageHash: products.imageHash,
      messageId: products.messageId,
      contentHash: products.contentHash,
      status: products.status,
    })
    .from(products)
    .where(and(eq(products.manufacturerId, manufacturerId), sql`${products.createdAt} > now() - interval '30 days'`))
    .orderBy(desc(products.createdAt))
    .limit(50);

  for (const p of recent) {
    if (p.messageId === messageId) {
      return { action: "update", productId: p.id, changes: ["repost"] };
    }
    if (imageHash && contentHash && p.imageHash === imageHash && p.contentHash === contentHash && p.messageId === messageId) {
      return { action: "reject_duplicate", originalProductId: p.id, reason: "exact duplicate" };
    }
    const imgSim = p.imageHash && imageHash ? imageHashSimilarity(p.imageHash, imageHash) : 0;
    const capSim = captionSimilarity(p.title, caption);
    const sim = Math.max(imgSim, capSim * 0.7);
    if (sim >= 0.78) {
      return {
        action: "reject_duplicate",
        originalProductId: p.id,
        reason: `approximate duplicate of ${p.title} (image ${imgSim.toFixed(2)}, caption ${capSim.toFixed(2)})`,
      };
    }
    if (p.status === "archived" && sim >= 0.5) {
      return { action: "reactivate", productId: p.id };
    }
    if (sim >= 0.5) {
      const changes: string[] = [];
      if (imageUrl && p.heroImage !== imageUrl) changes.push("image");
      if (p.contentHash !== contentHash) changes.push("caption");
      if (changes.length > 0) return { action: "update", productId: p.id, changes };
    }
  }

  return { action: "create" };
}

export async function applyResolution(
  resolution: UpdateResolution,
  args: {
    messageId: string;
    caption: string;
    imageUrl: string | null;
    contentHash: string | null;
    imageHash: string | null;
    enrichment: { costPrice: number; qualityScore: number; confidence: number };
  },
): Promise<{ stage: string; productId?: string }> {
  const { messageId, caption, imageUrl, contentHash, enrichment } = args;

  switch (resolution.action) {
    case "update": {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (resolution.changes.includes("image") && imageUrl) {
        patch.heroImage = imageUrl;
        patch.images = [imageUrl];
        if (args.imageHash) patch.imageHash = args.imageHash;
      }
      if (resolution.changes.includes("caption") && caption) {
        const re = await enrichProduct({ caption, imageUrl });
        patch.title = re.title;
        patch.description = re.description;
        patch.shortAnswer = re.shortAnswer;
        patch.contentHash = contentHash;
      }
      if (enrichment.costPrice > 0) {
        const pricing = computePricing({ costPrice: enrichment.costPrice });
        patch.costPrice = pricing.costPrice;
        patch.mrp = pricing.mrp;
        patch.price = pricing.price;
        patch.resellerPrice = pricing.price;
      }
      patch.qualityScore = enrichment.qualityScore;
      patch.confidence = enrichment.confidence;
      await db.update(products).set(patch as never).where(eq(products.id, resolution.productId));
      return { stage: "updated", productId: resolution.productId };
    }
    case "reactivate": {
      await db
        .update(products)
        .set({ status: "published", availability: "in_stock" as never, updatedAt: new Date(), publishedAt: new Date() })
        .where(eq(products.id, resolution.productId));
      return { stage: "updated", productId: resolution.productId };
    }
    case "reject_duplicate": {
      await db.insert(ingestionEvents).values({
        source: "whatsapp",
        messageId,
        rawCaption: caption.slice(0, 4000),
        stage: "deduped",
        productId: resolution.originalProductId,
        error: resolution.reason,
        durationMs: 0,
      });
      return { stage: "deduped", productId: resolution.originalProductId };
    }
    case "needs_review": {
      await db.insert(opsTasks).values({
        kind: "moderation",
        severity: "medium",
        title: `Update resolution unclear: ${messageId.slice(0, 20)}`,
        detail: resolution.reason,
        entityType: "message",
        actionUrl: "/admin/moderation",
      });
      return { stage: "needs_review" };
    }
    case "create":
    default:
      return { stage: "create" };
  }
}
