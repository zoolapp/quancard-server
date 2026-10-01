import { base64, buf, ProtocolError, parseUpperUUID, randomBytes, utf8 } from "./bytes.js";
import { importAESKey, openEnvelope, parseEnvelope, type SealRandomness, sealEnvelope, serializeEnvelope } from "./envelope.js";
import { asInteger, asObject, asString, canonicalJSON, parseStrictJSON } from "./strict-json.js";
import type { SyncKeyMaterial } from "./sync.js";

/**
 * auth-v1 (docs/protocol/auth-v1.md). The account password never leaves the
 * browser. Argon2id turns it into a master key; HKDF splits that into an
 * `authKey` (sent to the server, which stores only a second Argon2id hash of
 * it) and a `kek` that wraps a random Account Key. The Account Key in turn
 * wraps each vault's random sync key. Changing the password re-wraps only the
 * Account Key; sync keys and revisions are untouched.
 */

export const ACCOUNT_KDF = {
  algorithm: "argon2id-1.3",
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
  saltBytes: 16,
  outputBytes: 32,
  normalization: "NFC",
} as const;

export const PASSWORD_RULES = { minimumCodePoints: 15, maximumUTF8Bytes: 1_024 } as const;

export const ACCOUNT_KEY_KIND = "accountKey.v1";
export const VAULT_KEY_KIND = "vaultKey.v1";

/** Argon2id implementation supplied by the host (hash-wasm in browsers, node:crypto on servers). */
export type Argon2id = (input: {
  password: Uint8Array;
  salt: Uint8Array;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  outputBytes: number;
}) => Promise<Uint8Array>;

export function normalizePassword(password: string): Uint8Array {
  const normalized = password.normalize("NFC");
  const bytes = utf8(normalized);
  if (bytes.length === 0 || bytes.length > PASSWORD_RULES.maximumUTF8Bytes) throw new ProtocolError("invalidData");
  return bytes;
}

/** Creation-time policy (NIST SP 800-63B-4 style: length, no composition rules). */
export function passwordMeetsPolicy(password: string): boolean {
  const normalized = password.normalize("NFC");
  return [...normalized].length >= PASSWORD_RULES.minimumCodePoints && utf8(normalized).length <= PASSWORD_RULES.maximumUTF8Bytes;
}

export interface AccountSecrets {
  /** 32 bytes; sent to the server as proof of password knowledge. */
  authKey: Uint8Array;
  /** Non-extractable AES-GCM key wrapping the Account Key. */
  kek: CryptoKey;
}

async function hkdf(masterKey: CryptoKey, info: string): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: buf(utf8(info)) }, masterKey, 256);
}

export async function deriveAccountSecrets(password: string, salt: Uint8Array, argon2id: Argon2id): Promise<AccountSecrets> {
  if (salt.length !== ACCOUNT_KDF.saltBytes) throw new ProtocolError("invalidData");
  const passwordBytes = normalizePassword(password);
  const master = await argon2id({
    password: passwordBytes,
    salt,
    memoryKiB: ACCOUNT_KDF.memoryKiB,
    iterations: ACCOUNT_KDF.iterations,
    parallelism: ACCOUNT_KDF.parallelism,
    outputBytes: ACCOUNT_KDF.outputBytes,
  });
  passwordBytes.fill(0);
  if (master.length !== 32) throw new ProtocolError("invalidData");
  const masterKey = await crypto.subtle.importKey("raw", buf(master), "HKDF", false, ["deriveBits"]);
  master.fill(0);
  const authKey = new Uint8Array(await hkdf(masterKey, "quancard.auth.v1|auth"));
  const kekBytes = new Uint8Array(await hkdf(masterKey, "quancard.auth.v1|kek"));
  const kek = await importAESKey(kekBytes);
  kekBytes.fill(0);
  return { authKey, kek };
}

export function newAccountKey(): Uint8Array {
  return randomBytes(32);
}

export async function wrapAccountKey(accountKey: Uint8Array, accountID: string, kek: CryptoKey, randomness?: SealRandomness): Promise<Uint8Array> {
  parseUpperUUID(accountID);
  const plaintext = utf8(canonicalJSON({ version: 1, accountID, key: base64.encode(accountKey) }));
  return serializeEnvelope(await sealEnvelope(plaintext, accountID, ACCOUNT_KEY_KIND, kek, randomness));
}

/** Returns a non-extractable key plus the raw bytes; callers that do not re-wrap must zero `raw` immediately. */
export async function unwrapAccountKey(bytes: Uint8Array, accountID: string, kek: CryptoKey): Promise<{ key: CryptoKey; raw: Uint8Array }> {
  const envelope = parseEnvelope(bytes, { maximumBytes: 4096 });
  const plain = await openEnvelope(envelope, kek, { recordID: accountID, objectKind: ACCOUNT_KEY_KIND });
  const object = asObject(parseStrictJSON(plain).value, ["version", "accountID", "key"]);
  if (asInteger(object.version) !== 1 || object.accountID !== accountID) throw new ProtocolError("integrityFailure");
  const raw = base64.decode(asString(object.key), 32);
  return { key: await importAESKey(raw), raw };
}

export async function wrapVaultKey(material: SyncKeyMaterial, accountKey: CryptoKey, randomness?: SealRandomness): Promise<Uint8Array> {
  parseUpperUUID(material.vaultID);
  const plaintext = utf8(canonicalJSON({ version: 1, vaultID: material.vaultID, key: base64.encode(material.key) }));
  return serializeEnvelope(await sealEnvelope(plaintext, material.vaultID, VAULT_KEY_KIND, accountKey, randomness));
}

export async function unwrapVaultKey(bytes: Uint8Array, vaultID: string, accountKey: CryptoKey): Promise<SyncKeyMaterial> {
  const envelope = parseEnvelope(bytes, { maximumBytes: 4096 });
  const plain = await openEnvelope(envelope, accountKey, { recordID: vaultID, objectKind: VAULT_KEY_KIND });
  const object = asObject(parseStrictJSON(plain).value, ["version", "vaultID", "key"]);
  if (asInteger(object.version) !== 1 || object.vaultID !== vaultID) throw new ProtocolError("integrityFailure");
  return { vaultID, key: base64.decode(asString(object.key), 32) };
}
