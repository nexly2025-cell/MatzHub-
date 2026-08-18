#!/usr/bin/env bash
#
# MatzHub worker — day-to-day operations.
#
#   ./wa.sh status     container + WhatsApp connection state
#   ./wa.sh health     raw /health JSON
#   ./wa.sh logs       follow logs (Ctrl-C to stop)
#   ./wa.sh restart    recycle the container (session preserved)
#   ./wa.sh rebuild    rebuild the image and redeploy (session preserved)
#   ./wa.sh qr         fetch the current pairing QR to ./qr.png
#
# Every command here is non-destructive to the WhatsApp session. Nothing in
# this file removes the `wa-session` volume — that volume IS the pairing.

set -Eeuo pipefail

readonly CONTAINER="matzhub-worker"
readonly PORT="${WA_WORKER_PORT:-8081}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; }
health()  { docker exec "$CONTAINER" wget -qO- "http://127.0.0.1:${PORT}/health" 2>/dev/null; }

case "${1:-status}" in
  status)
    if ! running; then
      printf 'container : \033[1;31mnot running\033[0m\n'
      docker ps -a --filter "name=${CONTAINER}" --format 'last state: {{.Status}}'
      exit 1
    fi
    body="$(health || true)"
    state="$(printf '%s' "$body" | sed -n 's/.*"status":"\([a-z_]*\)".*/\1/p')"
    printf 'container : \033[1;32mrunning\033[0m (%s)\n' "$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" | cut -c1-19)"
    case "$state" in
      connected)   printf 'whatsapp  : \033[1;32mconnected\033[0m\n' ;;
      awaiting_qr) printf 'whatsapp  : \033[1;33mawaiting pairing\033[0m — run ./wa.sh qr\n' ;;
      "")          printf 'whatsapp  : \033[1;31munreachable\033[0m\n' ;;
      *)           printf 'whatsapp  : \033[1;33m%s\033[0m\n' "$state" ;;
    esac
    printf 'session   : volume "wa-session" (%s)\n' "$(docker volume inspect wa-session -f '{{.Mountpoint}}' 2>/dev/null || echo 'MISSING')"
    printf 'memory    : %s\n' "$(docker stats --no-stream --format '{{.MemUsage}} ({{.MemPerc}})' "$CONTAINER" 2>/dev/null || echo n/a)"
    ;;

  health)
    running || die "worker is not running"
    health || die "no response from /health"
    echo
    ;;

  logs)
    docker logs -f --tail "${2:-100}" "$CONTAINER"
    ;;

  restart)
    running || die "worker is not running — use ./deploy-worker.sh"
    # SIGTERM first so the shutdown hook backs the session up to Supabase.
    docker restart --time 30 "$CONTAINER" >/dev/null
    echo "restarted — session volume untouched. Checking health…"
    sleep 8
    exec "$0" status
    ;;

  rebuild)
    exec ./deploy-worker.sh
    ;;

  qr)
    running || die "worker is not running"
    token="$(grep -E '^WA_WORKER_TOKEN=' .env | cut -d= -f2-)"
    [ -n "$token" ] || die "WA_WORKER_TOKEN is not set in .env"
    payload="$(docker exec "$CONTAINER" wget -qO- --header "Authorization: Bearer ${token}" "http://127.0.0.1:${PORT}/qr" 2>/dev/null)" \
      || die "worker refused the request"
    if printf '%s' "$payload" | grep -q '"status":"connected"'; then
      echo "Already paired — no QR needed."; exit 0
    fi
    printf '%s' "$payload" | sed -n 's/.*"pngBase64":"\([^"]*\)".*/\1/p' | base64 -d > qr.png \
      || die "no pairing code active — run: curl -XPOST -H \"Authorization: Bearer \$WA_WORKER_TOKEN\" localhost:${PORT}/relink"
    [ -s qr.png ] || die "empty QR payload"
    echo "wrote qr.png — scan it, or use /qr from the admin Telegram bot"
    ;;

  *)
    sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
