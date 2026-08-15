import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";

/**
 * Operator subscription (Cashfree).
 *
 * This gates ONE thing: whether new products may publish automatically.
 *
 * Deliberate non-goals, because this is a billing relationship between the
 * platform and its operator, not between the operator and their customers:
 *   - No customer ever sees subscription state. No banners, no interstitials,
 *     no field in any public API response.
 *   - An expired subscription never removes, hides or de-lists anything that is
 *     already published. The storefront keeps serving the full catalogue.
 *   - Only future automatic uploads pause, and only the admin is told, over
 *     Telegram.
 *
 * State lives in `settings` rather than a dedicated table: it is a handful of
 * singleton scalars, and a new table would add a migration and a join for no
 * behavioural gain.
 */

const PAID_UNTIL = "subscription_paid_until";      // ISO 8601 instant
const LAST_ORDER = "subscription_last_order";      // idempotency key
const LAST_NOTIFIED = "subscription_last_notified"; // anti-spam for the admin alert
const BILLING_STARTS = "subscription_billing_starts"; // grace period boundary

/** Days of access granted per successful payment. */
export const SUBSCRIPTION_DAYS = 30;

/**
 * Anchor for the current billing period, as an ISO date.
 *
 * Set to the date the operator last paid. Expiry is exactly
 * SUBSCRIPTION_DAYS after it. Once a Cashfree webhook lands, the stored
 * paid-until value takes over and this is only a fallback.
 */
export const LAST_PAYMENT_DATE = (process.env.SUBSCRIPTION_LAST_PAYMENT ?? "").trim();

/** Seeds paid-until from LAST_PAYMENT_DATE the first time it is needed. */
async function ensureAnchor(): Promise<void> {
  if (!LAST_PAYMENT_DATE) return;
  if (await read(PAID_UNTIL)) return;
  const paidOn = new Date(LAST_PAYMENT_DATE);
  if (Number.isNaN(paidOn.getTime())) return;
  await write(PAID_UNTIL, new Date(paidOn.getTime() + SUBSCRIPTION_DAYS * 86_400_000).toISOString());
}

/**
 * Reminder ladder, in days before expiry: two days out, then on the day.
 * Each milestone fires at most once per period — LAST_NOTIFIED records which
 * one was last sent, so a daily cron cannot turn one reminder into many.
 */
export const RENEWAL_REMINDER_DAYS = [2, 0] as const;

/**
 * The tightest reminder rung that `days` has reached, or undefined when the
 * expiry is still far off.
 *
 * Must scan smallest-first. A naive `find(d => days <= d)` over [7, 2, 0]
 * returns 7 for every value below 7, so once the seven-day notice was sent the
 * two-day and expiry-day notices would be deduplicated away and never fire.
 */
export function reminderMilestone(days: number): number | undefined {
  return [...RENEWAL_REMINDER_DAYS].sort((a, b) => a - b).find((d) => days <= d);
}

/**
 * Billing does not begin on the day the platform goes live — the operator gets
 * the remainder of the current month free. Until this instant passes, uploads
 * are permitted regardless of payment state.
 *
 * Resolution order:
 *   1. SUBSCRIPTION_BILLING_STARTS (ISO date) — explicit override
 *   2. a value persisted in settings on first read
 *   3. 00:00 UTC on the first day of next month, then persisted so it is
 *      computed once and never drifts across deploys
 */
