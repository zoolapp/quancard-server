import { base64, encodePayload, importAESKey, randomBytes, randomUUID, sealManifest } from "@quancard/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory fake of the server data plane, enough for VaultStore. */
const server = vi.hoisted(() => ({
  manifest: new Uint8Array() as Uint8Array,
  rows: [] as { revisionID: string; seq: number; createdAt: number; body: string }[],
}));

vi.mock("../src/api.js", () => ({
  api: {
    manifest: async () => server.manifest,
    vaults: async () => ({ vaults: [] }),
    revisions: async (_vault: string, after: number) => {
      const page = server.rows.filter((r) => r.seq > after);
      return { revisions: page, nextAfter: page.at(-1)?.seq ?? after, hasMore: false, lastSeq: server.rows.at(-1)?.seq ?? 0, modifiedAt: 0 };
    },
    putRevision: async (_vault: string, revisionID: string, bytes: Uint8Array) => {
      const seq = server.rows.length + 1;
      server.rows.push({ revisionID, seq, createdAt: 0, body: base64.encode(bytes) });
      return { revisionID, seq };
    },
  },
}));

const { VaultStore } = await import("../src/vault.js");
const { isSample, removeSamples, sampleItems, seedSamples, WELCOME_ID, welcomeItem } = await import("../src/demo.js");

/** The IDs in QuanCard/Domain/DemoData.swift (iOS), in catalogue order. */
const IOS_IDS = [WELCOME_ID, ...Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8001-${String(i + 1).padStart(12, "0")}`)];

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
  server.manifest = await sealManifest({ vaultID, key: keyBytes }, await importAESKey(keyBytes));
});

describe("sample data", () => {
  it("mirrors the iOS catalogue: same IDs, 15 cards and 6 accounts, all strict-codec valid", async () => {
    for (const locale of ["en", "zh"] as const) {
      const items = sampleItems(locale);
      expect(items.map((i) => i.id)).toEqual(IOS_IDS);
      expect(items.filter((i) => i.kind === "paymentCard")).toHaveLength(15);
      expect(items.filter((i) => i.kind === "bankAccount")).toHaveLength(6);
      expect(items.every(isSample)).toBe(true);
      await encodePayload(items, []);
    }
  });

  it("uses the iOS sample tag and issuer palettes", () => {
    const zh = sampleItems("zh");
    const en = sampleItems("en");
    expect(zh[0]?.tags[0]).toBe("示例");
    expect(en[0]?.tags[0]).toBe("Demo");
    expect(welcomeItem("en").artworkTemplateID).toBe("quancard-welcome");
    expect(welcomeItem("en").lifecycle).toBe("collectionOnly");
    expect(en.find((i) => i.displayName === "HSBC Red Credit Card")?.artworkTemplateID).toBe("issuer.hsbc");
    expect(zh.find((i) => i.displayName === "工行 · 借记卡")?.artworkTemplateID).toBe("issuer.icbc");
  });

  it("seeds through encrypted revisions only, without duplicates, and removes only tagged items", async () => {
    const store = await VaultStore.open(view(), { vaultID, key: new Uint8Array(keyBytes) });
    expect(await seedSamples(store, sampleItems("en"))).toBe(21);
    expect(store.items()).toHaveLength(21);
    // Ciphertext only: no sample value appears in any uploaded body.
    const bodies = server.rows.map((r) => new TextDecoder("latin1").decode(base64.decode(r.body))).join("\n");
    for (const plain of ["DEMO USER", "5555555555554444", "HSBCHKHH", "Chase Freedom Flex"]) expect(bodies).not.toContain(plain);

    expect(await seedSamples(store, sampleItems("zh"))).toBe(0);
    expect(store.items()).toHaveLength(21);

    const mine = { ...welcomeItem("en"), id: randomUUID().toLowerCase(), tags: ["Travel"], displayName: "Mine" };
    await store.save(mine, mine.id, null);
    expect(await removeSamples(store, store.items())).toBe(21);
    expect(store.items().map((e) => e.item.displayName)).toEqual(["Mine"]);

    // Loading again after removal brings the samples back.
    expect(await seedSamples(store, sampleItems("en"))).toBe(21);
    expect(store.items()).toHaveLength(22);
  });
});
