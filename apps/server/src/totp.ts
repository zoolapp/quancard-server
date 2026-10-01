import { createHmac, randomBytes } from "node:crypto";

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — the profile every authenticator app supports. */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function newTOTPSecret(): Buffer {
  return randomBytes(20);
}

export function hotp(secret: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Returns the matched time step so callers can reject reuse of the same code
 * (replay protection), or null. Accepts ±1 step of clock skew.
 */
export function verifyTOTP(secret: Uint8Array, code: string, at = Date.now(), lastUsedStep = -1): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const step = Math.floor(at / 1000 / 30);
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate > lastUsedStep && hotp(secret, candidate) === code) return candidate;
  }
  return null;
}

export function otpauthURI(secret: Uint8Array, username: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Ten single-use recovery codes, 10 bytes of entropy each, grouped for readability. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const raw = base32Encode(randomBytes(10));
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, "");
}
