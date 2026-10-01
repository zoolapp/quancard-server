// SPDX-License-Identifier: Apache-2.0
import { base64url, bytesEqual, ProtocolError, parseLowerUUID, sha256, utf8 } from "./bytes.js";
import {
  asArray,
  asBoolean,
  asInteger,
  asObject,
  asOptionalInteger,
  asOptionalString,
  asString,
  canonicalJSON,
  type JSONObject,
  type JSONValue,
  parseStrictJSON,
} from "./strict-json.js";

/**
 * Vault payload (`.qvault` payload schema 1/2), the plaintext that sync
 * revisions carry. Mirrors iOS `QVaultPayloadV1.decodeStrict`: exact key
 * whitelists, explicit nulls, canonical lowercase UUIDs, fixed-millisecond UTC
 * dates and hard resource limits. Schema 2 only adds `paymentCard.cvc`.
 */

export const PAYLOAD_LIMITS = {
  payloadBytes: 199_229_440,
  jsonDepth: 32,
  items: 10_000,
  artworks: 2_048,
  artworkBytes: 4_194_304,
  allArtworkBytes: 167_772_160,
  userStringBytes: 65_536,
  tagsPerItem: 128,
  routingIdentifiersPerAccount: 128,
  walletProvisionsPerCard: 32,
} as const;

/** Stable storage values. Unknown values are preserved (open enums). */
export const KNOWN_VALUES = {
  network: ["visa", "mastercard", "amex", "unionPay", "jcb", "discover", "dinersClub", "rupay", "mir", "other"],
  fundingType: ["credit", "debit", "charge", "prepaid", "cryptoLinked", "other"],
  formFactor: ["physical", "virtual", "other"],
  accountKind: ["checking", "savings", "current", "multiCurrency", "payment", "other"],
  lifecycle: ["active", "expired", "closed", "collectionOnly", "other"],
  routingScheme: [
    "iban",
    "bic",
    "abaRoutingNumber",
    "sortCode",
    "bsb",
    "ifsc",
    "clabe",
    "cnaps",
    "bankCode",
    "branchCode",
    "institutionNumber",
    "transitNumber",
    "other",
  ],
  walletProvider: ["applePay", "googlePay", "samsungPay", "alipay", "wechatPay", "payPal", "other"],
} as const;

export interface PaymentCardDetail {
  cardholderName: string | null;
  pan: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  /** Present only in payload schema 2. */
  cvc?: string | undefined;
  network: string;
  fundingType: string;
  formFactor: string;
  walletProvisions: string[];
}

export interface RoutingIdentifier {
  id: string;
  scheme: string;
  value: string;
  label: string | null;
}

export interface BankAccountDetail {
  accountHolderName: string | null;
  accountNumber: string | null;
  accountKind: string;
  currencies: string[];
  routingIdentifiers: RoutingIdentifier[];
}

export interface VaultItem {
  itemSchemaVersion: 1;
  id: string;
  displayName: string;
  institutionName: string | null;
  country: string | null;
  tags: string[];
  notes: string | null;
  artworkTemplateID: string;
  artworkBlobID: string | null;
  lifecycle: string;
  isFavorite: boolean;
  manualSortPosition: number | null;
  createdAt: string;
  updatedAt: string;
  kind: "paymentCard" | "bankAccount";
  paymentCard: PaymentCardDetail | null;
  bankAccount: BankAccountDetail | null;
}

export interface VaultArtwork {
  id: string;
  mediaType: "image/jpeg";
  sha256: string;
  data: string;
}

export interface VaultPayload {
  payloadSchemaVersion: 1 | 2;
  createdAt: string;
  items: VaultItem[];
  artworks: VaultArtwork[];
}

const ITEM_KEYS = [
  "itemSchemaVersion",
  "id",
  "displayName",
  "institutionName",
  "country",
  "tags",
  "notes",
  "artworkTemplateID",
  "artworkBlobID",
  "lifecycle",
  "isFavorite",
  "manualSortPosition",
  "createdAt",
  "updatedAt",
  "kind",
  "paymentCard",
  "bankAccount",
] as const;
const CARD_KEYS = ["cardholderName", "pan", "expiryMonth", "expiryYear", "network", "fundingType", "formFactor", "walletProvisions"] as const;
const ACCOUNT_KEYS = ["accountHolderName", "accountNumber", "accountKind", "currencies", "routingIdentifiers"] as const;
const ROUTING_KEYS = ["id", "scheme", "value", "label"] as const;
const ARTWORK_KEYS = ["id", "mediaType", "sha256", "data"] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function formatDate(date: Date): string {
  const text = date.toISOString();
  if (!DATE_PATTERN.test(text)) throw new ProtocolError("invalidData");
  return text;
}

function checkDate(value: JSONValue | undefined): string {
  const text = asString(value);
  if (!DATE_PATTERN.test(text)) throw new ProtocolError("invalidData");
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) throw new ProtocolError("invalidData");
  return text;
}

