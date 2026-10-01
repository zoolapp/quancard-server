import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./db.js";

/**
 * Maintenance commands, run inside the container:
 *   node dist/cli.js backup <destination.sqlite>   consistent online snapshot (VACUUM INTO)
 *   node dist/cli.js check <file.sqlite>           integrity + schema version check
 * Backups contain only ciphertext, password verifiers and server-encrypted
 * TOTP secrets; restoring TOTP also requires the original QC_SECRET.
 */

function fail(message: string): never {
  console.error(`quancard-server: ${message}`);
  process.exit(1);
}

function check(path: string): void {
  if (!existsSync(path)) fail(`no such file: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (integrity.integrity_check !== "ok") fail("integrity check failed");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (!row) fail("not a QuanCard database");
  if (row.version > MIGRATIONS.length) fail(`schema ${row.version} is newer than this server (${MIGRATIONS.length})`);
  const counts = db
    .prepare("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM vaults) AS vaults, (SELECT COUNT(*) FROM revisions) AS revisions")
    .get();
  db.close();
  console.log(JSON.stringify({ ok: true, schema: row.version, ...counts }));
}

const [command, target] = process.argv.slice(2);
const dataDir = resolve(process.env.QC_DATA_DIR ?? "./data");
const live = resolve(dataDir, "quancard.sqlite");

switch (command) {
  case "backup": {
    if (!target) fail("usage: backup <destination.sqlite>");
    const destination = resolve(target);
    if (existsSync(destination)) fail("destination already exists");
    const db = new DatabaseSync(live);
    db.prepare("VACUUM INTO ?").run(destination);
    db.close();
    check(destination);
    break;
  }
  case "check":
    check(resolve(target ?? live));
    break;
  default:
    fail("usage: cli.js backup <destination.sqlite> | check [file.sqlite]");
}
