# passkey v1 — passkeys as a second unlock path (proposal)

Status: **proposal, not implemented.** Reviewed by an independent second opinion
([docs/reviews/2026-10-02-passkey-second-opinion.md](../reviews/2026-10-02-passkey-second-opinion.md)).
Implementation waits for the owner to approve the dependency and the second-factor policy in §6.

## 1. Why a plain passkey is not enough

In [auth v1](auth-v1.md) a session is not an unlock. The browser needs the KEK, derived from the
password, to unwrap the Account Key. A passkey that only signs in (WebAuthn assertion → session
cookie) would replace the TOTP step and still ask for the password a moment later. Users would
see no benefit.

So passkey v1 is only worth building with the WebAuthn **PRF extension** (`hmac-secret` under the
hood). PRF returns a 32-byte secret that only that credential can produce, and only after user
verification. That secret becomes a second KEK.

## 2. Key hierarchy

```text
prf     = WebAuthn PRF(credential, salt = SHA-256("quancard.passkey.v1|prf"))
KEK_pk  = HKDF-SHA256(prf, salt = 32 zero bytes, info = "quancard.passkey.v1|kek|" ‖ rpId ‖ "|" ‖ ACCOUNT-UUID ‖ "|" ‖ b64url(credentialID))
wrapped = envelope.v1(accountKey.v1 plaintext, parent = KEK_pk, objectKind = "accountKey.v1", recordID = accountID)
```

- The Account Key itself does not change. Each passkey stores **one more wrapped copy** of it
  (`wrappedAccountKey`, per credential), next to the password-wrapped copy that already exists.
- The server stores only `{credentialID, publicKey (COSE), signCount, transports, aaguid, name,
  wrappedAccountKey, createdAt, lastUsedAt}`. It never sees `prf`, `KEK_pk` or the Account Key.
- `prf` is 256 bits from the authenticator. The passkey-wrapped copy is therefore far stronger
  against offline guessing than the password-wrapped copy. The weakest link stays the password,
  exactly as today.

## 3. Flows

**Register** (signed in, unlocked, with a fresh password confirmation):

1. `POST /api/v1/account/passkeys/options` → creation options (`rp.id` = host of `QC_PUBLIC_ORIGIN`,
   `residentKey: required`, `userVerification: required`, `attestation: none`, single-use
   challenge, 2-minute TTL, `excludeCredentials` = existing ones).
2. `navigator.credentials.create()` with `extensions.prf.eval.first = salt`.
3. If the result does not report `prf.enabled`, **stop**. No credential is registered. The UI
   explains that this authenticator cannot unlock the vault. Half a feature (sign-in that still
   needs the password) is worse than none.
4. Some authenticators return PRF results only from `get()`. In that case run one `get()` right
   away, restricted to the new credential.
5. Wrap the in-memory Account Key under `KEK_pk` and send
   `POST /api/v1/account/passkeys {attestationResponse, name, wrappedAccountKey}`. The server
   verifies the attestation (`none`), the origin, the RP ID hash, UV, and that the challenge is
   unused. It also checks that `wrappedAccountKey` is a structurally valid `accountKey.v1`
   envelope bound to `accountID`.

**Sign in and unlock** (signed out):

1. `POST /api/v1/auth/passkey/options` → request options with an empty `allowCredentials`
   (discoverable credentials), `userVerification: required`, single-use challenge.
2. `navigator.credentials.get()` with `extensions.prf.eval.first = salt`. The salt does not depend on
   the account, because the account is unknown before the assertion. PRF outputs are already
   per credential and per RP, and `KEK_pk` binds the `credentialID` through the HKDF info.
3. `POST /api/v1/auth/passkey/verify {assertion}` → the server verifies the signature, the
   counter (it rejects a regression when either value is non-zero), UV and the challenge. It then
   issues a session and returns the account view **plus that credential's `wrappedAccountKey`**.
4. The client derives `KEK_pk` from the PRF output and unwraps the Account Key. Then the vault
   opens exactly as after a password sign-in.

**Unlock after lock** (session still valid): the same assertion against
`POST /api/v1/account/passkeys/unlock` returns that credential's `wrappedAccountKey`. No new
session is issued.

**Remove**: `DELETE /api/v1/account/passkeys/:id` requires a fresh password `authKey`.

**Password change** leaves passkeys alone, because the Account Key does not change.
**Account deletion** deletes them. **Revoke other sessions** does not delete passkeys.

## 4. Security boundaries (go into THREAT_MODEL §2.9)

