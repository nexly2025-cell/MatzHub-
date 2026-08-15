import type { Metadata } from "next";
import { SITE } from "@/lib/utils";

export const metadata: Metadata = {
  title: "FAQ — shipping, returns, authenticity and payments",
  description:
    "Straight answers on MatzHub delivery times, payment, the 7-day replacement policy and product authenticity labelling.",
  alternates: { canonical: "/faq" },
};

/**
 * Customer-facing only.
 *
 * Previously this described private WhatsApp supplier groups, an "automated
 * pipeline", per-manufacturer markups and reseller cost multiples. That is
 * internal commercial information — it tells a buyer how the supply side is
 * organised and what our margin is. Every answer here is now about the thing
 * the customer actually has: the product, the order, the delivery.
 */
const FAQS: Array<{ q: string; a: string }> = [
  { q: "What is MatzHub?", a: "A curated catalogue of imported watches, handbags, footwear, eyewear, apparel and perfumes. Every piece is inspected and scored before it is listed, and priced honestly — one fixed margin, no inflated MRP invented to make a discount look bigger." },
  { q: "Are these original branded goods?", a: "No, and we never suggest otherwise. What we list is imported first-copy, master-quality merchandise, stated plainly on every product page. We are not affiliated with, endorsed by or licensed by any original brand." },
  { q: "How do I place an order?", a: "Open any product and tap Buy on WhatsApp. The message arrives with the piece, size and reference already filled in. Our team confirms availability and takes it from there." },
  { q: "How do I pay?", a: "Payment is arranged with our team on WhatsApp once your order is confirmed. Cash on delivery is not offered." },
  { q: "How long does delivery take?", a: "Dispatch is within 24 to 48 hours of confirmation. Metro cities usually receive in 2 to 4 working days and the rest of India in 4 to 7. Remote PIN codes can take up to 10." },
  { q: "How do I track my order?", a: "Your order number is sent to you on WhatsApp. Enter it on the Track page to see live progress from confirmed through delivered, along with the courier link once it ships." },
  { q: "What is the return policy?", a: "Seven days from delivery. If an item does not match the listing, arrives damaged or is the wrong size, we replace it free. Size exchanges on unworn footwear and apparel with tags intact are free." },
  { q: "Are the sizes and measurements accurate?", a: "Yes. Every listing carries real measurements taken from the piece itself — insole length for footwear, dimensions in centimetres for bags, case size for watches. Match them against something you already own rather than relying on a size label." },
  { q: "Why do some products disappear?", a: "Stock is finite and a listing is removed once it can no longer be fulfilled, rather than left on the site to disappoint you at checkout. If something you saved is gone, message us — we will tell you whether it is returning." },
  { q: "Can I ask a question before buying?", a: "Yes, and we would rather you did. Message us on WhatsApp about sizing, materials, colour accuracy or availability and a person will answer during working hours." },
];


const crumbs = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
    { "@type": "ListItem", position: 2, name: "FAQ", item: `${SITE.url}/faq` },
  ],
};

export default function FAQPage() {
  const ld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${SITE.url}/faq#faq`,
    mainEntity: FAQS.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(crumbs) }} />

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <div className="shell max-w-3xl py-16">
        <p className="eyebrow mb-4">Support</p>
        <h1 className="t-title mb-10">Frequently asked questions</h1>
        <div className="space-y-2">
          {FAQS.map((f) => (
            <details key={f.q} className="surface group px-6 py-5">
              <summary className="t-heading flex cursor-pointer list-none items-start justify-between gap-4">
                {f.q}
                <span className="text-accent transition-transform group-open:rotate-45" aria-hidden>+</span>
              </summary>
              <p className="t-body measure mt-3">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </>
  );
}
