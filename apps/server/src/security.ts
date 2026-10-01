import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** Server-side secrets handling. Nothing here ever sees vault keys or plaintext. */

const VERIFIER = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

/** Second Argon2id over the client's high-entropy authKey (defense in depth if the DB leaks). */
export function hashAuthKey(authKey: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2("argon2id", { message: authKey, nonce: salt, ...VERIFIER }, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Compare secrets of possibly different lengths without leaking where they differ. */
export function safeEqualText(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export class ServerKeys {
  private readonly hmacKey: Buffer;
  private readonly atRestKey: Buffer;

  constructor(secret: Buffer) {
    this.hmacKey = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "quancard.server.v1|hmac", 32));
    this.atRestKey = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "quancard.server.v1|at-rest", 32));
  }

  hmac(domain: string, value: string | Uint8Array): Buffer {
    return createHmac("sha256", this.hmacKey).update(`${domain}\u0000`).update(value).digest();
  }

  /** Stable pseudonymous tag for audit/rate-limit records; raw IPs are never stored. */
  ipTag(ip: string): string {
    return this.hmac("ip", ip).subarray(0, 8).toString("hex");
  }

  /** Deterministic decoy salt so prelogin does not reveal whether a username exists. */
  decoySalt(username: string): Buffer {
    return this.hmac("prelogin", username.toLowerCase()).subarray(0, 16);
  }

  seal(plaintext: Buffer, context: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.atRestKey, nonce);
    cipher.setAAD(Buffer.from(`quancard.server.v1|${context}`));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]);
  }

  open(sealed: Uint8Array, context: string): Buffer {
    const buffer = Buffer.from(sealed);
    const decipher = createDecipheriv("aes-256-gcm", this.atRestKey, buffer.subarray(0, 12));
    decipher.setAAD(Buffer.from(`quancard.server.v1|${context}`));
    decipher.setAuthTag(buffer.subarray(buffer.length - 16));
    return Buffer.concat([decipher.update(buffer.subarray(12, buffer.length - 16)), decipher.final()]);
  }
}
