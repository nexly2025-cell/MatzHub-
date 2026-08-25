import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { manufacturers, notifications, opsTasks, settings, telegramEphemeral } from "@/db/schema";
import { SITE, inr } from "@/lib/utils";

/**
 * Notification dispatcher.
 * Renders templates, sends through the persistent Baileys worker or Telegram, and retries with bounded backoff.
 * Nothing here can block a customer action — the queue is drained by cron.
 */

type Payload = Record<string, unknown>;

import crypto from "node:crypto";
const payloadHash = (template: string, recipient: string, payload: Payload) =>
  crypto.createHash("sha256").update(`${template}|${recipient}|${JSON.stringify(payload)}`).digest("hex");

const MAX_NOTIFICATION_ATTEMPTS = 3;
const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

const s = (p: Payload, k: string, d = "") => (typeof p[k] === "string" || typeof p[k] === "number" ? String(p[k]) : d);
const n = (p: Payload, k: string, d = 0) => (typeof p[k] === "number" ? p[k] : d);

export function render(template: string, p: Payload): string {
  switch (template) {
    case "order_received":
      return [
        `*Order request received — ${s(p, "orderNo")}*`,
        ``,
        `Thanks for shopping with MatzHub. Total ${inr(n(p, "total"))}.`,
        `We’ll confirm live availability and delivery details before dispatch.`,
        ``,
        `Track your request: ${s(p, "orderUrl", `${SITE.url}/track`)}`,
        ``,
        `Reply to this message any time if you need help.`,
      ].join("\n");

    case "supplier_dispatch_request": {
      const items = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : [];
      return [
        `*New order — ${s(p, "orderNo")}*`,
        ``,
        ...items.map((i) => `• ${String(i.titleSnapshot)}${i.variantLabel ? ` (${String(i.variantLabel)})` : ""} × ${String(i.qty)}`),
        ``,
        `Please pack and hand to the courier within 48 hours.`,
        `Reply DONE with the AWB number when dispatched.`,
      ].join("\n");
    }

    case "new_order":
      return `🟢 Order ${s(p, "orderNo")} · ${inr(n(p, "total"))} · risk ${n(p, "risk")}`;

    case "payment_received":
      return [
        `*Payment received — ${s(p, "orderNo")}*`,
        ``,
        `${inr(n(p, "total"))} confirmed. Your order is now first in the dispatch queue.`,
        ``,
        s(p, "orderUrl", `${SITE.url}/track`),
      ].join("\n");

    case "order_status_update": {
      const track = p.trackingUrl ? `\nTrack live: ${String(p.trackingUrl)}` : "";
      const human: Record<string, string> = {
        confirmed: "confirmed and is being packed by the verified sources.",
        packed: "packed and ready for courier pickup.",
        shipped: "shipped and is on the way.",
        delivered: "delivered. Enjoy it — and if anything is off, reply within 7 days for a free replacement.",
        cancelled: "cancelled. If you paid, the refund is being processed.",
        returned: "marked as returned and the replacement or refund is in motion.",
      };
      return [`*Order ${s(p, "orderNo")}*`, "", `Your order is ${human[s(p, "status")] ?? s(p, "status")}`, track, "", s(p, "orderUrl", `${SITE.url}/track`)].filter(Boolean).join("\n");
    }

    /**
     * The alert an operator acts on, so it carries only what changes the
     * decision: what the product is, where it came from, why it stopped, and
     * the one number that matters. Internal identifiers, raw message ids and
     * pipeline internals belong in the dashboard, not in a chat.
     */
    case "moderation_needed":
      return [
        ` *Product needs your decision*`,
        ``,
        `*${s(p, "title")}*`,
        `From channel: ${s(p, "groupName", s(p, "supplierName", "unknown"))}`,
        `Why it stopped: ${s(p, "reason", "it needs a human check")}`,
        ``,
        `Publish it only if the details are right — stock and sizes are not supplied automatically.`,
        ``,
        `🔗 ${SITE.url}/admin/moderation`,
      ].join("\n");

    /**
     * Confirmation, not a report. It self-deletes after a few minutes, so it
     * states the outcome and the listing — no ids, no metrics, no history.
     */
    case "product_auto_published":
      return [`✅ *Live on the site:* ${s(p, "title")}`, ``, `From ${s(p, "groupName", s(p, "supplierName", "your channel"))}.`, ``, `🔗 ${SITE.url}/p/${s(p, "slug")}`].join("\n");

    case "order_fulfilment": {
      const rows = Array.isArray(p.lines) ? (p.lines as Array<Record<string, unknown>>) : [];
      const grouped: Record<string, Array<Record<string, unknown>>> = {};
      for (const l of rows) {
        const key = String(l.groupName ?? "Unknown group");
        grouped[key] = grouped[key] ?? [];
        grouped[key].push(l);
      }
      const sections = Object.entries(grouped).map(([g, ls]) => [
        `*${g}* (${String(ls[0].groupJid ?? "").slice(-10)})`,
        ...ls.map((l) => `  • ${String(l.title)}${l.variant ? ` (${String(l.variant)})` : ""} ×${String(l.qty)}`),
      ].join("\n"));
      return [
        `*Fulfil order ${s(p, "orderNo")}*`,
        ``,
        ...sections,
        ``,
        `Total ${inr(n(p, "total"))} · Ship to: ${s(p, "city")} ${s(p, "pincode")}`,
        `${SITE.url}/admin/orders`,
      ].join("\n");
    }

    case "daily_digest":
      return [
        `*MatzHub daily digest*`,
        `Published in last 24h: ${n(p, "publishedToday")}`,
        `Awaiting review: ${n(p, "pendingReview")}`,
        `Open ops tasks: ${n(p, "openTasks")}`,
        ``,
        `${SITE.url}/admin`,
      ].join("\n");

    case "automation_alert":
      return `🔴 *Automation failure*\n${s(p, "job")}: ${s(p, "error")}\n${SITE.url}/admin/automation`;

    // Operator billing state, phrased for a business owner rather than a log.
    case "subscription_status":
      return s(p, "text", "Subscription status changed. Automatic uploads may be paused — check *Subscription* in the bot.");

    case "subscription_renewed":
      return `💳 *Billing renewed*\n\nAutomatic uploads are active${p.paidUntil ? ` until ${String(p.paidUntil).slice(0, 10)}` : ""}. The storefront was never affected.`;

    /**
     * Handler internals. This template is addressed to the developer bot only;
     * the admin chat gets a plain sentence instead of a stack trace.
     */
    case "telegram_handler_failure":
      return `🤖 *Telegram handler failure*\ncontext: ${s(p, "context", "unknown")}\n\`\`\`\n${s(p, "detail", "no detail")}\n\`\`\``;

    default:
      return JSON.stringify(p);
  }
}

