#!/usr/bin/env sh
# Online, consistent backup of the encrypted database to ./backups/.
# The backup holds ciphertext only. Keep .env (QC_SECRET) alongside it to restore 2FA.
set -eu
cd "$(dirname "$0")/.."
COMPOSE="${COMPOSE:-docker compose}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="quancard-${STAMP}.sqlite"
mkdir -p backups
$COMPOSE exec -T quancard node dist/cli.js backup "/data/${NAME}"
$COMPOSE cp "quancard:/data/${NAME}" "backups/${NAME}"
$COMPOSE exec -T quancard rm -f "/data/${NAME}"
chmod 600 "backups/${NAME}"
echo "backups/${NAME}"
