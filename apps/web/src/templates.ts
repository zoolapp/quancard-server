import catalog from "./issuers.json";

export type Decor = "none" | "sheen" | "orbit" | "dots" | "wave";

export interface CardTemplate {
  id: string;
  fill: string;
  accent: string;
  decor: Decor;
}

// iOS CardTemplates: colors[0] and accent, rounded from 0–1 channels to 0–255.
export const BUILTIN_TEMPLATES: readonly CardTemplate[] = [
  { id: "graphite", fill: "rgb(41,43,51)", accent: "rgb(255,255,255)", decor: "none" },
  { id: "azure", fill: "rgb(20,51,115)", accent: "rgb(242,209,115)", decor: "sheen" },
  { id: "ember", fill: "rgb(41,33,36)", accent: "rgb(255,158,77)", decor: "orbit" },
  { id: "nebula", fill: "rgb(51,23,97)", accent: "rgb(115,230,242)", decor: "dots" },
  { id: "carbon", fill: "rgb(23,28,31)", accent: "rgb(89,242,166)", decor: "wave" },
  { id: "vermilion", fill: "rgb(140,31,26)", accent: "rgb(255,217,153)", decor: "wave" },
  { id: "ocean", fill: "rgb(13,82,140)", accent: "rgb(166,217,255)", decor: "none" },
  { id: "sunset", fill: "rgb(217,89,64)", accent: "rgb(255,217,179)", decor: "none" },
  { id: "forest", fill: "rgb(26,97,71)", accent: "rgb(191,242,204)", decor: "none" },
  { id: "plum", fill: "rgb(97,41,128)", accent: "rgb(230,204,255)", decor: "none" },
  { id: "gold", fill: "rgb(140,107,46)", accent: "rgb(255,242,204)", decor: "none" },
  { id: "silver", fill: "rgb(92,97,110)", accent: "rgb(255,255,255)", decor: "none" },
  { id: "sakura", fill: "rgb(168,71,112)", accent: "rgb(255,230,242)", decor: "none" },
];

export const ISSUERS = catalog.issuers;
export const WELCOME_TEMPLATE_ID = "quancard-welcome";

export function templateFor(id: string): CardTemplate {
  const builtin = BUILTIN_TEMPLATES.find((template) => template.id === id);
  if (builtin) return builtin;
  const issuer = ISSUERS.find((palette) => palette.id === id);
  if (issuer) {
    const decor = issuer.decor;
    return {
      id: issuer.id,
      fill: issuer.colors[0] ?? "#000000",
      accent: issuer.accent,
      decor: decor === "sheen" || decor === "orbit" || decor === "dots" || decor === "wave" ? decor : "none",
    };
  }
  return BUILTIN_TEMPLATES[0]!;
}

export function matchIssuer(institutionName: string | null | undefined): (typeof ISSUERS)[number] | undefined {
  if (!institutionName) return undefined;
  const normalized = institutionName.toLowerCase().trim();
  const compact = normalized.replaceAll(" ", "");
  let best: (typeof ISSUERS)[number] | undefined;
  let bestLength = 0;
  for (const issuer of ISSUERS) {
    for (const alias of issuer.aliases) {
      const value = alias.toLowerCase().trim();
      if (!value) continue;
      if ((normalized.includes(value) || compact.includes(value.replaceAll(" ", ""))) && value.length > bestLength) {
        best = issuer;
        bestLength = value.length;
      }
    }
  }
  return best;
}

export function templateIDFor(institutionName: string | null | undefined, network: string, fundingType: string): string {
  const issuer = matchIssuer(institutionName);
  if (issuer) return issuer.id;
  if (fundingType === "cryptoLinked") return network === "mastercard" ? "carbon" : "nebula";
  switch (network) {
    case "visa":
      return "azure";
    case "mastercard":
      return "ember";
    case "amex":
      return "silver";
    case "unionPay":
      return "vermilion";
    case "jcb":
      return "sakura";
    case "discover":
    case "dinersClub":
      return "gold";
    case "rupay":
      return "forest";
    case "mir":
      return "plum";
    default:
      return "graphite";
  }
}

export function templateIDForAccount(accountKind: string): string {
  switch (accountKind) {
    case "savings":
      return "forest";
    case "multiCurrency":
      return "plum";
    default:
      return "ocean";
  }
}
