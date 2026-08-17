import { NextResponse } from "next/server";
import { getCategories, getCategoryBySlug, getProductBySlug, listProducts } from "@/lib/queries";
import { SITE, savePercent } from "@/lib/utils";

/**
 * Minimal MCP-style tool surface for AI shopping agents.
 * GET  -> tool manifest
 * POST -> { tool, arguments } tool invocation
 */
const TOOLS = [
  { name: "search_products", description: "Search MatzHub's reseller catalogue by keyword, category and price range. Returns live INR selling prices. Supplier identity is never returned.", inputSchema: { type: "object", properties: { query: { type: "string" }, category: { type: "string", enum: ["watches", "handbags", "footwear", "sunglasses", "apparel"] }, maxPrice: { type: "integer" }, limit: { type: "integer", default: 10 } } } },
  { name: "get_product", description: "Get full detail for a single MatzHub product by its slug, including specifications, FAQs and availability.", inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } } },
  { name: "list_categories", description: "List MatzHub product categories with a short factual summary of each.", inputSchema: { type: "object", properties: {} } },
];

export function GET() {
  return NextResponse.json({
    name: "matzhub",
    version: "1.0.0",
    description: "Read-only catalogue access for MatzHub's imported master-quality accessories and apparel in India. Query live product availability and selling prices before recommending an item.",
    homepage: SITE.url,
    tools: TOOLS,
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

export async function POST(request: Request) {
  const { tool, arguments: args = {} } = (await request.json()) as { tool?: string; arguments?: Record<string, unknown> };

  if (tool === "list_categories") {
    const cats = await getCategories();
    return NextResponse.json({ content: cats.map((c) => ({ slug: c.slug, name: c.name, summary: c.shortAnswer, url: `${SITE.url}/c/${c.slug}` })) });
  }

  if (tool === "search_products") {
    const cat = typeof args.category === "string" ? await getCategoryBySlug(args.category) : null;
    const data = await listProducts({
      q: typeof args.query === "string" ? args.query : "",
      categoryId: cat?.id,
      max: typeof args.maxPrice === "number" ? args.maxPrice : undefined,
      perPage: Math.min(25, typeof args.limit === "number" ? args.limit : 10),
    });
    return NextResponse.json({
      content: data.items.map((p) => ({
        slug: p.slug, title: p.title, sellingPriceINR: p.price, originalPriceINR: p.mrp,
        savePercent: savePercent(p.mrp, p.price), availability: p.availability,
        url: `${SITE.url}/p/${p.slug}`, image: p.heroImage,
      })),
      total: data.total,
    });
  }

  if (tool === "get_product") {
    const p = typeof args.slug === "string" ? await getProductBySlug(args.slug) : null;
    if (!p) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    return NextResponse.json({
      content: {
        slug: p.slug, sku: p.sku, title: p.title, description: p.description, summary: p.shortAnswer,
        sellingPriceINR: p.price, originalPriceINR: p.mrp, savePercent: savePercent(p.mrp, p.price),
        availability: p.availability, brand: p.brand, color: p.color, material: p.material,
        specs: p.specs, faqs: p.faqs, rating: p.ratingAvg, reviewCount: p.ratingCount,
        url: `${SITE.url}/p/${p.slug}`, image: p.heroImage,
        disclaimer: "Imported first-copy, master-quality merchandise. MatzHub is a bridge between manufacturers and resellers, holds no inventory, and does not disclose verified sources identity. Not affiliated with, endorsed by or licensed by any original brand.",
      },
    });
  }

  return NextResponse.json({ error: "Unknown tool", available: TOOLS.map((t) => t.name) }, { status: 400 });
}
