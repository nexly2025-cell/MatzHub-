import { NextResponse } from "next/server";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { cartItems, carts, products } from "@/db/schema";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Best-effort cart mirror for recovery and operations analytics.
 *
 * The customer cart remains local-first in browser storage. This endpoint only
 * stores a server-validated snapshot and must never block browsing or imply
 * that an order has been placed.
 */
type CartLine = { productId?: unknown; qty?: unknown; variant?: unknown };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const ip = clientKey(request);
  const rl = rateLimit(`cart-sync:${ip}`, { max: 30, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });

  const anonId = request.headers.get("x-mh-anon")?.trim() ?? "";
  if (!UUID.test(anonId)) return NextResponse.json({ ok: false, error: "invalid_cart_identity" }, { status: 400 });

  let body: { items?: CartLine[] };
  try {
    body = (await request.json()) as { items?: CartLine[] };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((item): item is { productId: string; qty: number; variant?: string } =>
      typeof item?.productId === "string" && UUID.test(item.productId) &&
      typeof item.qty === "number" && Number.isFinite(item.qty) && item.qty > 0,
    )
    .slice(0, 50);

  try {
    if (!items.length) {
      // An intentional clear must not later produce an abandoned-cart reminder.
      await db.delete(carts).where(and(eq(carts.anonId, anonId), eq(carts.status, "open")));
      return NextResponse.json({ ok: true, synced: 0 });
    }

    // Resolve live price and availability from Postgres. Client storage is only
    // a display cache and can contain archived or modified values.
    const ids = [...new Set(items.map((item) => item.productId))];
    const rows = await db
      .select({ id: products.id, price: products.price })
      .from(products)
      .where(and(inArray(products.id, ids), eq(products.status, "published"), ne(products.availability, "out_of_stock")));
    const priceById = new Map(rows.map((row) => [row.id, row.price]));
    const validItems = items.filter((item) => priceById.has(item.productId));

    // Reuse the active snapshot. The schema deliberately permits historical
    // carts, so there is no unsafe global anonymous-cart uniqueness assumption.
    let [cart] = await db
      .select({ id: carts.id })
      .from(carts)
      .where(and(eq(carts.anonId, anonId), eq(carts.status, "open")))
      .orderBy(desc(carts.updatedAt))
      .limit(1);

    if (!cart) {
      [cart] = await db
        .insert(carts)
        .values({ anonId, status: "open", updatedAt: new Date() })
        .returning({ id: carts.id });
    }

    await db.delete(cartItems).where(eq(cartItems.cartId, cart.id));
    if (validItems.length) {
      await db.insert(cartItems).values(
        validItems.map((item) => ({
          cartId: cart.id,
          productId: item.productId,
          qty: Math.max(1, Math.min(10, Math.floor(item.qty))),
          unitPrice: priceById.get(item.productId) ?? 0,
        })),
      );
    }
    await db.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cart.id));

    return NextResponse.json({ ok: true, synced: validItems.length, cartId: cart.id });
  } catch {
    // Recovery telemetry is optional. Never let a transient database failure
    // interrupt a local cart interaction.
    return NextResponse.json({ ok: true, synced: 0, note: "mirror_unavailable" });
  }
}
