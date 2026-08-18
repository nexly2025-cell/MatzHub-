#!/usr/bin/env bash
# MatzHub persistent WhatsApp worker operations.
# Usage: ./deploy-worker.sh [deploy|update|rebuild|status|health|logs|restart|qr]
# The wa-session volume is never removed by this script.
set -Eeuo pipefail

ACTION="${1:-deploy}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${WA_WORKER_ENV_FILE:-$SCRIPT_DIR/.env}"
SESSION_VOLUME="${WA_SESSION_VOLUME:-wa-session}"
HOST_PORT="${WA_WORKER_HOST_PORT:-8081}"

# Preserve compatibility with the existing production container name.
if [[ -n "${WA_WORKER_CONTAINER:-}" ]]; then
  CONTAINER_NAME="$WA_WORKER_CONTAINER"
elif docker container inspect matzhub-worker >/dev/null 2>&1; then
  CONTAINER_NAME="matzhub-worker"
else
  CONTAINER_NAME="matzhub-whatsapp-worker"
fi
PREVIOUS_CONTAINER="${CONTAINER_NAME}-previous"
IMAGE="${WA_WORKER_IMAGE:-matzhub-worker}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required."
  docker info >/dev/null 2>&1 || fail "Cannot access the Docker daemon."
}
worker_health() {
  docker exec "$CONTAINER_NAME" node -e "fetch('http://127.0.0.1:8081/health').then(async r => { console.log(r.status); console.log(await r.text()); }).catch(() => process.exit(1))"
}
wait_for_health() {
  local status=""
  for _ in $(seq 1 60); do
    status="$(docker exec "$CONTAINER_NAME" node -e "fetch('http://127.0.0.1:8081/health').then(r => console.log(r.status)).catch(() => process.exit(1))" 2>/dev/null || true)"
    case "$status" in
      200|503) printf '%s\n' "$status"; return 0 ;;
      *) sleep 3 ;;
    esac
  done
  return 1
}

case "$ACTION" in
  status)
    require_docker
    docker ps --filter "name=^/${CONTAINER_NAME}$" --format 'container={{.Names}} status={{.Status}} image={{.Image}}'
    docker volume inspect "$SESSION_VOLUME" --format 'session_volume={{.Name}} created={{.CreatedAt}}' 2>/dev/null || printf 'session_volume=%s missing\n' "$SESSION_VOLUME"
    worker_health || fail "Worker control endpoint is unavailable."
    exit 0
    ;;
  health)
    require_docker
    worker_health || fail "Worker control endpoint is unavailable."
    exit 0
    ;;
  logs)
    require_docker
    docker logs --tail "${WA_WORKER_LOG_LINES:-200}" "$CONTAINER_NAME"
    exit 0
    ;;
  qr)
    # State-aware by design. A connected session must never be asked to mint a
    # pairing code, so this reports connected and stops. It NEVER calls /relink:
    # that discards live credentials and is the one action that can strand the
    # paired account. Pairing a genuinely unpaired account is the only path that
    # writes a QR file.
    require_docker
    token="$(sed -n 's/^WA_WORKER_TOKEN=//p' "$ENV_FILE" | tail -1)"
    [[ -n "$token" ]] || fail "WA_WORKER_TOKEN is not set in $ENV_FILE"
    payload="$(docker exec -e WA_TOKEN="$token" "$CONTAINER_NAME" node -e "
      fetch('http://127.0.0.1:8081/qr', { headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN } })
        .then(async r => { process.stdout.write(await r.text()); })
        .catch(() => process.exit(1));" 2>/dev/null || true)"
    [[ -n "$payload" ]] || fail "Worker did not answer /qr."
    case "$payload" in
      *'"status":"connected"'*)
        echo "WhatsApp is already connected. No QR needed — do not re-pair."
        exit 0 ;;
      *pngBase64*)
        printf '%s' "$payload" \
          | sed -n 's/.*"pngBase64":"\([^"]*\)".*/\1/p' \
          | base64 -d > "$SCRIPT_DIR/qr.png"
        [[ -s "$SCRIPT_DIR/qr.png" ]] || fail "QR payload was empty."
        echo "Wrote $SCRIPT_DIR/qr.png — scan it with the WhatsApp number you are pairing."
        exit 0 ;;
      *)
        printf '%s\n' "$payload"
        exit 0 ;;
    esac
    ;;
  restart)
    require_docker
    docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1 || fail "Worker container is missing. Use ./deploy-worker.sh deploy."
    # SIGTERM lets the worker upload the current session before Docker restarts.
    docker restart --time 30 "$CONTAINER_NAME" >/dev/null
    status="$(wait_for_health)" || fail "Worker did not answer /health within 180 seconds."
    case "$status" in
      200) echo "Worker restarted and connected. Session volume preserved." ;;
      503) echo "Worker restarted and is responding; WhatsApp reconnect/pairing is still in progress." ;;
    esac
    exit 0
    ;;
  deploy|update|rebuild) ;;
  *) fail "Unknown command '$ACTION'. Use deploy, update, rebuild, status, health, logs, restart, or qr." ;;
