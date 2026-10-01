# Test vector provenance

These files are copied byte-for-byte from the QuanCard iOS repository at commit `2dc0af1`
(`docs/test-vectors/`). They contain **public synthetic keys and placeholder values only** —
never real card numbers, account numbers or passwords.

| File | SHA-256 | Covers |
| --- | --- | --- |
| `sync-v1.json` | `0412439df71d99d9f15ea3df6d5f840a6da1ca31c6d71c45a987814da42b3786` | envelope v1, sync manifest, revisions, parent digests, recovery code |
| `qvault-v1.json` | `c458e8dd63b967ea9cef8746ea833b9467205cb91c9ca8239442f4e6a9356373` | `.qvault` v1 Argon2id KEK, key wrap, payload schema 1 |
| `qvault-payload-v2.json` | `1533aa591319db59ca4cee126f0d9a61e304a134d49c44c4d080cb1a823037b9` | payload schema 2 with CVC |

`packages/protocol/test/vectors.test.ts` must reproduce every envelope byte-for-byte. If iOS
publishes new vectors, copy them here unchanged and record the new commit and digests.

Licensed under Apache-2.0 (see `LICENSE` in this directory) so independent implementations
can reuse them.
