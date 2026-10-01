# Security policy

## Supported versions

QuanCard Server is in development preview (0.1.x). Security fixes go into the latest release only.
There is no published backport policy or guaranteed response time.

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button in the repository's
[Security tab](https://github.com/zoolapp/quancard-server/security/advisories/new). Reports are
handled by ZOOL LLC, with maintainer Luo Lei (@foru17).

Please include the affected version or commit, deployment method (compose, reverse proxy, local),
browser and OS, impact, and a minimal reproduction **using synthetic data only**.

**Never** put real card numbers, CVCs, bank account numbers, passwords, `.env` files, database files,
backups, pairing QR codes or session cookies in issues, pull requests, logs or screenshots. Do not
test against servers you do not own.

Maintainers triage reports and coordinate remediation and disclosure with the reporter. Good-faith
research that follows this policy is welcome; we will not pursue action against it.

## Scope

In scope: anything that lets the server, network or another user read vault contents or keys;
authentication, session, TOTP, pairing or rate-limit bypasses; CSRF, XSS, CSP bypass, injection;
cross-account or cross-vault access; protocol/codec flaws (envelope, sync v1, payload parsing);
data loss or corruption caused by valid requests; container escape or privilege issues in the
provided Docker setup; supply-chain problems in dependencies or release images.

Known, documented limits (see [THREAT_MODEL.md](THREAT_MODEL.md)) are not vulnerabilities by
themselves: a malicious server can serve modified web code; metadata such as revision counts and
sizes is visible to the server; a compromised browser or extension can read an unlocked vault.
Improvements to these mitigations are still very welcome.

## What is implemented

- Zero-knowledge storage: all vault data is encrypted in the browser (or iPhone) with AES-256-GCM;
  the server stores opaque envelopes and validates structure only.
- Password never leaves the client; Argon2id (64 MiB) + HKDF; server keeps a second Argon2id hash.
- HTTPS required (`426` otherwise); HSTS; strict CSP without inline script or third-party origins;
  COOP/COEP/CORP; `frame-ancestors 'none'`; host and origin checks; SameSite=Strict `__Host-` cookies.
- Rate limits, account lockout, TOTP with replay protection and single-use recovery codes,
  append-only audit log with pseudonymised client tags.
- Container: non-root, read-only root filesystem, all capabilities dropped, no published app port
  in the default deployment; logs exclude bodies, headers and query strings.
- No analytics, telemetry, crash reporting, CDNs or third-party requests.

These measures do not constitute an independent audit. CI runs type checks, linting, unit tests,
the cross-platform protocol vectors, end-to-end tests, dependency audit and an image build.
