# MatzHub — Real-World Launch

Exact sequence, in order. No fluff. Every step is either a command you run
locally, a click in a specific dashboard, or a one-off human action. Nothing
in here is theatre.

`DEPLOYMENT.md` explains why the architecture is what it is.
`OPS.md` covers day-to-day operation.
**This file is only for the first go-live.**

---

## Prerequisites (one-time)

- Node 20+ installed locally
- A Supabase project (you already have one)
- A Vercel account with the GitHub App connected to your repo
<<<<<<< HEAD
- A Fly.io account (`brew install flyctl` / `curl -L https://fly.io/install.sh | sh`, then `fly auth login`)
=======
- An AWS account with a key pair (the SSH key from your machine)
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
- A Cloudflare account with `matzhub.com` zone (only for the final DNS step)
- Two Telegram bots created via @BotFather (you already have them)

---

## STEP 1 — Fix the Supabase service_role key (2 min)

The single remaining blocker from the audit.

1. Open Supabase Dashboard → your project → **Project Settings** → **API**.
2. Under **Project API Keys**, find the row labelled `service_role` `secret`.
3. Copy the value. It is a long JWT starting with `eyJ…`.
4. Verify it is the right one by decoding the middle segment — the payload
   MUST contain `"role":"service_role"`. If it doesn't, you copied the wrong
   row.
5. Put it in your local `.env` as `SUPABASE_SERVICE_ROLE_KEY=…`.

Sanity check:

```bash
node -e "const p=process.env.SUPABASE_SERVICE_ROLE_KEY.split('.')[1];console.log(JSON.parse(Buffer.from(p,'base64').toString()))"
# Must print: { iss: 'supabase', ref: '...', role: 'service_role', iat: ..., exp: ... }
```

Anything without `role:service_role` fails silently against Supabase Storage
and PostgREST. Do not skip this.

---

## STEP 2 — Set a real ADMIN_PASSWORD (30 s)

```bash
# From the repo root:
NEWPW=$(openssl rand -base64 24)
echo "ADMIN_PASSWORD=$NEWPW"     # save this in your password manager
sed -i.bak "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$NEWPW|" .env
rm .env.bak
```

Store it. This is how you log into `/admin/login` in production.

---

## STEP 3 — Push the schema to Supabase (30 s)

Only needed on a fresh Supabase project.

```bash
npx drizzle-kit push --force
```

If it prints `Changes applied` you're done. Preflight in Step 5 verifies.

---

## STEP 4 — Local validation (30 s)

```bash
npm ci
npm run lint
npm test
npm run build
```

All four must succeed. Test suite is 102 tests. Build must succeed against
the same DATABASE_URL you'll use in production, because a couple of routes
prerender against real data.

---

## STEP 5 — Preflight (10 s)

```bash
npm run preflight -- --skip=worker
```

Must print `✓ GO — all checks passed` (WARNs on optional services like
Cashfree/OpenAI are fine). Any `✗ FAIL` is a real blocker; fix it before
continuing.

Worker is skipped here because it isn't deployed yet — Step 7 covers it.

---

## STEP 6 — Deploy Next.js to Vercel

**Push to GitHub first:**

```bash
git add -A
git commit -m "prod: launch-ready"
git push origin main
```

**In the Vercel dashboard:**

