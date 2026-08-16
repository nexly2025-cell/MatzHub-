#!/usr/bin/env node
/**
 * Registers both Telegram bot webhooks against a deployed Next.js URL.
 * Idempotent — safe to re-run every deploy.
 *
 *   node scripts/setup-webhooks.mjs                     # uses NEXT_PUBLIC_SITE_URL
 *   node scripts/setup-webhooks.mjs https://matzhub.com # explicit
 *
 * Reads from .env: TELEGRAM_ADMIN_BOT_TOKEN, TELEGRAM_DEV_BOT_TOKEN,
 * TELEGRAM_WEBHOOK_SECRET, TELEGRAM_DEV_WEBHOOK_SECRET (falls back to admin secret).
 *
 * Never prints tokens. Only bot usernames and last 4 of secret.
 */
import "dotenv/config";

const site = (process.argv[2] || process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
if (!site || !/^https:\/\//.test(site)) {
  console.error("Pass the public site URL, e.g. `node scripts/setup-webhooks.mjs https://matzhub.com`");
  console.error("HTTPS is required by Telegram. HTTP will not work.");
  process.exit(1);
}

const bots = [
  {
    label: "admin",
    token: process.env.TELEGRAM_ADMIN_BOT_TOKEN,
    secret: process.env.TELEGRAM_WEBHOOK_SECRET,
    path: "/api/telegram/webhook",
  },
  {
    label: "dev",
    token: process.env.TELEGRAM_DEV_BOT_TOKEN,
    secret: process.env.TELEGRAM_DEV_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET,
    path: "/api/telegram/webhook/dev",
  },
];

let fatal = false;
for (const b of bots) {
  if (!b.token) {
    console.log(`  ✗ ${b.label}: TELEGRAM_${b.label.toUpperCase()}_BOT_TOKEN missing — skipping`);
    fatal = true;
    continue;
  }
  if (!b.secret) {
    console.log(`  ✗ ${b.label}: no webhook secret — refusing to register (webhook would be open)`);
    fatal = true;
    continue;
  }
  const url = `${site}${b.path}`;
  const meRes = await fetch(`https://api.telegram.org/bot${b.token}/getMe`);
  const me = await meRes.json();
  if (!me.ok) {
    console.log(`  ✗ ${b.label}: getMe failed — ${me.description}`);
    fatal = true;
    continue;
  }
  const setRes = await fetch(`https://api.telegram.org/bot${b.token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: b.secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
  });
  const setBody = await setRes.json();
  if (!setBody.ok) {
    console.log(`  ✗ ${b.label} @${me.result.username}: setWebhook failed — ${setBody.description}`);
    fatal = true;
    continue;
  }
  console.log(`  ✓ ${b.label} @${me.result.username}  →  ${url}  (secret …${b.secret.slice(-4)})`);
}

if (fatal) process.exit(1);
console.log("\n  Both webhooks registered. Message either bot to confirm delivery.\n");
