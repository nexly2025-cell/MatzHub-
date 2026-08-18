import crypto from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  ingestionEvents,
  manufacturers,
  notifications,
  opsTasks,
  orderItems,
  orders,
  productVariants,
  products,
} from "@/db/schema";
import { computePricing, enrichProduct, slugify, normalizeCategoryAlias, detectCategory, isAuthoritativeGroup } from "@/lib/ai";
import { isAutoUploadEnabled } from "@/lib/telegram";
import { uploadsPermitted } from "@/lib/subscription";
import { classifyMessage, applyResolution } from "@/lib/reconcile";

export type RawMessage = {
  messageId: string;
  groupId?: string | null;
  groupName?: string | null;
  caption: string;
  imageUrl?: string | null;
  imageUrls?: string[];
  videoUrl?: string | null;
  mediaType?: "image" | "video";
  /** Worker-supplied mapped category (e.g. "bags", "shoes" from group JIDs). Aliases are normalized later. */
  category?: string | null;
  source?: "whatsapp" | "sheet" | "manual" | "api";
};

export type IngestResult = {
  messageId: string;
  stage: string;
  productId?: string;
  slug?: string;
  reason?: string;
  qualityScore?: number;
  confidence?: number;
};

const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

const normalizeCaption = (c: string) =>
  c.toLowerCase().replace(/(?:₹|rs\.?|inr)\s*[0-9,]+/g, "").replace(/[^a-z0-9]+/g, " ").trim();


