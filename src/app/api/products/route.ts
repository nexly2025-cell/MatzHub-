import { NextResponse } from "next/server";
import { getCategories, getCategoryBySlug, listProducts } from "@/lib/queries";
import { toPublicMediaUrl } from "@/lib/storage";
import { SITE, savePercent } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SORTS = new Set(["trending", "new", "price_asc", "price_desc", "discount"] as const);
type Sort = "trending" | "new" | "price_asc" | "price_desc" | "discount";

/**
 * Issue 2 — catalogue API with validated category filter.
 *
 * Category used to be ignored (or accepted as a free-form string that never
 * matched `category_id`). We resolve slug → id against live taxonomy and
 * reject unknown slugs with 400 so the client can reset the chip.
 */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const categorySlug = (sp.get("category") || "").trim().toLowerCase();
  const sortRaw = (sp.get("sort") || "trending") as Sort;
  const sort: Sort = SORTS.has(sortRaw) ? sortRaw : "trending";

  let categoryId: string | undefined;
  if (categorySlug) {
    const cat = await getCategoryBySlug(categorySlug);
    if (!cat || !cat.isActive) {
      const known = await getCategories();
      return NextResponse.json(
        { ok: false, error: "unknown_category", allowed: known.map((c) => c.slug) },
        { status: 400 },
      );
    }
    categoryId = cat.id;
  }

  const page = Math.max(1, Number(sp.get("page") ?? 1) || 1);
  const perPage = Math.min(48, Math.max(1, Number(sp.get("limit") ?? 24) || 24));
  const min = sp.get("min") ? Number(sp.get("min")) : undefined;
  const max = sp.get("max") ? Number(sp.get("max")) : undefined;

  const data = await listProducts({
    q: sp.get("q") ?? "",
    categoryId,
    brand: sp.get("brand") || undefined,
    color: sp.get("color") || undefined,
    min: Number.isFinite(min) ? min : undefined,
    max: Number.isFinite(max) ? max : undefined,
    sort,
    page,
    perPage,
  });

  return NextResponse.json(
    {
      ok: true,
      query: sp.get("q") ?? "",
      category: categorySlug || null,
      sort,
      page: data.page,
      pages: data.pages,
      total: data.total,
      currency: "INR",
      items: data.items.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        brand: p.brand,
        color: p.color,
        price: p.price,
        mrp: p.mrp,
        savePercent: savePercent(p.mrp, p.price),
        availability: p.availability,
        rating: p.ratingCount > 0 ? p.ratingAvg : null,
        image: toPublicMediaUrl(p.heroImage),
        url: `${SITE.url}/p/${p.slug}`,
      })),
    },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=120" } },
  );
}
