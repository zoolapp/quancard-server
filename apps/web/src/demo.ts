import { type BankAccountDetail, type PaymentCardDetail, randomUUID, type VaultItem } from "@quancard/protocol";
import type { Locale } from "./i18n.js";
import { templateIDFor, WELCOME_TEMPLATE_ID } from "./templates.js";
import type { ProjectedItem, VaultStore } from "./vault.js";

/**
 * Sample data, mirroring the iOS catalogue (QuanCard/Domain/DemoData.swift):
 * the same stable item IDs and the same localized "sample" tags, so a vault
 * seeded here shows up on a paired iPhone as demo data, and "Remove sample
 * data" on either side removes it everywhere. Numbers are public test
 * vectors or deliberately invalid placeholders. There are no photos: faces
 * come from the original templates and issuer palettes.
 *
 * Samples are written like any other item — encrypted in this browser into
 * new revisions — so the server never sees them in plaintext either.
 */

export const WELCOME_ID = "00000000-0000-4000-8000-000000000026";

/** Every localization of the sample tag used by iOS (zh-Hans, zh-Hant, en). */
export const SAMPLE_TAGS: ReadonlySet<string> = new Set(["示例", "範例", "Demo"]);

function sampleID(n: number): string {
  return `00000000-0000-4000-8001-${String(n).padStart(12, "0")}`;
}

type Text = { en: string; zh: string };

const tx = (en: string, zh: string): Text => ({ en, zh });

interface CardSpec {
  id: string;
  name: Text;
  institution: Text;
  country: string;
  tags: Text[];
  card: Partial<PaymentCardDetail> & Pick<PaymentCardDetail, "network" | "fundingType" | "formFactor">;
  lifecycle?: string;
  template?: string;
  notes?: Text;
}

interface AccountSpec {
  id: string;
  name: Text;
  institution: string;
  country: string;
  tags: Text[];
  account: Omit<BankAccountDetail, "routingIdentifiers"> & { routing: { scheme: string; value: string; label?: string }[] };
  template?: string;
}

const SAMPLE = tx("Demo", "示例");

const WELCOME: CardSpec = {
  id: WELCOME_ID,
  name: tx("QuanCard · Sample", "全卡卡 · 示例"),
  institution: tx("QuanCard", "QuanCard"),
  country: "",
  tags: [],
  card: {
    cardholderName: "KAKA DEMO",
    pan: "0000000000000000",
    expiryMonth: 12,
    expiryYear: 2030,
    network: "other",
    fundingType: "debit",
    formFactor: "virtual",
  },
  lifecycle: "collectionOnly",
  template: WELCOME_TEMPLATE_ID,
  notes: tx(
    "This fictional QuanCard demo card is for trying the collection and cannot make payments. You can edit or delete it anytime.",
    "这是全卡卡的虚构示例卡，仅用于体验收藏，不可支付。你可以随时编辑或删除。",
  ),
};

const MC = tx("Mastercard", "Mastercard");
const AMEX = tx("Amex", "Amex");
const UP = tx("UnionPay", "UnionPay");
const DEBIT = tx("Debit", "借记");
const HKD = tx("HKD", "港币");
const MULTI = tx("Multi-currency", "多币种");