const encoder = new TextEncoder();
function checkUserString(value: string | null): void {
  if (value !== null && encoder.encode(value).length > PAYLOAD_LIMITS.userStringBytes) {
    throw new ProtocolError("resourceLimitExceeded");
  }
}

export function isValidCVC(value: string): boolean {
  return /^[0-9]{3,4}$/.test(value);
}

export function isJPEG(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
}

export async function decodePayloadStrict(bytes: Uint8Array): Promise<VaultPayload> {
  if (bytes.length > PAYLOAD_LIMITS.payloadBytes) throw new ProtocolError("resourceLimitExceeded");
  let parsed: ReturnType<typeof parseStrictJSON>;
  try {
    parsed = parseStrictJSON(bytes, { maximumDepth: PAYLOAD_LIMITS.jsonDepth, allowsCVC: true });
  } catch (error) {
    if (error instanceof ProtocolError && (error.code === "forbiddenField" || error.code === "resourceLimitExceeded")) {
      throw error;
    }
    throw new ProtocolError("invalidData");
  }
  const root = asObject(parsed.value, ["payloadSchemaVersion", "createdAt", "items", "artworks"]);
  const schema = asInteger(root.payloadSchemaVersion);
  if (parsed.sawCVC && schema !== 2) throw new ProtocolError("forbiddenField");
  if (schema !== 1 && schema !== 2) throw new ProtocolError("invalidData");
  const createdAt = checkDate(root.createdAt);
  const rawItems = asArray(root.items);
  const rawArtworks = asArray(root.artworks);
  if (rawItems.length > PAYLOAD_LIMITS.items || rawArtworks.length > PAYLOAD_LIMITS.artworks) {
    throw new ProtocolError("resourceLimitExceeded");
  }

  const artworks: VaultArtwork[] = [];
  const artworkIDs = new Set<string>();
  let totalArtworkBytes = 0;
  for (const raw of rawArtworks) {
    const object = asObject(raw, ARTWORK_KEYS);
    const id = parseLowerUUID(object.id);
    if (artworkIDs.has(id) || object.mediaType !== "image/jpeg") throw new ProtocolError("invalidData");
    artworkIDs.add(id);
    const data = asString(object.data);
    if (data.length > Math.ceil(PAYLOAD_LIMITS.artworkBytes / 3) * 4) throw new ProtocolError("resourceLimitExceeded");
    const imageBytes = base64url.decode(data);
    const digest = base64url.decode(asString(object.sha256), 32);
    if (imageBytes.length > PAYLOAD_LIMITS.artworkBytes) throw new ProtocolError("resourceLimitExceeded");
    totalArtworkBytes += imageBytes.length;
    if (totalArtworkBytes > PAYLOAD_LIMITS.allArtworkBytes) throw new ProtocolError("resourceLimitExceeded");
    if (!isJPEG(imageBytes) || !bytesEqual(await sha256(imageBytes), digest)) throw new ProtocolError("invalidData");
    artworks.push({ id, mediaType: "image/jpeg", sha256: asString(object.sha256), data });
  }

  const items: VaultItem[] = [];
  const itemIDs = new Set<string>();
  const referenced = new Set<string>();
  for (const raw of rawItems) {
    const item = decodeItem(asObject(raw, ITEM_KEYS), schema);
    if (itemIDs.has(item.id)) throw new ProtocolError("invalidData");
    itemIDs.add(item.id);
    if (item.artworkBlobID !== null) {
      if (!artworkIDs.has(item.artworkBlobID)) throw new ProtocolError("invalidData");
      referenced.add(item.artworkBlobID);
    }
    items.push(item);
  }
  if (referenced.size !== artworkIDs.size) throw new ProtocolError("invalidData");
  return { payloadSchemaVersion: schema, createdAt, items, artworks };
}

function decodeItem(object: JSONObject, schema: 1 | 2): VaultItem {
  if (asInteger(object.itemSchemaVersion) !== 1) throw new ProtocolError("invalidData");
  const tags = asArray(object.tags).map(asString);
  if (tags.length > PAYLOAD_LIMITS.tagsPerItem) throw new ProtocolError("invalidData");
  const kind = asString(object.kind);
  const artworkBlobID = object.artworkBlobID === null ? null : parseLowerUUID(object.artworkBlobID);
  const item: VaultItem = {
    itemSchemaVersion: 1,
    id: parseLowerUUID(object.id),
    displayName: asString(object.displayName),
    institutionName: asOptionalString(object.institutionName),
    country: asOptionalString(object.country),
    tags,
    notes: asOptionalString(object.notes),
    artworkTemplateID: asString(object.artworkTemplateID),
    artworkBlobID,
    lifecycle: asString(object.lifecycle),
    isFavorite: asBoolean(object.isFavorite),
    manualSortPosition: asOptionalInteger(object.manualSortPosition),
    createdAt: checkDate(object.createdAt),
    updatedAt: checkDate(object.updatedAt),
    kind: "paymentCard",
    paymentCard: null,
    bankAccount: null,
  };
  for (const s of [item.displayName, item.institutionName, item.country, item.notes, item.artworkTemplateID, item.lifecycle, ...tags]) {
    checkUserString(s);
  }
  if (kind === "paymentCard") {
    if (object.paymentCard === null || object.bankAccount !== null) throw new ProtocolError("invalidData");
    item.paymentCard = decodeCard(object.paymentCard, schema);
  } else if (kind === "bankAccount") {
    if (object.bankAccount === null || object.paymentCard !== null) throw new ProtocolError("invalidData");
    item.kind = "bankAccount";
    item.bankAccount = decodeAccount(object.bankAccount);
  } else {
    throw new ProtocolError("invalidData");
  }
  return item;
}

