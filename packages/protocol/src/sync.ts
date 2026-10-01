import { base64, base64url, bytesEqual, ProtocolError, parseUpperUUID, sha256, utf8 } from "./bytes.js";
import { type EncryptedEnvelope, importAESKey, openEnvelope, parseEnvelope, type SealRandomness, sealEnvelope, serializeEnvelope } from "./envelope.js";
import { decodePayloadStrict, type VaultPayload } from "./payload.js";
import { asArray, asInteger, asObject, canonicalJSON, parseStrictJSON } from "./strict-json.js";

/** QuanCard sync v1 (see iOS `docs/specs/sync-v1.md`). */

export const SYNC_LIMITS = {
  revisionBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  revisionCount: 2_000,
  maximumParents: 32,
  jsonDepth: 32,
} as const;

export const MANIFEST_KIND = "syncManifest.v1";
export const REVISION_KIND = "syncRevision.v1";

/** Random 256-bit sync root key plus vault identity. Never derived from a password. */
export interface SyncKeyMaterial {
  vaultID: string;
  key: Uint8Array;
}

export function recoveryCode(material: SyncKeyMaterial): string {
  return `QC1.${parseUpperUUID(material.vaultID)}.${base64url.encode(material.key)}`;
}

export function parseRecoveryCode(code: string): SyncKeyMaterial {
  if (utf8(code).length !== 84) throw new ProtocolError("invalidData");
  const parts = code.split(".");
  if (parts.length !== 3 || parts[0] !== "QC1") throw new ProtocolError("invalidData");
  return { vaultID: parseUpperUUID(parts[1]), key: base64url.decode(parts[2] as string, 32) };
}

export interface SyncParent {
  revisionID: string;
  /** Standard Base64 SHA-256 of the parent's exact envelope bytes. */
  digest: string;
}

export interface SyncRevision {
  version: 1;
  vaultID: string;
  revisionID: string;
  itemID: string;
  installationID: string;
  counter: number;
  parents: SyncParent[];
  /** Vault payload JSON bytes with exactly one item; null is a tombstone. */
  snapshot: Uint8Array | null;
}

export interface RevisionNode {
  revision: SyncRevision;
  /** Exact envelope bytes as stored on the server. */
  ciphertext: Uint8Array;
  digest: string;
  snapshot: VaultPayload | null;
}

export async function sealManifest(material: SyncKeyMaterial, key: CryptoKey, randomness?: SealRandomness): Promise<Uint8Array> {
  const plaintext = utf8(canonicalJSON({ version: 1, vaultID: material.vaultID }));
  return serializeEnvelope(await sealEnvelope(plaintext, material.vaultID, MANIFEST_KIND, key, randomness));
}

export async function verifyManifest(bytes: Uint8Array, vaultID: string, key: CryptoKey): Promise<void> {
  const plain = await openParsed(bytes, vaultID, MANIFEST_KIND, key);
  const object = asObject(parseStrictJSON(plain).value, ["version", "vaultID"]);
  if (object.vaultID !== vaultID) throw new ProtocolError("integrityFailure");
  if (asInteger(object.version) !== 1) throw new ProtocolError("unsupportedVersion");
}

async function openParsed(bytes: Uint8Array, recordID: string, kind: string, key: CryptoKey): Promise<Uint8Array> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = parseEnvelope(bytes, { maximumBytes: SYNC_LIMITS.revisionBytes });
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "capacityExceeded") throw error;
    throw new ProtocolError("invalidData");
  }
  return openEnvelope(envelope, key, { recordID, objectKind: kind });
}

export function encodeRevision(revision: SyncRevision): Uint8Array {
  return utf8(
    canonicalJSON({
      version: revision.version,
      vaultID: revision.vaultID,
      revisionID: revision.revisionID,
      itemID: revision.itemID,
      installationID: revision.installationID,
      counter: revision.counter,
      parents: revision.parents.map((p) => ({ revisionID: p.revisionID, digest: p.digest })),
      snapshot: revision.snapshot === null ? null : base64.encode(revision.snapshot),
    }),
  );
}

