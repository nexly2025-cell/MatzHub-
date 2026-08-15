import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { runtime } from "@/lib/tracing";

export const dynamic = "force-dynamic";

/**
 * Machine health for external monitoring (UptimeRobot, Better Stack, Grafana,
 * Vercel health checks). Unauthenticated on purpose — it reveals nothing
 * sensitive, just flags whether the platform's automation is alive.
 */
export async function GET() {
  const t0 = Date.now();
  try {
    const [dbPing] = await db.execute(sql`select 1 as ok`).then((r) => r.rows);
    const [stats] = await db
      .execute<{ published: number; staged: number; openTasks: number; failedQueue: number; lastIngest: string | null }>(
        sql`select
          (select count(*) from products where status='published')::int as published,
          (select count(*) from products where status='pending_review')::int as staged,
          (select count(*) from ops_tasks where status='open' and severity in ('high','critical'))::int as "openTasks",
          (select count(*) from notifications where status='failed' and created_at > now() - interval '1 hour')::int as "failedQueue",
          (select max(created_at)::text from ingestion_events where stage in ('published','pending_review')) as "lastIngest"`,
      )
      .then((r) => r.rows);

    const lastIngest = stats.lastIngest ? new Date(stats.lastIngest) : null;
    const ingestStaleMinutes = lastIngest ? Math.round((Date.now() - lastIngest.getTime()) / 60000) : null;

    const healthy = dbPing?.ok === 1 && stats.failedQueue < 20 && stats.openTasks < 50;

    return NextResponse.json(
      {
        status: healthy ? "ok" : "degraded",
        db: dbPing?.ok === 1,
        published: stats.published,
        staged: stats.staged,
        urgentTasks: stats.openTasks,
        failedNotificationsLastHour: stats.failedQueue,
        ingestStaleMinutes,
        runtime: runtime(),
        latencyMs: Date.now() - t0,
        checkedAt: new Date().toISOString(),
      },
      { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { status: "error", error: error instanceof Error ? error.message : "monitoring failed", latencyMs: Date.now() - t0 },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