function decodeCard(value: JSONValue | undefined, schema: 1 | 2): PaymentCardDetail {
  const loose = asObject(value);
  const hasCVC = Object.hasOwn(loose, "cvc");
  if (hasCVC && schema !== 2) throw new ProtocolError("forbiddenField");
  const object = asObject(value, hasCVC ? [...CARD_KEYS, "cvc"] : CARD_KEYS);
  const walletProvisions = asArray(object.walletProvisions).map(asString);
  if (walletProvisions.length > PAYLOAD_LIMITS.walletProvisionsPerCard) throw new ProtocolError("resourceLimitExceeded");
  const card: PaymentCardDetail = {
    cardholderName: asOptionalString(object.cardholderName),
    pan: asOptionalString(object.pan),
    expiryMonth: asOptionalInteger(object.expiryMonth),
    expiryYear: asOptionalInteger(object.expiryYear),
    network: asString(object.network),
    fundingType: asString(object.fundingType),
    formFactor: asString(object.formFactor),
    walletProvisions,
  };
  if (hasCVC) {
    // iOS omits an absent CVC but its reader also tolerates an explicit null.
    if (object.cvc !== null) {
      const cvc = asString(object.cvc);
      if (!isValidCVC(cvc)) throw new ProtocolError("invalidData");
      card.cvc = cvc;
    }
  }
  for (const s of [card.cardholderName, card.pan, card.network, card.fundingType, card.formFactor, ...walletProvisions]) {
    checkUserString(s);
  }
  return card;
}

function decodeAccount(value: JSONValue | undefined): BankAccountDetail {
  const object = asObject(value, ACCOUNT_KEYS);
  const currencies = asArray(object.currencies).map(asString);
  const rawRouting = asArray(object.routingIdentifiers);
  if (rawRouting.length > PAYLOAD_LIMITS.routingIdentifiersPerAccount) throw new ProtocolError("resourceLimitExceeded");
  const seen = new Set<string>();
  const routingIdentifiers = rawRouting.map((raw) => {
    const r = asObject(raw, ROUTING_KEYS);
    const id = parseLowerUUID(r.id);
    if (seen.has(id)) throw new ProtocolError("invalidData");
    seen.add(id);
    const routing: RoutingIdentifier = { id, scheme: asString(r.scheme), value: asString(r.value), label: asOptionalString(r.label) };
    for (const s of [routing.scheme, routing.value, routing.label]) checkUserString(s);
    return routing;
  });
  const account: BankAccountDetail = {
    accountHolderName: asOptionalString(object.accountHolderName),
    accountNumber: asOptionalString(object.accountNumber),
    accountKind: asString(object.accountKind),
    currencies,
    routingIdentifiers,
  };
  for (const s of [account.accountHolderName, account.accountNumber, account.accountKind, ...currencies]) checkUserString(s);
  return account;
}

/** Builds and validates a payload; schema 2 is chosen exactly when a CVC is present. */
export async function encodePayload(items: VaultItem[], artworks: VaultArtwork[], createdAt = new Date()): Promise<Uint8Array> {
  const schema = items.some((i) => i.paymentCard?.cvc !== undefined) ? 2 : 1;
  const normalized = items.map((item) => {
    if (item.paymentCard && item.paymentCard.cvc === undefined) {
      const { cvc: _omit, ...rest } = item.paymentCard;
      return { ...item, paymentCard: rest };
    }
    return item;
  });
  const payload = {
    payloadSchemaVersion: schema,
    createdAt: formatDate(createdAt),
    items: normalized,
    artworks: [...artworks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  const bytes = utf8(canonicalJSON(payload));
  // Never emit what a strict reader (including iOS) would refuse.
  await decodePayloadStrict(bytes);
  return bytes;
}

export async function makeArtwork(id: string, jpeg: Uint8Array): Promise<VaultArtwork> {
  parseLowerUUID(id);
  if (jpeg.length > PAYLOAD_LIMITS.artworkBytes) throw new ProtocolError("resourceLimitExceeded");
  if (!isJPEG(jpeg)) throw new ProtocolError("invalidData");
  return { id, mediaType: "image/jpeg", sha256: base64url.encode(await sha256(jpeg)), data: base64url.encode(jpeg) };
}