export async function sealRevision(revision: SyncRevision, key: CryptoKey, randomness?: SealRandomness): Promise<RevisionNode> {
  const plaintext = encodeRevision(revision);
  const decoded = await decodeRevision(plaintext, revision.revisionID, revision.vaultID);
  const bytes = serializeEnvelope(await sealEnvelope(plaintext, revision.revisionID, REVISION_KIND, key, randomness));
  if (bytes.length > SYNC_LIMITS.revisionBytes) throw new ProtocolError("capacityExceeded");
  return { revision: decoded.revision, ciphertext: bytes, digest: base64.encode(await sha256(bytes)), snapshot: decoded.snapshot };
}

export async function openRevision(bytes: Uint8Array, expectedID: string, vaultID: string, key: CryptoKey): Promise<RevisionNode> {
  const plaintext = await openParsed(bytes, expectedID, REVISION_KIND, key);
  const decoded = await decodeRevision(plaintext, expectedID, vaultID);
  return { ...decoded, ciphertext: bytes, digest: base64.encode(await sha256(bytes)) };
}

async function decodeRevision(bytes: Uint8Array, expectedID: string, vaultID: string) {
  const object = asObject(parseStrictJSON(bytes, { maximumDepth: SYNC_LIMITS.jsonDepth }).value, [
    "version",
    "vaultID",
    "revisionID",
    "itemID",
    "installationID",
    "counter",
    "parents",
    "snapshot",
  ]);
  if (asInteger(object.version) !== 1) throw new ProtocolError("unsupportedVersion");
  const revision: SyncRevision = {
    version: 1,
    vaultID: parseUpperUUID(object.vaultID),
    revisionID: parseUpperUUID(object.revisionID),
    itemID: parseUpperUUID(object.itemID, false),
    installationID: parseUpperUUID(object.installationID),
    counter: asInteger(object.counter),
    parents: [],
    snapshot: null,
  };
  const rawParents = asArray(object.parents);
  if (rawParents.length > SYNC_LIMITS.maximumParents) throw new ProtocolError("capacityExceeded");
  for (const raw of rawParents) {
    const parent = asObject(raw, ["revisionID", "digest"]);
    const digest = parent.digest;
    if (typeof digest !== "string") throw new ProtocolError("invalidData");
    base64.decode(digest, 32);
    revision.parents.push({ revisionID: parseUpperUUID(parent.revisionID), digest });
  }
  if (object.snapshot !== null) {
    if (typeof object.snapshot !== "string") throw new ProtocolError("invalidData");
    revision.snapshot = base64.decode(object.snapshot);
  }
  const parentIDs = revision.parents.map((p) => p.revisionID);
  if (
    revision.vaultID !== vaultID ||
    revision.revisionID !== expectedID ||
    revision.counter <= 0 ||
    revision.revisionID === vaultID ||
    new Set(parentIDs).size !== parentIDs.length ||
    parentIDs.some((id) => id === revision.revisionID || id === vaultID) ||
    parentIDs.join("\n") !== [...parentIDs].sort().join("\n")
  ) {
    throw new ProtocolError("integrityFailure");
  }
  let snapshot: VaultPayload | null = null;
  if (revision.snapshot !== null) {
    snapshot = await decodePayloadStrict(revision.snapshot);
    const item = snapshot.items[0];
    if (snapshot.items.length !== 1 || snapshot.artworks.length > 1 || item?.id.toUpperCase() !== revision.itemID) {
      throw new ProtocolError("invalidData");
    }
  }
  return { revision, snapshot };
}

export interface ItemState {
  itemID: string;
  /** Heads sorted by revision ID; more than one is an unresolved conflict. */
  heads: RevisionNode[];
}