type TelegramAudience = "dev" | "admin";

/**
 * Ops alerts go to exactly two people, with different jobs:
 *
 *   TELEGRAM_DEV_CHAT_ID    (you — the developer)
 *     automation failures, cron misses, transport outages, worker age,
 *     ingestion failure spikes, security/session anomalies, deploy issues.
 *
 *   TELEGRAM_ADMIN_CHAT_ID  (your admin)
 *     new orders above the fraud-review threshold, risky orders,
 *     moderation queue additions, supplier-health degradations, daily digest.
 *
 * Bots are send-only. "Responds" = the correct person hears the right alert
 * without seeing the other person's noise. Two chat IDs, one shared bot token
 * Two bots, two tokens: TELEGRAM_ADMIN_BOT_TOKEN and TELEGRAM_DEV_BOT_TOKEN.
 *
 * TELEGRAM_CHAT_ID (single-inbox legacy) was removed: it silently routed dev
 * alerts to the admin and vice versa when only one of the two was set.
 */
function telegramRecipient(audience: TelegramAudience): { token: string; chatId: string } {

  if (audience === "dev") {
    return {
      token: process.env.TELEGRAM_DEV_BOT_TOKEN || "",
      chatId: process.env.TELEGRAM_DEV_CHAT_ID || "",
    };
  }
  return {
    token: process.env.TELEGRAM_ADMIN_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_ADMIN_CHAT_ID || "",
  };
}

