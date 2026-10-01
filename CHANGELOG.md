# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## 0.1.0 — unreleased

First development preview.

- Zero-knowledge sync server for the QuanCard sync v1 protocol: immutable opaque revisions, per-vault
  quotas, idempotent writes, incremental paging.
- Accounts (auth v1): Argon2id + HKDF in the browser, owner setup token, invites, sessions,
  TOTP two-step verification with recovery codes, lockout and rate limits, append-only audit log.
- iPhone pairing v1: single-use, 10-minute codes; vault key delivered by QR, never to the server;
  per-vault device tokens with revocation.
- Web client: cards and bank accounts, region filters, search, favourites, masked details with
  password-gated reveal, card photos re-encoded in the browser, conflict resolution, settings,
  English and Simplified Chinese, light and dark mode.
- Deployment: hardened image, HTTPS-by-default compose with Caddy, local evaluation compose,
  backup/restore scripts, one-step installer.