/**
 * Immutable revision DAG. Device time never elects a winner: an item with
 * several heads stays in conflict until a user writes a merging revision.
 */
export class RevisionGraph {
  readonly nodes = new Map<string, RevisionNode>();
  readonly incompleteItems = new Set<string>();

  constructor(readonly vaultID: string) {}

  get maximumCounter(): number {
    let max = 0;
    for (const node of this.nodes.values()) max = Math.max(max, node.revision.counter);
    return max;
  }

  get totalBytes(): number {
    let total = 0;
    for (const node of this.nodes.values()) total += node.ciphertext.length;
    return total;
  }

  add(incoming: RevisionNode[]): void {
    const next = new Map(this.nodes);
    for (const node of incoming) {
      if (node.revision.vaultID !== this.vaultID) throw new ProtocolError("integrityFailure");
      const previous = next.get(node.revision.revisionID);
      if (previous) {
        if (!bytesEqual(previous.ciphertext, node.ciphertext)) throw new ProtocolError("integrityFailure");
      } else {
        next.set(node.revision.revisionID, node);
      }
    }
    let bytes = 0;
    for (const node of next.values()) bytes += node.ciphertext.length;
    if (next.size > SYNC_LIMITS.revisionCount || bytes > SYNC_LIMITS.totalBytes) throw new ProtocolError("capacityExceeded");

    const clocks = new Set<string>();
    const complete = new Set<string>();
    const incomplete = new Set<string>();
    const ordered = [...next.values()].sort((a, b) => a.revision.counter - b.revision.counter);
    for (const node of ordered) {
      const r = node.revision;
      const clock = `${r.installationID}#${r.counter}`;
      if (clocks.has(clock)) throw new ProtocolError("integrityFailure");
      clocks.add(clock);
      let ready = true;
      for (const edge of r.parents) {
        const parent = next.get(edge.revisionID);
        if (!parent) {
          ready = false;
          continue;
        }
        if (parent.revision.itemID !== r.itemID || parent.digest !== edge.digest || parent.revision.counter >= r.counter) {
          throw new ProtocolError("integrityFailure");
        }
        if (!complete.has(parent.revision.revisionID)) ready = false;
      }
      if (ready) complete.add(r.revisionID);
      else incomplete.add(r.itemID);
    }
    this.nodes.clear();
    for (const [id, node] of next) this.nodes.set(id, node);
    this.incompleteItems.clear();
    for (const id of incomplete) this.incompleteItems.add(id);
  }

  heads(itemID: string): RevisionNode[] {
    const candidates = [...this.nodes.values()].filter((n) => n.revision.itemID === itemID);
    const referenced = new Set(candidates.flatMap((n) => n.revision.parents.map((p) => p.revisionID)));
    return candidates.filter((n) => !referenced.has(n.revision.revisionID)).sort((a, b) => (a.revision.revisionID < b.revision.revisionID ? -1 : 1));
  }

  items(): ItemState[] {
    const ids = new Set([...this.nodes.values()].map((n) => n.revision.itemID));
    return [...ids].filter((id) => !this.incompleteItems.has(id)).map((itemID) => ({ itemID, heads: this.heads(itemID) }));
  }

  /** Parents for a new local revision; refuses to silently resolve a conflict. */
  parentsFor(itemID: string, resolvingConflict = false): SyncParent[] {
    if (this.incompleteItems.has(itemID)) throw new ProtocolError("missingParents");
    const heads = this.heads(itemID);
    if (heads.length > SYNC_LIMITS.maximumParents) throw new ProtocolError("capacityExceeded");
    if (!resolvingConflict && heads.length > 1) throw new ProtocolError("conflict");
    return heads.map((n) => ({ revisionID: n.revision.revisionID, digest: n.digest }));
  }
}

export async function importSyncKey(material: SyncKeyMaterial): Promise<CryptoKey> {
  return importAESKey(material.key);
}
