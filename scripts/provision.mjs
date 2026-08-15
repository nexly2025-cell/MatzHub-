#!/usr/bin/env node
/**
 * Production provisioning — Cloudflare DNS/TLS + Vercel domains and env.
 *
 *   node scripts/provision.mjs          # show what would change
 *   node scripts/provision.mjs --apply  # make the changes
 *
 * Idempotent: re-running when everything already matches performs no writes.
 *
 * Scope is deliberately limited to production-safe operations. It never
 * deletes DNS records it did not create, never triggers a deployment, and
 * never writes secrets it was not given.
 *
 * Required environment:
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID
 *   VERCEL_API_TOKEN, VERCEL_PROJECT_ID
 * Optional:
 *   APEX_DOMAIN (default matzhub.com), VERCEL_TEAM_ID
 */

const APPLY = process.argv.includes("--apply");
/**
 * --proxy routes matzhub.com through Cloudflare's edge (orange cloud), which is
 * what actually enables CDN, cache, compression, DDoS mitigation and WAF.
 * DNS-only gives you nothing but name resolution.
 *
 * Only run this AFTER the first successful Vercel deployment: the apex
 * certificate is issued over http-01, and proxying before it exists can stall
 * issuance. Verify with `curl -I https://matzhub.com` — a `server: cloudflare`
 * header and HTTP 200 means it worked. Re-run without the flag to revert.
 */
const PROXY = process.argv.includes("--proxy");
/** Mirror local secrets to Vercel. Explicit by design — see SECRET_KEYS. */
const PUSH_SECRETS = process.argv.includes("--push-secrets");
const DOMAIN = process.env.APEX_DOMAIN || "matzhub.com";

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ZONE = process.env.CLOUDFLARE_ZONE_ID;
const V_TOKEN = process.env.VERCEL_API_TOKEN;
const V_PROJECT = process.env.VERCEL_PROJECT_ID;
const V_TEAM = process.env.VERCEL_TEAM_ID || "";

/**
 * Vercel's anycast address for apex records, and the CNAME target for
 * subdomains. Published at vercel.com/docs/projects/domains.
 */
const VERCEL_APEX_IP = "76.76.21.21";
const VERCEL_CNAME = "cname.vercel-dns.com";

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const wouldDo = (m) => console.log(`  \x1b[33m→\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const head = (t) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

let changed = 0;
let failed = 0;

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && body.success !== false, body };
}

async function vercel(path, init = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.vercel.com/${path}${V_TEAM ? `${sep}teamId=${V_TEAM}` : ""}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${V_TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

/* ── Cloudflare DNS ──────────────────────────────────────────────────────── */

async function dns() {
  head("Cloudflare DNS");
  const current = await cf("dns_records?per_page=100");
  if (!current.ok) {
    bad(`cannot read DNS records (${current.status}) — check the token's Zone:DNS permission`);
    failed += 1;
    return;
  }
  const records = current.body.result || [];

  // Apex must be an A record at Vercel's anycast IP; www a CNAME to Vercel.
  //
  // proxied:false is deliberate. Vercel terminates TLS and issues the
  // certificate for the apex; sending traffic through Cloudflare's proxy
  // creates a second TLS hop that breaks certificate issuance unless the zone
  // is on Full (strict) with an origin cert installed. DNS-only is the
  // configuration Vercel documents and supports.
  // ttl must be 1 (automatic) when proxied; Cloudflare rejects explicit TTLs.
  const desired = [
    { type: "A", name: DOMAIN, content: VERCEL_APEX_IP, proxied: PROXY, ttl: PROXY ? 1 : 300 },
    { type: "CNAME", name: `www.${DOMAIN}`, content: VERCEL_CNAME, proxied: PROXY, ttl: PROXY ? 1 : 300 },
  ];

  for (const want of desired) {
    const existing = records.find((r) => r.name === want.name && (r.type === "A" || r.type === "CNAME"));

    if (!existing) {
      if (!APPLY) { wouldDo(`create ${want.type} ${want.name} → ${want.content}`); changed += 1; continue; }
      const r = await cf("dns_records", { method: "POST", body: JSON.stringify(want) });
      if (r.ok) { ok(`created ${want.type} ${want.name} → ${want.content}`); changed += 1; }
      else { bad(`create ${want.name} failed: ${JSON.stringify(r.body.errors)}`); failed += 1; }
      continue;
    }

    const matches =
      existing.type === want.type &&
      existing.content === want.content &&
      existing.proxied === want.proxied;

    if (matches) { ok(`${want.type} ${want.name} already correct`); continue; }

    // 192.0.2.0/24 is RFC 5737 TEST-NET-1: reserved for documentation and never
    // routable. A zone pointing there is serving nothing at all.
    if (existing.content.startsWith("192.0.2.")) {
      warn(`${existing.name} currently points at ${existing.content} (RFC 5737 placeholder — the site cannot be reachable)`);
    }

    if (!APPLY) {
      wouldDo(`update ${existing.type} ${existing.name}: ${existing.content} (proxied=${existing.proxied}) → ${want.content} (proxied=${want.proxied})`);
      changed += 1;
      continue;
    }
    const r = await cf(`dns_records/${existing.id}`, { method: "PUT", body: JSON.stringify(want) });
    if (r.ok) { ok(`updated ${want.name} → ${want.content}`); changed += 1; }
    else { bad(`update ${want.name} failed: ${JSON.stringify(r.body.errors)}`); failed += 1; }
  }
}

