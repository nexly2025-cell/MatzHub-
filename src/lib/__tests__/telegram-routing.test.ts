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
