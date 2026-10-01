import {
  base64,
  encodePayload,
  importAESKey,
  openRevision,
  ProtocolError,
  RevisionGraph,
  type RevisionNode,
  randomUUID,
  type SyncKeyMaterial,
  sealManifest,
  sealRevision,
  type VaultArtwork,
  type VaultItem,
  verifyManifest,
  wrapVaultKey,
} from "@quancard/protocol";
import { api, type VaultView } from "./api.js";

/**
 * Client-side vault: downloads opaque revisions, decrypts and verifies them in
 * memory, and writes new immutable revisions. The server never sees keys or
 * plaintext; device time never decides a conflict.
 */

export interface ItemVersion {
  node: RevisionNode;
  item: VaultItem | null;
  artwork: VaultArtwork | null;
}

export interface ProjectedItem {
  itemID: string;
  /** Current item; for conflicts, the first head with content. */
  item: VaultItem;
  artwork: VaultArtwork | null;
  versions: ItemVersion[];
  conflict: boolean;
}

/** Thrown when work finishes after the vault was locked; its results are discarded. */
export class VaultClosedError extends Error {}

export class VaultStore {
  readonly graph: RevisionGraph;
  lastSeq = 0;
  view: VaultView;
  private key: CryptoKey | null = null;
  private closed = false;
  /** Records that failed verification; the fetch cursor never moves past them. */
  private readonly failed = new Set<string>();
  /**
   * A fresh random installation per open vault (per tab, per unlock). Two tabs
   * therefore never share a clock, and the counter is reserved synchronously,
   * so concurrent saves can never produce a duplicate (installation, counter).
   */
  private readonly installationID = randomUUID();
  private lastCounter = 0;
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(
    view: VaultView,
    private material: SyncKeyMaterial | null,
  ) {
    this.view = view;
    this.graph = new RevisionGraph(view.vaultID);
  }

  static async open(view: VaultView, material: SyncKeyMaterial): Promise<VaultStore> {
    const store = new VaultStore(view, material);
    store.key = await importAESKey(material.key);
    await verifyManifest(await api.manifest(view.vaultID), view.vaultID, store.key);
    await store.refresh();
    return store;
  }

  /** Creates a vault with a fresh random sync key (or an imported one) and uploads only ciphertext. */
  static async create(accountKey: CryptoKey, material: SyncKeyMaterial): Promise<VaultView> {
    const key = await importAESKey(material.key);
    const manifest = await sealManifest(material, key);
    const wrapped = await wrapVaultKey(material, accountKey);
    return api.createVault(material.vaultID, manifest, wrapped);
  }

  get vaultID(): string {
    return this.view.vaultID;
  }

  /** The sync key leaves memory only into the pairing QR code, on explicit user action. */
  syncMaterial(): SyncKeyMaterial {
    if (!this.material) throw new ProtocolError("invalidData");
    return this.material;
  }

  get unreadable(): number {
    return this.failed.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.material?.key.fill(0);
    this.material = null;
    this.key = null;
    this.graph.nodes.clear();
  }

  private ensureOpen(): void {
    if (this.closed) throw new VaultClosedError();
  }

  async refresh(): Promise<void> {
    const key = this.requireKey();
    const incoming: RevisionNode[] = [];
    let after = this.lastSeq;
    let firstFailedSeq: number | null = null;
    // Bounded: at most 10 pages per refresh; the server never holds more than 2,000 revisions.
    for (let page = 0; page < 10; page++) {
      const result = await api.revisions(this.vaultID, after);
      this.ensureOpen();
      for (const entry of result.revisions) {
        try {
          incoming.push(await openRevision(base64.decode(entry.body), entry.revisionID, this.vaultID, key));
          this.failed.delete(entry.revisionID);
        } catch {
          // A record we cannot authenticate is never shown or merged — and is retried next time.
          this.failed.add(entry.revisionID);
          firstFailedSeq ??= entry.seq;
        }
      }
      this.ensureOpen();
      after = result.nextAfter;
      if (!result.hasMore) break;
    }
    if (incoming.length) this.graph.add(incoming);
    this.lastSeq = firstFailedSeq !== null ? Math.min(after, firstFailedSeq - 1) : after;
    const vaults = await api.vaults();
    this.ensureOpen();
    this.view = vaults.vaults.find((v) => v.vaultID === this.vaultID) ?? this.view;
  }

  items(): ProjectedItem[] {
    const out: ProjectedItem[] = [];
    for (const state of this.graph.items()) {
      const versions = state.heads.map((node) => ({
        node,
        item: node.snapshot?.items[0] ?? null,
        artwork: node.snapshot?.artworks[0] ?? null,
      }));
      const live = versions.filter((v) => v.item !== null);
      const conflict = versions.length > 1;
      const first = live[0];
      // A single tombstone head means the item was deleted.
      if (!first) continue;
      out.push({ itemID: state.itemID, item: first.item as VaultItem, artwork: first.artwork, versions, conflict });
    }
    return out;
  }

  get pendingItems(): number {
    return this.graph.incompleteItems.size;
  }

  /** Writes a successor of the current head(s). `resolving` is set only by the conflict screen. */
  save(item: VaultItem | null, itemID: string, artwork: VaultArtwork | null, resolving = false): Promise<void> {
    // Writes are serialized per store so parents always reflect the previous write.
    const run = this.writes.then(() => this.write(item, itemID, artwork, resolving));
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async write(item: VaultItem | null, itemID: string, artwork: VaultArtwork | null, resolving: boolean): Promise<void> {
    const key = this.requireKey();
    const upper = itemID.toUpperCase();
    const parents = this.graph.parentsFor(upper, resolving);
    // Reserve the counter before the first await.
    const counter = Math.max(this.graph.maximumCounter, this.lastCounter) + 1;
    this.lastCounter = counter;
    const snapshot = item ? await encodePayload([item], artwork ? [artwork] : []) : null;
    const node = await sealRevision(
      { version: 1, vaultID: this.vaultID, revisionID: randomUUID(), itemID: upper, installationID: this.installationID, counter, parents, snapshot },
      key,
    );
    // Locked meanwhile: nothing is uploaded and nothing re-enters memory.
    this.ensureOpen();
    await api.putRevision(this.vaultID, node.revision.revisionID, node.ciphertext);
    this.ensureOpen();
    this.graph.add([node]);
  }

  /** "Keep all": every live branch becomes its own new item, and the original is closed with a merge tombstone. */
  async keepAll(project: ProjectedItem): Promise<void> {
    for (const version of project.versions) {
      if (!version.item) continue;
      const id = randomUUID().toLowerCase();
      const artwork = version.artwork ? { ...version.artwork, id: randomUUID().toLowerCase() } : null;
      const copy: VaultItem = { ...version.item, id, artworkBlobID: artwork?.id ?? null };
      await this.save(copy, id, artwork);
    }
    await this.save(null, project.itemID, null, true);
  }

  private requireKey(): CryptoKey {
    this.ensureOpen();
    if (!this.key) throw new VaultClosedError();
    return this.key;
  }
}
