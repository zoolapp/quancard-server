# Getting started

Your first hour with QuanCard Server, after it is running. To install it, read
[Deployment](../deployment.md) first. [简体中文版](getting-started.zh-CN.md).

## 1. Create the owner account

Open your server (`https://vault.example.com`). On the first visit you see **Set up your server**:

1. Paste the **setup token**. `scripts/init-env.sh` printed it, and it is stored in `.env` as
   `QC_SETUP_TOKEN`.
2. Choose a username and a **passphrase of at least 15 characters**. Several unrelated words work
   well. A password manager is welcome.
3. Confirm that you understand there is **no password reset**. Your password encrypts your keys in
   the browser, so the server cannot recover it, and neither can anyone else.

After this the token is spent and the setup page never appears again. Later visitors see the
sign-in page. People without an account need an invite (see §4).

> **Sign in or unlock?** After you sign in, the browser keeps a session. When the vault locks
> (idle, tab in the background, or the lock button), you see **Welcome back** and only need your
> password. You only see the full sign-in form in a new browser or after you sign out.

## 2. Create your vault

Choose one:

- **Create a new vault.** Recommended. It starts with one sample card, like a fresh iPhone
  install. *New here? Load sample data* adds 15 cards and 6 accounts with public test numbers, so
  you can look around. Settings → Sample data removes them again, on every device.
- **Import with a recovery code** (`QC1.…`). Use this to continue a vault you already have, for
  example one you exported earlier. No sample card is added.

Everything you add is encrypted in the browser before it leaves.

## 3. Pair your iPhone

You need QuanCard for iPhone with self-hosted sync.

**In the browser:** Settings → Devices → **Pair iPhone**. Enter your password again. A QR code
appears: it works once and expires after 10 minutes. The dialog shows *Waiting for your iPhone to
scan…*.

**On the iPhone:** Settings → Sync → Self-hosted Sync → **Scan pairing QR code**. If the camera is not
convenient, paste the pairing link instead. Check that the destination is your server, then tap
**Connect and sync**.

Both screens then play the same short "linked" animation and show three steps: **iPhone
connected** → **Syncing…** → **All set**, with the number of cards and accounts in the vault.
From then on, changes made on either side appear on the other. The web app refreshes when the tab
regains focus, and every 60 seconds while it is open.

> **The QR code contains your vault key.** Show it only to your own phone, and close it when you
> are done. The server never sees the key. Details are in
> [pairing v1](../protocol/pairing-v1.md#4-security-notes).

**Re-pairing a phone:** on the iPhone, Self-hosted Sync → Manage Sync → **Disconnect** (your local
items stay). In the browser, Settings → Devices → **Revoke** the old entry, then pair again. Items that
are unchanged on both sides are recognised as the same item and do not show up as conflicts.

## 4. Invite family members

Settings → Members → **Create invite link** (owner only). The link works once and expires after
7 days. The invite code is in the URL fragment, which browsers never send to servers. The member
opens it, creates their own account and vault, and pairs their own iPhone. **Each member's vault
is encrypted separately; the owner cannot read it.**

## 5. Secure your account

- **Two-step verification:** Settings → Security → Two-step verification → **Turn on**. Scan the
  code with an authenticator app, then **save the recovery codes** somewhere safe and offline.
- **Auto-lock:** choose 1, 5, 15 or 30 minutes idle. The vault also locks 60 seconds after the
  tab goes to the background.
- **Revealing card details:** card numbers show the last four digits. Expiry, cardholder and
  security code appear only after you enter your password again, for 60 seconds.
- **Sessions and activity:** Settings shows signed-in browsers (sign out the others in one click)
  and an append-only activity log.

## 6. When versions differ (conflicts)

QuanCard never lets a device clock decide which version of an item wins. If two devices changed
the same item while offline, the item has a **conflict** and a banner appears.

- **Identical copies are not conflicts.** A re-paired phone uploading unchanged items is folded
  automatically ([sync v1 §3.1](../protocol/sync-v1.md#31-identical-heads-are-folded-in-the-view-client-rule-2026-10)).
- **Conflict centre:** the banner opens a page that lists every conflict with the **fields that
  differ**. Secrets show only *differs*, never the values. You can keep one version per item or
  use a bulk action: *use the most recently edited version*, *keep one copy of each sample*, or
  *keep all versions as copies*. Each bulk action shows its full list before you confirm.

## 7. Day-to-day operations

| Task | How |
| --- | --- |
| Back up | `./scripts/backup.sh`, for example nightly from cron: `0 3 * * * cd /opt/quancard && ./scripts/backup.sh`. Keep `.env` (`QC_SECRET`) with your backups. |
| Restore | `./scripts/restore.sh backups/quancard-<UTC>.sqlite` (verifies, stops, swaps, restarts) |
| Upgrade | Take a backup, then `docker compose pull && docker compose up -d --wait` |
| Health | `GET /healthz` → `{"ok":true}`; `GET /api/v1/status` reports the version and capabilities |
| Install as an app | In Chrome or Edge, use *Install*; in Safari on macOS, use *File → Add to Dock*. The vault still lives only in memory. |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No setup page, only sign-in | The owner already exists. Sign in, or ask the owner for an invite. |
| "Setup token is invalid" | Copy `QC_SETUP_TOKEN` from `.env` exactly. Each token works for one setup only. |
| Pairing dialog says the code expired | Codes last 10 minutes. Close the dialog and create a new one. |
| iPhone cannot connect | The server must be reachable over **HTTPS** with a valid certificate. Check `https://your-domain/healthz` from the phone's browser. |
| Browser shows *HTTPS required* | Open the exact `QC_PUBLIC_ORIGIN`. Behind a proxy, set `QC_TRUST_PROXY=1` ([Option B](../deployment.md#option-b--behind-your-own-reverse-proxy)). |
| Forgot the password | It cannot be reset. Data in that account is unrecoverable unless another device still has it (a paired iPhone keeps its local copy). |
| Lost the authenticator app | Use a recovery code at sign-in, then turn two-step verification off and on again. |

Something else? Open an issue on GitHub. Report security problems privately, as described in
[SECURITY.md](../../SECURITY.md).