1. Import the GitHub repo (`nexly2025-cell/MatzHub-`).
2. Framework preset: Next.js (auto-detected).
3. Under **Environment Variables**, paste every non-empty line from your
   local `.env` EXCEPT the four listed below. Scope: Production.
   - Skip `WA_WORKER_URL` (set in Step 8, after the worker is deployed)
   - Skip `DATABASE_POOL_MAX` if you left it at 4 (that's the default)
   - Skip anything with an empty value
4. Click **Deploy**.
5. Wait for the build. Confirm live:

   ```bash
   curl -fsS https://<your-vercel-domain>/api/health
   curl -fsS https://<your-vercel-domain>/api/readiness
   curl -fsS https://<your-vercel-domain>/api/monitoring
   ```

   All three must return HTTP 200.

---

<<<<<<< HEAD
## STEP 7 — Deploy the WhatsApp worker to AWS EC2 or Fly.io

The worker is the ONLY component that needs a persistent host. This step handles that. You can choose AWS EC2 (Highly recommended VM, free-tier eligible) or Fly.io.

### Option A: Deploy to AWS EC2 (VM with Auto-Recovery)

Setting up the worker directly on an Ubuntu/Amazon Linux EC2 instance ensures 100% reliability, zero-latency connections if hosted close to your DB, and robust auto-recovery across crashes or host reboots using PM2.

1. **Provision an EC2 Instance:**
   - Launch a `t2.micro` or `t3.micro` instance in AWS Console (Free Tier eligible).
   - In Security Groups, open Inbound Port `8081` (Custom TCP) to allow Vercel to reach it, and port `22` (SSH) for setup.

2. **SSH to your Instance & Install Node.js + PM2:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo npm install -g pm2
   ```

3. **Deploy the Worker:**
   ```bash
   git clone https://github.com/nexly2025-cell/MatzHub-.git
   cd MatzHub-/worker
   npm install --omit=dev
   
   # Create and fill the production .env file
   cp .env.example .env
   nano .env
   # Set MATZHUB_API_URL, INGEST_TOKEN, WA_WORKER_TOKEN, SUPABASE_URL, etc.
   ```

4. **Start and Enable Safe Reboot Recovery:**
   Using PM2 startup script ensures that if the EC2 VM reboots, the worker automatically restarts and recovers:
   ```bash
   pm2 start whatsapp-worker.mjs --name "matzhub-worker"
   
   # Enable system boot integration
   pm2 startup
   # (Copy and execute the output command printed by the terminal)
   
   # Save the process state for startup recovery
   pm2 save
   ```

5. **Verify Running State:**
   ```bash
   curl http://localhost:8081/health
   # Expected: {"status":"awaiting_qr",...} (ready for pairing)
   ```

---

### Option B: Deploy to Fly.io (Container with Volume)

If you prefer containerized deployment on Fly.io:

```bash
cd worker

# 7a. One-time app + volume creation
fly auth login
fly launch --no-deploy --name matzhub-worker --region bom --copy-config=false
fly volumes create wa_session --size 1 --region bom --yes

# 7b. Push every secret it needs (values come from your local .env)
set -a; . ../.env; set +a
fly secrets set \
  MATZHUB_API_URL="https://<your-vercel-domain>" \
  INGEST_TOKEN="$INGEST_TOKEN" \
  WA_WORKER_TOKEN="$WA_WORKER_TOKEN" \
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  SUPABASE_BUCKET="$SUPABASE_BUCKET" \
  SUPABASE_VIDEO_BUCKET="${SUPABASE_VIDEO_BUCKET:-product-media}"
# Only if you have one:
# fly secrets set SUPPLIER_INGESTION_NUMBER="$SUPPLIER_INGESTION_NUMBER"

# 7c. Deploy
fly deploy

# 7d. Confirm
fly status
curl -fsS https://matzhub-worker.fly.dev/health
=======
## STEP 7 — Deploy the WhatsApp worker to EC2

The worker is the ONLY component that needs a persistent host, and EC2 is
the canonical one. The Next.js app, cron and Postgres never run here — only
the single Docker container from `worker/Dockerfile`.

```bash
# 7a. AWS Console: launch an instance
#     - AMI: Amazon Linux 2023 (or Ubuntu 22.04+)
#     - Type: t2.micro (free tier) or t3.micro
#     - Storage: 20 GB gp3 root + 5 GB gp3 at /dev/sdb
#     - Security group: allow SSH (your IP only) + TCP 8081 (your IP only).
#       Never open 8081 to 0.0.0.0/0 — the worker is reached via
#       WA_WORKER_URL from Vercel and your Telegram admin, not by the public.
#     - Key pair: the one from your local machine (your SSH key).

# 7b. SSH in and prepare the volume + Docker
sudo mkfs -t xfs /dev/sdb
sudo mkdir -p /var/lib/matzhub-worker
sudo mount /dev/sdb /var/lib/matzhub-worker
echo "/dev/sdb /var/lib/matzhub-worker xfs defaults,nofail 0 2" | sudo tee -a /etc/fstab
sudo dnf install -y docker
sudo systemctl enable --now docker

# 7c. Ship the code + env to the instance (from your laptop, repo root)
scp -r worker ec2-user@<INSTANCE-IP>:/home/ec2-user/
scp .env ec2-user@<INSTANCE-IP>:/home/ec2-user/worker/.env   # same values as Vercel

# 7d. Build + run (on the instance)
cd worker
sudo docker build -t matzhub-worker .
sudo docker run -d --name matzhub-worker \
  --restart unless-stopped \
  -v matzhub-wa-data:/data \
  -p 8081:8081 \
  --env-file .env \
  matzhub-worker

# 7e. Confirm
curl -fsS http://localhost:8081/health
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
# Expect: 503 with status:"awaiting_qr" or status:"starting" on first boot
#         200 with status:"connected" after Step 9
```

<<<<<<< HEAD
**Region:** `bom` = Mumbai. If you're not in India, pick your nearest region
from `fly platform regions`. Latency to Supabase's `ap-south-1` project is
lowest from `bom`.
=======
`--restart unless-stopped` + the EBS volume means: instance reboot → container
comes back; container crash → Docker restarts it; instance replaced → a fresh
container restores the WhatsApp session from Supabase Storage on boot (no QR).
Full recovery notes: `DEPLOYMENT.md` → "Deploy to EC2".
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)

