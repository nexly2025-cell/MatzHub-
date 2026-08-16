import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

/* ============================================================
   IDENTITY & ACCESS
   ============================================================ */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    email: text("email"),
    name: text("name"),
    role: text("role").notNull().default("customer"), // customer | reseller | manufacturer | ops | admin
    tier: text("tier").notNull().default("bronze"), // bronze | silver | gold | platinum
    loyaltyPoints: integer("loyalty_points").notNull().default(0),
    referralCode: text("referral_code").notNull(),
    referredBy: uuid("referred_by"),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_phone_uidx").on(t.phone),
    uniqueIndex("users_referral_code_uidx").on(t.referralCode),
    index("users_role_idx").on(t.role),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_uidx").on(t.token), index("sessions_user_idx").on(t.userId)],
);

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("otp_phone_idx").on(t.phone)],
);

/* ============================================================
   SUPPLY SIDE
   ============================================================ */

export const manufacturers = pgTable(
  "manufacturers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    phone: text("phone"),
    city: text("city"),
    // WhatsApp group binding for automated ingestion
    sourceChannel: text("source_channel").notNull().default("whatsapp"),
    sourceGroupId: text("source_group_id"),
    sourceGroupName: text("source_group_name"),
    defaultCategoryId: uuid("default_category_id"),
    // Pricing is global. Cost×1.40 original, cost×1.15 selling. This column records the applied margin.
    autoPublish: boolean("auto_publish").notNull().default(true),
    // Supplier health scoring — computed nightly
    healthScore: real("health_score").notNull().default(100),
    qualityScore: real("quality_score").notNull().default(0),
    fulfilmentRate: real("fulfilment_rate").notNull().default(100),
    avgResponseMinutes: integer("avg_response_minutes").notNull().default(0),
    totalProducts: integer("total_products").notNull().default(0),
    totalRevenue: integer("total_revenue").notNull().default(0),
    status: text("status").notNull().default("active"), // active | paused | blocked
    lastIngestAt: timestamp("last_ingest_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("manufacturers_slug_uidx").on(t.slug),
    index("manufacturers_status_idx").on(t.status),
    // Looked up once per ingested WhatsApp message to resolve the supplier.
    // Without this the ingestion hot path is a sequential scan.
    uniqueIndex("manufacturers_source_group_uidx").on(t.sourceGroupId),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    parentId: uuid("parent_id"),
    heroImage: text("hero_image"),
    icon: text("icon"),
    // AEO/GEO content surface
    shortAnswer: text("short_answer").notNull().default(""),
    buyingGuide: text("buying_guide").notNull().default(""),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    faqs: jsonb("faqs").$type<Array<{ q: string; a: string }>>().notNull().default([]),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    position: integer("position").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("categories_slug_uidx").on(t.slug), index("categories_parent_idx").on(t.parentId)],
);

/* ============================================================
   CATALOG
   ============================================================ */

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    sku: text("sku").notNull(),

    title: text("title").notNull(),
    subtitle: text("subtitle"),
    description: text("description").notNull().default(""),
    shortAnswer: text("short_answer").notNull().default(""), // AEO extractable snippet

    categoryId: uuid("category_id").references(() => categories.id),
    manufacturerId: uuid("manufacturer_id").references(() => manufacturers.id),

    brand: text("brand"),
    color: text("color"),
    material: text("material"),
    gender: text("gender").notNull().default("unisex"),
    specs: jsonb("specs").$type<Record<string, string>>().notNull().default({}),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    faqs: jsonb("faqs").$type<Array<{ q: string; a: string }>>().notNull().default([]),

    // Ordered media: images[0] is the cover used on cards; gallery shows the rest.
    // Videos: videoUrl holds the mp4; images[] holds extracted candidate frames;
    // heroImage is the chosen frame. Admin can swap cover to any candidate.
    images: jsonb("images").$type<string[]>().notNull().default([]),
    heroImage: text("hero_image").notNull(),
    videoUrl: text("video_url"),
    mediaType: text("media_type").notNull().default("image"), // image | video
    altText: text("alt_text").notNull().default(""),

    // Money in whole INR.
    // costPrice  = manufacturer's price. ADMIN ONLY. Never leaves the server for non-admins.
    // mrp        = "Original Price" shown struck-through in red  = cost x 1.30
    // price      = "Selling Price"  shown in green, larger       = cost × 1.15
    costPrice: integer("cost_price").notNull().default(0),
    mrp: integer("mrp").notNull(),
    price: integer("price").notNull(),
    resellerPrice: integer("reseller_price").notNull().default(0),
    // Records the applied margin (always 15 under the global rule). Never exposed publicly.
    marginPercent: real("margin_percent").notNull().default(15),
    // Records the applied margin (always 15 under the global rule). Not exposed publicly.

    stockQty: integer("stock_qty").notNull().default(0),
    availability: text("availability").notNull().default("in_stock"), // in_stock | low_stock | out_of_stock | discontinued

    status: text("status").notNull().default("draft"), // draft | pending_review | published | archived | rejected
    moderationReason: text("moderation_reason"),
    qualityScore: real("quality_score").notNull().default(0), // 0-100 from AI pipeline
    confidence: real("confidence").notNull().default(0), // AI classification confidence

    // SEO
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),

    // Dedupe fingerprints
    messageId: text("message_id"),
    imageHash: text("image_hash"),
    contentHash: text("content_hash"),
    embedding: jsonb("embedding").$type<number[]>(), // pgvector upgrade path

    views: integer("views").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    addToCarts: integer("add_to_carts").notNull().default(0),
    orders: integer("orders").notNull().default(0),
    revenue: integer("revenue").notNull().default(0),
    ratingAvg: real("rating_avg").notNull().default(0),
    ratingCount: integer("rating_count").notNull().default(0),
    trendingScore: real("trending_score").notNull().default(0),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_slug_uidx").on(t.slug),
    uniqueIndex("products_sku_uidx").on(t.sku),
    index("products_status_cat_idx").on(t.status, t.categoryId),
    index("products_trending_idx").on(t.trendingScore),
    index("products_published_idx").on(t.publishedAt),
    index("products_content_hash_idx").on(t.contentHash),
    index("products_manufacturer_idx").on(t.manufacturerId),
    // Scale: the hottest catalogue read path (published + category, sorted by trending)
    index("products_cat_trend_idx").on(t.categoryId, t.trendingScore, t.id),
    index("products_status_pub_idx").on(t.status, t.publishedAt),
  ],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    label: text("label").notNull(), // "UK 9" / "Black" / "Free Size"
    axis: text("axis").notNull().default("size"), // size | color
    priceDelta: integer("price_delta").notNull().default(0),
    stockQty: integer("stock_qty").notNull().default(0),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("variants_product_idx").on(t.productId)],
);

