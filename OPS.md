# Operations

Everything you need to run, deploy, back up and recover. One file. Nothing else.

## Run it (first time — clean clone)

```bash
git clone <repo>
cd <repo>
npm install
npm run setup      # everything: node, packages, env, postgres, migrations, seed, probes
npm start          # dev, hot reload
# or:
npm run build
npm start          # production
bash launch.sh worker        # whatsapp worker (QR once, or pairing code)
bash launch.sh doctor        # diagnostics
bash docker-compose up -d    # self-host, full stack including postgres
```

If Postgres isn't running, `launch.sh` detects it in ≤20s and either starts the bundled one
with `docker compose up -d db` or tells you exactly what to set.

## Telegram alerts — two people, two inboxes

| Who | Gets | Why |
|---|---|---|
| `TELEGRAM_DEV_CHAT_ID` (you, developer) | automation failures, cron misses, worker version alerts, transport outages, security alerts | fix the platform |
| `TELEGRAM_ADMIN_CHAT_ID` (admin) | new orders, risky orders, moderation additions, supplier health, daily digests | run the business |

One bot token shared; override per-audience per-token optional:

```
TELEGRAM_BOT_TOKEN=…
TELEGRAM_DEV_CHAT_ID=…
TELEGRAM_ADMIN_CHAT_ID=…
# optional split: TELEGRAM_DEV_BOT_TOKEN=…, TELEGRAM_ADMIN_BOT_TOKEN=…
```

Alerts are anti-spammed: identical template+recipient+payload fires at most once per 15 minutes.

## Telegram Operations Center

Inbound command bot. Webhook-based, so it costs nothing idle and needs no
long-running process.

### Setup

```bash
# 1. Create the bot with @BotFather, then:
TELEGRAM_ADMIN_BOT_TOKEN=<token>
TELEGRAM_ADMIN_CHAT_ID=<your numeric chat id>   # send /whoami to find it
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24)

# 2. Point Telegram at the deployment (once per URL change):
curl -X POST "https://api.telegram.org/bot$TELEGRAM_ADMIN_BOT_TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://matzhub.com/api/telegram/webhook",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET"'",
       "allowed_updates":["message","callback_query"]}'
```

### Developer bot

Telegram allows one webhook per bot and an update never says which bot received
it, so each bot needs its own URL. Role is decided by the path, not the sender —
a developer messaging the dev bot from any allowlisted account gets developer
commands.

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_DEV_BOT_TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://matzhub.com/api/telegram/webhook/dev",
       "secret_token":"'"$TELEGRAM_DEV_WEBHOOK_SECRET"'",
       "allowed_updates":["message","callback_query"]}'
