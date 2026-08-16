import { NextResponse } from "next/server";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRuns, carts, ingestionEvents, notifications, opsTasks, priceAlerts, products, settings } from "@/db/schema";
import { runExpiryJob, runSupplierScoreJob, runTrendingJob } from "@/lib/ingest";
import { relativeTime } from "@/lib/utils";
import { dispatchNotifications, retryFailedNotifications } from "@/lib/notify";
import { isAutomationPaused, isMaintenanceMode } from "@/lib/telegram";
import { pendingAdminNotice, reconcileSubscription } from "@/lib/subscription";

/**
 * Scheduled automation. Point Vercel Cron / GitHub Actions at:
 *   /api/cron/trending      every 30 min
 *   /api/cron/expire        hourly
 *   /api/cron/supplier      daily 02:00 IST
 *   /api/cron/price-alerts  hourly
 *   /api/cron/cart-recovery hourly
 *   /api/cron/digest        daily 08:00 IST
 */
function authorized(request: Request) {
  const expected = process.env.CRON_SECRET;
  // Fails closed: an unset secret used to let anyone trigger every job,
  // including repricing the catalogue and clearing storage.
  if (!expected) return process.env.NODE_ENV === "development";
  const url = new URL(request.url);
  return (
    request.headers.get("authorization") === `Bearer ${expected}` ||
    url.searchParams.get("secret") === expected
  );
}

async function priceAlertJob() {
  const due = await db
    .select({ id: priceAlerts.id, productId: priceAlerts.productId, phone: priceAlerts.phone, target: priceAlerts.targetPrice, price: products.price, title: products.title, slug: products.slug })
    .from(priceAlerts)
    .innerJoin(products, eq(products.id, priceAlerts.productId))
    .where(and(isNull(priceAlerts.notifiedAt), lte(products.price, priceAlerts.targetPrice)))
    .limit(500);

  for (const d of due) {
    await db.insert(notifications).values({
      channel: d.phone ? "whatsapp" : "push",
      recipient: d.phone ?? "anon",
      template: "price_drop",
      payload: { title: d.title, slug: d.slug, price: d.price, target: d.target },
    });
    await db.update(priceAlerts).set({ notifiedAt: new Date() }).where(eq(priceAlerts.id, d.id));
  }
  return { notified: due.length };
}

async function cartRecoveryJob() {
  const stale = await db
    .update(carts)
    .set({ status: "abandoned", recoveryNudgedAt: new Date() })
    .where(and(eq(carts.status, "open"), isNull(carts.recoveryNudgedAt), sql`${carts.updatedAt} < now() - interval '4 hours'`))
    .returning({ id: carts.id, anonId: carts.anonId });

  if (stale.length) {
    await db.insert(notifications).values(
      stale.map((c) => ({ channel: "push" as const, recipient: c.anonId, template: "cart_recovery", payload: { cartId: c.id } })),
    );
  }
  return { nudged: stale.length };
}

async function digestJob() {
  const [row] = await db
    .select({
      published: sql<number>`count(*) filter (where status='published' and published_at > now() - interval '1 day')::int`,
      pending: sql<number>`count(*) filter (where status='pending_review')::int`,
    })
    .from(products);
  const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(opsTasks).where(eq(opsTasks.status, "open"));
  await db.insert(notifications).values({
    channel: "telegram", audience: "ops", recipient: "ops", template: "daily_digest",
    payload: { publishedToday: row.published, pendingReview: row.pending, openTasks: open },
  });
  return { ...row, openTasks: open };
}

