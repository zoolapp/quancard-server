import { base64, deriveAccountSecrets, randomBytes, randomUUID, wrapAccountKey } from "@quancard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { hotp } from "../src/totp.js";
import { argon2id, Client, login, makeApp, ORIGIN, registerOwner, SETUP_TOKEN } from "./helpers.js";

/** Regression tests for the second-opinion review (F1–F8): races across Argon2 awaits. */

const apps: { close: () => Promise<unknown> }[] = [];
async function setup(overrides: Record<string, string> = {}) {
  const made = await makeApp(overrides);
  apps.push(made.app);
  return made;
}
afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
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

async function enableTOTP(owner: Awaited<ReturnType<typeof registerOwner>>) {
  const r = await owner.client.request({ method: "POST", url: "/api/v1/account/totp/setup", payload: { authKey: base64.encode(owner.authKey) } });
  const secret = base32Decode(new URL(r.json().otpauthURI).searchParams.get("secret") as string);
  const enable = await owner.client.request({
    method: "POST",
    url: "/api/v1/account/totp/enable",
    payload: { code: hotp(secret, Math.floor(Date.now() / 30_000)) },
  });
  return { secret, recoveryCodes: enable.json().recoveryCodes as string[] };
}

describe("races across password hashing", () => {
  it("F1: the same TOTP code or recovery code succeeds only once under concurrency", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const { secret, recoveryCodes } = await enableTOTP(owner);
    const code = hotp(secret, Math.floor(Date.now() / 30_000) + 1);
    const both = await Promise.all([login(app, owner.username, owner.password, { totp: code }), login(app, owner.username, owner.password, { totp: code })]);
    expect(both.map((r) => r.response.statusCode).sort()).toEqual([200, 401]);
    const rc = recoveryCodes[0] as string;
    const twice = await Promise.all([
      login(app, owner.username, owner.password, { recoveryCode: rc }),
      login(app, owner.username, owner.password, { recoveryCode: rc }),
    ]);
    expect(twice.map((r) => r.response.statusCode).sort()).toEqual([200, 401]);
    // Two different recovery codes at once must both be consumed, not resurrect each other.
    const [a, b] = [recoveryCodes[1] as string, recoveryCodes[2] as string];
    await Promise.all([login(app, owner.username, owner.password, { recoveryCode: a }), login(app, owner.username, owner.password, { recoveryCode: b })]);
    expect((await login(app, owner.username, owner.password, { recoveryCode: a })).response.statusCode).toBe(401);
    expect((await login(app, owner.username, owner.password, { recoveryCode: b })).response.statusCode).toBe(401);
  });

  it("F2: ten concurrent wrong passwords lock the account", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        new Client(app).request({ method: "POST", url: "/api/v1/auth/login", payload: { username: owner.username, authKey: base64.encode(randomBytes(32)) } }),
      ),
    );
    expect((await login(app, owner.username, owner.password)).response.json().error).toBe("accountLocked");
  });

  it("F2: wrong second factors with the right password count toward the lockout", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    await enableTOTP(owner);
    for (let i = 0; i < 10; i++) {
      const r = await login(app, owner.username, owner.password, { totp: "000000" }, new Client(app));
      expect(r.response.statusCode).toBe(401);
    }
    expect((await login(app, owner.username, owner.password, { totp: "000000" })).response.json().error).toBe("accountLocked");
  });

  it("F3: concurrent password changes from the same stale state commit at most once", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const second = await login(app, owner.username, owner.password);
    const change = async (client: Client, password: string) => {
      const salt = randomBytes(16);
      const next = await deriveAccountSecrets(password, salt, argon2id);
      return client.request({
        method: "POST",
        url: "/api/v1/account/password",
        payload: {
          currentAuthKey: base64.encode(owner.authKey),
          kdfSalt: base64.encode(salt),
          authKey: base64.encode(next.authKey),
          wrappedAccountKey: base64.encode(await wrapAccountKey(randomBytes(32), owner.accountID, next.kek)),
        },
      });
    };
    const results = await Promise.all([change(owner.client, "first replacement passphrase"), change(second.client, "second replacement passphrase")]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const winner = results[0]?.statusCode === 200 ? "first replacement passphrase" : "second replacement passphrase";
    expect((await login(app, owner.username, winner)).response.statusCode).toBe(200);
  });

  it("F8: concurrent setup requests create exactly one owner, and the token works once", async () => {
    const { app, db } = await setup();
    const results = await Promise.allSettled([registerOwner(app, "alpha"), registerOwner(app, "bravo"), registerOwner(app, "charlie")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(1);
    const owner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof registerOwner>>>;
    const del = await owner.value.client.request({
      method: "DELETE",
      url: "/api/v1/account",
      payload: { authKey: base64.encode(owner.value.authKey), confirm: owner.value.username },
    });
    expect(del.statusCode).toBe(204);
    // An empty server does not silently reopen setup with the already-used token.
    await expect(registerOwner(app, "delta")).rejects.toThrow(/setupClosed/);
  });

  it("F8: an invite is consumed atomically with account creation", async () => {
    const { app, db } = await setup();
    const owner = await registerOwner(app);
    const invite = (await owner.client.request({ method: "POST", url: "/api/v1/invites", payload: {} })).json().code as string;
    const register = async (name: string) => {
      const salt = randomBytes(16);
      const secrets = await deriveAccountSecrets("member long password!", salt, argon2id);
      const accountID = randomUUID();
      return new Client(app).request({
        method: "POST",
        url: "/api/v1/register",
        payload: {
          inviteCode: invite,
          username: name,
          accountID,
          kdfSalt: base64.encode(salt),
          authKey: base64.encode(secrets.authKey),
          wrappedAccountKey: base64.encode(await wrapAccountKey(randomBytes(32), accountID, secrets.kek)),
        },
      });
    };
    const results = await Promise.all([register("member1"), register("member2")]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(2);
  });
});

describe("request trust", () => {
  it("F7: an unrecognised Authorization header neither bypasses CSRF nor falls back to the cookie", async () => {
    const { app } = await setup();
    const owner = await registerOwner(app);
    const r = await owner.client.request({
      method: "POST",
      url: "/api/v1/account/sessions/revoke-others",
      payload: {},
      noOrigin: true,
      headers: { authorization: "Bearer garbage" },
    });
    expect(r.statusCode).toBe(403);
    const withOrigin = await owner.client.request({ method: "GET", url: "/api/v1/account", headers: { authorization: "Bearer garbage" } });
    expect(withOrigin.statusCode).toBe(401);
  });

  it("F6: forged X-Forwarded-Proto from a public peer is not trusted", async () => {
    const { app } = await setup();
    const forged = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      remoteAddress: "198.51.100.7",
      headers: { host: "vault.example.com", "x-forwarded-proto": "https", origin: ORIGIN },
    });
    expect(forged.statusCode).toBe(426);
    const proxied = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      remoteAddress: "172.18.0.3",
      headers: { host: "vault.example.com", "x-forwarded-proto": "https" },
    });
    expect(proxied.statusCode).toBe(200);
  });

  it("F6: the localhost development exemption requires a local peer", async () => {
    const { app } = await setup({ QC_PUBLIC_ORIGIN: "", QC_ALLOW_INSECURE_LOCALHOST: "1", QC_TRUST_PROXY: "0" });
    const remote = await app.inject({ method: "GET", url: "/api/v1/status", remoteAddress: "198.51.100.7", headers: { host: "localhost:8080" } });
    expect(remote.statusCode).toBe(426);
  });
});

void SETUP_TOKEN;
