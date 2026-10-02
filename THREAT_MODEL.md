# Threat model

QuanCard Server is a self-hosted, **zero-knowledge** companion for the QuanCard iPhone app: a
sync store plus a web client for managing your saved payment cards and bank-account details. This
document says what it protects, against whom, and — just as importantly — what it does not.

Every statement here is backed by code or a test; the references point to them. If you find a
statement that is not true, please report it (see [SECURITY.md](SECURITY.md)).

## 1. What we protect

| Asset | Where it lives | Protection |
| --- | --- | --- |
| Card numbers, CVC, expiry, cardholder, bank accounts, routing details, notes, tags, card photos | Encrypted revisions on the server; plaintext only in the unlocked browser tab or iPhone | AES-256-GCM per record (`quancard.envelope.v1`) under a random 256-bit vault key |
| Vault key (sync root key) | Wrapped by the Account Key on the server; raw only in browser/iPhone memory | AES-256-GCM key wrap, never derived from a password |
| Account Key | Wrapped by the password-derived KEK on the server | Argon2id (64 MiB, t=3) + HKDF in the browser |
| Account password | Never stored or sent anywhere | Only `authKey = HKDF(Argon2id(password))` is sent; the server stores `Argon2id(authKey)` |
| Sessions | HttpOnly `__Host-` cookie; server stores SHA-256 of the token | Secure, SameSite=Strict, 30 min idle / 12 h absolute |
| TOTP secrets | Server database | AES-256-GCM with a key derived from `QC_SECRET` |

Key hierarchy:

```text
password ──NFC/UTF-8──▶ Argon2id(salt, 64 MiB, t=3, p=1) ──▶ master key
master key ──HKDF "quancard.auth.v1|auth"──▶ authKey  ──▶ server: Argon2id(authKey) verifier
master key ──HKDF "quancard.auth.v1|kek" ──▶ KEK ──wraps──▶ Account Key (random)
Account Key ──wraps──▶ vault key (random, same key the iPhone uses for sync v1)
vault key ──wraps per-record DEK──▶ revision payloads (cards, accounts, photos)
```

Specifications: [auth v1](docs/protocol/auth-v1.md), [pairing v1](docs/protocol/pairing-v1.md),
[sync v1 data plane](docs/protocol/sync-v1.md).

## 2. Adversaries and outcomes

### 2.1 Stolen database, backup or disk image — **defended**

The attacker gets ciphertext, wrapped keys, `Argon2id(authKey)` verifiers, KDF salts and
encrypted TOTP secrets. To read vault data they must guess the account password offline; each guess
costs one client-side Argon2id evaluation at 64 MiB, after which trying to unwrap the Account Key
confirms it. The two wrapping layers add no independent secret — **the password is the only barrier**,
and two-step verification does not slow offline guessing. A weak password can be guessed; that is why
the client requires at least 15 characters and the UI explains that there is no reset.

Changing the password re-wraps the same Account Key; it is not key rotation. Anyone holding an
older copy of the wrapped Account Key and the old password can still unwrap it. If you suspect the
old password leaked together with a backup, create a new vault and move your items into it.

Tested by: `apps/server/test/server.test.ts` (“never stores plaintext or keys”), e2e
request-body scan in `e2e/vault.spec.ts`.

### 2.2 Network attacker — **defended (HTTPS required)**

The server refuses non-HTTPS requests with `426` (only `localhost` is exempt, and only with the
explicit `QC_ALLOW_INSECURE_LOCALHOST=1` development flag and a loopback/private peer). Forwarded
`X-Forwarded-Proto` headers are honoured only from private-network peers such as the bundled proxy.
HSTS (2 years) is sent, and the bundled Caddy obtains certificates automatically.

Distinguish three cases. A **passive** observer of a broken TLS session sees ciphertext and the
`authKey` — a replayable login credential (not the password), enough to sign in but not to decrypt.
An **active** attacker who can tamper with the page delivery (first visit over HTTP before HSTS, a
mis-issued certificate, a compromised proxy) can replace the JavaScript and capture the password,
keys and plaintext — the same outcome as §2.4. A `426` response cannot recall data a client already
sent in clear. HTTPS and trusted delivery of the web client are therefore prerequisites, not
defences that encryption provides on its own.

### 2.3 Honest-but-curious server operator — **defended for content, not for metadata**

The server can see: usernames, number of vaults, number and size of revisions, when they are
written, client IP addresses (masked in proxy logs, HMAC-pseudonymised in the audit log), coarse
browser/OS labels for sessions, and device names chosen during pairing.

It cannot see: any card or account field, which revisions belong to which item, whether a revision
is a deletion, the vault key, or the password.

### 2.4 Malicious or compromised server — **NOT fully defended**

This is the fundamental limit of every web-based end-to-end-encrypted app (Bitwarden,
1Password web and others share it). A server that is controlled by an attacker **can send modified
JavaScript** that captures your password or decrypted data the next time you open the web client.
Encryption at rest does not help against that.

What we do:

- strict Content-Security-Policy (`default-src 'none'`, no inline script, no third-party origins),
  so injected markup cannot load external code;
- no CDNs, fonts, analytics or third-party requests at all — the bundle is self-contained;
- open source and buildable from this repository; release images are built by CI from tagged
  commits with provenance and an SBOM, and web bundle hashes are attached to each release
  (bit-for-bit reproducibility across machines is not yet verified);
- the iPhone app does not execute server-supplied code, which removes this attack path for it; it
  remains subject to its own protocol parsing, pairing and rollback limits (and can be denied
  service or shown stale data).