/** Watchdog: raise a task if a mission-critical job has not run inside its SLA. */
async function watchdogJob() {
  const SLAS: Record<string, number> = { notify: 6, trending: 40, expire: 75, supplier: 1445, digest: 1445 };
  const { rows: lastRuns } = await db.execute<{ job: string; last: string | null }>(sql`
    select job, max(started_at)::text as last from automation_runs group by job`);
  const byJob = new Map<string, Date | null>(
    (lastRuns as Array<{ job: string; last: string | null }>).map((r) => [r.job, r.last ? new Date(r.last) : null]),
  );
  let alerts = 0;
  for (const [job, slaMin] of Object.entries(SLAS)) {
    const last = byJob.get(job);
    const stale = !last || Date.now() - last.getTime() > slaMin * 60000;
    if (stale) {
      const [{ exists }] = await db
        .select({ exists: sql<number>`count(*)::int` })
        .from(opsTasks)
        .where(and(eq(opsTasks.kind, "automation_failure"), eq(opsTasks.status, "open"), eq(opsTasks.title, `Job "${job}" is overdue`)))
        .limit(1);
      if (!exists) {
        await db.insert(opsTasks).values({
          kind: "automation_failure", severity: "high",
          title: `Job "${job}" is overdue`,
          detail: `SLA is ${slaMin} min; last run ${last ? relativeTime(last) : "never"}. Check the scheduler / vercel.json.`,
          actionUrl: "/admin/automation",
        });
        alerts += 1;
      }
    }
  }
  return { checked: Object.keys(SLAS).length, alerts };
}

/** Self-heal: retry stuck ingestion, resurrect orphans, clear stale dedupe locks. */
async function selfHealJob() {
  const t0 = Date.now();
  // 1. Messages stuck in 'received' > 15 min are probably orphaned; re-run enrich.
  const stuck = await db
    .select({ id: ingestionEvents.id, messageId: ingestionEvents.messageId, rawCaption: ingestionEvents.rawCaption, rawImageUrl: ingestionEvents.rawImageUrl })
    .from(ingestionEvents)
    .where(and(eq(ingestionEvents.stage, "received"), lte(ingestionEvents.createdAt, new Date(Date.now() - 15 * 60000))))
    .limit(50)
    .catch(() => []);
  let requeued = 0;
  const { ingestMessage } = await import("@/lib/ingest");
  for (const e of stuck) {
    try {
      if (!e.messageId) continue;
      await ingestMessage({ messageId: e.messageId, caption: e.rawCaption, imageUrl: e.rawImageUrl, source: "whatsapp" });
      await db.update(ingestionEvents).set({ stage: "healed" }).where(eq(ingestionEvents.id, e.id));
      requeued += 1;
    } catch {
      await db.update(ingestionEvents).set({ stage: "failed", error: "self-heal retry failed" }).where(eq(ingestionEvents.id, e.id));
    }
  }
  // 2. Orphaned pending_review with no task -> create one so it never sits invisible.
  const { rows: orphanRows } = (await db.execute<{ id: string }>(sql`
    select p.id from products p left join ops_tasks t
      on t.entity_id = p.id and t.status = 'open'
    where p.status = 'pending_review' and t.id is null limit 20`).catch(() => ({ rows: [] }))) as { rows: Array<{ id: string }> };
  let reflagged = 0;
  for (const o of orphanRows) {
    await db.insert(opsTasks).values({
      kind: "moderation", severity: "medium",
      title: "Untracked product awaiting review",
      detail: "Found in pending_review without an open task. Approve or reject to clear.",
      entityType: "product", entityId: o.id, actionUrl: "/admin/moderation",
    });
    reflagged += 1;
  }
  return { requeued, reflagged };
}

async function repriceJob() {
  // Applies the global rule to every live product. Safe to run after any
  // margin change; orders already placed are snapshots and are not touched.
  const [marginRow] = await db.select().from(settings).where(eq(settings.key, "selling_margin_percent")).limit(1);
  const margin = marginRow ? Number(marginRow.value) : undefined;
  const rows = await db.select({ id: products.id, costPrice: products.costPrice }).from(products).where(eq(products.status, "published"));
  const { computePricing } = await import("@/lib/ai");
  let updated = 0;
  for (const r of rows) {
    const pr = computePricing({ costPrice: r.costPrice, marginPercent: margin });
    await db.update(products).set({ mrp: pr.mrp, price: pr.price, resellerPrice: pr.price, marginPercent: pr.marginPercent, updatedAt: new Date() }).where(eq(products.id, r.id));
    updated += 1;
  }
  return { repriced: updated };
}

