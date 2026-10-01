import "@fastify/cookie";
import { bytesEqual } from "@quancard/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { type Database, now } from "./db.js";
import { ApiError, DEVICE_AUTHORIZATION, isLocalRequest, RateLimiter } from "./http-guard.js";
import { hashAuthKey, ServerKeys, safeEqual, sha256, token } from "./security.js";

export const SESSION_COOKIE = "__Host-qc_session";
const DEVICE_PREFIX = "qcd_";
const LOCK_AFTER_FAILURES = 10;
const LOCK_SECONDS = 15 * 60;

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

  /**
   * Atomic failure accounting: 10 consecutive failures (wrong password or
   * wrong second factor, from any client) lock the account for 15 minutes.
   */
  recordAuthFailure(userID: string): void {
    this.db
      .prepare(
        `UPDATE users SET
           locked_until = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END,
           failed_logins = CASE WHEN failed_logins + 1 >= ? THEN 0 ELSE failed_logins + 1 END
         WHERE id = ?`,
      )
      .run(LOCK_AFTER_FAILURES, now() + LOCK_SECONDS, LOCK_AFTER_FAILURES, userID);
  }

  /**
   * Re-authentication for sensitive actions. Returns the *current* user row,
   * re-validated after the Argon2 await: if the password, security stamp or
   * the session itself changed meanwhile, the stale proof is rejected. Callers
   * must not await again before committing their change.
   */
  async requireFreshAuth(principal: Extract<Principal, { kind: "session" }>, authKey: Uint8Array): Promise<UserRow> {
    const before = principal.user;
    this.sensitiveLimiter.check(`reauth:${before.id}`);
    if (before.locked_until > now()) throw new ApiError(429, "accountLocked", { retryAfterSeconds: before.locked_until - now() });
    const ok = await this.verifyAuthKey(before, authKey);
    const fresh = this.user(before.id);
    const session = this.db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(principal.sessionHash);
    if (!fresh || !session || fresh.security_stamp !== before.security_stamp || !bytesEqual(fresh.verifier, before.verifier)) {
      throw new ApiError(401, "unauthorized");
    }
    if (!ok) {
      this.recordAuthFailure(fresh.id);
      throw new ApiError(401, "invalidCredentials");
    }
    return fresh;
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
    // An Authorization header means device auth, full stop: never fall back to the cookie.
    if (authorization !== undefined) {
      if (!DEVICE_AUTHORIZATION.test(authorization)) return null;
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