esac

require_docker
[[ -f "$ENV_FILE" ]] || fail "Worker environment file not found: $ENV_FILE"
git -C "$REPOSITORY_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Repository checkout is missing."
[[ "$(git -C "$REPOSITORY_ROOT" branch --show-current)" == "main" ]] || fail "Refusing to deploy outside main."
git -C "$REPOSITORY_ROOT" diff --quiet && git -C "$REPOSITORY_ROOT" diff --cached --quiet || fail "Commit or stash local changes before deployment."

# Optional read-only GitHub token for private repositories. It is used only as
# an in-memory HTTP header and is never written to the remote URL or .git/config.
GITHUB_TOKEN="$(sed -n 's/^GITHUB_TOKEN=//p' "$ENV_FILE" | tail -1 | tr -d '\r')"
fetch_main() {
  if [[ -n "$GITHUB_TOKEN" ]]; then
    local header
    header="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' \
      GIT_CONFIG_VALUE_0="$header" \
      git -C "$REPOSITORY_ROOT" fetch origin main
  else
    git -C "$REPOSITORY_ROOT" fetch origin main || fail "Git fetch failed. If the repository is private, set a read-only GITHUB_TOKEN in worker/.env."
  fi
}

if [[ "$ACTION" != "rebuild" ]]; then
  fetch_main
  git -C "$REPOSITORY_ROOT" merge --ff-only origin/main || fail "Cannot fast-forward worker checkout. Resolve the Git branch before deployment."
fi
unset GITHUB_TOKEN

docker volume inspect "$SESSION_VOLUME" >/dev/null 2>&1 || docker volume create "$SESSION_VOLUME" >/dev/null

rollback() {
  printf 'Deployment failed; restoring previous worker if available.\n' >&2
  docker logs --tail 80 "$CONTAINER_NAME" 2>&1 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if docker container inspect "$PREVIOUS_CONTAINER" >/dev/null 2>&1; then
    docker rename "$PREVIOUS_CONTAINER" "$CONTAINER_NAME"
    docker start "$CONTAINER_NAME" >/dev/null
    printf 'Previous worker restored; session volume was untouched.\n' >&2
  fi
}
trap rollback ERR

echo "Building ${IMAGE}:candidate…"
docker build --pull -t "${IMAGE}:candidate" "$SCRIPT_DIR"

# Stop the old worker before starting a new one: exactly one Baileys socket may
# use the session. Keep the stopped predecessor only as a rollback target.
docker rm -f "$PREVIOUS_CONTAINER" >/dev/null 2>&1 || true
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  docker stop --time 30 "$CONTAINER_NAME" >/dev/null
  docker rename "$CONTAINER_NAME" "$PREVIOUS_CONTAINER"
fi

echo "Starting ${CONTAINER_NAME} with persistent volume ${SESSION_VOLUME}…"
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  --env "WA_SESSION_DIR=/data/.wa-session" \
  --env "WA_WORKER_PORT=8081" \
  --memory 700m --memory-swap 1g \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p "127.0.0.1:${HOST_PORT}:8081" \
  -v "${SESSION_VOLUME}:/data" \
  "${IMAGE}:candidate" >/dev/null

status="$(wait_for_health)" || fail "Worker health endpoint did not respond within 180 seconds."
case "$status" in
  200) echo "Worker deployed and WhatsApp connected. Persistent session preserved." ;;
  503) echo "Worker deployed and responding; WhatsApp is not connected yet. Use the authenticated Telegram QR flow only if pairing is truly required." ;;
esac

docker tag "${IMAGE}:candidate" "${IMAGE}:current"
docker rm -f "$PREVIOUS_CONTAINER" >/dev/null 2>&1 || true
trap - ERR
