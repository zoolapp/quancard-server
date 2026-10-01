import { bytesEqual, type EncryptedEnvelope, MANIFEST_KIND, parseEnvelope, REVISION_KIND, SYNC_LIMITS, VAULT_KEY_KIND } from "@quancard/protocol";
import type { FastifyInstance } from "fastify";
import type { Context } from "../context.js";
import { now, transaction } from "../db.js";
import { ApiError } from "../http-guard.js";
import { sha256, token } from "../security.js";
import { body, bytesField, optionalText, uuidField } from "../validate.js";

/**
 * Data plane. The server is a dumb, append-only store of opaque sync-v1
 * envelopes: it validates only the outer JSON shape, identity binding and
 * quotas. It never holds a key and cannot read, merge or rewrite revisions.
 */

const PAGE_RECORDS = 500;
const PAGE_BYTES = 24 * 1024 * 1024;
const PAIRING_SECONDS = 10 * 60;

interface VaultRow {
  id: string;
  user_id: string;
  manifest: Uint8Array;
  wrapped_key: Uint8Array;
  created_at: number;
  revision_count: number;
  total_bytes: number;
  last_seq: number;
  modified_at: number;
}

function envelopeOf(bytes: Uint8Array, kind: string, recordID: string, maximumBytes: number): EncryptedEnvelope {
  let envelope: EncryptedEnvelope;
  try {
    envelope = parseEnvelope(bytes, { maximumBytes });
  } catch {
    throw new ApiError(400, "invalidEnvelope");
  }
  if (envelope.objectKind !== kind || envelope.recordID !== recordID) throw new ApiError(400, "invalidEnvelope");
  return envelope;
}

function vaultView(ctx: Context, row: VaultRow) {
  return {
    vaultID: row.id,
    wrappedKey: Buffer.from(row.wrapped_key).toString("base64"),
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    revisionCount: row.revision_count,
    totalBytes: row.total_bytes,
    lastSeq: row.last_seq,
    quota: { revisionCount: ctx.config.quota.revisionCount, totalBytes: ctx.config.quota.totalBytes },
  };
}