/**
 * Chat hygiene.
 *
 * The admin's Telegram thread is a decision surface, not an archive. Routine
 * confirmations self-delete after ~5 minutes, which is how long they are
 * worth reading. Two categories are deliberately kept:
 *
 *   - anything actionable and unrepeated (a new order, a channel that needs a
 *     decision) survives until the underlying work is finished;
 *   - the review alert survives until the product is decided, then it is
 *     retired by `retireProductAlert`, so a handled item cannot leave a stale
 *     "Review needed" hanging above the chat forever.
 *
 * Deletion is queued through `telegram_ephemeral` and drained by the existing
 * `telegram-sweep` job. One row per message, insert-on-conflict-nothing, and
 * the sweeper drops rows whether or not Telegram accepts the delete — so a
 * message removed by hand can never become a retry loop or an API hammer.
 */
const ROUTINE_ADMIN_TEMPLATES = new Set(["product_auto_published", "daily_digest", "subscription_renewed", "subscription_status"]);
const ADMIN_ROUTINE_TTL_MS = 5 * 60 * 1000;

export const moderationAlertKey = (productId: string) => `tg_alert:${productId}`;

type SendOptions = { ttlMs?: number; retainAlertFor?: string };

async function sendTelegramTo(
  audience: TelegramAudience,
  text: string,
  opts: SendOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const { token, chatId } = telegramRecipient(audience);
  if (!token || !chatId) return { ok: false, error: `telegram ${audience} not configured` };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!res.ok || !body.ok) return { ok: false, error: `telegram ${res.status}` };

    const messageId = body.result?.message_id;
    if (typeof messageId === "number") {
      const bot = audience === "dev" ? "dev" : "admin";
      if (opts.ttlMs) {
        await db
          .insert(telegramEphemeral)
          .values({ chatId, messageId, bot, expiresAt: new Date(Date.now() + opts.ttlMs) })
          .onConflictDoNothing()
          .catch(() => undefined);
      }
      if (opts.retainAlertFor) {
        await db
          .insert(settings)
          .values({ key: moderationAlertKey(opts.retainAlertFor), value: JSON.stringify({ chatId, messageId, bot }) })
          .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify({ chatId, messageId, bot }), updatedAt: new Date() } })
          .catch(() => undefined);
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : `telegram ${audience} failed` };
  }
}

/**
 * Removes the review alert for a product once a decision exists, from either
 * surface (Telegram or the dashboard). Best-effort by design: if Telegram has
 * already dropped the message, or the bot token is unavailable, the mapping is
 * cleared and nothing is retried.
 */
export async function retireProductAlert(productId: string): Promise<void> {
  if (!productId) return;
  const key = moderationAlertKey(productId);
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    await db.delete(settings).where(eq(settings.key, key));
    if (!row?.value) return;
    const alert = JSON.parse(row.value) as { chatId?: string; messageId?: number; bot?: string };
    if (!alert.chatId || typeof alert.messageId !== "number") return;
    const token = alert.bot === "dev" ? process.env.TELEGRAM_DEV_BOT_TOKEN : process.env.TELEGRAM_ADMIN_BOT_TOKEN;
    if (!token) return;
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: alert.chatId, message_id: alert.messageId }),
      signal: AbortSignal.timeout(6_000),
    }).catch(() => undefined);
    // Also drop any queued sweep for that message so the job never re-attempts.
    await db
      .delete(telegramEphemeral)
      .where(and(eq(telegramEphemeral.chatId, alert.chatId), eq(telegramEphemeral.messageId, alert.messageId)))
      .catch(() => undefined);
  } catch {
    /* hygiene must never fail a moderation decision */
  }
}

/**
 * Outbound WhatsApp goes through the persistent Baileys worker, which is the
 * single supported transport. The Meta Cloud API branch was removed: it was
 * never configured, required two more secrets, and silently took priority over
 * the worker whenever those secrets happened to be present.
 */
