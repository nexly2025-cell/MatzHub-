import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Subscription billing anchor and grace period.
 *
 * These assertions previously lived in telegram.test.ts and reached the real
 * database, so they only passed when a Postgres happened to be listening on
 * localhost — a false pass in CI and a hard failure on a clean checkout.
 *
 * The persistence boundary is mocked here with an in-memory settings store.
 * Everything above it — the anchor arithmetic, the grace-period comparison and
 * the upload gate — runs for real, so the behaviour is genuinely verified
 * rather than stubbed away.
 */

const store = new Map<string, string>();

vi.mock("@/db", () => {
  const rowsFor = (key: string) => (store.has(key) ? [{ key, value: store.get(key)! }] : []);
  let pendingKey = "";
  const chain = {
    from: () => chain,
    where: (cond: { key?: string }) => {
      pendingKey = cond?.key ?? pendingKey;
      return chain;
    },
    limit: () => Promise.resolve(rowsFor(pendingKey)),
  };
  return {
    db: {
      select: () => chain,
      insert: () => ({
        values: (v: { key: string; value: string }) => ({
          onConflictDoUpdate: () => {
            store.set(v.key, v.value);
            return Promise.resolve();
          },
        }),
      }),
    },
  };
});

// drizzle's eq() is used to build the predicate the mock above reads.
vi.mock("drizzle-orm", async (orig) => {
  const actual = await orig<typeof import("drizzle-orm")>();
  return { ...actual, eq: (_col: unknown, value: string) => ({ key: value }) };
});

const DAY = 86_400_000;

beforeEach(() => {
  store.clear();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("payment anchor", () => {
  it("derives expiry exactly SUBSCRIPTION_DAYS after the recorded payment", async () => {
    vi.stubEnv("SUBSCRIPTION_LAST_PAYMENT", "2026-08-04");
    const { subscriptionStatus, SUBSCRIPTION_DAYS } = await import("@/lib/subscription");

    const s = await subscriptionStatus();

    expect(SUBSCRIPTION_DAYS).toBe(30);
    // 4 Aug + 30 days = 3 Sep. This is the date the operator was quoted.
    expect(s.paidUntil?.toISOString().slice(0, 10)).toBe("2026-09-03");
    expect(store.get("subscription_paid_until")).toContain("2026-09-03");
  });

  it("bypasses the grace period once an anchor exists", async () => {
    vi.stubEnv("SUBSCRIPTION_LAST_PAYMENT", "2026-08-04");
    const { subscriptionStatus } = await import("@/lib/subscription");

    const s = await subscriptionStatus();

    // A stored paid-until means billing is live; there is no free window left
    // to fall back into, regardless of what the month boundary would compute.
    expect(s.inGracePeriod).toBe(false);
    expect(s.neverActivated).toBe(false);
  });

  it("keeps the pre-billing grace period when nothing has been paid", async () => {
    vi.stubEnv("SUBSCRIPTION_BILLING_STARTS", new Date(Date.now() + 5 * DAY).toISOString());
    const { subscriptionStatus, uploadsPermitted } = await import("@/lib/subscription");

    const s = await subscriptionStatus();
    expect(s.inGracePeriod).toBe(true);
    expect(s.neverActivated).toBe(true);
    // Uploads run free until billing begins.
    await expect(uploadsPermitted()).resolves.toMatchObject({ permitted: true, reason: "grace_period" });
  });

  it("pauses uploads once the grace period ends unpaid", async () => {
    vi.stubEnv("SUBSCRIPTION_BILLING_STARTS", new Date(Date.now() - DAY).toISOString());
    const { uploadsPermitted } = await import("@/lib/subscription");

    await expect(uploadsPermitted()).resolves.toMatchObject({
      permitted: false,
      reason: "subscription_never_activated",
    });
  });

  it("permits uploads while a paid period is still running", async () => {
    store.set("subscription_paid_until", new Date(Date.now() + 10 * DAY).toISOString());
    const { uploadsPermitted, subscriptionStatus } = await import("@/lib/subscription");

    const s = await subscriptionStatus();
    expect(s.active).toBe(true);
    expect(s.daysRemaining).toBeGreaterThan(9);
    await expect(uploadsPermitted()).resolves.toMatchObject({ permitted: true });
  });

  it("pauses uploads after a paid period lapses, without touching the catalogue", async () => {
    store.set("subscription_paid_until", new Date(Date.now() - DAY).toISOString());
    const { uploadsPermitted } = await import("@/lib/subscription");

    await expect(uploadsPermitted()).resolves.toMatchObject({
      permitted: false,
      reason: "subscription_expired",
    });
  });
});

describe("renewal payments", () => {
  it("stacks a renewal onto the remaining balance instead of truncating it", async () => {
    const remaining = new Date(Date.now() + 10 * DAY);
    store.set("subscription_paid_until", remaining.toISOString());
    const { recordPayment, SUBSCRIPTION_DAYS } = await import("@/lib/subscription");

    const r = await recordPayment("order-early", SUBSCRIPTION_DAYS);

    // Paying early must not cost the operator the days already owned.
    expect(r.applied).toBe(true);
    const gained = (r.paidUntil!.getTime() - remaining.getTime()) / DAY;
    expect(Math.round(gained)).toBe(SUBSCRIPTION_DAYS);
  });

  it("does not back-date a renewal made after expiry", async () => {
    store.set("subscription_paid_until", new Date(Date.now() - 5 * DAY).toISOString());
    const { recordPayment, SUBSCRIPTION_DAYS } = await import("@/lib/subscription");

    const r = await recordPayment("order-late", SUBSCRIPTION_DAYS);

    // The new period starts now, not from the lapsed date.
    const fromNow = (r.paidUntil!.getTime() - Date.now()) / DAY;
    expect(Math.round(fromNow)).toBe(SUBSCRIPTION_DAYS);
  });

  it("is idempotent per order id so webhook retries cannot grant free months", async () => {
    const { recordPayment } = await import("@/lib/subscription");

    const first = await recordPayment("cf-order-1");
    const replay = await recordPayment("cf-order-1");

    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(replay.reason).toBe("duplicate webhook");
    expect(replay.paidUntil?.toISOString()).toBe(first.paidUntil?.toISOString());
  });

  it("rejects a payment with no order id", async () => {
    const { recordPayment } = await import("@/lib/subscription");
    await expect(recordPayment("")).resolves.toMatchObject({ applied: false });
  });
});
