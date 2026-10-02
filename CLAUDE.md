# quancard-server — notes for coding agents

Self-hosted, zero-knowledge sync server and web vault for the QuanCard iPhone app
(iOS repo: `../quan-card`). Read `THREAT_MODEL.md` and `docs/protocol/` before touching
keys, payloads or sessions.

## Checks

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint
pnpm exec playwright test e2e/vault.spec.ts                       # main story, fresh server
UI_ACCEPTANCE=1 pnpm exec playwright test e2e/ui-acceptance.spec.ts # UI gate, separate run
```

The server caches `index.html` at start-up: restart it after every web build.

## UI 基准

- Current baseline: web v2 — `docs/screenshots/v2/` + `docs/verification/ui-acceptance-2026-10-02.md`.
- Previous: 0.1.x — `docs/screenshots/mvp/` + `docs/verification/ui-acceptance-2026-10-01.md`.
- Visual reference: the iOS v3 language (`../quan-card/QuanCard/DesignSystem/Theme.swift`):
  white / pure black, hairlines, light display type, monochrome controls. Saturated colour lives
  only on card faces and the otter. Warm sand stays on the character, never in the interface.

## Rules that are easy to break

- Sample data (`apps/web/src/demo.ts`) mirrors iOS `DemoData.swift`: the same item IDs and the
  same sample tags (`示例` / `範例` / `Demo`). Change both sides together.
- Do not copy `../quan-card/QuanCard/DemoCardFaces/` (unlicensed card photos) or issuer, network
  or wallet logos into this public repository without a trademark review.
- CSP is `style-src 'self'`: no inline `<style>`. Preact `style={{…}}` objects are fine (CSSOM).
- Credentials: none are needed for development. Do not commit `.env`.
