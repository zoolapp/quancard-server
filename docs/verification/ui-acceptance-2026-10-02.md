# UI acceptance — 2026-10-02 (web v2)

**VERDICT: PASS** — 520/520 automated checks, 17/17 behaviour assertions, manual review below.

Gate: `pnpm -r build && UI_ACCEPTANCE=1 pnpm exec playwright test e2e/ui-acceptance.spec.ts` against the production bundle served by the real server. Synthetic and sample data only. The main story `pnpm exec playwright test e2e/vault.spec.ts` passes separately (it needs a fresh server).

## Screenshots

`.ui-acceptance/2026-10-02/` (git-ignored): 26 screens × desktop 1440×900, phone 390×844, dark desktop, dark phone. Screens: `01-setup`, `02-create-vault`, `03-home-accounts`, `03-home-cards`, `03-home-conflict-banner`, `03-home-region`, `03-home-search`, `04-editor`, `05-detail-masked`, `05-detail-revealed`, `06-reveal-dialog`, `07-delete-confirm`, `08-pairing`, `09-settings`, `09-settings-zh`, `10-conflict`, `11-unlock`, `12-sign-in`, `12-sign-in-error`, `13-home-welcome`, `14-home-samples`, `15-palette`, `16-account-detail`, `16-home-accounts-samples`, `17-home-empty`, `17-remove-samples-confirm`.
Committed reference set: [`docs/screenshots/v2/`](../screenshots/v2/) (52 WebP, replaces `docs/screenshots/mvp/` as the baseline).

## Automated checks

| Check | Result |
| --- | --- |
| no horizontal overflow | ✅ 104/104 |
| zoom not disabled | ✅ 104/104 |
| dialogs inside viewport | ✅ 104/104 |
| buttons/chips single line | ✅ 104/104 |
| text contrast ≥ WCAG AA | ✅ 104/104 |

## Manual review

| Item | Result | Note |
| --- | --- | --- |
| Dark mode readability | ✅ | Reviewed sidebar, palette, sheets, settings (en/zh), unlock, setup in dark. Disabled primary buttons were hard to read in dark (ink at 45 % opacity on grey); restyled to field background + secondary ink. |
| Controls on one line, no overflow | ✅ | Automated, plus visual pass on 390 px (two-column card grid, chips scroll). |
| High-frequency entries as dialogs | ✅ | Search is a ⌘K / Ctrl+K command dialog (sidebar field, phone header icon); detail and editor open as a side sheet over the collection (full screen on phones); sign-in stays on its own screen (no session yet). |
| Modern SaaS look, not a flat admin page | ✅ | Sidebar app frame with brand lockup, library and region navigation, account chip with sync time; branded split-screen sign-in with fanned issuer card faces and the otter; empty state with illustration and actions. |
| Brand presence | ✅ | Otter mark (sidebar, phone header, sign-in), guardian otter on unlock, first-card otter on empty state, kaka favicon, app icon for apple-touch/PWA, welcome card with the otter. |
| Public disclaimer | ✅ | “QuanCard does not issue cards, move money or connect to banks.” under every sign-in/setup/unlock form and in Settings. |
| Sheet animation | ✅ | Found during review: the slide-in also faded, so mid-animation frames showed the list through the sheet. Sheets now move without fading. |

## Baseline diff (vs 0.1.x, `docs/screenshots/mvp/`)

| 0.1.x feature | v2 | |
| --- | --- | --- |
| Setup, invite registration, sign-in with TOTP / recovery code | same forms, branded shell | ✅ |
| Unlock | guardian illustration, avatar, autofocus | ✅ |
| Create / import vault | option cards; a new vault starts with the welcome card | ✅ |
| Cards / Accounts tabs with counts | sidebar on desktop (+ Favorites), tabs on phones (+ Favorites) | ✅ |
| Region chips | sidebar region list with counts; chips on phones | ✅ |
| Favorites filter | dedicated section | ✅ |
| Inline search | ⌘K palette (items + actions) | ✅ (changed by design) |
| Refresh button | sidebar and phone header; plus automatic sync on focus and every 60 s while visible | ✅ (phone button restored during this gate) |
| Add via FAB | “New” menu in the page header; FAB on phones | ✅ |
| Card faces: 13 templates | + 71 issuer palettes with decor, issuer short names, welcome face | ✅ improved |
| Detail: masked, reveal with password, copy, delete | same, in a side sheet | ✅ |
| Editor with photo, templates | same, in a side sheet; issuer template suggested from the bank name | ✅ |
| Conflict resolution | same, in a side sheet | ✅ |
| Settings (account, language, security, sessions, devices, pairing QR, vault, members, activity, about, danger zone) | all kept; + Auto-lock duration, + Sample data section | ✅ |
| Lock / sign out | sidebar account chip / settings | ✅ |
| English / 简体中文 | both; completeness test added | ✅ |

Nothing from 0.1.x is missing.

## Behaviour assertions (real controls, observed results)

| Control | Claimed | Observed | |
| --- | --- | --- | --- |
| Create account (before acknowledging no-reset warning) | disabled until acknowledged | disabled | ✅ |
| Search (Ctrl+K) | opens a search dialog, filters items, no navigation | 1 item(s), url unchanged | ✅ |
| Search → Esc | closes the dialog | open dialogs: 0 | ✅ |
| Sidebar region “Japan” | show only Japanese items | 1 card(s) | ✅ |
| Detail (default) | number shows last 4; expiry/holder/CVC masked | CVC visible: false | ✅ |
| Show | asks for password, then shows full details | password dialog, then full number and CVC | ✅ |
| Hide | masks again | CVC visible: false | ✅ |
| Delete → Cancel | nothing deleted | still present | ✅ |
| Delete → Delete | removed from every device (tombstone) | item gone from list | ✅ |
| Keep this version | chosen version becomes the item; conflict resolved | chosen visible: true, banner: 0 | ✅ |
| Language → 简体中文 | UI switches to Chinese | heading “设置” | ✅ |
| Lock | keys dropped, vault hidden, password required | vault text on screen: 0 | ✅ |
| Sign in (wrong password) | generic error, no account hint | Username or password is incorrect. | ✅ |
| Create a new vault | starts with the QuanCard welcome card (as on iPhone) | QuanCard · Sample, QuanCard, Other, •••• 0000 | ✅ |
| Load sample data | adds the iOS sample catalogue (15 cards, 6 accounts) | 15 cards | ✅ |
| Sidebar “Accounts” | lists the 6 sample accounts | 6 rows | ✅ |
| Remove sample data | deletes every item tagged Demo/示例/範例 | 0 cards left | ✅ |

## Not covered

Real Safari / iOS Safari rendering, a VoiceOver walkthrough, 200 % text zoom, and the iPhone round trip for sample data (pair a real iPhone, see the samples, remove them there) — see the hand-off list.
