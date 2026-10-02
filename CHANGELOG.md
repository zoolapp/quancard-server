# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## Unreleased (0.2.0)

Web v2: a branded, desktop-class web app.

- App frame: sidebar with library (cards, accounts, favourites) and region navigation, account
  chip with sync time; phone layout keeps tabs, chips and the add button.
- ⌘K / Ctrl+K command palette for items and actions (replaces inline search).
- Detail and editor open as a side sheet over the collection (full screen on phones); background
  is inert while a sheet is open.
- QuanCard brand: otter lockup, guardian otter on the lock screen, kaka favicon, app icons and a
  web app manifest; split-screen sign-in with issuer card faces.
- Card faces match iOS: 71 issuer palettes with decor, short issuer names, the QuanCard welcome
  card face; the editor suggests the issuer template from the bank name.
- Sample data mirroring the iOS catalogue (same IDs and tags): a new vault starts with the
  welcome card; load or remove 15 cards and 6 accounts from the empty state or Settings.
  Encrypted like any other item.
- Automatic sync when the tab regains focus and every 60 seconds while visible.
- `GET /api/v1/status` reports `capabilities` and `limits` for other clients.
- Invite links pasted into an open tab now work.
- Passkey v1 proposal with an independent review (not implemented), and a multi-platform
  roadmap.

## 0.1.1 — 2026-10-01

- One-step installer clones the pinned release and falls back to building the image from source when
  the published image cannot be pulled; the image tag is pinned in `.env`.

## 0.1.0 — 2026-10-01

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
