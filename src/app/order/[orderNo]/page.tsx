import Image from "next/image";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { orderItems, orders } from "@/db/schema";
import { inr, waLink } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ orderNo: string }>;
  searchParams: Promise<{ token?: string | string[] }>;
};

const TOKEN = /^[A-Za-z0-9_-]{32,}$/;

export default async function OrderConfirmationPage({ params, searchParams }: Props) {
  const { orderNo } = await params;
  const tokenValue = (await searchParams).token;
  const token = typeof tokenValue === "string" ? tokenValue : "";
  if (!TOKEN.test(token)) notFound();

  const [order] = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      customerName: orders.customerName,
      city: orders.city,
      state: orders.state,
      pincode: orders.pincode,
      subtotal: orders.subtotal,
      shipping: orders.shipping,
      total: orders.total,
      status: orders.status,
    })
    .from(orders)
    .where(and(eq(orders.orderNo, orderNo.toUpperCase()), eq(orders.accessToken, token)))
    .limit(1);
  if (!order) notFound();

  const items = await db
    .select({
      id: orderItems.id,
      title: orderItems.titleSnapshot,
      image: orderItems.imageSnapshot,
      variant: orderItems.variantLabel,
      qty: orderItems.qty,
      lineTotal: orderItems.lineTotal,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  const trackHref = `/track?no=${encodeURIComponent(order.orderNo)}&token=${encodeURIComponent(token)}`;

  return (
    <div className="shell py-12 sm:py-16 lg:py-20">
      <div className="mx-auto max-w-3xl">
        <section className="surface overflow-hidden">
          <div className="border-b border-line p-6 sm:p-8">
            <p className="eyebrow">Order request received</p>
            <h1 className="display mt-3 text-[clamp(2rem,5vw,3.2rem)]">Thank you, {order.customerName.split(" ")[0]}.</h1>
            <p className="t-lead mt-4 max-w-xl">We’ll check live availability and confirm your delivery details with you on WhatsApp before dispatch.</p>
            <p className="mt-5 font-mono text-[13px] tracking-wide text-muted">Reference: {order.orderNo}</p>
          </div>

          <div className="p-6 sm:p-8">
            <p className="eyebrow mb-2">Delivery</p>
            <p className="text-[15px] text-ink">{order.city}, {order.state} · {order.pincode}</p>

            <ul className="mt-7 divide-y divide-line border-y border-line">
              {items.map((item) => (
                <li key={item.id} className="flex gap-4 py-4">
                  <div className="relative h-16 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-3">
                    <Image src={item.image} alt="" fill sizes="56px" className="object-cover" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-ink">{item.title}</p>
                    <p className="mt-1 text-[12px] text-muted">{item.variant ? `${item.variant} · ` : ""}Qty {item.qty}</p>
                  </div>
                  <p className="shrink-0 font-display text-[16px] text-ink">{inr(item.lineTotal)}</p>
                </li>
              ))}
            </ul>

            <dl className="mt-5 max-w-sm space-y-2 text-[13px] sm:ml-auto">
              <div className="flex justify-between gap-8"><dt className="text-muted">Subtotal</dt><dd>{inr(order.subtotal)}</dd></div>
              <div className="flex justify-between gap-8"><dt className="text-muted">Delivery</dt><dd>{order.shipping ? inr(order.shipping) : "Free"}</dd></div>
              <div className="flex justify-between gap-8 border-t border-line pt-3 font-semibold text-ink"><dt>Total</dt><dd className="font-display text-[21px]">{inr(order.total)}</dd></div>
            </dl>
          </div>
        </section>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={trackHref} className="btn btn-solid">Track order</Link>
          <a href={waLink(`Hi MatzHub, I have a question about order ${order.orderNo}.`)} target="_blank" rel="noopener noreferrer" className="btn btn-whatsapp">Message us on WhatsApp</a>
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-muted">Keep this private link to check the status of your order. No payment has been taken through this website.</p>
      </div>
    </div>
  );
}
