import type { Metadata } from "next";
import Link from "next/link";
import { SITE, waLink } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Contact support",
  description:
    "Reach the MatzHub team on WhatsApp for order help, delivery questions, replacements and size exchanges. Replies within working hours, every day except Sunday.",
  alternates: { canonical: "/contact" },
  openGraph: { title: "Contact MatzHub", url: `${SITE.url}/contact` },
};

/**
 * Customer support only.
 *
 * This page previously listed reseller onboarding, reseller sign-in and
 * manufacturing partnerships. Suppliers and resellers are counterparties, not
 * customers, and surfacing those routes told visitors how the supply side is
 * organised. Reseller access is arranged privately; manufacturers are onboarded
 * by the team directly.
 */

const ld = {
  "@context": "https://schema.org",
  "@type": "ContactPage",
  name: "Contact MatzHub",
  url: `${SITE.url}/contact`,
  mainEntity: { "@id": `${SITE.url}/#organization` },
};

const ROUTES: Array<{ t: string; d: string; a: string }> = [
  {
    t: "Order help",
    d: "Delivery status, address changes, replacements and size exchanges. Have your order number ready.",
    a: "Hi MatzHub, I need help with an order.",
  },
  {
    t: "Before you buy",
    d: "Sizing, materials, measurements, colours and availability on any listing.",
    a: "Hi MatzHub, I have a question about a product.",
  },
  {
    t: "Something went wrong",
    d: "Damaged, incorrect or missing items. We sort it out inside the 7-day window.",
    a: "Hi MatzHub, there is a problem with my order.",
  },
];


const crumbs = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
    { "@type": "ListItem", position: 2, name: "Contact", item: `${SITE.url}/contact` },
  ],
};

export default function Contact() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(crumbs) }} />

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />

      <div className="shell py-12 sm:py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="eyebrow mb-3">Support</p>
          <h1 className="t-title">We reply on WhatsApp</h1>
          <p className="t-lead measure mt-5">
            One channel, staffed by people who can actually see your order. No ticket numbers and no
            queue.
          </p>

          <div className="mt-9 grid gap-3 sm:grid-cols-3">
            {ROUTES.map((r) => (
              <a
                key={r.t}
                href={waLink(r.a)}
                target="_blank"
                rel="noopener noreferrer"
                className="surface card-lift block p-5"
              >
                <p className="t-heading">{r.t}</p>
                <p className="t-body mt-2.5">{r.d}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent">
                  Open WhatsApp
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </span>
              </a>
            ))}
          </div>

          <div className="surface mt-8 p-5 sm:p-7">
            <p className="eyebrow mb-4">Direct</p>
            <dl className="grid gap-5 text-sm sm:grid-cols-3">
              <div>
                <dt className="label text-subtle">WhatsApp</dt>
                <dd className="mt-1.5">
                  <a href={`https://wa.me/${SITE.whatsapp}`} target="_blank" rel="noopener noreferrer" className="text-ink hover:text-accent">
                    +{SITE.whatsapp}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="label text-subtle">Email</dt>
                <dd className="mt-1.5">
                  <a href={`mailto:${SITE.email}`} className="text-ink hover:text-accent">
                    {SITE.email}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="label text-subtle">Hours</dt>
                <dd className="mt-1.5 text-ink">10am–8pm IST · Mon–Sat</dd>
              </div>
            </dl>
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/track" className="btn btn-outline">
              Track an order
            </Link>
            <Link href="/faq" className="btn btn-ghost">
              Read the FAQ
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
