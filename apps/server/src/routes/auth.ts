import { ACCOUNT_KDF, bytesEqual, parseEnvelope } from "@quancard/protocol";
import type { FastifyInstance } from "fastify";
import type { Context, UserRow } from "../context.js";
import { now, transaction } from "../db.js";
import { ApiError } from "../http-guard.js";
import { hashAuthKey, safeEqualText, sha256, token } from "../security.js";
import { newRecoveryCodes, newTOTPSecret, normalizeRecoveryCode, otpauthURI, verifyTOTP } from "../totp.js";
import { body, bytesField, optionalText, textField, username, uuidField } from "../validate.js";

/**
 * Concurrency rule for this file: Argon2 work is awaited first, outside any
 * transaction; afterwards the handler re-reads current state inside one
 * synchronous IMMEDIATE transaction and applies conditional updates. No await
 * happens between the re-read and the write, so two in-flight requests can
 * never act on the same stale snapshot.
 */

const INVITE_SECONDS = 7 * 24 * 60 * 60;

/** Fields shared by setup and invite registration (auth-v1 §3). */
const REGISTRATION_FIELDS = ["username", "accountID", "kdfSalt", "authKey", "wrappedAccountKey"] as const;

function kdfDescriptor(salt: Uint8Array) {
  return {
    algorithm: ACCOUNT_KDF.algorithm,
    memoryKiB: ACCOUNT_KDF.memoryKiB,
    iterations: ACCOUNT_KDF.iterations,
    parallelism: ACCOUNT_KDF.parallelism,
    outputBytes: ACCOUNT_KDF.outputBytes,
    normalization: ACCOUNT_KDF.normalization,
    salt: Buffer.from(salt).toString("base64"),
  };
}

function checkWrappedAccountKey(bytes: Uint8Array, accountID: string): void {
  try {
    const envelope = parseEnvelope(bytes, { maximumBytes: 4096 });
    if (envelope.objectKind !== "accountKey.v1" || envelope.recordID !== accountID) throw new Error();
  } catch {
    throw new ApiError(400, "badRequest");
  }
}

export function accountView(_ctx: Context, user: UserRow) {
  return {
    accountID: user.id,
    username: user.username,
    isOwner: user.is_owner === 1,
    kdf: kdfDescriptor(user.kdf_salt),
    wrappedAccountKey: Buffer.from(user.wrapped_account_key).toString("base64"),
    totpEnabled: user.totp_secret !== null,
    recoveryCodesRemaining: user.recovery_codes ? (JSON.parse(user.recovery_codes) as string[]).length : 0,
    createdAt: user.created_at,
    passwordChangedAt: user.password_changed_at,
  };
}

function userCount(ctx: Context): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

function setupTokenConsumed(ctx: Context, tokenValue: string): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM server_state WHERE key = 'setup_token_consumed' AND value = ?").get(sha256(tokenValue).toString("hex"));
}

interface PreparedUser {
  name: string;
  accountID: string;
  kdfSalt: Uint8Array;
  wrapped: Uint8Array;
  verifier: Buffer;
  verifierSalt: Buffer;
}

/** Validates registration fields and does the expensive hashing; writes nothing. */
async function prepareUser(fields: Record<string, unknown>): Promise<PreparedUser> {
  const name = username(fields.username);
  const accountID = uuidField(fields.accountID);
  const kdfSalt = bytesField(fields.kdfSalt, ACCOUNT_KDF.saltBytes);
  const authKey = bytesField(fields.authKey, 32);
  const wrapped = bytesField(fields.wrappedAccountKey, undefined, 4096);
  checkWrappedAccountKey(wrapped, accountID);
  const verifierSalt = Buffer.from(token(16), "base64url");
  const verifier = await hashAuthKey(authKey, verifierSalt);
  return { name, accountID, kdfSalt, wrapped, verifier, verifierSalt };
}

