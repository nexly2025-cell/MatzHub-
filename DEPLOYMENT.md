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

**What is not part of the architecture:** DigitalOcean droplets,
Railway, Render, a developer laptop, a Codespace, `docker compose up`, or any
"just run `node whatsapp-worker.mjs` locally" story. If you see instructions
pointing at any of those in older README revisions, ignore them.

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

- `WA_WORKER_URL` — the public URL of the worker (e.g. `https://matzhub-worker.fly.dev`)
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

The only production-appropriate hosts are ones that give you a long-lived, persistent Node runtime with storage that survives process restarts. **Pick one** (do not run two):

- **AWS EC2 (Recommended VM)** — Perfect for running the worker 24/7. An Amazon Linux / Ubuntu `t2.micro` or `t3.micro` instance (free tier) is exceptionally robust. You can run the worker directly under `pm2` (with auto-restart and system boot recovery) or via Docker.
- **Fly.io (Recommended Serverless Container)** — Small free tier, Mumbai region (`bom`), ~$0-2/mo. The `worker/Dockerfile` targets this shape (exposes 8081, mounts `/data`, healthchecks `/health`).
- Render, Northflank, Koyeb, or other persistent VM / Docker container providers.

### Deploy to AWS EC2 (VM Example)

EC2 provides a highly resilient, isolated virtual machine. By setting up the worker under **Docker** with restart policies, or under **PM2**, the worker automatically restarts if it crashes, and automatically recovers when the EC2 instance is rebooted.

#### Option A: Docker on the VM — `./deploy-worker.sh` (canonical)

This is the supported path for an EC2 / GCE e2-micro class box. One command
pulls, builds, replaces the container, health-checks it, and rolls back on
failure. **It never touches the session volume**, so a deploy does not force a
new QR scan.

1. **Launch the instance**
   - Ubuntu 22.04 LTS or Amazon Linux 2023, 2 vCPU / 1 GB is enough.
   - Security group: SSH `22` only. The worker binds to `127.0.0.1:8081`;
     expose it publicly only behind a reverse proxy with TLS.

2. **One-time setup**
   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io git
   sudo systemctl enable --now docker
   sudo usermod -aG docker "$USER" && newgrp docker

   git clone https://github.com/nexly2025-cell/MatzHub-.git
   cd MatzHub-/worker
   cp .env.example .env && ${EDITOR:-nano} .env   # fill in the tokens
   chmod 600 .env                                 # secrets stay off the CLI
   chmod +x deploy-worker.sh
   ```

3. **Every deploy after that**
   ```bash
   cd ~/MatzHub-/worker && ./deploy-worker.sh
   ```

   The script:
   - `git pull --ff-only` on the current branch
   - builds `matzhub-worker:candidate`
   - stops the old container with SIGTERM (its shutdown hook uploads the
     Baileys session to Supabase Storage first)
   - starts the new one with `--restart unless-stopped`, the `wa-session`
     named volume mounted at `/data`, and a 700 MB memory cap
   - polls `/health` for up to 180 s and reports `connected` or `awaiting_qr`
   - restores the previous image if the new one never comes up

> **Never run `docker volume rm wa-session`.** That volume *is* the WhatsApp
> pairing. Deleting it is the only thing in normal operations that forces a
> re-scan. `deploy-worker.sh` prunes dangling *images* only.

Manual equivalent, if you need to run it by hand — note `--env-file`, so no
secret ever lands in shell history:

```bash
docker build -t matzhub-worker:current ~/MatzHub-/worker
docker run -d --name matzhub-worker --restart unless-stopped \
  --env-file ~/MatzHub-/worker/.env \
  -e WA_SESSION_DIR=/data/.wa-session -e WA_WORKER_PORT=8081 \
  -v wa-session:/data -p 127.0.0.1:8081:8081 \
  --memory 700m --log-opt max-size=10m --log-opt max-file=3 \
  matzhub-worker:current
```

#### Option B: Running with PM2 directly on EC2 (No Docker Required)

1. **Install Node.js & PM2:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo npm install -y -g pm2
   ```

2. **Clone the Repo & Configure:**
   ```bash
   git clone https://github.com/nexly2025-cell/MatzHub-.git
   cd MatzHub-/worker
   npm install --omit=dev
   cp .env.example .env
   # Edit .env with your production credentials
   nano .env
   ```

3. **Start with PM2 & Configure System Recovery:**
   Using PM2 guarantees the worker restarts instantly on crash, and system startup hook restores it on VM reboot.
   ```bash
   pm2 start whatsapp-worker.mjs --name "matzhub-worker"
   
   # Generate system startup configuration to survive VM reboots:
   pm2 startup
   # (Copy-paste the command printed by PM2 to enable the service)
   
   # Save the current process list so it recovers on boot:
   pm2 save
   ```

4. **Verify Health:**
   ```bash
   curl http://localhost:8081/health
   ```

### Deploy to Fly.io (canonical example)

```bash
cd worker
fly launch --no-deploy --name matzhub-worker --region <region>
fly volumes create wa_session --size 1 --region <region>
# Mount the volume at /data and expose 8081 (fly.toml example below).
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

Minimum `fly.toml`:

```toml
app = "matzhub-worker"
primary_region = "<region>"

[build]
  dockerfile = "Dockerfile"

[env]
  WA_SESSION_DIR = "/data/.wa-session"
  WA_WORKER_PORT = "8081"

[mounts]
  source      = "wa_session"
  destination = "/data"

[[services]]
  internal_port = 8081
  protocol      = "tcp"

  [[services.ports]]
    port     = 443
    handlers = ["tls", "http"]
  [[services.ports]]
    port     = 80
    handlers = ["http"]

  [services.http_checks]
    interval = "30s"
    method   = "GET"
    path     = "/health"
    timeout  = "5s"
```

After deploy, set on Vercel:

- `WA_WORKER_URL=https://matzhub-worker.fly.dev`
- `WA_WORKER_TOKEN=<same value as the worker>`

Then in Telegram (admin bot): `/worker` shows connection state, `/qr` returns
the pairing code only if the session is invalid, `/relink` forces a fresh
pairing.

### Pairing (once per WhatsApp number)

The very first boot has no session in `wa-sessions/`, so the worker emits a QR.
Options:

1. Fly SSH: `fly ssh console -C 'cat /data/.wa-session/whatsapp-qr.png' > qr.png`
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
  Fly.io (or equivalent); Supabase holds all state; Cloudflare + Vercel serve
  the edge. Turning off your laptop changes nothing in production.
- **No docker-compose in production.** Compose is dev-only convenience and is
  not shipped in this repo.
- **No `WA_RUN_MS` / scheduled worker.** The worker is a long-running process,
  not a cron job. That misfeature was removed together with the GitHub Actions
  workflow that used it.
