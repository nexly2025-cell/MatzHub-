import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { PUBLISHED } from "@/lib/queries";
import { db } from "@/db";
import { categories, products } from "@/db/schema";
import { SITE } from "@/lib/utils";

export const revalidate = 3600;

/** Ungated, flat product feed. Indexed by Perplexity, shopping agents and merchant crawlers. */
export async function GET() {
  const rows = await db
    .select({
      id: products.id, sku: products.sku, slug: products.slug, title: products.title,
      description: products.shortAnswer, brand: products.brand, color: products.color,
      material: products.material, gender: products.gender, price: products.price,
      mrp: products.mrp, availability: products.availability, image: products.heroImage,
      rating: products.ratingAvg, ratingCount: products.ratingCount,
      category: categories.name, categorySlug: categories.slug, updatedAt: products.updatedAt,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(PUBLISHED)
    .orderBy(desc(products.trendingScore))
    .limit(5000);

  return NextResponse.json(
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: `${SITE.name} product feed`,
      description: "MatzHub public catalogue of imported master-quality watches, handbags, footwear, sunglasses, apparel and perfumes. Prices are in INR and availability is updated regularly.",
      provider: { "@type": "Organization", name: SITE.name, url: SITE.url },
      generatedAt: new Date().toISOString(),
      currency: "INR",
      numberOfItems: rows.length,
      itemListElement: rows.map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "Product",
          "@id": `${SITE.url}/p/${p.slug}`,
          sku: p.sku, name: p.title, description: p.description,
          brand: p.brand ?? undefined, color: p.color ?? undefined, material: p.material ?? undefined,
          category: p.category ?? undefined, image: p.image, url: `${SITE.url}/p/${p.slug}`,
          audience: { "@type": "PeopleAudience", suggestedGender: p.gender },
          aggregateRating: p.ratingCount > 0 ? { "@type": "AggregateRating", ratingValue: p.rating, reviewCount: p.ratingCount } : undefined,
          offers: {
            "@type": "Offer",
            price: p.price,
            priceCurrency: "INR",
            priceSpecification: {
              "@type": "PriceSpecification",
              price: p.price,
              priceCurrency: "INR",
              valueAddedTaxIncluded: true,
            },
            availability: p.availability === "discontinued" ? "https://schema.org/Discontinued" : "https://schema.org/InStock",
            url: `${SITE.url}/p/${p.slug}`,
          },
        },
      })),
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
