import { argon2 } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type Argon2id,
  base64,
  canonicalJSON,
  decodePayloadStrict,
  deriveAccountSecrets,
  encodePayload,
  importAESKey,
  makeArtwork,
  newAccountKey,
  openRevision,
  ProtocolError,
  parseEnvelope,
  parseStrictJSON,
  passwordMeetsPolicy,
  RevisionGraph,
  randomBytes,
  randomUUID,
  type SyncRevision,
  sealRevision,
  unwrapAccountKey,
  unwrapVaultKey,
  utf8,
  type VaultItem,
  wrapAccountKey,
  wrapVaultKey,
} from "../src/index.js";

// Synthetic, deliberately invalid placeholder values only.
const TEST_PAN = "0000000000000000";

function card(id: string, overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    itemSchemaVersion: 1,
    id,
    displayName: "Synthetic test card",
    institutionName: "Test Bank",
    country: "SG",
    tags: ["test"],
    notes: "TEST_ONLY note",
    artworkTemplateID: "graphite",
    artworkBlobID: null,
    lifecycle: "active",
    isFavorite: false,
    manualSortPosition: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    kind: "paymentCard",
    paymentCard: {
      cardholderName: "TEST HOLDER",
      pan: TEST_PAN,
      expiryMonth: 12,
      expiryYear: 2030,
      network: "visa",
      fundingType: "credit",
      formFactor: "physical",
      walletProvisions: [],
    },
    bankAccount: null,
    ...overrides,
  };
}

const lower = () => randomUUID().toLowerCase();
const tinyJPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);

