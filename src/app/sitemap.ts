import type { MetadataRoute } from "next";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { getCategories, PUBLISHED } from "@/lib/queries";
import { SITE } from "@/lib/utils";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [cats, items] = await Promise.all([
    getCategories(),
    db.select({ slug: products.slug, updatedAt: products.updatedAt, heroImage: products.heroImage, title: products.title })
      .from(products).where(PUBLISHED).orderBy(desc(products.trendingScore)).limit(45000),
  ]);

  const statics: MetadataRoute.Sitemap = [
    { url: SITE.url, changeFrequency: "hourly", priority: 1 },
    { url: `${SITE.url}/about`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE.url}/faq`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/sell`, changeFrequency: "monthly", priority: 0.7 },
        { url: `${SITE.url}/contact`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/track`, changeFrequency: "yearly", priority: 0.4 },
    { url: `${SITE.url}/sitemap`, changeFrequency: "daily", priority: 0.5 },
    ...["privacy", "terms", "shipping", "returns", "disclaimer"].map((d) => ({
      url: `${SITE.url}/legal/${d}`, changeFrequency: "yearly" as const, priority: 0.3,
    })),
  ];

  return [
    ...statics,
    ...cats.map((c) => ({ url: `${SITE.url}/c/${c.slug}`, changeFrequency: "daily" as const, priority: 0.9 })),
    ...items.map((p) => ({
      url: `${SITE.url}/p/${p.slug}`,
      lastModified: p.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.8,
      images: p.heroImage ? [p.heroImage] : undefined,
    })),
  ];
}
