#!/usr/bin/env bash
# ============================================================================
#  MatzHub — local development helper.
#
#  Usage:
#     ./launch.sh dev          setup + dev server (hot reload)
#     ./launch.sh worker       run the WhatsApp worker locally for testing
#     ./launch.sh doctor       report which env vars are configured
#
#  This script is dev-only. Production deployment is documented in
<<<<<<< HEAD
#  DEPLOYMENT.md (Vercel + Fly.io worker + Supabase + Cloudflare) and is
=======
#  DEPLOYMENT.md (Vercel + EC2 worker + Supabase + Cloudflare) and is
>>>>>>> 4c2f0f5 (production: full audit consolidation — cart, Telegram 5-min delete fix, dev/admin separation, premium WhatsApp order, logo, worker + deploy fixes)
#  never a bare-metal `./launch.sh start` in a screen session.
#
#  Idempotent. Safe to run repeatedly.
# ============================================================================
set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; GOLD=$'\033[33m'; GREEN=$'\033[32m'
RED=$'\033[31m'; BLUE=$'\033[36m'; RESET=$'\033[0m'

say()  { printf "%s\n" "${BLUE}▸${RESET} $1"; }
ok()   { printf "%s\n" "${GREEN}✓${RESET} $1"; }
warn() { printf "%s\n" "${GOLD}!${RESET} $1"; }
die()  { printf "%s\n" "${RED}✗${RESET} $1"; exit 1; }

banner() {
  printf "\n%s\n" "${BOLD}${GOLD}  MatzHub${RESET}${DIM} — dev launcher${RESET}"
  printf "%s\n\n" "${DIM}  ────────────────────────────────────────────────${RESET}"
}

MODE="${1:-dev}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

preflight() {
  command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 20 or newer."
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "Node 20+ required. You have $(node -v)."
  ok "Node $(node -v)"
  command -v npm >/dev/null 2>&1 || die "npm not found."
}

setup_env() {
  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      cp .env.example .env
      warn "Created .env from .env.example — open it and fill in your values."
    else
      die ".env.example is missing. The repo is incomplete."
    fi
  fi
  set -a; . ./.env; set +a
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is missing from .env"
  ok "Environment loaded"

  if [ -z "${ADMIN_PASSWORD:-}" ] || [ "${ADMIN_PASSWORD:-}" = "change-me-now" ]; then
    warn "ADMIN_PASSWORD is unset or default — /admin is effectively open."
  fi
}

install_deps() {
  if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
    say "Installing platform dependencies…"
    npm install --no-audit --no-fund >/dev/null 2>&1 || npm install
  fi
  ok "Platform dependencies ready"
}

wait_for_postgres() {
  say "Checking PostgreSQL…"
  local reachable=0
  for _ in $(seq 1 20); do
    if node -e "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query('select 1').then(()=>{process.exit(0)}).catch(()=>{process.exit(1)});" >/dev/null 2>&1; then
      reachable=1; break
    fi
    sleep 1
  done
  if [ "$reachable" -eq 0 ]; then
    die "DATABASE_URL is unreachable after 20s.
        Point it at your managed PostgreSQL (Supabase, Neon or RDS) and retry."
  fi
  ok "PostgreSQL reachable"
}

setup_db() {
  wait_for_postgres
  say "Applying database schema…"
  npx drizzle-kit push --force >/dev/null 2>&1 || npx drizzle-kit push --force
  ok "Schema applied"
}

start_worker() {
  [ -d worker ] || die "worker/ directory is missing."
  cd worker
  if [ ! -d node_modules ]; then
    say "Installing WhatsApp worker dependencies (Baileys + sharp, ~1 min)…"
    npm install --no-audit --no-fund
  fi
  [ -f .env ] || { cp ../.env .env 2>/dev/null || true; }
  printf "\n%s\n" "${BOLD}Scan the QR code below once with WhatsApp → Linked Devices.${RESET}"
  printf "%s\n\n" "${DIM}After the first scan the session persists to Supabase; restarts reconnect silently.${RESET}"
  exec node whatsapp-worker.mjs
}

