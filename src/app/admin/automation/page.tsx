import { desc } from "drizzle-orm";
import { db } from "@/db";
import { automationRuns, ingestionEvents, notifications } from "@/db/schema";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const JOBS = [
  ["ingest", "On webhook", "WhatsApp worker posts raw messages; dedupe, enrich, price, publish."],
  ["trending", "Every 30 min", "Recompute the decayed engagement score that drives ranking."],
  ["expire", "Hourly", "Archive expired products, flip low-stock and out-of-stock states."],
  ["supplier", "Daily 02:00", "Rescore supplier health and raise ops tasks for weak suppliers."],
  ["cart-recovery", "Hourly", "Mark carts idle for 4+ hours for operations reporting."],
  ["digest", "Daily 08:00", "Send the founder digest to Telegram."],
];

export default async function Automation() {
  const [runs, recent, queue] = await Promise.all([
    db.select().from(automationRuns).orderBy(desc(automationRuns.startedAt)).limit(20),
    db.select().from(ingestionEvents).orderBy(desc(ingestionEvents.createdAt)).limit(20),
    db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(15),
  ]);

  return (
    <div className="shell py-8">
      <h1 className="display text-3xl mb-1">Automation</h1>
      <p className="mb-8 text-sm text-muted">
        Every scheduled job is idempotent and independently triggerable. A failure raises a critical ops task rather than failing silently.
      </p>

      <section className="mb-8">
        <h2 className="eyebrow mb-3">Jobs</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {JOBS.map(([job, cadence, desc]) => (
            <div key={job} className="surface p-4">
              <div className="flex items-center justify-between">
                <code className="text-xs text-accent">{job}</code>
                <span className="text-[10px] uppercase tracking-wider text-subtle">{cadence}</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted">{desc}</p>
              <a href={`/api/cron/${job}`} className="mt-3 inline-block text-[11px] text-muted underline hover:text-ink">Run now →</a>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="surface p-5">
          <h2 className="eyebrow mb-3">Recent runs</h2>
          <ul className="space-y-2 text-xs">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center gap-3 border-b border-line pb-2 last:border-0">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.status === "ok" ? "bg-[--color-jade]" : r.status === "failed" ? "bg-[--color-rose]" : "bg-[#f59e0b]"}`} />
                <code className="w-28 shrink-0 text-accent">{r.job}</code>
                <span className="flex-1 truncate text-muted">{JSON.stringify(r.detail ?? {})}</span>
                <span className="shrink-0 text-subtle">{r.durationMs}ms · {relativeTime(r.startedAt)}</span>
              </li>
            ))}
            {runs.length === 0 && <li className="text-muted">No runs recorded yet.</li>}
          </ul>
        </section>

        <section className="surface p-5">
          <h2 className="eyebrow mb-3">Ingestion log</h2>
          <ul className="space-y-2 text-xs">
            {recent.map((e) => (
              <li key={e.id} className="flex items-center gap-3 border-b border-line pb-2 last:border-0">
                <span className={`chip shrink-0 text-[9px] ${e.stage === "failed" ? "!text-[--color-rose] !border-[--color-rose]" : ""}`}>{e.stage}</span>
                <span className="flex-1 truncate text-muted">{e.rawCaption.slice(0, 70)}</span>
                <span className="shrink-0 text-subtle">{e.aiLatencyMs}ms</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="surface p-5 lg:col-span-2">
          <h2 className="eyebrow mb-3">Notification queue</h2>
          <ul className="space-y-2 text-xs">
            {queue.map((n) => (
              <li key={n.id} className="flex items-center gap-3 border-b border-line pb-2 last:border-0">
                <span className="chip shrink-0 text-[9px]">{n.channel}</span>
                <code className="w-52 shrink-0 truncate text-accent">{n.template}</code>
                <span className="flex-1 truncate text-muted">{n.recipient}</span>
                <span className="shrink-0 text-subtle">{n.status} · {relativeTime(n.createdAt)}</span>
              </li>
            ))}
            {queue.length === 0 && <li className="text-muted">Queue empty.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
