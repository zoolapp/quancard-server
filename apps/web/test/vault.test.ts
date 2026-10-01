import {
  base64,
  encodePayload,
  importAESKey,
  openRevision,
  RevisionGraph,
  randomBytes,
  randomUUID,
  sealManifest,
  sealRevision,
  type VaultItem,
} from "@quancard/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory fake of the server data plane, enough for VaultStore. */
const server = vi.hoisted(() => ({
  manifest: new Uint8Array() as Uint8Array,
  rows: [] as { revisionID: string; seq: number; createdAt: number; body: string }[],
  puts: 0,
}));

vi.mock("../src/api.js", () => ({
  api: {
    manifest: async () => server.manifest,
    vaults: async () => ({ vaults: [] }),
    revisions: async (_vault: string, after: number) => {
      const page = server.rows.filter((r) => r.seq > after);
      const last = server.rows.at(-1)?.seq ?? 0;
      return { revisions: page, nextAfter: page.at(-1)?.seq ?? after, hasMore: false, lastSeq: last, modifiedAt: 0 };
    },
    putRevision: async (_vault: string, revisionID: string, bytes: Uint8Array) => {
      server.puts++;
      const seq = server.rows.length + 1;
      server.rows.push({ revisionID, seq, createdAt: 0, body: base64.encode(bytes) });
      return { revisionID, seq };
    },
  },
}));

const { VaultStore, VaultClosedError } = await import("../src/vault.js");

function item(): VaultItem {
  return {
    itemSchemaVersion: 1,
    id: randomUUID().toLowerCase(),
    displayName: "TEST_ONLY",
    institutionName: null,
    country: null,
    tags: [],
    notes: null,
    artworkTemplateID: "graphite",
    artworkBlobID: null,
    lifecycle: "active",
    isFavorite: false,
    manualSortPosition: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    kind: "paymentCard",
    paymentCard: {
      cardholderName: null,
      pan: null,
      expiryMonth: null,
      expiryYear: null,
      network: "visa",
      fundingType: "credit",
      formFactor: "physical",
      walletProvisions: [],
    },
    bankAccount: null,
  };
}

let vaultID: string;
let keyBytes: Uint8Array;
const view = () => ({
  vaultID,
  wrappedKey: "",
  createdAt: 0,
  modifiedAt: 0,
  revisionCount: 0,
  totalBytes: 0,
  lastSeq: 0,
  quota: { revisionCount: 2000, totalBytes: 1 << 26 },
});

beforeEach(async () => {
  vaultID = randomUUID();
  keyBytes = randomBytes(32);
  server.rows = [];
  server.puts = 0;
  server.manifest = await sealManifest({ vaultID, key: keyBytes }, await importAESKey(keyBytes));
});

async function reload() {
  const graph = new RevisionGraph(vaultID);
  const key = await importAESKey(keyBytes);
  graph.add(await Promise.all(server.rows.map((r) => openRevision(base64.decode(r.body), r.revisionID, vaultID, key))));
  return graph;
}

describe("VaultStore", () => {
  it("F5: concurrent saves in one tab and across two tabs never reuse a sync clock", async () => {
    const tabA = await VaultStore.open(view(), { vaultID, key: new Uint8Array(keyBytes) });
    const tabB = await VaultStore.open(view(), { vaultID, key: new Uint8Array(keyBytes) });
    const items = Array.from({ length: 6 }, item);
    await Promise.all(items.map((it, i) => (i % 2 ? tabA : tabB).save(it, it.id, null)));
    const graph = await reload(); // throws integrityFailure on a duplicate (installation, counter)
    expect(graph.nodes.size).toBe(6);
  });

  it("F4: a save that finishes after lock uploads nothing and does not repopulate memory", async () => {
    const store = await VaultStore.open(view(), { vaultID, key: new Uint8Array(keyBytes) });
    const it1 = item();
    const pending = store.save(it1, it1.id, null);
    store.close();
    await expect(pending).rejects.toBeInstanceOf(VaultClosedError);
    expect(server.puts).toBe(0);
    expect(store.graph.nodes.size).toBe(0);
  });

  it("F11: an unreadable record does not advance the cursor and is retried", async () => {
    const key = await importAESKey(keyBytes);
    const good = item();
    const node = await sealRevision(
      {
        version: 1,
        vaultID,
        revisionID: randomUUID(),
        itemID: good.id.toUpperCase(),
        installationID: randomUUID(),
        counter: 1,
        parents: [],
        snapshot: await encodePayload([good], []),
      },
      key,
    );
    server.rows.push({ revisionID: node.revision.revisionID, seq: 1, createdAt: 0, body: base64.encode(new Uint8Array([123, 125])) });
    const store = await VaultStore.open(view(), { vaultID, key: new Uint8Array(keyBytes) });
    expect(store.unreadable).toBe(1);
    expect(store.items()).toHaveLength(0);
    // The server (or a transient fault) now serves the intact record.
    (server.rows[0] as { body: string }).body = base64.encode(node.ciphertext);
    await store.refresh();
    expect(store.unreadable).toBe(0);
    expect(store.items()[0]?.item.displayName).toBe("TEST_ONLY");
  });
});
