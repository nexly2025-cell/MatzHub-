import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { notifications, orderItems, orders, products } from "@/db/schema";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { DELIVERY_FEE, FREE_DELIVERY_OVER, MAX_QTY_PER_LINE, orderNo as newOrderNo } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Order submission.
 *
 * This is the step the storefront was missing. The cart previously opened a
 * wa.me link and nothing was ever written down: no row in `orders`, no order
 * number, and /track could only resolve orders an operator had retyped by hand
 * into /admin/orders. Anything the customer never repeated in the chat was
 * simply lost.
 *
 * THERE IS NO PAYMENT HERE. This records an *intent to buy* and hands it to a
 * human on WhatsApp. `payment_status` stays "pending" and no code path in this
 * file marks an order paid, confirmed or shipped.
 *
 * Pricing is server-authoritative. The client sends product ids and quantities
 * only; every rupee is re-read from the products table. A tampered localStorage
 * cart cannot change what gets recorded.
 */

const MAX_LINES = 20;

/** Indian mobile: 10 digits starting 6-9, tolerating +91 / 0 prefixes. */
function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

const clean = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";

type Body = {
  customer?: {
    name?: unknown; phone?: unknown; addressLine?: unknown;
    city?: unknown; state?: unknown; pincode?: unknown; notes?: unknown;
  };
  items?: Array<{ productId?: unknown; qty?: unknown; variant?: unknown }>;
};

