import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { cartItems, carts, products } from "@/db/schema";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Cart persistence for the cart-recovery cron.
 *
 * The cart itself lives in localStorage — the customer sees instant, offline
 * behaviour and nothing here blocks the UI. This endpoint is a best-effort
 * mirror of the open cart into the `carts`/`cart_items` tables so the hourly
 * cart-recovery job (and admin analytics) can see abandoned carts.
 *
 * Anonymous by design (no PII beyond the anon id). Rate-limited per IP;
 * failures are ignored by the client.
 */
export async function POST(request: Request) {
  const ip = clientKey(request);
  const rl = rateLimit(`cart-sync:${ip}`, { max: 30, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  let body: { items?: Array<{ productId?: string; qty?: number; variant?: string }> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const items = (body.items ?? []).filter((i) => i?.productId && Number.isFinite(i.qty)).slice(0, 50);
  if (!items.length) return NextResponse.json({ ok: true, synced: 0 });

  // Resolve current prices from the products table — never trust client
  // prices in storage, only the cart display uses them.
  const ids = [...new Set(items.map((i) => i.productId!))];
  const rows = await db
    .select({ id: products.id, price: products.price })
    .from(products)
    .where(inArray(products.id, ids));
  const priceBy = new Map(rows.map((r) => [r.id, r.price]));

  try {
    const anonId = request.headers.get("x-mh-anon") || "anonymous";
    const [cart] = await db
      .insert(carts)
      .values({ anonId, status: "open", updatedAt: new Date() })
      .onConflictDoNothing()
      .returning({ id: carts.id });
    const existing = cart
      ? cart
      : (await db.select({ id: carts.id }).from(carts).where(and(eq(carts.anonId, anonId), eq(carts.status, "open"))).orderBy(carts.updatedAt).limit(1))[0];
    if (!existing) return NextResponse.json({ ok: false, error: "no_cart" }, { status: 500 });

    // Replace the previous snapshot for this cart (single open cart per anon).
    // Only mirror lines whose product still exists — a stale/removed product
    // id must never fail the whole mirror.
    const validItems = items.filter((i) => priceBy.has(i.productId!));
    await db.delete(cartItems).where(eq(cartItems.cartId, existing.id));
    if (validItems.length) {
      await db.insert(cartItems).values(
        validItems.map((i) => ({
          cartId: existing.id,
          productId: i.productId!,
          qty: Math.max(1, Math.min(10, i.qty!)),
          unitPrice: priceBy.get(i.productId!) ?? 0,
        })),
      );
    }
    await db.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, existing.id));
    return NextResponse.json({ ok: true, synced: validItems.length, cartId: existing.id });
  } catch {
    // The cart page must never break because the mirror failed.
    return NextResponse.json({ ok: true, synced: 0, note: "mirror skipped" });
  }
}