---

## STEP 8 — Wire Vercel → Worker (30 s)

In the Vercel dashboard, add these two environment variables (Production):

```
<<<<<<< HEAD
WA_WORKER_URL   = https://matzhub-worker.fly.dev
WA_WORKER_TOKEN = <same value as WA_WORKER_TOKEN in your .env>
```

=======
WA_WORKER_URL   = http://<INSTANCE-IP>:8081
WA_WORKER_TOKEN = <same value as WA_WORKER_TOKEN in your .env>
```

If you put the worker behind a domain + TLS later, point WA_WORKER_URL at
that instead. Plain HTTP to the instance IP is acceptable for launch because
the only callers are your Vercel app and your admin's Telegram commands —
both send `WA_WORKER_TOKEN`, and the port is firewalled to your IP.

>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
Redeploy (Vercel does this automatically when env vars change on the
Production environment).

---

## STEP 9 — Pair WhatsApp (2 min, one-time)

Choose ONE method. QR is simpler; pairing code helps if QR doesn't render
where you can scan it.

### 9a. QR method

```bash
# Fetch the QR image directly from the worker (requires WA_WORKER_TOKEN).
curl -sS -H "Authorization: Bearer $WA_WORKER_TOKEN" \
<<<<<<< HEAD
  https://matzhub-worker.fly.dev/qr \
=======
  http://<INSTANCE-IP>:8081/qr \
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
  | node -e "let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{const j=JSON.parse(d);if(j.pngBase64){require('fs').writeFileSync('qr.png',Buffer.from(j.pngBase64,'base64'));console.log('Wrote qr.png — open it and scan with WhatsApp → Linked Devices → Link a Device')}else{console.log(j)}})"
