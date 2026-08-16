# MatzHub — Production Deployment

This is the **only** production deployment path. `OPS.md` covers day-to-day
operations; this file is the initial rollout.

## Architecture at a glance

```
GitHub  ──►  Vercel  ──►  Next.js app + API + Vercel Cron
                │
                ├──►  Supabase Postgres  (data of record)
                ├──►  Supabase Storage   (images, videos, WA session backup)
                └──►  WhatsApp worker    (persistent Node/Baileys process,
                                          hosted separately — see below)

Cloudflare  ──►  DNS + TLS at the edge for matzhub.com
Telegram    ──►  admin + dev bots  →  Vercel webhooks  →  worker control
```

| Component            | Runs on                          | Why                                                 |
| -------------------- | -------------------------------- | --------------------------------------------------- |
| Storefront + API     | Vercel                           | Serverless is a good fit, edge-cached, zero-ops.    |
| Cron jobs            | Vercel Cron → `/api/cron/[job]`  | One config in `vercel.json`; scoped by CRON_SECRET. |
| Database             | Supabase Postgres                | Managed, pooled, has backups + PITR.                |
| Object storage       | Supabase Storage                 | `products`, `product-media`, `wa-sessions` buckets. |
| WhatsApp worker      | **Persistent Node host**         | Baileys keeps a live WebSocket — see below.         |
| Telegram control     | Vercel `/api/telegram/webhook*`  | Webhook-driven, no long-running process.            |
| DNS / TLS            | Cloudflare (DNS-only apex)       | Vercel terminates TLS; do NOT proxy the apex.       |
| CI + backups         | GitHub Actions                   | Typecheck, lint, tests, build, nightly `pg_dump`.   |

**What is not part of the architecture:** DigitalOcean droplets, Railway,
Render, a developer laptop, a Codespace, `docker compose up`, or any
"just run `node whatsapp-worker.mjs` locally" story. If you see instructions
pointing at any of those in older README revisions, ignore them.

**EC2 runs ONE thing:** the persistent WhatsApp worker described in section 4.
It never runs the Next.js app, never runs cron, and never runs Postgres —
those are Vercel and Supabase workloads. The worker is a single Docker
container (`worker/Dockerfile`) with its session directory mounted on a
persistent EBS volume.

---

## 1. Vercel — Next.js app + API + Cron

The whole `src/` tree deploys as one Next.js project. `vercel.json` declares
every cron path; there is no other scheduler.

### Environment variables

Set these in **Vercel → Settings → Environment Variables** (Production). All
names are documented in `.env.example`.

Required:

- `DATABASE_URL`, `DIRECT_DATABASE_URL`, `DATABASE_POOL_MAX`
- `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_CUSTOMER_WHATSAPP`
- `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`
- `INGEST_TOKEN`, `CRON_SECRET`
- `TELEGRAM_ADMIN_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_DEV_BOT_TOKEN`, `TELEGRAM_DEV_CHAT_ID` (dev webhook secret falls back)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`

Required once the worker is deployed:

- `WA_WORKER_URL` — the public URL of the worker (e.g. `http://<EC2-IP>:8081`)
- `WA_WORKER_TOKEN` — must equal `WA_WORKER_TOKEN` on the worker side

Optional (see `.env.example` for the full list and their effect if unset):
`CASHFREE_*`, `OPENAI_API_KEY`, `UPTIME_WEBHOOK_URL`, `SUPPLIER_INGESTION_NUMBER`.

Generate every secret with `openssl rand -hex 32`.

### Deploy

```bash
git push origin main          # GitHub Actions runs CI + deploys via Vercel
# or, one-off:
npx vercel deploy --prod
```

### Verify

```bash
curl -fsS https://matzhub.com/api/health      # 200, "status":"ok"
curl -fsS https://matzhub.com/api/readiness   # 200, "status":"ready"
curl -fsS https://matzhub.com/api/monitoring  # 200 or 503 (with reason)
curl -fsS https://matzhub.com/api/liveness    # 200, "status":"alive"
```

---

## 2. Supabase — database + storage

1. Create a project. Copy the Session-pooler URL into `DIRECT_DATABASE_URL`
   (port 5432) and the Transaction-pooler URL into `DATABASE_URL` (port 6543).
2. Apply the schema from the repo root:

   ```bash
   npx drizzle-kit push
   ```

   `drizzle.config.ts` uses `DIRECT_DATABASE_URL` because DDL requires
   session-mode. The app runtime uses transaction-mode.
