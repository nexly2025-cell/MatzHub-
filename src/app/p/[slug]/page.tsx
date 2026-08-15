import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { categories, productVariants } from "@/db/schema";
import { getProductBySlug, getProductReviews, getRelated } from "@/lib/queries";
import { ProductRail } from "@/components/ProductCard";
import ProductGallery from "@/components/ProductGallery";
import BuyBox from "@/components/BuyBox";
import RecentlyViewed from "@/components/RecentlyViewed";
import { SITE, inr, savePercent } from "@/lib/utils";

export const revalidate = 300;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const p = await getProductBySlug(slug);
  if (!p) return { title: "Product" };
  const title = p.seoTitle || `${p.title} | MatzHub`;
  const description = p.seoDescription || p.shortAnswer.slice(0, 158);
  return {
    title,
    description,
    alternates: { canonical: `/p/${p.slug}` },
    openGraph: { type: "website", title, description, url: `${SITE.url}/p/${p.slug}`, images: p.heroImage ? [{ url: p.heroImage, width: 800, height: 800, alt: p.altText }] : [] },
    twitter: { card: "summary_large_image", title, description, images: p.heroImage ? [p.heroImage] : [] },
    other: { "product:price:amount": String(p.price), "product:price:currency": "INR" },
  };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const p = await getProductBySlug(slug);
  if (!p) notFound();

  const [cat, variants, reviewRows, related] = await Promise.all([
    p.categoryId ? db.select().from(categories).where(eq(categories.id, p.categoryId)).limit(1) : Promise.resolve([]),
    db.select().from(productVariants).where(eq(productVariants.productId, p.id)),
    getProductReviews(p.id),
    getRelated({ id: p.id, categoryId: p.categoryId, price: p.price }),
  ]);

  const category = cat[0];
  const off = savePercent(p.mrp, p.price);
  const url = `${SITE.url}/p/${p.slug}`;
  const availabilityLd =
    p.availability === "out_of_stock" ? "https://schema.org/OutOfStock" :
    p.availability === "low_stock" ? "https://schema.org/LimitedAvailability" : "https://schema.org/InStock";

  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        "@id": `${url}#product`,
        name: p.title,
        description: p.description,
        image: p.images.length ? p.images : [p.heroImage],
        sku: p.sku,
        category: category?.name,
        color: p.color ?? undefined,
        material: p.material ?? undefined,
        brand: { "@type": "Brand", name: p.brand || SITE.name },
        offers: {
          "@type": "Offer",
          url,
          priceCurrency: "INR",
          price: p.price,
          availability: availabilityLd,
          itemCondition: "https://schema.org/NewCondition",
          seller: { "@id": `${SITE.url}/#organization` },
          hasMerchantReturnPolicy: {
            "@type": "MerchantReturnPolicy", applicableCountry: "IN",
            returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
            merchantReturnDays: 7, returnMethod: "https://schema.org/ReturnByMail", returnFees: "https://schema.org/FreeReturn",
          },
        },
        ...(p.ratingCount > 0 ? {
          aggregateRating: { "@type": "AggregateRating", ratingValue: p.ratingAvg, reviewCount: p.ratingCount, bestRating: 5, worstRating: 1 },
          review: reviewRows.slice(0, 5).map((r) => ({
            "@type": "Review", author: { "@type": "Person", name: r.author },
            datePublished: new Date(r.createdAt).toISOString().slice(0, 10),
            reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5 }, reviewBody: r.body,
          })),
        } : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
          ...(category ? [{ "@type": "ListItem", position: 2, name: category.name, item: `${SITE.url}/c/${category.slug}` }] : []),
          { "@type": "ListItem", position: category ? 3 : 2, name: p.title, item: url },
        ],
      },
      ...(p.faqs.length ? [{
        "@type": "FAQPage",
        mainEntity: p.faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
      }] : []),
    ],
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />

      <div className="border-b border-line bg-surface">
        <nav aria-label="Breadcrumb" className="shell pt-4 text-[11px] text-muted">
          <Link href="/" className="hover:text-ink">Home</Link>
          {category && <> / <Link href={`/c/${category.slug}`} className="hover:text-ink">{category.name}</Link></>}
          {" / "}<span className="text-ink">{p.title}</span>
        </nav>
      </div>

      <div className="border-b border-line bg-surface">
        <div className="shell gap-10 pb-10 pt-5 lg:grid lg:grid-cols-[1.05fr_0.95fr] lg:pb-14 lg:pt-8">
          <div>
            <ProductGallery
              images={p.images}
              heroImage={p.heroImage}
              alt={p.altText || p.title}
              priority
              mediaType={(p.mediaType as "image" | "video") ?? "image"}
              videoUrl={p.videoUrl}
            />
          </div>
          <BuyBox
            product={{
              id: p.id, slug: p.slug, title: p.title, subtitle: p.subtitle,
              heroImage: p.heroImage, price: p.price, mrp: p.mrp,
              availability: p.availability, stockQty: p.stockQty,
              ratingAvg: p.ratingAvg, ratingCount: p.ratingCount,
              brand: p.brand, sku: p.sku,
            }}
            variants={variants.map((v) => ({ id: v.id, label: v.label, stockQty: v.stockQty }))}
          />
        </div>
      </div>

      {/* detail tabs — Details / Specifications / Shipping */}
      <section className="border-b border-line bg-canvas">
        <div className="shell py-10 lg:grid lg:grid-cols-[280px_1fr] lg:gap-14 lg:px-10 lg:py-14">
          <div>
            <p className="eyebrow mb-2">The detail</p>
            <h2 className="font-display text-[26px] leading-tight text-ink sm:text-[32px]">{p.title}</h2>
            <p className="mt-2 text-[12px] text-subtle">SKU {p.sku}</p>
          </div>
          <div className="mt-8 grid gap-10 lg:mt-0 lg:grid-cols-2">
            <div>
              <h3 className="eyebrow mb-4">What you should know</h3>
              <p className="text-[14px] leading-relaxed text-ink">{p.shortAnswer}</p>
              {p.description && <p className="mt-4 text-[13.5px] leading-relaxed text-muted">{p.description}</p>}
            </div>
            <div>
              <h3 className="eyebrow mb-4">Specifications</h3>
              {Object.keys(p.specs).length ? (
                <dl className="divide-y divide-line">
                  {Object.entries(p.specs).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-6 py-2.5 text-[13px]">
                      <dt className="text-muted">{k}</dt>
                      <dd className="text-right text-ink">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-[13px] text-muted">Listed exactly as supplied. Specs populate as details are confirmed per batch.</p>
              )}
            </div>
          </div>
        </div>
      </section>

      {p.faqs.length > 0 && (
        <section className="border-b border-line bg-surface">
          <div className="shell py-12 ">
            <p className="eyebrow mb-4">Asked constantly</p>
            <div className="divide-y divide-line">
              {p.faqs.map((f) => (
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

      {reviewRows.length > 0 && (
        <section className="border-b border-line bg-surface">
          <div className="shell py-12 lg:px-10">
            <div className="mb-8 flex items-end justify-between">
              <div>
                <p className="eyebrow mb-2">From the people who ordered it</p>
                <h2 className="font-display text-[26px] text-ink sm:text-[30px]">
                  {p.ratingAvg.toFixed(1)} from {p.ratingCount} review{p.ratingCount === 1 ? "" : "s"}
                </h2>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {reviewRows.map((r) => (
                <article key={r.id} className="surface p-5">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[13px] text-accent" aria-label={`${r.rating} out of 5`}>
                      {"★".repeat(r.rating)}<span className="text-subtle">{"★".repeat(5 - r.rating)}</span>
                    </span>
                    {r.verified && <span className="label rounded-full bg-accent-soft px-2 py-0.5 text-accent" style={{ background: "var(--c-accent-soft)" }}>Verified order</span>}
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-ink">{r.body}</p>
                  <p className="mt-2.5 text-[11px] text-subtle">{r.author} · {new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {related.length > 0 && (
        <section className="bg-canvas">
          <div className="px-4 pt-12 sm:px-6 lg:px-10">
            <p className="eyebrow mb-2">Same energy</p>
            <h2 className="font-display text-[26px] text-ink sm:text-[30px]">Pieces that pair with this one</h2>
          </div>
          <ProductRail items={related} />
        </section>
      )}

      <RecentlyViewed />
    </>
  );
}
