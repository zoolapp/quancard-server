# Pairing "linked" motion — shared spec (web + iOS)

One animation, drawn the same way on both screens at the moment of pairing. The browser plays it
when its QR code is claimed. The iPhone plays it when its claim succeeds. Both then show the same
three-step sync status. This page is the single source of truth: change the numbers here, then in
`apps/web/src/components/pairing.tsx` and in iOS `QuanCard/Features/Settings/PairingLinkedView.swift`.

## Composition

A 240 × 160 canvas (px on the web, pt on iOS), scaled uniformly to the available width
(max 280).

| Element | Geometry | Style |
| --- | --- | --- |
| Browser window | rect x 14, y 38, w 108, h 78, corner 10; title bar line y 54; three dots at (24,46) (31,46) (38,46) r 2 | stroke ink 1.5, fill surface |
| iPhone | rect x 160, y 18, w 62, h 124, corner 16; speaker pill x 182, y 25, w 18, h 4 | stroke ink 1.5, fill surface |
| Phone screen | rect x 166, y 34, w 50, h 98, corner 9 | fill: grouped surface (fades in) |
| Otter mark | the brand otter (holding a card), 40 × 40 centred at (191, 83) | the existing raster mark; no new artwork |
| Link | straight line (122, 77) → (160, 77), dashed 2 / 5 | stroke ink at 30 % |
| Travelling dots | 3 dots r 2.5 moving along the link, left → right | fill ink |
| Check badge | circle r 12 centred at (218, 22) | fill ink; check path `M212 22 l4 4 l8 -8`, stroke canvas 2, round caps |
| Ripple | circle centred on the badge, r 12 → 30 | stroke ink 1.5, opacity 0.35 → 0 |

Colours come from the theme (ink, canvas, surface, grouped). The otter is the only coloured
element, in line with the iOS rule that warm colour stays on the character. The otter does not
celebrate a payment; it simply appears on the connected phone.

## Timeline (ms from start)

| Window | Element | Motion |
| --- | --- | --- |
| 0 – 450 | iPhone outline | stroke draws on (trim 0 → 1), ease-out |
| 0 – 300 | Browser window | fades in from opacity 0.4 to 1 (it was already there) |
| 250 – 850 | Travelling dots | each dot crosses the link in 360 ms; starts are staggered by 120 ms; opacity 0 → 1 → 0 |
| 650 – 1000 | Phone screen | fill fades in |
| 700 – 1100 | Otter mark | scales 0.6 → 1 and fades in. Web: `cubic-bezier(.34,1.56,.64,1)` over 400 ms. iOS: `.spring(response: 0.4, dampingFraction: 0.68)` |
| 1000 – 1300 | Check badge | scales 0 → 1 with the same spring |
| 1150 – 1400 | Check mark | stroke draws on |
| 1250 – 1900 | Ripple | radius 12 → 30, opacity 0.35 → 0, once |

Total ≈ 1.9 s, played once, with no loop. **Reduce Motion** (both platforms) shows the final
frame immediately, with a 200 ms cross-fade.

## Text and states, identical on both sides

| Step | Title | Detail |
| --- | --- | --- |
| 1 Connected | “iPhone connected” / “iPhone 已连接” | device name (web) · server host (iPhone) |
| 2 Syncing | “Syncing…” / “正在同步…” | web: “Waiting for the first sync from your iPhone” until the device has called the API, then “Received N items”; iPhone: the current sync status |
| 3 Done | “All set” / “同步完成” | counts: “N cards · M accounts” / “N 张卡片 · M 个账户” |

The step list is three rows, each with a 20 px state glyph: pending is a hollow circle, active is
a spinner, done is a filled check. A primary “Done” / “完成” button closes the flow at any time.
The web keeps following the sync for at most 2 minutes after the claim; after that it shows the
counts it has.