```

| Route | Bot | Token | Allowlist |
|---|---|---|---|
| `/api/telegram/webhook` | admin | `TELEGRAM_ADMIN_BOT_TOKEN` | `TELEGRAM_ADMIN_CHAT_ID` |
| `/api/telegram/webhook/dev` | developer | `TELEGRAM_DEV_BOT_TOKEN` | `TELEGRAM_DEV_CHAT_ID` |

Dev commands: `/diag` `/jobs` `/run <job>` `/errors` `/worker` `/syncstatus`
`/health` `/pause` `/resume` `/upload on|off` `/maintenance` `/backfill`.
None of them appear on the admin bot.

### Security

Two independent gates, both required:

1. `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` —
   proves the request came from Telegram, not the open internet.
2. The sender's chat id must be in `TELEGRAM_ADMIN_CHAT_ID` /
   `TELEGRAM_DEV_CHAT_ID`. With neither set the bot refuses everything.

The endpoint always answers HTTP 200; Telegram retries non-2xx aggressively and
a retry storm from an unauthorised caller is worse than a silent drop.

### Commands

| Command | Effect |
|---|---|
| `/help` | command list |
| `/whoami` | prints your chat id |
| `/health` | database reachability, catalogue counts, pause state |
| `/stats` | products by status, order count and revenue |
| `/tasks` | open items needing a human |
| `/orders` | five most recent orders |
| `/jobs` | every runnable job with its last run |
| `/run <job>` | run one job now (rejects unknown names) |
| `/heal` | shortcut for `/run self-heal` |
| `/pause` `/resume` | kill switch for all scheduled jobs |
| `/worker` | worker connection state and counters |
| `/qr` | pairing QR — only if the session is actually invalid |
| `/relink` | discard the session and force a fresh code |
| `/groups` | groups the worker can currently see |

`/pause` writes `automation_paused=1` to `settings`; the cron runner checks it
and returns `{skipped:"automation_paused"}`. `self-heal` stays runnable so a
paused system can still be repaired.

### WhatsApp pairing

The worker never mints a QR on its own. It restores the stored session first
and only emits a code when Baileys reports no valid credentials. On successful
pair the QR is deleted from memory and disk and the session is pushed to
Supabase, so restarts do not re-prompt.

```
/qr        -> "Already paired" if the session is valid, otherwise a scannable image
/relink    -> clears the session (requires WA_WORKER_TOKEN on both sides)
```

## WhatsApp linking

Two ways to register the ingestion SIM, whichever works:

1. **QR** (default): run worker, scan the terminal QR or `.wa-session/whatsapp-qr.png`.
2. **Pairing code** (if QR breaks in your environment): set `WA_PAIRING_NUMBER=91XXXXXXXXXX`
   in the worker env; the worker prints an 8-digit code to enter in
   WhatsApp → Linked Devices → Link with phone number.

Session persists to `./.wa-session` and re-uploads to Supabase (`wa-sessions` bucket) so
a container restart doesn't rescan.

## Deploy — no Vercel needed

The canonical self-host path is Docker:

```bash
docker compose up -d            # platform + postgres + worker
docker compose up -d db         # postgres only, if you keep app separate
```

Provide `.env` with real `DATABASE_URL` (if your compose DB is externally hosted),
`ADMIN_PASSWORD`, `INGEST_TOKEN`, `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`, `SUPABASE_URL`, and
`SUPABASE_SERVICE_ROLE_KEY`. That is the entire required set for a functioning
**browsing + ingestion-first** deployment.

`vercel.json` exists only as a convenience for people who already use Vercel. It is not
part of the required path.

## Provisioning (Cloudflare + Vercel)

One idempotent script configures DNS, TLS and the Vercel project. Dry run by
default; nothing is written without `--apply`.

```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=...
export VERCEL_API_TOKEN=...    VERCEL_PROJECT_ID=... VERCEL_TEAM_ID=...
npm run provision          # show the diff
npm run provision:apply    # execute
```

It sets the apex A record to Vercel's anycast IP and `www` to
`cname.vercel-dns.com`, both **DNS-only**. Proxying the apex is deliberately
avoided: Vercel terminates TLS and issues the certificate, and a second TLS hop
through Cloudflare's proxy breaks issuance unless the zone runs Full (strict)
with an origin certificate installed.

TLS settings applied: Full, Always Use HTTPS, minimum TLS 1.2, TLS 1.3, 0-RTT,
Brotli, HTTP/3, automatic HTTPS rewrites, and HSTS (2 years, includeSubDomains,
preload). WAF and Ruleset changes are out of scope — they need permissions the
deploy token does not carry, and silently failing security config is worse than
none.

Secrets are never written by the script. It lists which ones are still missing
from the Vercel project so they can be added in the dashboard.

## Subscription (Cashfree)

Operator billing. It gates exactly one thing: whether newly ingested products
publish automatically.

- Customers never see subscription state — no banner, no API field, nothing.
- An expired subscription never removes, hides or de-lists published products.
- Only future automatic uploads pause; the admin is told over Telegram.

```
CASHFREE_APP_ID=        CASHFREE_SECRET_KEY=        CASHFREE_ENV=sandbox|production
Webhook URL: https://matzhub.com/api/payments/cashfree/webhook
```

Signature is `base64(HMAC-SHA256(x-webhook-timestamp + rawBody, secret))`,
verified against the raw bytes. Unsigned or misconfigured callers get 401 —
without `CASHFREE_SECRET_KEY` the endpoint rejects everything rather than
granting free access.

Renewals stack from the later of now and the current expiry, and are idempotent
per `order_id` so Cashfree's retries cannot grant 30 days each. The daily
`subscription` cron reconciles against the Cashfree order API as a backstop for
a webhook that never arrived, then notifies the admin at most once per day.

Check state any time with `/payment` in the admin bot.

## Diagnosing a WhatsApp history problem

WhatsApp pushes a device its message history exactly once, at link time. If the
worker was linked while history sync was off, that payload is gone and the only
recovery is re-pairing. The worker now detects this automatically: it inspects
`creds.processedHistoryMessages` and enables `syncFullHistory` for any session
that has never received one.

To confirm what the server actually sends:

```bash
cd worker && node probe-history.mjs      # read-only, ingests nothing
```

Look for `history.set` batches. Zero batches with `neverSynced=true` means the
session must be re-paired via the admin bot (WhatsApp → Attach new account).

## Backup / restore

A nightly logical backup runs on GitHub Actions (`.github/workflows/backup.yml`,
03:00 UTC) and is kept as a 30-day artifact. It runs there rather than on a
Vercel cron because functions cannot execute `pg_dump`, and the architecture has
no VPS. It requires the `DATABASE_URL` repository secret and fails loudly if the
dump is missing `categories`, `manufacturers`, `settings` or `products` — a dump
that lost the configuration would be worse than none, since restoring it would
overwrite a working setup with an empty one.

One dump covers everything: channel mappings, categories, settings, the
subscription anchor, suppliers and products.

```bash
./scripts/backup.sh                                    # manual, uncompressed
./scripts/restore.sh backups/matzhub_db_<ts>.sql.gz    # accepts .sql or .sql.gz
```

Restore prompts for confirmation before running, because the dump is
`--clean --if-exists` and replaces every object. Backups are never committed.

## Cron schedule (when deployment isn't Vercel)

Any scheduler hitting these URLs with `?secret=$CRON_SECRET`:

```
*/2 * * * *  /api/cron/notify
*/10 * * * * /api/cron/self-heal
*/15 * * * * /api/cron/watchdog
*/30 * * * * /api/cron/trending
0 * * * *    /api/cron/expire
15 * * * *   /api/cron/price-alerts
30 * * * *   /api/cron/cart-recovery
45 * * * *   /api/cron/notify-retry
30 20 * * *  /api/cron/supplier
30 2 * * *   /api/cron/digest
```

Or `docker compose exec platform curl http://localhost:3000/api/cron/<job>?secret=...`.
