import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCategories, getCategoryBySlug, getFacets, listProducts } from "@/lib/queries";
import { ProductGrid } from "@/components/ProductCard";
import Filters from "@/components/Filters";
import { SITE, inr } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const c = await getCategoryBySlug(slug);
  if (!c) return { title: "Collection" };
  return {
    title: c.seoTitle || `${c.name} | MatzHub`,
    description: c.seoDescription ?? c.shortAnswer.slice(0, 158),
    keywords: c.keywords,
    alternates: { canonical: `/c/${c.slug}` },
    openGraph: { title: c.seoTitle || c.name, description: c.seoDescription ?? "", url: `${SITE.url}/c/${c.slug}`, images: c.heroImage ? [c.heroImage] : [] },
  };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const c = await getCategoryBySlug(slug);
  if (!c) notFound();

  const page = Number(one(sp.page) ?? 1) || 1;
  const sort = (one(sp.sort) ?? "trending") as "trending" | "new" | "price_asc" | "price_desc" | "discount";

  const [data, facets, allCats] = await Promise.all([
    listProducts({
      categoryId: c.id,
      page,
      sort,
      min: one(sp.min) ? Number(one(sp.min)) : undefined,
      max: one(sp.max) ? Number(one(sp.max)) : undefined,
      brand: one(sp.brand),
      color: one(sp.color),
      perPage: 24,
    }),
    getFacets(c.id),
    getCategories(),
  ]);

  const base = `${SITE.url}/c/${c.slug}`;
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: c.name,
        description: c.shortAnswer,
        url: base,
        isPartOf: { "@id": `${SITE.url}/#website` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
          { "@type": "ListItem", position: 2, name: c.name, item: base },
        ],
      },
      {
        "@type": "ItemList",
        numberOfItems: data.total,
        itemListElement: data.items.slice(0, 20).map((p, i) => ({
          "@type": "ListItem",
          position: (page - 1) * 24 + i + 1,
          url: `${SITE.url}/p/${p.slug}`,
          name: p.title,
        })),
      },
      ...(c.faqs.length ? [{ "@type": "FAQPage", mainEntity: c.faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) }] : []),
    ],
  };

  const qs = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    Object.entries({ ...sp, ...patch }).forEach(([k, v]) => {
      const val = one(v as string | string[] | undefined);
      if (val) u.set(k, val);
    });
    return `/c/${c.slug}${u.toString() ? `?${u.toString()}` : ""}`;
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />

      {/* header — quiet editorial, not a billboard */}
      <section className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-10 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-10">
          <div>
            <nav aria-label="Breadcrumb" className="mb-3 text-[11px] text-muted">
              <Link href="/" className="hover:text-ink">Home</Link> / <span className="text-ink">{c.name}</span>
            </nav>
            <p className="eyebrow mb-2">Collection</p>
            <h1 className="font-display text-[38px] leading-none text-ink sm:text-[50px]">{c.name}</h1>
          </div>
          <div className="max-w-md">
            <p className="text-[13px] leading-relaxed text-muted">{c.shortAnswer}</p>
            <p className="mt-2 text-[11px] text-subtle">{data.total} pieces · {inr(facets.range.min)} – {inr(facets.range.max)}</p>
          </div>
        </div>
      </section>

      <div className="shell py-6 lg:px-10">
        <Filters
          basePath={`/c/${c.slug}`}
          facets={facets}
          current={{ sort, brand: one(sp.brand), color: one(sp.color), min: one(sp.min), max: one(sp.max) }}
        />

        <div className="mt-8">
          <ProductGrid items={data.items} />
        </div>

        {data.pages > 1 && (
          <nav aria-label="Pagination" className="mt-12 flex items-center justify-center gap-3">
            {page > 1 && <Link href={qs({ page: String(page - 1) })} className="btn btn-outline" rel="prev">Previous</Link>}
            <span className="text-[11px] uppercase tracking-[0.14em] text-muted">{page} of {data.pages}</span>
            {page < data.pages && <Link href={qs({ page: String(page + 1) })} className="btn btn-outline" rel="next">Next</Link>}
          </nav>
        )}
      </div>

      {/* buying guide — cut depth content for search, visually quiet */}
      {c.buyingGuide && (
        <section className="border-t border-line bg-surface">
          <div className="shell py-12 lg:py-14">
            <p className="eyebrow mb-3">Before you pick</p>
            <h2 className="mb-4 font-display text-[24px] leading-snug text-ink sm:text-[28px]">
              How to choose {c.name.toLowerCase()} that actually hold up
            </h2>
            <p className="text-[14px] leading-loose text-muted">{c.buyingGuide}</p>
          </div>
        </section>
      )}

      {c.faqs.length > 0 && (
        <section className="border-t border-line bg-canvas">
          <div className="shell py-12 ">
            <p className="eyebrow mb-4">Asked constantly</p>
            <div className="divide-y divide-line">
              {c.faqs.map((f) => (
                <details key={f.q} className="group py-4">
                  <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4 text-[14px] font-medium text-ink">
                    {f.q}
                    <span className="text-accent transition-transform group-open:rotate-45" aria-hidden>+</span>
                  </summary>
                  <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-muted">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="border-t border-line bg-surface">
        <div className="shell py-8 lg:px-10">
          <p className="eyebrow mb-4">Other collections</p>
          <div className="flex flex-wrap gap-2">
            {allCats.filter((x) => x.id !== c.id).map((x) => (
              <Link key={x.id} href={`/c/${x.slug}`} className="chip">
                {x.name}
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
