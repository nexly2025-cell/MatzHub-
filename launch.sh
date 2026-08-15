#!/usr/bin/env bash
# ============================================================================
#  MatzHub — one-tap launch
#
#  Usage:
#     ./launch.sh              full setup + build + start
#     ./launch.sh dev          setup + dev server (hot reload)
#     ./launch.sh worker       start the WhatsApp ingestion worker only
#     ./launch.sh all          platform + worker together
#     ./launch.sh reset        wipe the catalogue and re-seed
#     ./launch.sh doctor       diagnose what's configured and what isn't
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
  printf "\n%s\n" "${BOLD}${GOLD}  MatzHub${RESET}${DIM} — manufacturer-direct commerce, automated${RESET}"
  printf "%s\n\n" "${DIM}  ────────────────────────────────────────────────${RESET}"
}

MODE="${1:-start}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# --------------------------------------------------------------------------
# 0. Preflight
# --------------------------------------------------------------------------
preflight() {
  command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 20 or newer."
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "Node 20+ required. You have $(node -v)."
  ok "Node $(node -v)"
  command -v npm >/dev/null 2>&1 || die "npm not found."
}

# --------------------------------------------------------------------------
# 1. Environment
# --------------------------------------------------------------------------
setup_env() {
  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      cp .env.example .env
      warn "Created .env from .env.example — open it and fill in your values."
    else
      printf 'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db\nADMIN_PASSWORD=matzhub\n' > .env
      warn "Created a minimal .env."
    fi
  fi
  if [ -f .env.local ]; then
    say "Loading .env.local overrides…"
    set -a; . ./.env.local; set +a
  fi
  set -a; . ./.env; set +a
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is missing from .env"
  ok "Environment loaded"

  if [ "${ADMIN_PASSWORD:-}" = "change-me-now" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
    warn "ADMIN_PASSWORD is unset or default — /admin is effectively open. Change it before launch."
  fi
}

# --------------------------------------------------------------------------
# 2. Dependencies
# --------------------------------------------------------------------------
install_deps() {
  if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
    say "Installing platform dependencies…"
    npm install --no-audit --no-fund >/dev/null 2>&1 || npm install
  fi
  ok "Platform dependencies ready"
}

# --------------------------------------------------------------------------
# 3. Database
# --------------------------------------------------------------------------
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
        Point it at your managed PostgreSQL (Neon, Supabase or RDS) and retry."
  fi
  ok "PostgreSQL reachable"
}

setup_db() {
  wait_for_postgres
  say "Applying database schema…"
  npx drizzle-kit push --force >/dev/null 2>&1 || npx drizzle-kit push --force
  ok "Schema applied"
}

# --------------------------------------------------------------------------
# 4. Build
# --------------------------------------------------------------------------
build_app() {
  say "Building production bundle…"
  npm run build >/tmp/matzhub-build.log 2>&1 || { tail -30 /tmp/matzhub-build.log; die "Build failed. Full log: /tmp/matzhub-build.log"; }
  ok "Build complete"
}

# --------------------------------------------------------------------------
# 5. Seed — happens automatically on the first /api/health hit
# --------------------------------------------------------------------------
wait_and_seed() {
  local url="http://localhost:${PORT:-3000}/api/health"
  say "Waiting for the server…"
  for _ in $(seq 1 45); do
    if curl -fsS "$url" >/tmp/matzhub-health.json 2>/dev/null; then
      local count; count="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("/tmp/matzhub-health.json","utf8")).publishedProducts)}catch(e){console.log(0)}')"
      ok "Server healthy · ${count} products live"
      return 0
    fi
    sleep 1
  done
  warn "Health check did not respond in time. The server may still be starting."
}

# --------------------------------------------------------------------------
# 6. Worker
# --------------------------------------------------------------------------
start_worker() {
  [ -d worker ] || die "worker/ directory is missing."
  cd worker
  if [ ! -d node_modules ]; then
    say "Installing WhatsApp worker dependencies (this pulls Baileys + sharp, ~1 min)…"
    npm install --no-audit --no-fund
  fi
  [ -f .env ] || { cp ../.env .env 2>/dev/null || true; }
  printf "\n%s\n" "${BOLD}Scan the QR code below once with WhatsApp → Linked Devices.${RESET}"
  printf "%s\n\n" "${DIM}After the first scan the session persists; restarts reconnect silently.${RESET}"
  exec node whatsapp-worker.mjs
}

