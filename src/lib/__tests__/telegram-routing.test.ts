import { afterEach, describe, expect, it } from "vitest";

/**
 * Bot routing.
 *
 * Telegram allows one webhook per bot and the payload never says which bot
 * received it. Role was previously derived from the sender's chat id, so a
 * developer messaging the dev bot from their own account was treated as an
 * admin and had every dev command refused, while the reply was sent through
 * the admin bot's token. Identity now comes from the URL path.
 */

function tokenFor(bot: "admin" | "dev"): string {
  return bot === "dev"
    ? process.env.TELEGRAM_DEV_BOT_TOKEN || ""
    : process.env.TELEGRAM_ADMIN_BOT_TOKEN || "";
}

function secretFor(bot: "admin" | "dev"): string {
  const shared = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  return bot === "dev" ? process.env.TELEGRAM_DEV_WEBHOOK_SECRET || shared : shared;
}

function allowedFor(bot: "admin" | "dev"): string[] {
  const raw = bot === "dev" ? process.env.TELEGRAM_DEV_CHAT_ID : process.env.TELEGRAM_ADMIN_CHAT_ID;
  return (raw ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

afterEach(() => {
  for (const k of [
    "TELEGRAM_ADMIN_BOT_TOKEN", "TELEGRAM_DEV_BOT_TOKEN",
    "TELEGRAM_ADMIN_CHAT_ID", "TELEGRAM_DEV_CHAT_ID",
    "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_DEV_WEBHOOK_SECRET",
  ]) delete process.env[k];
});

describe("per-bot token", () => {
  it("replies through the bot that received the update", () => {
    process.env.TELEGRAM_ADMIN_BOT_TOKEN = "admin-token";
    process.env.TELEGRAM_DEV_BOT_TOKEN = "dev-token";
    expect(tokenFor("admin")).toBe("admin-token");
    expect(tokenFor("dev")).toBe("dev-token");
  });

  it("does not silently fall back to the admin token", () => {
    // Falling back would make the dev bot appear dead: Telegram accepts the
    // update but the reply is delivered by a different bot.
    process.env.TELEGRAM_ADMIN_BOT_TOKEN = "admin-token";
    expect(tokenFor("dev")).toBe("");
  });
});

describe("per-bot webhook secret", () => {
  it("uses a dedicated dev secret when configured", () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "shared";
    process.env.TELEGRAM_DEV_WEBHOOK_SECRET = "dev-only";
    expect(secretFor("admin")).toBe("shared");
    expect(secretFor("dev")).toBe("dev-only");
  });

  it("falls back to the shared secret so single-bot setups keep working", () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "shared";
    expect(secretFor("dev")).toBe("shared");
  });
});

describe("per-bot allowlist", () => {
  it("scopes chat ids to their own bot", () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = "111";
    process.env.TELEGRAM_DEV_CHAT_ID = "222";
    expect(allowedFor("admin")).toEqual(["111"]);
    expect(allowedFor("dev")).toEqual(["222"]);
    // An admin cannot drive the dev bot and vice versa.
    expect(allowedFor("dev")).not.toContain("111");
    expect(allowedFor("admin")).not.toContain("222");
  });

  it("supports several developers on one bot", () => {
    process.env.TELEGRAM_DEV_CHAT_ID = "222, 333 ,444";
    expect(allowedFor("dev")).toEqual(["222", "333", "444"]);
  });

  it("fails closed when unset", () => {
    expect(allowedFor("dev")).toEqual([]);
    expect(allowedFor("admin")).toEqual([]);
  });
});

/**
 * Supplier group identity.
 *
 * The paired WhatsApp account sees 19 groups: nine live supplier channels,
 * nine near-empty duplicates that share their display names, and one
 * unrelated group. Telegram previously listed all of them, so every supplier
 * appeared twice and a dead duplicate was one tap from becoming a source.
 */
describe("authoritative supplier groups", () => {
  it("contains exactly the nine approved groups", async () => {
    const { AUTHORITATIVE_GROUPS } = await import("@/lib/ai");
    expect(AUTHORITATIVE_GROUPS).toHaveLength(9);
    expect(AUTHORITATIVE_GROUPS.map((g) => g.name).sort()).toEqual(
      [
        "SHETTY SILKS SHOES Reseller's Grp",
        "Shetty_Silks_ (Mens Section)",
        "Smart Collections 12@ Premium/Luxury",
        "Smart Collections_Clothing",
        "Smart Collections_Footwear",
        "Smart Collections_Perfumes",
        "Smart Collections_Premium Bags",
        "Smart Collections_Sunglasses",
        "Smart Collections_Watches",
      ].sort(),
    );
  });

  it("uses unique JIDs as identity", async () => {
    const { AUTHORITATIVE_GROUPS } = await import("@/lib/ai");
    const jids = AUTHORITATIVE_GROUPS.map((g) => g.jid);
    expect(new Set(jids).size).toBe(9);
    for (const jid of jids) expect(jid).toMatch(/^\d+@g\.us$/);
  });

  it("drops duplicates, unknown groups and preserves order", async () => {
    const { AUTHORITATIVE_GROUPS, resolveAuthoritativeGroups } = await import("@/lib/ai");
    const live = AUTHORITATIVE_GROUPS[6];
    const resolved = resolveAuthoritativeGroups([
      { jid: live.jid, subject: live.name },
      { jid: live.jid, subject: live.name },            // same JID twice
      { jid: "120363088478963131@g.us", subject: live.name }, // 2-member twin
      { jid: "120363420070237908@g.us", subject: "Mfbuddy watch group 13" },
      { jid: null, subject: "" },
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].jid).toBe(live.jid);
  });

  it("is idempotent across repeated syncs", async () => {
    const { AUTHORITATIVE_GROUPS, resolveAuthoritativeGroups } = await import("@/lib/ai");
    const discovered = AUTHORITATIVE_GROUPS.map((g) => ({ jid: g.jid, subject: g.name }));
    const a = resolveAuthoritativeGroups(discovered);
    const b = resolveAuthoritativeGroups([...discovered, ...discovered]);
    expect(a).toHaveLength(9);
    expect(b.map((g) => g.jid)).toEqual(a.map((g) => g.jid));
  });

  it("never auto-admits a newly discovered group", async () => {
    const { isAuthoritativeGroup, resolveAuthoritativeGroups } = await import("@/lib/ai");
    expect(isAuthoritativeGroup("120363999999999999@g.us")).toBe(false);
    expect(resolveAuthoritativeGroups([{ jid: "120363999999999999@g.us" }])).toEqual([]);
  });

  it("keeps the worker mapping in sync with the app allowlist", async () => {
    const { AUTHORITATIVE_GROUPS } = await import("@/lib/ai");
    const { readFile } = await import("node:fs/promises");
    const map = JSON.parse(await readFile("worker/group-mapping.json", "utf8")) as Record<string, string>;
    const jids = Object.keys(map).filter((k) => k.endsWith("@g.us"));
    expect(jids.sort()).toEqual(AUTHORITATIVE_GROUPS.map((g) => g.jid).sort());
  });
});
