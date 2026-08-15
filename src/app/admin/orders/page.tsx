import { revalidatePath } from "next/cache";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { manufacturers, orderItems, orders, products } from "@/db/schema";
import { inr, orderNo as makeOrderNo, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Order fulfilment.
 *
 * The storefront has no cart and no checkout — orders are agreed on WhatsApp.
 * This is where the team records that conversation so the customer gets an
 * order number to track, and where the status is advanced as it ships.
 *
 * Deliberately minimal: a SKU, who it is for, and where it goes. Nothing here
 * takes payment.
 */

const NEXT_STATUS: Record<string, string[]> = {
  placed: ["packed", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: ["returned"],
};

async function createOrder(formData: FormData) {
  "use server";

  const sku = String(formData.get("sku") ?? "").trim().toUpperCase();
  const customerName = String(formData.get("customerName") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").replace(/\D/g, "");
  const city = String(formData.get("city") ?? "").trim();
  const state = String(formData.get("state") ?? "").trim();
  const pincode = String(formData.get("pincode") ?? "").trim();
  const addressLine = String(formData.get("addressLine") ?? "").trim();
  const qty = Math.max(1, Math.min(20, Number(formData.get("qty") ?? 1)));

  if (!sku || !customerName || phone.length < 10 || !city || !state || !/^\d{6}$/.test(pincode)) return;

  const [p] = await db
    .select({
      id: products.id,
      title: products.title,
      heroImage: products.heroImage,
      price: products.price,
      costPrice: products.costPrice,
      manufacturerId: products.manufacturerId,
    })
    .from(products)
    .where(eq(products.sku, sku))
    .limit(1);
  if (!p) return;

  const subtotal = p.price * qty;
  const [created] = await db
    .insert(orders)
    .values({
      orderNo: makeOrderNo(),
      customerName,
      phone,
      addressLine: addressLine || city,
      city,
      state,
      pincode,
      subtotal,
      discount: 0,
      shipping: 0,
      total: subtotal,
      costTotal: p.costPrice * qty,
      profit: subtotal - p.costPrice * qty,
      paymentMode: "prepaid",
      paymentStatus: "pending",
      status: "placed",
      timeline: [{ at: new Date().toISOString(), status: "placed", note: "Recorded from WhatsApp" }],
    })
    .returning({ id: orders.id });

  await db.insert(orderItems).values({
    orderId: created.id,
    productId: p.id,
    manufacturerId: p.manufacturerId,
    titleSnapshot: p.title,
    imageSnapshot: p.heroImage,
    qty,
    unitPrice: p.price,
    unitCost: p.costPrice,
    lineTotal: subtotal,
  });

  // Stock follows the sale so the storefront stops offering what is gone.
  await db
    .update(products)
    .set({
      stockQty: sql`greatest(0, ${products.stockQty} - ${qty})`,
      orders: sql`${products.orders} + ${qty}`,
    })
    .where(eq(products.id, p.id));

  revalidatePath("/admin/orders");
}

async function advance(formData: FormData) {
  "use server";

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const courier = String(formData.get("courier") ?? "").trim();
  const trackingUrl = String(formData.get("trackingUrl") ?? "").trim();
  if (!id || !status) return;

  const [current] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, id)).limit(1);
  if (!current || !(NEXT_STATUS[current.status] ?? []).includes(status)) return;

  await db
    .update(orders)
    .set({
      status,
      ...(courier ? { courier } : {}),
      ...(trackingUrl.startsWith("https://") ? { trackingUrl } : {}),
      updatedAt: new Date(),
      timeline: sql`${orders.timeline} || ${JSON.stringify([{ at: new Date().toISOString(), status }])}::jsonb`,
    })
    // Optimistic lock: refuses if someone else advanced it first.
    .where(sql`${orders.id} = ${id} and ${orders.status} = ${current.status}`);

  revalidatePath("/admin/orders");
}

export default async function AdminOrders() {
  const rows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      customerName: orders.customerName,
      phone: orders.phone,
      city: orders.city,
      total: orders.total,
      profit: orders.profit,
      status: orders.status,
      courier: orders.courier,
      createdAt: orders.createdAt,
      item: orderItems.titleSnapshot,
      qty: orderItems.qty,
      supplier: manufacturers.name,
      supplierGroup: manufacturers.sourceGroupName,
    })
    .from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .leftJoin(manufacturers, eq(manufacturers.id, orderItems.manufacturerId))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  const open = rows.filter((r) => !["delivered", "cancelled", "returned"].includes(r.status));

  return (
    <div className="shell py-8">
      <h1 className="display text-3xl">Orders</h1>
      <p className="mb-8 mt-1 text-sm text-muted">
        Record an order agreed on WhatsApp, then advance it as it ships. {open.length} open.
      </p>

      <section className="surface mb-10 p-5 sm:p-6">
        <h2 className="eyebrow mb-4">Record a new order</h2>
        <form action={createOrder} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input name="sku" required placeholder="SKU (MH-WAT-A1B2C3)" className="field font-mono uppercase" />
          <input name="qty" type="number" min={1} max={20} defaultValue={1} placeholder="Qty" className="field" />
          <input name="customerName" required placeholder="Customer name" className="field" />
          <input name="phone" required inputMode="numeric" placeholder="Phone (10 digits)" className="field" />
          <input name="addressLine" placeholder="Address line" className="field" />
          <input name="city" required placeholder="City" className="field" />
          <input name="state" required placeholder="State" className="field" />
          <input name="pincode" required inputMode="numeric" placeholder="PIN code" className="field" />
          <button className="btn btn-solid">Create order</button>
        </form>
      </section>

      {rows.length === 0 ? (
        <div className="surface grid place-items-center py-16 text-center">
          <p className="display text-xl">No orders yet</p>
          <p className="mt-1 text-sm text-muted">Recorded orders appear here and become trackable at /track.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((o) => (
            <li key={o.id} className="surface p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-[15px] text-ink">{o.orderNo}</p>
                  <p className="mt-0.5 truncate text-[13px] text-muted">
                    {o.item ?? "—"} {o.qty ? `× ${o.qty}` : ""}
                  </p>
                  <p className="mt-1 text-[12px] text-subtle">
                    {o.customerName} · {o.phone} · {o.city} · {relativeTime(o.createdAt)}
                  </p>
                  {/* Internal only: which supplier fulfils this line. */}
                  <p className="mt-1 text-[12px] text-subtle">
                    Fulfil from: {o.supplierGroup ?? o.supplier ?? "unassigned"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-display text-[17px] text-ink">{inr(o.total)}</p>
                  <p className="text-[11.5px] text-subtle">margin {inr(o.profit)}</p>
                  <span className="label mt-1 inline-block rounded-full border border-line px-2 py-0.5">{o.status}</span>
                </div>
              </div>

              {(NEXT_STATUS[o.status] ?? []).length > 0 && (
                <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
                  {(NEXT_STATUS[o.status] ?? []).map((next) => (
                    <form key={next} action={advance} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={o.id} />
                      <input type="hidden" name="status" value={next} />
                      {next === "shipped" && (
                        <>
                          <input name="courier" placeholder="Courier" className="field w-32 text-[13px]" />
                          <input name="trackingUrl" placeholder="https://tracking-url" className="field w-56 text-[13px]" />
                        </>
                      )}
                      <button className="btn btn-outline px-4 py-2 text-xs">Mark {next}</button>
                    </form>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
