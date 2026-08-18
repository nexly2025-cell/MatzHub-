#!/usr/bin/env node
/**
 * MatzHub preflight — GO/NO-GO for real-world launch.
 *
 * Run BEFORE the first Vercel deploy and BEFORE `fly deploy` for the worker.
 * Exits 0 only when every check reports GO. Any FAIL exits non-zero so a
 * launch script or CI can stop.
 *
 *   node scripts/preflight.mjs
 *   node scripts/preflight.mjs --json          # machine-readable
 *   node scripts/preflight.mjs --skip=worker   # skip WA_WORKER_URL probe
 *
 * Never prints secret values. Only presence + last 4 for identification.
 */
import "dotenv/config";
import { Pool } from "pg";

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has("--json");
const SKIP = new Set(
  process.argv
    .filter((a) => a.startsWith("--skip="))
    .flatMap((a) => a.slice(7).split(",").map((s) => s.trim()))
    .filter(Boolean),
);

const results = [];
const record = (name, status, detail) => results.push({ name, status, detail });

const bold = (s) => (JSON_OUT ? s : `\x1b[1m${s}\x1b[0m`);
const green = (s) => (JSON_OUT ? s : `\x1b[32m${s}\x1b[0m`);
const red = (s) => (JSON_OUT ? s : `\x1b[31m${s}\x1b[0m`);
const yellow = (s) => (JSON_OUT ? s : `\x1b[33m${s}\x1b[0m`);
const dim = (s) => (JSON_OUT ? s : `\x1b[2m${s}\x1b[0m`);

const REQUIRED_ENV = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_CUSTOMER_WHATSAPP",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "INGEST_TOKEN",
  "CRON_SECRET",
  "TELEGRAM_ADMIN_BOT_TOKEN",
  "TELEGRAM_ADMIN_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_DEV_BOT_TOKEN",
  "TELEGRAM_DEV_CHAT_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_BUCKET",
  "WA_WORKER_URL",
  "WA_WORKER_TOKEN",
  "WA_GROUP_IDS",
];

const RECOMMENDED_ENV = [
  "SUPABASE_VIDEO_BUCKET",
  "CASHFREE_APP_ID",
  "CASHFREE_SECRET_KEY",
  "OPENAI_API_KEY",
];

/* ── 1. Environment variables ─────────────────────────────────────── */
function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  const weakAdmin =
    !process.env.ADMIN_PASSWORD ||
    /^(change-me|matzhub-dev|password|admin)/i.test(process.env.ADMIN_PASSWORD || "");
  const shortSecret = (k, minLen) =>
    process.env[k] && process.env[k].length < minLen;

  const problems = [];
  if (missing.length) problems.push(`missing: ${missing.join(", ")}`);
  if (weakAdmin) problems.push("ADMIN_PASSWORD looks like a dev default");
  for (const [k, min] of [
    ["ADMIN_SESSION_SECRET", 32],
    ["INGEST_TOKEN", 32],
    ["CRON_SECRET", 32],
    ["TELEGRAM_WEBHOOK_SECRET", 24],
    ["WA_WORKER_TOKEN", 32],
  ]) {
    if (shortSecret(k, min)) problems.push(`${k} shorter than ${min} chars`);
  }

  const recommendedMissing = RECOMMENDED_ENV.filter((k) => !process.env[k]);

  if (problems.length) {
    record("env.required", "FAIL", problems.join("; "));
  } else {
    record("env.required", "GO", `${REQUIRED_ENV.length} present`);
  }
  if (recommendedMissing.length) {
    record("env.recommended", "WARN", `absent: ${recommendedMissing.join(", ")}`);
  } else {
    record("env.recommended", "GO", "all present");
  }
}

/* ── 2. Database reachability + schema ─────────────────────────────── */
async function checkDatabase() {
  if (!process.env.DATABASE_URL) {
    record("db.reachable", "FAIL", "DATABASE_URL unset");
    return;
  }
  const url = process.env.DATABASE_URL;
  const isLocal = /(localhost|127\.0\.0\.1)/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8_000,
  });
  try {
    const t0 = Date.now();
    await pool.query("select 1");
    const latency = Date.now() - t0;
    record("db.reachable", "GO", `${latency}ms`);

    const { rows } = await pool.query(
      "select count(*)::int as c from information_schema.tables where table_schema='public'",
    );
    const tables = rows[0].c;
    if (tables < 20) {
      record(
        "db.schema",
        "FAIL",
        `only ${tables} public tables — run \`npx drizzle-kit push\` before launch`,
      );
    } else {
      record("db.schema", "GO", `${tables} tables`);
    }

    // Confirm the four critical tables exist.
    const { rows: crit } = await pool.query(
      `select table_name from information_schema.tables
       where table_schema='public'
         and table_name in ('categories','manufacturers','products','settings')`,
    );
    if (crit.length !== 4) {
      const found = crit.map((r) => r.table_name);
      const missing = ["categories", "manufacturers", "products", "settings"].filter(
        (t) => !found.includes(t),
      );
      record("db.schema.critical", "FAIL", `missing tables: ${missing.join(", ")}`);
    } else {
      record("db.schema.critical", "GO", "categories,manufacturers,products,settings present");
    }
  } catch (e) {
    record("db.reachable", "FAIL", e.message);
  } finally {
    await pool.end();
  }
}

