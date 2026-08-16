# MatzHub — Operations

Day-to-day runbook. First-time deployment lives in `DEPLOYMENT.md`; this file
assumes production is already up.

Architecture in one sentence: **Vercel serves the app + APIs + cron, a
persistent Node worker (EC2, or any Docker host) holds the Baileys WhatsApp
socket, Supabase is the database and storage, Cloudflare is DNS/TLS at the
edge, Telegram is the operator control plane, and GitHub Actions handles CI +
nightly backups.**

Nothing in production depends on a laptop, Codespace, or `docker compose up`.

---

## Local development (only)

```bash
git clone <repo>
cd matzhub
npm install
cp .env.example .env       # fill in DATABASE_URL and ADMIN_PASSWORD at minimum
npm run setup              # migrations, seed, probes
npm run dev                # hot reload on :3000
npm test                   # vitest
```

If you want to exercise WhatsApp ingestion locally, run the worker in a second
terminal:

```bash
cd worker && npm install && node whatsapp-worker.mjs
```

That worker is for local testing only. Production runs the same file, on
on EC2, permanently. See `DEPLOYMENT.md` → "Deploy to EC2".

---

## Telegram alerts — who hears what

| Chat id                   | Receives                                                                                                | Purpose                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------- |
| `TELEGRAM_DEV_CHAT_ID`    | automation failures, cron misses, worker version alerts, transport outages, security alerts             | keep the platform healthy   |
| `TELEGRAM_ADMIN_CHAT_ID`  | new orders, risky orders, moderation additions, supplier health, daily digests, subscription notices    | run the business            |

Two independent bots (`TELEGRAM_ADMIN_BOT_TOKEN`, `TELEGRAM_DEV_BOT_TOKEN`),
each with its own webhook URL (`/api/telegram/webhook`, `.../dev`). Role is
decided by the webhook path, not the sender.

Alerts are anti-spammed: identical (template, recipient, payload) fires at
most once per 15 minutes.

---

## Telegram Operations Center

### Security

Two independent gates, both required:

1. `X-Telegram-Bot-Api-Secret-Token` header must equal `TELEGRAM_WEBHOOK_SECRET`
   (proves the caller is Telegram itself).
2. Sender chat id must be in `TELEGRAM_ADMIN_CHAT_ID` / `TELEGRAM_DEV_CHAT_ID`.
   No allowlist configured → the bot refuses everything (fail-closed).

The endpoint always returns HTTP 200; Telegram retries non-2xx aggressively,
and a retry storm from an unauthorised caller is worse than a silent drop.

### Admin commands

| Command              | Effect                                                          |
| -------------------- | --------------------------------------------------------------- |
| `/help`              | command list                                                    |
| `/whoami`            | prints your chat id                                             |
| `/health`            | DB reachability, catalogue counts, pause state                  |
| `/stats`             | products by status, order count, revenue                        |
| `/tasks`             | open items needing a human                                      |
| `/orders`            | five most recent orders                                         |
| `/panel`             | persistent control panel                                        |
| `/pause` / `/resume` | kill switch for all scheduled jobs                              |
| `/worker`            | worker connection state + counters                              |
| `/qr`                | pairing QR — only if the session is actually invalid            |
| `/relink`            | discard the session and force a fresh code                      |
| `/restart`           | ask the worker to reconnect (session is kept)                   |
| `/channels`          | groups the worker can currently see                             |

`/pause` writes `automation_paused=1` to `settings`; the cron runner returns
`{skipped:"automation_paused"}` and `self-heal` remains runnable so a paused
system can still be repaired.

### Developer commands

`/diag /jobs /run <job> /errors /worker /syncstatus /health /pause /resume
/upload on|off /maintenance /backfill`. None of these appear on the admin bot.

---

## WhatsApp session

The session is the one piece of state that cannot be regenerated
automatically. Two places hold it:

- **Container disk** at `/data/.wa-session` (mounted volume on the worker
  host) — used at runtime.
- **Supabase Storage** `wa-sessions/primary/*` — persistent, survives
  redeploys, restored automatically on boot when the local disk is empty.

Rules:

- The worker never mints a QR on its own. It restores the stored session
  first and only emits a code when Baileys reports no valid credentials.
- On a successful pair the QR is deleted from memory and disk and the session
  is pushed to Supabase.
- `/relink` is destructive: it wipes both local disk AND the Supabase copy.
  Without the remote wipe the "removed" account silently reconnects on the
  next boot.

Diagnosing "no QR ever appears": the session is valid and the worker is
already connected — check `/worker` output. Diagnosing "asks for a QR every
restart": `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are missing on the
worker so `session-store.mjs` cannot back up.

### WhatsApp history

WhatsApp pushes a device its message history exactly once, at link time. If
the worker was linked while history sync was off, that payload is gone and
the only recovery is re-pairing. The worker detects this automatically by
inspecting `creds.processedHistoryMessages` and enables `syncFullHistory` for
any session that has never received one.

