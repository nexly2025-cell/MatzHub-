import { asc } from "drizzle-orm";
import { db } from "@/db";
import { manufacturers } from "@/db/schema";
import { inr, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function Suppliers() {
  const rows = await db.select().from(manufacturers).orderBy(asc(manufacturers.healthScore));
  return (
    <div className="shell py-8">
      <h1 className="display text-3xl mb-1">Suppliers</h1>
      <p className="mb-8 text-sm text-muted">
        Health = 50% catalogue quality + 30% posting freshness + 20% fulfilment rate. Below 50 triggers an ops task automatically.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {rows.map((m) => (
          <article key={m.id} className="surface p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-medium">{m.name}</h2>
                <p className="text-xs text-muted">{m.city} · {m.sourceGroupName}</p>
              </div>
              <span className={`display text-2xl ${m.healthScore < 50 ? "text-[--color-rose]" : m.healthScore < 75 ? "text-[#f59e0b]" : "text-[--color-jade]"}`}>
                {m.healthScore.toFixed(0)}
              </span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-xs">
              {[
                ["Products", String(m.totalProducts)],
                ["Revenue", inr(m.totalRevenue)],
                ["Quality", `${m.qualityScore.toFixed(0)}/100`],
                ["Fulfilment", `${m.fulfilmentRate.toFixed(0)}%`],
                ["Pricing", "Global: cost ×1.40 / ×1.15"],
                ["Last post", relativeTime(m.lastIngestAt)],
                ["Auto-publish", m.autoPublish ? "on" : "off"],
                ["Status", m.status],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between pr-4">
                  <dt className="text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}
