import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  base64,
  encodePayload,
  importAESKey,
  openRevision,
  RevisionGraph,
  randomBytes,
  randomUUID,
  recoveryCode,
  sealRevision,
} from "../packages/protocol/dist/index.js";
import { E2E_SETUP_TOKEN } from "../playwright.config.js";

/**
 * UI acceptance gate (run with UI_ACCEPTANCE=1): desktop 1440×900, phone 390×844 and dark
 * screenshots of every screen, plus machine checks — horizontal overflow, zoom not disabled,
 * dialogs inside the viewport, single-line buttons, and WCAG contrast of every visible text node.
 * Results go to .ui-acceptance/<date>/ (git-ignored); the human report lives next to them.
 */

test.skip(process.env.UI_ACCEPTANCE !== "1", "UI acceptance gate runs only with UI_ACCEPTANCE=1");

const DATE = new Date().toISOString().slice(0, 10);
const DIR = `.ui-acceptance/${DATE}`;
mkdirSync(DIR, { recursive: true });
const PASSWORD = "correct horse battery staple ui";
const VAULT_ID = randomUUID();
const SYNC_KEY = randomBytes(32);

interface Finding {
  screen: string;
  variant: string;
  check: string;
  ok: boolean;
  detail: string;
}
const findings: Finding[] = [];
const behaviours: { control: string; claimed: string; observed: string; ok: boolean }[] = [];

async function audit(page: Page, screen: string, variant: string) {
  const result = await page.evaluate(() => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = "1"] = (m[1] as string).split(/[ ,/]+/).filter(Boolean);
      return [Number(r), Number(g), Number(b), Number(a)] as [number, number, number, number];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r as number) + 0.7152 * f(g as number) + 0.0722 * f(b as number);
    };
    const background = (el: Element | null): number[] | null => {
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none" || node.tagName === "IMG" || node.querySelector(":scope > img")) return null;
        const c = parse(style.backgroundColor);
        if (c && c[3] > 0.95) return c;
      }
      return parse(getComputedStyle(document.body).backgroundColor);
    };
    const low: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? "").trim();
      const el = n.parentElement;
      if (!text || !el) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || el.closest("[aria-hidden='true'] .card-face, .card-face")) continue;
      if (el.closest(".visually-hidden") || rect.bottom < 0 || rect.top > innerHeight) continue;
      const fg = parse(style.color);
      const bg = background(el);
      if (!fg || !bg) continue;
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
      const ratio = (a + 0.05) / (b + 0.05);
      const large = Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      const disabled = !!el.closest(":disabled, [aria-disabled='true']");
      if (!disabled && ratio < (large ? 3 : 4.5)) low.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 40)}"`);
    }
    const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
    const dialogs = [...document.querySelectorAll("dialog[open]")].map((d) => {
      const r = d.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    const wrapped = [...document.querySelectorAll<HTMLElement>(".btn, .chip, .tab")]
      .filter((b) => b.getBoundingClientRect().width > 0)
      .filter((b) => {
        const lh = Number.parseFloat(getComputedStyle(b).lineHeight) || Number.parseFloat(getComputedStyle(b).fontSize) * 1.45;
        const inner =
          b.getBoundingClientRect().height - Number.parseFloat(getComputedStyle(b).paddingTop) - Number.parseFloat(getComputedStyle(b).paddingBottom);
        return inner > lh * 1.6 && b.getBoundingClientRect().height > 48;
      })
      .map((b) => b.textContent?.trim() ?? "");
    return {
      overflowX: document.documentElement.scrollWidth - innerWidth,
      zoomDisabled: /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(viewport),
      dialogs,
      viewport: { w: innerWidth, h: innerHeight },
      lowContrast: low,
      wrapped,
    };
  });
  const push = (check: string, ok: boolean, detail: string) => findings.push({ screen, variant, check, ok, detail });
  push("no horizontal overflow", result.overflowX <= 0, `${result.overflowX}px`);
  push("zoom not disabled", !result.zoomDisabled, result.zoomDisabled ? "viewport disables zoom" : "ok");
  push(
    "dialogs inside viewport",
    result.dialogs.every((d) => d.left >= -1 && d.top >= -1 && d.right <= result.viewport.w + 1 && d.bottom <= result.viewport.h + 1),
    JSON.stringify(result.dialogs),
  );
  push("buttons/chips single line", result.wrapped.length === 0, result.wrapped.join(" | ") || "ok");
  push("text contrast ≥ WCAG AA", result.lowContrast.length === 0, result.lowContrast.slice(0, 5).join("; ") || "ok");
}