3. Storage buckets (`products`, `product-media`, `wa-sessions`) are created
   automatically on first worker boot by `worker/ensure-supabase-buckets.mjs`.
   Nothing to do manually.

Backups run nightly via GitHub Actions (`.github/workflows/backup.yml`) using
the `DATABASE_URL` repo secret. Retention: 30 days as workflow artifacts.

---

## 3. Cloudflare — DNS + edge

Cloudflare is the domain / DNS / edge layer only. It does NOT host the app.

Provisioning is scripted and idempotent:

```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=...
export VERCEL_API_TOKEN=...     VERCEL_PROJECT_ID=... VERCEL_TEAM_ID=...
npm run provision          # dry run — show the diff
npm run provision:apply    # execute
```

What the script sets:

- Apex A record → Vercel's anycast IP (`76.76.21.21`), DNS-only.
- `www` CNAME → `cname.vercel-dns.com`, DNS-only.
- TLS: Full, Always Use HTTPS, min TLS 1.2, TLS 1.3, HSTS.

**Do NOT enable the orange-cloud proxy on the apex before Vercel issues the
certificate** — the http-01 challenge stalls. Once TLS is live you can turn it
on with `npm run provision:apply -- --proxy` for CDN + WAF.

---

## 4. WhatsApp worker — persistent Node process

Baileys speaks the WhatsApp multi-device protocol over a persistent WebSocket.
It **cannot** run on Vercel, Cloudflare Workers, or GitHub Actions cron — those
runtimes tear the process down and the session is lost. That is a WhatsApp
protocol constraint, not a MatzHub design choice.

The only production-appropriate hosts are ones that give you a long-lived Node
container with mounted storage. **Pick one** (do not run two):

- **AWS EC2 — canonical.** One t2.micro (free tier) or t3.micro. The
  `worker/Dockerfile` already targets this shape (exposes 8081, mounts
  `/data`, healthchecks `/health`). Docker + systemd restarts the container
  automatically on reboot or crash; the EBS volume survives both.
- Fly.io (alternative) — `worker/fly.toml` is provided; `auto_stop_machines`
  must stay `false` so Baileys never sleeps.
- Any other host that runs a Docker image and gives you a persistent volume.

### Deploy to EC2 (canonical)

1. Launch an instance (Amazon Linux 2023 or Ubuntu 22.04+), t2.micro/t3.micro,
   20–30 GB gp3 root volume. Add a second 5 GB gp3 volume mounted at
   `/var/lib/matzhub-worker` (or use a Docker named volume — EBS survives
   instance reboots, a named volume survives container restarts but not
   instance replacement; EBS is the stronger guarantee).
2. Security group: open **TCP 8081 only to your own IP** (Telegram never
   calls the worker directly — the Vercel app and your admin commands do).
   Do NOT expose 8081 to 0.0.0.0/0.
3. Install Docker:
   ```bash
   sudo dnf install -y docker && sudo systemctl enable --now docker
   ```
4. Build and run:
   ```bash
   cd worker
   sudo docker build -t matzhub-worker .
   sudo docker run -d --name matzhub-worker \
     --restart unless-stopped \
     -v matzhub-wa-data:/data \
     -p 8081:8081 \
     --env-file .env \
     matzhub-worker
   ```
   `.env` on the server holds the same variables as `worker/.env.example`,
   filled with real values: `MATZHUB_API_URL`, `INGEST_TOKEN`,
   `WA_WORKER_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_BUCKET`, `SUPABASE_VIDEO_BUCKET`, plus optional
   `TELEGRAM_ADMIN_BOT_TOKEN`/`TELEGRAM_ADMIN_CHAT_ID` (worker crash
   escalation), `SUPPLIER_INGESTION_NUMBER`, `WA_GROUPS`, `WA_PAIRING_NUMBER`.
5. Restart/recovery safety — verified behaviour of this image:
   - `--restart unless-stopped`: container comes back after reboot or crash.
   - The session lives on the mounted volume at `/data/.wa-session` AND is
     backed up to Supabase Storage (`wa-sessions/primary/*`) on every
     successful connect and on SIGTERM. If the instance itself is replaced,
     a fresh container restores the session from Supabase on boot — no QR.
   - SIGTERM handler uploads the session before exit; the container then
     restarts cleanly. No QR is minted unless the stored session is invalid.
   - Verify after any restart:
     ```bash
     curl -fsS http://localhost:8081/health   # 200 + "status":"connected"
     ```
