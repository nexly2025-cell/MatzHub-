import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SITE } from "@/lib/utils";

export const revalidate = 86400;

const DOCS: Record<string, { title: string; desc: string; body: Array<[string, string]> }> = {
  privacy: {
    title: "Privacy Policy",
    desc: "What MatzHub collects, why, how long we keep it and how to have it deleted.",
    body: [
      ["What we collect", "For an order we collect your name, phone number, delivery address and optionally your email. For analytics we store an anonymous device identifier, the pages you view and the searches you run. We do not collect payment card details; prepaid payments are handled by the payment processor and we only receive a status."],
      ["Why we collect it", "Order data exists to deliver the order and support you afterwards. Analytics data exists to decide what to stock, to fix pages that convert badly and to detect fraud. We do not sell personal data to anyone, ever."],
      ["How long we keep it", "Order records are retained for seven years because Indian tax law requires it. Anonymous analytics events are retained for 24 months and then aggregated and deleted. Abandoned carts are deleted after 90 days."],
      ["Cookies", "We set one first-party cookie holding an anonymous identifier so your cart and wishlist survive a refresh. We do not run third-party advertising trackers."],
      ["Your rights", "Write to " + SITE.email + " to request a copy of your data, a correction, or deletion. We respond within 30 days. Deletion requests remove everything except records we are legally required to retain."],
      ["Sharing", "We share your name, address and phone with the courier and the curated source fulfilling your order, because they cannot deliver it otherwise. That is the full list."],
    ],
  },
  terms: {
    title: "Terms of Service",
    desc: "The rules that govern buying from MatzHub.",
    body: [
      ["Who we are", SITE.legalName + " operates matzhub.com from " + SITE.city + ", India. By placing an order you accept these terms."],
      ["Nature of the service", "MatzHub is an intermediary. It does not own or stock the products listed and is not the manufacturer. It provides catalogue access, automated listing and order routing between verified sources and resellers."],
      ["Product descriptions", "Listings are generated from partner-supplied information and enriched automatically. We publish measurements and specifications in good faith. If a listing is materially wrong, the returns policy applies and we correct the listing."],
      ["Reseller obligations", "Resellers may set their own retail price and may share MatzHub listing images and copy with their own customers. Resellers must not represent products as original, authentic or brand-authorised merchandise, and must not attempt to identify, contact or circumvent a verified sources."],
      ["Brand labelling", "Listings are imported first-copy, master-quality merchandise. MatzHub is not affiliated with, endorsed by, sponsored by, licensed by or an agent of any original brand referenced on this site. Brand names, where they appear, are used descriptively only and remain the property of their respective owners."],
      ["Pricing", "Prices are set by our pricing engine and can change without notice. The price at the moment you place the order is the price that binds. If a price is obviously erroneous, we may cancel and refund rather than fulfil."],
      ["Orders and cancellation", "You may cancel any order before it is marked shipped, at no cost. After shipping, the returns policy applies. We may cancel an order that our risk engine flags, and we will tell you why."],
      ["Liability", "Our liability for any order is limited to the amount you paid for it. We are not liable for indirect or consequential loss."],
      ["Governing law", "These terms are governed by Indian law, with exclusive jurisdiction in the courts of " + SITE.city + "."],
    ],
  },
  shipping: {
    title: "Shipping & Returns",
    desc: "Dispatch times, delivery windows, replacements and size exchanges.",
    body: [
      ["Dispatch", "Orders are dispatched within 24 to 48 hours of confirmation, directly from the curated source. You get a WhatsApp message with the courier and tracking link when it leaves."],
      ["Delivery times", "Metro cities: 2 to 4 working days. Tier-2 and tier-3 cities: 4 to 7 working days. Remote pin codes can take up to 10 days. Delivery estimates exclude Sundays and public holidays."],
      ["Shipping charges", "Free on orders of ₹999 and above. Below that, a flat ₹59 applies. Payment is arranged over WhatsApp before dispatch."],
      ["Coverage", "We deliver to all serviceable PIN codes across India, including metro, tier-2, tier-3 and most remote locations. If your PIN code is not serviceable by our courier partners, we contact you and refund in full."],
      ["Replacements", "Seven days from delivery. Eligible if the product does not match the listing, arrives damaged, or is the wrong item. Record an unboxing video where possible; it makes the claim instant."],
      ["Size exchanges", "Free on footwear and apparel within seven days, provided the item is unworn, unwashed and has its tags and box intact. One exchange per item."],
      ["Refunds", "Where a replacement is not possible we refund in full within five working days, using the same method the payment was made by."],
      ["Not eligible", "Items damaged by use, items returned without tags, and change-of-mind returns on unopened but non-defective goods after the seven-day window."],
    ],
  },
  returns: {
    title: "Return & Refund Policy",
    desc: "Replacement window, size exchanges, refund timelines and what is not eligible.",
    body: [
      ["Replacement window", "Seven days from the date of delivery. A replacement is available if the product does not match the listing photograph or description, arrives damaged, is the wrong item, or is the wrong size on a size-based product."],
      ["How to raise a claim", "Message us on WhatsApp with your order number and a photograph of the item. Where possible, record an unboxing video - with one, claims are approved immediately and without further questions."],
      ["Size exchanges", "Free on footwear and apparel within seven days, provided the item is unworn, unwashed, and has its original tags and box intact. One exchange per item."],
      ["Refunds", "Where a replacement is not possible, we refund in full within five working days of the item being collected, using the same method the payment was made by."],
      ["Return shipping", "MatzHub arranges and pays for reverse pickup on all approved claims. You are never asked to courier an item at your own cost."],
      ["Not eligible", "Items damaged through use or improper care, items returned without original tags or packaging, and change-of-mind returns on non-defective goods after the seven-day window. Because listings are imported first-copy goods and are described as such, dissatisfaction that the item is not an original branded product is not a valid claim."],
      ["Resellers", "If you are a reseller and your own customer raises a claim, raise it with us under your order number within the same seven-day window. We handle it on the same terms."],
    ],
  },
  disclaimer: {
    title: "Disclaimer",
    desc: "Exactly what MatzHub is and is not selling.",
    body: [
      ["What MatzHub is", "MatzHub operates as a bridge between independent third-party verified sources and independent resellers. MatzHub does not own, manufacture, stock or warehouse the products listed on this site. It provides catalogue access, listing automation and order routing."],
      ["Product origin", "Products listed on MatzHub are supplied by independent third-party curated sources in India and abroad. They are imported first-copy, master-quality goods. They are not original branded products."],
      ["verified sources privacy", "The identity, location, contact details and channel of every verified sources are confidential and are not disclosed to resellers, customers, or any third party. This is a structural feature of the platform and applies without exception."],
      ["No brand affiliation", "MatzHub is not affiliated with, authorised by, endorsed by, sponsored by or licensed by any original brand whose name may appear descriptively on this site. All trademarks belong to their respective owners."],
      ["Imagery", "Product photography is supplied by the curated source. Colour reproduction varies by screen. Where a listing photo materially misrepresents the product, our replacement policy applies."],
      ["Automated content", "Product descriptions, specifications and FAQ content are generated by an automated enrichment pipeline from manufacturer-supplied information and reviewed by exception. If you spot an error, tell us and we correct it within a day."],
      ["Pricing claims", "Where we display a comparison price, it reflects the typical Indian retail price for a comparable item, not an original brand's recommended retail price."],
    ],
  },
};