const CARDS: CardSpec[] = [
  {
    id: sampleID(1),
    name: tx("Chase Freedom Flex", "Chase Freedom Flex"),
    institution: tx("Chase", "Chase"),
    country: "US",
    tags: [MC, tx("Cash back", "返现")],
    card: {
      cardholderName: "DEMO USER",
      pan: "5555555555554444",
      expiryMonth: 3,
      expiryYear: 2028,
      network: "mastercard",
      fundingType: "credit",
      formFactor: "physical",
      walletProvisions: ["applePay"],
    },
  },
  {
    id: sampleID(2),
    name: tx("Amex Platinum", "Amex Platinum"),
    institution: tx("American Express", "American Express"),
    country: "US",
    tags: [AMEX, tx("Travel", "旅行")],
    card: {
      cardholderName: "DEMO USER",
      pan: "378282246310005",
      expiryMonth: 4,
      expiryYear: 2030,
      network: "amex",
      fundingType: "charge",
      formFactor: "physical",
      walletProvisions: ["applePay"],
    },
  },
  {
    id: sampleID(3),
    name: tx("Amex Blue Cash Everyday", "Amex Blue Cash Everyday"),
    institution: tx("American Express", "American Express"),
    country: "US",
    tags: [AMEX, tx("Cash back", "返现")],
    card: {
      cardholderName: "DEMO USER",
      pan: "371449635398431",
      expiryMonth: 1,
      expiryYear: 2029,
      network: "amex",
      fundingType: "credit",
      formFactor: "physical",
    },
  },
  {
    id: sampleID(4),
    name: tx("Apple Card", "Apple Card"),
    institution: tx("Goldman Sachs Bank USA", "Goldman Sachs Bank USA"),
    country: "US",
    tags: [MC],
    card: {
      cardholderName: "DEMO USER",
      pan: "5105105105105100",
      expiryMonth: 6,
      expiryYear: 2029,
      network: "mastercard",
      fundingType: "credit",
      formFactor: "physical",
      walletProvisions: ["applePay"],
    },
  },
  {
    id: sampleID(5),
    name: tx("HSBC Red Credit Card", "滙豐 Red 信用卡"),
    institution: tx("HSBC", "HSBC"),
    country: "HK",
    tags: [MC, HKD],
    card: {
      cardholderName: "DEMO USER",
      pan: "2223003122003222",
      expiryMonth: 9,
      expiryYear: 2029,
      network: "mastercard",
      fundingType: "credit",
      formFactor: "physical",
      walletProvisions: ["applePay", "alipay"],
    },
  },
  {
    id: sampleID(6),
    name: tx("HSBC Premier Mastercard", "滙豐卓越理財 Mastercard"),
    institution: tx("HSBC", "HSBC"),
    country: "HK",
    tags: [MC],
    card: {
      cardholderName: "DEMO USER",
      pan: "5200828282828210",
      expiryMonth: 2,
      expiryYear: 2030,
      network: "mastercard",
      fundingType: "credit",
      formFactor: "physical",
    },
  },
  {
    id: sampleID(7),
    name: tx("HSBC Mastercard Debit Card", "滙豐 Mastercard 扣賬卡"),
    institution: tx("HSBC", "HSBC"),
    country: "HK",
    tags: [MC, DEBIT],
    card: {
      cardholderName: "DEMO USER",
      pan: "5555552500001001",
      expiryMonth: 7,
      expiryYear: 2028,
      network: "mastercard",
      fundingType: "debit",
      formFactor: "physical",
      walletProvisions: ["applePay", "alipay", "wechatPay"],
    },
  },
  {
    id: sampleID(8),
    name: tx("Hang Seng Prestige ATM Card", "恒生 Prestige 提款卡"),
    institution: tx("Hang Seng Bank", "Hang Seng Bank"),
    country: "HK",
    tags: [UP, DEBIT],
    card: {
      cardholderName: "DEMO USER",
      pan: "6200000000000005",
      expiryMonth: 11,
      expiryYear: 2030,
      network: "unionPay",
      fundingType: "debit",
      formFactor: "physical",
    },
  },
  {
    id: sampleID(9),
    name: tx("DBS Diamond Debit Card", "星展 Diamond 扣賬卡"),
    institution: tx("DBS Bank (Hong Kong)", "DBS Bank (Hong Kong)"),
    country: "HK",
    tags: [UP, DEBIT],
    card: {
      cardholderName: "DEMO USER",
      pan: "6205500000000000004",
      expiryMonth: 3,
      expiryYear: 2031,
      network: "unionPay",
      fundingType: "debit",
      formFactor: "physical",
    },
  },
  {
    id: sampleID(10),
    name: tx("BOCHK Mastercard Debit Card", "中銀 Mastercard 扣賬卡"),
    institution: tx("Bank of China (Hong Kong)", "Bank of China (Hong Kong)"),
    country: "HK",
    tags: [MC, DEBIT],
    card: {
      cardholderName: "DEMO USER",
      pan: "2223000048400011",
      expiryMonth: 8,
      expiryYear: 2030,
      network: "mastercard",
      fundingType: "debit",
      formFactor: "physical",
    },
  },
  {
    id: sampleID(11),
    name: tx("livi Debit Mastercard", "livi Debit Mastercard"),
    institution: tx("livi Bank", "livi Bank"),
    country: "HK",
    tags: [MC, tx("Digital bank", "虚拟银行")],
    card: {
      cardholderName: "DEMO USER",
      pan: "5200828282828210",
      expiryMonth: 6,
      expiryYear: 2028,
      network: "mastercard",
      fundingType: "debit",
      formFactor: "virtual",
      walletProvisions: ["applePay"],
    },
  },
  {
    id: sampleID(12),
    name: tx("Octopus Mastercard", "Octopus Mastercard"),
    institution: tx("Octopus Cards", "Octopus Cards"),
    country: "HK",
    tags: [MC, tx("Prepaid", "预付")],
    card: {
      pan: "5105105105105100",
      expiryMonth: 1,
      expiryYear: 2028,
      network: "mastercard",
      fundingType: "prepaid",
      formFactor: "virtual",
      walletProvisions: ["applePay"],
    },
  },
  {
    id: sampleID(13),
    name: tx("Bybit Card", "Bybit Card"),
    institution: tx("Bybit", "Bybit"),
    country: "AE",
    tags: [tx("U card", "U卡"), MC],
    card: {
      pan: "5105105105105100",
      expiryMonth: 6,
      expiryYear: 2028,
      network: "mastercard",
      fundingType: "cryptoLinked",
      formFactor: "physical",
      walletProvisions: ["applePay"],
    },
  },
  {
    id: sampleID(14),
    name: tx("ICBC · Debit Card", "工行 · 借记卡"),
    institution: tx("Industrial and Commercial Bank of China", "中国工商银行"),
    country: "CN",
    tags: [UP, tx("CNY", "人民币")],
    card: {
      cardholderName: "DEMO USER",
      pan: "6200000000000005",
      expiryMonth: 11,
      expiryYear: 2031,
      network: "unionPay",
      fundingType: "debit",
      formFactor: "physical",
      walletProvisions: ["alipay", "wechatPay"],
    },
    notes: tx("Demo: the institution name matches the ICBC colors and mark.", "示例：中文机构名匹配到工商银行配色与标志。"),
  },
];

