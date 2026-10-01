import { mkdirSync } from "node:fs";
import { expect, type Page, type Request, test } from "@playwright/test";
import { hotp } from "../apps/server/src/totp.js";
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
 * One end-to-end story through the real server and the production web bundle.
 * All values are synthetic placeholders (TEST_ONLY / 0000…), never real data.
 */

const USERNAME = "owner";
const PASSWORD = "correct horse battery staple e2e";
const NEW_PASSWORD = "an even longer replacement passphrase";
const PAN = "0000000000001234";
const CVC = "987";
const IBAN = "TEST_ONLY_IBAN_0001";
const VAULT_ID = randomUUID();
const SYNC_KEY = randomBytes(32);
const QC1 = recoveryCode({ vaultID: VAULT_ID, key: SYNC_KEY });

/** Screenshots overwrite tracked files only when explicitly requested (E2E_SCREENSHOTS=1). */
const shotDir = process.env.E2E_SCREENSHOTS === "1" ? "docs/screenshots/mvp" : "test-results/screenshots";
mkdirSync(shotDir, { recursive: true });

const sentBodies: string[] = [];
function record(request: Request) {
  const body = request.postDataBuffer();
  if (body) sentBodies.push(body.toString("latin1"));
  sentBodies.push(request.url());
}

/** Desktop + phone, light + dark. */
async function shoot(page: Page, name: string) {
  const original = page.viewportSize();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [
      ["desktop", { width: 1280, height: 800 }],
      ["mobile", { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${shotDir}/${label}-${scheme}-${name}.png`, fullPage: false });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  if (original) await page.setViewportSize(original);
}

async function syntheticJPEG(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(1200, 760);
    const g = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    g.fillStyle = "#1f4e79";
    g.fillRect(0, 0, 1200, 760);
    g.fillStyle = "#f2d173";
    g.font = "64px sans-serif";
    g.fillText("TEST ONLY", 80, 160);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  return Buffer.from(b64, "base64");
}

test.describe.configure({ mode: "serial" });

test("owner setup, vault, cards, reveal, conflicts, pairing, 2FA and password change", async ({ page, request }) => {
  page.on("request", record);
  await page.goto("/");

  // --- Owner setup -----------------------------------------------------------------
  await expect(page.getByRole("heading", { name: "Set up your server" })).toBeVisible();
  await shoot(page, "setup");
  await page.getByLabel("Setup token").fill(E2E_SETUP_TOKEN);
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password", { exact: true }).fill("too short");
  await page.getByLabel("Confirm password").fill("too short");
  await page.getByLabel("I understand").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toHaveText("Use at least 15 characters.");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  // --- Import an existing vault key (QC1), so this test can act as a second device ---
  await expect(page.getByRole("heading", { name: "Create your vault" })).toBeVisible();
  await page.getByRole("button", { name: "Import with a recovery code" }).click();
  await page.getByLabel("Recovery code").fill("QC1.not-a-code");
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByRole("alert")).toContainText("QC1");
  await page.getByLabel("Recovery code").fill(QC1);
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByRole("tab", { name: /Cards/ })).toBeVisible();
  await shoot(page, "home-empty");

  // --- Add a card with CVC and a photo -----------------------------------------------
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add card" }).click();
  await page.getByLabel("Name").fill("Synthetic Travel Card");
  await page.getByLabel("Bank or issuer").fill("TEST_ONLY Bank");
  await page.getByLabel("Country or region").fill("sg");
  await page.getByLabel("Card number").fill("0000 0000 0000 1234");
  await page.getByLabel("Expiry · Month").fill("12");
  await page.getByLabel("Year").fill("2031");
  await page.getByLabel("Cardholder").fill("TEST HOLDER");
  await page.getByLabel("Security code").fill(CVC);
  await page.getByLabel("Notes").fill("TEST_ONLY lounge access note");
  await shoot(page, "edit");
  await page.locator('input[type="file"]').setInputFiles({ name: "card.jpg", mimeType: "image/jpeg", buffer: await syntheticJPEG(page) });
  await expect(page.getByRole("button", { name: "Remove photo" })).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: /Synthetic Travel Card/ })).toBeVisible();

  // --- Add a bank account ---------------------------------------------------------
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByLabel("Name").fill("Synthetic Savings");
  await page.getByLabel("Bank or issuer").fill("TEST_ONLY Savings Bank");
  await page.getByLabel("Country or region").fill("DE");
  await page.getByLabel("Account number").fill("TEST_ONLY_0001");
  await page.getByLabel("Currencies").fill("eur, usd");
  await page.getByRole("button", { name: "Add routing detail" }).click();
  await page.getByLabel("Value").fill(IBAN);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("tab", { name: /Accounts/ }).click();
  await expect(page.getByText("Synthetic Savings")).toBeVisible();
  await page.getByRole("tab", { name: /Cards/ }).click();

  // A second card so the grid shows more than one face.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add card" }).click();
  await page.getByLabel("Name").fill("Synthetic Debit");
  await page.getByLabel("Bank or issuer").fill("TEST_ONLY Credit Union");
  await page.getByLabel("Country or region").fill("US");
  await page.getByLabel("Network").selectOption("mastercard");
  await page.getByRole("combobox", { name: /^Type/ }).selectOption("debit");
  await page.getByLabel("Card number").fill("0000000000005678");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: /Synthetic Debit/ })).toBeVisible();
  await shoot(page, "home");

  // --- Masked detail and password-gated reveal ------------------------------------
  await page.getByRole("button", { name: /Synthetic Travel Card/ }).click();
  await expect(page.locator(".kv").getByText("•••• 1234")).toBeVisible();
  await expect(page.getByText(CVC)).toHaveCount(0);
  await expect(page.getByText("TEST HOLDER")).toHaveCount(0);
  await expect(page.getByText("TEST_ONLY lounge access note")).toBeVisible();
  await shoot(page, "detail");
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByRole("dialog").getByLabel("Password").fill("wrong password value");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Password is incorrect.");
  await page.getByRole("dialog").getByLabel("Password").fill(PASSWORD);
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("0000 0000 0000 1234")).toBeVisible();
  await expect(page.getByText(CVC)).toBeVisible();
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(page.getByText(CVC)).toHaveCount(0);
  // Within the 5-minute grace window no second prompt appears.
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByText(CVC)).toBeVisible();
  await page.getByRole("button", { name: "Hide" }).click();

  // --- Edit ---------------------------------------------------------------------------
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Name").fill("Synthetic Travel Card Edited");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Synthetic Travel Card Edited" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  // --- Second device: pair, read web revisions with the strict codec, write a concurrent edit
  await page.getByRole("button", { name: "Settings" }).click();
  const pairingResponse = page.waitForResponse((r) => r.url().includes("/pairings") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Pair iPhone" }).click();
  await page.getByRole("dialog").getByLabel("Password").fill(PASSWORD);
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  const pairing = await (await pairingResponse).json();
  await expect(page.getByRole("img", { name: "Pair iPhone" })).toBeVisible();
  await shoot(page, "pairing");
  const pairingRequestBody = (await (await pairingResponse).request().postDataJSON()) as Record<string, unknown>;
  expect(Object.keys(pairingRequestBody)).toEqual(["authKey"]);
  await page.getByRole("button", { name: "Close code" }).click();

  const claim = await request.post("/api/v1/pairings/claim", { data: { code: pairing.code, deviceName: "E2E Phone" } });
  expect(claim.status()).toBe(201);
  const { deviceToken } = await claim.json();
  expect((await request.post("/api/v1/pairings/claim", { data: { code: pairing.code } })).status()).toBe(410);
  const auth = { Authorization: `Bearer ${deviceToken}` };
  const page1 = await (await request.get(`/api/v1/vaults/${VAULT_ID}/revisions?after=0`, { headers: auth })).json();
  const key = await importAESKey(SYNC_KEY);
  const graph = new RevisionGraph(VAULT_ID);
  const nodes = [];
  for (const entry of page1.revisions) nodes.push(await openRevision(base64.decode(entry.body), entry.revisionID, VAULT_ID, key));
  graph.add(nodes);
  const edited = nodes.find((n) => n.snapshot?.items[0]?.displayName === "Synthetic Travel Card Edited");
  expect(edited).toBeTruthy();
  const snapshot = edited!.snapshot!;
  expect(snapshot.payloadSchemaVersion).toBe(2);
  expect(snapshot.items[0]?.paymentCard?.cvc).toBe(CVC);
  expect(snapshot.items[0]?.paymentCard?.pan).toBe(PAN);
  expect(snapshot.artworks).toHaveLength(1);
  const itemID = edited!.revision.itemID;
  const phoneEdit = {
    ...(snapshot.items[0] as NonNullable<(typeof snapshot.items)[0]>),
    displayName: "Renamed On Phone",
    updatedAt: new Date().toISOString(),
  };
  // The phone edits the same head the browser is about to edit: a real fork.
  const parents = graph.parentsFor(itemID);
  const forked = await sealRevision(
    {
      version: 1,
      vaultID: VAULT_ID,
      revisionID: randomUUID(),
      itemID,
      installationID: randomUUID(),
      counter: graph.maximumCounter + 1,
      parents,
      snapshot: await encodePayload([phoneEdit], snapshot.artworks),
    },
    key,
  );
  const put = await request.put(`/api/v1/vaults/${VAULT_ID}/revisions/${forked.revision.revisionID}`, {
    headers: { ...auth, "Content-Type": "application/octet-stream" },
    data: Buffer.from(forked.ciphertext),
  });
  expect(put.status()).toBe(201);

  // The browser has not refreshed, so its edit forks from the same parent.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: /Synthetic Travel Card Edited/ }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Notes").fill("TEST_ONLY edited in browser");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("1 item(s) have conflicting versions")).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Conflicting versions" })).toBeVisible();
  await shoot(page, "conflict");
  await page.locator(".panel", { hasText: "Synthetic Travel Card Edited" }).getByRole("button", { name: "Keep this version" }).click();
  await expect(page.getByRole("heading", { name: "Conflicting versions" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("conflicting versions")).toHaveCount(0);

  // The phone sees a single head again after the merge.
  const after = await (await request.get(`/api/v1/vaults/${VAULT_ID}/revisions?after=0`, { headers: auth })).json();
  const merged = new RevisionGraph(VAULT_ID);
  const all = [];
  for (const entry of after.revisions) all.push(await openRevision(base64.decode(entry.body), entry.revisionID, VAULT_ID, key));
  merged.add(all);
  expect(merged.heads(itemID)).toHaveLength(1);
  expect(merged.heads(itemID)[0]?.revision.parents.length).toBe(2);

  // --- Delete: the item disappears here and the other device sees a tombstone ----------
  await page.getByRole("button", { name: /Synthetic Debit/ }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Delete this item?" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: /Synthetic Debit/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Cards/ })).toContainText("1");
  const afterDelete = await (await request.get(`/api/v1/vaults/${VAULT_ID}/revisions?after=0`, { headers: auth })).json();
  const deletedGraph = new RevisionGraph(VAULT_ID);
  const deletedNodes = [];
  for (const entry of afterDelete.revisions) deletedNodes.push(await openRevision(base64.decode(entry.body), entry.revisionID, VAULT_ID, key));
  deletedGraph.add(deletedNodes);
  const debitID = deletedNodes.find((n) => n.snapshot?.items[0]?.displayName === "Synthetic Debit")?.revision.itemID as string;
  const debitHeads = deletedGraph.heads(debitID);
  expect(debitHeads).toHaveLength(1);
  expect(debitHeads[0]?.snapshot).toBeNull();

  // --- Lock / unlock --------------------------------------------------------------------
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByRole("heading", { name: "Locked" })).toBeVisible();
  await shoot(page, "unlock");
  await page.getByLabel(/Password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("tab", { name: /Cards/ })).toBeVisible();

  // Nothing secret persisted in browser storage.
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const needle of [PASSWORD, PAN, CVC, base64.encode(SYNC_KEY), QC1.split(".")[2] as string]) expect(stored).not.toContain(needle);

  // --- Two-step verification ---------------------------------------------------------
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Turn on" }).click();
  await page.getByRole("dialog").getByLabel("Password").fill(PASSWORD);
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  const secretText = (await page.locator("dialog[open] .mono-wrap").textContent()) ?? "";
  const secret = base32(secretText.trim());
  await page
    .getByRole("dialog")
    .getByLabel("Authenticator code")
    .fill(hotp(secret, Math.floor(Date.now() / 30_000)));
  await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await page.getByRole("button", { name: "I saved these codes" }).click();
  await expect(page.getByText("On — authenticator app")).toBeVisible();
  await shoot(page, "settings");

  // --- Password change, sign out, sign in with new password + TOTP ----------------------
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByRole("dialog").getByLabel("Current password").fill(PASSWORD);
  await page.getByRole("dialog").getByLabel("New password").fill(NEW_PASSWORD);
  await page.getByRole("dialog").getByLabel("Confirm password").fill(NEW_PASSWORD);
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Password changed")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await shoot(page, "signin");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Username or password is incorrect.");
  await page.getByLabel("Password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Authenticator code").fill(hotp(secret, Math.floor(Date.now() / 30_000) + 1));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /Synthetic Travel Card/ })).toBeVisible();

  // --- Zero-knowledge: nothing readable ever left the browser ---------------------------
  const wire = sentBodies.join("\n");
  const plain = [PASSWORD, NEW_PASSWORD, PAN, "0000 0000 0000 1234", '"987"', IBAN, "TEST_ONLY lounge", "Synthetic Travel", "TEST HOLDER"];
  // Also catch plaintext that was merely Base64-encoded or JSON-escaped on its way out.
  const encoded = plain.flatMap((p) => [Buffer.from(p).toString("base64"), Buffer.from(p).toString("base64url"), JSON.stringify(p).slice(1, -1)]);
  for (const needle of [...plain, ...encoded, base64.encode(SYNC_KEY), QC1.split(".")[2] as string]) {
    expect(wire, `request bodies must not contain ${needle}`).not.toContain(needle);
  }
});

function base32(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
