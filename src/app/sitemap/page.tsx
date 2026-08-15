import type { Metadata } from "next";
import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { getCategories, PUBLISHED } from "@/lib/queries";

export const revalidate = 3600;
export const metadata: Metadata = {
  title: "Browse index — every category and product on MatzHub",
  description: "A plain HTML index of every MatzHub category and published product. Useful for humans and crawlers alike.",
  alternates: { canonical: "/sitemap" },
};

export default async function SitemapPage() {
  const [cats, items] = await Promise.all([
    getCategories(),
    db.select({ slug: products.slug, title: products.title, categoryId: products.categoryId })
      .from(products).where(PUBLISHED).orderBy(desc(products.trendingScore)).limit(1000),
  ]);

  return (
    <div className="shell py-16">
      <h1 className="font-display text-[34px] text-ink mb-3">Browse index</h1>
      <p className="mb-10 text-sm text-muted">{items.length} published products across {cats.length} categories.</p>

      <nav className="mb-10 flex flex-wrap gap-2" aria-label="Pages">
        {[["/", "Home"], ["/about", "About"], ["/faq", "FAQ"], ["/contact", "Contact"], ["/legal/privacy", "Privacy"], ["/legal/terms", "Terms"], ["/legal/shipping", "Shipping"], ["/legal/returns", "Returns"], ["/legal/disclaimer", "Disclaimer"]].map(([h, l]) => (
          <Link key={h} href={h} className="chip">{l}</Link>
        ))}
      </nav>

      {cats.map((c) => {
        const list = items.filter((i) => i.categoryId === c.id);
        return (
          <section key={c.id} className="mb-10">
            <h2 className="font-display text-xl text-ink mb-4">
              <Link href={`/c/${c.slug}`} className="hover:text-accent">{c.name}</Link>
              <span className="ml-2 text-sm text-muted">({list.length})</span>
            </h2>
            <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((p) => (
                <li key={p.slug}>
                  <Link href={`/p/${p.slug}`} className="text-sm text-muted hover:text-ink">{p.title}</Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
