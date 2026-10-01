/**
 * Byte helpers shared by Node and browsers. Every decoder here is canonical:
 * input that does not re-encode to exactly the same text is rejected, so two
 * different strings can never name the same bytes.
 */

export class ProtocolError extends Error {
  constructor(
    readonly code:
      | "invalidData"
      | "unsupportedVersion"
      | "integrityFailure"
      | "capacityExceeded"
      | "forbiddenField"
      | "resourceLimitExceeded"
      | "missingParents"
      | "conflict",
  ) {
    // Deliberately carries no input values: errors may end up in logs.
    super(code);
    this.name = "ProtocolError";
  }
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUTF8(bytes: Uint8Array): string {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw new ProtocolError("invalidData");
  }
}

const STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeWith(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + (pad ? "==" : "");
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + (pad ? "=" : "");
  }
  return out;
}

function decodeWith(text: string, alphabet: string, pad: boolean): Uint8Array {
  let body = text;
  if (pad) {
    if (text.length % 4 !== 0) throw new ProtocolError("invalidData");
    body = text.replace(/=+$/, "");
    if (text.length - body.length > 2) throw new ProtocolError("invalidData");
  }
  if (body.length % 4 === 1) throw new ProtocolError("invalidData");
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < body.length; i++) {
    const v = alphabet.indexOf(body[i] as string);
    if (v < 0) throw new ProtocolError("invalidData");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  // Canonical form only: leftover bits must be zero and padding exact.
  if (encodeWith(out, alphabet, pad) !== text) throw new ProtocolError("invalidData");
  return out;
}

/** RFC 4648 standard alphabet with padding (Swift `Data` Codable form). */
export const base64 = {
  encode: (bytes: Uint8Array): string => encodeWith(bytes, STANDARD, true),
  decode: (text: string, expectedBytes?: number): Uint8Array => {
    const bytes = decodeWith(text, STANDARD, true);
    if (expectedBytes !== undefined && bytes.length !== expectedBytes) throw new ProtocolError("invalidData");
    return bytes;
  },
};

/** RFC 4648 URL-safe alphabet without padding (`.qvault` and recovery codes). */
export const base64url = {
  encode: (bytes: Uint8Array): string => encodeWith(bytes, URL_SAFE, false),
  decode: (text: string, expectedBytes?: number): Uint8Array => {
    const bytes = decodeWith(text, URL_SAFE, false);
    if (expectedBytes !== undefined && bytes.length !== expectedBytes) throw new ProtocolError("invalidData");
    return bytes;
  },
};

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Returns a buffer WebCrypto accepts under strict TS lib typings. */
export function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buf(bytes)));
}

/** Random RFC 4122 version-4 UUID, uppercase like Swift `UUID().uuidString`. */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID().toUpperCase();
}

const UUID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/**
 * Canonical uppercase UUID (Swift `uuidString`). Version 4 + RFC 4122 variant
 * is required unless the caller is reading a pre-existing item identifier.
 */
export function parseUpperUUID(value: unknown, requiresVersion4 = true): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new ProtocolError("invalidData");
  if (requiresVersion4 && !isVersion4(value)) throw new ProtocolError("invalidData");
  return value;
}

/** Canonical lowercase UUID used inside vault payload JSON. */
export function parseLowerUUID(value: unknown, requiresVersion4 = false): string {
  if (typeof value !== "string" || value !== value.toLowerCase() || !UUID_PATTERN.test(value.toUpperCase())) {
    throw new ProtocolError("invalidData");
  }
  if (requiresVersion4 && !isVersion4(value.toUpperCase())) throw new ProtocolError("invalidData");
  return value;
}

function isVersion4(upper: string): boolean {
  return upper[14] === "4" && "89AB".includes(upper[19] as string);
}