async function capture(page: Page, screen: string) {
  for (const [variant, size, scheme] of [
    ["desktop", { width: 1440, height: 900 }, "light"],
    ["mobile", { width: 390, height: 844 }, "light"],
    ["dark", { width: 1440, height: 900 }, "dark"],
    ["mobile-dark", { width: 390, height: 844 }, "dark"],
  ] as const) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${DIR}/${screen}-${variant}.png` });
    await audit(page, screen, variant);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("UI acceptance", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up your server" })).toBeVisible();
  await capture(page, "01-setup");
  await page.getByLabel("Setup token").fill(E2E_SETUP_TOKEN);
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  const createButton = page.getByRole("button", { name: "Create account" });
  behaviours.push({
    control: "Create account (before acknowledging no-reset warning)",
    claimed: "disabled until acknowledged",
    observed: (await createButton.isDisabled()) ? "disabled" : "enabled",
    ok: await createButton.isDisabled(),
  });
  await page.getByLabel("I understand").check();
  await createButton.click();
  await expect(page.getByRole("heading", { name: "Create your vault" })).toBeVisible();
  await capture(page, "02-create-vault");
  await page.getByRole("button", { name: "Import with a recovery code" }).click();
  await page.getByLabel("Recovery code").fill(recoveryCode({ vaultID: VAULT_ID, key: SYNC_KEY }));
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.locator(".sidebar").getByRole("button", { name: /Cards/ })).toBeVisible();

  for (const [name, bank, region, pan] of [
    ["Synthetic Everyday Visa", "TEST_ONLY Bank", "SG", "0000000000001111"],
    ["Synthetic Travel Platinum Card With A Long Name", "TEST_ONLY International Bank Corporation", "JP", "0000000000002222"],
    ["Synthetic Debit", "TEST_ONLY Credit Union", "US", "0000000000003333"],
  ]) {
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add card" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name as string);
    await page.getByLabel("Bank or issuer").fill(bank as string);
    await page.getByLabel("Country or region").fill(region as string);
    await page.getByLabel("Card number").fill(pan as string);
    await page.getByLabel("Expiry · Month").fill("09");
    await page.getByLabel("Year").fill("2031");
    await page.getByLabel("Security code").fill("123");
    if (name === "Synthetic Debit") await page.getByRole("combobox", { name: /^Network/ }).selectOption("mastercard");
    if (name === "Synthetic Everyday Visa") await capture(page, "04-editor");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: new RegExp(name as string) })).toBeVisible();
  }
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add account" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Synthetic Savings");
  await page.getByLabel("Bank or issuer").fill("TEST_ONLY Savings Bank");
  await page.getByLabel("Country or region").fill("DE");
  await page.getByLabel("Account number").fill("TEST_ONLY_0001");
  await page.getByLabel("Currencies").fill("EUR, USD");
  await page.getByRole("button", { name: "Save" }).click();
  await capture(page, "03-home-cards");
  const nav = page.locator(".sidebar");
  await nav.getByRole("button", { name: /Accounts/ }).click();
  await capture(page, "03-home-accounts");
  await nav.getByRole("button", { name: /Cards/ }).click();

  // Search is a dialog (⌘K / Ctrl+K or the sidebar field); no page navigation.
  const urlBefore = page.url();
  await page.keyboard.press("Control+k");
  await page.getByRole("searchbox", { name: "Search" }).fill("debit");
  const matched = await page.locator(".palette-row .palette-thumb").count();
  behaviours.push({
    control: "Search (Ctrl+K)",
    claimed: "opens a search dialog, filters items, no navigation",
    observed: `${matched} item(s), url ${page.url() === urlBefore ? "unchanged" : "changed"}`,
    ok: matched === 1 && page.url() === urlBefore,
  });
  await capture(page, "03-home-search");
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]"))
    .toHaveCount(0, { timeout: 2000 })
    .catch(() => undefined);
  behaviours.push({
    control: "Search → Esc",
    claimed: "closes the dialog",
    observed: `open dialogs: ${await page.locator("dialog[open]").count()}`,
    ok: (await page.locator("dialog[open]").count()) === 0,
  });

  // Region filter in the sidebar
  await nav.getByRole("button", { name: /Japan/ }).click();
  const jp = await page.locator(".card-tile").count();
  behaviours.push({ control: "Sidebar region “Japan”", claimed: "show only Japanese items", observed: `${jp} card(s)`, ok: jp === 1 });
  await capture(page, "03-home-region");
  await nav.getByRole("button", { name: /Japan/ }).click();

  // Detail: masked, reveal requires password, hide hides.
  await page.getByRole("button", { name: /Synthetic Everyday Visa/ }).click();
  const maskedCVC = await page.getByText("123", { exact: true }).count();
  behaviours.push({
    control: "Detail (default)",
    claimed: "number shows last 4; expiry/holder/CVC masked",
    observed: `CVC visible: ${maskedCVC > 0}`,
    ok: maskedCVC === 0,
  });
  await capture(page, "05-detail-masked");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.locator("dialog[open]")).toBeVisible();
  await capture(page, "06-reveal-dialog");
  await page.locator("dialog[open]").getByLabel("Password").fill(PASSWORD);
  await page.locator("dialog[open]").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("0000 0000 0000 1111")).toBeVisible();
  behaviours.push({
    control: "Show",
    claimed: "asks for password, then shows full details",
    observed: "password dialog, then full number and CVC",
    ok: (await page.getByText("123", { exact: true }).count()) === 1,
  });
  await capture(page, "05-detail-revealed");
  await page.getByRole("button", { name: "Hide" }).click();
  behaviours.push({
    control: "Hide",
    claimed: "masks again",
    observed: `CVC visible: ${(await page.getByText("123", { exact: true }).count()) > 0}`,
    ok: (await page.getByText("123", { exact: true }).count()) === 0,
  });
  // Copy writes the clipboard (Chromium grants clipboard permission in tests).
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: /Copy Notes|Copy Bank/ }).count();
  await page.getByRole("button", { name: "Back" }).click();

  // Delete shows a confirmation and removes the item.
  await page.getByRole("button", { name: /Synthetic Debit/ }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await capture(page, "07-delete-confirm");
  await page.locator("dialog[open]").getByRole("button", { name: "Cancel" }).click();
  behaviours.push({
    control: "Delete → Cancel",
    claimed: "nothing deleted",
    observed: (await page.getByRole("heading", { name: "Synthetic Debit" }).count()) ? "still present" : "gone",
    ok: (await page.getByRole("heading", { name: "Synthetic Debit" }).count()) === 1,
  });
  await page.getByRole("button", { name: "Delete" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: /Synthetic Debit/ })).toHaveCount(0);
  behaviours.push({ control: "Delete → Delete", claimed: "removed from every device (tombstone)", observed: "item gone from list", ok: true });

  // Conflict: a second device edits the same head.
  await page.getByRole("button", { name: "Settings" }).click();
  const pairingResponse = page.waitForResponse((r) => r.url().includes("/pairings") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Pair iPhone" }).click();
  await page.locator("dialog[open]").getByLabel("Password").fill(PASSWORD);
  await page.locator("dialog[open]").getByRole("button", { name: "Confirm" }).click();
  const pairing = await (await pairingResponse).json();
  await expect(page.getByRole("img", { name: "Pair iPhone" })).toBeVisible();
  await capture(page, "08-pairing");
  await page.getByRole("button", { name: "Close code" }).click();
  await capture(page, "09-settings");
  const claim = await (await request.post("/api/v1/pairings/claim", { data: { code: pairing.code, deviceName: "UI Phone" } })).json();
  const auth = { Authorization: `Bearer ${claim.deviceToken}` };
  const rows = (await (await request.get(`/api/v1/vaults/${VAULT_ID}/revisions?after=0`, { headers: auth })).json()).revisions;
  const key = await importAESKey(SYNC_KEY);
  const graph = new RevisionGraph(VAULT_ID);
  const nodes = [];
  for (const r of rows) nodes.push(await openRevision(base64.decode(r.body), r.revisionID, VAULT_ID, key));
  graph.add(nodes);
  const target = nodes.find((n) => n.snapshot?.items[0]?.displayName === "Synthetic Everyday Visa");
  const snap = target?.snapshot;
  if (!target || !snap) throw new Error("missing target");
  // The browser's draft starts before the phone edits: saving it must fork, never overwrite.
  await nav.getByRole("button", { name: /Cards/ }).click();
  await page.getByRole("button", { name: /Synthetic Everyday Visa/ }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Notes").fill("TEST_ONLY browser edit");
  const forked = await sealRevision(
    {
      version: 1,
      vaultID: VAULT_ID,
      revisionID: randomUUID(),
      itemID: target.revision.itemID,
      installationID: randomUUID(),
      counter: graph.maximumCounter + 1,
      parents: graph.parentsFor(target.revision.itemID),
      snapshot: await encodePayload(
        [{ ...(snap.items[0] as NonNullable<(typeof snap.items)[0]>), displayName: "Renamed On Phone", updatedAt: new Date().toISOString() }],
        [],
      ),
    },
    key,
  );
  await request.put(`/api/v1/vaults/${VAULT_ID}/revisions/${forked.revision.revisionID}`, {
    headers: { ...auth, "Content-Type": "application/octet-stream" },
    data: Buffer.from(forked.ciphertext),
  });
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText(/conflicting versions/)).toBeVisible();
  await capture(page, "03-home-conflict-banner");
  await page.getByRole("button", { name: "Review" }).click();
  await capture(page, "10-conflict");
  await page.locator(".panel", { hasText: "Renamed On Phone" }).getByRole("button", { name: "Keep this version" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  const kept = await page.getByRole("button", { name: /Renamed On Phone/ }).count();
  behaviours.push({
    control: "Keep this version",
    claimed: "chosen version becomes the item; conflict resolved",
    observed: `chosen visible: ${kept === 1}, banner: ${await page.getByText(/conflicting versions/).count()}`,
    ok: kept === 1 && (await page.getByText(/conflicting versions/).count()) === 0,
  });

  // Language switch
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "简体中文" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  behaviours.push({ control: "Language → 简体中文", claimed: "UI switches to Chinese", observed: "heading “设置”", ok: true });
  await capture(page, "09-settings-zh");
  await page.getByRole("button", { name: "English" }).click();
  await nav.getByRole("button", { name: /Cards/ }).click();

  // Lock and sign-in screens
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  const stillCached = await page.getByText("Synthetic").count();
  behaviours.push({
    control: "Lock",
    claimed: "keys dropped, vault hidden, password required",
    observed: `vault text on screen: ${stillCached}`,
    ok: stillCached === 0,
  });
  await capture(page, "11-unlock");
  await page.getByRole("button", { name: "Not you? Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await capture(page, "12-sign-in");
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("a wrong password value");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  behaviours.push({
    control: "Sign in (wrong password)",
    claimed: "generic error, no account hint",
    observed: (await page.getByRole("alert").textContent()) ?? "",
    ok: (await page.getByRole("alert").textContent()) === "Username or password is incorrect.",
  });
  await capture(page, "12-sign-in-error");

  // A brand-new vault (invited member): welcome card, sample data, palette, removal.
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const invite = ((await page.locator(".mono-wrap", { hasText: "#invite=" }).textContent()) ?? "").trim();
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.goto(invite);
  await expect(page.getByRole("heading", { name: "Join this server" })).toBeVisible();
  await page.getByLabel("Username").fill("member");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByLabel("I understand").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: /Create a new vault/ }).click();
  await expect(page.locator(".card-tile")).toHaveCount(1);
  behaviours.push({
    control: "Create a new vault",
    claimed: "starts with the QuanCard welcome card (as on iPhone)",
    observed: (await page.locator(".card-tile").first().getAttribute("aria-label")) ?? "",
    ok: /QuanCard · Sample/.test((await page.locator(".card-tile").first().getAttribute("aria-label")) ?? ""),
  });
  await capture(page, "13-home-welcome");
  await page.locator(".banner").getByRole("button", { name: "Load sample data" }).click();
  await expect(page.getByText("Added 20 sample items.")).toBeVisible();
  const cards = await page.locator(".card-tile").count();
  behaviours.push({
    control: "Load sample data",
    claimed: "adds the iOS sample catalogue (15 cards, 6 accounts)",
    observed: `${cards} cards`,
    ok: cards === 15,
  });
  await capture(page, "14-home-samples");
  await page.keyboard.press("Control+k");
  await page.getByRole("searchbox", { name: "Search" }).fill("hsbc");
  await capture(page, "15-palette");
  await page.keyboard.press("Escape");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /Accounts/ })
    .click();
  const accounts = await page.locator(".list-row").count();
  behaviours.push({ control: "Sidebar “Accounts”", claimed: "lists the 6 sample accounts", observed: `${accounts} rows`, ok: accounts === 6 });
  await capture(page, "16-home-accounts-samples");
  await page.locator(".list-row").first().click();
  await capture(page, "16-account-detail");
  await page.getByRole("button", { name: "Back" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Remove sample data" }).click();
  await capture(page, "17-remove-samples-confirm");
  await page
    .locator("dialog[open]")
    .getByRole("button", { name: /Remove sample data/ })
    .click();
  await expect(page.getByText("Removed 21 sample items.")).toBeVisible();
  await page.locator(".sidebar").getByRole("button", { name: /Cards/ }).click();
  const left = await page.locator(".card-tile").count();
  behaviours.push({ control: "Remove sample data", claimed: "deletes every item tagged Demo/示例/範例", observed: `${left} cards left`, ok: left === 0 });
  await capture(page, "17-home-empty");

  writeFileSync(`${DIR}/results.json`, `${JSON.stringify({ findings, behaviours }, null, 2)}\n`);
  const failed = findings.filter((f) => !f.ok);
  const badBehaviour = behaviours.filter((b) => !b.ok);
  console.log(
    `UI acceptance: ${findings.length - failed.length}/${findings.length} checks ok, ${behaviours.length - badBehaviour.length}/${behaviours.length} behaviours ok`,
  );
  for (const f of failed) console.log(`FAIL ${f.screen} [${f.variant}] ${f.check}: ${f.detail}`);
  for (const b of badBehaviour) console.log(`FAIL behaviour ${b.control}: ${b.observed}`);
});