What you should do: run the server yourself, on infrastructure you control, keep it updated, and
prefer the iPhone app when you do not trust the host. Planned (not yet shipped): published bundle
hashes per release and an optional locally-installed static client.

A malicious server can also **withhold or roll back** revisions or delete everything. Native
devices that keep a persistent sync history detect some rollbacks through missing parents. The web
client keeps history only in memory: after a lock or reload it trusts whatever consistent history the
server returns, so it **cannot detect a rollback to an older, complete state**, and neither can a
brand-new device. Keep the iPhone app and `.qvault` encrypted backups as independent copies.

### 2.5 Malicious browser extension, compromised device or someone at your unlocked screen — **NOT defended**

Anything that can read the page or memory of an unlocked tab can read what you can read. The web
client limits the window: keys exist only in memory, the vault locks after 5 minutes idle or 60
seconds in the background, sensitive card fields (number, expiry, holder, CVC) stay masked until you
re-enter your password (shown for 60 seconds; no new prompt for 5 minutes, revoked on lock), and copied values are cleared from the clipboard after 45 seconds when the
browser allows it. These are mitigations, not guarantees.

### 2.6 Online password guessing — **rate limited**

10 attempts per minute per client **for each** credential endpoint; an account locks for 15 minutes
after 10 consecutive failures from any source, counted atomically, where wrong passwords, wrong
second-factor codes and failed re-authentication all count. Optional TOTP with single-use recovery
codes and replay protection (codes are consumed with compare-and-set updates, so concurrent replays
fail). Prelogin returns a stable decoy salt for unknown usernames, and failed logins for unknown users
spend the same Argon2id work as real ones. Trade-off: anyone who knows your username can keep your
account locked out (denial of service) — they still learn nothing.

### 2.7 CSRF, clickjacking, DNS rebinding — **defended**

`SameSite=Strict` host-only cookies; every state-changing browser request must carry the exact
configured `Origin` and an `X-QuanCard-Client: web` header; `Host` must equal `QC_PUBLIC_ORIGIN`
(`421` otherwise); `frame-ancestors 'none'` and `X-Frame-Options: DENY`.

### 2.8 Exposed pairing QR code — **long-lived key exposure**

The pairing QR contains the vault key (that is how a new iPhone can decrypt) and a one-time code.
The **10-minute limit applies only to redeeming the code** for a device token. The vault key in the
picture never expires: anyone who ever obtains a photo of the QR, at any time, can decrypt every
revision written under that key that they can also obtain — past and future — until you move your
items to a new vault. A redeemed device token also outlives the 10 minutes until it is revoked.

Mitigations: the QR is shown only after password re-entry, never enters the page as text, and the UI
warns about it. Changing the password deletes pending (unredeemed) pairing codes; it does not revoke
paired devices — revoke them explicitly in Settings. Revocation stops server access only; it cannot
remove data or keys a device already has. If a QR leaked, create a new vault, move your items, pair
your devices again and delete the old vault.

### 2.9 Passkeys — **not implemented (proposal)**

[passkey v1](docs/protocol/passkey-v1.md) would add a PRF-derived second wrap of the Account Key.
It is not implemented. Before it ships, these boundaries must hold:
- the PRF output never leaves the browser;
- the passkey is bound to the server's hostname, so moving to a new domain invalidates every
  passkey and the password remains required;
- a prebuilt iOS app cannot use passkeys for arbitrary self-hosted domains;
- removing a passkey cannot undo exposure for someone who already holds an old wrapped copy and
  the authenticator.

The [independent review](docs/reviews/2026-10-02-passkey-second-opinion.md) lists the
preconditions.

### 2.10 Concurrent edits from several devices — **defended**

The web client syncs in the background: on focus, and every 60 seconds while visible. An
editor saves on top of the heads it was opened from, never on the newest head. If another device
changed the item in the meantime, the result is a visible conflict, never a silent overwrite.
The reviewer flagged this on 2026-10-02 and it is covered by `apps/web/test/vault.test.ts`.

## 3. Deletion

Deleting an item writes an encrypted tombstone. Earlier encrypted versions stay in the sync history
(sync v1 has no history compaction), and every device that knew the vault key can still decrypt
them. Deleting your account or a vault removes the server rows with SQLite `secure_delete`, but it
cannot erase copies on paired devices, in your own backups, or in filesystem/SSD remnants.
QuanCard never claims instant physical erasure.

## 4. Data QuanCard has no fields for

The vault schema has no fields for PINs, PIN blocks, magnetic-stripe/chip track data,
online-banking passwords or bank OTP seeds, and the strict payload codec rejects such field names
anywhere in a payload (`forbiddenField`); CVC is accepted only in the payload schema that explicitly
allows it. This cannot stop you from typing such secrets into free-text notes or photographing them —
please don't — and the server, which only sees ciphertext, cannot check.

Integers in payloads are limited to the JavaScript safe range (±2^53−1) in this implementation. The
iOS app only produces small counters and sort positions, so valid data is unaffected; a revision
outside that range is treated as unreadable rather than silently rounded.

## 5. Out of scope

Denial of service by the host, physical attacks on your devices, operating-system compromise,
side channels in the browser’s WebCrypto implementation, and legal compulsion of the person who
runs your server.

## 6. Review status

This is version 0.1 of an open-source project. It has automated tests and an internal design
review, but **no independent third-party security audit yet**. Until then, do not describe a
deployment as audited.
