import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { manufacturers, notifications, opsTasks } from "@/db/schema";
import { SITE, inr } from "@/lib/utils";

/**
 * Notification dispatcher.
 * Renders templates, sends via WhatsApp Cloud API / Telegram, retries with backoff.
 * Nothing here can block a customer action — the queue is drained by cron.
 */

type Payload = Record<string, unknown>;

import crypto from "node:crypto";
const payloadHash = (template: string, recipient: string, payload: Payload) =>
  crypto.createHash("sha256").update(`${template}|${recipient}|${JSON.stringify(payload)}`).digest("hex");

const s = (p: Payload, k: string, d = "") => (typeof p[k] === "string" || typeof p[k] === "number" ? String(p[k]) : d);
const n = (p: Payload, k: string, d = 0) => (typeof p[k] === "number" ? p[k] : d);

export function render(template: string, p: Payload): string {
  switch (template) {
    case "order_confirmed":
      return [
        `*Order confirmed — ${s(p, "orderNo")}*`,
        ``,
        `Thanks for shopping with MatzHub. Total ${inr(n(p, "total"))}.`,
        `Your items ship from the curated source within ≤5 hours.`,
        ``,
        `Track it here: ${SITE.url}/track?no=${s(p, "orderNo")}`,
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

    case "price_drop":
      return [
        `*Price drop on your saved item*`,
        ``,
        `${s(p, "title")} is now ${inr(n(p, "price"))} — at or below your ${inr(n(p, "target"))} target.`,
        ``,
        `${SITE.url}/p/${s(p, "slug")}`,
      ].join("\n");

    case "cart_recovery":
      return [
        `You left something in your MatzHub cart.`,
        ``,
        `Manufacturer stock moves fast and items archive automatically. Finish here: ${SITE.url}/cart`,
      ].join("\n");

    case "new_order":
      return `🟢 Order ${s(p, "orderNo")} · ${inr(n(p, "total"))} · risk ${n(p, "risk")}`;

    case "payment_received":
      return [
        `*Payment received — ${s(p, "orderNo")}*`,
        ``,
        `${inr(n(p, "total"))} confirmed. Your order is now first in the dispatch queue.`,
        ``,
        `${SITE.url}/track?no=${s(p, "orderNo")}`,
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
      return [`*Order ${s(p, "orderNo")}*`, "", `Your order is ${human[s(p, "status")] ?? s(p, "status")}`, track, "", `${SITE.url}/track?no=${s(p, "orderNo")}`].filter(Boolean).join("\n");
    }

    case "moderation_needed":
      return [
        `🟢 *Review needed*: ${s(p, "title")}`,
        ``,
        `*Supplier:* ${s(p, "supplierName", "Unknown")}`,
        `*Group:* ${s(p, "groupName", "Unknown")} (${s(p, "groupId", "Unknown")})`,
        `*Received:* ${s(p, "receivedAt", "Unknown")}`,
        `*Message Ref:* \`${s(p, "messageId", "Unknown")}\``,
        ``,
        `*AI Metrics:*`,
        `• Quality: ${n(p, "quality")}/100`,
        `• Confidence: ${n(p, "confidence")}%`,
        `• Reason: ${s(p, "reason")}`,
        ``,
        `🔗 ${SITE.url}/admin/moderation`,
      ].join("\n");

    case "product_auto_published":
      return [
        `✅ *Auto-Published*: ${s(p, "title")}`,
        ``,
        `*Supplier:* ${s(p, "supplierName", "Unknown")}`,
        `*Group:* ${s(p, "groupName", "Unknown")} (${s(p, "groupId", "Unknown")})`,
        `*Received:* ${s(p, "receivedAt", "Unknown")}`,
        `*Message Ref:* \`${s(p, "messageId", "Unknown")}\``,
        ``,
        `*AI Metrics:*`,
        `• Quality: ${n(p, "quality")}/100`,
        `• Confidence: ${n(p, "confidence")}%`,
        ``,
        `🔗 ${SITE.url}/p/${s(p, "slug")}`,
      ].join("\n");

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

async function sendTelegramTo(audience: TelegramAudience, text: string): Promise<{ ok: boolean; error?: string }> {
  const { token, chatId } = telegramRecipient(audience);
  if (!token || !chatId) return { ok: false, error: `telegram ${audience} not configured` };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `telegram ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : `telegram ${audience} failed` };
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

/** Drain the queue. Idempotent and safe to run every minute. */
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
  const queued = await db
    .select()
    .from(notifications)
    .where(eq(notifications.status, "queued"))
    .orderBy(notifications.createdAt)
    .limit(limit);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of queued) {
    const text = render(item.template, (item.payload ?? {}) as Payload);

    // Anti-spam: the same alert to the same recipient is never sent twice within
    // 15 minutes. Covers watchdog flapping, repeated failures, chatty crons.
    const hash = payloadHash(item.template, item.recipient, (item.payload ?? {}) as Payload);
    const [recentDup] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.status, "sent"), sql`${notifications.sentAt} > now() - interval '15 minutes'`))
      .orderBy(sql`${notifications.sentAt} desc`)
      .limit(25);
    if (recentDup) {
      const [recentPayloads] = await db
        .select({ payload: notifications.payload, template: notifications.template, recipient: notifications.recipient, sentAt: notifications.sentAt })
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
      if (recentPayloads && payloadHash(recentPayloads.template, recentPayloads.recipient, (recentPayloads.payload ?? {}) as Payload) === hash) {
        await db.update(notifications).set({ status: "sent", sentAt: new Date(), error: "deduped: identical alert within 15m window" }).where(eq(notifications.id, item.id));
        failed++; // counts as suppressed, not delivered
        continue;
      }
    }
    const to = await resolveRecipient(item.recipient);

    if (!to) {
      await db.update(notifications).set({ status: "failed", error: "no deliverable address" }).where(eq(notifications.id, item.id));
      skipped += 1;
      continue;
    }

    // Route alert class to the right person's inbox.
    const audit: Record<string, TelegramAudience> = {
      automation_alert: "dev",
      worker_outdated: "dev",
      notification_transport_down: "dev",
      daily_digest: "admin",
      new_order: "admin",
      order_fulfilment: "admin",
      security_alert: "dev",
    };
    const audience: TelegramAudience = audit[item.template] ?? "admin";

    const result =
      item.channel === "telegram"
        ? await sendTelegramTo(audience, text)
        : item.channel === "whatsapp"
          ? await sendWhatsApp(to, text)
          : { ok: false, error: `channel ${item.channel} not implemented` };

    if (result.ok) {
      await db.update(notifications).set({ status: "sent", sentAt: new Date(), error: null }).where(eq(notifications.id, item.id));
      sent += 1;
    } else {
      await db.update(notifications).set({ status: "failed", error: result.error?.slice(0, 400) }).where(eq(notifications.id, item.id));
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

  return { processed: queued.length, sent, failed, skipped };
}

/** Retry messages that failed transiently, capped so a dead channel doesn't loop forever. */
export async function retryFailedNotifications(limit = 25) {
  const rows = await db
    .update(notifications)
    .set({ status: "queued", error: null })
    .where(
      and(
        eq(notifications.status, "failed"),
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
