import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { SITE, inr, relativeTime, waLink } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Track your order",
  description:
    "Enter your MatzHub order number to see live dispatch and delivery progress. Order numbers are shared on WhatsApp once your order is confirmed.",
  alternates: { canonical: "/track" },
  openGraph: { title: "Track your MatzHub order", url: `${SITE.url}/track` },
};

/**
 * Order tracking.
 *
 * Orders are agreed in conversation on WhatsApp — the site has no cart and no
 * checkout. Once the team confirms an order they record it and share the order
 * number, which is what this page resolves. It is read-only: nothing here can
 * create, modify or pay for an order.
 *
 * Supplier identity is deliberately absent. The customer sees what they bought
 * and where it is, never who made it or which group it came from.
 */

const STAGES = [
  { key: "placed", label: "Order confirmed", blurb: "We have your order and are preparing it." },
  { key: "packed", label: "Packed", blurb: "Quality-checked and boxed." },
  { key: "shipped", label: "Shipped", blurb: "Handed to the courier." },
  { key: "delivered", label: "Delivered", blurb: "Signed for at your address." },
] as const;

const TERMINAL: Record<string, { label: string; blurb: string }> = {
  cancelled: { label: "Cancelled", blurb: "This order was cancelled. Message us if that looks wrong." },
  returned: { label: "Returned", blurb: "The return was received and processed." },
};

/** How far along the four-stage bar a status sits. `confirmed` maps onto `placed`. */
function stageIndex(status: string): number {
  const normalised = status === "confirmed" ? "placed" : status;
  const i = STAGES.findIndex((s) => s.key === normalised);
  return i === -1 ? 0 : i;
}


const crumbs = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
    { "@type": "ListItem", position: 2, name: "Track order", item: `${SITE.url}/track` },
  ],
};

export default async function TrackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = typeof sp.no === "string" ? sp.no.trim().toUpperCase() : "";

  const order = raw
    ? (
        await db
          .select({
            orderNo: orders.orderNo,
            customerName: orders.customerName,
            city: orders.city,
            state: orders.state,
            status: orders.status,
            total: orders.total,
            courier: orders.courier,
            trackingUrl: orders.trackingUrl,
            timeline: orders.timeline,
            createdAt: orders.createdAt,
            updatedAt: orders.updatedAt,
          })
          .from(orders)
          .where(eq(orders.orderNo, raw))
          .limit(1)
      )[0]
    : undefined;

  const notFound = Boolean(raw) && !order;
  const terminal = order ? TERMINAL[order.status] : undefined;
  const active = order && !terminal ? stageIndex(order.status) : -1;

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(crumbs) }} />
      <div className="shell py-12 sm:py-16 lg:py-20">
      <div className="mx-auto max-w-2xl">
        <p className="eyebrow mb-3">Order status</p>
        <h1 className="t-title">Track your order</h1>
        <p className="t-lead mt-5">
          Enter the order number our team shared with you on WhatsApp. It looks like{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[13px]">MH2608141A2B</code>.
        </p>

        {/* GET keeps the result linkable and shareable, and works without JS. */}
        <form method="GET" action="/track" className="mt-7 flex flex-col gap-3 sm:flex-row">
          <label htmlFor="no" className="sr-only">
            Order number
          </label>
          <input
            id="no"
            name="no"
            defaultValue={raw}
            required
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="MH2608141A2B"
            aria-describedby={notFound ? "track-error" : undefined}
            className="field flex-1 font-mono text-[15px] uppercase tracking-wider"
          />
          <button type="submit" className="btn btn-solid sm:w-auto">
            Track
          </button>
        </form>

        {notFound && (
          <div id="track-error" role="status" className="surface mt-6 p-5">
            <p className="t-body text-ink">
              No order found for <span className="font-mono">{raw}</span>.
            </p>
            <p className="t-body mt-2">
              Order numbers are case-insensitive but must match exactly. If you have just placed the
              order, give us a few minutes to record it.
            </p>
            <a
              href={waLink(`Hi MatzHub, I can't track order ${raw}. Could you check it for me?`)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-whatsapp mt-4"
            >
              Ask us on WhatsApp
            </a>
          </div>
        )}

        {order && (
          <section className="mt-8" aria-label={`Status for order ${order.orderNo}`}>
            <div className="surface p-5 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="label text-subtle">Order</p>
                  <p className="font-mono text-[17px] text-ink">{order.orderNo}</p>
                </div>
                <div className="text-right">
                  <p className="label text-subtle">Total</p>
                  <p className="font-display text-[19px] text-ink">{inr(order.total)}</p>
                </div>
              </div>

              <p className="t-meta mt-5 border-t border-line pt-5">
                {order.customerName.split(" ")[0]} · {order.city}, {order.state} · placed{" "}
                {relativeTime(order.createdAt)}
              </p>

              {terminal ? (
                <div className="mt-6 rounded-lg border border-line bg-surface-2 p-4">
                  <p className="t-heading">{terminal.label}</p>
                  <p className="t-body mt-1.5">{terminal.blurb}</p>
                </div>
              ) : (
                <ol className="mt-7 space-y-0" role="list">
                  {STAGES.map((s, i) => {
                    const done = i <= active;
                    const current = i === active;
                    return (
                      <li key={s.key} className="relative flex gap-4 pb-7 last:pb-0">
                        {/* Connector stops at the last node so it never dangles. */}
                        {i < STAGES.length - 1 && (
                          <span
                            aria-hidden
                            className={`absolute left-[11px] top-6 h-full w-px ${done ? "bg-accent" : "bg-line"}`}
                          />
                        )}
                        <span
                          aria-hidden
                          className={`relative z-10 mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 ${
                            done ? "border-accent bg-accent text-white" : "border-line bg-surface text-subtle"
                          }`}
                        >
                          {done ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          ) : (
                            <span className="h-1.5 w-1.5 rounded-full bg-current" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={`text-[15px] ${current ? "font-semibold text-ink" : done ? "text-ink" : "text-subtle"}`}>
                            {s.label}
                          </p>
                          <p className="t-meta mt-1">{s.blurb}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              {order.courier && (
                <div className="mt-6 border-t border-line pt-5">
                  <p className="label text-subtle">Courier</p>
                  <p className="t-body mt-1.5 text-ink">{order.courier}</p>
                  {order.trackingUrl && (
                    <a
                      href={order.trackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-outline mt-3"
                    >
                      Track with courier
                    </a>
                  )}
                </div>
              )}
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <a
                href={waLink(`Hi MatzHub, a question about order ${order.orderNo}.`)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-whatsapp"
              >
                Ask about this order
              </a>
              <Link href="/" className="btn btn-outline">
                Keep browsing
              </Link>
            </div>
          </section>
        )}

        {!raw && (
          <div className="surface mt-8 p-5 sm:p-6">
            <p className="t-heading">Do not have an order number?</p>
            <p className="t-body mt-2">
              Every order is confirmed on WhatsApp and the number is sent in that same chat. Message
              us and we will find it for you.
            </p>
            <a
              href={waLink("Hi MatzHub, could you send me my order number?")}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-whatsapp mt-4"
            >
              Message us on WhatsApp
            </a>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
