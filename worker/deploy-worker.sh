#!/usr/bin/env bash
# Safe Docker worker operations for the persistent VM.
# Usage: ./deploy-worker.sh [deploy|update|rebuild|status|logs|restart]
# Never removes the WhatsApp session volume.
set -Eeuo pipefail

ACTION="${1:-deploy}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTAINER_NAME="${WA_WORKER_CONTAINER:-matzhub-whatsapp-worker}"
PREVIOUS_CONTAINER="${CONTAINER_NAME}-previous"
IMAGE="${WA_WORKER_IMAGE:-matzhub-whatsapp-worker:latest}"
SESSION_VOLUME="${WA_SESSION_VOLUME:-wa-session}"
HOST_PORT="${WA_WORKER_HOST_PORT:-8081}"
ENV_FILE="${WA_WORKER_ENV_FILE:-$SCRIPT_DIR/.env}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required."
}

worker_health() {
  docker exec "$CONTAINER_NAME" node -e "fetch('http://127.0.0.1:8081/health').then(async r => { console.log(r.status); console.log(await r.text()); }).catch(() => process.exit(1))"
}

wait_for_health() {
  local status=""
  for _ in $(seq 1 30); do
    status="$(docker exec "$CONTAINER_NAME" node -e "fetch('http://127.0.0.1:8081/health').then(r => console.log(r.status)).catch(() => process.exit(1))" 2>/dev/null || true)"
    case "$status" in
      200|503) printf '%s\n' "$status"; return 0 ;;
      *) sleep 2 ;;
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
  logs)
    require_docker
    docker logs --tail "${WA_WORKER_LOG_LINES:-200}" "$CONTAINER_NAME"
    exit 0
    ;;
  restart)
    require_docker
    docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1 || fail "Worker container is missing. Use ./deploy-worker.sh deploy."
    docker restart "$CONTAINER_NAME" >/dev/null
    status="$(wait_for_health)" || fail "Worker did not answer /health within 60 seconds."
    case "$status" in
      200) echo "Worker restarted and connected. Session volume preserved." ;;
      503) echo "Worker restarted and is responding; WhatsApp pairing/reconnect is still in progress." ;;
    esac
    exit 0
    ;;
  deploy|update|rebuild)
    ;;
  *)
    fail "Unknown command '$ACTION'. Use deploy, update, rebuild, status, logs, or restart."
    ;;
esac

require_docker
[[ -f "$ENV_FILE" ]] || fail "Worker environment file not found: $ENV_FILE"
git -C "$REPOSITORY_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Repository checkout is missing."
[[ "$(git -C "$REPOSITORY_ROOT" branch --show-current)" == "main" ]] || fail "Refusing to deploy outside main."
git -C "$REPOSITORY_ROOT" diff --quiet && git -C "$REPOSITORY_ROOT" diff --cached --quiet || fail "Commit or stash local changes before deployment."

if [[ "$ACTION" != "rebuild" ]]; then
  git -C "$REPOSITORY_ROOT" fetch origin main
  git -C "$REPOSITORY_ROOT" merge --ff-only origin/main
fi

docker volume inspect "$SESSION_VOLUME" >/dev/null 2>&1 || docker volume create "$SESSION_VOLUME" >/dev/null

rollback() {
  printf 'Deployment failed; restoring the previous container if available.\n' >&2
  docker logs --tail 80 "$CONTAINER_NAME" 2>&1 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if docker container inspect "$PREVIOUS_CONTAINER" >/dev/null 2>&1; then
    docker rename "$PREVIOUS_CONTAINER" "$CONTAINER_NAME"
    docker start "$CONTAINER_NAME" >/dev/null
    printf 'Previous worker restored.\n' >&2
  fi
}
trap rollback ERR

echo "Building $IMAGE…"
docker build --pull -t "$IMAGE" "$SCRIPT_DIR"

# A stopped predecessor is a rollback target, never a second Baileys runtime.
docker rm -f "$PREVIOUS_CONTAINER" >/dev/null 2>&1 || true
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  docker stop "$CONTAINER_NAME" >/dev/null
  docker rename "$CONTAINER_NAME" "$PREVIOUS_CONTAINER"
fi

echo "Starting $CONTAINER_NAME with persistent volume $SESSION_VOLUME…"
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -p "${HOST_PORT}:8081" \
  -v "${SESSION_VOLUME}:/data" \
  "$IMAGE" >/dev/null

status="$(wait_for_health)" || fail "Worker health endpoint did not respond within 60 seconds."
case "$status" in
  200) echo "Worker deployed and connected. Persistent session volume preserved." ;;
  503) echo "Worker deployed and responding; WhatsApp is not connected yet. Use the authenticated Telegram QR flow only if pairing is required." ;;
esac

docker rm -f "$PREVIOUS_CONTAINER" >/dev/null 2>&1 || true
trap - ERR
