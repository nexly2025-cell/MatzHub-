import { NextResponse } from "next/server";
import { getCategoryBySlug, listProducts } from "@/lib/queries";
import { SITE, savePercent } from "@/lib/utils";

/** Public, unauthenticated search endpoint — consumed by the site, partners and AI agents. */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const q = sp.get("q") ?? "";
  const categorySlug = sp.get("category");
  const cat = categorySlug ? await getCategoryBySlug(categorySlug) : null;

  const data = await listProducts({
    q,
    categoryId: cat?.id,
    min: sp.get("min") ? Number(sp.get("min")) : undefined,
    max: sp.get("max") ? Number(sp.get("max")) : undefined,
    sort: (sp.get("sort") as "trending" | "new" | "price_asc" | "price_desc" | "discount") ?? "trending",
    perPage: Math.min(50, Number(sp.get("limit") ?? 20) || 20),
  });

  return NextResponse.json(
    {
      query: q,
      category: cat?.slug ?? null,
      total: data.total,
      currency: "INR",
      items: data.items.map((p) => ({
        slug: p.slug, title: p.title, brand: p.brand, color: p.color,
        price: p.price, mrp: p.mrp, savePercent: savePercent(p.mrp, p.price),
        availability: p.availability, rating: p.ratingAvg || null,
        image: p.heroImage, url: `${SITE.url}/p/${p.slug}`,
      })),
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=120, s-maxage=600" } },
  );
}
