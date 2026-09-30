import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { categories, manufacturers, opsTasks, orders, products, reviews } from "@/db/schema";
import { searchMatchSql, searchRankSql } from "@/lib/search";
import { toPublicMediaUrl } from "@/lib/storage";

// The single availability rule for every public and orderable surface:
// published and inside its valid expiry window. SQL NULL semantics already
// exclude expires_at IS NULL, so "expiresAt exists AND expiresAt > now" holds.
// Expiry archival (runExpiryJob) tombstones rows to archived + discontinued,
// so no availability-state clause belongs here.
export const PUBLISHED = and(eq(products.status, "published"), sql`${products.expiresAt} > now()`);

export const productCard = {
  id: products.id,
  slug: products.slug,
  sku: products.sku,
  title: products.title,
  subtitle: products.subtitle,
  heroImage: products.heroImage,
  altText: products.altText,
  mrp: products.mrp,
  price: products.price,
  brand: products.brand,
  color: products.color,
  availability: products.availability,
  ratingAvg: products.ratingAvg,
  ratingCount: products.ratingCount,
  trendingScore: products.trendingScore,
  categoryId: products.categoryId,
  createdAt: products.createdAt,
};

export type ProductCard = {
  id: string;
  slug: string;
  sku: string;
  title: string;
  subtitle: string | null;
  heroImage: string;
  altText: string;
  mrp: number;
  price: number;
  brand: string | null;
  color: string | null;
  availability: string;
  ratingAvg: number;
  ratingCount: number;
  trendingScore: number;
  categoryId: string | null;
  createdAt: Date;
};

export async function getCategories() {
  return db.select().from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.position));
}

export async function getCategoryBySlug(slug: string) {
  const [c] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  return c ?? null;
}

export async function getCategoryCounts() {
  const rows = await db
    .select({ categoryId: products.categoryId, count: sql<number>`count(*)::int` })
    .from(products)
    .where(PUBLISHED)
    .groupBy(products.categoryId);
  return new Map(rows.map((r) => [r.categoryId, r.count]));
}

export type ProductFilters = {
  categoryId?: string;
  q?: string;
  min?: number;
  max?: number;
  brand?: string;
  color?: string;
  sort?: "trending" | "new" | "price_asc" | "price_desc" | "discount";
  page?: number;
  perPage?: number;
};

export async function healOutdatedStockInDb(): Promise<void> {
  // Availability is derived from status + expiry; no healing writes.
  return;
}

function withPublicImages(items: ProductCard[]): ProductCard[] {
  return items.map((p) => ({
    ...p,
    heroImage: toPublicMediaUrl(p.heroImage) || p.heroImage,
  }));
}

