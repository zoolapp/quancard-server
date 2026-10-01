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
encrypted TOTP secrets. To read vault data they must guess the account password offline against
Argon2id at 64 MiB per guess, then still unwrap two layers of keys. A **weak password can be
guessed**; that is why the client requires at least 15 characters and the UI explains that there is
no reset.

Tested by: `apps/server/test/server.test.ts` (“never stores plaintext or keys”), e2e
request-body scan in `e2e/vault.spec.ts`.

### 2.2 Network attacker — **defended (HTTPS required)**

The server refuses non-HTTPS requests with `426` (only `localhost` is exempt, and only with the
explicit `QC_ALLOW_INSECURE_LOCALHOST=1` development flag). HSTS (2 years), and the bundled Caddy
obtains certificates automatically. Even a TLS failure exposes only ciphertext plus the
`authKey`, which is not the password and does not decrypt anything by itself — but it does allow
signing in, so HTTPS remains mandatory.

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
- open source and reproducible from this repository; release images are built by CI from tagged
  commits;
- the iPhone app never executes server-supplied code, so it stays safe even if the server is
  compromised (it can still be denied service or shown stale data).

What you should do: run the server yourself, on infrastructure you control, keep it updated, and
prefer the iPhone app when you do not trust the host. Planned (not yet shipped): published bundle
hashes per release and an optional locally-installed static client.

A malicious server can also **withhold or roll back** revisions or delete everything. Devices that
already synced keep their copies and detect missing parents, but a brand-new device cannot prove it
received the latest history. Keep the iPhone app and `.qvault` encrypted backups as independent
copies.

### 2.5 Malicious browser extension, compromised device or someone at your unlocked screen — **NOT defended**

Anything that can read the page or memory of an unlocked tab can read what you can read. The web
client limits the window: keys exist only in memory, the vault locks after 5 minutes idle or 60
seconds in the background, sensitive card fields (number, expiry, holder, CVC) stay masked until you
re-enter your password, and copied values are cleared from the clipboard after 45 seconds when the
browser allows it. These are mitigations, not guarantees.

### 2.6 Online password guessing — **rate limited**

10 credential attempts per minute per client; an account locks for 15 minutes after 10 consecutive
failures; optional TOTP with single-use recovery codes and replay protection. Prelogin returns a
stable decoy salt for unknown usernames, and failed logins for unknown users spend the same
Argon2id work as real ones.

### 2.7 CSRF, clickjacking, DNS rebinding — **defended**

`SameSite=Strict` host-only cookies; every state-changing browser request must carry the exact
configured `Origin` and an `X-QuanCard-Client: web` header; `Host` must equal `QC_PUBLIC_ORIGIN`
(`421` otherwise); `frame-ancestors 'none'` and `X-Frame-Options: DENY`.

### 2.8 Lost pairing QR code — **limited exposure**

The pairing QR contains the vault key (that is how a new iPhone can decrypt) and a single-use code
that expires after 10 minutes. Anyone who photographs it during that window can decrypt the vault if
they also obtain the ciphertext. The QR is shown only after password re-entry, never enters the
page as text, and the UI warns about this. Paired devices can be revoked; revocation stops future
sync but cannot remove data or keys a device already has.

## 3. Deletion

Deleting an item writes an encrypted tombstone. Earlier encrypted versions stay in the sync history
(sync v1 has no history compaction), and every device that knew the vault key can still decrypt
them. Deleting your account or a vault removes the server rows with SQLite `secure_delete`, but it
cannot erase copies on paired devices, in your own backups, or in filesystem/SSD remnants.
QuanCard never claims instant physical erasure.

## 4. Things QuanCard never stores

PINs, PIN blocks, magnetic-stripe/chip track data, online-banking passwords and OTP seeds for your
bank. The strict payload codec rejects these field names everywhere (`forbiddenField`), and CVC is
accepted only in the payload schema that explicitly allows it.

## 5. Out of scope

Denial of service by the host, physical attacks on your devices, operating-system compromise,
side channels in the browser’s WebCrypto implementation, and legal compulsion of the person who
runs your server.

## 6. Review status

This is version 0.1 of an open-source project. It has automated tests and an internal design
review, but **no independent third-party security audit yet**. Until then, do not describe a
deployment as audited.
