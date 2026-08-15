import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { getCategories, getCategoryCounts, listProducts, type ProductCard as PC } from "@/lib/queries";
import { ProductGrid } from "@/components/ProductCard";
import { SITE } from "@/lib/utils";

// ISR: the catalogue drifts slowly. 60 s removes a Postgres round-trip from
// every homepage request without shoppers ever noticing.
export const revalidate = 60;

export const metadata: Metadata = {
  title: "MatzHub — Imported Master-Quality, Honestly Priced",
  description:
    "Imported master-quality watches, handbags, footwear, eyewear, apparel and perfumes. Quality-scored before listing, priced from real manufacturer cost. Delivered across India with a 7-day replacement window.",
  alternates: { canonical: "/" },
};

/**
 * Homepage.
 *
 * Browse-first, not read-first. There is no search field and no explanation of
 * how the business works — that belongs on /about. The job of this page is to
 * get a visitor into a category or onto a product in as few decisions as
 * possible, so copy is trimmed to what changes a buying decision.
 *
 * Order: hero → categories → featured → new → trending → trust.
 */

const TRUST = [
  ["Quality-scored", "Inspected against a fixed rubric before listing"],
  ["7-day replacement", "Not as shown, replaced free"],
  ["≤5 hrs", "Dispatch on in-stock orders"],
  ["Pan-India", "Delivered nationwide"],
];

export default async function Home() {
  const [cats, counts, featured, latest, trending] = await Promise.all([
    getCategories(),
    getCategoryCounts(),
    listProducts({ sort: "discount", perPage: 8 }),
    listProducts({ sort: "new", perPage: 4 }),
    listProducts({ sort: "trending", perPage: 4 }),
  ]);

  const hero = featured.items[0] ?? latest.items[0] ?? trending.items[0];

  return (
    <>
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="border-b border-line">
        <div className="shell grid items-center gap-10 py-12 sm:py-16 lg:grid-cols-[1fr_1fr] lg:gap-16 lg:py-24">
          <div className="order-2 lg:order-1">
            <p className="eyebrow mb-5">Imported master-quality · since 2017</p>
            <h1 className="display text-[clamp(2.4rem,9vw,4.4rem)]">
              Master quality,
              <br />
              honestly priced.
            </h1>
            <p className="mt-6 max-w-sm text-[15px] leading-[1.75] text-muted">
              Watches, handbags, footwear, eyewear, apparel and perfumes — sold for exactly what they are.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a href="#collections" className="btn btn-solid">Shop collections</a>
              <Link href="/about" className="btn btn-outline">Our standard</Link>
            </div>
          </div>

          <div className="order-1 lg:order-2">
            {hero && (
              <Link href={`/p/${hero.slug}`} className="group block" aria-label={hero.title}>
                <div className="relative aspect-[4/5] w-full overflow-hidden rounded-2xl border border-line">
                  <Image
                    src={hero.heroImage}
                    alt={hero.title}
                    fill
                    priority
                    // Explicit sizes stops a phone downloading the 2x desktop asset.
                    sizes="(max-width: 1024px) 100vw, 46vw"
                    className="object-cover transition-transform duration-[900ms] ease-out group-hover:scale-[1.04]"
                  />
                </div>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* ── CATEGORIES — the primary entry point ─────────────────────────── */}
      <section id="collections" className="scroll-mt-16 border-b border-line bg-surface">
        <div className="shell py-14 lg:py-20">
          <div className="mb-8 flex items-end justify-between gap-4">
            <h2 className="display text-[clamp(1.6rem,5vw,2.4rem)]">Shop by category</h2>
            <Link href="/sitemap" className="hidden shrink-0 text-[12px] uppercase tracking-[0.14em] text-muted hover:text-ink sm:block">
              All products →
            </Link>
          </div>

          {/* Two-up on phones keeps each tile thumb-sized and legible. */}
          <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
            {cats.map((c, i) => (
              <li key={c.id}>
                <Link href={`/c/${c.slug}`} className="card-lift group relative block overflow-hidden rounded-xl border border-line">
                  <div className="relative aspect-[4/5] w-full sm:aspect-[4/3]">
                    {c.heroImage && (
                      <Image
                        src={c.heroImage}
                        alt=""
                        fill
                        priority={i < 4}
                        sizes="(max-width: 1024px) 50vw, 33vw"
                        className="object-cover transition-transform duration-[900ms] ease-out group-hover:scale-[1.06]"
                        aria-hidden
                      />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-4">
                      <h3 className="font-display text-[18px] leading-tight text-white sm:text-[22px]">{c.name}</h3>
                      <p className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-white/65">
                        {counts.get(c.id) ?? 0} pieces
                      </p>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── FEATURED ─────────────────────────────────────────────────────── */}
      {featured.items.length > 0 && (
        <section className="border-b border-line">
          <div className="shell py-14 lg:py-20">
            <div className="mb-8 flex items-end justify-between gap-4">
              <h2 className="display text-[clamp(1.6rem,5vw,2.4rem)]">Featured</h2>
              <Link href="/search?sort=discount" className="shrink-0 text-[12px] uppercase tracking-[0.14em] text-muted hover:text-ink">
                See all →
              </Link>
            </div>
            <ProductGrid items={featured.items as PC[]} priorityCount={0} />
          </div>
        </section>
      )}

      {/* ── NEW ARRIVALS ─────────────────────────────────────────────────── */}
      {latest.items.length > 0 && (
        <section className="border-b border-line bg-surface">
          <div className="shell py-14 lg:py-20">
            <div className="mb-8 flex items-end justify-between gap-4">
              <h2 className="display text-[clamp(1.6rem,5vw,2.4rem)]">New arrivals</h2>
              <Link href="/search?sort=new" className="shrink-0 text-[12px] uppercase tracking-[0.14em] text-muted hover:text-ink">
                See all →
              </Link>
            </div>
            <ProductGrid items={latest.items as PC[]} priorityCount={0} />
          </div>
        </section>
      )}

      {/* ── TRENDING ─────────────────────────────────────────────────────── */}
      {trending.items.length > 0 && (
        <section className="border-b border-line">
          <div className="shell py-14 lg:py-20">
            <div className="mb-8 flex items-end justify-between gap-4">
              <h2 className="display text-[clamp(1.6rem,5vw,2.4rem)]">Trending now</h2>
              <Link href="/search?sort=trending" className="shrink-0 text-[12px] uppercase tracking-[0.14em] text-muted hover:text-ink">
                See all →
              </Link>
            </div>
            <ProductGrid items={trending.items as PC[]} priorityCount={0} />
          </div>
        </section>
      )}

      {/* ── TRUST ────────────────────────────────────────────────────────── */}
      <section className="bg-surface">
        <div className="shell py-12 lg:py-16">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-9 lg:grid-cols-4">
            {TRUST.map(([v, l]) => (
              <div key={l}>
                <dt className="display text-[clamp(1.15rem,3.4vw,1.6rem)]">{v}</dt>
                <dd className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{l}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-10 border-t border-line pt-6 text-[12.5px] leading-relaxed text-subtle">
            Questions before ordering?{" "}
            <a
              href={`https://wa.me/${SITE.whatsapp}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted underline underline-offset-2 hover:text-ink"
            >
              Message us on WhatsApp
            </a>{" "}
            — a human replies and confirms availability before anything ships.
          </p>
        </div>
      </section>
    </>
  );
}
