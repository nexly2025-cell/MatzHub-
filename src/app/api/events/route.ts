import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { events, products } from "@/db/schema";

const COUNTER: Record<string, "views" | "clicks" | "addToCarts"> = {
  view_item: "views",
  select_item: "clicks",
  add_to_cart: "addToCarts",
};

export async function POST(request: Request) {
  try {
    const b = (await request.json()) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.slice(0, 60) : null;
    if (!name) return new NextResponse(null, { status: 204 });

    const productId = typeof b.productId === "string" ? b.productId : null;
    await db.insert(events).values({
      name,
      anonId: typeof b.anonId === "string" ? b.anonId.slice(0, 64) : null,
      productId,
      query: typeof b.query === "string" ? b.query.slice(0, 200) : null,
      value: typeof b.value === "number" ? Math.round(b.value) : null,
      referrer: typeof b.referrer === "string" ? b.referrer.slice(0, 300) : null,
      props: { path: b.path ?? null },
    });

    const col = COUNTER[name];
    if (col && productId) {
      const field = col === "views" ? products.views : col === "clicks" ? products.clicks : products.addToCarts;
      await db.update(products).set({ [col]: sql`${field} + 1` }).where(eq(products.id, productId));
    }
  } catch {
    /* analytics must never surface an error to the user */
  }
  return new NextResponse(null, { status: 204 });
}