export function generateStaticParams() {
  return Object.keys(DOCS).map((doc) => ({ doc }));
}

const OTHER_DOCS = Object.keys(DOCS);

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  const d = DOCS[doc];
  if (!d) return { title: "Not found" };
  return { title: d.title, description: d.desc, alternates: { canonical: `/legal/${doc}` } };
}

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const d = DOCS[doc];
  if (!d) notFound();
  const updated = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  // Breadcrumbs give search engines the hierarchy and give phone users a way
  // back without the browser control.
  const crumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
      { "@type": "ListItem", position: 2, name: d.title, item: `${SITE.url}/legal/${doc}` },
    ],
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(crumbs) }} />

      {/* .shell caps the width and supplies responsive padding. Before it was
          defined these pages ran edge to edge and touched the screen border. */}
      <div className="shell py-12 sm:py-16 lg:py-20">
        <div className="measure mx-auto">
          <nav aria-label="Breadcrumb" className="mb-6">
            <ol className="t-meta flex flex-wrap items-center gap-2">
              <li><Link href="/" className="hover:text-ink">Home</Link></li>
              <li aria-hidden>/</li>
              <li className="text-muted">{d.title}</li>
            </ol>
          </nav>

          <p className="eyebrow mb-3">Legal</p>
          <h1 className="t-title">{d.title}</h1>
          <p className="t-meta mt-4">Last updated {updated}</p>

          <div className="mt-12 space-y-10">
            {d.body.map(([h, p]) => (
              <section key={h}>
                <h2 className="t-heading">{h}</h2>
                {/* max-w on the paragraph keeps the measure readable on wide
                    screens; break-words stops long URLs forcing a scrollbar. */}
                <p className="t-body mt-3">{p}</p>
              </section>
            ))}
          </div>

          <div className="mt-14 flex flex-wrap gap-3 border-t border-line pt-8">
            {OTHER_DOCS.filter((k) => k !== doc).map((k) => (
              <Link key={k} href={`/legal/${k}`} className="chip">
                {DOCS[k].title}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
