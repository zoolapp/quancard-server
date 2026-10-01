# Independent security review — 2026-10-01

Reviewer: a different model family (read-only, adversarial), over the full server, web client,
protocol package, deployment files and threat model. Score before fixes: **2/5 release readiness**;
no critical cryptographic break found. All blockers below were fixed in the same change set and are
covered by regression tests. This is an internal review, not an independent third-party audit.

## Findings and resolution

| ID | Severity | Finding | Resolution | Test |
| --- | --- | --- | --- | --- |
| F1 | high | TOTP step / recovery code could be reused by concurrent logins; TOTP enabled mid-login could be skipped | Argon2 first, then re-read the row in one synchronous `BEGIN IMMEDIATE` transaction; compare-and-set consumption | `concurrency.test.ts` F1 |
| F2 | high | Lockout counter lost updates; wrong second factors had no per-account budget | Atomic SQL increment; second-factor and re-auth failures count toward lockout | F2 ×2 |
| F3 | high | Concurrent password changes could overwrite each other from stale proofs | Fresh-auth re-validates stamp, verifier and session after the await; update conditioned on the stamp (`409 staleCredentials`) | F3 |
| F4 | high | Unlock/refresh/save finishing after lock could restore keys or plaintext | Lock generation for the session; `VaultStore` closed state checked after every await, before upload and before merging | web `vault.test.ts` F4 |
| F5 | high | Two tabs sharing an installation ID could write duplicate sync clocks and make the vault unloadable | Random installation per opened store, synchronous counter reservation, serialized writes; nothing stored in localStorage | web F5 |
| F6 | high* | Forwarded headers and the localhost exemption were not bound to the connecting peer | Honoured only from loopback/private peers (bundled proxy); proxy-address function restricted the same way | F6 ×2 |
| F7 | medium | Any `Bearer …` header skipped CSRF checks while auth fell back to the cookie | Only a well-formed device token is exempt; any Authorization header disables cookie auth | F7 |
| F8 | medium | Setup and invite registration not atomic; setup token reusable after deleting the last account | Hash first, then check-and-insert in one transaction; unique-owner index; consumed setup token recorded | F8 ×2 |
| F9 | medium | Background 60 s lock not timed; reveal grace survived lock | Background timer plus visibility check; grace revoked on lock | covered by code review |
| F10, F13 | medium | Threat-model wording overstated (QR 10-minute “exposure”, authKey entropy, “two layers”, TLS, iPhone safety, “never stores PINs”) | Rewritten; QR key exposure is indefinite; password change is re-wrapping, not rotation | — |
| F11 | medium | Unreadable records advanced the cursor; doc implied browsers detect rollback | Cursor stops before the first unreadable record and retries; doc states the web client cannot detect rollback | web F11 |
| F12 | medium | JS integers vs Swift Int64 | iOS emits small counters and index-based sort positions; out-of-range values are treated as unreadable, documented | — |

\* Severity depends on deployment: the default compose never publishes the app port.

## Synthesis

**Agreed.** The server races (F1–F3, F8) share one root cause — acting on state read before an Argon2
await — and the web races (F4, F5) are real. The threat model overstated several guarantees.

**Disagreed.** F12 is not a compatibility blocker: the iOS writer produces counters that increment by
one and sort positions that are list indices, so valid data stays far below 2^53; documenting the
boundary is sufficient. F6 is lower than high for the default deployment, but trust should not depend
on network topology alone, so it was fixed anyway.

**Decision.** The review was right where our own pass was blind: we reasoned about single requests,
not interleavings across awaits or multiple tabs. All blockers were fixed with tests that exercise the
interleavings; the re-run results are recorded in the commit that adds this file.

## Open items (not blockers for a development preview)

- Published per-release web bundle hashes are produced by the release workflow; reproducible builds
  across machines are not yet verified.
- Client-side resource budgets for malicious server responses (entry counts per page) are bounded by
  page limits only.
- The iPhone side of pairing v1 is specified but not implemented.