export function registerVaultRoutes(app: FastifyInstance, ctx: Context): void {
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: SYNC_LIMITS.revisionBytes }, (_request, payload, done) =>
    done(null, payload),
  );

  app.get("/api/v1/vaults", async (request) => {
    const { user } = ctx.requireSession(request);
    const rows = ctx.db.prepare("SELECT * FROM vaults WHERE user_id = ? ORDER BY created_at").all(user.id) as unknown as VaultRow[];
    return { vaults: rows.map((row) => vaultView(ctx, row)) };
  });

  app.post("/api/v1/vaults", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const { user } = ctx.requireSession(request);
    const fields = body(request.body, ["vaultID", "manifest", "wrappedKey"]);
    const vaultID = uuidField(fields.vaultID);
    const manifest = bytesField(fields.manifest, undefined, 8192);
    const wrappedKey = bytesField(fields.wrappedKey, undefined, 4096);
    envelopeOf(manifest, MANIFEST_KIND, vaultID, 8192);
    envelopeOf(wrappedKey, VAULT_KEY_KIND, vaultID, 4096);
    const count = (ctx.db.prepare("SELECT COUNT(*) AS n FROM vaults WHERE user_id = ?").get(user.id) as { n: number }).n;
    if (count >= ctx.config.quota.vaultsPerAccount) throw new ApiError(507, "capacity");
    const existing = ctx.db.prepare("SELECT user_id, manifest, wrapped_key FROM vaults WHERE id = ?").get(vaultID) as
      | { user_id: string; manifest: Uint8Array; wrapped_key: Uint8Array }
      | undefined;
    if (existing) {
      // Idempotent retry of the same creation succeeds; anything else is a conflict.
      if (existing.user_id === user.id && bytesEqual(existing.manifest, manifest) && bytesEqual(existing.wrapped_key, wrappedKey)) {
        return reply.code(200).send(vaultView(ctx, ctx.db.prepare("SELECT * FROM vaults WHERE id = ?").get(vaultID) as unknown as VaultRow));
      }
      throw new ApiError(409, "vaultExists");
    }
    const at = now();
    ctx.db
      .prepare("INSERT INTO vaults (id, user_id, manifest, wrapped_key, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(vaultID, user.id, manifest, wrappedKey, at, at);
    ctx.audit("vault.created", user.id, request);
    return reply.code(201).send(vaultView(ctx, ctx.db.prepare("SELECT * FROM vaults WHERE id = ?").get(vaultID) as unknown as VaultRow));
  });

  app.delete<{ Params: { vaultID: string } }>("/api/v1/vaults/:vaultID", async (request, reply) => {
    const principal = ctx.requireSession(request);
    const vaultID = uuidField(request.params.vaultID);
    ctx.requireVaultAccess(request, vaultID);
    const fields = body(request.body, ["authKey"]);
    const user = await ctx.requireFreshAuth(principal, bytesField(fields.authKey, 32));
    ctx.requireVaultAccess(request, vaultID);
    ctx.db.prepare("DELETE FROM vaults WHERE id = ?").run(vaultID);
    ctx.audit("vault.deleted", user.id, request);
    return reply.code(204).send();
  });

  app.get<{ Params: { vaultID: string } }>("/api/v1/vaults/:vaultID/manifest", async (request, reply) => {
    const vaultID = uuidField(request.params.vaultID);
    ctx.requireVaultAccess(request, vaultID);
    const row = ctx.db.prepare("SELECT manifest FROM vaults WHERE id = ?").get(vaultID) as { manifest: Uint8Array };
    return reply.type("application/octet-stream").send(Buffer.from(row.manifest));
  });

  app.get<{ Params: { vaultID: string }; Querystring: { after?: string; limit?: string } }>("/api/v1/vaults/:vaultID/revisions", async (request) => {
    const vaultID = uuidField(request.params.vaultID);
    ctx.requireVaultAccess(request, vaultID);
    const after = Number(request.query.after ?? 0);
    const limit = Math.min(Number(request.query.limit ?? PAGE_RECORDS), PAGE_RECORDS);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new ApiError(400, "badRequest");
    const rows = ctx.db
      .prepare("SELECT id, seq, body, created_at FROM revisions WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(vaultID, after, limit) as { id: string; seq: number; body: Uint8Array; created_at: number }[];
    const page = [];
    let bytes = 0;
    for (const row of rows) {
      if (page.length > 0 && bytes + row.body.length > PAGE_BYTES) break;
      bytes += row.body.length;
      page.push({ revisionID: row.id, seq: row.seq, createdAt: row.created_at, body: Buffer.from(row.body).toString("base64") });
    }
    const vault = ctx.db.prepare("SELECT last_seq, modified_at FROM vaults WHERE id = ?").get(vaultID) as { last_seq: number; modified_at: number };
    const last = page.at(-1)?.seq ?? after;
    return { revisions: page, nextAfter: last, hasMore: last < vault.last_seq, lastSeq: vault.last_seq, modifiedAt: vault.modified_at };
  });

  app.put<{ Params: { vaultID: string; revisionID: string } }>(
    "/api/v1/vaults/:vaultID/revisions/:revisionID",
    { bodyLimit: SYNC_LIMITS.revisionBytes },
    async (request, reply) => {
      const vaultID = uuidField(request.params.vaultID);
      const revisionID = uuidField(request.params.revisionID);
      ctx.requireVaultAccess(request, vaultID);
      if (!Buffer.isBuffer(request.body)) throw new ApiError(415, "unsupportedMediaType");
      const bytes = new Uint8Array(request.body);
      envelopeOf(bytes, REVISION_KIND, revisionID, SYNC_LIMITS.revisionBytes);
      const result = transaction(ctx.db, () => {
        const existing = ctx.db.prepare("SELECT seq, body FROM revisions WHERE vault_id = ? AND id = ?").get(vaultID, revisionID) as
          | { seq: number; body: Uint8Array }
          | undefined;
        if (existing) {
          // Revisions are immutable: an identical retry is acknowledged, a different body is refused.
          if (!bytesEqual(existing.body, bytes)) throw new ApiError(409, "revisionConflict");
          return { status: 200, seq: existing.seq };
        }
        const vault = ctx.db.prepare("SELECT revision_count, total_bytes, last_seq FROM vaults WHERE id = ?").get(vaultID) as {
          revision_count: number;
          total_bytes: number;
          last_seq: number;
        };
        if (vault.revision_count + 1 > ctx.config.quota.revisionCount || vault.total_bytes + bytes.length > ctx.config.quota.totalBytes) {
          throw new ApiError(507, "capacity");
        }
        const seq = vault.last_seq + 1;
        const at = now();
        ctx.db.prepare("INSERT INTO revisions (vault_id, id, seq, body, created_at) VALUES (?, ?, ?, ?, ?)").run(vaultID, revisionID, seq, bytes, at);
        ctx.db
          .prepare("UPDATE vaults SET revision_count = revision_count + 1, total_bytes = total_bytes + ?, last_seq = ?, modified_at = ? WHERE id = ?")
          .run(bytes.length, seq, at, vaultID);
        return { status: 201, seq };
      });
      return reply.code(result.status).send({ revisionID, seq: result.seq });
    },
  );

  // Pairing: a signed-in browser mints a short-lived, single-use code. The
  // browser (never the server) puts the vault key next to it in a QR code.
  app.post<{ Params: { vaultID: string } }>("/api/v1/vaults/:vaultID/pairings", async (request, reply) => {
    const principal = ctx.requireSession(request);
    const vaultID = uuidField(request.params.vaultID);
    ctx.requireVaultAccess(request, vaultID);
    const fields = body(request.body, ["authKey"]);
    const user = await ctx.requireFreshAuth(principal, bytesField(fields.authKey, 32));
    // Re-check after the await: the vault may have been deleted meanwhile.
    ctx.requireVaultAccess(request, vaultID);
    const code = token(24);
    const at = now();
    ctx.db.prepare("DELETE FROM pairings WHERE expires_at <= ? OR claimed_at IS NOT NULL").run(at);
    ctx.db
      .prepare("INSERT INTO pairings (code_hash, user_id, vault_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(code), user.id, vaultID, at, at + PAIRING_SECONDS);
    ctx.audit("pairing.created", user.id, request);
    return reply.code(201).send({ code, expiresAt: at + PAIRING_SECONDS });
  });

  app.post("/api/v1/pairings/claim", async (request, reply) => {
    ctx.authLimiter.check(`claim:${ctx.clientTag(request)}`);
    const fields = body(request.body, ["code", "deviceName"]);
    const code = typeof fields.code === "string" && /^[A-Za-z0-9_-]{32}$/.test(fields.code) ? fields.code : null;
    if (!code) throw new ApiError(410, "pairingInvalid");
    const name = optionalText(fields.deviceName, 64) ?? "iPhone";
    const device = ctx.issueDeviceToken();
    const claimed = transaction(ctx.db, () => {
      const at = now();
      const pairing = ctx.db.prepare("SELECT user_id, vault_id, expires_at, claimed_at FROM pairings WHERE code_hash = ?").get(sha256(code)) as
        | { user_id: string; vault_id: string; expires_at: number; claimed_at: number | null }
        | undefined;
      if (!pairing || pairing.claimed_at !== null || pairing.expires_at <= at) throw new ApiError(410, "pairingInvalid");
      ctx.db.prepare("UPDATE pairings SET claimed_at = ? WHERE code_hash = ?").run(at, sha256(code));
      const deviceID = crypto.randomUUID().toUpperCase();
      ctx.db
        .prepare("INSERT INTO devices (id, user_id, vault_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(deviceID, pairing.user_id, pairing.vault_id, name, device.hash, at);
      return { deviceID, vaultID: pairing.vault_id, userID: pairing.user_id };
    });
    ctx.audit("pairing.claimed", claimed.userID, request);
    return reply.code(201).send({ deviceID: claimed.deviceID, vaultID: claimed.vaultID, deviceToken: device.value });
  });

  app.get("/api/v1/devices", async (request) => {
    const { user } = ctx.requireSession(request);
    const rows = ctx.db.prepare("SELECT id, vault_id, name, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY created_at").all(user.id) as {
      id: string;
      vault_id: string;
      name: string;
      created_at: number;
      last_seen_at: number | null;
    }[];
    return { devices: rows.map((r) => ({ deviceID: r.id, vaultID: r.vault_id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at })) };
  });

  app.delete<{ Params: { deviceID: string } }>("/api/v1/devices/:deviceID", async (request, reply) => {
    const { user } = ctx.requireSession(request);
    const deviceID = uuidField(request.params.deviceID);
    const result = ctx.db.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").run(deviceID, user.id);
    if (result.changes !== 1) throw new ApiError(404, "notFound");
    ctx.audit("device.revoked", user.id, request);
    return reply.code(204).send();
  });
}
