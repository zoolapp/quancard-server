import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  base64,
  deriveAccountSecrets,
  encodePayload,
  openRevision,
  randomBytes,
  randomUUID,
  sealRevision,
  unwrapVaultKey,
  type VaultItem,
  wrapAccountKey,
} from "@quancard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, openDatabase } from "../src/db.js";
import { hotp } from "../src/totp.js";
import { argon2id, Client, createVault, login, makeApp, registerOwner, unwrapFromLogin } from "./helpers.js";

const apps: { close: () => Promise<unknown> }[] = [];
async function setup(overrides: Record<string, string> = {}) {
  const made = await makeApp(overrides);
  apps.push(made.app);
  return made;
}
afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

function syntheticCard(): VaultItem {
  return {
    itemSchemaVersion: 1,
    id: randomUUID().toLowerCase(),
    displayName: "Synthetic Zero-Knowledge Probe",
    institutionName: "TEST_ONLY Bank",
    country: "SG",
    tags: [],
    notes: "TEST_ONLY secret note",
    artworkTemplateID: "graphite",
    artworkBlobID: null,
    lifecycle: "active",
    isFavorite: false,
    manualSortPosition: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    kind: "paymentCard",
    paymentCard: {
      cardholderName: "TEST HOLDER",
      pan: "0000000000000000",
      expiryMonth: 1,
      expiryYear: 2031,
      cvc: "000",
      network: "visa",
      fundingType: "credit",
      formFactor: "physical",
      walletProvisions: [],
    },
    bankAccount: null,
  };
}

