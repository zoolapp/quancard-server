# Contributing

Thanks for helping. QuanCard Server protects people's financial records, so the bar for changes is
deliberately high.

## Ground rules

1. **Never use real data.** Tests, fixtures, screenshots, issues and logs use only synthetic values
   (`TEST_ONLY`, `0000…`, the public vectors). No real card numbers, CVCs, account numbers,
   passwords, backups or `.env` files — not even “redacted” ones.
2. **The server stays zero-knowledge.** No change may give the server access to plaintext, keys or
   passwords, add server-side decryption, or log request bodies, headers or query strings.
3. **No tracking.** No analytics, telemetry, crash reporting, CDNs, remote fonts or other
   third-party requests in the server or the web client.
4. **Protocol changes need a specification.** Anything that changes bytes on the wire or at rest
   (envelopes, payload schema, KDF parameters, auth v1, pairing v1) needs an updated document in
   `docs/protocol/`, new public test vectors, a migration path, and must stay compatible with the
   QuanCard iPhone app. Vectors in `vectors/` are copied from the iOS project and must not be edited.
5. **PINs, track data and bank passwords are never supported**, by design.

## Workflow

```sh
corepack enable && pnpm install
pnpm -r build && pnpm -r typecheck && pnpm lint
pnpm -r test
pnpm exec playwright test
```

- Keep pull requests small and focused; include tests (write the failing test first for security or
  data bugs).
- UI changes: check light and dark mode, a 390 px wide phone, keyboard navigation and screen-reader
  labels; update screenshots in `docs/screenshots/` when the look changes.
- Sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).

Security issues: follow [SECURITY.md](SECURITY.md), not the public tracker.