/* ── 3. Supabase Storage service_role key ─────────────────────────── */
async function checkSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    record("supabase.storage", "FAIL", "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY unset");
    return;
  }
  // Decode JWT payload — validate role claim, do not print the token.
  try {
    const [, payloadB64] = key.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    if (payload.role !== "service_role") {
      record(
        "supabase.jwt",
        "FAIL",
        `JWT has no role:service_role claim (found role=${payload.role ?? "<absent>"}). ` +
          `Get the correct key from Supabase Dashboard → Project Settings → API → service_role`,
      );
    } else {
      record("supabase.jwt", "GO", "role=service_role");
    }
  } catch (e) {
    record("supabase.jwt", "FAIL", `cannot decode JWT: ${e.message}`);
  }

  // Live request: list buckets. This proves signature works.
  try {
    const res = await fetch(`${url}/storage/v1/bucket`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      record(
        "supabase.storage",
        "FAIL",
        `HTTP ${res.status} — ${body.slice(0, 120)}`,
      );
      return;
    }
    const buckets = await res.json();
    const names = Array.isArray(buckets) ? buckets.map((b) => b.name) : [];
    const required = ["products", "wa-sessions"];
    const missing = required.filter((n) => !names.includes(n));
    if (missing.length) {
      record(
        "supabase.storage",
        "WARN",
        `buckets present: [${names.join(", ")}]; still needed: [${missing.join(", ")}] — first worker boot creates them automatically`,
      );
    } else {
      record("supabase.storage", "GO", `buckets: ${names.join(", ")}`);
    }
  } catch (e) {
    record("supabase.storage", "FAIL", e.message);
  }
}

/* ── 4. Telegram bots ─────────────────────────────────────────────── */
async function checkTelegram() {
  for (const [label, token, chatEnv] of [
    ["admin", process.env.TELEGRAM_ADMIN_BOT_TOKEN, "TELEGRAM_ADMIN_CHAT_ID"],
    ["dev", process.env.TELEGRAM_DEV_BOT_TOKEN, "TELEGRAM_DEV_CHAT_ID"],
  ]) {
    if (!token) {
      record(`telegram.${label}.bot`, "FAIL", "token unset");
      continue;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(8_000),
      });
      const body = await res.json();
      if (!body.ok) {
        record(`telegram.${label}.bot`, "FAIL", body.description || `HTTP ${res.status}`);
        continue;
      }
      record(`telegram.${label}.bot`, "GO", `@${body.result.username}`);
    } catch (e) {
      record(`telegram.${label}.bot`, "FAIL", e.message);
    }
    if (!process.env[chatEnv]) {
      record(`telegram.${label}.chat`, "FAIL", `${chatEnv} unset — bot will refuse everything`);
    } else {
      record(`telegram.${label}.chat`, "GO", `${chatEnv} configured`);
    }
  }
}

/* ── 5. WhatsApp worker reachability ──────────────────────────────── */
async function checkWorker() {
  if (SKIP.has("worker")) {
    record("worker.reachable", "SKIP", "--skip=worker");
    return;
  }
  const base = (process.env.WA_WORKER_URL || "").replace(/\/$/, "");
  if (!base) {
    record(
      "worker.reachable",
      "FAIL",
      "WA_WORKER_URL unset — deploy worker via `fly deploy` in worker/ first, then set WA_WORKER_URL",
    );
    return;
  }
  if (base.startsWith("http://localhost") || base.startsWith("http://127.")) {
    record(
      "worker.reachable",
      "WARN",
      "WA_WORKER_URL points at localhost — Vercel cannot reach that from production",
    );
  }
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      record("worker.reachable", "FAIL", `HTTP ${res.status} ${body.slice(0, 120)}`);
      return;
    }
    const body = await res.json();
    if (body.status === "connected") {
      record("worker.reachable", "GO", `connected, processed=${body.processed ?? 0}`);
    } else {
      record(
        "worker.reachable",
        "WARN",
        `worker up but connectionState=${body.status} — /qr from Telegram admin`,
      );
    }
  } catch (e) {
    record("worker.reachable", "FAIL", e.message);
  }
}

/* ── 6. Site URL sanity ───────────────────────────────────────────── */
function checkSiteUrl() {
  const url = process.env.NEXT_PUBLIC_SITE_URL || "";
  if (!/^https?:\/\//.test(url)) {
    record("site.url", "FAIL", `NEXT_PUBLIC_SITE_URL is not a full URL: '${url}'`);
    return;
  }
  if (url.startsWith("http://") && !/localhost|127\./.test(url)) {
    record("site.url", "WARN", "NEXT_PUBLIC_SITE_URL is http:// on a non-local host");
    return;
  }
  record("site.url", "GO", url);
}

/* ── report ───────────────────────────────────────────────────────── */
function print() {
  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log(bold("\n  MatzHub preflight"));
  console.log(dim("  ────────────────────────────────────────────────\n"));
  const wide = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const tag =
      r.status === "GO"
        ? green("✓ GO  ")
        : r.status === "WARN"
        ? yellow("! WARN")
        : r.status === "SKIP"
        ? dim("○ SKIP")
        : red("✗ FAIL");
    console.log(`  ${tag}  ${r.name.padEnd(wide)}  ${dim(r.detail)}`);
  }
  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  console.log();
  if (fails) {
    console.log(red(bold(`  ✗ NOT READY — ${fails} FAIL${fails > 1 ? "s" : ""}, ${warns} warning${warns === 1 ? "" : "s"}`)));
    console.log(dim("  Fix the FAILs above. WARNs are acceptable at launch but should be resolved.\n"));
    process.exit(1);
  }
  if (warns) {
    console.log(yellow(bold(`  ! GO WITH WARNINGS — 0 FAIL, ${warns} warning${warns === 1 ? "" : "s"}`)));
    console.log(dim("  Safe to launch. Review the warnings when convenient.\n"));
    process.exit(0);
  }
  console.log(green(bold("  ✓ GO — all checks passed")));
  console.log();
  process.exit(0);
}

/* ── run ──────────────────────────────────────────────────────────── */
checkEnv();
checkSiteUrl();
await checkDatabase();
await checkSupabase();
await checkTelegram();
await checkWorker();
print();
