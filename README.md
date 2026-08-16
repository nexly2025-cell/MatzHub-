# MatzHub

Automation engine with a premium catalogue.

Suppliers post product photos and videos to dedicated WhatsApp groups. The
platform reads them, dedupes, extracts category-specific attributes, prices
by rule, quality-gates, and publishes — usually without a human touching
anything.

## Architecture

```
GitHub  ──►  Vercel  ──►  Next.js app + API + Vercel Cron
                │
                ├──►  Supabase (Postgres + Storage)
<<<<<<< HEAD
                └──►  WhatsApp worker (persistent Node/Baileys, hosted on AWS EC2 or Fly.io)
=======
                └──►  WhatsApp worker (persistent Node/Baileys, hosted on EC2)
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)

Cloudflare  = DNS / TLS for matzhub.com
Telegram    = admin + dev bots → Vercel webhooks → worker control
```

Nothing in production runs on a laptop, Codespace, or `docker compose up`.
Full deployment: `DEPLOYMENT.md`. Day-to-day: `OPS.md`.

## Local dev — clean clone

```bash
git clone <this-repo>
cd matzhub
npm install
cp .env.example .env       # fill in DATABASE_URL and ADMIN_PASSWORD at minimum
npm run setup              # migrations, seed, probes
npm run dev                # hot reload on :3000
npm test                   # vitest
```

Optional: run the WhatsApp worker locally in a second terminal (for testing
<<<<<<< HEAD
ingestion — production runs the same file on AWS EC2 or Fly.io):
=======
ingestion — production runs the same file on EC2):
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)

```bash
cd worker && npm install && node whatsapp-worker.mjs
```

## Required environment variables

Full list with commentary is in `.env.example`. The minimum to boot the app
locally:

| Variable                        | Purpose                                     |
| ------------------------------- | ------------------------------------------- |
| `DATABASE_URL`                  | PostgreSQL connection string                |
| `ADMIN_PASSWORD`                | Gates `/admin` (production: also required)  |
| `NEXT_PUBLIC_SITE_URL`          | Canonical host used in metadata / sitemaps  |
| `NEXT_PUBLIC_CUSTOMER_WHATSAPP` | Floating WhatsApp support number            |

For production add: `DIRECT_DATABASE_URL`, `ADMIN_SESSION_SECRET`,
`INGEST_TOKEN`, `CRON_SECRET`, `TELEGRAM_*`, `SUPABASE_*`, `WA_WORKER_URL`,
`WA_WORKER_TOKEN`. Optional integrations (Cashfree, OpenAI, OTP providers)
are listed with their unlock effect in `.env.example`.

## Two Telegram inboxes

- **Developer** (`TELEGRAM_DEV_CHAT_ID`, `TELEGRAM_DEV_BOT_TOKEN`): automation
  failures, cron misses, worker version alerts, transport outages, security
  alerts.
- **Admin** (`TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_ADMIN_BOT_TOKEN`): new
  orders, risky orders, moderation needs, supplier health, daily digests.

Role is decided by the webhook URL, not the sender.

## WhatsApp

Baileys speaks the WhatsApp multi-device protocol over a persistent
WebSocket. It cannot run on Vercel / Cloudflare Workers / GitHub Actions
cron — the process would be torn down between requests. The worker runs on a
<<<<<<< HEAD
persistent Node host (AWS EC2 or Fly.io in the canonical setups).
=======
persistent Node host (EC2 in the canonical setup).
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)

Two link methods: QR (default, retrievable via Telegram `/qr` or from the
worker's mounted `/data/.wa-session/whatsapp-qr.png`), or pairing code via
`WA_PAIRING_NUMBER=91XXXXXXXXXX`.

The session persists in Supabase Storage (`wa-sessions/primary/*`). Redeploys
do not require rescanning. The ingestion SIM is read-only — it never sends
messages, never appears in UI. Customer support runs on a separate account
via `wa.me`.

## Stack

Next.js App Router · TypeScript · Tailwind · Drizzle ORM · Supabase Postgres
(trigram search) · Baileys worker · ffmpeg/sharp media engine · Supabase
Storage · optional OpenAI enrichment.

## Layout

```
src/app/           pages + admin + API routes (ingest, cron, telegram, health)
src/components/    ProductCard · BuyBox · ProductGallery · Filters
src/db/schema.ts   catalog, orders, automation, analytics, settings tables
src/lib/           ai.ts · ingest.ts · reconcile.ts · privacy.ts · notify.ts · telegram.ts
worker/            whatsapp-worker.mjs · media-engine.mjs · session-store.mjs
scripts/           setup.mjs · provision.mjs · backup.sh · restore.sh
.github/workflows/ ci.yml · deploy.yml · backup.yml · secret-scan.yml
```

## Tests

```bash
npm test
```
