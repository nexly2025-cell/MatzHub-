#!/usr/bin/env bash
# MatzHub WhatsApp worker operator commands.
# Usage: ./wa.sh [status|health|logs|restart|qr|deploy]
# This wrapper never removes the persistent wa-session volume.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

container_name() {
  if [[ -n "${WA_WORKER_CONTAINER:-}" ]]; then
    printf '%s' "$WA_WORKER_CONTAINER"
  elif docker container inspect matzhub-worker >/dev/null 2>&1; then
    printf 'matzhub-worker'
  else
    printf 'matzhub-whatsapp-worker'
  fi
}

CONTAINER="$(container_name)"
PORT="${WA_WORKER_HOST_PORT:-8787}"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

case "${1:-status}" in
  status) exec ./deploy-worker.sh status ;;
  health)
    docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8081/health').then(async r=>{console.log(await r.text());process.exit(r.status===200||r.status===503?0:1)}).catch(()=>process.exit(1))"
    ;;
  logs)
    docker logs -f --tail "${WA_WORKER_LOG_LINES:-200}" "$CONTAINER"
    ;;
  restart) exec ./deploy-worker.sh restart ;;
  deploy) exec ./deploy-worker.sh deploy ;;
  qr)
    [[ -f .env ]] || fail "Missing worker/.env"
    token="$(sed -n 's/^WA_WORKER_TOKEN=//p' .env | tail -1 | tr -d '\r')"
    [[ -n "$token" ]] || fail "WA_WORKER_TOKEN is not set in worker/.env"
    payload="$(docker exec -e WORKER_TOKEN="$token" "$CONTAINER" node -e "fetch('http://127.0.0.1:8081/qr',{headers:{Authorization:'Bearer '+process.env.WORKER_TOKEN}}).then(async r=>{console.log(await r.text());process.exit(r.status===200?0:1)}).catch(()=>process.exit(1))")" || fail "Worker did not provide a QR. If connected, no QR is needed."
    if printf '%s' "$payload" | grep -q '"status":"connected"'; then
      echo "Session is valid. No QR needed."
      exit 0
    fi
    printf '%s' "$payload" | sed -n 's/.*"pngBase64":"\([^"]*\)".*/\1/p' | base64 -d > qr.png || fail "No active pairing QR. Use Telegram /qr or wait for worker pairing mode."
    [[ -s qr.png ]] || fail "QR image was empty"
    echo "QR saved to $SCRIPT_DIR/qr.png"
    ;;
  *)
    echo "Usage: ./wa.sh [status|health|logs|restart|qr|deploy]"
    exit 1
    ;;
esac