open qr.png     # or `xdg-open qr.png` on Linux
```

Scan with **the WhatsApp account that receives supplier messages** (NOT
your personal customer number). WhatsApp → Settings → Linked Devices →
Link a Device.

### 9b. Pairing-code method (if you can't scan the QR)

Set `WA_PAIRING_NUMBER=91XXXXXXXXXX` as a Fly secret, redeploy, watch logs
<<<<<<< HEAD
with `fly logs -a matzhub-worker`. Baileys prints an 8-digit code. Enter it
=======
with `sudo docker logs -f matzhub-worker`. Baileys prints an 8-digit code. Enter it
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
in WhatsApp → Linked Devices → Link with phone number instead.

### Confirm

```bash
<<<<<<< HEAD
curl -sS https://matzhub-worker.fly.dev/health
=======
curl -sS http://<INSTANCE-IP>:8081/health
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
# Must print: {"status":"connected","processed":0,...}
```

The session is now backed up automatically to `wa-sessions/primary/*` in
<<<<<<< HEAD
Supabase Storage. Future `fly deploy` calls restore it — no re-scanning.
=======
Supabase Storage. Future container redeploys restore it — no re-scanning.
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)

---

## STEP 10 — Register Telegram webhooks

```bash
# From the repo root, on the machine that has your .env
npm run webhooks -- https://<your-vercel-domain>
```

Prints:

```
  ✓ admin @MatzHubAdmin_bot  →  https://<...>/api/telegram/webhook  (secret …abcd)
  ✓ dev   @MatzHubDev_bot    →  https://<...>/api/telegram/webhook/dev  (secret …efgh)
```

Now DM `/whoami` to `@MatzHubAdmin_bot` from your Telegram account. It must
reply with your chat id. If it doesn't, `TELEGRAM_ADMIN_CHAT_ID` in Vercel
doesn't match your account.

Then `/health` → must return DB green, worker `connected`, catalogue counts.

---

## STEP 11 — Point Cloudflare DNS at Vercel

```bash
export CLOUDFLARE_API_TOKEN=<Cloudflare token with DNS:Edit + SSL:Edit>
export CLOUDFLARE_ZONE_ID=<matzhub.com zone id>
export VERCEL_API_TOKEN=<Vercel personal token>
export VERCEL_PROJECT_ID=<your project id>
export VERCEL_TEAM_ID=<your team id, or leave unset for personal>

npm run provision            # dry run — shows the diff
npm run provision:apply      # actually apply
```

This sets `matzhub.com A 76.76.21.21` and `www CNAME cname.vercel-dns.com`,
both DNS-only, plus TLS + HSTS. **Do NOT turn on Cloudflare's orange-cloud
proxy on the apex until after Vercel issues the certificate** — otherwise
the http-01 challenge stalls. See `DEPLOYMENT.md` → "Cloudflare".

---

## STEP 12 — End-to-end smoke test

```bash
SITE=https://matzhub.com
<<<<<<< HEAD
WORKER=https://matzhub-worker.fly.dev
=======
WORKER=http://<INSTANCE-IP>:8081
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
INGEST=<INGEST_TOKEN from .env>
CRON=<CRON_SECRET from .env>
WA=<WA_WORKER_TOKEN from .env>

# 1. Public endpoints
for p in / /api/health /api/readiness /api/monitoring /sitemap.xml /products.json; do
  printf "  %-30s %s\n" "$p" "$(curl -sS -o /dev/null -w '%{http_code}' $SITE$p)"
done

# 2. Auth fail-closed
printf "  %-30s %s\n" "POST /api/ingest (no auth)" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST $SITE/api/ingest)"
# expect 401

# 3. Auth pass with token
printf "  %-30s %s\n" "POST /api/ingest (auth)" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $INGEST" -H 'Content-Type: application/json' -d '{"messages":[]}' $SITE/api/ingest)"
# expect 400 (empty batch is rejected by validation, which is correct)

# 4. Cron with token
curl -sS -H "Authorization: Bearer $CRON" $SITE/api/cron/self-heal
# expect {"ok":true,"job":"self-heal",...}

# 5. Worker health
curl -sS $WORKER/health
# expect {"status":"connected",...}

# 6. Worker groups (auth required)
curl -sS -H "Authorization: Bearer $WA" $WORKER/groups | head -c 200
# expect {"ok":true,"groups":[...]} once at least one supplier group is joined

# 7. Real supplier message → catalogue
MSG=smoke-$(date +%s)
curl -sS -X POST -H "Authorization: Bearer $INGEST" -H 'Content-Type: application/json' \
  -d "{\"messages\":[{\"messageId\":\"$MSG\",\"groupId\":\"919999999999-1234567890@g.us\",\"caption\":\"Test Watch Silver Cost 850\",\"imageUrl\":\"https://images.pexels.com/photos/190819/pexels-photo-190819.jpeg\",\"source\":\"whatsapp\"}]}" \
  $SITE/api/ingest
# expect {"ok":true,"processed":1,"stages":{"pending_review":1},...}
```

If step 7 returns `pending_review` with a productId, your entire pipeline
works end-to-end.

---

## STEP 13 — First real supplier group

1. In Telegram admin bot: `/panel` → **Add channel** → paste the WhatsApp
   group name exactly as it appears in WhatsApp.
2. Add the WhatsApp ingestion account to that supplier group in WhatsApp
   itself.
3. Ask a supplier to post one product. Within ~10 seconds the worker
   ingests it; within ~1 minute `/admin/moderation` on the storefront shows
   it staged for review.
4. Approve it. The product appears on the public storefront.

Launch complete.

---

## What to do if something breaks

| Symptom | First place to look |
| --- | --- |
| `/api/health` 503 | Supabase project status page; DB password unchanged? |
| Worker `awaiting_qr` after being connected | Session invalidated. Telegram admin: `/relink`, redo Step 9 |
| Telegram bot silent | `npm run webhooks -- https://matzhub.com` again; check `TELEGRAM_*_CHAT_ID` in Vercel |
| Products ingest but no image | Supabase service_role key rotated or wrong; redo Step 1 |
| Cron endpoints return 401 | `CRON_SECRET` in Vercel doesn't match; Vercel dashboard → Env → redeploy |
<<<<<<< HEAD
| Worker crashed | `fly status -a matzhub-worker`, `fly logs -a matzhub-worker`, `fly apps restart matzhub-worker` |
=======
| Worker crashed | SSH in: `sudo docker ps -a`, `sudo docker logs matzhub-worker`, `sudo docker restart matzhub-worker` |
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
| Missed a supplier message | Telegram admin: `/backfill` — pulls last 50 per group via `fetchMessageHistory` |

Detailed runbook is in `OPS.md`.

---

## What is deliberately NOT in this doc

- Anything requiring your personal computer to stay on 24/7. Nothing here
  does.
- Docker Compose. There is no compose file in this repo. If you see one
  referenced elsewhere, it's stale.
<<<<<<< HEAD
- Multiple deployment options for the worker. Pick AWS EC2, Fly.io, or GCE e2-micro
  and stick with it. Running two worker instances against one WhatsApp
  account will fight over the session (`connectionReplaced` 440 loop) and
  eventually rate-limit the number.
- Anything about the SSH key `user@DESKTOP-O7H0FRT`. MatzHub has no server
  you SSH into. SSH keys belong on GitHub (for `git push`) and on Fly.io /
  GCE (for `fly ssh console` or `gcloud compute ssh`), not in this repo.
=======
- Multiple deployment options for the worker. EC2 is canonical; Fly.io is
  the documented alternative. Pick ONE and stick with it. Running two worker
  instances against one WhatsApp account will fight over the session
  (`connectionReplaced` 440 loop) and eventually rate-limit the number.
- Anything about the SSH key `user@DESKTOP-O7H0FRT`. MatzHub has no server
  you SSH into. SSH keys belong on GitHub (for `git push`) and on AWS (for
  `ssh` to the EC2 instance), not in this repo.
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
