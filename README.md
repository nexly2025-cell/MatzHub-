# MatzHub

Automation engine with a premium catalogue.

Suppliers post product photos and videos to dedicated WhatsApp groups. The platform
reads them, dedupes, extracts category-specific attributes, prices by rule, quality-
gates, and publishes — usually without a human touching anything.

## Clean-clone launch

```bash
git clone <this-repo>
cd matzhub
npm install
npm run setup        # everything below, automatically:
                        # node version check
                        # install packages (skips if present)
                        # create .env if missing
                        # DATABASE_URL validation
                        # Postgres reachable-if-fail fast + docker compose fallback
                        # drizzle-kit push: every migration applied
                        # seed catalogue if empty
                        # storage + worker probe with meaningful hints
npm run build
npm start
```

Then run the WhatsApp worker whenever you want real ingestion:

```bash
bash launch.sh worker      # scan the QR once, or set WA_PAIRING_NUMBER
```

See OPS.md for everything operational.

## Required to boot in dev

| Variable | Purpose | Required? | Default in .env.example |
|---|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | **Yes** | `postgresql://postgres:postgres@127.0.0.1:5432/app_db` |
| `ADMIN_PASSWORD` | Gates `/admin` | **Yes (production)** | `change-me-now` |
| `ADMIN_SESSION_SECRET` | Signs Edge session cookies | **Yes (production)** | `replace-with-64-hex-chars` |
| `INGEST_TOKEN` | Auths the worker webhook | **Yes (production)** | empty |
| `CRON_SECRET` | Auths cron triggers | **Yes (production)** | empty |
| `NEXT_PUBLIC_SITE_URL` | Canonical host in metadata/OG/sitemaps | **Yes** | `http://localhost:3000` |
| `NEXT_PUBLIC_CUSTOMER_WHATSAPP` | Floating WhatsApp number | **Yes** | `9187412133` |

## Optional but unlocks parts of the product

| Variable | Unlocks | Missing = |
|---|---|---|
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Image hosting for the worker, WhatsApp session restoration | images can't upload; ingestion pauses |
| `SUPPLIER_INGESTION_NUMBER` | Read-only ingestion SIM identity | worker can't attach to correct group |
| `OPENAI_API_KEY` | LLM-enriched product copy | rules-engine enrichment (works, lower quality) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_DEV_CHAT_ID` + `TELEGRAM_ADMIN_CHAT_ID` | Order + failure alerts in two inboxes | ops sees tasks in the dashboard only |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` | COD fraud protection at checkout | no bot check |
| `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` | Official outbound messaging instead of worker | Baileys worker handles it |
| `UPTIME_WEBHOOK_URL` | Automation failure escalation | silent only if you don't watch admin |

## The two people

- **Developer** hears: automation failures, cron misses, worker version alerts,
  transport outages, security alerts.
- **Admin** hears: new orders, risky orders, moderation needs, supplier health,
  daily digests.

Both are configured by two chat IDs, one shared bot token:
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_DEV_CHAT_ID`, `TELEGRAM_ADMIN_CHAT_ID`.

## WhatsApp

Two link methods: QR (default) prints to terminal + `.wa-session/whatsapp-qr.png`,
or pairing code via `WA_PAIRING_NUMBER=91XXXXXXXXXX` for environments where QR fails.

The ingestion SIM is read-only. It never sends messages, never shows up in UI.
The customer number is a separate account serving orders on `wa.me`.

## Full operations: see OPS.md

Telegram alert routing · WhatsApp linking · self-host deploy (docker, no Vercel
requirement) · backup/restore · cron schedule · every required environment variable
and what happens without it.

## Stack

Next.js App Router · TypeScript · Tailwind (tokenised 6-theme light system) ·
Drizzle ORM · PostgreSQL (trigram search) · Baileys worker · ffmpeg/sharp media
engine · Supabase Storage (image + session) · optional OpenAI enrichment.

## Layout (one line each)

```
src/app/          pages + admin + api routes (ingest, orders, crons, search)
src/components/   ProductCard · BuyBox · ProductGallery (image+video) · Filters · Price
src/db/schema.ts  catalog, orders, automation, analytics, settings tables
src/lib/          ai.ts (extraction+pricing) · ingest.ts · reconcile.ts · privacy.ts · notify.ts
src/worker/       whatsapp-worker.mjs · media-engine.mjs · session-store.mjs · update-check.mjs
```

## Tests

```bash
npm test        # 21/21
```
