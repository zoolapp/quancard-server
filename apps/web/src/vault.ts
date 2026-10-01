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

const INSTALLATION_KEY = "quancard.installation.v1";
const COUNTER_KEY = "quancard.counter.v1";

/** Non-secret per-browser sync identity: a random installation UUID and a monotonic counter per vault. */
function localState(vaultID: string): { installationID: string; counter: number } {
  let installations: Record<string, string> = {};
  let counters: Record<string, number> = {};
  try {
    installations = JSON.parse(localStorage.getItem(INSTALLATION_KEY) ?? "{}");
    counters = JSON.parse(localStorage.getItem(COUNTER_KEY) ?? "{}");
  } catch {
    /* storage unavailable: fall back to a fresh identity for this tab */
  }
  let installationID = installations[vaultID];
  if (!installationID) {
    installationID = randomUUID();
    installations[vaultID] = installationID;
    try {
      localStorage.setItem(INSTALLATION_KEY, JSON.stringify(installations));
    } catch {
      /* ignore */
    }
  }
  return { installationID, counter: counters[vaultID] ?? 0 };
}

function storeCounter(vaultID: string, counter: number): void {
  try {
    const counters = JSON.parse(localStorage.getItem(COUNTER_KEY) ?? "{}") as Record<string, number>;
    counters[vaultID] = Math.max(counters[vaultID] ?? 0, counter);
    localStorage.setItem(COUNTER_KEY, JSON.stringify(counters));
  } catch {
    /* ignore */
  }
}

export class VaultStore {
  readonly graph: RevisionGraph;
  lastSeq = 0;
  unreadable = 0;
  view: VaultView;
  private key: CryptoKey | null = null;

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

  close(): void {
    this.material?.key.fill(0);
    this.material = null;
    this.key = null;
    this.graph.nodes.clear();
  }

  async refresh(): Promise<void> {
    const key = this.requireKey();
    const incoming: RevisionNode[] = [];
    let after = this.lastSeq;
    // Bounded: at most quota/page pages; the server never holds more than 2,000 revisions.
    for (let page = 0; page < 10; page++) {
      const result = await api.revisions(this.vaultID, after);
      for (const entry of result.revisions) {
        try {
          incoming.push(await openRevision(base64.decode(entry.body), entry.revisionID, this.vaultID, key));
        } catch {
          // A record we cannot authenticate is never shown or merged.
          this.unreadable++;
        }
      }
      after = result.nextAfter;
      if (!result.hasMore) break;
    }
    if (incoming.length) this.graph.add(incoming);
    this.lastSeq = after;
    const vaults = await api.vaults();
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
  async save(item: VaultItem | null, itemID: string, artwork: VaultArtwork | null, resolving = false): Promise<void> {
    const key = this.requireKey();
    const upper = itemID.toUpperCase();
    const parents = this.graph.nodes.size ? this.graph.parentsFor(upper, resolving) : [];
    const local = localState(this.vaultID);
    const counter = Math.max(this.graph.maximumCounter, local.counter) + 1;
    const snapshot = item ? await encodePayload([item], artwork ? [artwork] : []) : null;
    const node = await sealRevision(
      { version: 1, vaultID: this.vaultID, revisionID: randomUUID(), itemID: upper, installationID: local.installationID, counter, parents, snapshot },
      key,
    );
    storeCounter(this.vaultID, counter);
    await api.putRevision(this.vaultID, node.revision.revisionID, node.ciphertext);
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
    if (!this.key) throw new ProtocolError("invalidData");
    return this.key;
  }
}
