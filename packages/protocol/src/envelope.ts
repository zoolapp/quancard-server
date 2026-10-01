import { base64, buf, concat, ProtocolError, parseUpperUUID, randomBytes, utf8 } from "./bytes.js";
import { asInteger, asObject, asString, parseStrictJSON } from "./strict-json.js";

/**
 * `quancard.envelope.v1`, byte-compatible with iOS `RecordCipher`:
 * a fresh 256-bit DEK seals the payload with AES-256-GCM; the DEK is wrapped
 * with AES-256-GCM under the caller's key. Both boxes authenticate
 * `quancard.envelope.v1|<stage>|<objectKind>|<UPPERCASE-UUID>` so a ciphertext
 * cannot be replayed into another record, kind or format version.
 */

export const ENVELOPE_FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_DEK_BYTES = NONCE_BYTES + 32 + TAG_BYTES;

export interface EncryptedEnvelope {
  formatVersion: 1;
  recordID: string;
  objectKind: string;
  /** nonce ‖ ciphertext ‖ tag of the 32-byte DEK. */
  wrappedDEK: Uint8Array;
  /** nonce ‖ ciphertext ‖ tag of the payload. */
  payload: Uint8Array;
}

export function envelopeAAD(recordID: string, objectKind: string, stage: "dek" | "payload"): Uint8Array {
  return utf8(`quancard.envelope.v${ENVELOPE_FORMAT_VERSION}|${stage}|${objectKind}|${recordID}`);
}

/** Deterministic randomness is only for public test vectors. */
export interface SealRandomness {
  dek: Uint8Array;
  wrapNonce: Uint8Array;
  payloadNonce: Uint8Array;
}

export async function importAESKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== 32) throw new ProtocolError("invalidData");
  return crypto.subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, extractable, ["encrypt", "decrypt"]);
}

async function gcmSeal(key: CryptoKey, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array) {
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(aad), tagLength: 128 }, key, buf(plaintext));
  return concat(nonce, new Uint8Array(sealed));
}

async function gcmOpen(key: CryptoKey, combined: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (combined.length < NONCE_BYTES + TAG_BYTES) throw new ProtocolError("integrityFailure");
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(combined.subarray(0, NONCE_BYTES)), additionalData: buf(aad), tagLength: 128 },
      key,
      buf(combined.subarray(NONCE_BYTES)),
    );
    return new Uint8Array(opened);
  } catch {
    // One failure for wrong key, tampering and AAD mismatch alike.
    throw new ProtocolError("integrityFailure");
  }
}

export async function sealEnvelope(
  plaintext: Uint8Array,
  recordID: string,
  objectKind: string,
  key: CryptoKey,
  randomness?: SealRandomness,
): Promise<EncryptedEnvelope> {
  parseUpperUUID(recordID, false);
  const dekBytes = randomness?.dek ?? randomBytes(32);
  const wrapNonce = randomness?.wrapNonce ?? randomBytes(NONCE_BYTES);
  const payloadNonce = randomness?.payloadNonce ?? randomBytes(NONCE_BYTES);
  const dek = await importAESKey(dekBytes);
  const payload = await gcmSeal(dek, payloadNonce, plaintext, envelopeAAD(recordID, objectKind, "payload"));
  const wrappedDEK = await gcmSeal(key, wrapNonce, dekBytes, envelopeAAD(recordID, objectKind, "dek"));
  if (!randomness) dekBytes.fill(0);
  return { formatVersion: 1, recordID, objectKind, wrappedDEK, payload };
}

export async function openEnvelope(envelope: EncryptedEnvelope, key: CryptoKey, expected: { recordID: string; objectKind: string }): Promise<Uint8Array> {
  if (envelope.recordID !== expected.recordID || envelope.objectKind !== expected.objectKind) {
    throw new ProtocolError("integrityFailure");
  }
  const dekBytes = await gcmOpen(key, envelope.wrappedDEK, envelopeAAD(envelope.recordID, envelope.objectKind, "dek"));
  if (dekBytes.length !== 32) throw new ProtocolError("integrityFailure");
  const dek = await importAESKey(dekBytes);
  dekBytes.fill(0);
  return gcmOpen(dek, envelope.payload, envelopeAAD(envelope.recordID, envelope.objectKind, "payload"));
}

/**
 * Wire form: compact JSON, sorted keys, standard padded Base64. iOS escapes
 * `/` as `\/`; both forms parse identically, and digests are always computed
 * over the exact bytes received, never over a re-serialization.
 */
export function serializeEnvelope(envelope: EncryptedEnvelope): Uint8Array {
  const json =
    `{"formatVersion":${envelope.formatVersion},"objectKind":${JSON.stringify(envelope.objectKind)},` +
    `"payload":"${base64.encode(envelope.payload)}","recordID":"${envelope.recordID}",` +
    `"wrappedDEK":"${base64.encode(envelope.wrappedDEK)}"}`;
  return utf8(json);
}

export interface EnvelopeLimits {
  maximumBytes: number;
}

/**
 * Structural validation only — safe for the server, which never holds keys.
 * Rejects unknown/duplicate keys, non-canonical Base64 and wrong sizes.
 */
export function parseEnvelope(bytes: Uint8Array, limits: EnvelopeLimits): EncryptedEnvelope {
  if (bytes.length > limits.maximumBytes) throw new ProtocolError("capacityExceeded");
  const root = asObject(parseStrictJSON(bytes).value, ["formatVersion", "recordID", "objectKind", "wrappedDEK", "payload"]);
  const formatVersion = asInteger(root.formatVersion);
  if (formatVersion > ENVELOPE_FORMAT_VERSION) throw new ProtocolError("unsupportedVersion");
  if (formatVersion !== ENVELOPE_FORMAT_VERSION) throw new ProtocolError("integrityFailure");
  const recordID = parseUpperUUID(root.recordID, false);
  const objectKind = asString(root.objectKind);
  if (!/^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(objectKind)) throw new ProtocolError("invalidData");
  const wrappedDEK = base64.decode(asString(root.wrappedDEK), WRAPPED_DEK_BYTES);
  const payload = base64.decode(asString(root.payload));
  if (payload.length < NONCE_BYTES + TAG_BYTES) throw new ProtocolError("invalidData");
  return { formatVersion: 1, recordID, objectKind, wrappedDEK, payload };
}
