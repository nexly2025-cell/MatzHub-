import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import Filters from "@/components/Filters";
import { ProductGrid, ProductGridSkeleton } from "@/components/ProductCard";
import { getCategories, getCategoryBySlug, getFacets, listProducts } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "All products",
  description: "Browse the full MatzHub catalogue — watches, handbags, footwear, eyewear, apparel and perfumes. Honest pricing, pan-India delivery.",
  alternates: { canonical: "/products" },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Issue 12 — catalogue route with a Suspense skeleton so the grid never pops
 * in as a blank page. Filters push `?category=` which this page (and the
 * products API) both honour.
 */
export default function ProductsPage({ searchParams }: Props) {
  return (
    <div className="shell py-10">
      <p className="eyebrow mb-3">Catalogue</p>
      <h1 className="display mb-2 text-[clamp(1.8rem,4.5vw,2.8rem)]">All products</h1>
      <p className="mb-7 max-w-xl text-sm text-muted">
        Every live piece, quality-scored before listing. Filter by collection, price or colour.
      </p>
      <Suspense fallback={<ProductGridSkeleton />}>
        <Catalogue searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Catalogue({ searchParams }: Props) {
  const sp = await searchParams;
  const q = one(sp.q) ?? "";
  const categorySlug = (one(sp.category) ?? "").trim().toLowerCase();
  const page = Number(one(sp.page) ?? 1) || 1;
  const sort = (one(sp.sort) ?? "trending") as "trending" | "new" | "price_asc" | "price_desc" | "discount";

  const cats = await getCategories();
  const cat = categorySlug ? await getCategoryBySlug(categorySlug) : null;
  const categoryId = cat?.isActive ? cat.id : undefined;

  const [data, facets] = await Promise.all([
    listProducts({
      q,
      categoryId,
      page,
      sort,
      min: one(sp.min) ? Number(one(sp.min)) : undefined,
      max: one(sp.max) ? Number(one(sp.max)) : undefined,
      brand: one(sp.brand),
      color: one(sp.color),
      perPage: 24,
    }),
    getFacets(categoryId),
  ]);

  const qs = (pageNum: number) => {
    const u = new URLSearchParams();
    const keep = ["q", "category", "sort", "brand", "color", "min", "max"] as const;
    for (const k of keep) {
      const v = one(sp[k]);
      if (v) u.set(k, v);
    }
    if (pageNum > 1) u.set("page", String(pageNum));
    const s = u.toString();
    return `/products${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <Filters
        basePath="/products"
        facets={facets}
        categories={cats.map((c) => ({ slug: c.slug, name: c.name }))}
        current={{
          sort,
          brand: one(sp.brand),
          color: one(sp.color),
          min: one(sp.min),
          max: one(sp.max),
          category: categorySlug || undefined,
        }}
      />

      <p className="mb-5 mt-6 text-sm text-muted">{data.total} products</p>

      {data.total === 0 ? (
        <div className="surface py-16 text-center">
          <p className="display mb-2 text-2xl">Nothing matches those filters</p>
          <p className="mx-auto mb-6 max-w-md text-sm text-muted">Try another collection, or clear the filters.</p>
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

      {data.pages > 1 && (
        <nav aria-label="Pagination" className="mt-10 flex justify-center gap-2">
          {page > 1 && (
            <Link href={qs(page - 1)} className="btn btn-ghost" rel="prev">
              ← Previous
            </Link>
          )}
          <span className="px-4 py-3 text-sm text-muted">
            {page} / {data.pages}
          </span>
          {page < data.pages && (
            <Link href={qs(page + 1)} className="btn btn-ghost" rel="next">
              Next →
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
