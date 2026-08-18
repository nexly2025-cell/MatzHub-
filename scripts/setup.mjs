#!/usr/bin/env node
/**
 * npm run setup
 * ------------
 * Everything a clean clone needs to become a running development environment.
 * Exact order: Node version → packages → env → Postgres → migrations → seed →
 * storage probe → complete diagnostics. Exits non-zero with a meaningful message
 * if anything required fails so CI and humans see the same signal.
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
process.chdir(root);

const ok = (s) => console.log(`  ✓ ${s}`);
const warn = (s) => console.log(`  ! ${s}`);
const fail = (s, code = 1) => {
  console.log(`  ✗ ${s}`);
  process.exit(code);
};

const banner = (t) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

banner("MatzHub setup");

/* 1. Node version */
const major = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isFinite(major) || major < 20) fail(`Node 20+ required, you have ${process.version}`);
ok(`Node ${process.version}`);

/* 2. Packages */
if (!fs.existsSync(path.join(root, "node_modules", ".package-lock.json")) && !fs.existsSync(path.join(root, "node_modules", "pg"))) {
  banner("Installing dependencies");
  spawnSync("npm", ["install", "--no-audit", "--no-fund"], { stdio: "inherit" });
  if (!fs.existsSync(path.join(root, "node_modules"))) fail("npm install produced no node_modules/");
} else {
  ok("node_modules present, skipping fresh install");
}

/* 3. Environment */
let envPath = path.join(root, ".env");
if (!fs.existsSync(envPath)) {
  const example = path.join(root, ".env.example");
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, envPath);
    warn("created .env from .env.example — fill in values");
  } else {
    fail(".env missing and .env.example missing. This repository is not launchable without one.");
  }
} else {
  ok(".env present");
}

if (!process.env.DATABASE_URL) {
  const local = path.join(root, ".env.local");
  const envFile = fs.readFileSync(envPath, "utf8");
  const match = envFile.match(/^DATABASE_URL=(.*)$/m);
  if (match) process.env.DATABASE_URL = match[1].trim();
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is required. Set it in .env or export it.");
}
ok("DATABASE_URL loaded");

/* 4. Postgres connectivity — fails fast with an actionable message */
banner("PostgreSQL");
async function reachPostgres(url) {
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    await pool.query("select 1");
    await pool.end();
    return true;
  } catch {
    return false;
  }
}

let okpg = await reachPostgres(process.env.DATABASE_URL);
if (!okpg) {
  fail(
    `DATABASE_URL is unreachable.\n        Point it at your managed PostgreSQL (Neon, Supabase or RDS), or start a local\n        instance and re-run. The platform no longer bundles a database container.`,
  );
}
ok("PostgreSQL reachable");

/* 5. Migrations — must run automatically for a clean clone */
banner("Migrations");
const pushResult = spawnSync("npx", ["drizzle-kit", "push", "--force"], { stdio: "inherit" });
if (pushResult.status !== 0) fail("drizzle-kit push failed. Check DATABASE_URL and your drizzle-config.");
ok("Schema applied");

/* 6. Seed — only if catalogue is empty, never duplicated */
banner("Seed");
try {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query("select count(*)::int as c from products");
  await pool.end();
  if (rows[0].c === 0) {
    warn("No categories — bootstrapping taxonomy (no products are created)");
    const result = spawnSync("npx", ["tsx", "-e", `import { bootstrapTaxonomy } from "./src/lib/seed.ts"; bootstrapTaxonomy().then(r => { console.log(r); process.exit(0); });`], {
      stdio: "inherit",
      shell: false,
    });
    if (result.status !== 0) fail("seed failed — see error above");
    ok("Seed complete");
  } else {
    ok(`Catalogue already populated (${rows[0].c} products), skipping`);
  }
} catch (e) {
  fail(`Seed probe failed: ${e instanceof Error ? e.message : String(e)}`);
}

/* 7. Storage probe — optional cloud member, meaningful bypass instructions */
banner("Storage");
const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!hasSupabase) {
  warn("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — image hosting disabled. Products that arrive through WhatsApp need image hosting, see .env.example.");
} else {
  ok("Supabase storage configured");
}

/* 8. WhatsApp worker env check */
banner("Ingestion worker");
const hasIngest = Boolean(process.env.INGEST_TOKEN && process.env.MATZHUB_API_URL);
if (!hasIngest) {
  warn("Ingestion worker not fully configured (INGEST_TOKEN, MATZHUB_API_URL). Add WA_GROUP_IDS after reading real JIDs from Telegram /channels for the strongest boundary.");
} else {
  ok("Worker env present");
}

/* 9. Final diagnostics */
banner("Next steps");
console.log(`
  Then:

    npm run build   # production build
    npm start       # runs on http://${new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").host.replace("localhost", "localhost")}

  What was done:

    ✓ Node ${process.version}
    ✓ Packages installed (if needed)
    ✓ .env created (if needed)
    ✓ PostgreSQL reachable
    ✓ drizzle-kit push: migrations applied
    ✓ catalog seed applied (if empty)
    ✓ storage probe
    ✓ worker env probe

  Optional, but recommended before live traffic:

    ADMIN_PASSWORD             — gates /admin
    SUPABASE_URL + SERVICE_KEY — image + session hosting
    OPENAI_API_KEY             — better product copy
    TELEGRAM_ADMIN_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID — operator control
    WA_WORKER_URL + WA_WORKER_TOKEN — WhatsApp ingestion live
`);
process.exit(0);