/* ============================================================
   DEMAND SIDE
   ============================================================ */

export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    anonId: text("anon_id").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("open"), // open | converted | abandoned | recovered
    recoveryToken: text("recovery_token"),
    recoveryNudgedAt: timestamp("recovery_nudged_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("carts_anon_idx").on(t.anonId), index("carts_status_idx").on(t.status)],
);

export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id"),
    qty: integer("qty").notNull().default(1),
    unitPrice: integer("unit_price").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cart_items_cart_idx").on(t.cartId)],
);

export const wishlists = pgTable(
  "wishlists",
  {
    anonId: text("anon_id").notNull(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.anonId, t.productId] })],
);

export const priceAlerts = pgTable(
  "price_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    anonId: text("anon_id").notNull(),
    phone: text("phone"),
    targetPrice: integer("target_price").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("price_alerts_product_idx").on(t.productId)],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNo: text("order_no").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    anonId: text("anon_id"),

    customerName: text("customer_name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    addressLine: text("address_line").notNull(),
    city: text("city").notNull(),
    state: text("state").notNull(),
    pincode: text("pincode").notNull(),
    notes: text("notes"),

    subtotal: integer("subtotal").notNull(),
    discount: integer("discount").notNull().default(0),
    shipping: integer("shipping").notNull().default(0),
    total: integer("total").notNull(),
    costTotal: integer("cost_total").notNull().default(0),
    profit: integer("profit").notNull().default(0),

    couponCode: text("coupon_code"),
    paymentMode: text("payment_mode").notNull().default("prepaid"), // prepaid | upi | bank
    paymentStatus: text("payment_status").notNull().default("pending"),
    status: text("status").notNull().default("placed"), // placed | confirmed | packed | shipped | delivered | cancelled | returned
    riskScore: real("risk_score").notNull().default(0), // AI fraud/RTO scoring
    riskFlags: jsonb("risk_flags").$type<string[]>().notNull().default([]),

    trackingUrl: text("tracking_url"),
    courier: text("courier"),
    timeline: jsonb("timeline").$type<Array<{ at: string; status: string; note?: string }>>().notNull().default([]),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_no_uidx").on(t.orderNo),
    index("orders_status_idx").on(t.status),
    index("orders_phone_idx").on(t.phone),
    index("orders_created_idx").on(t.createdAt),
  ],
);

export const resellerOrders = pgTable(
  "reseller_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    resellerId: uuid("reseller_id").notNull().references(() => resellers.id),
    marginINR: integer("margin_inr").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reseller_orders_reseller_idx").on(t.resellerId), uniqueIndex("reseller_orders_order_uidx").on(t.orderId)],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    manufacturerId: uuid("manufacturer_id"),
    titleSnapshot: text("title_snapshot").notNull(),
    imageSnapshot: text("image_snapshot").notNull(),
    variantLabel: text("variant_label"),
    qty: integer("qty").notNull(),
    unitPrice: integer("unit_price").notNull(),
    unitCost: integer("unit_cost").notNull().default(0),
    lineTotal: integer("line_total").notNull(),
    supplierStatus: text("supplier_status").notNull().default("pending"), // pending | notified | accepted | shipped
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    orderId: uuid("order_id"),
    author: text("author").notNull(),
    rating: integer("rating").notNull(),
    body: text("body").notNull().default(""),
    verified: boolean("verified").notNull().default(false),
    sentiment: text("sentiment").notNull().default("neutral"),
    status: text("status").notNull().default("published"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reviews_product_idx").on(t.productId)],
);

export const coupons = pgTable(
  "coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    kind: text("kind").notNull().default("percent"), // percent | flat
    value: integer("value").notNull(),
    minSubtotal: integer("min_subtotal").notNull().default(0),
    maxRedemptions: integer("max_redemptions").notNull().default(0),
    redemptions: integer("redemptions").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("coupons_code_uidx").on(t.code)],
);

