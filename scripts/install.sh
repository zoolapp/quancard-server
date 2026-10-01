#!/usr/bin/env sh
# One-step install on a fresh Linux host with Docker:
#   curl -fsSL https://raw.githubusercontent.com/zoolapp/quancard-server/v0.1.1/scripts/install.sh -o install.sh
#   less install.sh            # read it first — this is a security product
#   sh install.sh vault.example.com
set -eu
DOMAIN="${1:-}"
DIR="${QC_INSTALL_DIR:-$HOME/quancard}"
# Pin a release tag by default; set QC_REF=main only to try unreleased code.
REF="${QC_REF:-v0.1.1}"

[ -n "$DOMAIN" ] || { echo "usage: sh install.sh <domain>" >&2; exit 64; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/engine/install/" >&2; exit 69; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 69; }

command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 69; }

# A full checkout of the pinned tag, so the image can always be built from reviewed source.
if [ ! -d "$DIR/.git" ]; then
  git clone --quiet --depth 1 --branch "$REF" https://github.com/zoolapp/quancard-server.git "$DIR"
fi
cd "$DIR"
scripts/init-env.sh "$DOMAIN"
# Pin the image to the installed release so later `docker compose` commands use the same version.
grep -q '^QC_IMAGE_TAG=' .env || echo "QC_IMAGE_TAG=${REF#v}" >> .env
# Prefer the published image; fall back to building the same tag locally.
if ! docker compose pull quancard 2>/dev/null; then
  echo "Published image not available; building from source (this takes a few minutes)."
  docker compose build quancard
fi
docker compose up -d --wait
echo
echo "QuanCard is running at https://${DOMAIN}"
echo "Open it and create the owner account with the setup token printed above (also in $DIR/.env)."