describe("strict JSON", () => {
  it("rejects duplicates, fractions, BOM, deep nesting and trailing data", () => {
    for (const text of ['{"a":1,"a":2}', '{"a":1.0}', '{"a":1e3}', "[1] x", '{"a":01}']) {
      expect(() => parseStrictJSON(utf8(text))).toThrow(ProtocolError);
    }
    expect(() => parseStrictJSON(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow(ProtocolError);
    expect(() => parseStrictJSON(utf8("[".repeat(40) + "]".repeat(40)))).toThrow("resourceLimitExceeded");
    expect(() => parseStrictJSON(utf8('{"PIN":"1"}'))).toThrow("forbiddenField");
  });

  it("does not let __proto__ pollute objects", () => {
    const { value } = parseStrictJSON(utf8('{"__proto__":{"x":1}}'));
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.keys(value as object)).toEqual(["__proto__"]);
  });

  it("emits sorted compact JSON without escaping slashes", () => {
    expect(canonicalJSON({ b: "a/b", a: [{ d: 1, c: null }] })).toBe('{"a":[{"c":null,"d":1}],"b":"a/b"}');
  });
});

describe("vault payload", () => {
  it("round-trips a card with CVC and artwork plus a bank account", async () => {
    const artworkID = lower();
    const art = await makeArtwork(artworkID, tinyJPEG);
    const withCVC = card(lower(), { artworkBlobID: artworkID });
    withCVC.paymentCard = { ...withCVC.paymentCard!, cvc: "123" };
    const account: VaultItem = {
      ...card(lower()),
      kind: "bankAccount",
      paymentCard: null,
      bankAccount: {
        accountHolderName: "TEST HOLDER",
        accountNumber: "TEST_ONLY",
        accountKind: "checking",
        currencies: ["USD"],
        routingIdentifiers: [{ id: lower(), scheme: "iban", value: "TEST_ONLY", label: null }],
      },
    };
    const bytes = await encodePayload([withCVC, account], [art], new Date("2026-10-01T00:00:00Z"));
    const decoded = await decodePayloadStrict(bytes);
    expect(decoded.payloadSchemaVersion).toBe(2);
    expect(decoded.items).toEqual([withCVC, account]);
    expect(decoded.artworks[0]?.sha256).toBe(art.sha256);
  });

  it("uses schema 1 without a CVC and omits the key", async () => {
    const bytes = await encodePayload([card(lower())], []);
    expect(new TextDecoder().decode(bytes)).not.toContain("cvc");
    expect((await decodePayloadStrict(bytes)).payloadSchemaVersion).toBe(1);
  });

  it("rejects orphan artwork, bad digests, non-JPEG, bad dates and invalid CVC", async () => {
    const art = await makeArtwork(lower(), tinyJPEG);
    await expect(encodePayload([card(lower())], [art])).rejects.toThrow(ProtocolError);
    const badDigest = { ...art, sha256: art.sha256.replace(/^./, art.sha256[0] === "A" ? "B" : "A") };
    await expect(encodePayload([card(lower(), { artworkBlobID: art.id })], [badDigest])).rejects.toThrow(ProtocolError);
    await expect(makeArtwork(lower(), new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(ProtocolError);
    await expect(encodePayload([card(lower(), { createdAt: "2026-02-30T00:00:00.000Z" })], [])).rejects.toThrow(ProtocolError);
    const badCVC = card(lower());
    badCVC.paymentCard = { ...badCVC.paymentCard!, cvc: "12a" };
    await expect(encodePayload([badCVC], [])).rejects.toThrow(ProtocolError);
    await expect(encodePayload([card("ABCDEF00-0000-4000-8000-000000000000")], [])).rejects.toThrow(ProtocolError);
  });

  it("rejects unknown keys and missing explicit nulls", async () => {
    const good = new TextDecoder().decode(await encodePayload([card(lower())], []));
    await expect(decodePayloadStrict(utf8(good.replace('"notes":"TEST_ONLY note",', "")))).rejects.toThrow(ProtocolError);
    await expect(decodePayloadStrict(utf8(good.replace('"notes":', '"extra":1,"notes":')))).rejects.toThrow(ProtocolError);
  });
});

describe("sync revisions", () => {
  async function setup() {
    const vaultID = randomUUID();
    const keyBytes = randomBytes(32);
    return { vaultID, key: await importAESKey(keyBytes) };
  }

  async function revision(
    vaultID: string,
    item: VaultItem | null,
    itemID: string,
    counter: number,
    installationID: string,
    parents: SyncRevision["parents"] = [],
  ) {
    return {
      version: 1 as const,
      vaultID,
      revisionID: randomUUID(),
      itemID,
      installationID,
      counter,
      parents,
      snapshot: item ? await encodePayload([item], []) : null,
    };
  }

  it("seals a snapshot revision that opens with the same item", async () => {
    const { vaultID, key } = await setup();
    const item = card(lower());
    const node = await sealRevision(await revision(vaultID, item, item.id.toUpperCase(), 1, randomUUID()), key);
    const opened = await openRevision(node.ciphertext, node.revision.revisionID, vaultID, key);
    expect(opened.snapshot?.items[0]).toEqual(item);
    expect(opened.digest).toBe(node.digest);
    expect(parseEnvelope(node.ciphertext, { maximumBytes: 1 << 24 }).objectKind).toBe("syncRevision.v1");
  });

  it("refuses snapshots for a different item and unsorted parents", async () => {
    const { vaultID, key } = await setup();
    const item = card(lower());
    await expect(sealRevision(await revision(vaultID, item, randomUUID(), 1, randomUUID()), key)).rejects.toThrow(ProtocolError);
    const parents = [
      { revisionID: "F0000000-0000-4000-8000-000000000000", digest: base64.encode(new Uint8Array(32)) },
      { revisionID: "10000000-0000-4000-8000-000000000000", digest: base64.encode(new Uint8Array(32)) },
    ];
    await expect(sealRevision(await revision(vaultID, null, randomUUID(), 2, randomUUID(), parents), key)).rejects.toThrow("integrityFailure");
  });

  it("keeps concurrent edits as a conflict until a merge revision covers all heads", async () => {
    const { vaultID, key } = await setup();
    const item = card(lower());
    const itemID = item.id.toUpperCase();
    const phone = randomUUID();
    const web = randomUUID();
    const root = await sealRevision(await revision(vaultID, item, itemID, 1, phone), key);
    const graph = new RevisionGraph(vaultID);
    graph.add([root]);
    const parents = graph.parentsFor(itemID);
    const a = await sealRevision(await revision(vaultID, { ...item, displayName: "A" }, itemID, 2, phone, parents), key);
    const b = await sealRevision(await revision(vaultID, { ...item, displayName: "B" }, itemID, 2, web, parents), key);
    graph.add([a, b]);
    expect(graph.heads(itemID)).toHaveLength(2);
    expect(() => graph.parentsFor(itemID)).toThrow("conflict");
    const merged = graph.parentsFor(itemID, true);
    const resolution = await sealRevision(await revision(vaultID, { ...item, displayName: "B" }, itemID, 3, web, merged), key);
    graph.add([resolution]);
    expect(graph.heads(itemID).map((n) => n.revision.revisionID)).toEqual([resolution.revision.revisionID]);
  });

  it("rejects replayed clocks, digest mismatch and conflicting bytes for one ID", async () => {
    const { vaultID, key } = await setup();
    const item = card(lower());
    const itemID = item.id.toUpperCase();
    const install = randomUUID();
    const one = await sealRevision(await revision(vaultID, item, itemID, 1, install), key);
    const two = await sealRevision(await revision(vaultID, item, itemID, 1, install), key);
    expect(() => new RevisionGraph(vaultID).add([one, two])).toThrow("integrityFailure");
    const badParent = await sealRevision(
      await revision(vaultID, item, itemID, 2, install, [{ revisionID: one.revision.revisionID, digest: base64.encode(new Uint8Array(32)) }]),
      key,
    );
    expect(() => new RevisionGraph(vaultID).add([one, badParent])).toThrow("integrityFailure");
    const resealed = await sealRevision(one.revision, key);
    const graph = new RevisionGraph(vaultID);
    graph.add([one]);
    expect(() => graph.add([resealed])).toThrow("integrityFailure");
  });
});

describe("account keys", () => {
  const argon2id: Argon2id = (input) =>
    new Promise((resolve, reject) =>
      argon2(
        "argon2id",
        {
          message: input.password,
          nonce: input.salt,
          memory: input.memoryKiB,
          passes: input.iterations,
          parallelism: input.parallelism,
          tagLength: input.outputBytes,
        },
        (error, key) => (error ? reject(error) : resolve(new Uint8Array(key))),
      ),
    );

  it("derives stable auth keys, wraps and unwraps the account and vault keys", async () => {
    const salt = randomBytes(16);
    const password = "correct horse battery staple";
    const one = await deriveAccountSecrets(password, salt, argon2id);
    const nfd = await deriveAccountSecrets(password.normalize("NFD"), salt, argon2id);
    expect(one.authKey).toEqual(nfd.authKey);
    const accountID = randomUUID();
    const accountKey = newAccountKey();
    const wrapped = await wrapAccountKey(accountKey, accountID, one.kek);
    const { key, raw } = await unwrapAccountKey(wrapped, accountID, nfd.kek);
    expect(raw).toEqual(accountKey);
    const vault = { vaultID: randomUUID(), key: randomBytes(32) };
    const wrappedVault = await wrapVaultKey(vault, key);
    expect(await unwrapVaultKey(wrappedVault, vault.vaultID, key)).toEqual(vault);
    await expect(unwrapVaultKey(wrappedVault, randomUUID(), key)).rejects.toThrow(ProtocolError);
    const other = await deriveAccountSecrets("a different long password", salt, argon2id);
    expect(other.authKey).not.toEqual(one.authKey);
    await expect(unwrapAccountKey(wrapped, accountID, other.kek)).rejects.toThrow("integrityFailure");
  });

  it("enforces the length-only password policy", () => {
    expect(passwordMeetsPolicy("short")).toBe(false);
    expect(passwordMeetsPolicy("fifteen chars!!")).toBe(true);
    expect(passwordMeetsPolicy("密码密码密码密码密码密码密码密码")).toBe(true);
  });
});