/** Reconcile supplier-supplied stock/cost corrections with live listings. */
async function stockSyncJob() {
  // Suppliers post follow-up messages like "stock: 40" or "cost 780 now" with
  // the same product. Rather than create a new listing we update the existing one.
  const corrections = await db
    .select({ id: ingestionEvents.id, messageId: ingestionEvents.messageId, rawCaption: ingestionEvents.rawCaption, createdAt: ingestionEvents.createdAt })
    .from(ingestionEvents)
    .where(and(eq(ingestionEvents.stage, "needs_review"), sql`${ingestionEvents.rawCaption} ilike '%stock:%' or ${ingestionEvents.rawCaption} ilike '%cost%'`))
    .orderBy(sql`${ingestionEvents.createdAt} desc`)
    .limit(50)
    .catch(() => []);

  let synced = 0;
  for (const c of corrections) {
    const text = c.rawCaption.toLowerCase();
    const stockMatch = text.match(/\bstock\s*(?:[:\-]|is)?\s*(\d{1,6})/);
    const costMatch = text.match(/\bcost\s*(?:[:\-]|is)?\s*(\d{2,7})/);
    const slugMatch = text.match(/\bproduct\s*[:\-]?\s*([a-z0-9\-]{10,80})/);
    if (!slugMatch) continue;

    const [p] = await db.select({ id: products.id, stockQty: products.stockQty, costPrice: products.costPrice }).from(products).where(eq(products.slug, slugMatch[1])).limit(1);
    if (!p) continue;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (stockMatch) {
      const n = Math.max(0, Number(stockMatch[1]));
      updates.stockQty = n;
      updates.availability = n === 0 ? "out_of_stock" : n < 5 ? "low_stock" : "in_stock";
      synced += 1;
    }
    if (costMatch) {
      const { computePricing } = await import("@/lib/ai");
      const pricing = computePricing({ costPrice: Number(costMatch[1]) });
      updates.costPrice = pricing.costPrice;
      updates.mrp = pricing.mrp;
      updates.price = pricing.price;
      synced += 1;
    }
    await db.update(products).set(updates).where(eq(products.id, p.id));
    await db.update(ingestionEvents).set({ stage: "healed" }).where(eq(ingestionEvents.id, c.id));
  }
  return { synced };
}

/**
 * Subscription watch. Notifies the operator over Telegram when access has
 * lapsed or is about to. Never touches the catalogue and never surfaces
 * anything publicly — an expired subscription is invisible to customers.
 */
async function subscriptionJob() {
  // Pull-based backstop first, in case a success webhook never arrived.
  const reconciled = await reconcileSubscription();
  const notice = await pendingAdminNotice();
  if (!notice) return { notified: 0, reconciled: reconciled ? 1 : 0 };
  await db.insert(notifications).values({
    channel: "telegram",
    audience: "ops",
    recipient: "ops",
    template: "subscription_status",
    payload: { text: notice },
  });
  return { notified: 1, reconciled: reconciled ? 1 : 0 };
}

/**
 * Storage housekeeping.
 *
 * Six tables grew without any retention policy — on a live catalogue `events`
 * alone gains a row per product view. This prunes operational telemetry on
 * fixed windows and deliberately touches nothing that represents the business:
 * products, categories, manufacturers, resellers and settings are never read
 * here, and audit_log is retained for a year because it is the security record.
 *
 * Windows are chosen against actual consumers:
 *   events 90d          — analytics and trending query 30d
 *   search_queries 90d  — analytics queries 30d
 *   automation_runs 30d — watchdog reads only the newest row per job
 *   ingestion_events 30d, terminal stages only — self-heal retries the rest
 *   notifications 30d, settled only — retry job needs pending and failed
 */