const ACCOUNTS: AccountSpec[] = [
  {
    id: sampleID(15),
    name: tx("HSBC Hong Kong Account", "滙豐香港戶口"),
    institution: "HSBC",
    country: "HK",
    tags: [HKD],
    account: {
      accountHolderName: "DEMO USER",
      accountNumber: "123-456789-001",
      accountKind: "savings",
      currencies: ["HKD", "USD"],
      routing: [
        { scheme: "bankCode", value: "004" },
        { scheme: "bic", value: "HSBCHKHH" },
      ],
    },
  },
  {
    id: sampleID(16),
    name: tx("US Payroll Account", "美国工资账户"),
    institution: "Bank of America",
    country: "US",
    tags: [],
    account: {
      accountHolderName: "DEMO USER",
      accountNumber: "000123456789",
      accountKind: "checking",
      currencies: ["USD"],
      routing: [{ scheme: "abaRoutingNumber", value: "111000025", label: "ACH" }],
    },
  },
  {
    id: sampleID(17),
    name: tx("Wells Fargo Savings", "富国银行储蓄"),
    institution: "Wells Fargo",
    country: "US",
    tags: [tx("Savings", "储蓄")],
    account: {
      accountHolderName: "DEMO USER",
      accountNumber: "000987654321",
      accountKind: "savings",
      currencies: ["USD"],
      routing: [{ scheme: "abaRoutingNumber", value: "111000025", label: "ACH" }],
    },
  },
  {
    id: sampleID(18),
    name: tx("Wise Multi-currency Account", "Wise 多币种账户"),
    institution: "Wise",
    country: "GB",
    tags: [MULTI],
    account: {
      accountHolderName: "DEMO USER",
      accountNumber: null,
      accountKind: "multiCurrency",
      currencies: ["GBP", "EUR", "USD"],
      routing: [
        { scheme: "iban", value: "GB82WEST12345698765432" },
        { scheme: "sortCode", value: "23-14-70" },
      ],
    },
  },
  {
    id: sampleID(19),
    name: tx("DBS Multi-currency Account", "星展多币种账户"),
    institution: "DBS Bank",
    country: "SG",
    tags: [MULTI],
    account: {
      accountHolderName: "DEMO USER",
      accountNumber: "0123456789",
      accountKind: "multiCurrency",
      currencies: ["SGD", "USD"],
      routing: [
        { scheme: "bankCode", value: "7171" },
        { scheme: "bic", value: "DBSSSGSG" },
      ],
    },
  },
  {
    id: sampleID(20),
    name: tx("European Receiving Account", "欧洲收款账户"),
    institution: "Example Bank Europe",
    country: "DE",
    tags: [tx("Cross-border", "跨境")],
    account: {
      accountHolderName: "DEMO USER",
      accountNumber: null,
      accountKind: "checking",
      currencies: ["EUR"],
      routing: [
        { scheme: "iban", value: "DE89370400440532013000" },
        { scheme: "bic", value: "DEUTDEFF" },
      ],
    },
    template: "forest",
  },
];

function base(id: string, name: string, institution: string | null, country: string, tags: string[], now: string) {
  return {
    itemSchemaVersion: 1 as const,
    id,
    displayName: name,
    institutionName: institution,
    country: country || null,
    tags,
    notes: null as string | null,
    artworkBlobID: null,
    lifecycle: "active",
    isFavorite: false,
    manualSortPosition: null,
    createdAt: now,
    updatedAt: now,
  };
}

