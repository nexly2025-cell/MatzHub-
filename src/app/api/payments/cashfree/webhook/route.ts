import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog, notifications } from "@/db/schema";
import { recordPayment, verifyCashfreeSignature, SUBSCRIPTION_DAYS } from "@/lib/subscription";

export const dynamic = "force-dynamic";

/**
 * Cashfree payment webhook.
 *
 * Reads the body as text and verifies the signature against those exact bytes.
 * Parsing first and re-serialising would change key order and whitespace, and
 * the HMAC would never match.
 *
 * Returns 200 for anything already handled or safely ignorable so Cashfree does
 * not retry indefinitely; 401 only for a genuine signature failure, which is
 * the one case where a retry could legitimately succeed after config repair.
 */

type CashfreeEvent = {
  type?: string;
  data?: {
    order?: { order_id?: string; order_amount?: number; order_currency?: string };
    payment?: { payment_status?: string; cf_payment_id?: string | number };
  };
};

export async function POST(request: Request) {
  const raw = await request.text();

  if (
    !verifyCashfreeSignature(
      raw,
      request.headers.get("x-webhook-timestamp"),
      request.headers.get("x-webhook-signature"),
    )
  ) {
    // Also covers the unconfigured case: with no CASHFREE_SECRET_KEY the
    // endpoint rejects everything rather than trusting unsigned callers.
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  let event: CashfreeEvent;
  try {
    event = JSON.parse(raw) as CashfreeEvent;
  } catch {
    return NextResponse.json({ ok: true, ignored: "unparseable body" });
  }

  const type = event.type ?? "";
  const orderId = event.data?.order?.order_id ?? "";
  const paymentStatus = event.data?.payment?.payment_status ?? "";

  // Only a settled success extends access. Drops, failures and user-dropped
  // attempts are acknowledged and discarded.
  const isSuccess = type === "PAYMENT_SUCCESS_WEBHOOK" && paymentStatus === "SUCCESS";
  if (!isSuccess) {
    return NextResponse.json({ ok: true, ignored: type || "unknown event" });
  }

  const result = await recordPayment(orderId, SUBSCRIPTION_DAYS);

  await db.insert(auditLog).values({
    actor: "cashfree",
    action: result.applied ? "subscription.renewed" : "subscription.duplicate_webhook",
    entityType: "subscription",
    entityId: orderId,
    after: { paidUntil: result.paidUntil?.toISOString() ?? null, amount: event.data?.order?.order_amount ?? null },
  });

  if (result.applied) {
    // Queued, never sent inline: a slow Telegram must not make Cashfree retry.
    await db.insert(notifications).values({
      channel: "telegram",
      audience: "ops",
      recipient: "ops",
      template: "subscription_renewed",
      payload: {
        orderId,
        paidUntil: result.paidUntil?.toISOString() ?? null,
        days: SUBSCRIPTION_DAYS,
      },
    });
  }

  return NextResponse.json({ ok: true, applied: result.applied });
}
