import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { searchQueries } from "@/db/schema";
import { getCategories, getFacets, listProducts } from "@/lib/queries";
import { ProductGrid } from "@/components/ProductCard";
import Filters from "@/components/Filters";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const q = one((await searchParams).q);
  return {
    title: q ? `"${q}" — Search results` : "Search the catalogue",
    description: q
      ? `Products matching "${q}" on MatzHub. curated imports pricing, delivered across India.`
      : "Search MatzHub's curated imports catalogue of watches, handbags, footwear, sunglasses and apparel.",
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = one(sp.q) ?? "";
  const page = Number(one(sp.page) ?? 1) || 1;
  const sort = (one(sp.sort) ?? (q ? "trending" : "new")) as "trending" | "new" | "price_asc" | "price_desc" | "discount";

  const [data, facets, cats] = await Promise.all([
    listProducts({
      q,
      page,
      sort,
      min: one(sp.min) ? Number(one(sp.min)) : undefined,
      max: one(sp.max) ? Number(one(sp.max)) : undefined,
      brand: one(sp.brand),
      color: one(sp.color),
      perPage: 24,
    }),
    getFacets(),
    getCategories(),
  ]);

  // Zero-result queries are a product roadmap signal, so we persist them.
  if (q.trim()) {
    await db
      .insert(searchQueries)
      .values({ query: q, normalized: q.toLowerCase().trim(), resultCount: data.total })
      .catch(() => undefined);
  }

  return (
    <div className="shell py-10">
      <h1 className="display text-[clamp(1.8rem,4.5vw,2.8rem)] mb-2">
        {q ? (
          <>
            Results for <span className="gold-text">“{q}”</span>
          </>
        ) : (
          "Browse everything"
        )}
      </h1>
      <p className="mb-7 text-sm text-muted">{data.total} products found</p>

      <Filters
        basePath="/search"
        facets={facets}
        current={{ sort, brand: one(sp.brand), color: one(sp.color), min: one(sp.min), max: one(sp.max) }}
      />

      <div className="mt-7">
        {data.total === 0 ? (
          <div className="surface py-16 text-center">
            <p className="display text-2xl mb-2">No match for “{q}”</p>
            <p className="mx-auto mb-6 max-w-md text-sm text-muted">
              Try one of the collections below — new pieces are added regularly.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {cats.map((c) => (
                <Link key={c.id} href={`/c/${c.slug}`} className="chip">
                  {c.name}
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <ProductGrid items={data.items} />
        )}
      </div>

      {data.pages > 1 && (
        <nav aria-label="Pagination" className="mt-10 flex justify-center gap-2">
          {page > 1 && (
            <Link href={`/search?${new URLSearchParams({ ...(sp as Record<string, string>), page: String(page - 1) })}`} className="btn btn-ghost">
              ← Previous
            </Link>
          )}
          <span className="px-4 py-3 text-sm text-muted">
            {page} / {data.pages}
          </span>
          {page < data.pages && (
            <Link href={`/search?${new URLSearchParams({ ...(sp as Record<string, string>), page: String(page + 1) })}`} className="btn btn-ghost">
              Next →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
