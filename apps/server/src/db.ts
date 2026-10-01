import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Embedded, numbered migrations. The server refuses to start against a
 * database written by a newer version rather than silently corrupting it.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    is_owner INTEGER NOT NULL DEFAULT 0,
    kdf_salt BLOB NOT NULL,
    verifier BLOB NOT NULL,
    verifier_salt BLOB NOT NULL,
    wrapped_account_key BLOB NOT NULL,
    totp_secret BLOB,
    totp_pending BLOB,
    totp_last_step INTEGER NOT NULL DEFAULT -1,
    recovery_codes TEXT,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    security_stamp TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    password_changed_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    security_stamp TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    client_hint TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE invites (
    code_hash BLOB PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE vaults (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manifest BLOB NOT NULL,
    wrapped_key BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    revision_count INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    last_seq INTEGER NOT NULL DEFAULT 0,
    modified_at INTEGER NOT NULL
  );
  CREATE INDEX vaults_user ON vaults(user_id);
  CREATE TABLE revisions (
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    body BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, id)
  );
  CREATE UNIQUE INDEX revisions_seq ON revisions(vault_id, seq);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash BLOB NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE TABLE pairings (
    code_hash BLOB PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_at INTEGER
  );
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id TEXT,
    event TEXT NOT NULL,
    ip_tag TEXT
  );
  CREATE INDEX audit_user ON audit_events(user_id, id);
  CREATE UNIQUE INDEX users_single_owner ON users(is_owner) WHERE is_owner = 1;
  CREATE TABLE server_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
    WHEN (SELECT COUNT(*) FROM users WHERE id = OLD.user_id) > 0
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  `,
];

export class DowngradeError extends Error {
  constructor(found: number, supported: number) {
    super(`downgrade refused: database schema ${found} is newer than supported ${supported}`);
  }
}

export type Database = DatabaseSync;

export function openDatabase(dataDir: string, filename = "quancard.sqlite"): Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, filename));
  configure(db);
  return db;
}

export function openMemoryDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  configure(db);
  return db;
}

function configure(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA secure_delete = ON");
  migrate(db);
}

export function migrate(db: Database, migrations: readonly string[] = MIGRATIONS): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  const current = row?.version ?? 0;
  if (current > migrations.length) throw new DowngradeError(current, migrations.length);
  for (let v = current; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v] as string);
      if (v === 0 && !row) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(v + 1);
      else db.prepare("UPDATE schema_version SET version = ?").run(v + 1);
    });
  }
}

export function transaction<T>(db: Database, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