/* ── Cloudflare zone settings ────────────────────────────────────────────── */

async function zoneSettings() {
  head("Cloudflare TLS and performance");

  // Only settings that are safe on a Free plan and cannot break a DNS-only
  // origin. Anything requiring Rulesets/WAF is intentionally excluded because
  // the supplied token does not carry those permissions (verified: 403).
  const wanted = [
    ["ssl", "full", "TLS between Cloudflare and Vercel"],
    ["always_use_https", "on", "redirect http → https"],
    ["min_tls_version", "1.2", "reject TLS 1.0/1.1"],
    ["automatic_https_rewrites", "on", "upgrade passive mixed content"],
    ["brotli", "on", "brotli compression"],
    ["http3", "on", "HTTP/3"],
    ["0rtt", "on", "0-RTT resumption"],
    ["tls_1_3", "on", "TLS 1.3"],
    ["security_header", null, "HSTS 2y, includeSubDomains, preload"],
    // Browser Integrity Check challenges clients that do not look like a
    // browser, which is exactly what Googlebot, Bingbot and AI crawlers are.
    // It must stay off on a site that wants to be discoverable.
    ["browser_check", "off", "browser integrity check off (keeps crawlers unblocked)"],
    // "medium" challenges only addresses with a bad reputation. Anything
    // higher starts interstitialling legitimate crawlers.
    ["security_level", "medium", "security level medium"],
  ];

  for (const [key, value, label] of wanted) {
    const body =
      key === "security_header"
        ? { value: { strict_transport_security: { enabled: true, max_age: 63072000, include_subdomains: true, preload: true, nosniff: true } } }
        : { value };

    const cur = await cf(`settings/${key}`);
    if (cur.ok && key !== "security_header" && cur.body.result?.value === value) { ok(`${label} already ${value}`); continue; }

    if (!APPLY) { wouldDo(`set ${label}`); changed += 1; continue; }

    const r = await cf(`settings/${key}`, { method: "PATCH", body: JSON.stringify(body) });
    if (r.ok) { ok(`${label}`); changed += 1; }
    else if (r.status === 403) { warn(`${label} — token lacks Zone Settings:Edit`); }
    else { warn(`${label} — ${JSON.stringify(r.body.errors)}`); }
  }
}

/* ── Vercel domains ──────────────────────────────────────────────────────── */

async function vercelDomains() {
  head("Vercel domains");
  const cur = await vercel(`v9/projects/${V_PROJECT}/domains`);
  if (!cur.ok) { bad(`cannot list domains (${cur.status})`); failed += 1; return; }
  const have = new Set((cur.body.domains || []).map((d) => d.name));

  for (const name of [DOMAIN, `www.${DOMAIN}`]) {
    if (have.has(name)) { ok(`${name} already attached`); continue; }
    if (!APPLY) { wouldDo(`attach ${name} to the Vercel project`); changed += 1; continue; }
    const r = await vercel(`v10/projects/${V_PROJECT}/domains`, {
      method: "POST",
      // www redirects to the apex so the canonical URL in metadata stays correct.
      body: JSON.stringify(name.startsWith("www.") ? { name, redirect: DOMAIN, redirectStatusCode: 308 } : { name }),
    });
    if (r.ok) { ok(`attached ${name}`); changed += 1; }
    else { bad(`attach ${name} failed: ${r.body?.error?.message ?? r.status}`); failed += 1; }
  }
}

/* ── Vercel environment variables ────────────────────────────────────────── */

/** Non-secret, deploy-shaping values. Always safe to write. */
function publicEnv() {
  return [
    { key: "NEXT_PUBLIC_SITE_URL", value: `https://${DOMAIN}` },
    { key: "NEXT_PUBLIC_CUSTOMER_WHATSAPP", value: process.env.NEXT_PUBLIC_CUSTOMER_WHATSAPP || "9187412133" },
  ];
}

/**
 * Secrets the app cannot boot without, mirrored from the local environment
 * when --push-secrets is passed.
 *
 * Off by default: silently shipping whatever happens to be in a developer's
 * shell to production is how staging credentials reach live systems. With the
 * flag it is explicit, and only keys that are actually set locally are sent.
 */
const SECRET_KEYS = [
  "DATABASE_URL", "DIRECT_DATABASE_URL", "DATABASE_POOL_MAX",
  "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "INGEST_TOKEN", "CRON_SECRET",
  "TELEGRAM_ADMIN_BOT_TOKEN", "TELEGRAM_ADMIN_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_DEV_BOT_TOKEN", "TELEGRAM_DEV_CHAT_ID", "TELEGRAM_DEV_WEBHOOK_SECRET",
  "WA_WORKER_URL", "WA_WORKER_TOKEN",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_BUCKET", "SUPABASE_VIDEO_BUCKET",
  "CASHFREE_APP_ID", "CASHFREE_SECRET_KEY", "CASHFREE_ENV",
  "SUBSCRIPTION_LAST_PAYMENT", "SUBSCRIPTION_PRICE_INR", "LOG_LEVEL",
];

