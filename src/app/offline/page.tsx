import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "You're offline", robots: { index: false, follow: false } };

export default function Offline() {
  return (
    <div className="shell grid min-h-[60vh] place-items-center py-20 text-center">
      <div>
        <p className="eyebrow mb-4">No connection</p>
        <h1 className="display text-[clamp(2rem,6vw,3.5rem)] mb-4">You&apos;re offline</h1>
        <p className="mx-auto mb-8 max-w-md text-sm text-muted">
          The catalogue pages you&apos;ve already opened are available below. Reconnect and we&apos;ll pick up exactly
          where you left off.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/" className="btn btn-primary">Home</Link>
          <Link href="/sitemap" className="btn btn-ghost">Browse index</Link>
        </div>
      </div>
    </div>
  );
}