describe("transport security", () => {
  it("refuses plain HTTP with 426 and still serves the loopback health check", async () => {
    const { app } = await setup();
    const client = new Client(app);
    const api = await client.request({ method: "POST", url: "/api/v1/auth/login", payload: {}, secure: false });
    expect(api.statusCode).toBe(426);
    expect(api.json()).toEqual({ error: "httpsRequired" });
    const page = await client.request({ method: "GET", url: "/", secure: false });
    expect(page.statusCode).toBe(426);
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.json()).toEqual({ ok: true });
  });

  it("ignores X-Forwarded-Proto unless the proxy is trusted", async () => {
    const { app } = await setup({ QC_TRUST_PROXY: "0" });
    const response = await new Client(app).request({ method: "GET", url: "/api/v1/status" });
    expect(response.statusCode).toBe(426);
  });

  it("allows localhost over HTTP only with the explicit development flag", async () => {
    const { app } = await setup({ QC_PUBLIC_ORIGIN: "", QC_ALLOW_INSECURE_LOCALHOST: "1", QC_TRUST_PROXY: "0" });
    const local = await app.inject({ method: "GET", url: "/api/v1/status", headers: { host: "localhost:8080" } });
    expect(local.statusCode).toBe(200);
    const remote = await app.inject({ method: "GET", url: "/api/v1/status", headers: { host: "vault.example.com" } });
    expect(remote.statusCode).toBe(426);
  });

  it("rejects foreign Host headers and cross-origin writes", async () => {
    const { app } = await setup();
    const client = new Client(app);
    const wrongHost = await client.request({ method: "GET", url: "/api/v1/status", headers: { host: "evil.example" } });
    expect(wrongHost.statusCode).toBe(421);
    const noOrigin = await client.request({ method: "POST", url: "/api/v1/auth/prelogin", payload: { username: "x1x" }, noOrigin: true });
    expect(noOrigin.statusCode).toBe(403);
    const evil = await client.request({
      method: "POST",
      url: "/api/v1/auth/prelogin",
      payload: { username: "x1x" },
      noOrigin: true,
      headers: { origin: "https://evil.example", "x-quancard-client": "web" },
    });
    expect(evil.statusCode).toBe(403);
  });

  it("sends strict security headers", async () => {
    const { app } = await setup();
    const response = await new Client(app).request({ method: "GET", url: "/api/v1/status" });
    const csp = String(response.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("accounts", () => {
  it("creates the owner once with the setup token", async () => {
    const { app } = await setup();
    const client = new Client(app);
    const bad = await client.request({ method: "POST", url: "/api/v1/setup", payload: { setupToken: "wrong", username: "abc" } });
    expect(bad.statusCode).toBe(403);
    const owner = await registerOwner(app);
    expect(owner.client.cookie).toMatch(/^__Host-qc_session=/);
    const again = await registerOwner(app, "second").catch((e: Error) => e.message);
    expect(again).toContain("setupClosed");
    const status = await client.request({ method: "GET", url: "/api/v1/status" });
    expect(status.json().setupRequired).toBe(false);
    // Capability discovery for non-web clients; no secrets, no account data.
    expect(status.json().capabilities).toMatchObject({ payloadSchemas: [1, 2], pairing: 1, passkeys: false, invites: true });
    expect(status.json().limits.revisionsPerVault).toBeGreaterThan(0);
  });

  it("sets a host-only, HttpOnly, Secure, SameSite=Strict session cookie", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const { response } = await login(app, owner.username, owner.password);
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toMatch(/^__Host-qc_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain");
  });

  it("returns a stable decoy salt for unknown users", async () => {
    const { app } = await setup();
    const client = new Client(app);
    const a = await client.request({ method: "POST", url: "/api/v1/auth/prelogin", payload: { username: "nobody" } });
    const b = await client.request({ method: "POST", url: "/api/v1/auth/prelogin", payload: { username: "NOBODY" } });
    expect(a.statusCode).toBe(200);
    expect(a.json().kdf.salt).toBe(b.json().kdf.salt);
    expect(a.json().kdf.memoryKiB).toBe(65536);
  });

  it("logs in with the password and unwraps the account key client-side", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const { response, secrets } = await login(app, owner.username, owner.password);
    expect(response.statusCode).toBe(200);
    const unwrapped = await unwrapFromLogin(response.json(), secrets.kek);
    expect(unwrapped.raw).toHaveLength(32);
    const wrong = await login(app, owner.username, "the wrong long password");
    expect(wrong.response.statusCode).toBe(401);
    expect(wrong.response.json()).toEqual({ error: "invalidCredentials" });
    const unknown = await login(app, "ghost", "the wrong long password");
    expect(unknown.response.json()).toEqual({ error: "invalidCredentials" });
  });

  it("rate limits credential attempts per client (A9)", async () => {
    const { app } = await setup();
    const client = new Client(app);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await client.request({ method: "POST", url: "/api/v1/auth/login", payload: { username: "ghost", authKey: base64.encode(new Uint8Array(32)) } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("locks an account after ten failures from many clients", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    for (let i = 0; i < 10; i++) {
      const r = await new Client(app).request({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: owner.username, authKey: base64.encode(randomBytes(32)) },
      });
      expect(r.statusCode).toBe(401);
    }
    const { response } = await login(app, owner.username, owner.password);
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toBe("accountLocked");
  });

  it("changes the password, re-wraps the account key and signs out other sessions (A10)", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const other = await login(app, owner.username, owner.password);
    const vault = await createVault(owner);
    expect(vault.response.statusCode).toBe(201);

    const login1 = await login(app, owner.username, owner.password);
    const { raw } = await unwrapFromLogin(login1.response.json(), login1.secrets.kek);
    const newPassword = "an entirely new long password";
    const salt = randomBytes(16);
    const next = await deriveAccountSecrets(newPassword, salt, argon2id);
    const change = await owner.client.request({
      method: "POST",
      url: "/api/v1/account/password",
      payload: {
        currentAuthKey: base64.encode(owner.authKey),
        kdfSalt: base64.encode(salt),
        authKey: base64.encode(next.authKey),
        wrappedAccountKey: base64.encode(await wrapAccountKey(raw, owner.accountID, next.kek)),
      },
    });
    expect(change.statusCode).toBe(200);
    expect((await other.client.request({ method: "GET", url: "/api/v1/account" })).statusCode).toBe(401);
    expect((await owner.client.request({ method: "GET", url: "/api/v1/account" })).statusCode).toBe(200);
    expect((await login(app, owner.username, owner.password)).response.statusCode).toBe(401);
    const fresh = await login(app, owner.username, newPassword);
    expect(fresh.response.statusCode).toBe(200);
    const account = await unwrapFromLogin(fresh.response.json(), fresh.secrets.kek);
    const vaults = await fresh.client.request({ method: "GET", url: "/api/v1/vaults" });
    const material = await unwrapVaultKey(base64.decode(vaults.json().vaults[0].wrappedKey), vault.vaultID, account.key);
    expect(material.key).toEqual(vault.keyBytes);
  });

  it("enforces TOTP with replay protection and single-use recovery codes", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const setupResponse = await owner.client.request({ method: "POST", url: "/api/v1/account/totp/setup", payload: { authKey: base64.encode(owner.authKey) } });
    const uri = new URL(setupResponse.json().otpauthURI);
    const secretB32 = uri.searchParams.get("secret") as string;
    const secret = base32Decode(secretB32);
    const code = hotp(secret, Math.floor(Date.now() / 30_000));
    const enable = await owner.client.request({ method: "POST", url: "/api/v1/account/totp/enable", payload: { code } });
    expect(enable.statusCode).toBe(200);
    const recoveryCodes: string[] = enable.json().recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);

    const missing = await login(app, owner.username, owner.password);
    expect(missing.response.json()).toEqual({ error: "secondFactorRequired" });
    const replay = await login(app, owner.username, owner.password, { totp: code });
    expect(replay.response.json()).toEqual({ error: "invalidSecondFactor" });
    const nextCode = hotp(secret, Math.floor(Date.now() / 30_000) + 1);
    expect((await login(app, owner.username, owner.password, { totp: nextCode })).response.statusCode).toBe(200);
    const recovery = recoveryCodes[0] as string;
    expect((await login(app, owner.username, owner.password, { recoveryCode: recovery.toLowerCase() })).response.statusCode).toBe(200);
    expect((await login(app, owner.username, owner.password, { recoveryCode: recovery })).response.statusCode).toBe(401);
  });

  it("supports owner invites for additional family members", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const invite = await owner.client.request({ method: "POST", url: "/api/v1/invites", payload: {} });
    expect(invite.statusCode).toBe(201);
    const client = new Client(app);
    const salt = randomBytes(16);
    const secrets = await deriveAccountSecrets("member long password!", salt, argon2id);
    const accountID = randomUUID();
    const payload = {
      inviteCode: invite.json().code,
      username: "member",
      accountID,
      kdfSalt: base64.encode(salt),
      authKey: base64.encode(secrets.authKey),
      wrappedAccountKey: base64.encode(await wrapAccountKey(randomBytes(32), accountID, secrets.kek)),
    };
    expect((await client.request({ method: "POST", url: "/api/v1/register", payload })).statusCode).toBe(201);
    const reuse = await new Client(app).request({
      method: "POST",
      url: "/api/v1/register",
      payload: { ...payload, username: "member2", accountID: randomUUID() },
    });
    expect(reuse.statusCode).toBe(403);
  });
});

describe("vault data plane", () => {
  async function revisionBytes(vault: { vaultID: string; key: CryptoKey }) {
    const item = syntheticCard();
    const node = await sealRevision(
      {
        version: 1,
        vaultID: vault.vaultID,
        revisionID: randomUUID(),
        itemID: item.id.toUpperCase(),
        installationID: randomUUID(),
        counter: 1,
        parents: [],
        snapshot: await encodePayload([item], []),
      },
      vault.key,
    );
    return node;
  }

  it("stores immutable revisions idempotently and pages them back (A7)", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const vault = await createVault(owner);
    const node = await revisionBytes(vault);
    const url = `/api/v1/vaults/${vault.vaultID}/revisions/${node.revision.revisionID}`;
    const put = (bytes: Uint8Array) =>
      owner.client.request({ method: "PUT", url, payload: Buffer.from(bytes), headers: { "content-type": "application/octet-stream" } });
    expect((await put(node.ciphertext)).statusCode).toBe(201);
    expect((await put(node.ciphertext)).statusCode).toBe(200);
    const resealed = await sealRevision(node.revision, vault.key);
    const conflict = await put(resealed.ciphertext);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "revisionConflict" });

    const list = await owner.client.request({ method: "GET", url: `/api/v1/vaults/${vault.vaultID}/revisions?after=0` });
    expect(list.headers["cache-control"]).toBe("no-store");
    const page = list.json();
    expect(page.revisions).toHaveLength(1);
    expect(page.lastSeq).toBe(1);
    const fetched = base64.decode(page.revisions[0].body);
    const opened = await openRevision(fetched, node.revision.revisionID, vault.vaultID, vault.key);
    expect(opened.digest).toBe(node.digest);
    expect(opened.snapshot?.items[0]?.paymentCard?.cvc).toBe("000");
  });

  it("rejects envelopes that are malformed, mis-bound or too large (A8)", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const vault = await createVault(owner);
    const node = await revisionBytes(vault);
    const headers = { "content-type": "application/octet-stream" };
    const otherID = randomUUID();
    const misbound = await owner.client.request({
      method: "PUT",
      url: `/api/v1/vaults/${vault.vaultID}/revisions/${otherID}`,
      payload: Buffer.from(node.ciphertext),
      headers,
    });
    expect(misbound.statusCode).toBe(400);
    const junk = await owner.client.request({
      method: "PUT",
      url: `/api/v1/vaults/${vault.vaultID}/revisions/${otherID}`,
      payload: Buffer.from("{}"),
      headers,
    });
    expect(junk.statusCode).toBe(400);
    const big = await owner.client.request({
      method: "PUT",
      url: `/api/v1/vaults/${vault.vaultID}/revisions/${otherID}`,
      payload: Buffer.alloc(16 * 1024 * 1024 + 1),
      headers,
    });
    expect(big.statusCode).toBe(413);
  });

  it("enforces the per-vault revision quota with 507", async () => {
    const { app, db } = await setup();
    const owner = await registerOwner(app);
    const vault = await createVault(owner);
    db.prepare("UPDATE vaults SET revision_count = 2000 WHERE id = ?").run(vault.vaultID);
    const node = await revisionBytes(vault);
    const response = await owner.client.request({
      method: "PUT",
      url: `/api/v1/vaults/${vault.vaultID}/revisions/${node.revision.revisionID}`,
      payload: Buffer.from(node.ciphertext),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(response.statusCode).toBe(507);
    expect(response.json()).toEqual({ error: "capacity" });
  });

  it("isolates vaults between accounts", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const vault = await createVault(owner);
    const anonymous = new Client(app);
    expect((await anonymous.request({ method: "GET", url: "/api/v1/vaults" })).statusCode).toBe(401);
    expect((await anonymous.request({ method: "GET", url: `/api/v1/vaults/${vault.vaultID}/manifest` })).statusCode).toBe(401);
    const invite = await owner.client.request({ method: "POST", url: "/api/v1/invites", payload: {} });
    const salt = randomBytes(16);
    const secrets = await deriveAccountSecrets("member long password!", salt, argon2id);
    const accountID = randomUUID();
    const member = new Client(app);
    await member.request({
      method: "POST",
      url: "/api/v1/register",
      payload: {
        inviteCode: invite.json().code,
        username: "member",
        accountID,
        kdfSalt: base64.encode(salt),
        authKey: base64.encode(secrets.authKey),
        wrappedAccountKey: base64.encode(await wrapAccountKey(randomBytes(32), accountID, secrets.kek)),
      },
    });
    expect((await member.request({ method: "GET", url: `/api/v1/vaults/${vault.vaultID}/manifest` })).statusCode).toBe(404);
    expect((await member.request({ method: "GET", url: "/api/v1/vaults" })).json().vaults).toEqual([]);
  });

  it("pairs a device once, scopes it to one vault and supports revocation (A13)", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const vault = await createVault(owner);
    const other = await createVault(owner);
    const pairing = await owner.client.request({
      method: "POST",
      url: `/api/v1/vaults/${vault.vaultID}/pairings`,
      payload: { authKey: base64.encode(owner.authKey) },
    });
    expect(pairing.statusCode).toBe(201);
    const code: string = pairing.json().code;
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const phone = new Client(app);
    const claim = await phone.request({ method: "POST", url: "/api/v1/pairings/claim", payload: { code, deviceName: "Test iPhone" }, noOrigin: true });
    expect(claim.statusCode).toBe(201);
    const deviceToken: string = claim.json().deviceToken;
    expect((await phone.request({ method: "POST", url: "/api/v1/pairings/claim", payload: { code }, noOrigin: true })).statusCode).toBe(410);
    const manifest = await phone.request({ method: "GET", url: `/api/v1/vaults/${vault.vaultID}/manifest`, bearer: deviceToken, noOrigin: true });
    expect(manifest.statusCode).toBe(200);
    expect((await phone.request({ method: "GET", url: `/api/v1/vaults/${other.vaultID}/manifest`, bearer: deviceToken, noOrigin: true })).statusCode).toBe(404);
    expect((await phone.request({ method: "GET", url: "/api/v1/vaults", bearer: deviceToken, noOrigin: true })).statusCode).toBe(401);
    const node = await revisionBytes(vault);
    const put = await phone.request({
      method: "PUT",
      url: `/api/v1/vaults/${vault.vaultID}/revisions/${node.revision.revisionID}`,
      payload: Buffer.from(node.ciphertext),
      headers: { "content-type": "application/octet-stream" },
      bearer: deviceToken,
      noOrigin: true,
    });
    expect(put.statusCode).toBe(201);
    const devices = await owner.client.request({ method: "GET", url: "/api/v1/devices" });
    const deviceID = devices.json().devices[0].deviceID;
    expect((await owner.client.request({ method: "DELETE", url: `/api/v1/devices/${deviceID}` })).statusCode).toBe(204);
    expect((await phone.request({ method: "GET", url: `/api/v1/vaults/${vault.vaultID}/manifest`, bearer: deviceToken, noOrigin: true })).statusCode).toBe(401);
  });

  it("expires pairing codes", async () => {
    const { app, db } = await setup();
    const owner = await registerOwner(app);
    const vault = await createVault(owner);
    const pairing = await owner.client.request({
      method: "POST",
      url: `/api/v1/vaults/${vault.vaultID}/pairings`,
      payload: { authKey: base64.encode(owner.authKey) },
    });
    db.prepare("UPDATE pairings SET expires_at = 0").run();
    const claim = await new Client(app).request({ method: "POST", url: "/api/v1/pairings/claim", payload: { code: pairing.json().code }, noOrigin: true });
    expect(claim.statusCode).toBe(410);
  });

  it("never stores plaintext or keys (A5 zero-knowledge probe)", async () => {
    const { app, db } = await setup();
    const owner = await registerOwner(app);
    const vault = await createVault(owner);
    const node = await revisionBytes(vault);
    await owner.client.request({
      method: "PUT",
      url: `/api/v1/vaults/${vault.vaultID}/revisions/${node.revision.revisionID}`,
      payload: Buffer.from(node.ciphertext),
      headers: { "content-type": "application/octet-stream" },
    });
    const dump: string[] = [];
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
        for (const value of Object.values(row as Record<string, unknown>)) {
          dump.push(value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : String(value));
        }
      }
    }
    const haystack = dump.join("\n");
    for (const needle of [
      "Synthetic Zero-Knowledge Probe",
      "TEST_ONLY",
      "0000000000000000",
      owner.password,
      base64.encode(vault.keyBytes),
      base64.encode(owner.authKey),
    ]) {
      expect(haystack).not.toContain(needle);
    }
  });

  it("keeps the audit log append-only", async () => {
    const { app, db } = await setup();
    await registerOwner(app);
    expect(() => db.prepare("UPDATE audit_events SET event = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
  });

  it("deletes a vault only with fresh authentication", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const vault = await createVault(owner);
    const bad = await owner.client.request({ method: "DELETE", url: `/api/v1/vaults/${vault.vaultID}`, payload: { authKey: base64.encode(randomBytes(32)) } });
    expect(bad.statusCode).toBe(401);
    const ok = await owner.client.request({ method: "DELETE", url: `/api/v1/vaults/${vault.vaultID}`, payload: { authKey: base64.encode(owner.authKey) } });
    expect(ok.statusCode).toBe(204);
    expect((await owner.client.request({ method: "GET", url: "/api/v1/vaults" })).json().vaults).toEqual([]);
  });
});

describe("migrations (A14)", () => {
  it("migrates a fresh database and refuses to downgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "qc-migrate-"));
    const db = openDatabase(dir);
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(MIGRATIONS.length);
    db.prepare("UPDATE schema_version SET version = ?").run(MIGRATIONS.length + 1);
    db.close();
    expect(() => openDatabase(dir)).toThrow(/downgrade refused/);
  });

  it("applies pending migrations in order inside transactions", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, ["CREATE TABLE a (x INTEGER)"]);
    migrate(db, ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y INTEGER)"]);
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(2);
    expect(() => migrate(db, ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y INTEGER)", "CREATE TABLE broken ("])).toThrow();
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(2);
  });
});

function base32Decode(text: string): Uint8Array {
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