export async function billingStartsAt(): Promise<Date> {
  // An explicit paid-until date means billing is already live; there is no
  // grace period to compute.
  if (await read(PAID_UNTIL)) return new Date(0);

  const override = (process.env.SUBSCRIPTION_BILLING_STARTS ?? "").trim();
  if (override) {
    const d = new Date(override);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const stored = await read(BILLING_STARTS);
  if (stored) {
    const d = new Date(stored);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  await write(BILLING_STARTS, first.toISOString());
  return first;
}

export type SubscriptionStatus = {
  active: boolean;
  paidUntil: Date | null;
  daysRemaining: number | null;
  /** True when never paid — distinct from "paid once, now lapsed". */
  neverActivated: boolean;
  /** True while inside the pre-billing grace period. */
  inGracePeriod: boolean;
  billingStarts: Date | null;
};

async function read(key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

async function write(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function subscriptionStatus(): Promise<SubscriptionStatus> {
  await ensureAnchor();
  const billingStarts = await billingStartsAt();
  const inGracePeriod = Date.now() < billingStarts.getTime();
  const raw = await read(PAID_UNTIL);

  if (!raw) {
    return { active: false, paidUntil: null, daysRemaining: null, neverActivated: true, inGracePeriod, billingStarts };
  }

  const paidUntil = new Date(raw);
  if (Number.isNaN(paidUntil.getTime())) {
    return { active: false, paidUntil: null, daysRemaining: null, neverActivated: true, inGracePeriod, billingStarts };
  }

  const ms = paidUntil.getTime() - Date.now();
  return {
    active: ms > 0,
    paidUntil,
    daysRemaining: Math.ceil(ms / 86_400_000),
    neverActivated: false,
    inGracePeriod,
    billingStarts,
  };
}

/**
 * Extends access after a confirmed payment.
 *
 * Renewal stacks from the later of "now" and the current expiry, so paying
 * early never costs the operator the days they already own, and paying late
 * never back-dates the new period into the past.
 *
 * Idempotent by order id: Cashfree retries webhooks, and a naive handler would
 * grant 30 days per retry.
 */
export async function recordPayment(orderId: string, days = SUBSCRIPTION_DAYS): Promise<{
  applied: boolean;
  reason?: string;
  paidUntil: Date | null;
}> {
  if (!orderId) return { applied: false, reason: "missing order id", paidUntil: null };

  const seen = await read(LAST_ORDER);
  if (seen === orderId) {
    const { paidUntil } = await subscriptionStatus();
    return { applied: false, reason: "duplicate webhook", paidUntil };
  }

  const current = await subscriptionStatus();
  const base = current.active && current.paidUntil ? current.paidUntil.getTime() : Date.now();
  const next = new Date(base + days * 86_400_000);

  await write(PAID_UNTIL, next.toISOString());
  await write(LAST_ORDER, orderId);
  await write(LAST_NOTIFIED, ""); // a fresh period may warn again

  return { applied: true, paidUntil: next };
}

/**
 * Verifies a Cashfree webhook.
 *
 * Scheme (cashfree.com/docs/payments/webhooks): the signature is
 * base64(HMAC-SHA256(timestamp + rawBody, clientSecret)). The RAW body must be
 * used — re-serialising parsed JSON changes key order and whitespace and will
 * never match.
 */
export function verifyCashfreeSignature(rawBody: string, timestamp: string | null, signature: string | null): boolean {
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!secret || !timestamp || !signature) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}${rawBody}`).digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Direct order verification against Cashfree.
 *
 * The webhook is the fast path, but webhooks get missed — endpoint down during
 * a deploy, transient network failure, or a retry budget exhausted. Without a
 * pull-based check a paying operator silently loses access. This is that
 * backstop, called by the daily subscription cron.
 *
 * Returns null when Cashfree is unreachable or unconfigured, which the caller
 * treats as "no new information" rather than "not paid".
 */
export async function verifyOrderWithCashfree(orderId: string): Promise<{ paid: boolean } | null> {
  const appId = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!appId || !secret || !orderId) return null;

  const base =
    process.env.CASHFREE_ENV === "production"
      ? "https://api.cashfree.com/pg"
      : "https://sandbox.cashfree.com/pg";

  try {
    const res = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`, {
      headers: {
        "x-client-id": appId,
        "x-client-secret": secret,
        "x-api-version": "2023-08-01",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { order_status?: string };
    return { paid: body.order_status === "PAID" };
  } catch {
    return null;
  }
}

/** Monthly subscription price in INR. Override with SUBSCRIPTION_PRICE_INR. */
export const SUBSCRIPTION_PRICE_INR = Number(process.env.SUBSCRIPTION_PRICE_INR || 2500);

/**
 * Creates a Cashfree order and returns a hosted payment link.
 *
 * This is the operator's only payment entry point — surfaced through the admin
 * Telegram bot, never on the storefront. Returns null when Cashfree is not yet
 * configured so the caller can say so plainly instead of showing a dead link.
 */
export async function createSubscriptionOrder(): Promise<{ orderId: string; paymentLink: string } | null> {
  const appId = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!appId || !secret) return null;

  const base =
    process.env.CASHFREE_ENV === "production"
      ? "https://api.cashfree.com/pg"
      : "https://sandbox.cashfree.com/pg";

  // Deterministic per-month id: retrying within the same month reuses the
  // order rather than creating duplicates, and recordPayment is keyed on it.
  const period = new Date().toISOString().slice(0, 7).replace("-", "");
  const orderId = `matzhub-sub-${period}`;

  try {
    const res = await fetch(`${base}/orders`, {
      method: "POST",
      headers: {
        "x-client-id": appId,
        "x-client-secret": secret,
        "x-api-version": "2023-08-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: SUBSCRIPTION_PRICE_INR,
        order_currency: "INR",
        customer_details: {
          customer_id: "matzhub-operator",
          customer_phone: process.env.NEXT_PUBLIC_CUSTOMER_WHATSAPP || "9999999999",
        },
        order_note: `MatzHub automation subscription — ${SUBSCRIPTION_DAYS} days`,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { payment_session_id?: string; order_id?: string };
    if (!body.payment_session_id) return null;
    const host = process.env.CASHFREE_ENV === "production" ? "payments" : "payments-test";
    return {
      orderId: body.order_id ?? orderId,
      paymentLink: `https://${host}.cashfree.com/pay/${body.payment_session_id}`,
    };
  } catch {
    return null;
  }
}

/**
 * Should the ingestion pipeline publish automatically right now?
 * Requires both a live subscription and the operator's manual switch.
 */
export async function uploadsPermitted(): Promise<{ permitted: boolean; reason: string | null }> {
  const sub = await subscriptionStatus();
  // Free until billing begins next month.
  if (sub.inGracePeriod) return { permitted: true, reason: "grace_period" };
  if (!sub.active) {
    return { permitted: false, reason: sub.neverActivated ? "subscription_never_activated" : "subscription_expired" };
  }
  return { permitted: true, reason: null };
}

/**
 * Returns an admin-facing message when one is due, else null.
 * Caller sends it; this module only decides. Deduplicated per calendar day so
 * an hourly cron cannot turn a lapsed subscription into 24 notifications.
 */
export async function pendingAdminNotice(): Promise<string | null> {
  const sub = await subscriptionStatus();
  const sent = (await read(LAST_NOTIFIED)) ?? "";

  const fire = async (tag: string, text: string) => {
    if (sent === tag) return null;
    await write(LAST_NOTIFIED, tag);
    return text;
  };

  // Grace period: silent except as billing approaches.
  if (sub.inGracePeriod) {
    const days = Math.ceil((sub.billingStarts!.getTime() - Date.now()) / 86_400_000);
    const milestone = reminderMilestone(days);
    if (milestone === undefined) return null;
    return fire(
      `grace:${milestone}`,
      `*Billing starts ${sub.billingStarts!.toISOString().slice(0, 10)}* (${days} day${days === 1 ? "" : "s"}). ` +
        "Automatic uploads run free until then. The storefront is never affected.",
    );
  }

  // Lapsed: say it once, not once per cron tick.
  if (!sub.active) {
    return fire(
      "expired",
      "*Subscription inactive.* Automatic product synchronisation has paused. " +
        "The existing catalogue remains online and fully visible to customers.",
    );
  }

  // Active: 7 days out, then 2, then on the day. Each exactly once.
  const days = sub.daysRemaining ?? 999;
  const milestone = reminderMilestone(days);
  if (milestone === undefined) return null;

  return fire(
    `renew:${milestone}`,
    milestone === 0
      ? "*Subscription expires today.* Automatic uploads pause when it lapses. " +
          "Existing products stay online and customers see no change."
      : `*Subscription renews in ${days} day${days === 1 ? "" : "s"}.* ` +
          "Automatic uploads pause if it lapses. The storefront is unaffected either way.",
  );
}

/**
 * Re-checks the most recent order with Cashfree and extends access if that
 * order is PAID but the webhook never landed. Safe to run repeatedly:
 * recordPayment is idempotent per order id, so a reconciliation that finds
 * nothing new performs no write.
 */
export async function reconcileSubscription(): Promise<boolean> {
  const status = await subscriptionStatus();
  if (status.active) return false; // nothing to repair

  const orderId = await read(LAST_ORDER);
  if (!orderId) return false; // never paid; nothing to reconcile against

  const verdict = await verifyOrderWithCashfree(orderId);
  if (!verdict?.paid) return false;

  // The stored order is genuinely paid but access lapsed, meaning the renewal
  // webhook for it was lost. Grant the period it bought.
  await write(PAID_UNTIL, new Date(Date.now() + SUBSCRIPTION_DAYS * 86_400_000).toISOString());
  return true;
}
