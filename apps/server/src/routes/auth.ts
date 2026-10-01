import { ACCOUNT_KDF, parseEnvelope } from "@quancard/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Context, UserRow } from "../context.js";
import { now, transaction } from "../db.js";
import { ApiError } from "../http-guard.js";
import { hashAuthKey, safeEqualText, sha256, token } from "../security.js";
import { newRecoveryCodes, newTOTPSecret, normalizeRecoveryCode, otpauthURI, verifyTOTP } from "../totp.js";
import { body, bytesField, optionalText, textField, username, uuidField } from "../validate.js";

const LOCK_AFTER_FAILURES = 10;
const LOCK_SECONDS = 15 * 60;
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

export function accountView(ctx: Context, user: UserRow) {
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
    signupsOpen: ctx.config.setupToken !== null && userCount(ctx) === 0,
  };
}

function userCount(ctx: Context): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

async function createUser(ctx: Context, fields: Record<string, unknown>, isOwner: boolean): Promise<UserRow> {
  const name = username(fields.username);
  const accountID = uuidField(fields.accountID);
  const kdfSalt = bytesField(fields.kdfSalt, ACCOUNT_KDF.saltBytes);
  const authKey = bytesField(fields.authKey, 32);
  const wrapped = bytesField(fields.wrappedAccountKey, undefined, 4096);
  checkWrappedAccountKey(wrapped, accountID);
  if (ctx.userByName(name)) throw new ApiError(409, "usernameTaken");
  const verifierSalt = Buffer.from(token(16), "base64url");
  const verifier = await hashAuthKey(authKey, verifierSalt);
  const at = now();
  ctx.db
    .prepare(
      `INSERT INTO users (id, username, is_owner, kdf_salt, verifier, verifier_salt, wrapped_account_key, security_stamp, created_at, password_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(accountID, name, isOwner ? 1 : 0, kdfSalt, verifier, verifierSalt, wrapped, token(16), at, at);
  return ctx.user(accountID) as UserRow;
}

function consumeRecoveryCode(ctx: Context, user: UserRow, code: string): boolean {
  const stored = user.recovery_codes ? (JSON.parse(user.recovery_codes) as string[]) : [];
  const digest = ctx.keys.hmac("recovery", normalizeRecoveryCode(code)).toString("hex");
  const index = stored.findIndex((candidate) => safeEqualText(candidate, digest));
  if (index < 0) return false;
  stored.splice(index, 1);
  ctx.db.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?").run(JSON.stringify(stored), user.id);
  return true;
}

function checkSecondFactor(ctx: Context, user: UserRow, fields: Record<string, unknown>, request: FastifyRequest): void {
  if (!user.totp_secret) return;
  const code = fields.totp;
  const recovery = fields.recoveryCode;
  if (typeof code === "string") {
    const secret = ctx.keys.open(user.totp_secret, `totp|${user.id}`);
    const step = verifyTOTP(secret, code, Date.now(), user.totp_last_step);
    if (step === null) throw new ApiError(401, "invalidSecondFactor");
    ctx.db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ?").run(step, user.id);
    return;
  }
  if (typeof recovery === "string") {
    if (!consumeRecoveryCode(ctx, user, recovery)) throw new ApiError(401, "invalidSecondFactor");
    ctx.audit("recovery_code.used", user.id, request);
    return;
  }
  throw new ApiError(401, "secondFactorRequired");
}

export function registerAuthRoutes(app: FastifyInstance, ctx: Context): void {
  app.get("/api/v1/status", async () => ({
    service: "quancard-server",
    version: ctx.config.version,
    setupRequired: userCount(ctx) === 0,
    setupEnabled: ctx.config.setupToken !== null,
    protocol: { auth: 1, sync: 1, envelope: 1 },
  }));

  app.post("/api/v1/setup", async (request, reply) => {
    ctx.authLimiter.check(`setup:${ctx.clientTag(request)}`);
    const fields = body(request.body, ["setupToken", ...REGISTRATION_FIELDS]);
    const expected = ctx.config.setupToken;
    if (!expected || userCount(ctx) > 0) throw new ApiError(403, "setupClosed");
    if (!safeEqualText(textField(fields.setupToken, 256), expected)) throw new ApiError(403, "invalidSetupToken");
    const user = await createUser(ctx, fields, true);
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
    const code = textField(fields.inviteCode, 64);
    const user = await (async () => {
      const invite = ctx.db.prepare("SELECT expires_at, used_at FROM invites WHERE code_hash = ?").get(sha256(code)) as
        | { expires_at: number; used_at: number | null }
        | undefined;
      if (!invite || invite.used_at !== null || invite.expires_at <= now()) throw new ApiError(403, "invalidInvite");
      const created = await createUser(ctx, fields, false);
      const claimed = ctx.db.prepare("UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(now(), sha256(code));
      if (claimed.changes !== 1) {
        ctx.db.prepare("DELETE FROM users WHERE id = ?").run(created.id);
        throw new ApiError(403, "invalidInvite");
      }
      return created;
    })();
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
    const user = ctx.userByName(name);
    if (!user) {
      // Spend the same work as a real check to blunt timing-based enumeration.
      await hashAuthKey(authKey, ctx.keys.decoySalt(name));
      throw new ApiError(401, "invalidCredentials");
    }
    const at = now();
    if (user.locked_until > at) {
      ctx.audit("login.locked", user.id, request);
      throw new ApiError(429, "accountLocked", { retryAfterSeconds: user.locked_until - at });
    }
    if (!(await ctx.verifyAuthKey(user, authKey))) {
      const failures = user.failed_logins + 1;
      const lockedUntil = failures >= LOCK_AFTER_FAILURES ? at + LOCK_SECONDS : 0;
      ctx.db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(lockedUntil ? 0 : failures, lockedUntil, user.id);
      ctx.audit("login.failure", user.id, request);
      throw new ApiError(401, "invalidCredentials");
    }
    checkSecondFactor(ctx, user, fields, request);
    ctx.db.prepare("UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?").run(user.id);
    ctx.audit("login.success", user.id, request);
    ctx.issueSession(reply, request, user);
    return accountView(ctx, ctx.user(user.id) as UserRow);
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
    const { user } = ctx.requireSession(request);
    const fields = body(request.body, ["currentAuthKey", "kdfSalt", "authKey", "wrappedAccountKey"]);
    await ctx.requireFreshAuth(user, bytesField(fields.currentAuthKey, 32));
    const kdfSalt = bytesField(fields.kdfSalt, ACCOUNT_KDF.saltBytes);
    const authKey = bytesField(fields.authKey, 32);
    const wrapped = bytesField(fields.wrappedAccountKey, undefined, 4096);
    checkWrappedAccountKey(wrapped, user.id);
    const verifierSalt = Buffer.from(token(16), "base64url");
    const verifier = await hashAuthKey(authKey, verifierSalt);
    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          "UPDATE users SET kdf_salt = ?, verifier = ?, verifier_salt = ?, wrapped_account_key = ?, security_stamp = ?, password_changed_at = ? WHERE id = ?",
        )
        .run(kdfSalt, verifier, verifierSalt, wrapped, token(16), now(), user.id);
      ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    });
    ctx.audit("password.changed", user.id, request);
    // Every other browser session is signed out; this one gets a fresh session.
    ctx.issueSession(reply, request, ctx.user(user.id) as UserRow);
    return accountView(ctx, ctx.user(user.id) as UserRow);
  });

  app.post("/api/v1/account/totp/setup", async (request) => {
    const { user } = ctx.requireSession(request);
    const fields = body(request.body, ["authKey"]);
    await ctx.requireFreshAuth(user, bytesField(fields.authKey, 32));
    if (user.totp_secret) throw new ApiError(409, "totpAlreadyEnabled");
    const secret = newTOTPSecret();
    ctx.db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").run(ctx.keys.seal(secret, `totp-pending|${user.id}`), user.id);
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
    ctx.db
      .prepare("UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_last_step = ?, recovery_codes = ? WHERE id = ?")
      .run(ctx.keys.seal(secret, `totp|${user.id}`), step, JSON.stringify(hashes), user.id);
    ctx.audit("totp.enabled", user.id, request);
    return { recoveryCodes: codes };
  });

  app.post("/api/v1/account/totp/disable", async (request) => {
    const { user } = ctx.requireSession(request);
    const fields = body(request.body, ["authKey", "totp", "recoveryCode"]);
    await ctx.requireFreshAuth(user, bytesField(fields.authKey, 32));
    checkSecondFactor(ctx, user, fields, request);
    ctx.db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = -1, recovery_codes = NULL WHERE id = ?").run(user.id);
    ctx.audit("totp.disabled", user.id, request);
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
    const { user } = ctx.requireSession(request);
    const fields = body(request.body, ["authKey", "confirm"]);
    await ctx.requireFreshAuth(user, bytesField(fields.authKey, 32));
    if (optionalText(fields.confirm, 64) !== user.username) throw new ApiError(400, "confirmationMismatch");
    if (user.is_owner === 1 && userCount(ctx) > 1) throw new ApiError(409, "ownerHasMembers");
    transaction(ctx.db, () => {
      ctx.db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
      ctx.db.prepare("DELETE FROM audit_events WHERE user_id = ?").run(user.id);
    });
    ctx.clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
