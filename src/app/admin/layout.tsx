import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Operations", robots: { index: false, follow: false } };

/**
 * Operations only. Orders are agreed on WhatsApp; the Orders tab records them
 * so the customer gets a trackable number. No payment is taken anywhere.
 */
const NAV = [
  ["/admin", "Status"],
  ["/admin/orders", "Orders"],
  ["/admin/moderation", "Pipeline"],
  ["/admin/suppliers", "Channels"],
  ["/admin/automation", "Automation"],
  ["/admin/catalog", "Catalogue"],
  ["/admin/analytics", "Analytics"],
  ["/admin/settings", "Settings"],
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="shell flex h-14 items-center gap-6">
          <Link href="/" className="flex items-center gap-2" aria-label="MatzHub home">
            <Image src="/web-app-manifest-512x512.png" alt="MatzHub" width={26} height={26} className="rounded" />
            <span className="display text-lg">MatzHub</span>
          </Link>
          <span className="eyebrow">Ops</span>
          <nav className="ml-auto flex gap-1 overflow-x-auto no-scrollbar">
            {NAV.map(([h, l]) => (
              <Link key={h} href={h} className="whitespace-nowrap rounded-lg px-3 py-2 text-xs text-muted hover:bg-surface-2 hover:text-ink">{l}</Link>
            ))}
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
