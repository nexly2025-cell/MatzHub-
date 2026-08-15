import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { reminderMilestone, RENEWAL_REMINDER_DAYS, verifyCashfreeSignature } from "@/lib/subscription";

const SECRET = "test_cashfree_secret_key";

afterEach(() => {
  delete process.env.CASHFREE_SECRET_KEY;
});

/** Mirrors Cashfree's documented scheme: base64(HMAC-SHA256(ts + rawBody)). */
function sign(ts: string, body: string, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(`${ts}${body}`).digest("base64");
}

describe("Cashfree webhook signature", () => {
  const ts = "1746426425612";
  const body = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: "ord_1" } } });

  it("accepts a correctly signed payload", () => {
    process.env.CASHFREE_SECRET_KEY = SECRET;
    expect(verifyCashfreeSignature(body, ts, sign(ts, body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    process.env.CASHFREE_SECRET_KEY = SECRET;
    const good = sign(ts, body);
    const tampered = body.replace("ord_1", "ord_2");
    expect(verifyCashfreeSignature(tampered, ts, good)).toBe(false);
  });

  it("rejects a replayed signature under a different timestamp", () => {
    process.env.CASHFREE_SECRET_KEY = SECRET;
    expect(verifyCashfreeSignature(body, "1746426425999", sign(ts, body))).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    process.env.CASHFREE_SECRET_KEY = SECRET;
    expect(verifyCashfreeSignature(body, ts, sign(ts, body, "attacker_secret"))).toBe(false);
  });

  it("fails closed when the secret is not configured", () => {
    // No CASHFREE_SECRET_KEY: an unconfigured deployment must reject every
    // caller rather than trust unsigned webhooks and grant free access.
    expect(verifyCashfreeSignature(body, ts, sign(ts, body))).toBe(false);
  });

  it("rejects missing headers", () => {
    process.env.CASHFREE_SECRET_KEY = SECRET;
    expect(verifyCashfreeSignature(body, null, sign(ts, body))).toBe(false);
    expect(verifyCashfreeSignature(body, ts, null)).toBe(false);
  });

  it("does not throw on a malformed signature of differing length", () => {
    process.env.CASHFREE_SECRET_KEY = SECRET;
    // timingSafeEqual throws on length mismatch; the guard must catch it first.
    expect(() => verifyCashfreeSignature(body, ts, "short")).not.toThrow();
    expect(verifyCashfreeSignature(body, ts, "short")).toBe(false);
  });
});

describe("customer privacy invariant", () => {
  it("keeps subscription state out of every public surface", async () => {
    // The operator's billing status must never reach a customer. This asserts
    // the boundary structurally so a future edit cannot leak it into a page,
    // a component or a public API response.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const roots = ["src/app", "src/components"];
    const offenders: string[] = [];

    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
      }
      return out;
    }

    for (const root of roots) {
      for (const file of await walk(root)) {
        // Admin surfaces and the payment plumbing itself are allowed to know.
        if (file.includes("/admin/") || file.includes("/api/payments/") || file.includes("/api/cron/")) continue;
        const src = await readFile(file, "utf8");
        if (/subscriptionStatus|uploadsPermitted|subscription_paid_until|SUBSCRIPTION_DAYS/.test(src)) {
          offenders.push(file);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("renewal reminder ladder", () => {
  it("fires two days before expiry and on the day", () => {
    expect([...RENEWAL_REMINDER_DAYS]).toEqual([2, 0]);
  });

  it("selects the tightest milestone that has been reached", () => {
    // Must scan smallest-first. A descending scan over [7, 2, 0] returns 7 for
    // every value below 7, so after the seven-day notice was sent the two-day
    // and expiry-day notices were deduplicated away and never fired.
    const pick = reminderMilestone;
    expect(pick(30)).toBeUndefined(); // far out: silent
    expect(pick(7)).toBeUndefined();  // still silent
    expect(pick(2)).toBe(2);          // fires the 2-day notice
    expect(pick(1)).toBe(2);          // same rung -> deduped, silent
    expect(pick(0)).toBe(0);          // fires on expiry day
  });
});

describe("billing anchor", () => {
  it("computes expiry exactly 30 days after the last payment", async () => {
    const { SUBSCRIPTION_DAYS } = await import("@/lib/subscription");
    const paidOn = new Date("2026-08-04T00:00:00.000Z");
    const expiry = new Date(paidOn.getTime() + SUBSCRIPTION_DAYS * 86_400_000);
    expect(SUBSCRIPTION_DAYS).toBe(30);
    expect(expiry.toISOString().slice(0, 10)).toBe("2026-09-03");
  });
});
