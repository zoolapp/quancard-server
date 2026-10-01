#!/usr/bin/env sh
# Creates .env with fresh random secrets. Never overwrites an existing .env.
# Usage: scripts/init-env.sh <domain>     e.g. vault.example.com (or "localhost" for local trial)
set -eu
cd "$(dirname "$0")/.."

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: scripts/init-env.sh <domain>   (e.g. vault.example.com, or localhost)" >&2
  exit 64
fi
case "$DOMAIN" in
  http://*|https://*|*/*) echo "Give a bare host name such as vault.example.com" >&2; exit 64 ;;
esac
if [ -e .env ]; then
  echo ".env already exists; leaving it unchanged." >&2
  exit 0
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 69; }

umask 077
SECRET="$(openssl rand -hex 32)"
SETUP_TOKEN="$(openssl rand -hex 16)"
cat > .env <<ENV
# QuanCard server configuration. Keep this file private and back it up with your data:
# QC_SECRET also protects two-step verification secrets at rest.
QC_DOMAIN=${DOMAIN}
QC_SECRET=${SECRET}
# One-time token for creating the owner account. Remove it after setup if you like.
QC_SETUP_TOKEN=${SETUP_TOKEN}
ENV
chmod 600 .env
echo "Created .env for ${DOMAIN}."
echo "Owner setup token: ${SETUP_TOKEN}"