export async function listProducts(f: ProductFilters) {
  const perPage = f.perPage ?? 24;
  const page = Math.max(1, f.page ?? 1);
  const clauses = [PUBLISHED];
  const term = f.q?.trim() ?? "";

  if (f.categoryId) clauses.push(eq(products.categoryId, f.categoryId));
  if (f.min !== undefined) clauses.push(gte(products.price, f.min));
  if (f.max !== undefined) clauses.push(lte(products.price, f.max));
  if (f.brand) clauses.push(eq(products.brand, f.brand));
  if (f.color) clauses.push(eq(products.color, f.color));
  // Issue 9 — trigram similarity instead of unindexable LIKE '%term%'.
  if (term) clauses.push(searchMatchSql(term));

  const where = and(...clauses);
  const sortOrder =
    f.sort === "new"
      ? desc(products.publishedAt)
      : f.sort === "price_asc"
        ? asc(products.price)
        : f.sort === "price_desc"
          ? desc(products.price)
          : f.sort === "discount"
            ? desc(sql`(${products.mrp} - ${products.price})::float / nullif(${products.mrp},0)`)
            : desc(products.trendingScore);

  const orderBy = term
    ? [desc(searchRankSql(term)), sortOrder, desc(products.createdAt)]
    : [sortOrder, desc(products.createdAt)];

  const run = () =>
    Promise.all([
      db.select(productCard).from(products).where(where).orderBy(...orderBy).limit(perPage).offset((page - 1) * perPage),
      db.select({ total: sql<number>`count(*)::int` }).from(products).where(where),
    ]);

  let items: ProductCard[];
  let total: number;
  try {
    const [rows, countRows] = await run();
    items = rows as ProductCard[];
    total = countRows[0]?.total ?? 0;
  } catch {
    // If pg_trgm is not yet enabled, fall back to a bounded ilike so search
    // never 500s. The extension is created at setup.
    const like = `%${term}%`;
    const fallbackWhere = and(
      PUBLISHED,
      f.categoryId ? eq(products.categoryId, f.categoryId) : sql`true`,
      f.min !== undefined ? gte(products.price, f.min) : sql`true`,
      f.max !== undefined ? lte(products.price, f.max) : sql`true`,
      f.brand ? eq(products.brand, f.brand) : sql`true`,
      f.color ? eq(products.color, f.color) : sql`true`,
      term
        ? or(
            sql`${products.title} ilike ${like}`,
            sql`coalesce(${products.brand}, '') ilike ${like}`,
            sql`coalesce(${products.color}, '') ilike ${like}`,
            sql`${products.description} ilike ${like}`,
          )!
        : sql`true`,
    );
    const [rows, countRows] = await Promise.all([
      db.select(productCard).from(products).where(fallbackWhere).orderBy(sortOrder, desc(products.createdAt)).limit(perPage).offset((page - 1) * perPage),
      db.select({ total: sql<number>`count(*)::int` }).from(products).where(fallbackWhere),
    ]);
    items = rows as ProductCard[];
    total = countRows[0]?.total ?? 0;
  }

  return { items: withPublicImages(items), total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

export async function getProductBySlug(slug: string) {
  const [p] = await db.select().from(products).where(and(eq(products.slug, slug), PUBLISHED)).limit(1);
  if (!p) return null;
  return {
    ...p,
    heroImage: toPublicMediaUrl(p.heroImage) || p.heroImage,
    images: Array.isArray(p.images) ? p.images.map((u) => toPublicMediaUrl(u) || u) : p.images,
    videoUrl: p.videoUrl ? toPublicMediaUrl(p.videoUrl) || p.videoUrl : p.videoUrl,
  };
}

export async function getRelated(p: { id: string; categoryId: string | null; price: number }) {
  return db
    .select(productCard)
    .from(products)
    .where(
      and(
        PUBLISHED,
        ne(products.id, p.id),
        p.categoryId ? eq(products.categoryId, p.categoryId) : sql`true`,
      ),
    )
    .orderBy(sql`abs(${products.price} - ${p.price})`)
    .limit(8)
    .then((rows) => withPublicImages(rows as ProductCard[]));
}

/**
 * Cross-category discovery. getRelated() only ever shows more of the same
 * category, so a customer on a watch page never learns the store sells anything
 * else. This surfaces pieces from OTHER categories that genuinely share an
 * attribute - colour, material, or gender line - ranked by how many match, then
 * by real trend. Grounded in real columns only; returns nothing when no other
 * category shares an attribute, rather than showing a random product.
 */
export async function getCrossCategory(p: {
  id: string;
  categoryId: string | null;
  color: string | null;
  material: string | null;
  gender: string;
}) {
  const colorMatches = sql`nullif(${products.color}::text, '') is not null and ${products.color}::text = ${p.color ?? ""}`;
  const materialMatches = sql`nullif(${products.material}::text, '') is not null and ${products.material}::text = ${p.material ?? ""}`;
  const genderMatches = sql`${products.gender} = ${p.gender}`;

  const conditions = [
    PUBLISHED,
    ne(products.id, p.id),
    p.categoryId ? ne(products.categoryId, p.categoryId) : sql`true`,
    sql`(${colorMatches} or ${materialMatches} or ${genderMatches})`,
  ];

  const sharedAttributeCount = sql`(
    case when ${colorMatches} then 1 else 0 end +
    case when ${materialMatches} then 1 else 0 end +
    case when ${genderMatches} then 1 else 0 end
  )`;

  return db
    .select(productCard)
    .from(products)
    .where(and(...conditions))
    .orderBy(desc(sharedAttributeCount), desc(products.trendingScore))
    .limit(8)
    .then((rows) => withPublicImages(rows as ProductCard[]));
}

export async function getProductReviews(productId: string) {
  return db
    .select()
    .from(reviews)
    .where(and(eq(reviews.productId, productId), eq(reviews.status, "published")))
    .orderBy(desc(reviews.createdAt))
    .limit(12);
}

export async function getProductsByIds(ids: string[]) {
  if (!ids.length) return [] as ProductCard[];
  const rows = await db.select(productCard).from(products).where(and(inArray(products.id, ids), PUBLISHED));
  return withPublicImages(rows as ProductCard[]);
}

export async function getFacets(categoryId?: string) {
  const where = categoryId ? and(PUBLISHED, eq(products.categoryId, categoryId)) : PUBLISHED;
  const [brands, colors, range] = await Promise.all([
    db
      .select({ v: products.brand, c: sql<number>`count(*)::int` })
      .from(products)
      .where(and(where, sql`${products.brand} is not null`))
      .groupBy(products.brand)
      .orderBy(desc(sql`count(*)`))
      .limit(12),
    db
      .select({ v: products.color, c: sql<number>`count(*)::int` })
      .from(products)
      .where(and(where, sql`${products.color} is not null`))
      .groupBy(products.color)
      .orderBy(desc(sql`count(*)`))
      .limit(12),
    db
      .select({ min: sql<number>`coalesce(min(${products.price}),0)::int`, max: sql<number>`coalesce(max(${products.price}),0)::int` })
      .from(products)
      .where(where),
  ]);
  return { brands, colors, range: range[0] };
}

/* ---------------- admin intelligence ---------------- */

export async function getAdminSnapshot() {
  const [
    [rev],
    [prodStats],
    [orderStats],
    tasks,
    topProducts,
    supplierRows,
    ingest,
    failedSearches,
  ] = await Promise.all([
    db
      .select({
        revenue: sql<number>`coalesce(sum(${orders.total}),0)::int`,
        profit: sql<number>`coalesce(sum(${orders.profit}),0)::int`,
        count: sql<number>`count(*)::int`,
        aov: sql<number>`coalesce(avg(${orders.total}),0)::int`,
      })
      .from(orders)
      .where(sql`${orders.createdAt} > now() - interval '30 days'`),
    db
      .select({
        published: sql<number>`count(*) filter (where status = 'published')::int`,
        pending: sql<number>`count(*) filter (where status = 'pending_review')::int`,
        archived: sql<number>`count(*) filter (where status = 'archived')::int`,
        lowStock: sql<number>`count(*) filter (where availability = 'low_stock')::int`,
        avgQuality: sql<number>`coalesce(avg(quality_score),0)::float`,
      })
      .from(products),
    db
      .select({
        placed: sql<number>`count(*) filter (where status = 'placed')::int`,
        risky: sql<number>`count(*) filter (where risk_score >= 60)::int`,
        delivered: sql<number>`count(*) filter (where status = 'delivered')::int`,
      })
      .from(orders),
    db.select().from(opsTasks).where(eq(opsTasks.status, "open")).orderBy(
      sql`case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
      desc(opsTasks.createdAt),
    ).limit(12),
    db.select(productCard).from(products).where(PUBLISHED).orderBy(desc(products.trendingScore)).limit(6),
    db.select().from(manufacturers).orderBy(asc(manufacturers.healthScore)).limit(8),
    db
      .select({
        stage: sql<string>`stage`,
        c: sql<number>`count(*)::int`,
      })
      .from(sql`ingestion_events`)
      .where(sql`created_at > now() - interval '7 days'`)
      .groupBy(sql`stage`),
    db
      .select({ q: sql<string>`normalized`, c: sql<number>`count(*)::int` })
      .from(sql`search_queries`)
      .where(sql`result_count = 0 and created_at > now() - interval '30 days'`)
      .groupBy(sql`normalized`)
      .orderBy(desc(sql`count(*)`))
      .limit(8),
  ]);

  return {
    revenue: rev,
    products: prodStats,
    orders: orderStats,
    tasks,
    topProducts: topProducts as ProductCard[],
    suppliers: supplierRows,
    ingest,
    failedSearches,
  };
}

export async function getPendingProducts() {
  return db.select().from(products).where(eq(products.status, "pending_review")).orderBy(desc(products.createdAt)).limit(50);
}

export async function getRecentOrders(limit = 25) {
  return db.select().from(orders).orderBy(desc(orders.createdAt)).limit(limit);
}
