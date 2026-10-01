# pairing v1 — connecting the iPhone app

Status: server and web side implemented. The iPhone side is specified here and tracked in the iOS
repository as a proposed ADR; until it ships, the QR code is not yet scannable by the App Store app.

## 1. Flow

1. Signed-in browser, after password re-entry: `POST /api/v1/vaults/{vaultID}/pairings {authKey}`.
   The server returns a one-time `code` (24 random bytes, base64url, 32 characters) valid for **10
   minutes**, stored as SHA-256.
2. The browser builds the pairing URI **locally** and renders it as a QR code on a canvas (the
   string is never inserted into the DOM as text):

   ```text
   quancard://pair/v1?host=<origin>&code=<code>&key=<QC1 recovery code>
   ```

   `key` is the vault’s sync-v1 recovery code, `QC1.<UPPERCASE vault UUID>.<base64url SRK>` (84
   characters). The server never sees it.
3. The iPhone scans the QR, then calls `POST /api/v1/pairings/claim {code, deviceName}` over HTTPS
   (no cookie, so no CSRF header is required). On success it receives
   `{deviceID, vaultID, deviceToken}`; `deviceToken` is `qcd_` + 32 random bytes, stored as
   SHA-256 on the server.
4. The iPhone verifies the vault manifest with the key from the QR
   (`GET /api/v1/vaults/{vaultID}/manifest`, `Authorization: Bearer <deviceToken>`) before syncing.
   A manifest that fails verification aborts pairing.

A code works once (`410 pairingInvalid` afterwards) and expired codes return the same error.
The 10 minutes bound only the redemption of the code; the vault key in the QR does not expire (see
§4). Changing the account password deletes unredeemed codes.

## 2. Device scope

A device token can only:

- `GET /api/v1/vaults/{vaultID}/manifest`
- `GET /api/v1/vaults/{vaultID}/revisions`
- `PUT /api/v1/vaults/{vaultID}/revisions/{revisionID}`

for the single vault it was paired with. It cannot list vaults, read account data, create pairings
or change settings. `DELETE /api/v1/devices/{deviceID}` (browser session) revokes it immediately;
revocation does not remove data or keys the device already holds.

## 3. Requirements for the iPhone client

- Accept only `https://` hosts; refuse HTTP, including on local networks.
- Store the device token in the Keychain (`ThisDeviceOnly`), the SRK under the same protections as
  iCloud sync material, and never log either.
- Reuse the sync v1 merge rules unchanged: immutable revisions, parent digests, no time-based
  winner. Upload budget per sync run as with CloudKit: at most 5 batches of ≤ 100 revisions and
  ≤ 24 MiB of raw envelope bytes each (one `PUT` per revision). Fetching uses the server's pages
  (≤ 500 records, ≤ 24 MiB of raw envelope bytes before Base64) and the client's own totals of
  ≤ 2,001 records / 64 MiB.
- Show the host and let the user confirm before uploading existing items.

## 4. Security notes

The QR code is a bearer secret for the whole vault, indefinitely: the code part expires, the key part
does not. Anyone who later obtains a photo of it can decrypt any ciphertext of that vault they can
reach, until the items are moved to a new vault. The UI requires fresh password entry, shows a warning, expires the code, and closes the
dialog on demand. See [THREAT_MODEL.md](../../THREAT_MODEL.md#28-exposed-pairing-qr-code--long-lived-key-exposure).