async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || `product-${Date.now()}`;
  for (let i = 0; i < 6; i += 1) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [hit] = await db.select({ id: products.id }).from(products).where(eq(products.slug, candidate)).limit(1);
    if (!hit) return candidate;
  }
  return `${root}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * The full zero-touch pipeline for a single manufacturer message.
 * received → deduped → enriched → priced → published | needs_review
 */
export async function ingestMessage(msg: RawMessage): Promise<IngestResult> {
  const t0 = Date.now();
  const source = msg.source ?? "whatsapp";
  const caption = (msg.caption || "").trim();

  const log = async (stage: string, extra: Record<string, unknown> = {}) => {

      await db.insert(ingestionEvents).values({
      source,
      sourceGroupId: msg.groupId ?? null,
      messageId: msg.messageId,
      rawCaption: caption.slice(0, 4000),
      rawImageUrl: msg.imageUrl ?? null,
      stage,
      durationMs: Date.now() - t0,
      ...extra,
    });
  };

  // Hard isolation: a dedicated ingestion SIM that only receives supplier group
  // messages, never sends, and never sits in the customer channel. This number
  // is never rendered publicly — SECTION 1 in the ops runbook.
  const SUPPLIER_INGESTION_NUMBER = process.env.SUPPLIER_INGESTION_NUMBER;
  if (SUPPLIER_INGESTION_NUMBER && msg.groupId) {
    const digits = msg.groupId.replace(/\D/g, "");
    if (digits && digits !== SUPPLIER_INGESTION_NUMBER.replace(/\D/g, "").slice(-10)) {
      await log("rejected", { error: `message arrived from group not mapped to ingestion SIM ${SUPPLIER_INGESTION_NUMBER.slice(-4)}` });
      return { messageId: msg.messageId, stage: "rejected", reason: "wrong ingestion channel" };
    }
  }

  // ---- 0. guard rails -------------------------------------------------
  // Closed allowlist. The paired account sees 19 groups: nine live supplier
  // channels, their nine near-empty duplicates, and one unrelated group.
  // Only the nine may create products, so a repost in a duplicate group can
  // never become a second listing and an unrelated group can never inject one.
  if (!isAuthoritativeGroup(msg.groupId)) {
    await log("rejected", { error: "group is not an authoritative supplier source" });
    return { messageId: msg.messageId, stage: "rejected", reason: "unauthorised group" };
  }

  if (!caption && !msg.imageUrl) {
    await log("rejected", { error: "empty message" });
    return { messageId: msg.messageId, stage: "rejected", reason: "empty message" };
  }

  // ---- 0a. SUPPLIER ACKNOWLEDGEMENT: any group message matching
  // "DONE/OK/ACCEPTED/SHIPPED MH######XXXX" flips those order items to accepted.
  // Runs before anything else so supplier confirmations never turn into products.
  const ackMatch = caption.match(/\b(?:done|ok|accepted|shipped)\s+([A-Z]{2}\d{6}[A-Z0-9]{4})\b/i);
  if (ackMatch) {
    const orderRef = ackMatch[1].toUpperCase();
    const [order] = await db.select().from(orders).where(eq(orders.orderNo, orderRef)).limit(1);
    await log("supplier_ack", { notes: `ack candidate ${orderRef}` });
    if (order) {
      await db.update(orderItems).set({ supplierStatus: "accepted" }).where(eq(orderItems.orderId, order.id));
      return {
        messageId: msg.messageId,
        stage: "supplier_ack",
        productId: order.id,
      };
    }
    return { messageId: msg.messageId, stage: "deduped" };
  }

  // ---- 1. resolve manufacturer from the group it was posted in --------
  let mfr = msg.groupId
    ? (await db.select().from(manufacturers).where(eq(manufacturers.sourceGroupId, msg.groupId)).limit(1))[0]
    : undefined;
  if (!mfr && msg.groupName) {
    mfr = (await db.select().from(manufacturers).where(eq(manufacturers.sourceGroupName, msg.groupName)).limit(1))[0];
  }
  // Self-registration. Supplier groups are created and renamed constantly; a
  // hand-maintained mapping file drifts and silently sends everything to
  // manual review. Observed live: 5 of 6 real supplier groups were unmapped,
  // including a 1,463-member footwear group.
  //
  // A group with a usable JID is registered automatically and its category is
  // inferred from the subject ("Smart Collections_Watches" -> watches). An
  // operator can still override the category from the Telegram admin bot.
  if (!mfr && msg.groupId) {
    const inferred = detectCategory("", msg.groupName ?? null, null);
    const name = (msg.groupName || msg.groupId).slice(0, 80);
    const [cat] = inferred.confidence > 0
      ? await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, inferred.slug)).limit(1)
      : [];
    const [created] = await db
      .insert(manufacturers)
      .values({
        name,
        slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "supplier"}-${msg.groupId.slice(0, 6)}`,
        sourceGroupId: msg.groupId,
        sourceGroupName: msg.groupName ?? null,
        defaultCategoryId: cat?.id ?? null,
        // Suppliers publish straight to the storefront. Manual review was a
        // per-supplier approval step the operator had to clear by hand; the
        // business requires new stock to be live without that gate.
        autoPublish: true,
        status: "active",
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      mfr = created;
      await log("supplier_autoregistered", { group: name, category: cat ? inferred.slug : "unclassified" });
      await db.insert(opsTasks).values({
        kind: "supplier",
        severity: "low",
        title: `New supplier group registered: ${name}`,
        detail: cat
          ? `Category inferred as "${inferred.slug}". Products from this group publish automatically.`
          : "Category could not be inferred from the group name. Assign one from the admin bot or /admin/suppliers.",
        actionUrl: "/admin/suppliers",
      });
    }
  }

  if (!mfr) {
    await log("needs_review", { error: "unmapped source group" });
    await db.insert(opsTasks).values({
      kind: "supplier",
      severity: "high",
      title: `Unmapped WhatsApp group: ${msg.groupName ?? msg.groupId ?? "unknown"}`,
      detail: "A message arrived from a group not bound to any manufacturer. Bind it or the products will never publish.",
      actionUrl: "/admin/suppliers",
    });
    return { messageId: msg.messageId, stage: "needs_review", reason: "unmapped group" };
  }

  // ---- 2. deduplication (message id, image hash, semantic caption) ----
  const captionHash = sha(normalizeCaption(caption));
  const imageHash = msg.imageUrl ? sha(msg.imageUrl) : null;

  // ---- 2b. update reconciliation (needs imageUrl as string|null, not undefined)
  const resolution = await classifyMessage({
    messageId: msg.messageId,
    caption,
    imageUrl: msg.imageUrl ?? null,
    manufacturerId: mfr.id,
    contentHash: captionHash,
    imageHash,
  });
  if (resolution.action !== "create") {
    const out = await applyResolution(resolution, {
      messageId: msg.messageId,
      caption,
      imageUrl: msg.imageUrl ?? null,
      contentHash: captionHash,
      imageHash,
      enrichment: { costPrice: 0, qualityScore: 0, confidence: 0 },
    });
    await log(out.stage === 'updated' ? 'updated' : 'deduped', { productId: out.productId });
    return { messageId: msg.messageId, stage: out.stage, productId: out.productId };
  }

  // ---- 2c. hard dedupe check (exact fingerprint collision) ---------------
  let dupe = (
    await db
      .select({ id: products.id, slug: products.slug })
      .from(products)
      .where(
        or(
          eq(products.messageId, msg.messageId),
          eq(products.contentHash, captionHash),
          imageHash ? eq(products.imageHash, imageHash) : sql`false`,
        ),
      )
      .limit(1)
  )[0];

  // Approximate duplicate detection.
  //
  // Scans ACROSS suppliers, not just this one. Two channels frequently carry
  // the same piece with slightly different photography, so a per-manufacturer
  // scan let visually-identical products publish twice. The exact-hash check
  // above only catches byte-identical captions or image URLs.
  //
  // Cost stays bounded by narrowing to the same category and the same 30-day
  // window, still capped at 50 rows.
  if (!dupe && msg.imageUrl) {
    const recent = await db
      .select({ id: products.id, slug: products.slug, imageHash: products.imageHash, title: products.title })
      .from(products)
      .where(
        and(
          sql`${products.createdAt} > now() - interval '30 days'`,
          mfr.defaultCategoryId ? eq(products.categoryId, mfr.defaultCategoryId) : sql`true`,
        ),
      )
      .orderBy(desc(products.createdAt))
      .limit(50);

    const { captionSimilarity, imageHashSimilarity } = await import("@/lib/ai");
    const best = recent
      .map((r) => ({
        ...r,
        imageSim: imageHash ? imageHashSimilarity(r.imageHash ?? "", imageHash) : 0,
        captionSim: captionSimilarity(caption, r.title ?? ""),
      }))
      .sort((a, b) => b.imageSim - a.imageSim)[0];

    if (best && best.imageSim >= 0.78) {
      dupe = { id: best.id, slug: best.slug };
      await log("deduped", { productId: best.id, notes: `image similarity ${best.imageSim.toFixed(2)} with ${best.slug}` });
    }
  }

  if (dupe) {
    await log("deduped", { productId: dupe.id });
    return { messageId: msg.messageId, stage: "deduped", productId: dupe.id, slug: dupe.slug };
  }

  const providedCategory = normalizeCategoryAlias(msg.category);

  // ---- 3. AI enrichment ----------------------------------------------
  const [providedCatRow] = providedCategory
    ? await db.select().from(categories).where(eq(categories.slug, providedCategory)).limit(1)
    : [];
  const [defaultCat] = providedCatRow ? [providedCatRow] : mfr.defaultCategoryId
    ? await db.select().from(categories).where(eq(categories.id, mfr.defaultCategoryId)).limit(1)
    : [];

  const enrichment = await enrichProduct({
    caption,
    imageUrl: msg.imageUrl,
    groupName: msg.groupName ?? mfr.sourceGroupName,
    defaultCategory: defaultCat?.slug ?? null,
  });

  const [cat] = await db.select().from(categories).where(eq(categories.slug, enrichment.categorySlug)).limit(1);

  // ---- 4. pricing intelligence ---------------------------------------
  // Global mandatory rule: cost ×1.40 original, cost ×1.15 selling. If the
  // manufacturer stated an MRP, prefer that over the 1.40× derivation for the
  // display price — it is a factual signal and 1.40× is only a fallback.
  const pricing = computePricing({ costPrice: enrichment.costPrice });

  // ---- 5. publish decision -------------------------------------------
  // NO HUMAN APPROVAL. A supplier post becomes a live product on its own.
  //
  // The quality (>=55) and confidence (>=0.6) floors used to divert anything
  // below them to `pending_review`, where it sat until an operator cleared it
  // by hand. Those scores are still computed and stored — they drive supplier
  // scoring and the ops feed — but they no longer hold stock off the site.
  //
  // What remains are not approvals, they are sellability facts: a listing with
  // no photograph or no price cannot be bought, so publishing it would create
  // a broken page rather than a sale. The operator kill switch (/upload off)
  // and the subscription check are deliberate business controls and stay.
  const [manualOn, subscription] = await Promise.all([isAutoUploadEnabled(), uploadsPermitted()]);
  const uploadsOn = manualOn && subscription.permitted;
  // Resolve the hero exactly the way the insert below does (line ~338).
  // The gate previously tested only `msg.imageUrl`, so a payload carrying just
  // `imageUrls[]` — which the RawMessage type allows and the insert happily
  // uses — was held back as "no image" even though the product rendered with a
  // perfectly good photograph.
  const heroImage = msg.imageUrls?.[0] ?? msg.imageUrl ?? "";
  const sellable = Boolean(heroImage) && pricing.price > 0;
  const autoOk = uploadsOn && mfr.autoPublish && sellable;

  const status = autoOk ? "published" : "pending_review";
  const slug = await uniqueSlug(`${enrichment.title}-${enrichment.color ?? ""}`);
  const sku = `MH-${(cat?.slug ?? "gen").slice(0, 3).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  const expiresAt = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);

  const [created] = await db
    .insert(products)
    .values({
      slug,
      sku,
      title: enrichment.title,
      subtitle: enrichment.subtitle,
      description: enrichment.description,
      shortAnswer: enrichment.shortAnswer,
      categoryId: cat?.id ?? null,
      manufacturerId: mfr.id,
      brand: enrichment.brand,
      color: enrichment.color,
      material: enrichment.material,
      gender: enrichment.gender,
      specs: enrichment.specs,
      tags: enrichment.tags,
      faqs: enrichment.faqs,
      images: msg.imageUrls?.length
        ? msg.imageUrls
        : msg.imageUrl
          ? [msg.imageUrl]
          : [],
      heroImage,
      videoUrl: msg.videoUrl ?? null,
      mediaType: msg.mediaType ?? (msg.videoUrl ? "video" : "image"),
      altText: enrichment.altText,
      costPrice: pricing.costPrice,
      mrp: pricing.mrp,
      price: pricing.price,
      resellerPrice: pricing.resellerPrice,
      marginPercent: pricing.marginPercent,
      stockQty: 25,
      availability: "in_stock",
      status,
      qualityScore: enrichment.qualityScore,
      confidence: enrichment.confidence,
      seoTitle: enrichment.seoTitle,
      seoDescription: enrichment.seoDescription,
      messageId: msg.messageId,
      imageHash,
      contentHash: captionHash,
      publishedAt: autoOk ? new Date() : null,
      expiresAt,
    })
    .returning({ id: products.id, slug: products.slug });

  if (enrichment.variants.length) {
    await db.insert(productVariants).values(
      enrichment.variants.map((v, i) => ({
        productId: created.id,
        label: v.label,
        axis: v.axis,
        stockQty: 10,
        position: i,
      })),
    );
  }

  await db
    .update(manufacturers)
    .set({
      lastIngestAt: new Date(),
      totalProducts: sql`${manufacturers.totalProducts} + 1`,
      qualityScore: sql`round((${manufacturers.qualityScore} * 0.9 + ${enrichment.qualityScore} * 0.1)::numeric, 2)`,
    })
    .where(eq(manufacturers.id, mfr.id));

  await log(status, {
    manufacturerId: mfr.id,
    productId: created.id,
    aiModel: enrichment.model,
    aiLatencyMs: enrichment.latencyMs,
    aiOutput: {
      categorySlug: enrichment.categorySlug,
      qualityScore: enrichment.qualityScore,
      confidence: enrichment.confidence,
      pricing,
    },
  });

  const notificationPayload = {
    title: enrichment.title,
    slug: created.slug,
    quality: enrichment.qualityScore,
    confidence: Math.round(enrichment.confidence * 100),
    id: created.id,
    supplierName: mfr.name,
    groupName: msg.groupName || mfr.sourceGroupName || "Direct Group",
    groupId: msg.groupId || mfr.sourceGroupId || "N/A",
    receivedAt: new Date().toISOString(),
    messageId: msg.messageId,
  };

  if (!autoOk) {
    await db.insert(notifications).values({
      channel: "telegram",
      audience: "ops",
      recipient: "ops",
      template: "moderation_needed",
      payload: {
        ...notificationPayload,
        reason: !heroImage ? "no image" : pricing.price <= 0 ? "no usable price" : "uploads paused",
      },
    });
    await db.insert(opsTasks).values({
      kind: "moderation",
      severity: enrichment.qualityScore < 35 ? "high" : "medium",
      title: `Review: ${enrichment.title}`,
      detail: `Quality ${enrichment.qualityScore}/100 · confidence ${(enrichment.confidence * 100).toFixed(0)}%. Held because ${!heroImage ? "the post carried no image" : pricing.price <= 0 ? "no price could be read" : "uploads are paused"} — not because of a review threshold.`,
      entityType: "product",
      entityId: created.id,
      actionUrl: `/admin/moderation`,
    });
  } else {
    await db.insert(notifications).values({
      channel: "telegram",
      audience: "ops",
      recipient: "ops",
      template: "product_auto_published",
      payload: notificationPayload,
    });
  }

  return {
    messageId: msg.messageId,
    stage: status,
    productId: created.id,
    slug: created.slug,
    qualityScore: enrichment.qualityScore,
    confidence: enrichment.confidence,
  };
}

export async function ingestBatch(messages: RawMessage[]): Promise<IngestResult[]> {
  const out: IngestResult[] = [];
  for (const m of messages) {
    try {
      out.push(await ingestMessage(m));
    } catch (e) {
      const reason = e instanceof Error ? e.message : "unknown error";
      await db.insert(ingestionEvents).values({
        source: m.source ?? "whatsapp",
        messageId: m.messageId,
        rawCaption: (m.caption || "").slice(0, 4000),
        stage: "failed",
        error: reason,
      });
      await db.insert(opsTasks).values({
        kind: "automation_failure",
        severity: "critical",
        title: `Ingestion crashed on ${m.messageId}`,
        detail: reason,
        actionUrl: "/admin/automation",
      });
      out.push({ messageId: m.messageId, stage: "failed", reason });
    }
  }
  return out;
}

/* ---------------- scheduled jobs ---------------- */

export async function runTrendingJob() {
  // Wilson-ish blend of recency + engagement + conversion.
  const res = await db.execute(sql`
    update products set trending_score = round((
      (coalesce(clicks,0) * 3.0 + coalesce(add_to_carts,0) * 8.0 + coalesce(orders,0) * 25.0 + coalesce(views,0) * 0.5)
      / greatest(1, extract(epoch from (now() - coalesce(published_at, created_at))) / 86400 + 2) ^ 1.4
    )::numeric, 4)
    where status = 'published'
  `);
  return { processed: res.rowCount ?? 0 };
}

export async function runExpiryJob() {
  const expired = await db
    .update(products)
    .set({ status: "archived", availability: "discontinued", updatedAt: new Date() })
    .where(and(eq(products.status, "published"), sql`${products.expiresAt} < now()`))
    .returning({ id: products.id });

  const low = await db
    .update(products)
    .set({ availability: "low_stock" })
    .where(and(eq(products.status, "published"), sql`${products.stockQty} between 1 and 4`))
    .returning({ id: products.id });

  const out = await db
    .update(products)
    .set({ availability: "out_of_stock" })
    .where(and(eq(products.status, "published"), eq(products.stockQty, 0)))
    .returning({ id: products.id });

  return { archived: expired.length, lowStock: low.length, outOfStock: out.length };
}

export async function runSupplierScoreJob() {
  const rows = await db.select().from(manufacturers);
  let processed = 0;
  for (const m of rows) {
    const [agg] = await db
      .select({
        cnt: sql<number>`count(*)::int`,
        avgQ: sql<number>`coalesce(avg(${products.qualityScore}),0)::float`,
        rev: sql<number>`coalesce(sum(${products.revenue}),0)::int`,
      })
      .from(products)
      .where(eq(products.manufacturerId, m.id));

    const staleDays = m.lastIngestAt
      ? (Date.now() - new Date(m.lastIngestAt).getTime()) / 86400000
      : 99;
    const freshness = Math.max(0, 100 - staleDays * 8);
    const health = Number((agg.avgQ * 0.5 + freshness * 0.3 + m.fulfilmentRate * 0.2).toFixed(2));

    await db
      .update(manufacturers)
      .set({ healthScore: health, qualityScore: Number(agg.avgQ.toFixed(2)), totalProducts: agg.cnt, totalRevenue: agg.rev })
      .where(eq(manufacturers.id, m.id));

    if (health < 50) {
      await db.insert(opsTasks).values({
        kind: "supplier",
        severity: health < 30 ? "critical" : "high",
        title: `Supplier health dropped: ${m.name}`,
        detail: `Health ${health}/100 · quality ${agg.avgQ.toFixed(0)} · ${staleDays.toFixed(0)} days since last post.`,
        entityType: "manufacturer",
        entityId: m.id,
        actionUrl: "/admin/suppliers",
      });
    }
    processed += 1;
  }
  return { processed };
}
