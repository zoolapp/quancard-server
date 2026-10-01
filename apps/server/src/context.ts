import "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { type Database, now } from "./db.js";
import { ApiError, isLocalRequest, RateLimiter } from "./http-guard.js";
import { hashAuthKey, ServerKeys, safeEqual, sha256, token } from "./security.js";

export const SESSION_COOKIE = "__Host-qc_session";
const DEVICE_PREFIX = "qcd_";

export type AuditEvent =
  | "setup.owner_created"
  | "account.registered"
  | "login.success"
  | "login.failure"
  | "login.locked"
  | "logout"
  | "password.changed"
  | "totp.enabled"
  | "totp.disabled"
  | "recovery_code.used"
  | "sessions.revoked"
  | "invite.created"
  | "vault.created"
  | "vault.deleted"
  | "pairing.created"
  | "pairing.claimed"
  | "device.revoked"
  | "account.deleted";

export interface UserRow {
  id: string;
  username: string;
  is_owner: number;
  kdf_salt: Uint8Array;
  verifier: Uint8Array;
  verifier_salt: Uint8Array;
  wrapped_account_key: Uint8Array;
  totp_secret: Uint8Array | null;
  totp_pending: Uint8Array | null;
  totp_last_step: number;
  recovery_codes: string | null;
  failed_logins: number;
  locked_until: number;
  security_stamp: string;
  created_at: number;
  password_changed_at: number;
}

export type Principal =
  | { kind: "session"; user: UserRow; sessionHash: Buffer; publicID: string }
  | { kind: "device"; user: UserRow; deviceID: string; vaultID: string };

export class Context {
  readonly keys: ServerKeys;
  /** Unauthenticated credential endpoints: 10 attempts per minute per client. */
  readonly authLimiter = new RateLimiter(10, 60_000);
  /** Sensitive re-auth endpoints (pairing, password, TOTP) per account. */
  readonly sensitiveLimiter = new RateLimiter(10, 60_000);

  constructor(
    readonly config: Config,
    readonly db: Database,
  ) {
    this.keys = new ServerKeys(config.secret);
  }

  clientTag(request: FastifyRequest): string {
    return this.keys.ipTag(request.ip);
  }

  audit(event: AuditEvent, userID: string | null, request: FastifyRequest | null): void {
    this.db
      .prepare("INSERT INTO audit_events (at, user_id, event, ip_tag) VALUES (?, ?, ?, ?)")
      .run(now(), userID, event, request ? this.clientTag(request) : null);
  }

  user(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  userByName(username: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
  }

  async verifyAuthKey(user: UserRow, authKey: Uint8Array): Promise<boolean> {
    const candidate = await hashAuthKey(authKey, user.verifier_salt);
    return safeEqual(candidate, user.verifier);
  }

  /** Re-authentication for sensitive actions, rate limited per account. */
  async requireFreshAuth(user: UserRow, authKey: Uint8Array): Promise<void> {
    this.sensitiveLimiter.check(`reauth:${user.id}`);
    if (!(await this.verifyAuthKey(user, authKey))) throw new ApiError(401, "invalidCredentials");
  }

  issueSession(reply: FastifyReply, request: FastifyRequest, user: UserRow): void {
    const value = token(32);
    const at = now();
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, public_id, user_id, security_stamp, created_at, last_seen_at, expires_at, client_hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(sha256(value), token(9), user.id, user.security_stamp, at, at, at + this.config.sessionAbsoluteSeconds, clientHint(request));
    reply.setCookie(SESSION_COOKIE, value, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: this.config.sessionAbsoluteSeconds,
    });
  }

  clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, secure: true, sameSite: "strict" });
  }

  issueDeviceToken(): { value: string; hash: Buffer } {
    const value = `${DEVICE_PREFIX}${token(32)}`;
    return { value, hash: sha256(value) };
  }

  authenticate(request: FastifyRequest): Principal | null {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith(`Bearer ${DEVICE_PREFIX}`)) {
      const value = authorization.slice("Bearer ".length);
      const device = this.db.prepare("SELECT id, user_id, vault_id FROM devices WHERE token_hash = ?").get(sha256(value)) as
        | { id: string; user_id: string; vault_id: string }
        | undefined;
      if (!device) return null;
      const user = this.user(device.user_id);
      if (!user) return null;
      this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now(), device.id);
      return { kind: "device", user, deviceID: device.id, vaultID: device.vault_id };
    }
    const cookie = request.cookies[SESSION_COOKIE];
    if (!cookie) return null;
    const hash = sha256(cookie);
    const session = this.db.prepare("SELECT public_id, user_id, security_stamp, last_seen_at, expires_at FROM sessions WHERE token_hash = ?").get(hash) as
      | { public_id: string; user_id: string; security_stamp: string; last_seen_at: number; expires_at: number }
      | undefined;
    if (!session) return null;
    const at = now();
    const user = this.user(session.user_id);
    if (!user || at >= session.expires_at || at - session.last_seen_at > this.config.sessionIdleSeconds || session.security_stamp !== user.security_stamp) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
      return null;
    }
    if (at - session.last_seen_at >= 30) this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(at, hash);
    return { kind: "session", user, sessionHash: hash, publicID: session.public_id };
  }

  requireSession(request: FastifyRequest): Extract<Principal, { kind: "session" }> {
    const principal = this.authenticate(request);
    if (principal?.kind !== "session") throw new ApiError(401, "unauthorized");
    return principal;
  }

  /** Session users reach their own vaults; paired devices reach only their single vault. */
  requireVaultAccess(request: FastifyRequest, vaultID: string): Principal {
    const principal = this.authenticate(request);
    if (!principal) throw new ApiError(401, "unauthorized");
    if (principal.kind === "device" && principal.vaultID !== vaultID) throw new ApiError(404, "notFound");
    const vault = this.db.prepare("SELECT user_id FROM vaults WHERE id = ?").get(vaultID) as { user_id: string } | undefined;
    if (!vault || vault.user_id !== principal.user.id) throw new ApiError(404, "notFound");
    return principal;
  }

  isLocal(request: FastifyRequest): boolean {
    return isLocalRequest(this.config, request);
  }
}

/** Coarse, non-identifying client label shown in the session list. */
function clientHint(request: FastifyRequest): string {
  const ua = String(request.headers["user-agent"] ?? "");
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} · ${os}` : browser;
}
