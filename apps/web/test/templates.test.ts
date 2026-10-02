import { describe, expect, it } from "vitest";
import catalog from "../src/issuers.json";
import { BUILTIN_TEMPLATES, ISSUERS, matchIssuer, templateFor, templateIDFor, templateIDForAccount, WELCOME_TEMPLATE_ID } from "../src/templates.js";

// Ported from QuanCardTests/BrandAssetTests.swift, IssuerCoverageTests.
const coverageCases = [
  ["中国工商银行", "issuer.icbc"],
  ["ICBC (Asia)", "issuer.icbc"],
  ["中国建设银行", "issuer.ccb"],
  ["中国银行", "issuer.boc"],
  ["中国农业银行", "issuer.abc"],
  ["招商银行", "issuer.cmb"],
  ["交通银行", "issuer.comm"],
  ["Bank of Communications", "issuer.comm"],
  ["浦发银行", "issuer.spdb"],
  ["上海浦东发展银行", "issuer.spdb"],
  ["中国民生银行", "issuer.cmbc"],
  ["中国邮政储蓄银行", "issuer.psbc"],
  ["中信银行", "issuer.citic"],
  ["兴业银行", "issuer.cib"],
  ["中国光大银行", "issuer.ceb"],
  ["华夏银行", "issuer.huaxia"],
  ["广发银行", "issuer.cgb"],
  ["平安银行", "issuer.pingan"],
  ["微众银行", "issuer.webank"],
  ["网商银行", "issuer.mybank"],
  ["北京银行", "issuer.bob"],
  ["上海银行", "issuer.bosc"],
  ["宁波银行", "issuer.nbcb"],
  ["中银香港", "issuer.bochk"],
  ["Bank of China (Hong Kong)", "issuer.bochk"],
  ["Chase", "issuer.chase"],
  ["JPMorgan Chase", "issuer.chase"],
  ["Bank of America", "issuer.bofa"],
  ["Wells Fargo", "issuer.wellsfargo"],
  ["Citibank", "issuer.citi"],
  ["Citizens Bank", "issuer.citizens"],
  ["U.S. Bank", "issuer.usbank"],
  ["US Bank", "issuer.usbank"],
  ["Capital One", "issuer.capitalone"],
  ["PNC Bank", "issuer.pnc"],
  ["Truist", "issuer.truist"],
  ["TD Bank", "issuer.tdbank"],
  ["Marcus by Goldman Sachs", "issuer.marcus"],
  ["Ally Bank", "issuer.ally"],
  ["Charles Schwab Bank", "issuer.schwab"],
  ["Chime", "issuer.chime"],
  ["SoFi", "issuer.sofi"],
  ["Fifth Third Bank", "issuer.fifththird"],
  ["Discover Bank", "issuer.discoverbank"],
  ["American Express", "issuer.amex"],
  ["DBS Bank", "issuer.dbs"],
  ["POSB", "issuer.dbs"],
  ["星展银行", "issuer.dbs"],
  ["OCBC", "issuer.ocbc"],
  ["华侨银行", "issuer.ocbc"],
  ["UOB", "issuer.uob"],
  ["United Overseas Bank", "issuer.uob"],
  ["Standard Chartered Singapore", "issuer.sc"],
  ["Maybank Singapore", "issuer.maybank"],
  ["Trust Bank", "issuer.trustbank"],
  ["GXS Bank", "issuer.gxs"],
  ["MariBank", "issuer.maribank"],
  ["HSBC Singapore", "issuer.hsbc"],
  ["Citibank Singapore", "issuer.citi"],
  ["Citizens", "issuer.citizens"],
  ["CITIC", "issuer.citic"],
  ["BOCOM", "issuer.comm"],
  ["BOCHK", "issuer.bochk"],
  ["Industrial and Commercial Bank of China", "issuer.icbc"],
  ["Industrial Bank", "issuer.cib"],
] as const;

