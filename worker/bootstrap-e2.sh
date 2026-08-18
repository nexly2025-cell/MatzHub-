#!/usr/bin/env bash
# MatzHub E2 bootstrap and recovery. Run on the worker VM.
# Required secrets come from the shell, an existing worker/.env, or the current
# worker container. Nothing is printed or committed. The wa-session volume is
# never removed.
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/nexly2025-cell/MatzHub-.git}"
REPO_DIR="${REPO_DIR:-$HOME/MatzHub-}"
WORKER_DIR="$REPO_DIR/worker"
VERCEL_PROJECT_ID="${VERCEL_PROJECT_ID:-prj_ZMCtO7b0yi4Vr0zKmPYJSuBw3AaQ}"
SESSION_VOLUME="${WA_SESSION_VOLUME:-wa-session}"
SESSION_DIR="/data/.wa-session"
AUTHORITATIVE_JIDS="120363337186642655@g.us,120363136590856235@g.us,120363084957889605@g.us,120363086598656877@g.us,120363169458002169@g.us,120363088334492923@g.us,120363089280152472@g.us,120363103975055296@g.us,120363027163825724@g.us"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '\n=== %s ===\n' "$*"; }

info "SYSTEM"
sudo apt-get update -qq
sudo apt-get install -y -qq docker.io git curl >/dev/null
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER" || true

# Read only existing env values from the previous worker before replacing it.
LEGACY_ENV="$(mktemp)"
trap 'rm -f "$LEGACY_ENV"' EXIT
for container in matzhub-worker matzhub-whatsapp-worker; do
  if sudo docker container inspect "$container" >/dev/null 2>&1; then
    sudo docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$LEGACY_ENV"
    break
  fi
done

value_from_file() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -1
}
value_for() {
  local key="$1" fallback="${2:-}" value="${!key:-}"
  if [[ -z "$value" && -f "$WORKER_DIR/.env" ]]; then value="$(value_from_file "$key" "$WORKER_DIR/.env")"; fi
  if [[ -z "$value" ]]; then value="$(value_from_file "$key" "$LEGACY_ENV")"; fi
  printf '%s' "${value:-$fallback}"
}

GITHUB_TOKEN_VALUE="$(value_for GITHUB_TOKEN)"
info "REPOSITORY"
if [[ ! -d "$REPO_DIR/.git" ]]; then
  if [[ -n "$GITHUB_TOKEN_VALUE" ]]; then
    HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN_VALUE" | base64 | tr -d '\n')"
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' GIT_CONFIG_VALUE_0="$HEADER" \
      git clone -q "$REPO_URL" "$REPO_DIR"
  else
    git clone -q "$REPO_URL" "$REPO_DIR" || fail "Clone failed. Set GITHUB_TOKEN when the repository is private."
  fi
fi

if [[ -n "$GITHUB_TOKEN_VALUE" ]]; then
  HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN_VALUE" | base64 | tr -d '\n')"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' GIT_CONFIG_VALUE_0="$HEADER" \
    git -C "$REPO_DIR" fetch -q origin main
else
  git -C "$REPO_DIR" fetch -q origin main || fail "Fetch failed. Set GITHUB_TOKEN when the repository is private."
fi
git -C "$REPO_DIR" reset -q --hard origin/main
printf 'DEPLOY_COMMIT=%s\n' "$(git -C "$REPO_DIR" rev-parse HEAD)"

info "SESSION BEFORE DEPLOY"
sudo docker volume inspect "$SESSION_VOLUME" >/dev/null 2>&1 || sudo docker volume create "$SESSION_VOLUME" >/dev/null
sudo docker run --rm -v "$SESSION_VOLUME:/session" alpine sh -c '
  if [ -f /session/creds.json ] && [ ! -f /session/.wa-session/creds.json ]; then
    mkdir -p /session/.wa-session
    find /session -mindepth 1 -maxdepth 1 ! -name .wa-session -exec mv {} /session/.wa-session/ \;
  fi
  if [ -f /session/.wa-session/creds.json ]; then echo WA_SESSION_CREDS=YES; else echo WA_SESSION_CREDS=NO; fi
  find /session/.wa-session -maxdepth 1 -type f 2>/dev/null | wc -l | awk "{print \"WA_SESSION_FILES_BEFORE=\"\$1}"
'

info "WORKER CONFIG"
cd "$WORKER_DIR"
umask 077
INGEST_TOKEN_VALUE="$(value_for INGEST_TOKEN)"
CRON_SECRET_VALUE="$(value_for CRON_SECRET)"
WA_WORKER_TOKEN_VALUE="$(value_for WA_WORKER_TOKEN)"
SUPABASE_URL_VALUE="$(value_for SUPABASE_URL)"
SUPABASE_SERVICE_ROLE_KEY_VALUE="$(value_for SUPABASE_SERVICE_ROLE_KEY)"
SUPABASE_BUCKET_VALUE="$(value_for SUPABASE_BUCKET products)"
SUPABASE_VIDEO_BUCKET_VALUE="$(value_for SUPABASE_VIDEO_BUCKET product-media)"

