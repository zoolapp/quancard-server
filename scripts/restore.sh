#!/usr/bin/env sh
# Restores a backup produced by backup.sh. Stops the app, verifies the file, swaps it in, starts again.
# Usage: scripts/restore.sh backups/quancard-<timestamp>.sqlite
set -eu
cd "$(dirname "$0")/.."
COMPOSE="${COMPOSE:-docker compose}"
FILE="${1:-}"
[ -f "$FILE" ] || { echo "usage: scripts/restore.sh <backup.sqlite>" >&2; exit 64; }

$COMPOSE stop quancard
# Verify integrity and schema version with the same image before touching live data.
$COMPOSE run --rm --no-deps -T -v "$(pwd)/${FILE}:/restore/incoming.sqlite:ro" quancard \
  node dist/cli.js check /restore/incoming.sqlite
$COMPOSE run --rm --no-deps -T -v "$(pwd)/${FILE}:/restore/incoming.sqlite:ro" quancard \
  sh -c 'rm -f /data/quancard.sqlite-wal /data/quancard.sqlite-shm && cp /restore/incoming.sqlite /data/quancard.sqlite.restoring && mv /data/quancard.sqlite.restoring /data/quancard.sqlite'
$COMPOSE start quancard
echo "Restored ${FILE}."
