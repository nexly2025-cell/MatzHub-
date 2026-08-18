import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { SITE } from "@/lib/utils";

export const metadata: Metadata = {
  title: "About MatzHub — Since 2017",
  description:
    "MatzHub curates imported master-quality watches, handbags, footwear, eyewear, apparel and perfumes. Founded in Tumkur, Karnataka in 2017, and rebuilt end to end in 2026.",
  alternates: { canonical: "/about" },
};

const ld = {
  "@context": "https://schema.org",
  "@type": "AboutPage",
  name: "About MatzHub",
  url: `${SITE.url}/about`,
  mainEntity: { "@id": `${SITE.url}/#organization` },
};

const PEOPLE = [
  {
    role: "Founder",
    name: "Mohammed Zaid Y.",
    initials: "MY",
    note: "Started MatzHub in 2017 from Tumkur, Karnataka. Builds relationships with every manufacturing partner we source from.",
  },
  {
    role: "Co-Founder",
    instagram: SITE.cofounder.instagram,
    name: "Salman Khan GA",
    initials: "SK",
    note: "Runs operations and fulfilment across all partner channels. Makes sure every piece we list matches reality.",
  },
];


const crumbs = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
    { "@type": "ListItem", position: 2, name: "About", item: `${SITE.url}/about` },
  ],
};

export default function About() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(crumbs) }} />

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />

      {/* quiet editorial hero */}
      <section className="border-b border-line bg-surface">
        <div className="shell py-16 lg:py-20">
          <p className="eyebrow mb-4">About MatzHub</p>
          <h1 className="t-title">
            Built in Tumkur,
            <br />
            <span className="text-accent">since 2017.</span>
          </h1>
          <p className="t-lead measure mt-6">
            A curated import catalogue for watches, handbags, footwear, eyewear, apparel and perfumes. We started in
            Tumkur in 2017 because imported goods in India were sold with vague descriptions and invented discounts.
            We tell you exactly what a piece is and show you exactly how it looks.
          </p>
        </div>
      </section>

      {/* The standard — what a buyer can rely on, not how we operate. */}
      <section className="border-b border-line bg-canvas">
        <div className="shell py-14 lg:py-20">
          <div className="measure mx-auto">
            <h2 className="t-title">Our standard</h2>
            <dl className="mt-9 grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {[
                ["Inspected before listing", "Every piece is checked against a fixed rubric — stitching, hardware, finish, materials — and scored. If it does not clear the bar it never reaches the catalogue."],
                ["Described exactly", "Real measurements taken from the piece itself. Materials named honestly: genuine leather is called genuine leather, PU is called PU."],
                ["Priced once", "One fixed margin on the real cost. No invented MRP designed to make a discount look larger than it is."],
                ["Replaced without argument", "Seven days from delivery. Not as shown, damaged, or the wrong size — replaced free, no forms."],
              ].map(([t, d]) => (
                <div key={t}>
                  <dt className="t-heading">{t}</dt>
                  <dd className="t-body mt-2.5">{d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* founders */}
      <section className="border-b border-line bg-surface">
        <div className="shell py-14 lg:py-16">
          <p className="eyebrow mb-8">The people</p>
          <div className="grid gap-5 sm:grid-cols-2">
            {PEOPLE.map((p) => (
              <div key={p.name} className="surface p-6">
                {/* Theme-matched image placeholder.
                    Drop a replacement at /public/team/zaid.jpg and /public/team/salman.jpg
                    with {p.role === "Founder" ? "zaid.jpg" : "salman.jpg"} below when ready. */}
                <div className="relative mb-5 h-44 w-44 overflow-hidden rounded-2xl border border-line" style={{ background: "linear-gradient(145deg, var(--c-accent-soft) 0%, var(--c-surface) 100%)" }}>
                  <div className="absolute inset-0 grid place-items-center">
                    <span className="font-display text-5xl text-accent">{p.initials}</span>
                  </div>
                </div>
                <p className="eyebrow">{p.role}</p>
                <h3 className="mt-1.5 font-display text-2xl text-ink">{p.name}</h3>
                <p className="t-body mt-2.5">{p.note}</p>
                {"instagram" in p && typeof p.instagram === "string" && (
                  <a
                    href={p.instagram}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${p.name} on Instagram`}
                    className="mt-4 inline-flex items-center gap-2 text-[12.5px] text-muted transition-colors hover:text-ink"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
                      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
                      <circle cx="12" cy="12" r="4.4" />
                      <circle cx="17.6" cy="6.4" r="1.05" fill="currentColor" stroke="none" />
                    </svg>
                    Instagram
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* build credit — one section, linked, no more */}
      <section className="bg-canvas">
        <div className="shell py-14 lg:py-16">
          <p className="eyebrow mb-4">Built by</p>
          <div className="surface p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-2xl text-ink">Mohammed Usman E. Ghani</h3>
                <p className="eyebrow mt-1.5">Head of Digital Operations</p>
                <p className="t-body measure mt-3">
                  Designed and engineered the MatzHub platform and this page.
                </p>
              </div>
              <a
                href="https://usman-ops.netlify.app"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline shrink-0"
              >
                Portfolio ↗
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
