/**
 * Issue 9 — indexable trigram search.
 *
 * `LIKE '%term%'` cannot use a B-tree and ranks every hit equally, so search
 * felt slow and noisy. pg_trgm + GIN lets Postgres use `similarity()` which
 * is indexable and ranks by edit distance. Extension + indexes are applied
 * by `npx drizzle-kit push` plus the SQL in scripts (CREATE EXTENSION).
 */
import { sql } from "drizzle-orm";
import { products } from "@/db/schema";

const clampTerm = (q: string) => q.trim().slice(0, 80);

/** WHERE fragment: trigram similarity OR a bounded ilike fallback. */
export function searchMatchSql(raw: string) {
  const term = clampTerm(raw);
  const like = `%${term}%`;
  return sql`(
    similarity(coalesce(${products.title}, ''), ${term}) > 0.12
    OR similarity(coalesce(${products.brand}, ''), ${term}) > 0.18
    OR similarity(coalesce(${products.color}, ''), ${term}) > 0.25
    OR ${products.title} ilike ${like}
    OR coalesce(${products.brand}, '') ilike ${like}
    OR coalesce(${products.color}, '') ilike ${like}
    OR ${products.description} ilike ${like}
    OR ${products.tags}::text ilike ${like}
  )`;
}

/** ORDER BY fragment — higher similarity first. */
export function searchRankSql(raw: string) {
  const term = clampTerm(raw);
  return sql`GREATEST(
    similarity(coalesce(${products.title}, ''), ${term}),
    similarity(coalesce(${products.brand}, ''), ${term}),
    similarity(coalesce(${products.color}, ''), ${term})
  )`;
}