6. Zero-downtime redeploys of the worker image:
   ```bash
   sudo docker pull ... # or rebuild
   sudo docker stop matzhub-worker && sudo docker rm matzhub-worker
   sudo docker run -d --name matzhub-worker ... (same command as step 4)
   ```
   Session survives because the volume and the Supabase backup are untouched.

### Alternative: Fly.io

```bash
cd worker
fly launch --no-deploy --name matzhub-worker --region <region>
fly volumes create wa_session --size 1 --region <region>
fly secrets set \
  MATZHUB_API_URL=https://matzhub.com \
  INGEST_TOKEN=<same as Vercel> \
  WA_WORKER_TOKEN=<same as Vercel> \
  SUPABASE_URL=<...> \
  SUPABASE_SERVICE_ROLE_KEY=<...> \
  SUPABASE_BUCKET=products \
  SUPABASE_VIDEO_BUCKET=product-media \
  SUPPLIER_INGESTION_NUMBER=<optional>
fly deploy
```

The checked-in `worker/fly.toml` has `auto_stop_machines = false` and
`min_machines_running = 1` — required so Baileys keeps its socket.

After deploy, set on Vercel:

- `WA_WORKER_URL=http://<EC2-INSTANCE-IP>:8081` (or your domain once TLS is set up)
- `WA_WORKER_TOKEN=<same value as the worker>`

Then in Telegram (admin bot): `/worker` shows connection state, `/qr` returns
the pairing code only if the session is invalid, `/relink` forces a fresh
pairing.

### Pairing (once per WhatsApp number)

The very first boot has no session in `wa-sessions/`, so the worker emits a QR.
Options:

1. SSH: `ssh ec2-user@<INSTANCE-IP> 'sudo cat /var/lib/docker/volumes/matzhub-wa-data/_data/.wa-session/whatsapp-qr.png' > qr.png`
   (or `sudo docker cp matzhub-worker:/data/.wa-session/whatsapp-qr.png ./qr.png`)
2. Telegram: `/qr` returns the same PNG.
3. Pairing code: set `WA_PAIRING_NUMBER=91XXXXXXXXXX`; the worker prints an
   8-digit code to enter under WhatsApp → Linked Devices → Link with phone.

Once paired, the session backs itself up to Supabase Storage
(`wa-sessions/primary/*`). Every subsequent redeploy restores from there — no
QR unless the operator explicitly runs `/relink`.

---

## 5. Telegram webhooks

Point each bot at its own webhook exactly once (per URL change):

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_ADMIN_BOT_TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://matzhub.com/api/telegram/webhook",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET"'",
       "allowed_updates":["message","callback_query"]}'

curl -X POST "https://api.telegram.org/bot$TELEGRAM_DEV_BOT_TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://matzhub.com/api/telegram/webhook/dev",
       "secret_token":"'"${TELEGRAM_DEV_WEBHOOK_SECRET:-$TELEGRAM_WEBHOOK_SECRET}"'",
       "allowed_updates":["message","callback_query"]}'
```

---

## 6. Post-deploy smoke test

Run each of these once after the first live deploy. All should succeed:

1. `curl -fsS https://matzhub.com/api/health` → 200.
2. `curl -fsS https://matzhub.com/api/readiness` → 200.
3. `curl -fsS $WA_WORKER_URL/health` → 200, `connectionState:"open"`.
4. Telegram admin bot → `/health` → all green.
5. Telegram admin bot → `/worker` → shows session as connected, no QR.
6. Post a test message in a mapped supplier group → arrives in
   `/admin/moderation` within a minute.
7. Trigger a cron manually:
   `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://matzhub.com/api/cron/notify`
   → `{"ok":true,...}`.

If any of these fail, `OPS.md` → "Diagnosing" covers each one.

---

## What is NOT required

- **No local machine 24/7.** The Vercel app is stateless; the worker runs on
  EC2 (or Fly.io); Supabase holds all state; Cloudflare + Vercel serve
  the edge. Turning off your laptop changes nothing in production.
- **No docker-compose in production.** Compose is dev-only convenience and is
  not shipped in this repo.
- **No `WA_RUN_MS` / scheduled worker.** The worker is a long-running process,
  not a cron job. That misfeature was removed together with the GitHub Actions
  workflow that used it.
