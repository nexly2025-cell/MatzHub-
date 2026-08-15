#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/app_db}"
OUT="$BACKUP_DIR/matzhub_db_$TS.sql"
pg_dump --no-owner --clean --if-exists "$DB_URL" > "$OUT"
echo "Backup: $OUT"