/** Must run inside a transaction. */
function insertUser(ctx: Context, user: PreparedUser, isOwner: boolean): UserRow {
  if (ctx.userByName(user.name)) throw new ApiError(409, "usernameTaken");
  if (ctx.user(user.accountID)) throw new ApiError(409, "usernameTaken");
  const at = now();
  ctx.db
    .prepare(
      `INSERT INTO users (id, username, is_owner, kdf_salt, verifier, verifier_salt, wrapped_account_key, security_stamp, created_at, password_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(user.accountID, user.name, isOwner ? 1 : 0, user.kdfSalt, user.verifier, user.verifierSalt, user.wrapped, token(16), at, at);
  return ctx.user(user.accountID) as UserRow;
}

type FactorResult = "ok" | "required" | "invalid";

/**
 * Consumes a TOTP step or recovery code from the *current* row with
 * compare-and-set updates. Must run inside a transaction.
 */
function consumeSecondFactor(ctx: Context, user: UserRow, fields: Record<string, unknown>): FactorResult {
  if (!user.totp_secret) return "ok";
  if (typeof fields.totp === "string") {
    const secret = ctx.keys.open(user.totp_secret, `totp|${user.id}`);
    const step = verifyTOTP(secret, fields.totp, Date.now(), user.totp_last_step);
    if (step === null) return "invalid";
    const updated = ctx.db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").run(step, user.id, step);
    return updated.changes === 1 ? "ok" : "invalid";
  }
  if (typeof fields.recoveryCode === "string") {
    const stored = user.recovery_codes ? (JSON.parse(user.recovery_codes) as string[]) : [];
    const digest = ctx.keys.hmac("recovery", normalizeRecoveryCode(fields.recoveryCode)).toString("hex");
    const index = stored.findIndex((candidate) => safeEqualText(candidate, digest));
    if (index < 0) return "invalid";
    const remaining = stored.filter((_, i) => i !== index);
    const updated = ctx.db
      .prepare("UPDATE users SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?")
      .run(JSON.stringify(remaining), user.id, user.recovery_codes as string);
    return updated.changes === 1 ? "ok" : "invalid";
  }
  return "required";
}

function factorError(result: FactorResult): ApiError {
  return result === "required" ? new ApiError(401, "secondFactorRequired") : new ApiError(401, "invalidSecondFactor");
}

export function registerAuthRoutes(app: FastifyInstance, ctx: Context): void {
  app.get("/api/v1/status", async () => {
    const users = userCount(ctx);
    const token = ctx.config.setupToken;
    return {
      service: "quancard-server",
      version: ctx.config.version,
      setupRequired: users === 0,
      setupEnabled: token !== null && users === 0 && !setupTokenConsumed(ctx, token),
      protocol: { auth: 1, sync: 1, envelope: 1 },
      // Feature discovery for clients other than the bundled web app (macOS, future apps):
      // branch on these, never on the version string.
      capabilities: {
        payloadSchemas: [1, 2],
        pairing: 1,
        twoFactor: ["totp", "recoveryCode"],
        passkeys: false,
        invites: true,
        multipleVaults: ctx.config.quota.vaultsPerAccount > 1,
      },
      limits: {
        revisionsPerVault: ctx.config.quota.revisionCount,
        bytesPerVault: ctx.config.quota.totalBytes,
        vaultsPerAccount: ctx.config.quota.vaultsPerAccount,
      },
    };
  });

  app.post("/api/v1/setup", async (request, reply) => {
    ctx.authLimiter.check(`setup:${ctx.clientTag(request)}`);
    const fields = body(request.body, ["setupToken", ...REGISTRATION_FIELDS]);
    const expected = ctx.config.setupToken;
    if (!expected || userCount(ctx) > 0 || setupTokenConsumed(ctx, expected)) throw new ApiError(403, "setupClosed");
    if (!safeEqualText(textField(fields.setupToken, 256), expected)) throw new ApiError(403, "invalidSetupToken");
    const prepared = await prepareUser(fields);
    const user = transaction(ctx.db, () => {
      // Re-check after hashing: only one concurrent setup may create the owner, and a token works once.
      if (userCount(ctx) > 0 || setupTokenConsumed(ctx, expected)) throw new ApiError(403, "setupClosed");
      const created = insertUser(ctx, prepared, true);
      ctx.db
        .prepare("INSERT INTO server_state (key, value) VALUES ('setup_token_consumed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(sha256(expected).toString("hex"));
      return created;
    });
    ctx.audit("setup.owner_created", user.id, request);
    ctx.issueSession(reply, request, user);
    return reply.code(201).send(accountView(ctx, user));
  });

  app.post("/api/v1/invites", async (request, reply) => {
    const { user } = ctx.requireSession(request);
    if (user.is_owner !== 1) throw new ApiError(403, "forbidden");
    const code = token(18);
    const at = now();
    ctx.db
      .prepare("INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(code), user.id, at, at + INVITE_SECONDS);
    ctx.audit("invite.created", user.id, request);
    return reply.code(201).send({ code, expiresAt: at + INVITE_SECONDS });
  });

  app.post("/api/v1/register", async (request, reply) => {
    ctx.authLimiter.check(`register:${ctx.clientTag(request)}`);
    const fields = body(request.body, ["inviteCode", ...REGISTRATION_FIELDS]);
    const codeHash = sha256(textField(fields.inviteCode, 64));
    const valid = () => ctx.db.prepare("SELECT 1 FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").get(codeHash, now()) !== undefined;
    if (!valid()) throw new ApiError(403, "invalidInvite");
    const prepared = await prepareUser(fields);
    // User creation and invite consumption commit together or not at all.
    const user = transaction(ctx.db, () => {
      if (!valid()) throw new ApiError(403, "invalidInvite");
      const created = insertUser(ctx, prepared, false);
      ctx.db.prepare("UPDATE invites SET used_at = ? WHERE code_hash = ?").run(now(), codeHash);
      return created;
    });
    ctx.audit("account.registered", user.id, request);
    ctx.issueSession(reply, request, user);
    return reply.code(201).send(accountView(ctx, user));
  });

  app.post("/api/v1/auth/prelogin", async (request) => {
    ctx.authLimiter.check(`prelogin:${ctx.clientTag(request)}`);
    const fields = body(request.body, ["username"]);
    const name = username(fields.username);
    const user = ctx.userByName(name);
    // Unknown users get a stable decoy salt so the response does not reveal account existence.
    return { kdf: kdfDescriptor(user ? user.kdf_salt : ctx.keys.decoySalt(name)) };
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    ctx.authLimiter.check(`login:${ctx.clientTag(request)}`);
    const fields = body(request.body, ["username", "authKey", "totp", "recoveryCode"]);
    const name = username(fields.username);
    const authKey = bytesField(fields.authKey, 32);
    const snapshot = ctx.userByName(name);
    if (!snapshot) {
      // Spend the same work as a real check to blunt timing-based enumeration.
      await hashAuthKey(authKey, ctx.keys.decoySalt(name));
      throw new ApiError(401, "invalidCredentials");
    }
    if (snapshot.locked_until > now()) {
      ctx.audit("login.locked", snapshot.id, request);
      throw new ApiError(429, "accountLocked", { retryAfterSeconds: snapshot.locked_until - now() });
    }
    const passwordOK = await ctx.verifyAuthKey(snapshot, authKey);

    const outcome = transaction(ctx.db, () => {
      const user = ctx.user(snapshot.id);
      // The password may have changed while we hashed; a match against the old verifier proves nothing now.
      if (!user || !bytesEqual(user.verifier, snapshot.verifier)) return { error: new ApiError(401, "invalidCredentials") };
      if (user.locked_until > now()) return { error: new ApiError(429, "accountLocked", { retryAfterSeconds: user.locked_until - now() }) };
      if (!passwordOK) {
        ctx.recordAuthFailure(user.id);
        return { error: new ApiError(401, "invalidCredentials"), failure: user.id };
      }
      const factor = consumeSecondFactor(ctx, user, fields);
      if (factor !== "ok") {
        // Wrong second factors count against the same per-account budget as wrong passwords.
        if (factor === "invalid") ctx.recordAuthFailure(user.id);
        return { error: factorError(factor), failure: factor === "invalid" ? user.id : undefined };
      }
      ctx.db.prepare("UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?").run(user.id);
      return { user: ctx.user(user.id) as UserRow, usedRecovery: typeof fields.totp !== "string" && user.totp_secret !== null };
    });
    if ("error" in outcome) {
      if (outcome.failure) ctx.audit("login.failure", outcome.failure, request);
      throw outcome.error;
    }
    if (outcome.usedRecovery) ctx.audit("recovery_code.used", outcome.user.id, request);
    ctx.audit("login.success", outcome.user.id, request);
    ctx.issueSession(reply, request, outcome.user);
    return accountView(ctx, outcome.user);
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const principal = ctx.authenticate(request);
    if (principal?.kind === "session") {
      ctx.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(principal.sessionHash);
      ctx.audit("logout", principal.user.id, request);
    }
    ctx.clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/api/v1/account", async (request) => accountView(ctx, ctx.requireSession(request).user));

  app.post("/api/v1/account/password", async (request, reply) => {
    const principal = ctx.requireSession(request);
    const fields = body(request.body, ["currentAuthKey", "kdfSalt", "authKey", "wrappedAccountKey"]);
    const kdfSalt = bytesField(fields.kdfSalt, ACCOUNT_KDF.saltBytes);
    const authKey = bytesField(fields.authKey, 32);
    const wrapped = bytesField(fields.wrappedAccountKey, undefined, 4096);
    checkWrappedAccountKey(wrapped, principal.user.id);
    const verifierSalt = Buffer.from(token(16), "base64url");
    const verifier = await hashAuthKey(authKey, verifierSalt);
    // Last await: everything after re-validates and commits synchronously.
    const fresh = await ctx.requireFreshAuth(principal, bytesField(fields.currentAuthKey, 32));
    transaction(ctx.db, () => {
      const updated = ctx.db
        .prepare(
          "UPDATE users SET kdf_salt = ?, verifier = ?, verifier_salt = ?, wrapped_account_key = ?, security_stamp = ?, password_changed_at = ? WHERE id = ? AND security_stamp = ?",
        )
        .run(kdfSalt, verifier, verifierSalt, wrapped, token(16), now(), fresh.id, fresh.security_stamp);
      if (updated.changes !== 1) throw new ApiError(409, "staleCredentials");
      ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(fresh.id);
      ctx.db.prepare("DELETE FROM pairings WHERE user_id = ?").run(fresh.id);
    });
    ctx.audit("password.changed", fresh.id, request);
    // Every other browser session is signed out; this one gets a fresh session.
    const after = ctx.user(fresh.id) as UserRow;
    ctx.issueSession(reply, request, after);
    return accountView(ctx, after);
  });

  app.post("/api/v1/account/totp/setup", async (request) => {
    const principal = ctx.requireSession(request);
    const fields = body(request.body, ["authKey"]);
    const user = await ctx.requireFreshAuth(principal, bytesField(fields.authKey, 32));
    if (user.totp_secret) throw new ApiError(409, "totpAlreadyEnabled");
    const secret = newTOTPSecret();
    ctx.db.prepare("UPDATE users SET totp_pending = ? WHERE id = ? AND totp_secret IS NULL").run(ctx.keys.seal(secret, `totp-pending|${user.id}`), user.id);
    return { otpauthURI: otpauthURI(secret, user.username, "QuanCard") };
  });

  app.post("/api/v1/account/totp/enable", async (request) => {
    const { user } = ctx.requireSession(request);
    ctx.sensitiveLimiter.check(`totp:${user.id}`);
    const fields = body(request.body, ["code"]);
    if (!user.totp_pending || user.totp_secret) throw new ApiError(409, "totpNotPending");
    const secret = ctx.keys.open(user.totp_pending, `totp-pending|${user.id}`);
    const step = verifyTOTP(secret, textField(fields.code, 6));
    if (step === null) throw new ApiError(401, "invalidSecondFactor");
    const codes = newRecoveryCodes();
    const hashes = codes.map((c) => ctx.keys.hmac("recovery", normalizeRecoveryCode(c)).toString("hex"));
    const updated = ctx.db
      .prepare(
        "UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_last_step = ?, recovery_codes = ? WHERE id = ? AND totp_secret IS NULL AND totp_pending = ?",
      )
      .run(ctx.keys.seal(secret, `totp|${user.id}`), step, JSON.stringify(hashes), user.id, user.totp_pending);
    if (updated.changes !== 1) throw new ApiError(409, "totpNotPending");
    ctx.audit("totp.enabled", user.id, request);
    return { recoveryCodes: codes };
  });

  app.post("/api/v1/account/totp/disable", async (request) => {
    const principal = ctx.requireSession(request);
    const fields = body(request.body, ["authKey", "totp", "recoveryCode"]);
    const fresh = await ctx.requireFreshAuth(principal, bytesField(fields.authKey, 32));
    const failure = transaction(ctx.db, () => {
      const user = ctx.user(fresh.id) as UserRow;
      const factor = consumeSecondFactor(ctx, user, fields);
      if (factor !== "ok") {
        if (factor === "invalid") ctx.recordAuthFailure(user.id);
        return factorError(factor);
      }
      ctx.db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = -1, recovery_codes = NULL WHERE id = ?").run(user.id);
      return null;
    });
    if (failure) throw failure;
    ctx.audit("totp.disabled", fresh.id, request);
    return { totpEnabled: false };
  });

  app.get("/api/v1/account/sessions", async (request) => {
    const principal = ctx.requireSession(request);
    const rows = ctx.db
      .prepare("SELECT public_id, created_at, last_seen_at, expires_at, client_hint FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC")
      .all(principal.user.id) as { public_id: string; created_at: number; last_seen_at: number; expires_at: number; client_hint: string | null }[];
    return {
      sessions: rows.map((r) => ({
        id: r.public_id,
        current: r.public_id === principal.publicID,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        expiresAt: r.expires_at,
        client: r.client_hint,
      })),
    };
  });

  app.post("/api/v1/account/sessions/revoke-others", async (request) => {
    const principal = ctx.requireSession(request);
    const result = ctx.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(principal.user.id, principal.sessionHash);
    ctx.audit("sessions.revoked", principal.user.id, request);
    return { revoked: Number(result.changes) };
  });

  app.get("/api/v1/account/audit", async (request) => {
    const { user } = ctx.requireSession(request);
    const rows = ctx.db.prepare("SELECT id, at, event, ip_tag FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT 200").all(user.id) as {
      id: number;
      at: number;
      event: string;
      ip_tag: string | null;
    }[];
    return { events: rows.map((r) => ({ id: r.id, at: r.at, event: r.event, client: r.ip_tag })) };
  });

  app.delete("/api/v1/account", async (request, reply) => {
    const principal = ctx.requireSession(request);
    const fields = body(request.body, ["authKey", "confirm"]);
    const user = await ctx.requireFreshAuth(principal, bytesField(fields.authKey, 32));
    if (optionalText(fields.confirm, 64) !== user.username) throw new ApiError(400, "confirmationMismatch");
    transaction(ctx.db, () => {
      if (user.is_owner === 1 && userCount(ctx) > 1) throw new ApiError(409, "ownerHasMembers");
      ctx.db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
      ctx.db.prepare("DELETE FROM audit_events WHERE user_id = ?").run(user.id);
    });
    // Kept without a user reference so the operator can see that a deletion happened, not by whom.
    ctx.audit("account.deleted", null, request);
    ctx.clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
