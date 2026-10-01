import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  /** 32-byte server secret (hex). Keys TOTP-at-rest encryption and IP/prelogin HMACs. */
  secret: Buffer;
  /** One-time token required to create the first (owner) account. */
  setupToken: string | null;
  dataDir: string;
  host: string;
  port: number;
  /** e.g. https://vault.example.com — the only origin allowed to make browser requests. */
  publicOrigin: URL | null;
  /** Trust X-Forwarded-Proto/For from exactly one reverse-proxy hop (bundled Caddy). */
  trustProxy: boolean;
  /** Development escape hatch: plain HTTP is accepted only for localhost hosts. */
  allowInsecureLocalhost: boolean;
  webRoot: string | null;
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  quota: { revisionCount: number; totalBytes: number; vaultsPerAccount: number };
  version: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secretHex = env.QC_SECRET ?? "";
  if (!/^[0-9a-fA-F]{64,}$/.test(secretHex)) {
    throw new ConfigError("QC_SECRET must be at least 32 random bytes in hex (run: openssl rand -hex 32)");
  }
  const setupToken = env.QC_SETUP_TOKEN?.trim() || null;
  if (setupToken !== null && setupToken.length < 24) {
    throw new ConfigError("QC_SETUP_TOKEN must be at least 24 characters (run: openssl rand -hex 16)");
  }
  let publicOrigin: URL | null = null;
  if (env.QC_PUBLIC_ORIGIN) {
    publicOrigin = new URL(env.QC_PUBLIC_ORIGIN);
    if (publicOrigin.origin !== env.QC_PUBLIC_ORIGIN.replace(/\/$/, "")) {
      throw new ConfigError("QC_PUBLIC_ORIGIN must be a bare origin such as https://vault.example.com");
    }
    if (publicOrigin.protocol !== "https:") throw new ConfigError("QC_PUBLIC_ORIGIN must use https://");
  }
  const allowInsecureLocalhost = env.QC_ALLOW_INSECURE_LOCALHOST === "1";
  if (!publicOrigin && !allowInsecureLocalhost) {
    throw new ConfigError("Set QC_PUBLIC_ORIGIN (https://...) or, for local testing only, QC_ALLOW_INSECURE_LOCALHOST=1");
  }
  const webRoot = env.QC_WEB_ROOT ? resolve(env.QC_WEB_ROOT) : null;
  if (webRoot && !existsSync(webRoot)) throw new ConfigError("QC_WEB_ROOT does not exist");
  return {
    secret: Buffer.from(secretHex, "hex"),
    setupToken,
    dataDir: resolve(env.QC_DATA_DIR ?? "./data"),
    host: env.QC_HOST ?? "0.0.0.0",
    port: Number(env.QC_PORT ?? 8080),
    publicOrigin,
    trustProxy: env.QC_TRUST_PROXY === "1",
    allowInsecureLocalhost,
    webRoot,
    sessionIdleSeconds: 30 * 60,
    sessionAbsoluteSeconds: 12 * 60 * 60,
    quota: {
      // Mirrors sync-v1 client limits; the server never accepts more than a client could read.
      revisionCount: 2_000,
      totalBytes: 64 * 1024 * 1024,
      vaultsPerAccount: 8,
    },
    version: env.QC_VERSION ?? "0.1.0-dev",
  };
}
