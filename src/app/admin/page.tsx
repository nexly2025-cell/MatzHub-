import Link from "next/link";
import Image from "next/image";
import { getAdminSnapshot } from "@/lib/queries";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SEV: Record<string, string> = {
  critical: "border-[--color-rose] text-[--color-rose]",
  high: "border-[#f59e0b] text-[#f59e0b]",
  medium: "border-[--color-line-2] text-muted",
  low: "border-[--color-line-2] text-subtle",
};

export default async function AdminHome() {
  const s = await getAdminSnapshot();
  const stages = Object.fromEntries(s.ingest.map((r) => [r.stage, r.c]));

  return (
    <div className="shell py-8">
      <h1 className="display text-3xl mb-1">Command</h1>
      <p className="mb-8 text-sm text-muted">
        Only what needs a decision. Everything else already happened without you.
      </p>

      {/* --- the queue comes first, deliberately --- */}
      <section aria-labelledby="q-h" className="mb-10">
        <h2 id="q-h" className="eyebrow mb-3">Needs a human · {s.tasks.length}</h2>
        {s.tasks.length === 0 ? (
          <div className="surface p-8 text-center">
            <p className="display text-xl text-[--color-jade]">Queue is clear</p>
            <p className="mt-1 text-sm text-muted">The pipeline handled everything on its own today.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {s.tasks.map((t) => (
              <li key={t.id} className={`surface flex items-center gap-4 border-l-2 p-4 ${SEV[t.severity] ?? SEV.medium}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="eyebrow text-[9px]">{t.kind.replace(/_/g, " ")}</span>
                    <span className="text-[10px] uppercase">{t.severity}</span>
                  </div>
                  <p className="mt-1 truncate text-sm font-medium text-ink">{t.title}</p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">{t.detail}</p>
                </div>
                <span className="shrink-0 text-[11px] text-subtle">{relativeTime(t.createdAt)}</span>
                {t.actionUrl && <Link href={t.actionUrl} className="btn btn-ghost shrink-0 px-4 py-2 text-xs">Resolve</Link>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Open tasks" value={String(s.tasks.length)} sub={s.tasks.length ? "needs a decision" : "queue clear"} accent warn={s.tasks.length > 0} />
        <Stat label="Live catalogue" value={String(s.products.published)} sub={`avg quality ${s.products.avgQuality.toFixed(0)}/100`} />
        <Stat label="Awaiting review" value={String(s.products.pending)} sub={`${s.products.lowStock} low stock`} warn={s.products.pending > 0} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section className="surface p-6">
          <h2 className="eyebrow mb-4">Ingestion · last 7 days</h2>
          <div className="space-y-2.5">
            {["published", "pending_review", "deduped", "needs_review", "failed", "rejected"].map((k) => {
              const total = Math.max(1, Object.values(stages).reduce((a, b) => a + b, 0));
              const v = stages[k] ?? 0;
              return (
                <div key={k}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-muted">{k.replace(/_/g, " ")}</span>
                    <span>{v}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[#17171c]">
                    <div
                      className={`h-full rounded-full ${k === "failed" ? "bg-[--color-rose]" : k === "published" ? "bg-[--color-jade]" : "bg-[--color-gold]"}`}
                      style={{ width: `${(v / total) * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="surface p-6">
          <h2 className="eyebrow mb-4">Supplier health · weakest first</h2>
          <ul className="space-y-3">
            {s.suppliers.slice(0, 6).map((m) => (
              <li key={m.id} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{m.name}</p>
                  <p className="text-[11px] text-muted">
                    {m.totalProducts} products · last post {relativeTime(m.lastIngestAt)}
                  </p>
                </div>
                <div className="w-24 shrink-0">
                  <div className="h-1.5 overflow-hidden rounded-full bg-[#17171c]">
                    <div
                      className={`h-full ${m.healthScore < 50 ? "bg-[--color-rose]" : m.healthScore < 75 ? "bg-[#f59e0b]" : "bg-[--color-jade]"}`}
                      style={{ width: `${Math.min(100, m.healthScore)}%` }}
                    />
                  </div>
                </div>
                <span className="w-8 shrink-0 text-right text-xs">{m.healthScore.toFixed(0)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="surface p-6">
          <h2 className="eyebrow mb-4">Top movers</h2>
          <ul className="space-y-3">
            {s.topProducts.map((p) => (
              <li key={p.id} className="flex items-center gap-3">
                <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-surface-3">
                  <Image src={p.heroImage} alt="" fill sizes="40px" className="object-cover" />
                </div>
                <Link href={`/p/${p.slug}`} className="min-w-0 flex-1 truncate text-sm hover:text-accent">{p.title}</Link>
                <span className="shrink-0 text-xs text-muted">{p.trendingScore.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="surface p-6">
          <h2 className="eyebrow mb-4">Demand we can&apos;t fill · zero-result searches</h2>
          {s.failedSearches.length === 0 ? (
            <p className="text-sm text-muted">No empty searches in the last 30 days.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {s.failedSearches.map((f) => (
                <li key={f.q} className="chip">{f.q} <span className="opacity-60">×{f.c}</span></li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs leading-relaxed text-subtle">
            Each of these is a customer who wanted to spend money and could not. Brief the sourcing pipeline.
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent, warn }: { label: string; value: string; sub: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="surface p-5">
      <p className="eyebrow mb-2 text-[10px]">{label}</p>
      <p className={`display text-2xl ${accent ? "text-[--color-jade]" : warn ? "text-[#f59e0b]" : ""}`}>{value}</p>
      <p className="mt-1 text-[11px] text-muted">{sub}</p>
    </div>
  );
}
