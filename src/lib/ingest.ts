import crypto from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  ingestDeadLetters,
  ingestionEvents,
  manufacturers,
  notifications,
  opsTasks,
  orderItems,
  orders,
  productVariants,
  products,
} from "@/db/schema";
import { computePricing, enrichProduct, slugify, normalizeCategoryAlias, detectCategory } from "@/lib/ai";
import { isAutoUploadEnabled } from "@/lib/telegram";
import { uploadsPermitted } from "@/lib/subscription";
import { classifyMessage, applyResolution } from "@/lib/reconcile";
import {
  canonicalSupplierGroupName,
  categoryForApprovedSupplierGroup,
  isApprovedSupplierGroup,
} from "@/lib/supplier-groups";

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

/** Empty supplier captions intentionally have no semantic duplicate key. */
export const contentFingerprint = (caption: string) => {
  const normalized = normalizeCaption(caption);
  return normalized ? sha(normalized) : null;
};

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || `product-${Date.now()}`;
  for (let i = 0; i < 6; i += 1) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [hit] = await db.select({ id: products.id }).from(products).where(eq(products.slug, candidate)).limit(1);
    if (!hit) return candidate;
  }
  return `${root}-${crypto.randomBytes(3).toString("hex")}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Issue 7 — 3 attempts with exponential backoff. Terminal failures go to the
 * dead-letter queue instead of disappearing.
 */
export async function ingestMessage(msg: RawMessage): Promise<IngestResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await ingestMessageOnce(msg);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(400 * 2 ** (attempt - 1));
    }
  }
  const reason = lastError instanceof Error ? lastError.message : "unknown error";
  await db
    .insert(ingestDeadLetters)
    .values({
      messageId: msg.messageId,
      payload: msg as unknown as Record<string, unknown>,
      error: reason,
      attempts: 3,
      lastAttemptAt: new Date(),
    })
    .catch(() => undefined);
  await db.insert(ingestionEvents).values({
    source: msg.source ?? "whatsapp",
    messageId: msg.messageId,
    rawCaption: (msg.caption || "").slice(0, 4000),
    stage: "failed",
    error: reason,
  }).catch(() => undefined);
  return { messageId: msg.messageId, stage: "failed", reason };
}

/**
 * The full zero-touch pipeline for a single manufacturer message.
 * received → deduped → enriched → priced → published | needs_review
 */
async function ingestMessageOnce(msg: RawMessage): Promise<IngestResult> {
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

  // ---- 0. guard rails -------------------------------------------------
  // Closed JID allowlist: the paired account sees live supplier channels,
  // duplicate-name twins, and unrelated groups. Only the nine fixed JIDs may
  // create products or acknowledge fulfilment.
  if (!isApprovedSupplierGroup(msg.groupId)) {
    await log("rejected", { error: "group_not_authoritative" });
    return { messageId: msg.messageId, stage: "rejected", reason: "unauthorised group" };
  }

  if (!caption && !msg.imageUrl) {
    await log("rejected", { error: "empty message" });
    return { messageId: msg.messageId, stage: "rejected", reason: "empty message" };
  }

  const canonicalGroupName = canonicalSupplierGroupName(msg.groupId);
  if (!msg.groupId || !canonicalGroupName || !isApprovedSupplierGroup(msg.groupId)) {
    await log("rejected", { error: "group_not_authoritative" });
    return { messageId: msg.messageId, stage: "rejected", reason: "group not authoritative" };
  }

  // ---- 0a. SUPPLIER ACKNOWLEDGEMENT: any group message matching
  // "DONE/OK/ACCEPTED/SHIPPED MH######XXXX" flips those order items to accepted.
  // Runs before anything else so supplier confirmations never turn into products.
  // Order numbers are MH + 6-digit date + 10 hex chars = 18 chars total.
  // The previous regex only matched 12-char refs and could never hit a real order.
  const ackMatch = caption.match(/\b(?:done|ok|accepted|shipped)\s+(MH\d{6}[A-F0-9]{6,10})\b/i);
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

  // ---- 1. resolve the single canonical supplier identity ---------------
  let mfr = (await db.select().from(manufacturers).where(eq(manufacturers.sourceGroupId, msg.groupId)).limit(1))[0];
  if (!mfr) {
    const [boundName] = await db
      .select()
      .from(manufacturers)
      .where(eq(manufacturers.canonicalGroupName, canonicalGroupName))
      .limit(1);
    if (boundName && boundName.sourceGroupId !== msg.groupId) {
      // A copied or renamed group with the same display name is not an alias.
      // Only an explicit WA_GROUP_IDS update may authorize a replacement JID.
      await log("rejected", { error: "canonical_group_already_bound" });
      return { messageId: msg.messageId, stage: "rejected", reason: "duplicate supplier group jid" };
    }
    mfr = boundName;
  }

  // The first real message binds an approved canonical name to its stable JID.
  // Dedicated groups carry a fixed category; premium/luxury uses its caption.
  if (!mfr) {
    const configuredCategory = categoryForApprovedSupplierGroup(msg.groupId, msg.groupName);
    const inferred = configuredCategory
      ? { slug: configuredCategory, confidence: 1 }
      : detectCategory("", msg.groupName ?? null, null);
    const name = canonicalGroupName.slice(0, 80);
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
        canonicalGroupName,
        defaultCategoryId: cat?.id ?? null,
        autoPublish: true,
        status: "active",
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      mfr = created;
      await log("supplier_autoregistered", { group: name, category: cat ? inferred.slug : "caption" });
      await db.insert(opsTasks).values({
        kind: "supplier",
        severity: "low",
        title: `Authoritative supplier group bound: ${name}`,
        detail: cat
          ? `Category set to "${inferred.slug}". Valid media posts publish automatically.`
          : "Category is derived from each valid product caption. Media posts publish automatically.",
        actionUrl: "/admin/suppliers",
      });
    } else {
      const [winner] = await db.select().from(manufacturers).where(eq(manufacturers.canonicalGroupName, canonicalGroupName)).limit(1);
      if (!winner || winner.sourceGroupId !== msg.groupId) {
        await log("rejected", { error: "canonical_group_race_or_duplicate" });
        return { messageId: msg.messageId, stage: "rejected", reason: "duplicate supplier group jid" };
      }
      mfr = winner;
    }
  }

  // A channel the operator has removed or paused stops being read here. This
  // check is what makes *Remove channel* in Telegram true rather than cosmetic:
  // without it the JID allowlist alone kept ingesting a "removed" source, and
  // the block was silently undone on the next supplier post.
  if (mfr.status !== "active") {
    await log("rejected", { error: `channel_${mfr.status}`, manufacturerId: mfr.id });
    return { messageId: msg.messageId, stage: "rejected", reason: `channel is ${mfr.status}` };
  }

  if (!mfr.autoPublish) {
    await db.update(manufacturers).set({ autoPublish: true }).where(eq(manufacturers.id, mfr.id));
    mfr = { ...mfr, autoPublish: true };
  }

  // ---- 2. deduplication (message id, image hash, semantic caption) ----
  // Never fingerprint an empty caption: every image-only supplier post would
  // otherwise share sha256("") and be falsely collapsed into one product.
  const captionHash = contentFingerprint(caption);
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
    // Run enrichment BEFORE applying the update so quality, confidence and
    // pricing reflect the actual incoming message — not zeros that would
    // overwrite previously good data.
    const preEnrich = resolution.action === "update"
      ? await enrichProduct({ caption, imageUrl: msg.imageUrl, groupName: msg.groupName ?? mfr.sourceGroupName, defaultCategory: null })
      : null;
    const out = await applyResolution(resolution, {
      messageId: msg.messageId,
      caption,
      imageUrl: msg.imageUrl ?? null,
      contentHash: captionHash,
      imageHash,
      enrichment: preEnrich
        ? { costPrice: preEnrich.costPrice, qualityScore: preEnrich.qualityScore, confidence: preEnrich.confidence }
        : { costPrice: 0, qualityScore: 0, confidence: 0 },
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
          captionHash ? eq(products.contentHash, captionHash) : sql`false`,
          imageHash ? eq(products.imageHash, imageHash) : sql`false`,
        ),
      )
      .limit(1)
  )[0];

  // Cross-supplier caption-similarity duplicate detection.
  //
  // The previous "image similarity" check compared SHA256 digests of Supabase
  // Storage URLs (random strings), not actual image content, producing noise
  // between 0.28-0.38 for every pair. It has been replaced with caption-only
  // similarity, which is the one signal that actually carries meaning.
  if (!dupe && caption.trim()) {
    const recent = await db
      .select({ id: products.id, slug: products.slug, title: products.title })
      .from(products)
      .where(
        and(
          sql`${products.createdAt} > now() - interval '30 days'`,
          mfr.defaultCategoryId ? eq(products.categoryId, mfr.defaultCategoryId) : sql`true`,
        ),
      )
      .orderBy(desc(products.createdAt))
      .limit(50);

    const { captionSimilarity } = await import("@/lib/ai");
    const best = recent
      .map((r) => ({ ...r, sim: captionSimilarity(caption, r.title ?? "") }))
      .sort((a, b) => b.sim - a.sim)[0];

    if (best && best.sim >= 0.78) {
      dupe = { id: best.id, slug: best.slug };
      await log("deduped", { productId: best.id, notes: `caption similarity ${best.sim.toFixed(2)} with ${best.slug}` });
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
  // A verified supplier group is an operational source, not a moderation
  // queue. Valid media with a usable selling price publishes immediately.
  // The incident pause and subscription gates remain hard operational stops.
  const [manualOn, subscription] = await Promise.all([isAutoUploadEnabled(), uploadsPermitted()]);
  const uploadsOn = manualOn && subscription.permitted;
  const heroImage = msg.imageUrls?.[0] ?? msg.imageUrl ?? "";
  // `pricing.price > 0` is NOT a real check: computePricing floors both price
  // and mrp at Math.max(1, ...), so a caption whose price could not be parsed
  // yields costPrice 0 and still satisfies it — publishing a live, orderable
  // product at Rs 1. Gate on the parsed cost instead, which is only non-zero
  // when a genuine rupee figure was found in the supplier's message.
  const hasRealPrice = enrichment.costPrice > 0 && pricing.price > 1;
  const autoOk = uploadsOn && mfr.autoPublish && Boolean(heroImage) && hasRealPrice;

  const status = autoOk ? "published" : "pending_review";
  const slug = await uniqueSlug(`${enrichment.title}-${enrichment.color ?? ""}`);
  const sku = `MH-${(cat?.slug ?? "gen").slice(0, 3).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  const expiresAt = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);

  const inserted = await db
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
      // No fabricated stock: availability is expiry-based. Stock stays 0 unless supplier states quantity.
      stockQty: 0,
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
    .onConflictDoNothing()
    .returning({ id: products.id, slug: products.slug });
  const created = inserted[0];

  if (!created) {
    const [winner] = await db
      .select({ id: products.id, slug: products.slug })
      .from(products)
      .where(
        or(
          eq(products.messageId, msg.messageId),
          captionHash ? eq(products.contentHash, captionHash) : sql`false`,
          imageHash ? eq(products.imageHash, imageHash) : sql`false`,
        ),
      )
      .limit(1);
    if (!winner) throw new Error("product insert conflicted without an identifiable duplicate");
    await log("deduped", { productId: winner.id, race: true });
    return { messageId: msg.messageId, stage: "deduped", productId: winner.id, slug: winner.slug };
  }

  if (enrichment.variants.length) {
    await db.insert(productVariants).values(
      enrichment.variants.map((v, i) => ({
        productId: created.id,
        label: v.label,
        axis: v.axis,
        // Stock per variant is unknown — zero is honest.
        stockQty: 0,
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
        reason: !uploadsOn ? "automatic publishing is paused" : !msg.imageUrl ? "product media is required" : "usable product price was not extracted",
      },
    });
    await db.insert(opsTasks).values({
      kind: "moderation",
      severity: enrichment.qualityScore < 35 ? "high" : "medium",
      title: `Review: ${enrichment.title}`,
      detail: `Automatic publishing is blocked: ${!uploadsOn ? "uploads are paused" : !msg.imageUrl ? "no product media" : "no usable selling price"}. Quality ${enrichment.qualityScore}/100 · confidence ${(enrichment.confidence * 100).toFixed(0)}%.`,
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
  // Expiry is the only lifecycle transition: an expired product leaves the
  // public catalogue and orderable flow (archived tombstone). Stock counts
  // never change availability — there is no low_stock/out_of_stock state.
  const expired = await db
    .update(products)
    .set({ status: "archived", availability: "discontinued", updatedAt: new Date() })
    .where(and(eq(products.status, "published"), sql`${products.expiresAt} < now()`))
    .returning({ id: products.id });

  return { archived: expired.length };
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

/* ---------------- subscription-held release ---------------- */

/**
 * Release products held only because automatic uploads were paused.
 *
 * Group A criteria (observed production strings):
 *  - status = 'pending_review', moderation_reason IS NULL
 *  - hero_image is a valid https URL
 *  - cost_price > 0 AND price > cost_price AND mrp >= price (real price floor: cost parsed from caption)
 *  - category_id IS NOT NULL, message_id IS NOT NULL
 *  - created_at within last 21 days (catalogue-wide 21-day expiry)
 *  - manufacturer active AND auto_publish
 *  - manufacturer source_group_id in authoritative JID list (worker/group-mapping.json)
 *  - ops_tasks.detail = 'Automatic publishing is blocked: uploads are paused. ...' (reason string from ingest insert)
 *
 * On release: status='published', published_at=now(), expires_at=created_at+21d,
 * resolve the ops_task, retire the Telegram moderation alert (notification claimed).
 * Never releases missing-media or missing-price holds.
 *
 * Usage: `npx tsx scripts/release-held.ts --dry-run` for operator SQL, or import and call.
 */
export const HELD_RELEASE_REASON = "uploads are paused";
export const HELD_RELEASE_DETAIL_PREFIX = "Automatic publishing is blocked: uploads are paused.";

export async function releaseSubscriptionHeldProducts(opts: { dryRun?: boolean; limit?: number } = {}) {
  const dryRun = process.argv.includes("--dry-run") || opts.dryRun === true;
  const limit = opts.limit ?? 500;
  // Authoritative JIDs from worker/group-mapping.json (single source via supplier-groups).
  const { approvedSupplierGroups } = await import("@/lib/supplier-groups");
  const jids = approvedSupplierGroups.map((g) => g.jid);
  const sqlText = `
SELECT p.id, p.slug, p.title, p.created_at, p.expires_at, p.hero_image, p.price, p.cost_price, p.mrp,
       p.category_id, p.message_id, m.source_group_id, o.detail
FROM products p
JOIN manufacturers m ON m.id = p.manufacturer_id
JOIN ops_tasks o ON o.entity_id = p.id AND o.status = 'open' AND o.detail LIKE 'Automatic publishing is blocked: uploads are paused.%'
WHERE p.status = 'pending_review'
  AND p.moderation_reason IS NULL
  AND p.hero_image LIKE 'https://%'
  AND p.cost_price > 0 AND p.price > p.cost_price AND p.mrp >= p.price
  AND p.category_id IS NOT NULL AND p.message_id IS NOT NULL
  AND p.created_at > now() - interval '21 days'
  AND m.status = 'active' AND m.auto_publish = true
  AND m.source_group_id = ANY($1)
ORDER BY p.created_at DESC
LIMIT ${Number(limit)};
  `.trim();
  if (dryRun) {
    return { dryRun: true as const, reason: HELD_RELEASE_DETAIL_PREFIX, jids, sql: sqlText, priceFloor: "cost_price > 0 AND price > cost_price AND mrp >= price" };
  }
  const rows = await db.execute(sql`
    SELECT p.id, p.slug, p.created_at
    FROM products p
    JOIN manufacturers m ON m.id = p.manufacturer_id
    JOIN ops_tasks o ON o.entity_id = p.id AND o.status = 'open' AND o.detail LIKE 'Automatic publishing is blocked: uploads are paused.%'
    WHERE p.status = 'pending_review'
      AND p.moderation_reason IS NULL
      AND p.hero_image LIKE 'https://%'
      AND p.cost_price > 0 AND p.price > p.cost_price AND p.mrp >= p.price
      AND p.category_id IS NOT NULL AND p.message_id IS NOT NULL
      AND p.created_at > now() - interval '21 days'
      AND m.status = 'active' AND m.auto_publish = true
      AND m.source_group_id = ANY(${jids})
    ORDER BY p.created_at DESC
    LIMIT ${limit}
  `).then((r) => r.rows as Array<{ id: string; slug: string; created_at: string }>);
  const released: string[] = [];
  for (const row of rows) {
    await db.execute(sql`
      WITH upd AS (
        UPDATE products
        SET status = 'published', published_at = now(), expires_at = created_at + interval '21 days', updated_at = now(), moderation_reason = NULL
        WHERE id = ${row.id}::uuid AND status = 'pending_review' AND moderation_reason IS NULL
        RETURNING id
      )
      UPDATE ops_tasks SET status = 'resolved', resolved_at = now()
      WHERE entity_id = ${row.id}::uuid AND status = 'open' AND detail LIKE 'Automatic publishing is blocked: uploads are paused.%';
    `);
    // Retire Telegram moderation alert: mark related notification claimed (no delete).
    await db.execute(sql`
      UPDATE notifications SET status = 'retired'
      WHERE template = 'moderation_needed' AND payload->>'productId' = ${row.id} AND status IN ('queued','sent');
    `).catch(() => undefined);
    released.push(row.id);
  }
  return { dryRun: false as const, released, count: released.length };
}
