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
import { captionSimilarity, enrichProduct, computePricing } from "@/lib/ai";
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
      costPrice: products.costPrice,
      price: products.price,
      stockQty: products.stockQty,
      heroImage: products.heroImage,
      imageHash: products.imageHash,
      messageId: products.messageId,
      contentHash: products.contentHash,
      status: products.status,
      createdAt: products.createdAt,
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
    const imgExact = p.imageHash && imageHash && p.imageHash === imageHash ? 1 : 0;
    const capSim = captionSimilarity(p.title, caption);
    const sim = Math.max(imgExact, capSim * 0.7);
    if (sim >= 0.78) {
      return {
        action: "reject_duplicate",
        originalProductId: p.id,
        reason: `approximate duplicate of ${p.title} (image ${imgExact.toFixed(2)}, caption ${capSim.toFixed(2)})`,
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

  // Adjacent split-message reconciliation (image album + separate price/caption
  // text posted within 3 minutes by the same supplier).
  const now = Date.now();
  for (const p of recent) {
    if (p.status !== "pending_review") continue;
    const ageSec = (now - new Date(p.createdAt).getTime()) / 1000;
    if (ageSec > 180) continue;

    if (imageUrl && !p.heroImage && p.costPrice > 0) {
      return { action: "update", productId: p.id, changes: ["image"] };
    }
    if (!imageUrl && caption && p.heroImage && p.costPrice === 0) {
      return { action: "update", productId: p.id, changes: ["caption"] };
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
    enrichment: {
      costPrice: number;
      qualityScore: number;
      confidence: number;
      title?: string;
      description?: string;
      shortAnswer?: string;
    };
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
      const [existing] = await db
        .select({
          heroImage: products.heroImage,
          costPrice: products.costPrice,
          status: products.status,
          title: products.title,
          qualityScore: products.qualityScore,
          confidence: products.confidence,
          moderationReason: products.moderationReason,
          manufacturerId: products.manufacturerId,
        })
        .from(products)
        .where(eq(products.id, resolution.productId))
        .limit(1);
      if (resolution.changes.includes("caption") && caption) {
        const re =
          enrichment.title && enrichment.description && enrichment.shortAnswer
            ? { title: enrichment.title, description: enrichment.description, shortAnswer: enrichment.shortAnswer }
            : await enrichProduct({ caption, imageUrl });
        const isGenericFallback = /^(Unisex |Men's |Women's )?(Handbag|Watch|Shoe|Perfume|Sunglass|Apparel|Bag|Shirt)/i.test(re.title) && (existing?.title?.length ?? 0) > re.title.length + 10;
        // Never overwrite a descriptive title with a generic fallback on a price-only follow-up.
        if (!isGenericFallback) {
          patch.title = re.title;
          patch.description = re.description;
          patch.shortAnswer = re.shortAnswer;
        }
        patch.contentHash = contentHash;
      }
      if (enrichment.costPrice > 0) {
        const pricing = computePricing({ costPrice: enrichment.costPrice });
        patch.costPrice = pricing.costPrice;
        patch.mrp = pricing.mrp;
        patch.price = pricing.price;
        patch.resellerPrice = pricing.price;
        // Repost with new price/caption refreshes the 21-day window.
        patch.expiresAt = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
      }
      // Never overwrite higher existing quality/confidence.
      if (!existing || enrichment.qualityScore > (existing.qualityScore ?? 0)) patch.qualityScore = enrichment.qualityScore;
      if (!existing || enrichment.confidence > (existing.confidence ?? 0)) patch.confidence = enrichment.confidence;
      const finalHero = (patch.heroImage as string | undefined) || existing?.heroImage || "";
      const finalCost = (patch.costPrice as number | undefined) ?? existing?.costPrice ?? 0;
      // Gate pending_review -> published: requires active auto-publish manufacturer AND no existing moderation flag.
      let canAutoPublish = false;
      if (existing?.manufacturerId) {
        const { manufacturers } = await import("@/db/schema");
        const [mfr] = await db.select({ autoPublish: manufacturers.autoPublish, status: manufacturers.status }).from(manufacturers).where(eq(manufacturers.id, existing.manufacturerId)).limit(1);
        canAutoPublish = mfr?.status === "active" && mfr?.autoPublish === true;
      }
      if (finalHero.startsWith("http") && finalCost > 0 && existing?.status === "pending_review" && canAutoPublish && !existing?.moderationReason) {
        patch.status = "published";
        patch.publishedAt = new Date();
        patch.moderationReason = null;
        if (!patch.expiresAt) patch.expiresAt = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
      }
      await db.update(products).set(patch as never).where(eq(products.id, resolution.productId));
      return { stage: patch.status === "published" ? "published" : "updated", productId: resolution.productId };
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