doctor() {
  banner
  printf "%s\n" "${BOLD}Configuration report${RESET}"
  printf "%s\n" "${DIM}────────────────────────────────────────────────${RESET}"
  [ -f .env ] && set -a && . ./.env && set +a

  check() {
    if [ -n "${2:-}" ]; then printf "  ${GREEN}✓${RESET} %-32s %s\n" "$1" "configured";
    else printf "  ${GOLD}○${RESET} %-32s %s\n" "$1" "${3:-not set}"; fi
  }

  printf "\n%s\n" "${BOLD}Core${RESET}"
  check "DATABASE_URL"                "${DATABASE_URL:-}"                "REQUIRED — nothing works without this"
  check "DIRECT_DATABASE_URL"         "${DIRECT_DATABASE_URL:-}"         "drizzle-kit push may fail on Supabase transaction pooler"
  check "ADMIN_PASSWORD"              "${ADMIN_PASSWORD:-}"              "admin panel is unprotected"
  check "ADMIN_SESSION_SECRET"        "${ADMIN_SESSION_SECRET:-}"        "session cookies use a weak default"
  check "NEXT_PUBLIC_SITE_URL"        "${NEXT_PUBLIC_SITE_URL:-}"        "canonical URLs will be wrong"
  check "NEXT_PUBLIC_CUSTOMER_WHATSAPP" "${NEXT_PUBLIC_CUSTOMER_WHATSAPP:-}" "contact/support links are empty"

  printf "\n%s\n" "${BOLD}Automation${RESET}"
  check "INGEST_TOKEN"                "${INGEST_TOKEN:-}"                "ingestion webhook is open (dev) / 401 (prod)"
  check "CRON_SECRET"                 "${CRON_SECRET:-}"                 "cron endpoints are open (dev) / 401 (prod)"
  check "OPENAI_API_KEY"              "${OPENAI_API_KEY:-}"              "falls back to rules engine (works, lower copy quality)"

  printf "\n%s\n" "${BOLD}WhatsApp worker link${RESET}"
  check "WA_WORKER_URL"               "${WA_WORKER_URL:-}"               "Telegram /worker and /qr have nothing to call"
  check "WA_WORKER_TOKEN"             "${WA_WORKER_TOKEN:-}"             "worker control endpoints will refuse Telegram commands"
  check "SUPPLIER_INGESTION_NUMBER"   "${SUPPLIER_INGESTION_NUMBER:-}"   "no supplier-group isolation at /api/ingest"

  printf "\n%s\n" "${BOLD}Supabase (DB is above; this is storage)${RESET}"
  check "SUPABASE_URL"                "${SUPABASE_URL:-}"                "worker cannot host product images or persist WA session"
  check "SUPABASE_SERVICE_ROLE_KEY"   "${SUPABASE_SERVICE_ROLE_KEY:-}"   ""

  printf "\n%s\n" "${BOLD}Telegram operator control plane${RESET}"
  check "TELEGRAM_ADMIN_BOT_TOKEN"    "${TELEGRAM_ADMIN_BOT_TOKEN:-}"    "no admin bot"
  check "TELEGRAM_ADMIN_CHAT_ID"      "${TELEGRAM_ADMIN_CHAT_ID:-}"      "admin bot refuses everything (fail-closed)"
  check "TELEGRAM_WEBHOOK_SECRET"     "${TELEGRAM_WEBHOOK_SECRET:-}"     "webhook accepts unsigned callers"
  check "TELEGRAM_DEV_BOT_TOKEN"      "${TELEGRAM_DEV_BOT_TOKEN:-}"      "no developer bot"
  check "TELEGRAM_DEV_CHAT_ID"        "${TELEGRAM_DEV_CHAT_ID:-}"        "dev bot refuses everything (fail-closed)"

  printf "\n%s\n" "${BOLD}Cashfree (operator billing; customers never see it)${RESET}"
  check "CASHFREE_APP_ID"             "${CASHFREE_APP_ID:-}"             "auto-uploads pause when subscription expires"
  check "CASHFREE_SECRET_KEY"         "${CASHFREE_SECRET_KEY:-}"         "webhook rejects every caller"

  printf "\n%s\n" "${DIM}Legend: ✓ configured · ○ missing (consequence shown)${RESET}"
  printf "%s\n\n" "${DIM}Nothing marked ○ blocks dev launch except DATABASE_URL.${RESET}"
}

case "$MODE" in
  doctor)
    doctor
    ;;

  worker)
    banner; preflight; setup_env; start_worker
    ;;

  dev|*)
    banner; preflight; setup_env; install_deps; setup_db
    ok "Starting dev server on http://localhost:3000"
    exec npm run dev
    ;;
esac
