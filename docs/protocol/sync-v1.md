# sync v1 — server data plane

The cryptographic format is defined by the QuanCard iOS app and reproduced here byte for byte; the
public vectors in [`vectors/`](../../vectors/SOURCES.md) are the authority. The server never
decrypts anything: it stores opaque envelopes and enforces identity binding and quotas.

## 1. Envelope v1

```json
{"formatVersion":1,"objectKind":"syncRevision.v1","payload":"<base64>","recordID":"<UPPERCASE-UUID>","wrappedDEK":"<base64>"}
```

- `wrappedDEK` = nonce(12) ‖ AES-256-GCM(DEK) ‖ tag(16), exactly 60 bytes; `payload` = nonce ‖ ciphertext ‖ tag.
- AAD: `quancard.envelope.v1|dek|<objectKind>|<recordID>` and `quancard.envelope.v1|payload|<objectKind>|<recordID>`.
- Standard padded Base64, canonical only. iOS escapes `/` as `\/`; both parse identically.
- **Digests are always SHA-256 over the exact bytes stored**, never a re-serialisation.

## 2. Objects

| objectKind | recordID | Plaintext |
| --- | --- | --- |
| `syncManifest.v1` | vault UUID | `{"vaultID":…,"version":1}` |
| `syncRevision.v1` | revision UUID | `{"counter","installationID","itemID","parents","revisionID","snapshot","vaultID","version"}` |

A revision `snapshot` is standard Base64 of a vault payload (`.qvault` payload schema 1, or schema 2
when a CVC is present) containing exactly one item and at most one JPEG photo; `null` is a
tombstone. Parents are `{revisionID, digest}` sorted by revision ID. The strict codec rejects
duplicate/unknown keys, fractions, BOMs, nesting deeper than 32 and forbidden fields (PIN, track
data, …). Integers must be JSON integers; this TypeScript implementation additionally limits them to
±2^53−1 (Swift allows Int64). iOS only writes small counters and index-based sort positions, so valid
data is unaffected; an out-of-range revision is treated as unreadable, never rounded. See
`packages/protocol/src/{sync,payload}.ts`.

## 3. Merge rules (clients)

Heads are revisions without children. One head → show it (tombstone = deleted). Several heads →
conflict: keep all branches, never pick by time; the user writes a new revision whose parents cover
every head, or keeps all versions as separate items. Revisions with missing parents are held back
until the chain is complete. A per-installation counter must exceed every parent’s counter and never
repeat.

## 4. Server endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/v1/vaults` | session | `{vaultID, manifest, wrappedKey}`; idempotent for identical bytes, `409 vaultExists` otherwise |
| `GET` | `/api/v1/vaults` | session | vault list with wrapped keys and usage |
| `DELETE` | `/api/v1/vaults/{vaultID}` | session + fresh auth | removes vault, revisions, devices |
| `GET` | `/api/v1/vaults/{vaultID}/manifest` | session or device | raw envelope bytes |
| `GET` | `/api/v1/vaults/{vaultID}/revisions?after=<seq>` | session or device | pages of ≤ 500 records / 24 MiB, `{revisions:[{revisionID, seq, createdAt, body}], nextAfter, hasMore, lastSeq}` |
| `PUT` | `/api/v1/vaults/{vaultID}/revisions/{revisionID}` | session or device | `application/octet-stream`; `201` new, `200` identical retry, `409 revisionConflict` different bytes |

`seq` is a server-assigned, per-vault monotonic cursor for incremental fetches; it carries no
ordering meaning for merges.

## 5. Quotas

Mirroring the client limits so the server never holds what a client could not read: 16 MiB per
revision (`413`), 2,000 revisions and 64 MiB per vault (`507 capacity`), 8 vaults per account.
There is no automatic history compaction in v1; a future sync v2 (separate photo blobs, history
compaction with device acknowledgement) needs a new specification and new vectors on both
platforms.

## 6. Card photos

Photos travel inside the item’s snapshot, so every edit of an item with a photo re-uploads it. The
web client re-encodes photos (EXIF stripped, long edge ≤ 1600 px, quality stepped down to ≤ 1 MiB,
hard limit 4 MiB) and warns at 80 % of the vault quota. Photos stay on your server and paired
devices; they never touch iCloud unless you also enable iCloud sync on the iPhone.
