"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(JSON.stringify({ level: "error", event: "route_error", digest: error.digest, message: error.message }));
  }, [error]);

  return (
    <div className="shell grid min-h-[60vh] place-items-center py-20 text-center">
      <div>
        <p className="eyebrow mb-4">Something broke</p>
        <h1 className="display text-[clamp(2rem,6vw,3.5rem)] mb-4">That one&apos;s on us.</h1>
        <p className="mx-auto mb-2 max-w-md text-sm text-muted">
          An unexpected error hit this page. Our automation has already logged it so a human can look at the queue.
        </p>
        {error.digest && <p className="mb-8 text-xs text-subtle">Reference: <code>{error.digest}</code></p>}
        <div className="flex flex-wrap justify-center gap-3">
          <button onClick={reset} className="btn btn-primary">Try again</button>
          <Link href="/" className="btn btn-ghost">Home</Link>
          <Link href="/contact" className="btn btn-ghost">Tell us</Link>
        </div>
      </div>
    </div>
  );
}