for key in INGEST_TOKEN_VALUE CRON_SECRET_VALUE WA_WORKER_TOKEN_VALUE SUPABASE_URL_VALUE SUPABASE_SERVICE_ROLE_KEY_VALUE; do
  [[ -n "${!key}" ]] || fail "Missing ${key%_VALUE}. Export it in the SSH shell or keep it on the existing worker container."
done

cat > .env <<EOF
MATZHUB_API_URL=https://matzhub.com
INGEST_TOKEN=${INGEST_TOKEN_VALUE}
CRON_SECRET=${CRON_SECRET_VALUE}
WA_WORKER_TOKEN=${WA_WORKER_TOKEN_VALUE}
GITHUB_TOKEN=${GITHUB_TOKEN_VALUE}
WA_SESSION_DIR=${SESSION_DIR}
WA_WORKER_PORT=8081
SUPABASE_URL=${SUPABASE_URL_VALUE}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY_VALUE}
SUPABASE_BUCKET=${SUPABASE_BUCKET_VALUE}
SUPABASE_VIDEO_BUCKET=${SUPABASE_VIDEO_BUCKET_VALUE}
WA_GROUP_IDS=${AUTHORITATIVE_JIDS}
EOF
chmod 600 .env
chmod +x deploy-worker.sh

info "DEPLOY WORKER"
# Pin the published host port. deploy-worker.sh defaults to 8081, but the
# existing production container and the Cloudflare Tunnel hostname both use
# 8787, so the final health probe below would hit a closed port.
export WA_WORKER_HOST_PORT="${WA_WORKER_HOST_PORT:-8787}"
sg docker -c "cd '$WORKER_DIR' && WA_WORKER_HOST_PORT='$WA_WORKER_HOST_PORT' ./deploy-worker.sh deploy"

# Optional existing Cloudflare Tunnel. The token must already be created in
# Cloudflare Zero Trust with a public hostname routing to localhost:8787.
CF_TUNNEL_TOKEN_VALUE="$(value_for CF_TUNNEL_TOKEN)"
if [[ -n "$CF_TUNNEL_TOKEN_VALUE" ]]; then
  info "CLOUDFLARE TUNNEL"
  sudo docker rm -f matzhub-cloudflared >/dev/null 2>&1 || true
  sudo docker run -d --name matzhub-cloudflared --restart unless-stopped --network host \
    cloudflare/cloudflared:latest tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN_VALUE" >/dev/null
  echo CLOUDFLARE_TUNNEL=STARTED
else
  echo CLOUDFLARE_TUNNEL=NOT_CONFIGURED
fi

# Optional Vercel sync. WA_PUBLIC_URL must be the HTTPS hostname configured on
# the Cloudflare Tunnel (for example https://worker.matzhub.com).
VERCEL_TOKEN_VALUE="$(value_for VERCEL_TOKEN)"
WA_PUBLIC_URL_VALUE="$(value_for WA_PUBLIC_URL)"
if [[ -n "$VERCEL_TOKEN_VALUE" ]]; then
  info "VERCEL WORKER CONFIG"
  upsert_vercel_env() {
    local key="$1" value="$2" current id payload
    current="$(curl -fsS -H "Authorization: Bearer $VERCEL_TOKEN_VALUE" "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env?decrypt=false")"
    id="$(printf '%s' "$current" | node -e "let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{const j=JSON.parse(d);const e=(j.envs||[]).find(x=>x.key===process.argv[1]);process.stdout.write(e?.id||'')})" "$key")"
    payload="$(node -e "console.log(JSON.stringify({key:process.argv[1],value:process.argv[2],type:'encrypted',target:['production','preview']}))" "$key" "$value")"
    if [[ -n "$id" ]]; then
      curl -fsS -X PATCH -H "Authorization: Bearer $VERCEL_TOKEN_VALUE" -H 'Content-Type: application/json' \
        "https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env/${id}" \
        --data "$(node -e "console.log(JSON.stringify({value:process.argv[1],target:['production','preview']}))" "$value")" >/dev/null
    else
      curl -fsS -X POST -H "Authorization: Bearer $VERCEL_TOKEN_VALUE" -H 'Content-Type: application/json' \
        "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env" --data "$payload" >/dev/null
    fi
  }
  upsert_vercel_env INGEST_TOKEN "$INGEST_TOKEN_VALUE"
  upsert_vercel_env CRON_SECRET "$CRON_SECRET_VALUE"
  upsert_vercel_env WA_WORKER_TOKEN "$WA_WORKER_TOKEN_VALUE"
  upsert_vercel_env WA_GROUP_IDS "$AUTHORITATIVE_JIDS"
  if [[ -n "$WA_PUBLIC_URL_VALUE" ]]; then upsert_vercel_env WA_WORKER_URL "$WA_PUBLIC_URL_VALUE"; fi
  echo VERCEL_WORKER_SECRETS=SYNCED
else
  echo VERCEL_WORKER_SECRETS=NOT_SYNCED
fi

info "FINAL STATUS"
sg docker -c "cd '$WORKER_DIR' && WA_WORKER_HOST_PORT='$WA_WORKER_HOST_PORT' ./deploy-worker.sh status" || true
curl -sS --max-time 10 "http://127.0.0.1:${WA_WORKER_HOST_PORT}/health" || true
echo
sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
