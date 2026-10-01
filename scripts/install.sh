#!/usr/bin/env sh
# One-step install on a fresh Linux host with Docker:
#   curl -fsSL https://raw.githubusercontent.com/zoolapp/quancard-server/main/scripts/install.sh -o install.sh
#   less install.sh            # read it first — this is a security product
#   sh install.sh vault.example.com
set -eu
DOMAIN="${1:-}"
DIR="${QC_INSTALL_DIR:-$HOME/quancard}"
REF="${QC_REF:-main}"
BASE="https://raw.githubusercontent.com/zoolapp/quancard-server/${REF}"

[ -n "$DOMAIN" ] || { echo "usage: sh install.sh <domain>" >&2; exit 64; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/engine/install/" >&2; exit 69; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 69; }

mkdir -p "$DIR/deploy" "$DIR/scripts"
cd "$DIR"
for f in compose.yaml deploy/Caddyfile scripts/init-env.sh scripts/backup.sh scripts/restore.sh; do
  curl -fsSL "$BASE/$f" -o "$f"
done
chmod +x scripts/*.sh
scripts/init-env.sh "$DOMAIN"
docker compose pull
docker compose up -d --wait
echo
echo "QuanCard is running at https://${DOMAIN}"
echo "Open it and create the owner account with the setup token printed above (also in $DIR/.env)."
