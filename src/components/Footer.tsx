"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SITE } from "@/lib/utils";

const COLS = [
  {
    title: "Collections",
    links: [
      { href: "/c/watches", label: "Watches" },
      { href: "/c/handbags", label: "Handbags" },
      { href: "/c/footwear", label: "Footwear" },
      { href: "/c/sunglasses", label: "Eyewear" },
      { href: "/c/apparel", label: "Apparel" },
      { href: "/c/perfumes", label: "Perfumes" },
    ],
  },
  {
    title: "The brand",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
      { href: "/faq", label: "FAQ" },
      { href: "/sitemap", label: "Browse index" },
    ],
  },
  {
    title: "Orders",
    links: [
      { href: "/track", label: "Track order" },
      { href: "/legal/shipping", label: "Shipping" },
      { href: "/legal/returns", label: "Returns & refunds" },
      { href: "/legal/privacy", label: "Privacy" },
      { href: "/legal/terms", label: "Terms" },
      { href: "/legal/disclaimer", label: "Disclaimer" },
    ],
  },
];

export default function Footer() {
  // Public chrome must not appear on ops surfaces. The header already applies
  // the same suppression; mirror it so the admin dashboard never renders the
  // storefront footer beneath it.
  const pathname = usePathname();
  if (pathname?.startsWith("/admin")) return null;

  return (
    <footer className="border-t border-line bg-surface">
      <div className="shell py-12 lg:py-14">
        {/* Brand spans the full width above three equal columns. The previous
            1.4fr brand + 3 columns layout squeezed the links into narrow strips
            and stacked into one very long scroll on phones. */}
        <div className="flex flex-col gap-8 border-b border-line pb-9 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-sm">
            <Link href="/" className="inline-flex items-center gap-3" aria-label="MatzHub home">
              <Image src="/web-app-manifest-512x512.png" alt="" width={44} height={44} sizes="44px" loading="lazy" className="rounded-lg" aria-hidden />
              <span className="font-display text-[22px] tracking-tight text-ink">MatzHub</span>
            </Link>
            <p className="t-body mt-4">{SITE.tagline}</p>

            {/* Social. Sized for touch and tinted with theme tokens so both
                Porcelain and Espresso stay legible. */}
            <div className="mt-6 flex items-center gap-3 sm:mt-0">
              <a
                href={SITE.instagram}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="MatzHub on Instagram"
                className="grid h-11 w-11 place-items-center rounded-full border border-line text-muted transition-all duration-300 hover:-translate-y-0.5 hover:border-linestrong hover:text-ink"
              >
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
                  <circle cx="12" cy="12" r="4.4" />
                  <circle cx="17.6" cy="6.4" r="1.05" fill="currentColor" stroke="none" />
                </svg>
              </a>
              <a
                href={`https://wa.me/${SITE.whatsapp}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Message MatzHub on WhatsApp"
                className="grid h-11 w-11 place-items-center rounded-full border border-line text-muted transition-all duration-300 hover:-translate-y-0.5 hover:border-linestrong hover:text-ink"
              >
                <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.15h-.01a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.82c0 4.54-3.69 8.23-8.24 8.23zm4.52-6.16c-.25-.13-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.15.16-.29.18-.53.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.44.13-.15.17-.25.25-.42.09-.16.04-.31-.02-.43-.06-.13-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.16 0-.43.06-.65.31-.22.24-.85.83-.85 2.03s.87 2.35.99 2.51c.12.17 1.71 2.61 4.15 3.66.58.25 1.03.4 1.38.51.58.19 1.11.16 1.53.1.47-.07 1.44-.59 1.64-1.16.2-.57.2-1.05.14-1.16-.06-.1-.22-.16-.47-.29z" />
                </svg>
              </a>
            </div>
          </div>
        </div>

        {/* Three equal columns on desktop; two-up on phones so the footer stays
            compact instead of becoming one long list. */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 pt-9 sm:grid-cols-3 sm:gap-8">
          {COLS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h2 className="eyebrow mb-4">{col.title}</h2>
              <ul className="space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="t-body text-[0.875rem] transition-colors hover:text-ink">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="t-meta max-w-2xl">
            © {new Date().getFullYear()} {SITE.legalName}. Imported first-copy, master quality — stated plainly on
            every listing. Not affiliated with, endorsed by or licensed by any original brand. Trademarks referenced
            descriptively remain their owners&apos; property.
          </p>
          <p className="t-meta shrink-0">Serving all of India</p>
        </div>
      </div>
    </footer>
  );
}
