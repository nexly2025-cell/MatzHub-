"use client";

/**
 * Issue 14 — branded root error boundary.
 * Must render its own <html> / <body> because it replaces the root layout.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en-IN">
      <body style={{ margin: 0, background: "#f3f1ec", color: "#15201e", fontFamily: "Georgia, 'Times New Roman', serif" }}>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "3rem 1.25rem", textAlign: "center" }}>
          <div style={{ maxWidth: 440 }}>
            <p style={{ letterSpacing: "0.18em", textTransform: "uppercase", fontSize: 11, color: "#8d938f", marginBottom: 16 }}>
              MatzHub
            </p>
            <h1 style={{ fontWeight: 500, fontSize: "clamp(2rem, 6vw, 3.2rem)", lineHeight: 1.05, margin: "0 0 1rem" }}>
              A quiet interruption.
            </h1>
            <p style={{ fontFamily: "system-ui, sans-serif", fontSize: 14, lineHeight: 1.7, color: "#5e6663", margin: "0 0 2rem" }}>
              Something unexpected happened while loading this page. Your cart is safe. Try again, or return home.
            </p>
            {error?.digest ? (
              <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#8d938f", marginBottom: 24 }}>
                Reference {error.digest}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={reset}
                style={{
                  background: "#1f5f5b",
                  color: "#fff",
                  border: 0,
                  borderRadius: 999,
                  padding: "12px 22px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
              <a
                href="/"
                style={{
                  border: "1px solid #c9c5ba",
                  borderRadius: 999,
                  padding: "12px 22px",
                  fontSize: 13,
                  color: "#15201e",
                  textDecoration: "none",
                }}
              >
                Back to home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