1. **The RP ID is the server's hostname.** Moving the server to another domain makes every passkey
   unusable. The password is never optional, and Settings shows "Works on vault.example.com".
2. **No sharing with the native iOS app for arbitrary domains.** A prebuilt app declares its
   `webcredentials:` associated domains statically in its entitlements, so it cannot cover any
   self-hosted domain a user picks. A custom build for a known domain could. The
   iPhone does not need it anyway: it holds the sync key from pairing. A passkey synced through
   iCloud Keychain does work in Safari on iPhone, but only for the web app.
3. **Second factor.** A UV passkey counts as two factors (possession plus biometric or PIN), so
   passkey sign-in skips TOTP. Bitwarden and GitHub do the same. *Needs owner approval.*
4. **Fresh authentication stays password-based in v1.** Pairing, password change, TOTP changes and
   account deletion re-send a password `authKey`. Revealing card details (a local check today)
   may accept a fresh passkey assertion instead.
5. **A malicious server's JavaScript** can capture the PRF output just as it can capture a typed
   password ([THREAT_MODEL §2.4](../../THREAT_MODEL.md#24-malicious-or-compromised-server--not-fully-defended)).
   Passkeys neither add to nor remove that risk.
6. **Rate limits and audit**: options and verify share the login limiter. Each register, sign-in
   and removal writes an audit event.
7. **Lost authenticator**: remove it from Settings on another signed-in browser, or sign in with
   the password. Losing every passkey loses no data while the password and the second factor (or
   recovery codes) are still available.

## 5. Phases

| Phase | Scope |
| --- | --- |
| P0 (this document) | Spec, threat model, independent review |
| P1 | `passkey_credentials` table; register, sign-in and unlock endpoints; web Settings (add, rename, remove); "Sign in with passkey" button; Playwright with a CDP virtual authenticator (`hasPrf: true`) |
| P2 | Passkey as fresh authentication for reveal. **Passkey-based password reset**: unwrap with `KEK_pk`, re-wrap under a new password. This is the first real recovery path for the "no reset" model, and it needs its own ADR. |

## 6. Decisions the owner must make

- Adding `@simplewebauthn/server` (MIT; CBOR/COSE parsing should not be hand-written) to the
  server, which today has four runtime dependencies.
- Whether passkey sign-in skips TOTP (recommended: yes, UV required).
- Browser support for PRF (Safari 18+/iOS 18+, Chrome 116+ with platform or hybrid authenticators,
  Windows Hello, recent security keys). The matrix changes often, so check it again when
  implementing.

## 7. Preconditions before P1 (from the second opinion)

The [2026-10-02 review](../reviews/2026-10-02-passkey-second-opinion.md) scored this 3/5. P1 does
not start until each item below is specified and tested.

1. **The PRF output never leaves the browser.** Registration and assertion bodies are built from an
   explicit field allow-list (`id`, `rawId`, `type`, `response.*`). `clientExtensionResults` is
   never serialized. An e2e test asserts that no request body, log line or audit row contains the
   PRF output.
2. **Key lifecycle.** After a passkey unlock, password confirmation unwraps the password-wrapped
   copy with the password KEK and compares it with the current Account Key in constant time, in
   place of `authCheck`. Registration runs only right after a fresh password confirmation, which
   briefly yields the raw Account Key; it is zeroed after wrapping. Before the copy is uploaded,
   the client checks that the new wrapped copy unwraps to the same key. A failed unlock clears
   every partially published key.
3. **Account binding.** `credentialID` is unique across the server. `user.id` is a random 32-byte
   handle, not the username. On verify, the server checks the credential lookup against
   `userHandle`. An unlock inside a session accepts only credentials of that session's account.
4. **Challenges** record the operation (`register`, `register-confirm`, `login`, `unlock`), the
   account and session where they apply, and the security stamp. They are consumed atomically
   and expire after 2 minutes. Session issuance re-checks that the credential still exists.
5. **Revocation.** Removing a passkey deletes its wrapped copy and every session that the passkey
   created. The UI states that an attacker who already holds both an old copy and the
   authenticator is outside what removal can undo. Changing the password does not remove
   passkeys, and the UI says so.
6. **Recovery wording.** Losing every passkey loses no data *as long as* the password and the
   second factor (or recovery codes) are still available.
7. **HKDF info** is `"quancard.passkey.v1|kek|" ‖ rpId ‖ "|" ‖ UPPERCASE(accountID) ‖ "|" ‖
   base64url(credentialID)`, with fixed test vectors. **signCount**: reject only a regression
   where both values are non-zero, and audit it.