function cardItem(spec: CardSpec, locale: Locale, now: string, sampleTag: string): VaultItem {
  const institution = spec.institution[locale];
  const card: PaymentCardDetail = {
    cardholderName: spec.card.cardholderName ?? null,
    pan: spec.card.pan ?? null,
    expiryMonth: spec.card.expiryMonth ?? null,
    expiryYear: spec.card.expiryYear ?? null,
    network: spec.card.network,
    fundingType: spec.card.fundingType,
    formFactor: spec.card.formFactor,
    walletProvisions: spec.card.walletProvisions ?? [],
  };
  return {
    ...base(spec.id, spec.name[locale], institution, spec.country, [sampleTag, ...spec.tags.map((tag) => tag[locale])], now),
    notes: spec.notes?.[locale] ?? null,
    lifecycle: spec.lifecycle ?? "active",
    artworkTemplateID: spec.template ?? templateIDFor(institution, card.network, card.fundingType),
    kind: "paymentCard",
    paymentCard: card,
    bankAccount: null,
  };
}

function accountItem(spec: AccountSpec, locale: Locale, now: string, sampleTag: string): VaultItem {
  const { routing, ...account } = spec.account;
  return {
    ...base(spec.id, spec.name[locale], spec.institution, spec.country, [sampleTag, ...spec.tags.map((tag) => tag[locale])], now),
    // iOS matches accounts by institution only; unknown institutions fall back to graphite.
    artworkTemplateID: spec.template ?? templateIDFor(spec.institution, "other", "other"),
    kind: "bankAccount",
    paymentCard: null,
    bankAccount: {
      ...account,
      routingIdentifiers: routing.map((r) => ({ id: randomUUID().toLowerCase(), scheme: r.scheme, value: r.value, label: r.label ?? null })),
    },
  };
}

/** The welcome card alone: what a brand-new vault starts with (as on iOS). */
export function welcomeItem(locale: Locale, now = new Date().toISOString()): VaultItem {
  return cardItem(WELCOME, locale, now, SAMPLE[locale]);
}

/** Decorative preview faces (iOS WelcomeCard.previews): original templates, no issuer names. Never saved. */
export function previewItems(locale: Locale, now = new Date().toISOString()): VaultItem[] {
  const preview = (id: string, name: Text, template: string): VaultItem => ({
    ...cardItem({ ...WELCOME, id, name, institution: tx("DEMO", "DEMO"), template, notes: undefined }, locale, now, SAMPLE[locale]),
    lifecycle: "active",
  });
  return [
    preview("00000000-0000-4000-8000-000000000024", tx("Travel card · Sample", "旅行卡 · 示例"), "azure"),
    preview("00000000-0000-4000-8000-000000000025", tx("Everyday card · Sample", "日常卡 · 示例"), "carbon"),
    welcomeItem(locale, now),
  ];
}

/** The full catalogue: the welcome card, 14 cards and 6 accounts. */
export function sampleItems(locale: Locale, now = new Date().toISOString()): VaultItem[] {
  const tag = SAMPLE[locale];
  return [cardItem(WELCOME, locale, now, tag), ...CARDS.map((c) => cardItem(c, locale, now, tag)), ...ACCOUNTS.map((a) => accountItem(a, locale, now, tag))];
}

export function isSample(item: VaultItem): boolean {
  return item.tags.some((tag) => SAMPLE_TAGS.has(tag));
}

/**
 * Seeds every sample that is not currently in the vault. A sample that was
 * edited is left alone (never overwritten); one that was removed comes back,
 * which is what "Load sample data" asks for. Saves in reverse so the first
 * entries end up newest, like iOS.
 */
export async function seedSamples(store: VaultStore, items: VaultItem[], onProgress?: (done: number) => void): Promise<number> {
  const known = new Set(store.items().map((entry) => entry.itemID.toUpperCase()));
  let written = 0;
  for (const item of [...items].reverse()) {
    if (known.has(item.id.toUpperCase())) continue;
    await store.save(item, item.id, null);
    written++;
    onProgress?.(written);
  }
  return written;
}

/** Deletes (tombstones) every live item tagged as a sample, on any device. */
export async function removeSamples(store: VaultStore, live: ProjectedItem[]): Promise<number> {
  let removed = 0;
  for (const entry of live) {
    if (!isSample(entry.item)) continue;
    await store.save(null, entry.itemID, null);
    removed++;
  }
  return removed;
}
