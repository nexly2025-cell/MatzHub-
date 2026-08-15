import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const [daily, funnel, topSearch, dropoff] = await Promise.all([
    db.execute<{ d: string; views: number }>(sql`
      select to_char(created_at, 'YYYY-MM-DD') as d, count(*)::int as views
      from events where name = 'view_item' and created_at > now() - interval '30 days'
      group by 1 order by 1`),
    db.execute<{ name: string; c: number }>(sql`
      select name, count(*)::int as c from events where created_at > now() - interval '30 days' group by name order by c desc limit 12`),
    db.execute<{ q: string; c: number; rc: number }>(sql`
      select normalized as q, count(*)::int as c, round(avg(result_count),1)::float as rc
      from search_queries where created_at > now() - interval '30 days' group by normalized order by c desc limit 10`),
    db.execute<{ stage: string; c: number }>(sql`
      select stage, count(*)::int as c from ingestion_events where created_at > now() - interval '30 days' group by stage`),
  ]);

  const maxViews = Math.max(1, ...daily.rows.map((d) => d.views));
  // Orders are agreed in WhatsApp, so the funnel ends at the outbound tap.
  const funnelOrder = ["page_view", "view_item", "select_item", "whatsapp_order"];
  const funnelMap = new Map(funnel.rows.map((r) => [r.name, r.c]));
  const funnelMax = Math.max(1, ...funnelOrder.map((k) => funnelMap.get(k) ?? 0));

  return (
    <div className="shell py-8">
      <h1 className="display text-3xl mb-1">Analytics</h1>
      <p className="mb-8 text-sm text-muted">Last 30 days, derived from real traffic — no sampling.</p>

      <section className="surface mb-6 p-6">
        <h2 className="eyebrow mb-4">Product views by day</h2>
        <div className="flex h-40 items-end gap-[3px]">
          {daily.rows.map((d) => (
            <div key={d.d} className="group relative flex-1">
              <div className="w-full rounded-t bg-gradient-to-t from-[#1a1a20] to-[#c9a227]/80 transition-opacity" style={{ height: `${(d.views / maxViews) * 100}%`, minHeight: d.views > 0 ? "3px" : "1px" }} />
              <div className="pointer-events-none absolute -top-10 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded border border-line  px-2 py-1 text-[10px] opacity-0 group-hover:opacity-100">
                {d.d.slice(5)} · {d.views} views
              </div>
            </div>
          ))}
          {daily.rows.length === 0 && <p className="text-sm text-muted">No traffic yet this period.</p>}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="surface p-6">
          <h2 className="eyebrow mb-4">Conversion funnel</h2>
          <ul className="space-y-3">
            {funnelOrder.map((stage) => {
              const c = funnelMap.get(stage) ?? 0;
              return (
                <li key={stage}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-muted">{stage.replace(/_/g, " ")}</span>
                    <span>{c}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-[#131318]">
                    <div className="h-full bg-gradient-to-r from-[#c9a227] to-[#3dd68c]" style={{ width: `${(c / funnelMax) * 100}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="surface p-6">
          <h2 className="eyebrow mb-4">Top searches</h2>
          <ul className="space-y-2 text-sm">
            {topSearch.rows.map((s) => (
              <li key={s.q} className="flex justify-between border-b border-line pb-2 last:border-0">
                <span>{s.q}</span>
                <span className="text-xs text-muted">{s.c}× · avg {s.rc} results</span>
              </li>
            ))}
            {topSearch.rows.length === 0 && <li className="text-muted">No searches logged yet.</li>}
          </ul>
        </section>

        <section className="surface p-6 lg:col-span-2">
          <h2 className="eyebrow mb-4">Pipeline throughput</h2>
          <div className="flex flex-wrap gap-2">
            {dropoff.rows.map((d) => (
              <span key={d.stage} className="chip">{d.stage} <b>{d.c}</b></span>
            ))}
            {dropoff.rows.length === 0 && <span className="text-sm text-muted">No ingestion events this period.</span>}
          </div>
        </section>
      </div>
    </div>
  );
}
