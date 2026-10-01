# auth v1 — accounts, keys and sessions

Status: implemented in `packages/protocol/src/account.ts` and `apps/server/src/routes/auth.ts`.
Changing any value below requires a new version and migration, never an in-place edit.

## 1. Primitives

All encryption uses `quancard.envelope.v1` (see [sync-v1.md](sync-v1.md#1-envelope-v1)): a random
256-bit DEK seals the payload with AES-256-GCM; the DEK is wrapped with AES-256-GCM under the
parent key; both boxes authenticate `quancard.envelope.v1|<stage>|<objectKind>|<UPPERCASE-UUID>`.

| Parameter | Value |
| --- | --- |
| Password normalisation | Unicode NFC, then UTF-8; no trimming or case folding; 1–1,024 bytes |
| Creation policy | ≥ 15 Unicode code points (NIST SP 800-63B-4 style; no composition rules) |
| KDF | Argon2id v1.3, memory 65,536 KiB, iterations 3, parallelism 1, output 32 bytes |
| Salt | 16 random bytes per account, regenerated on every password change |
| Split | HKDF-SHA256, salt = 32 zero bytes, info `quancard.auth.v1\|auth` → `authKey` (32 bytes); info `quancard.auth.v1\|kek` → `KEK` (AES-256) |

```text
master = Argon2id(NFC(password), salt)
authKey = HKDF(master, "quancard.auth.v1|auth")   → sent to the server
KEK     = HKDF(master, "quancard.auth.v1|kek")    → never leaves the client
```

## 2. Key objects

| Object | objectKind | recordID | Plaintext (canonical JSON, sorted keys) | Wrapped by |
| --- | --- | --- | --- | --- |
| Account Key | `accountKey.v1` | account UUID | `{"accountID":…,"key":<base64 32 bytes>,"version":1}` | KEK |
| Vault key | `vaultKey.v1` | vault UUID | `{"key":<base64 32 bytes>,"vaultID":…,"version":1}` | Account Key |

The vault key is the same random sync root key (SRK) the iPhone uses for sync v1. It is generated
with a CSPRNG, never derived from a password, device or account identifier.

## 3. Server-side verification

The server stores `verifier = Argon2id(authKey, verifierSalt, m=19,456 KiB, t=2, p=1)` with a fresh
16-byte `verifierSalt`, and compares in constant time. `authKey` is a 256-bit *output*, but its
resistance to guessing is only that of the password behind the client-side KDF. It is a replayable
login credential, not a PAKE proof. The second hash ensures a leaked database cannot be replayed
directly as a login; it adds little against offline password guessing, which can target the wrapped
Account Key instead.

## 4. Flows

**Owner setup** (`POST /api/v1/setup`): allowed only while no account exists and the request carries
`QC_SETUP_TOKEN` (constant-time comparison). The client sends `username`, `accountID` (UUID v4),
`kdfSalt`, `authKey` and `wrappedAccountKey`. The server checks the wrapped key is a structurally
valid `accountKey.v1` envelope bound to `accountID`.

**Invites** (`POST /api/v1/invites`, owner only): a random 18-byte code, single use, valid 7 days,
stored as SHA-256. The link carries it in the URL fragment (`/#invite=…`), which browsers do not send
to servers. `POST /api/v1/register` mirrors setup.

**Sign-in**: `POST /api/v1/auth/prelogin {username}` returns the KDF descriptor and salt. Unknown
usernames receive a stable decoy salt `HMAC(server key, "prelogin" ‖ lowercase(username))[0..16]`.
The client derives `authKey`, then `POST /api/v1/auth/login {username, authKey, totp?|recoveryCode?}`
returns the account view (including `wrappedAccountKey`) and sets the session cookie. The client
unwraps the Account Key locally; a wrong password fails there as well.

**Unlock** (session still valid, keys gone after reload or lock): `GET /api/v1/account`, derive, unwrap.
No credential is sent.

**Password change** (`POST /api/v1/account/password`): requires `currentAuthKey`. The client
unwraps the Account Key with the old KEK, derives a new salt/authKey/KEK and re-wraps the same
Account Key. Vault keys and revisions are untouched — this is re-wrapping, not key rotation. The
server commits only if the account's security stamp is unchanged since the proof was checked
(`409 staleCredentials` otherwise), rotates the stamp, deletes every session and pending pairing
code, then issues a fresh session to the caller. Paired devices are not revoked.

**Owner setup token** is single use: once an owner is created its hash is recorded, and an emptied
server needs a new `QC_SETUP_TOKEN` value to run setup again.

**Concurrency.** Handlers finish all Argon2 work first, then re-read the account inside one
synchronous `BEGIN IMMEDIATE` transaction and commit with conditional updates; a proof checked
against state that changed meanwhile is rejected.

**Fresh authentication** for sensitive actions (pairing, vault deletion, TOTP changes, account
deletion) re-sends `authKey` derived from a newly typed password; rate limited per account.

## 5. Sessions

- Token: 32 random bytes (base64url) in cookie `__Host-qc_session`: `HttpOnly; Secure; SameSite=Strict; Path=/`, no `Domain`.
- Server stores only SHA-256(token), the account’s security stamp, timestamps and a coarse client label (`Chrome · macOS`).
- Lifetime: 30 minutes idle, 12 hours absolute. Invalid, expired or stamp-mismatched sessions are deleted on sight.
- Browser writes must also send `Origin: <QC_PUBLIC_ORIGIN>` and `X-QuanCard-Client: web`.

## 6. Two-step verification (TOTP)

RFC 6238, SHA-1, 6 digits, 30-second steps, ±1 step skew. The secret (20 random bytes) is stored
encrypted with AES-256-GCM under `HKDF(QC_SECRET, "quancard.server.v1|at-rest")` and bound to the
account ID as AAD. The last accepted step is recorded; codes from that step or earlier are rejected
(replay protection). Enabling returns ten single-use recovery codes (80 bits each), stored as
`HMAC(server key, normalised code)`.

## 7. Abuse controls

| Control | Limit |
| --- | --- |
| Each credential endpoint per client tag (`setup`, `register`, `prelogin`, `login`, `pairings/claim` — counted separately) | 10 / minute |
| Fresh-auth endpoints per account | 10 / minute |
| Consecutive failures per account (wrong password, wrong second factor, failed re-authentication; any source; atomic) | 10 → account locked 15 minutes (`429 accountLocked`) |
| Unknown user login | Same Argon2id work as a real check |

Client tags are `HMAC(server key, IP)[0..8]`; raw IP addresses are never stored.

## 8. Error codes

`invalidCredentials`, `secondFactorRequired`, `invalidSecondFactor`, `accountLocked`, `staleCredentials`,
`rateLimited`, `setupClosed`, `invalidSetupToken`, `usernameTaken`, `invalidUsername`,
`invalidInvite`, `totpAlreadyEnabled`, `totpNotPending`, `confirmationMismatch`, `ownerHasMembers`,
`unauthorized`, `forbidden`, `badRequest`. Responses never echo submitted values.
