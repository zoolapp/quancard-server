import { argon2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  base64,
  base64url,
  buf,
  decodePayloadStrict,
  fromUTF8,
  importAESKey,
  openRevision,
  ProtocolError,
  parseRecoveryCode,
  RevisionGraph,
  recoveryCode,
  sealManifest,
  sealRevision,
  utf8,
  verifyManifest,
} from "../src/index.js";

/**
 * Cross-implementation vectors copied byte-for-byte from the iOS repository
 * (see vectors/SOURCES.md). If any of these fail, Web and iOS disagree.
 */
const vectorsDir = new URL("../../../vectors/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, vectorsDir), "utf8"));
const sync = load("sync-v1.json");
const qvault = load("qvault-v1.json");
const payloadV2 = load("qvault-payload-v2.json");

const fixed = (sequence: number) => ({
  dek: new Uint8Array(32).fill(sequence),
  wrapNonce: new Uint8Array(12).fill(sequence + 16),
  payloadNonce: new Uint8Array(12).fill(sequence + 32),
});

describe("sync-v1 vectors", () => {
  const keyBytes = base64.decode(sync.syncKeyBase64, 32);
  const vaultID = "10000000-0000-4000-8000-000000000001";

  it("parses and re-encodes the recovery code", () => {
    const material = parseRecoveryCode(sync.recoveryCode);
    expect(material.vaultID).toBe(vaultID);
    expect(material.key).toEqual(keyBytes);
    expect(recoveryCode(material)).toBe(sync.recoveryCode);
    expect(() => parseRecoveryCode(sync.recoveryCode.replace("QC1", "QC2"))).toThrow(ProtocolError);
    expect(() => parseRecoveryCode(`${sync.recoveryCode}A`)).toThrow(ProtocolError);
  });

  it("reproduces the manifest envelope byte-for-byte and verifies it", async () => {
    const key = await importAESKey(keyBytes);
    const sealed = await sealManifest({ vaultID, key: keyBytes }, key, fixed(1));
    expect(fromUTF8(sealed)).toBe(sync.manifest.envelopeUTF8);
    await verifyManifest(utf8(sync.manifest.envelopeUTF8), vaultID, key);
    const wrong = await importAESKey(new Uint8Array(32).fill(255));
    await expect(verifyManifest(utf8(sync.manifest.envelopeUTF8), vaultID, wrong)).rejects.toThrow("integrityFailure");
  });

  for (const [name, sequence] of [
    ["rootDeletion", 2],
    ["childDeletion", 3],
  ] as const) {
    it(`reproduces ${name} and its SHA-256 digest`, async () => {
      const key = await importAESKey(keyBytes);
      const vector = sync[name];
      const envelope = JSON.parse(vector.envelopeUTF8);
      const opened = await openRevision(utf8(vector.envelopeUTF8), envelope.recordID, vaultID, key);
      expect(opened.digest).toBe(vector.sha256);
      expect(opened.snapshot).toBeNull();
      const resealed = await sealRevision(opened.revision, key, fixed(sequence));
      expect(fromUTF8(resealed.ciphertext)).toBe(vector.envelopeUTF8);
      expect(resealed.digest).toBe(vector.sha256);
    });
  }

  it("rejects wrong key, changed record, changed kind and tampering", async () => {
    const key = await importAESKey(keyBytes);
    const text: string = sync.rootDeletion.envelopeUTF8;
    const recordID = JSON.parse(text).recordID;
    const wrong = await importAESKey(new Uint8Array(32).fill(255));
    await expect(openRevision(utf8(text), recordID, vaultID, wrong)).rejects.toThrow(ProtocolError);
    await expect(openRevision(utf8(text), "00000000-0000-0000-0000-000000000000", vaultID, key)).rejects.toThrow(ProtocolError);
    await expect(openRevision(utf8(text.replace("syncRevision.v1", "vaultItem")), recordID, vaultID, key)).rejects.toThrow(ProtocolError);
    const envelope = JSON.parse(text);
    const raw = base64.decode(envelope.payload);
    raw[raw.length - 1] = (raw[raw.length - 1] as number) ^ 1;
    envelope.payload = base64.encode(raw);
    await expect(openRevision(utf8(JSON.stringify(envelope)), recordID, vaultID, key)).rejects.toThrow("integrityFailure");
  });

  it("accepts iOS-style escaped slashes and digests the bytes as received", async () => {
    const key = await importAESKey(keyBytes);
    const text: string = sync.childDeletion.envelopeUTF8;
    const escaped = text.replaceAll("/", "\\/");
    expect(escaped).not.toBe(text);
    const opened = await openRevision(utf8(escaped), JSON.parse(text).recordID, vaultID, key);
    expect(opened.digest).not.toBe(sync.childDeletion.sha256);
    expect(opened.revision.counter).toBe(2);
  });

  it("links parent digests through the revision graph", async () => {
    const key = await importAESKey(keyBytes);
    const nodes = [];
    for (const name of ["rootDeletion", "childDeletion"]) {
      const text: string = sync[name].envelopeUTF8;
      nodes.push(await openRevision(utf8(text), JSON.parse(text).recordID, vaultID, key));
    }
    const graph = new RevisionGraph(vaultID);
    graph.add(nodes);
    const item = "30000000-0000-4000-8000-000000000001";
    expect(graph.heads(item).map((n) => n.revision.revisionID)).toEqual(["20000000-0000-4000-8000-000000000002"]);
    expect(graph.parentsFor(item)).toEqual([{ revisionID: "20000000-0000-4000-8000-000000000002", digest: sync.childDeletion.sha256 }]);
    expect(graph.maximumCounter).toBe(2);

    const missing = new RevisionGraph(vaultID);
    missing.add([nodes[1]!]);
    expect(missing.items()).toEqual([]);
    expect(() => missing.parentsFor(item)).toThrow("missingParents");
  });
});

describe("qvault payload vectors", () => {
  it("decodes the schema 2 CVC payload strictly", async () => {
    const payload = await decodePayloadStrict(utf8(payloadV2.success.plaintextUTF8));
    expect(payload.payloadSchemaVersion).toBe(2);
    expect(payload.items[0]?.paymentCard?.cvc).toBe("000");
  });

  it("rejects a CVC in schema 1 and forbidden keys anywhere", async () => {
    const v1 = payloadV2.success.plaintextUTF8.replace('"payloadSchemaVersion":2', '"payloadSchemaVersion":1');
    await expect(decodePayloadStrict(utf8(v1))).rejects.toThrow("forbiddenField");
    for (const key of ["cvv", "pin", "PinBlock", "trackData", "verificationCode", "cid"]) {
      const bad = payloadV2.success.plaintextUTF8.replace('"cvc":"000"', `"${key}":"000"`);
      await expect(decodePayloadStrict(utf8(bad))).rejects.toThrow("forbiddenField");
    }
  });

  it("decrypts the .qvault v1 and v2 vectors with the published KEK", async () => {
    for (const vector of [qvault.success, payloadV2.success]) {
      const kek = await importAESKey(base64url.decode(vector.derivedKeyEncryptionKey, 32));
      const wrap = vector.envelope.keyWrap;
      const bck = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: buf(base64url.decode(wrap.nonce)), additionalData: buf(utf8(vector.keyWrapAADUTF8)) },
          kek,
          buf(new Uint8Array([...base64url.decode(wrap.ciphertext), ...base64url.decode(wrap.tag)])),
        ),
      );
      expect(base64url.encode(bck)).toBe(vector.backupContentKey);
      const p = vector.envelope.payload;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buf(base64url.decode(p.nonce)), additionalData: buf(utf8(vector.payloadAADUTF8)) },
        await importAESKey(bck),
        buf(new Uint8Array([...base64url.decode(p.ciphertext), ...base64url.decode(p.tag)])),
      );
      expect(fromUTF8(new Uint8Array(plain))).toBe(vector.plaintextUTF8);
      await decodePayloadStrict(new Uint8Array(plain));
    }
  });

  it("derives the published KEK with Argon2id m=256MiB t=3 p=1", () => {
    const kek = argon2Sync("argon2id", {
      message: Buffer.from(qvault.success.normalizedPassphrase.normalize("NFC"), "utf8"),
      nonce: Buffer.from(base64url.decode(qvault.success.envelope.kdf.salt)),
      parallelism: 1,
      tagLength: 32,
      memory: 262_144,
      passes: 3,
    });
    expect(base64url.encode(new Uint8Array(kek))).toBe(qvault.success.derivedKeyEncryptionKey);
  });
});