Probe what the server actually sends without ingesting:

```bash
cd worker && node probe-history.mjs
```

Look for `history.set` batches. Zero batches with `neverSynced=true` means
the session must be re-paired via `/relink`.

---

## Cron schedule (canonical)

Configured in `vercel.json`. Vercel Cron hits each path with the platform's
own scheduler token; the endpoint additionally requires `Authorization:
Bearer $CRON_SECRET` (Vercel Cron injects it via the `CRON_SECRET` var). Do
not duplicate the schedule anywhere else.

```
*/2  * * * *  /api/cron/notify
*/5  * * * *  /api/cron/telegram-sweep
*/10 * * * *  /api/cron/self-heal
*/15 * * * *  /api/cron/watchdog
*/30 * * * *  /api/cron/trending
0    * * * *  /api/cron/expire
15   * * * *  /api/cron/price-alerts
30   * * * *  /api/cron/cart-recovery
45   * * * *  /api/cron/notify-retry
30 20 * * *   /api/cron/supplier
30  2 * * *   /api/cron/digest
0   9 * * *   /api/cron/subscription
0   4 * * *   /api/cron/storage-sweep
```

Manually run a job:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  https://matzhub.com/api/cron/<job>
```

Every job records a row in `automation_runs`; `/api/cron/watchdog` alerts if
any critical job misses its SLA.

---

## Health / readiness / liveness / monitoring

| Endpoint            | Purpose                                            | Auth?    |
| ------------------- | -------------------------------------------------- | -------- |
| `/api/liveness`     | Is the process alive? No DB query.                 | none     |
| `/api/readiness`    | Can it serve traffic? Pings DB.                    | none     |
| `/api/health`       | Human-facing health, published product count.      | none     |
| `/api/monitoring`   | Machine-readable status for external monitors.     | none     |
| Worker `/health`    | Baileys connection state + queue counters.         | none     |

There is exactly one implementation of each. Do not add duplicates.

External monitor recommendation: poll `/api/monitoring` on the platform and
`$WA_WORKER_URL/health` on the worker every minute.

---

## Ingestion path

```
WhatsApp group  →  worker (Baileys)  →  POST /api/ingest  →  ingestBatch()  →
  Supabase (image upload) + Postgres (product row) → publication/review state
```

`/api/ingest`:

- **POST only.** GET returns 405 (Next.js default) — this is correct, do not
  add a GET stub.
- Authenticated with `INGEST_TOKEN`. Fails-closed: unset token → 401 in
  production.
- Idempotent by `messageId`.
- Enforces `SUPPLIER_INGESTION_NUMBER` isolation when set.
- Returns 503 in maintenance mode (worker retries later; nothing is lost).

---

## Backup / restore

Nightly logical backup runs on GitHub Actions
(`.github/workflows/backup.yml`, 03:00 UTC), retained 30 days. Requires the
`DATABASE_URL` repository secret; fails loudly if the dump is missing
`categories`, `manufacturers`, `settings` or `products`.

Ad-hoc:

```bash
./scripts/backup.sh                                       # uncompressed
./scripts/restore.sh backups/matzhub_db_<ts>.sql.gz       # .sql or .sql.gz
```

Restore prompts for confirmation because the dump is `--clean --if-exists`
and drops every object first.

---

## Subscription (Cashfree)

Operator billing. Gates exactly one thing: whether newly ingested products
publish automatically. Customers never see subscription state. Expiry never
touches published products.

Webhook: `POST https://matzhub.com/api/payments/cashfree/webhook`.
Signature: `base64(HMAC-SHA256(x-webhook-timestamp + rawBody, secret))`
verified against the raw bytes. Unsigned / misconfigured callers → 401.

Renewals stack from the later of now and the current expiry, idempotent per
`order_id`. Daily `subscription` cron reconciles against the Cashfree order
API as a backstop for a webhook that never arrived, notifying the admin at
most once per day.

Check state any time with `/payment` in the admin bot.

---

## Recovery procedures

**Worker process is down** (`/worker` shows unreachable):
- SSH to the instance: `sudo docker ps -a` to see container state.
- Restart: `sudo docker restart matzhub-worker`.
- Container removed? Re-run the `docker run` command from `DEPLOYMENT.md`.
- The session persists on the mounted volume AND in Supabase Storage, so a
  fresh container restores it without a QR.

**Worker running, connection state = "close" / "connecting" forever:**
- `/relink` from Telegram admin → fresh QR → re-pair.

**Vercel deploy failing:**
- Check `.github/workflows/deploy.yml` output.
- Rollback: `vercel rollback` or promote a previous deployment.

**Database unreachable:**
- `/api/readiness` returns 503. Check Supabase project status.
- Restore from the newest artifact in the Actions run of `backup.yml`.

**Ingestion queue backing up:**
- `/api/monitoring` `ingestStaleMinutes` climbing.
- Check worker `/health` for `connectionState`. If closed, `/relink`.
- `self-heal` cron re-runs stuck messages every 10 min automatically.