async function sendWhatsApp(to: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const workerUrl = process.env.WA_WORKER_URL;
  const workerToken = process.env.WA_WORKER_TOKEN;
  if (workerUrl) {
    try {
      const res = await fetch(`${workerUrl.replace(/\/$/, "")}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(workerToken ? { Authorization: `Bearer ${workerToken}` } : {}) },
        body: JSON.stringify({ to, text }),
      });
      return res.ok ? { ok: true } : { ok: false, error: `worker ${res.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "worker unreachable" };
    }
  }

  return { ok: false, error: "no whatsapp transport configured" };
}

/** Resolve a manufacturer UUID recipient into a real phone number. */
async function resolveRecipient(recipient: string): Promise<string | null> {
  if (/^[0-9a-f-]{36}$/i.test(recipient)) {
    const [m] = await db.select({ phone: manufacturers.phone }).from(manufacturers).where(eq(manufacturers.id, recipient)).limit(1);
    return m?.phone ?? null;
  }
  if (recipient === "ops") return process.env.TELEGRAM_ADMIN_CHAT_ID ?? null;
  if (recipient === "anon") return null;
  return recipient;
}

/** Requeue claims abandoned by a terminated worker invocation. */
export async function recoverStaleNotificationClaims() {
  const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS);
  const requeued = await db
    .update(notifications)
    .set({ status: "queued", claimedAt: null, error: "retrying after interrupted delivery" })
    .where(and(eq(notifications.status, "processing"), lte(notifications.claimedAt, cutoff), lt(notifications.attempts, MAX_NOTIFICATION_ATTEMPTS)))
    .returning({ id: notifications.id });

  const exhausted = await db
    .update(notifications)
    .set({ status: "failed", claimedAt: null, error: "delivery claim timed out after maximum attempts" })
    .where(and(eq(notifications.status, "processing"), lte(notifications.claimedAt, cutoff), sql`${notifications.attempts} >= ${MAX_NOTIFICATION_ATTEMPTS}`))
    .returning({ id: notifications.id });

  return { requeued: requeued.length, exhausted: exhausted.length };
}

/** Drain the queue. Atomically claims every notification before transport. */
async function escalate(summary: string, detail: string) {
  const hook = process.env.UPTIME_WEBHOOK_URL;
  if (!hook) return;
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary, detail, at: new Date().toISOString(), source: "matzhub" }),
    });
  } catch {
    /* escalation must never block the pipeline */
  }
}

