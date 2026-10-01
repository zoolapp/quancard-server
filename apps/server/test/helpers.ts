import { argon2 } from "node:crypto";
import {
  type Argon2id,
  base64,
  deriveAccountSecrets,
  importAESKey,
  newAccountKey,
  randomBytes,
  randomUUID,
  sealManifest,
  unwrapAccountKey,
  wrapAccountKey,
  wrapVaultKey,
} from "@quancard/protocol";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";
import { openMemoryDatabase } from "../src/db.js";

export const SETUP_TOKEN = "test-setup-token-0123456789abcdef";
export const ORIGIN = "https://vault.example.com";

export const argon2id: Argon2id = (input) =>
  new Promise((resolve, reject) =>
    argon2(
      "argon2id",
      {
        message: input.password,
        nonce: input.salt,
        memory: input.memoryKiB,
        passes: input.iterations,
        parallelism: input.parallelism,
        tagLength: input.outputBytes,
      },
      (error, key) => (error ? reject(error) : resolve(new Uint8Array(key))),
    ),
  );

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    QC_SECRET: "11".repeat(32),
    QC_SETUP_TOKEN: SETUP_TOKEN,
    QC_PUBLIC_ORIGIN: ORIGIN,
    QC_TRUST_PROXY: "1",
    QC_DATA_DIR: "/nonexistent-not-used",
    ...overrides,
  });
}

export async function makeApp(overrides: Record<string, string> = {}) {
  const db = openMemoryDatabase();
  const app = await buildApp(testConfig(overrides), db);
  return { app, db };
}

let ipCounter = 1;
/** Each test client gets its own IP so rate limits don't leak across tests. */
export function newClientIP(): string {
  ipCounter++;
  return `203.0.113.${ipCounter % 250}`;
}

export class Client {
  cookie: string | null = null;
  constructor(
    readonly app: FastifyInstance,
    readonly ip = newClientIP(),
  ) {}

  async request(options: InjectOptions & { secure?: boolean; bearer?: string; noOrigin?: boolean }): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {
      host: "vault.example.com",
      "x-forwarded-for": this.ip,
      ...(options.secure === false ? {} : { "x-forwarded-proto": "https" }),
      ...(options.noOrigin ? {} : { origin: ORIGIN, "x-quancard-client": "web" }),
      ...((options.headers as Record<string, string>) ?? {}),
    };
    if (this.cookie && !options.bearer) headers.cookie = this.cookie;
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    const response = await this.app.inject({ ...options, headers });
    const set = response.headers["set-cookie"];
    const first = Array.isArray(set) ? set[0] : set;
    if (first?.startsWith("__Host-qc_session=")) {
      const value = first.split(";")[0] as string;
      this.cookie = value.endsWith("=") ? null : value;
    }
    return response;
  }
}

export interface TestAccount {
  client: Client;
  username: string;
  password: string;
  accountID: string;
  authKey: Uint8Array;
  accountKey: CryptoKey;
}

export async function registerOwner(app: FastifyInstance, username = "owner", password = "a long test-only password"): Promise<TestAccount> {
  const client = new Client(app);
  const salt = randomBytes(16);
  const secrets = await deriveAccountSecrets(password, salt, argon2id);
  const accountID = randomUUID();
  const raw = newAccountKey();
  const response = await client.request({
    method: "POST",
    url: "/api/v1/setup",
    payload: {
      setupToken: SETUP_TOKEN,
      username,
      accountID,
      kdfSalt: base64.encode(salt),
      authKey: base64.encode(secrets.authKey),
      wrappedAccountKey: base64.encode(await wrapAccountKey(raw, accountID, secrets.kek)),
    },
  });
  if (response.statusCode !== 201) throw new Error(`setup failed: ${response.body}`);
  return { client, username, password, accountID, authKey: secrets.authKey, accountKey: await importAESKey(raw) };
}

export async function login(app: FastifyInstance, username: string, password: string, extra: Record<string, string> = {}, client = new Client(app)) {
  const pre = await client.request({ method: "POST", url: "/api/v1/auth/prelogin", payload: { username } });
  const salt = base64.decode(pre.json().kdf.salt);
  const secrets = await deriveAccountSecrets(password, salt, argon2id);
  const response = await client.request({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, authKey: base64.encode(secrets.authKey), ...extra },
  });
  return { client, response, secrets };
}

export async function unwrapFromLogin(body: { accountID: string; wrappedAccountKey: string }, kek: CryptoKey) {
  return unwrapAccountKey(base64.decode(body.wrappedAccountKey), body.accountID, kek);
}

export async function createVault(account: TestAccount) {
  const vaultID = randomUUID();
  const keyBytes = randomBytes(32);
  const key = await importAESKey(keyBytes);
  const manifest = await sealManifest({ vaultID, key: keyBytes }, key);
  const wrappedKey = await wrapVaultKey({ vaultID, key: keyBytes }, account.accountKey);
  const response = await account.client.request({
    method: "POST",
    url: "/api/v1/vaults",
    payload: { vaultID, manifest: base64.encode(manifest), wrappedKey: base64.encode(wrappedKey) },
  });
  return { vaultID, keyBytes, key, response };
}
