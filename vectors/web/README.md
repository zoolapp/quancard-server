# Web-produced vectors

`revision-v1.json` is written by the TypeScript implementation in this repository
(`node tools/make-web-vector.mjs`) with fixed, public randomness. It covers the direction the iOS
vectors cannot: data **created in the web client** — a payload schema 2 card with CVC and a photo.

`python3 tools/verify_web_vector.py` opens it with an independent implementation (Python
`cryptography`, no QuanCard code) and checks it against the iOS strict reader's rules: envelope v1
AAD binding, exact sync v1 revision keys, the payload key whitelists of iOS `QVaultPayloadSchema`,
canonical UUIDs and dates, and the photo digest — plus tamper and wrong-binding rejection. CI runs
both. The iOS project can copy this file into its own test vectors to close the loop in Swift
(ADR-0009, verification gate 2).

Public synthetic keys and values only (`TEST_ONLY`, `0000…`). Licensed Apache-2.0.
