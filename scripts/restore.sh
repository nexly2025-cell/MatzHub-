#!/usr/bin/env bash
# Restore a MatzHub database dump. Accepts .sql or the .sql.gz produced by the
# nightly GitHub Actions backup.
#
#   ./scripts/restore.sh backups/matzhub_db_20260814_030000.sql.gz
set -euo pipefail

[ $# -ge 1 ] || { echo "Usage: $0 <backup-file[.gz]>"; exit 1; }
FILE="$1"
[ -f "$FILE" ] || { echo "No such file: $FILE"; exit 1; }
DB_URL="${DATABASE_URL:?DATABASE_URL is required}"

echo "Restoring $FILE"
echo "Target: ${DB_URL%%\?*}"
# The dump is --clean --if-exists, so it drops and recreates every object.
read -r -p "This replaces the current database. Type yes to continue: " ok
[ "$ok" = "yes" ] || { echo "Aborted."; exit 1; }

case "$FILE" in
  *.gz) gunzip -c "$FILE" | psql "$DB_URL" ;;
  *)    psql "$DB_URL" < "$FILE" ;;
esac

echo "Restore complete."
