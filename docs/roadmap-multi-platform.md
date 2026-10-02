# Roadmap: one server for iPhone, web, macOS and later clients

Status: 2026-10-02. This page answers one question: what should be hardened before
quancard-server is the backend for every QuanCard client, not only the iPhone and its web
companion? Items are ordered by priority. "Done" means shipped in web v2 (0.2.0, unreleased).

## Done in web v2

| Item | Why it matters for more clients |
| --- | --- |
| `GET /api/v1/status` returns `capabilities` and `limits` | New clients branch on features (payload schemas, pairing version, 2FA kinds, passkeys, multiple vaults), never on the version string. |
| Issuer palettes and the design matcher ported from iOS | Every client draws the same face for the same item (`artworkTemplateID: "issuer.hsbc"` no longer falls back to grey on the web). |
| Sample data with the iOS IDs and tags | Samples seeded on any client can be recognised and removed on every other. |
| Background sync (on focus, every 60 s while visible) | Edits from another device appear without a manual refresh. |
| PWA manifest and app icons | macOS and Windows users can install the web vault as an app today (Chrome / Edge “Install”, Safari “Add to Dock”). No service worker: the vault lives only in memory, and an offline cache would give a malicious script more places to hide. |
| Passkey evaluation and spec | See [protocol/passkey-v1.md](protocol/passkey-v1.md) and its [second opinion](reviews/2026-10-02-passkey-second-opinion.md). |

## Next, in order

1. **Choose how a macOS app signs in.** Recommended: start it as a *paired device*, exactly
   like the iPhone (pairing v1: QR or `quancard://pair/v1?...` link, per-vault device token, no
   account password in the app). It needs no new server code and keeps the account password in
   one place. A full account sign-in (auth v1 in Swift) can follow later if users want macOS
   without a phone. Add "copy pairing link" to the web pairing dialog, because Macs cannot scan QR
   codes easily (45-second clipboard clear plus a warning that the link contains the vault key).
2. **One source of truth for shared catalogues.** `IssuerPalettes.json` now exists in the iOS
   repository and in `apps/web/src/issuers.json`. Move it, the sample catalogue and the template
   list into a versioned package (or a signed reference pack fetched from the server), and add a
   CI check that compares hashes with the iOS copy.
3. **sync v2: photos as separate blobs, plus history compaction.** In sync v1 each revision
   embeds the photo, so editing a card with a photo re-uploads it. The 64 MiB quota fills up with
   photos long before it fills with cards. This needs a new ADR and shared test vectors on both
   sides.
4. **Encrypted export/import (`.qvault`) in the browser**, using the same format as iOS. Desktop
   users expect a file backup they control.
5. **Rollback detection on the web** (THREAT_MODEL §2.4). Persist `lastSeq` and a digest of the
   heads, which are not secret, so the browser notices when a server goes back in time. Needs a
   threat-model review.
6. **Passkey P1**, once the seven preconditions in passkey-v1 §7 are written down and the owner
   has approved the dependency and the TOTP policy.
7. **Change notifications** instead of polling: one Server-Sent Events stream per session or
   device token that only says "vault X has new revisions". Native clients get timely sync
   without push certificates, which a self-hosted server cannot have.
8. **Generated clients.** `docs/protocol/openapi.yaml` already describes every endpoint.
   Generate Swift and TypeScript clients in CI, so a protocol change breaks the build instead of
   an app. Write down a deprecation policy (for example, one minor release of overlap).
9. **Reduce trust in server-delivered JavaScript.** Ship reproducible builds and publish bundle
   hashes. Longer term, a signed desktop app or browser extension can carry the web client
   itself, so a compromised server cannot change the code that handles keys.
10. **Multiple vaults in the UI.** The server already supports them; the web opens only
    `vaults[0]`.
11. **Per-device settings and hygiene**: rename devices, show the last sync per device, rate
    limits per device token, and an admin `/metrics` endpoint (no user data) for self-hosters.
12. **Localisation parity** with iOS: Traditional Chinese and Japanese on the web.

## Not planned

- Push notifications through Apple or Google: they need the operator's push credentials and leak
  metadata to a third party.
- Server-side search or indexing: incompatible with zero knowledge.
