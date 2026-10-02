import { describe, expect, it } from "vitest";
import { MESSAGES } from "../src/i18n.js";

describe("i18n", () => {
  it("translates every English key into Simplified Chinese", () => {
    // Card networks and routing schemes are proper nouns or acronyms (Visa, IBAN): English on purpose.
    const missing = Object.keys(MESSAGES.en).filter((key) => !(key in MESSAGES.zh) && !/^(network|routingScheme)\./.test(key));
    expect(missing).toEqual([]);
  });

  it("keeps every {placeholder} in both languages", () => {
    for (const [key, text] of Object.entries(MESSAGES.en)) {
      const zh = (MESSAGES.zh as Record<string, string | undefined>)[key];
      if (!zh) continue;
      const vars = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(zh), key).toEqual(vars(text));
    }
  });
});
