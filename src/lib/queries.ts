import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { categories, manufacturers, opsTasks, orders, products, reviews } from "@/db/schema";

export const PUBLISHED = eq(products.status, "published");

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

export async function listProducts(f: ProductFilters) {
  const perPage = f.perPage ?? 24;
  const page = Math.max(1, f.page ?? 1);
  const clauses = [PUBLISHED];

  if (f.categoryId) clauses.push(eq(products.categoryId, f.categoryId));
  if (f.min !== undefined) clauses.push(gte(products.price, f.min));
  if (f.max !== undefined) clauses.push(lte(products.price, f.max));
  if (f.brand) clauses.push(eq(products.brand, f.brand));
  if (f.color) clauses.push(eq(products.color, f.color));
  if (f.q && f.q.trim()) {
    const term = `%${f.q.trim()}%`;
    clauses.push(
      or(
        ilike(products.title, term),
        ilike(products.description, term),
        ilike(products.brand, term),
        ilike(products.color, term),
        sql`${products.tags}::text ilike ${term}`,
      )!,
    );
  }

  const where = and(...clauses);
  const order =
    f.sort === "new"
      ? desc(products.publishedAt)
      : f.sort === "price_asc"
        ? asc(products.price)
        : f.sort === "price_desc"
          ? desc(products.price)
          : f.sort === "discount"
            ? desc(sql`(${products.mrp} - ${products.price})::float / nullif(${products.mrp},0)`)
            : desc(products.trendingScore);

  const [items, [{ total }]] = await Promise.all([
    db.select(productCard).from(products).where(where).orderBy(order, desc(products.createdAt)).limit(perPage).offset((page - 1) * perPage),
    db.select({ total: sql<number>`count(*)::int` }).from(products).where(where),
  ]);

  return { items: items as ProductCard[], total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

export async function getProductBySlug(slug: string) {
  const [p] = await db.select().from(products).where(and(eq(products.slug, slug), PUBLISHED)).limit(1);
  return p ?? null;
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
    .limit(8) as Promise<ProductCard[]>;
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
  return rows as ProductCard[];
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