async function storageSweepJob() {
  const cutoff = (days: number) => sql`now() - (${days} || ' days')::interval`;

  const [ev] = (await db.execute<{ n: number }>(sql`
    with d as (delete from events where created_at < ${cutoff(90)} returning 1)
    select count(*)::int as n from d`)).rows;
  const [sq] = (await db.execute<{ n: number }>(sql`
    with d as (delete from search_queries where created_at < ${cutoff(90)} returning 1)
    select count(*)::int as n from d`)).rows;
  const [ar] = (await db.execute<{ n: number }>(sql`
    with d as (delete from automation_runs where started_at < ${cutoff(30)} returning 1)
    select count(*)::int as n from d`)).rows;
  const [ie] = (await db.execute<{ n: number }>(sql`
    with d as (
      delete from ingestion_events
      where created_at < ${cutoff(30)}
        and stage in ('published','deduped','healed','rejected')
      returning 1)
    select count(*)::int as n from d`)).rows;
  const [nt] = (await db.execute<{ n: number }>(sql`
    with d as (
      delete from notifications
      where created_at < ${cutoff(30)} and status in ('sent','dead')
      returning 1)
    select count(*)::int as n from d`)).rows;
  const [al] = (await db.execute<{ n: number }>(sql`
    with d as (delete from audit_log where created_at < ${cutoff(365)} returning 1)
    select count(*)::int as n from d`)).rows;

  // Worker-side temp files (stale QR images, failed uploads).
  let workerFiles = 0;
  const base = (process.env.WA_WORKER_URL || "").replace(/\/$/, "");
  if (base) {
    try {
      const res = await fetch(`${base}/cleanup`, {
        method: "POST",
        headers: process.env.WA_WORKER_TOKEN ? { authorization: `Bearer ${process.env.WA_WORKER_TOKEN}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) workerFiles = Number(((await res.json()) as { removed?: number }).removed ?? 0);
    } catch {
      /* worker offline is not a sweep failure */
    }
  }

  return {
    events: ev?.n ?? 0,
    searchQueries: sq?.n ?? 0,
    automationRuns: ar?.n ?? 0,
    ingestionEvents: ie?.n ?? 0,
    notifications: nt?.n ?? 0,
    auditLog: al?.n ?? 0,
    workerFiles,
  };
}

/** Expires Telegram status messages older than their TTL. */
async function telegramSweepJob() {
  const { sweepExpiredMessages } = await import("@/app/api/telegram/webhook/route");
  // Bot-scoped: each bot can only delete its own messages, so sweep both.
  const [admin, dev] = await Promise.all([
    sweepExpiredMessages("admin"),
    sweepExpiredMessages("dev"),
  ]);
  return { swept: admin + dev, admin, dev };
}

const JOBS: Record<string, () => Promise<Record<string, number>>> = {
  subscription: subscriptionJob,
  "telegram-sweep": telegramSweepJob,
  "storage-sweep": storageSweepJob,
  "stock-sync": stockSyncJob,
  watchdog: watchdogJob,
  "self-heal": selfHealJob,
  reprice: repriceJob,
  notify: () => dispatchNotifications(100),
  "notify-retry": () => retryFailedNotifications(50),
  trending: runTrendingJob,
  expire: runExpiryJob,
  supplier: runSupplierScoreJob,
  "price-alerts": priceAlertJob,
  "cart-recovery": cartRecoveryJob,
  digest: digestJob,
};

async function run(job: string) {
  const fn = JOBS[job];
  if (!fn) return NextResponse.json({ ok: false, error: `Unknown job "${job}"`, available: Object.keys(JOBS) }, { status: 404 });

  // Operator kill switch, toggled from the Telegram Ops Center (/pause, /resume).
  // self-heal stays runnable so an operator can still repair a paused system.
  if (job !== "self-heal" && (await isMaintenanceMode())) {
    return NextResponse.json({ ok: true, job, skipped: "maintenance_mode" });
  }
  if (job !== "self-heal" && (await isAutomationPaused())) {
    return NextResponse.json({ ok: true, job, skipped: "automation_paused" });
  }

  const t0 = Date.now();
  const [run] = await db.insert(automationRuns).values({ job, status: "running" }).returning({ id: automationRuns.id });
  try {
    const detail = await fn();
    await db.update(automationRuns)
      .set({ status: "ok", detail, durationMs: Date.now() - t0, finishedAt: new Date(), processed: Object.values(detail).reduce((a, b) => a + b, 0) })
      .where(eq(automationRuns.id, run.id));
    return NextResponse.json({ ok: true, job, detail, durationMs: Date.now() - t0 });
  } catch (e) {
    const error = e instanceof Error ? e.message : "unknown";
    await db.update(automationRuns).set({ status: "failed", detail: { error }, durationMs: Date.now() - t0, finishedAt: new Date() }).where(eq(automationRuns.id, run.id));
    await db.insert(opsTasks).values({ kind: "automation_failure", severity: "critical", title: `Cron "${job}" failed`, detail: error, actionUrl: "/admin/automation" });
    return NextResponse.json({ ok: false, job, error }, { status: 500 });
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ job: string }> }) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  return run((await params).job);
}
export async function POST(request: Request, ctx: { params: Promise<{ job: string }> }) {
  return GET(request, ctx);
}