export async function POST(request: Request) {
  // Orders are cheap to place and expensive to clean up. Throttle per IP.
  const rl = rateLimit(`orders:${clientKey(request)}`, { max: 6, windowMs: 10 * 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many orders from this connection. Try again shortly." },
      { status: 429 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // ── customer ───────────────────────────────────────────────────────────
  const c = body.customer ?? {};
  const name = clean(c.name, 80);
  const phone = normalisePhone(clean(c.phone, 20));
  const addressLine = clean(c.addressLine, 200);
  const city = clean(c.city, 60);
  const state = clean(c.state, 60);
  const pincode = clean(c.pincode, 10);
  const notes = clean(c.notes, 300);

  const invalid: Record<string, string> = {};
  if (name.length < 2) invalid.name = "Enter your full name.";
  if (!phone) invalid.phone = "Enter a valid 10-digit mobile number.";
  if (addressLine.length < 8) invalid.addressLine = "Enter your full address.";
  if (city.length < 2) invalid.city = "Enter your city.";
  if (state.length < 2) invalid.state = "Enter your state.";
  if (!/^\d{6}$/.test(pincode)) invalid.pincode = "Enter a valid 6-digit PIN code.";
  if (Object.keys(invalid).length || !phone) {
    return NextResponse.json({ ok: false, error: "validation_failed", fields: invalid }, { status: 400 });
  }
  // Past the guard `phone` is a validated 10-digit string.
  const customerPhone: string = phone;

  // ── lines ──────────────────────────────────────────────────────────────
  const raw = (body.items ?? []).slice(0, MAX_LINES);
  const wanted = raw
    .map((i) => ({
      productId: typeof i.productId === "string" ? i.productId : "",
      qty: Math.max(1, Math.min(MAX_QTY_PER_LINE, Math.trunc(Number(i.qty)) || 0)),
      variant: clean(i.variant, 60) || null,
    }))
    .filter((i) => /^[0-9a-f-]{36}$/i.test(i.productId) && i.qty > 0);

  if (!wanted.length) {
    return NextResponse.json({ ok: false, error: "Your cart is empty." }, { status: 400 });
  }

  // Re-read authoritative price, title, image and availability.
  const live = await db
    .select({
      id: products.id,
      title: products.title,
      heroImage: products.heroImage,
      price: products.price,
      costPrice: products.costPrice,
      availability: products.availability,
      status: products.status,
      manufacturerId: products.manufacturerId,
    })
    .from(products)
    .where(inArray(products.id, [...new Set(wanted.map((i) => i.productId))]));

  const by = new Map(live.map((p) => [p.id, p]));
  const unavailable: string[] = [];
  const lines: Array<{
    productId: string;
    manufacturerId: string | null;
    titleSnapshot: string;
    imageSnapshot: string;
    variantLabel: string | null;
    qty: number;
    unitPrice: number;
    unitCost: number;
    lineTotal: number;
  }> = [];

  for (const line of wanted) {
    const p = by.get(line.productId);
    if (!p || p.status !== "published" || p.availability === "out_of_stock") {
      unavailable.push(p?.title ?? "An item in your cart");
      continue;
    }
    lines.push({
      productId: p.id,
      manufacturerId: p.manufacturerId,
      titleSnapshot: p.title,
      imageSnapshot: p.heroImage,
      variantLabel: line.variant,
      qty: line.qty,
      unitPrice: p.price,
      unitCost: p.costPrice ?? 0,
      lineTotal: p.price * line.qty,
    });
  }

  // Refuse a partial order rather than silently dropping a line the customer
  // believes they bought.
  if (unavailable.length) {
    return NextResponse.json(
      {
        ok: false,
        error: "unavailable_items",
        message: `${unavailable.join(", ")} is no longer available. Remove it and try again.`,
        unavailable,
      },
      { status: 409 },
    );
  }

  // Idempotency. A double-tapped button or a client retry after a timeout must
  // not become two orders — verified in testing, where two concurrent POSTs
  // produced two order numbers for one cart. The key is derived from the parts
  // that define the order, and bucketed into a 10-minute window so a genuine
  // repeat purchase later in the day is still allowed through.
  const window = Math.floor(Date.now() / (10 * 60_000));
  const fingerprint = [
    phone,
    window,
    ...wanted.map((i) => `${i.productId}:${i.qty}:${i.variant ?? ""}`).sort(),
  ].join("|");
  const idempotencyKey = crypto.createHash("sha256").update(fingerprint).digest("hex");

  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const shipping = subtotal >= FREE_DELIVERY_OVER ? 0 : DELIVERY_FEE;
  const total = subtotal + shipping;
  const costTotal = lines.reduce((n, l) => n + l.unitCost * l.qty, 0);

  // ── persist ────────────────────────────────────────────────────────────
  // One transaction: an order without its items is worse than no order.
  // orderNo has a unique index; retry once on the (vanishingly rare) collision.
  try {
    const created = await db.transaction(async (tx) => {
      // Fast path: the same cart was already accepted in this window.
      const [replay] = await tx
        .select({ id: orders.id, orderNo: orders.orderNo })
        .from(orders)
        .where(eq(orders.idempotencyKey, idempotencyKey))
        .limit(1);
      if (replay) return { ...replay, duplicate: true };

      let orderNo = newOrderNo();
      let row;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const inserted = await tx
          .insert(orders)
          .values({
            orderNo,
            anonId: request.headers.get("x-mh-anon")?.slice(0, 64) || null,
            idempotencyKey,
            customerName: name,
            phone: customerPhone,
            addressLine,
            city,
            state,
            pincode,
            notes: notes || null,
            subtotal,
            shipping,
            total,
            costTotal,
            profit: total - shipping - costTotal,
            // No gateway and no COD: nothing is settled at this point.
            paymentMode: "to_arrange",
            paymentStatus: "pending",
            status: "placed",
            timeline: [{ at: new Date().toISOString(), status: "placed", note: "Submitted from the website" }],
          })
          // No target: this must swallow a collision on EITHER orderNo or
          // idempotencyKey. Targeting orderNo alone let a concurrent duplicate
          // raise and abort the whole transaction.
          .onConflictDoNothing()
          .returning({ id: orders.id, orderNo: orders.orderNo });
        if (inserted.length) {
          row = inserted[0];
          break;
        }
        orderNo = newOrderNo();
      }
      // A conflict on idempotencyKey (not orderNo) means this exact cart was
      // already accepted moments ago. Return that order rather than a second.
      if (!row) {
        const [existing] = await tx
          .select({ id: orders.id, orderNo: orders.orderNo })
          .from(orders)
          .where(eq(orders.idempotencyKey, idempotencyKey))
          .limit(1);
        if (existing) return { ...existing, duplicate: true };
        throw new Error("could not allocate an order number");
      }

      await tx.insert(orderItems).values(lines.map((l) => ({ ...l, orderId: row.id })));

      // Queue the operator alert on the existing notifications pipeline rather
      // than calling Telegram inline — a Telegram outage must never fail a
      // customer's order, and the existing cron already handles retries.
      await tx.insert(notifications).values({
        channel: "telegram",
        audience: "admin",
        recipient: "admin",
        template: "supplier_dispatch_request",
        payload: {
          orderNo: row.orderNo,
          total,
          city,
          items: lines.map((l) => ({ titleSnapshot: l.titleSnapshot, variantLabel: l.variantLabel, qty: l.qty })),
        },
      });

      return { ...row, duplicate: false };
    });

    // 200 (not 201) on a replay makes the idempotent path observable.
    return NextResponse.json(
      { ok: true, orderNo: created.orderNo, total, duplicate: created.duplicate },
      { status: created.duplicate ? 200 : 201 },
    );
  } catch {
    // Never leak a driver error to the storefront.
    return NextResponse.json(
      { ok: false, error: "We could not save your order. Please try again, or message us on WhatsApp." },
      { status: 500 },
    );
  }
}
