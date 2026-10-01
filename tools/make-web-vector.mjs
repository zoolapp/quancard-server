// Generates vectors/web/revision-v1.json: a sync v1 revision produced by the TypeScript (web)
// implementation with fixed, public randomness. tools/verify_web_vector.py checks it independently.
// Usage: node tools/make-web-vector.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { base64, encodePayload, fromUTF8, importAESKey, makeArtwork, sealManifest, sealRevision } from "../packages/protocol/dist/index.js";

const out = new URL("../vectors/web/revision-v1.json", import.meta.url);
const key = new Uint8Array(32).map((_, i) => 0x40 + i);
const vaultID = "50000000-0000-4000-8000-000000000001";
const itemID = "60000000-0000-4000-8000-000000000001";
const artworkID = "70000000-0000-4000-8000-000000000001";
const fixed = (n) => ({ dek: new Uint8Array(32).fill(n), wrapNonce: new Uint8Array(12).fill(n + 16), payloadNonce: new Uint8Array(12).fill(n + 32) });
// Smallest well-formed JPEG marker frame: SOI … EOI. Only structure and digest are checked.
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const item = {
  itemSchemaVersion: 1,
  id: itemID,
  displayName: "Synthetic web card / TEST_ONLY",
  institutionName: "TEST_ONLY Bank",
  country: "SG",
  tags: ["web"],
  notes: "Created in the web client",
  artworkTemplateID: "azure",
  artworkBlobID: artworkID,
  lifecycle: "active",
  isFavorite: true,
  manualSortPosition: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  kind: "paymentCard",
  paymentCard: {
    cardholderName: "TEST HOLDER",
    pan: "0000000000000000",
    expiryMonth: 12,
    expiryYear: 2030,
    cvc: "000",
    network: "visa",
    fundingType: "credit",
    formFactor: "physical",
    walletProvisions: [],
  },
  bankAccount: null,
};
const cryptoKey = await importAESKey(key);
const snapshot = await encodePayload([item], [await makeArtwork(artworkID, jpeg)], new Date("2026-10-01T00:00:00Z"));
const manifest = await sealManifest({ vaultID, key }, cryptoKey, fixed(1));
const node = await sealRevision(
  {
    version: 1,
    vaultID,
    revisionID: "80000000-0000-4000-8000-000000000001",
    itemID: itemID.toUpperCase(),
    installationID: "90000000-0000-4000-8000-000000000001",
    counter: 1,
    parents: [],
    snapshot,
  },
  cryptoKey,
  fixed(2),
);
const vector = {
  vectorVersion: 1,
  warning: "Public synthetic keys and values; never use for real data.",
  producer: "@quancard/protocol (TypeScript, web client)",
  syncKeyBase64: base64.encode(key),
  vaultID,
  manifestEnvelopeUTF8: fromUTF8(manifest),
  revision: { envelopeUTF8: fromUTF8(node.ciphertext), sha256: node.digest, snapshotUTF8: fromUTF8(snapshot) },
};
const text = `${JSON.stringify(vector, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("vectors/web/revision-v1.json differs from the deterministic generator");
    process.exit(1);
  }
  console.log("PASS: web vector is reproducible");
} else {
  writeFileSync(out, text);
  console.log("wrote vectors/web/revision-v1.json");
}