describe("issuer matching", () => {
  it.each(coverageCases)("matches iOS coverage: %s", (name, id) => {
    expect(matchIssuer(name)?.id).toBe(id);
    expect(templateIDFor(name, "visa", "credit")).toBe(id);
  });

  it.each(["HSBC", "汇丰", "滙豐", "  HsBc\n", "H S B C", "My HSBC card"])("matches HSBC: %s", (name) => {
    expect(templateIDFor(name, "mastercard", "cryptoLinked")).toBe("issuer.hsbc");
  });

  it.each(ISSUERS.flatMap((issuer) => issuer.aliases.map((alias) => [alias, issuer.id] as const)))("matches catalog alias: %s", (alias, id) => {
    expect(matchIssuer(alias)?.id).toBe(id);
  });

  it("keeps catalog order for equally long matching aliases", () => {
    expect(matchIssuer("CITI HSBC")?.id).toBe("issuer.hsbc");
    expect(matchIssuer("HSBC CITI")?.id).toBe("issuer.hsbc");
  });

  it.each([null, undefined, "", " \n\t", "Unknown Institution"])("ignores empty or unknown names: %s", (name) => {
    expect(matchIssuer(name)).toBeUndefined();
    expect(templateIDFor(name, "visa", "credit")).toBe("azure");
  });

  it("matches with literal spaces removed, without removing interior tabs", () => {
    expect(matchIssuer("BankofChina(HongKong)")?.id).toBe("issuer.bochk");
    expect(matchIssuer("H\tSBC")).toBeUndefined();
  });

  it("preserves catalog version, complete issuer count and unique aliases", () => {
    expect(catalog.version).toBe("2026.10.01");
    expect(ISSUERS).toHaveLength(71);
    expect(new Set(ISSUERS.map((issuer) => issuer.id)).size).toBe(71);
    const aliases = ISSUERS.flatMap((issuer) => issuer.aliases.map((alias) => alias.toLowerCase().trim()));
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});

describe("template fallbacks", () => {
  it.each([
    ["visa", "azure"],
    ["mastercard", "ember"],
    ["amex", "silver"],
    ["unionPay", "vermilion"],
    ["jcb", "sakura"],
    ["discover", "gold"],
    ["dinersClub", "gold"],
    ["rupay", "forest"],
    ["mir", "plum"],
    ["other", "graphite"],
    ["future-network", "graphite"],
    ["constructor", "graphite"],
  ])("falls back for unknown institutions on %s", (network, id) => {
    expect(templateIDFor("Unknown Institution", network!, "credit")).toBe(id);
  });

  it.each([
    ["mastercard", "carbon"],
    ["visa", "nebula"],
    ["other", "nebula"],
  ])("prefers crypto funding for %s", (network, id) => {
    expect(templateIDFor(null, network!, "cryptoLinked")).toBe(id);
  });

  it.each([
    ["savings", "forest"],
    ["multiCurrency", "plum"],
    ["checking", "ocean"],
    ["other", "ocean"],
    ["future", "ocean"],
  ])("matches account kind %s", (kind, id) => {
    expect(templateIDForAccount(kind!)).toBe(id);
  });

  it("resolves builtin, issuer and fallback fills", () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(13);
    expect(templateFor("azure")).toEqual({ id: "azure", fill: "rgb(20,51,115)", accent: "rgb(242,209,115)", decor: "sheen" });
    expect(templateFor("issuer.hsbc")).toEqual({ id: "issuer.hsbc", fill: "#8F0A14", accent: "#FFFFFF", decor: "sheen" });
    expect(templateFor("unknown").id).toBe("graphite");
    expect(templateFor("constructor").id).toBe("graphite");
    expect(WELCOME_TEMPLATE_ID).toBe("quancard-welcome");
    expect(templateFor(WELCOME_TEMPLATE_ID).id).toBe("graphite");
  });

  it.each(ISSUERS)("uses the first fill, accent and decor for $id", (issuer) => {
    expect(templateFor(issuer.id)).toEqual({ id: issuer.id, fill: issuer.colors[0], accent: issuer.accent, decor: issuer.decor });
  });

  it("keeps the iOS builtin decoration assignments", () => {
    expect(BUILTIN_TEMPLATES.map(({ id, decor }) => [id, decor])).toEqual([
      ["graphite", "none"],
      ["azure", "sheen"],
      ["ember", "orbit"],
      ["nebula", "dots"],
      ["carbon", "wave"],
      ["vermilion", "wave"],
      ["ocean", "none"],
      ["sunset", "none"],
      ["forest", "none"],
      ["plum", "none"],
      ["gold", "none"],
      ["silver", "none"],
      ["sakura", "none"],
    ]);
  });
});