/* ============================================================
   AUTOMATION / INGESTION PIPELINE
   ============================================================ */

export const ingestionEvents = pgTable(
  "ingestion_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull().default("whatsapp"), // whatsapp | sheet | manual | api
    sourceGroupId: text("source_group_id"),
    manufacturerId: uuid("manufacturer_id"),
    messageId: text("message_id"),
    rawCaption: text("raw_caption").notNull().default(""),
    rawImageUrl: text("raw_image_url"),
    stage: text("stage").notNull().default("received"),
    // received | deduped | enriched | priced | published | needs_review | failed | rejected
    productId: uuid("product_id"),
    aiModel: text("ai_model"),
    aiLatencyMs: integer("ai_latency_ms").notNull().default(0),
    aiOutput: jsonb("ai_output").$type<Record<string, unknown>>(),
    error: text("error"),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ingest_stage_idx").on(t.stage),
    index("ingest_created_idx").on(t.createdAt),
    index("ingest_msg_idx").on(t.messageId),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    job: text("job").notNull(), // ingest | reprice | expire | trending | supplier-score | cart-recovery | digest
    status: text("status").notNull().default("running"), // running | ok | partial | failed
    processed: integer("processed").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    durationMs: integer("duration_ms").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("automation_job_idx").on(t.job), index("automation_started_idx").on(t.startedAt)],
);

export const opsTasks = pgTable(
  "ops_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(), // moderation | stock | supplier | order_risk | automation_failure | seo
    severity: text("severity").notNull().default("medium"), // low | medium | high | critical
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    actionUrl: text("action_url"),
    status: text("status").notNull().default("open"), // open | resolved | snoozed
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ops_status_sev_idx").on(t.status, t.severity)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor: text("actor").notNull().default("system"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

/* ============================================================
   ANALYTICS
   ============================================================ */

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(), // view_product | search | add_to_cart | begin_checkout | purchase | share
    anonId: text("anon_id"),
    productId: uuid("product_id"),
    query: text("query"),
    resultCount: integer("result_count"),
    value: integer("value"),
    referrer: text("referrer"),
    props: jsonb("props").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_name_created_idx").on(t.name, t.createdAt), index("events_product_idx").on(t.productId)],
);

export const searchQueries = pgTable(
  "search_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    query: text("query").notNull(),
    normalized: text("normalized").notNull(),
    resultCount: integer("result_count").notNull().default(0),
    clicked: boolean("clicked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("search_norm_idx").on(t.normalized)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel").notNull(), // whatsapp | email | push | telegram
    audience: text("audience").notNull().default("customer"),
    recipient: text("recipient").notNull(),
    template: text("template").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("queued"), // queued | sent | failed
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_status_idx").on(t.status)],
);

export const resellers = pgTable(
  "resellers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    name: text("name").notNull(),
    gst: text("gst"),
    marginPercent: real("margin_percent").notNull().default(30),
    status: text("status").notNull().default("active"), // active | suspended | verified
    referralCode: text("referral_code"),
    totalProducts: integer("total_products").notNull().default(0),
    totalRevenue: integer("total_revenue").notNull().default(0),
    totalProfit: integer("total_profit").notNull().default(0),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("resellers_phone_uidx").on(t.phone), uniqueIndex("resellers_referral_code_uidx").on(t.referralCode)],
);

export const resellerSessions = pgTable(
  "reseller_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resellerId: uuid("reseller_id").notNull().references(() => resellers.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    ip: text("ip"),
    ua: text("ua"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reseller_sessions_token_uidx").on(t.token), index("reseller_sessions_reseller_idx").on(t.resellerId)],
);

/**
 * Telegram messages queued for automatic deletion.
 *
 * One row per message rather than a single packed column: the previous design
 * kept one row per chat, so a second reply overwrote the first list and those
 * messages could never be deleted. QR photos were not recorded at all.
 *
 * Rows are removed once the delete is issued, so this table stays tiny.
 */
export const telegramEphemeral = pgTable(
  "telegram_ephemeral",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: text("chat_id").notNull(),
    messageId: integer("message_id").notNull(),
    bot: text("bot").notNull().default("admin"), // "admin" | "dev"
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tg_ephemeral_expires_idx").on(t.expiresAt),
    uniqueIndex("tg_ephemeral_msg_idx").on(t.chatId, t.messageId),
  ],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Product = typeof products.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Manufacturer = typeof manufacturers.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OpsTask = typeof opsTasks.$inferSelect;
export type IngestionEvent = typeof ingestionEvents.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