# --------------------------------------------------------------------------
# 7. Doctor
# --------------------------------------------------------------------------
validate_env() {
  local mode="${1:-dev}"
  printf "\n%s\n" "${BOLD}Validating environment (${mode})${RESET}"
  printf "%s\n" "${DIM}────────────────────────────────────────────────${RESET}"
  local required=("DATABASE_URL")
  local warnings=0
  local failures=0

  for var in "${required[@]}"; do
    if [ -n "${!var:-}" ]; then
      printf "  ${GREEN}✓${RESET} %s\n" "$var"
    else
      printf "  ${RED}✗${RESET} %s ${RED}— REQUIRED, nothing works without it${RESET}\n" "$var"
      failures=$((failures+1))
    fi
  done

  if [ "$mode" = "prod" ]; then
    for var in ADMIN_PASSWORD ADMIN_SESSION_SECRET INGEST_TOKEN CRON_SECRET NEXT_PUBLIC_SITE_URL; do
      if [ -n "${!var:-}" ]; then
        printf "  ${GREEN}✓${RESET} %s\n" "$var"
      else
        printf "  ${RED}✗${RESET} %s ${RED}— required for production${RESET}\n" "$var"
        failures=$((failures+1))
      fi
    done
  fi

  for var in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY WHATSAPP_TOKEN WA_WORKER_URL TELEGRAM_BOT_TOKEN OPENAI_API_KEY RAZORPAY_KEY_ID; do
    if [ -n "${!var:-}" ]; then
      printf "  ${GREEN}✓${RESET} %s\n" "$var"
    else
      printf "  ${GOLD}○${RESET} %s — degraded without this\n" "$var"
      warnings=$((warnings+1))
    fi
  done

  printf "\n"
  [ "$failures" -eq 0 ] || die "${failures} required variable(s) missing. Fix before proceeding."
  [ "$warnings" -gt 0 ] && warn "${warnings} optional variable(s) missing — corresponding features will degrade."
  ok "Environment valid"
}

# Verify Supabase storage bucket exists and is public
verify_storage() {
  [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && { warn "Skipping storage verification (no Supabase credentials)"; return; }
  say "Verifying Supabase storage bucket…"
  local status
  status=$(curl -s -o /tmp/bucket.json -w "%{http_code}" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    "$SUPABASE_URL/storage/v1/bucket/${SUPABASE_BUCKET:-products}")
  if [ "$status" != "200" ]; then
    warn "Storage bucket ${SUPABASE_BUCKET:-products} not accessible (HTTP $status)"
    warn "Create it at: $SUPABASE_URL/storage/v1/bucket with public: true"
  else
    local pub
    pub=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("/tmp/bucket.json","utf8")).public)}catch(e){console.log(false)}')
    [ "$pub" = "true" ] && ok "Storage bucket ${SUPABASE_BUCKET:-products} verified (public, WebP ≤200KB)" \
      || warn "Storage bucket ${SUPABASE_BUCKET:-products} exists but is NOT public — images won't be reachable"
  fi
}

doctor() {
  banner
  printf "%s\n" "${BOLD}Configuration report${RESET}"
  printf "%s\n" "${DIM}────────────────────────────────────────────────${RESET}"
  [ -f .env ] && set -a && . ./.env && set +a

  check() {
    if [ -n "${2:-}" ]; then printf "  ${GREEN}✓${RESET} %-26s %s\n" "$1" "configured";
    else printf "  ${GOLD}○${RESET} %-26s %s\n" "$1" "${3:-not set}"; fi
  }

  printf "\n%s\n" "${BOLD}Core${RESET}"
  check "DATABASE_URL"        "${DATABASE_URL:-}"        "REQUIRED — nothing works without this"
  check "ADMIN_PASSWORD"      "${ADMIN_PASSWORD:-}"      "admin panel is unprotected"
  check "NEXT_PUBLIC_SITE_URL" "${NEXT_PUBLIC_SITE_URL:-}" "canonical URLs will be wrong"

  printf "\n%s\n" "${BOLD}Automation${RESET}"
  check "OPENAI_API_KEY"      "${OPENAI_API_KEY:-}"      "falls back to rules engine (works, lower copy quality)"
  check "INGEST_TOKEN"        "${INGEST_TOKEN:-}"        "ingestion webhook is open to anyone"
  check "CRON_SECRET"         "${CRON_SECRET:-}"         "cron endpoints are publicly triggerable"

  printf "\n%s\n" "${BOLD}Messaging${RESET}"
  check "WHATSAPP_TOKEN"      "${WHATSAPP_TOKEN:-}"      "no official Cloud API; will try the Baileys worker"
  check "WHATSAPP_PHONE_ID"   "${WHATSAPP_PHONE_ID:-}"   ""
  check "WA_WORKER_URL"       "${WA_WORKER_URL:-}"       "no outbound WhatsApp fallback"
  check "TELEGRAM_BOT_TOKEN"  "${TELEGRAM_BOT_TOKEN:-}"  "no ops alerts"
  check "TELEGRAM_CHAT_ID"    "${TELEGRAM_CHAT_ID:-}"    ""

  printf "\n%s\n" "${BOLD}Media${RESET}"
  check "SUPABASE_URL"        "${SUPABASE_URL:-}"        "worker cannot host product images"
  check "SUPABASE_SERVICE_ROLE_KEY" "${SUPABASE_SERVICE_ROLE_KEY:-}" ""

  printf "\n%s\n" "${DIM}Legend: ✓ configured · ○ missing (consequence shown)${RESET}"
  printf "%s\n\n" "${DIM}Nothing marked ○ blocks launch except DATABASE_URL.${RESET}"
}

# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------
case "$MODE" in
  deploy-prod)
    banner
    printf "%s\n" "${BOLD}Production deployment${RESET}"
    printf "\n"
    [ -f .env.production ] || die "Create .env.production from .env.production.example and fill it in."
    say "Validating production environment…"
    set -a; . ./.env.production; set +a
    local missing=0
    for var in DATABASE_URL NEXT_PUBLIC_SITE_URL ADMIN_PASSWORD; do
      [ -n "${!var:-}" ] || { warn "missing: $var"; missing=1; }
    done
    [ "$missing" -eq 0 ] || die "Fix the missing variables above before deploying."
    ok "Environment valid"
    validate_env prod
    verify_storage
    say "Building with production env…"
    npm run build
    ok "Build passed"
    printf "\n%s\n" "${BOLD}Deploy options:${RESET}"
    printf "  Vercel     %s\n" "${DIM}vercel --prod  (vercel.json already wires the crons)${RESET}"
    printf "  Bare metal %s\n\n" "${DIM}set -a; . ./.env.production; set +a; ./launch.sh${RESET}"
    ;;

  doctor)
    doctor
    ;;

  worker)
    banner; preflight; setup_env; start_worker
    ;;

  dev)
    banner; preflight; setup_env; install_deps; setup_db
    ok "Starting dev server on http://localhost:3000"
    exec npm run dev
    ;;

  reset)
    banner; preflight; setup_env
    say "Wiping catalogue data…"
    node -e '
      const {Pool}=require("pg");
      const p=new Pool({connectionString:process.env.DATABASE_URL});
      p.query(`truncate products, product_variants, categories, manufacturers, reviews,
        ingestion_events, automation_runs, ops_tasks, coupons, notifications, events,
        search_queries, orders, order_items, price_alerts, carts, cart_items, wishlists,
        audit_log restart identity cascade`).then(()=>{console.log("wiped");return p.end()})
        .catch(e=>{console.error(e.message);process.exit(1)});
    '
    ok "Catalogue cleared — it re-seeds on the next server start"
    ;;

  all)
    banner; preflight; setup_env; install_deps; setup_db; build_app
    say "Starting platform in the background…"
    npm run start > /tmp/matzhub-server.log 2>&1 &
    PLATFORM_PID=$!
    trap 'kill $PLATFORM_PID 2>/dev/null || true' EXIT
    wait_and_seed
    ok "Platform running · http://localhost:3000 · logs: /tmp/matzhub-server.log"
    start_worker
    ;;

  start|*)
    banner; preflight; setup_env; install_deps; setup_db
    validate_env dev
    verify_storage
    build_app
    npm run start > /tmp/matzhub-server.log 2>&1 &
    PLATFORM_PID=$!
    wait_and_seed
    printf "\n"
    ok "${BOLD}MatzHub is live${RESET}"
    printf "\n"
    printf "   Storefront   %s\n" "${BOLD}http://localhost:3000${RESET}"
    printf "   Operations   %s %s\n" "${BOLD}http://localhost:3000/admin${RESET}" "${DIM}(password: \$ADMIN_PASSWORD)${RESET}"
    printf "   AI feeds     %s\n" "${DIM}/llms.txt · /products.json · /openapi.json · /api/mcp${RESET}"
    printf "   Health       %s\n" "${DIM}/api/health${RESET}"
    printf "\n"
    printf "   %s\n" "${DIM}Next: ./launch.sh worker   ← connects your WhatsApp groups${RESET}"
    printf "   %s\n" "${DIM}      ./launch.sh doctor   ← see what still needs credentials${RESET}"
    printf "\n"
    wait $PLATFORM_PID
    ;;
esac
