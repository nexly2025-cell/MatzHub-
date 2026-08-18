#!/usr/bin/env bash
#
# MatzHub WhatsApp worker — one-command production deploy.
#
#   ssh <vm>
#   cd MatzHub-/worker && ./deploy-worker.sh
#
# What it does, in order:
#   1. pulls the latest code for the current branch
#   2. builds a new image
#   3. gracefully replaces the running container
#   4. waits for /health to report a live WhatsApp socket
#   5. rolls back to the previous image if it does not
#
# THE PERSISTENT SESSION IS NEVER TOUCHED.
# The Baileys credentials live in the named volume "wa-session" mounted at
# /data. This script does not create, prune or remove it, so a deploy never
# forces a new QR scan. If you ever run `docker volume rm wa-session` you WILL
# have to re-pair the phone — that command is not part of any normal workflow.
#
# Sized for a 2 vCPU / 1 GB e2-micro-class VM: one container, no compose stack,
# no build cache explosion (the old image is kept only until the next deploy).

set -Eeuo pipefail

readonly IMAGE="matzhub-worker"
readonly CONTAINER="matzhub-worker"
readonly VOLUME="wa-session"
readonly PORT="${WA_WORKER_PORT:-8081}"
readonly ENV_FILE="${WA_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env}"
readonly HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok  ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ warn ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ fail ]\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "aborted on line $LINENO"' ERR

# ── preflight ───────────────────────────────────────────────────────────────
command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (need sudo, or add yourself to the docker group)"
[[ -f "$ENV_FILE" ]] || die "missing env file: $ENV_FILE  (copy .env.example and fill it in)"

# Read GITHUB_TOKEN (optional) without exporting the whole file into the shell.
GITHUB_TOKEN="$(sed -n 's/^GITHUB_TOKEN=//p' "$ENV_FILE" | tail -1)"
export GITHUB_TOKEN

# Secrets must never end up in the deploy log.
for required in MATZHUB_API_URL INGEST_TOKEN WA_WORKER_TOKEN; do
  grep -qE "^${required}=.+" "$ENV_FILE" || die "$required is empty in $ENV_FILE"
done
ok "environment file validated (values not printed)"

# ── 1. latest code ──────────────────────────────────────────────────────────
if git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  log "pulling origin/$BRANCH"
  # A PRIVATE repository cannot be pulled anonymously. Set GITHUB_TOKEN in
  # worker/.env (a fine-grained PAT with read-only Contents on this repo) and
  # the pull authenticates over HTTPS without the token ever being written to
  # .git/config, the remote URL, or the shell history.
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git -c credential.helper= \
        -c http.extraheader="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)" \
        pull --ff-only origin "$BRANCH"
  else
    git pull --ff-only origin "$BRANCH" || die "pull failed — if this repository is private, set GITHUB_TOKEN in worker/.env"
  fi
  ok "at $(git rev-parse --short HEAD) on $BRANCH"
else
  warn "not a git checkout — building the working tree as-is"
fi

# ── 2. build ────────────────────────────────────────────────────────────────
# Keep whatever is currently deployed so a failed rollout can be undone.
PREVIOUS=""
if docker image inspect "${IMAGE}:current" >/dev/null 2>&1; then
  docker tag "${IMAGE}:current" "${IMAGE}:previous"
  PREVIOUS="${IMAGE}:previous"
fi

log "building ${IMAGE}:candidate"
docker build --tag "${IMAGE}:candidate" . >/dev/null
ok "image built"

# ── 3. replace the container ────────────────────────────────────────────────
# SIGTERM first: the worker's shutdown hook uploads the session to Supabase
# Storage before exiting, which is the safety net behind the local volume.
start_container() {
  local tag="$1"
  docker run --detach \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --env-file "$ENV_FILE" \
    --env "WA_SESSION_DIR=/data/.wa-session" \
    --env "WA_WORKER_PORT=${PORT}" \
    --volume "${VOLUME}:/data" \
    --publish "127.0.0.1:${PORT}:${PORT}" \
    --memory 700m --memory-swap 1g \
    --log-opt max-size=10m --log-opt max-file=3 \
    "$tag" >/dev/null
}

docker volume create "$VOLUME" >/dev/null   # no-op when it already exists
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  log "stopping the running worker (graceful, 30s)"
  docker stop --time 30 "$CONTAINER" >/dev/null || true
  docker rm "$CONTAINER" >/dev/null || true
fi

log "starting the new worker"
start_container "${IMAGE}:candidate"

# ── 4. health gate ──────────────────────────────────────────────────────────
# /health is 200 only once Baileys reports "connected". A worker that is
# genuinely waiting to be paired reports awaiting_qr — that is a legitimate
# state after a relink, so it is surfaced rather than treated as a rollback.
log "waiting for /health (up to ${HEALTH_TIMEOUT}s)"
deadline=$(( SECONDS + HEALTH_TIMEOUT ))
state="unreachable"
while (( SECONDS < deadline )); do
  body="$(docker exec "$CONTAINER" wget -qO- "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
  if [[ -n "$body" ]]; then
    state="$(printf '%s' "$body" | sed -n 's/.*"status":"\([a-z_]*\)".*/\1/p')"
    [[ "$state" == "connected"   ]] && { ok "worker healthy — WhatsApp connected"; break; }
    [[ "$state" == "awaiting_qr" ]] && { warn "worker is up but WhatsApp needs pairing — send /qr from the admin Telegram bot"; break; }
  fi
  sleep 3
done

if [[ "$state" != "connected" && "$state" != "awaiting_qr" ]]; then
  warn "worker did not become healthy (last state: ${state})"
  docker logs --tail 40 "$CONTAINER" || true
  if [[ -n "$PREVIOUS" ]]; then
    warn "rolling back to the previous image (the session volume is untouched)"
    docker stop --time 20 "$CONTAINER" >/dev/null || true
    docker rm "$CONTAINER" >/dev/null || true
    start_container "$PREVIOUS"
    docker tag "$PREVIOUS" "${IMAGE}:current"
    die "rolled back — previous worker restored"
  fi
  die "no previous image to roll back to; investigate the logs above"
fi

# ── 5. promote + tidy ───────────────────────────────────────────────────────
docker tag "${IMAGE}:candidate" "${IMAGE}:current"
# Dangling layers only. `docker volume prune` is deliberately NOT run here —
# it would be one flag away from destroying the WhatsApp pairing.
docker image prune --force --filter "dangling=true" >/dev/null 2>&1 || true

ok "deployed  container=${CONTAINER}  state=${state}  volume=${VOLUME} (preserved)"