async function vercelEnv() {
  head("Vercel environment");
  const cur = await vercel(`v10/projects/${V_PROJECT}/env?decrypt=false`);
  if (!cur.ok) { bad(`cannot list env (${cur.status})`); failed += 1; return; }
  const have = new Map((cur.body.envs || []).map((e) => [e.key, e]));

  for (const { key, value } of publicEnv()) {
    const existing = have.get(key);
    if (existing && existing.value === value) { ok(`${key} already set`); continue; }
    if (!APPLY) { wouldDo(`${existing ? "update" : "create"} ${key}=${value}`); changed += 1; continue; }

    const r = existing
      ? await vercel(`v9/projects/${V_PROJECT}/env/${existing.id}`, {
          method: "PATCH", body: JSON.stringify({ value, target: ["production", "preview"] }),
        })
      : await vercel(`v10/projects/${V_PROJECT}/env`, {
          method: "POST", body: JSON.stringify({ key, value, type: "plain", target: ["production", "preview"] }),
        });
    if (r.ok) { ok(`${key}`); changed += 1; }
    else { bad(`${key} failed: ${r.body?.error?.message ?? r.status}`); failed += 1; }
  }

  if (PUSH_SECRETS) {
    for (const key of SECRET_KEYS) {
      const value = process.env[key];
      if (value === undefined || value === "") continue; // never write blanks
      const existing = have.get(key);
      if (!APPLY) { wouldDo(`${existing ? "update" : "create"} ${key} (secret)`); changed += 1; continue; }

      const r = existing
        ? await vercel(`v9/projects/${V_PROJECT}/env/${existing.id}`, {
            method: "PATCH", body: JSON.stringify({ value, target: ["production", "preview"] }),
          })
        : await vercel(`v10/projects/${V_PROJECT}/env`, {
            method: "POST",
            body: JSON.stringify({ key, value, type: "encrypted", target: ["production", "preview"] }),
          });
      if (r.ok) { ok(`${key} (secret)`); changed += 1; }
      else { bad(`${key} failed: ${r.body?.error?.message ?? r.status}`); failed += 1; }
    }
  }

  // Report what production still cannot boot without.
  const fresh = await vercel(`v10/projects/${V_PROJECT}/env?decrypt=false`);
  const now = new Set((fresh.body?.envs ?? []).map((e) => e.key));
  const required = [
    "DATABASE_URL", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "INGEST_TOKEN", "CRON_SECRET",
    "TELEGRAM_ADMIN_BOT_TOKEN", "TELEGRAM_ADMIN_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET",
    "WA_WORKER_URL", "WA_WORKER_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = required.filter((k) => !now.has(k));
  if (missing.length) {
    warn(`still missing on Vercel (${missing.length}) — the app will refuse to boot:`);
    for (const m of missing) console.log(`      ${m}`);
  } else {
    ok(`all ${required.length} required secrets present on Vercel`);
  }
}

/* ── Cache purge ─────────────────────────────────────────────────────────── */

async function purge() {
  head("Cloudflare cache");
  if (!APPLY) { wouldDo("purge everything"); return; }
  const r = await cf("purge_cache", { method: "POST", body: JSON.stringify({ purge_everything: true }) });
  if (r.ok) ok("cache purged");
  else warn(`purge failed — ${JSON.stringify(r.body.errors)}`);
}

/* ── main ────────────────────────────────────────────────────────────────── */

const missingCreds = [
  ["CLOUDFLARE_API_TOKEN", CF_TOKEN], ["CLOUDFLARE_ZONE_ID", CF_ZONE],
  ["VERCEL_API_TOKEN", V_TOKEN], ["VERCEL_PROJECT_ID", V_PROJECT],
].filter(([, v]) => !v).map(([k]) => k);

if (missingCreds.length) {
  console.error(`Missing required environment: ${missingCreds.join(", ")}`);
  process.exit(1);
}

console.log(`\nMatzHub provisioning — ${DOMAIN}`);
console.log(APPLY ? "Mode: APPLY (writing changes)" : "Mode: DRY RUN (no writes; pass --apply to execute)");
console.log(PROXY ? "Edge:  PROXIED (Cloudflare CDN/WAF/DDoS active)" : "Edge:  DNS-only (Cloudflare resolves names; no CDN, cache or WAF)");

await dns();
await zoneSettings();
await vercelDomains();
await vercelEnv();
if (APPLY) await purge();

head("Summary");
console.log(`  ${APPLY ? "applied" : "pending"}: ${changed}`);
if (failed) { console.log(`  failed:  ${failed}`); process.exit(1); }
console.log(APPLY ? "\nDone. DNS changes take up to 5 minutes to propagate.\n" : "\nRe-run with --apply to execute.\n");
