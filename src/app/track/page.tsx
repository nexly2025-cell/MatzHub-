import type { Metadata } from "next";
import Link from "next/link";
import { and, eq, or } from "drizzle-orm";
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
 * This page is read-only: it never creates, modifies, or takes payment for an
 * order. A customer opens the secure link from their order confirmation, or
 * verifies the order number with the matching mobile number.
 *
 * Supplier identity is deliberately absent. The customer sees what they bought
 * and where it is, never who made it or which group it came from.
 */

const STAGES = [
  { key: "placed", label: "Request received", blurb: "We are checking live availability and delivery details." },
  { key: "confirmed", label: "Confirmed", blurb: "Your order is confirmed and being prepared." },
  { key: "packed", label: "Packed", blurb: "Quality-checked and boxed." },
  { key: "shipped", label: "Shipped", blurb: "Handed to the courier." },
  { key: "delivered", label: "Delivered", blurb: "Signed for at your address." },
] as const;

const TERMINAL: Record<string, { label: string; blurb: string }> = {
  cancelled: { label: "Cancelled", blurb: "This order was cancelled. Message us if that looks wrong." },
  returned: { label: "Returned", blurb: "The return was received and processed." },
};

/** How far along the customer-visible order timeline a status sits. */
function stageIndex(status: string): number {
  const i = STAGES.findIndex((stage) => stage.key === status);
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
  const token = typeof sp.token === "string" ? sp.token.trim() : "";
  const phoneDigits = typeof sp.phone === "string" ? sp.phone.replace(/\D/g, "") : "";
  const phone = /^(?:91)?[6-9]\d{9}$/.test(phoneDigits)
    ? (phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits)
    : "";
  const hasSecureToken = /^[A-Za-z0-9_-]{32,}$/.test(token);
  const canLookup = Boolean(raw && (hasSecureToken || phone));

  const order = canLookup
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
          .where(
            and(
              eq(orders.orderNo, raw),
              hasSecureToken
                ? eq(orders.accessToken, token)
                : or(eq(orders.phone, phone), eq(orders.phone, phone.slice(2))),
            ),
          )
          .limit(1)
      )[0]
    : undefined;

  const missingAccess = Boolean(raw) && !canLookup;
  const notFound = canLookup && !order;
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
          Open the secure link from your order confirmation, or enter your order number with the mobile number used for the order.
        </p>

        {/* GET keeps a secure result linkable and works without client JavaScript. */}
        <form method="GET" action="/track" className="mt-7 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="eyebrow mb-2 block">Order number</span>
            <input
              id="no"
              name="no"
              defaultValue={raw}
              required
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="MH2608141A2B"
              aria-describedby={notFound || missingAccess ? "track-error" : undefined}
              className="field w-full font-mono text-[15px] uppercase tracking-wider"
            />
          </label>
          <label className="block">
            <span className="eyebrow mb-2 block">Mobile number</span>
            <input name="phone" defaultValue={phoneDigits} inputMode="tel" autoComplete="tel" placeholder="91XXXXXXXXXX" className="field w-full" />
          </label>
          <details className="sm:col-span-2">
            <summary className="cursor-pointer text-[12px] text-muted underline underline-offset-4">Have a secure access code instead?</summary>
            <label className="mt-3 block">
              <span className="eyebrow mb-2 block">Secure access code</span>
              <input name="token" defaultValue={token} autoComplete="off" className="field w-full font-mono text-[12px]" />
            </label>
          </details>
          <button type="submit" className="btn btn-solid sm:col-span-2 sm:w-fit">
            Track order
          </button>
        </form>

        {missingAccess && (
          <div id="track-error" role="status" className="surface mt-6 p-5">
            <p className="t-body text-ink">For privacy, enter the mobile number used for this order or use the secure link we shared.</p>
          </div>
        )}

        {notFound && (
          <div id="track-error" role="status" className="surface mt-6 p-5">
            <p className="t-body text-ink">We could not match those order details.</p>
            <p className="t-body mt-2">Check the order number and mobile number, or ask us on WhatsApp if you need help.</p>
            <a
              href={waLink(`Hi MatzHub, I need help tracking order ${raw}.`)}
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