export async function dispatchNotifications(limit = 50) {
  await recoverStaleNotificationClaims();
  const queued = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.status, "queued"), lt(notifications.attempts, MAX_NOTIFICATION_ATTEMPTS)))
    .orderBy(notifications.createdAt)
    .limit(limit);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let processed = 0;

  for (const queuedItem of queued) {
    // Compare-and-set claim: concurrent cron invocations can see the same row,
    // but only one of them may transition it from queued to processing.
    const [item] = await db
      .update(notifications)
      .set({ status: "processing", claimedAt: new Date(), attempts: sql`${notifications.attempts} + 1`, error: null })
      .where(and(eq(notifications.id, queuedItem.id), eq(notifications.status, "queued"), lt(notifications.attempts, MAX_NOTIFICATION_ATTEMPTS)))
      .returning();
    if (!item) continue;
    processed += 1;

    const payload = (item.payload ?? {}) as Payload;
    const text = render(item.template, payload);
    const hash = payloadHash(item.template, item.recipient, payload);
    const recentPayloads = await db
      .select({ payload: notifications.payload, template: notifications.template, recipient: notifications.recipient })
      .from(notifications)
      .where(
        and(
          eq(notifications.status, "sent"),
          eq(notifications.template, item.template),
          eq(notifications.recipient, item.recipient),
          sql`${notifications.sentAt} > now() - interval '15 minutes'`,
        ),
      )
      .limit(5);
    const duplicate = recentPayloads.some((recent) =>
      payloadHash(recent.template, recent.recipient, (recent.payload ?? {}) as Payload) === hash,
    );
    if (duplicate) {
      await db.update(notifications)
        .set({ status: "sent", sentAt: new Date(), claimedAt: null, error: "deduped: identical alert within 15m window" })
        .where(and(eq(notifications.id, item.id), eq(notifications.status, "processing")));
      skipped += 1;
      continue;
    }

    const to = await resolveRecipient(item.recipient);
    if (!to) {
      await db.update(notifications)
        .set({ status: "failed", claimedAt: null, error: "no deliverable address" })
        .where(and(eq(notifications.id, item.id), eq(notifications.status, "processing")));
      skipped += 1;
      continue;
    }

    const audit: Record<string, TelegramAudience> = {
      automation_alert: "dev",
      worker_outdated: "dev",
      notification_transport_down: "dev",
      telegram_handler_failure: "dev",
      daily_digest: "admin",
      new_order: "admin",
      order_fulfilment: "admin",
      security_alert: "dev",
    };
    const audience: TelegramAudience = audit[item.template] ?? "admin";
    // Routine confirmations self-clean; the review alert waits for the decision.
    const retainFor = item.template === "moderation_needed" && typeof payload.id === "string" ? payload.id : undefined;
    const result =
      item.channel === "telegram"
        ? await sendTelegramTo(audience, text, {
            ttlMs: audience === "admin" && ROUTINE_ADMIN_TEMPLATES.has(item.template) ? ADMIN_ROUTINE_TTL_MS : undefined,
            retainAlertFor: retainFor,
          })
        : item.channel === "whatsapp"
          ? await sendWhatsApp(to, text)
          : { ok: false, error: `channel ${item.channel} not implemented` };

    if (result.ok) {
      await db.update(notifications)
        .set({ status: "sent", sentAt: new Date(), claimedAt: null, error: null })
        .where(and(eq(notifications.id, item.id), eq(notifications.status, "processing")));
      sent += 1;
    } else {
      await db.update(notifications)
        .set({ status: "failed", claimedAt: null, error: result.error?.slice(0, 400) ?? "transport failed" })
        .where(and(eq(notifications.id, item.id), eq(notifications.status, "processing")));
      failed += 1;
    }
  }

  // A systemic transport outage is an ops problem, not a silent log line.
  if (failed > 0 && sent === 0 && queued.length >= 5) {
    await escalate("MatzHub notification transport down", `${failed} messages failed with zero successes. Check WhatsApp/Telegram credentials.`);
    
    const [existing] = await db
      .select({ id: opsTasks.id })
      .from(opsTasks)
      .where(and(eq(opsTasks.kind, "automation_failure"), eq(opsTasks.status, "open"), eq(opsTasks.title, "Notification transport is down")))
      .limit(1);
    if (!existing) {
      await db.insert(opsTasks).values({
        kind: "automation_failure",
        severity: "critical",
        title: "Notification transport is down",
        detail: `${failed} messages failed with zero successes. Check WA_WORKER_URL and TELEGRAM_ADMIN_BOT_TOKEN.`,
        actionUrl: "/admin/automation",
      });
    }
  }

  return { processed, sent, failed, skipped };
}

/** Retry messages that failed transiently, capped so a dead channel doesn't loop forever. */
export async function retryFailedNotifications(limit = 25) {
  const rows = await db
    .update(notifications)
    .set({ status: "queued", claimedAt: null, error: null })
    .where(
      and(
        eq(notifications.status, "failed"),
        lt(notifications.attempts, MAX_NOTIFICATION_ATTEMPTS),
        sql`${notifications.error} not ilike '%no deliverable%'`,
        sql`${notifications.error} not ilike '%not configured%'`,
        lte(notifications.createdAt, new Date(Date.now() - 5 * 60 * 1000)),
        inArray(
          notifications.id,
          db.select({ id: notifications.id }).from(notifications).where(eq(notifications.status, "failed")).limit(limit),
        ),
      ),
    )
    .returning({ id: notifications.id });
  return { requeued: rows.length };
}
