// SPDX-License-Identifier: Apache-2.0
import { fromUTF8, ProtocolError } from "./bytes.js";

/**
 * Strict JSON reader mirroring the iOS `StrictJSONScanner`:
 * no BOM, no duplicate keys, no fractions/exponents, bounded depth, and a
 * case-insensitive deny-list of keys that QuanCard must never store
 * (PIN, track data, ...). CVC is only admitted where the caller opts in.
 */

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };

const FORBIDDEN_KEYS = new Set(["verificationcode", "cvv", "cvc", "cid", "pin", "pinblock", "trackdata"]);

export interface StrictParseOptions {
  maximumDepth?: number;
  /** Allow the exact key `cvc` (vault payload schema 2 only). */
  allowsCVC?: boolean;
}

export interface StrictParseResult {
  value: JSONValue;
  sawCVC: boolean;
}

export function parseStrictJSON(bytes: Uint8Array, options: StrictParseOptions = {}): StrictParseResult {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new ProtocolError("invalidData");
  const text = fromUTF8(bytes);
  const parser = new Parser(text, options.maximumDepth ?? 32, options.allowsCVC ?? false);
  parser.skipWhitespace();
  const value = parser.parseValue(1);
  parser.skipWhitespace();
  if (parser.index !== text.length) throw new ProtocolError("invalidData");
  return { value, sawCVC: parser.sawCVC };
}

class Parser {
  index = 0;
  sawCVC = false;

  constructor(
    private readonly text: string,
    private readonly maximumDepth: number,
    private readonly allowsCVC: boolean,
  ) {}

  parseValue(depth: number): JSONValue {
    if (depth > this.maximumDepth) throw new ProtocolError("resourceLimitExceeded");
    const ch = this.text[this.index];
    switch (ch) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default:
        if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) return this.parseInteger();
        throw new ProtocolError("invalidData");
    }
  }

  private parseObject(depth: number): JSONObject {
    this.index++;
    this.skipWhitespace();
    const out: JSONObject = Object.create(null);
    if (this.consumeIf("}")) return out;
    for (;;) {
      if (this.text[this.index] !== '"') throw new ProtocolError("invalidData");
      const key = this.parseString();
      if (Object.hasOwn(out, key)) throw new ProtocolError("invalidData");
      if (key === "cvc") this.sawCVC = true;
      if (FORBIDDEN_KEYS.has(key.toLowerCase()) && !(this.allowsCVC && key === "cvc")) {
        throw new ProtocolError("forbiddenField");
      }
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      out[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      if (this.consumeIf("}")) return out;
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): JSONValue[] {
    this.index++;
    this.skipWhitespace();
    const out: JSONValue[] = [];
    if (this.consumeIf("]")) return out;
    for (;;) {
      out.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.consumeIf("]")) return out;
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.expect('"');
    while (this.index < this.text.length) {
      const ch = this.text.charCodeAt(this.index);
      if (ch === 0x5c) {
        const next = this.text[this.index + 1];
        if (next === undefined || !'"\\/bfnrtu'.includes(next)) throw new ProtocolError("invalidData");
        if (next === "u" && !/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index + 2, this.index + 6))) {
          throw new ProtocolError("invalidData");
        }
        this.index += next === "u" ? 6 : 2;
      } else if (ch === 0x22) {
        this.index++;
        const decoded = JSON.parse(this.text.slice(start, this.index)) as string;
        // Lone surrogates cannot round-trip through UTF-8; Swift rejects them too.
        if (!decoded.isWellFormed()) throw new ProtocolError("invalidData");
        return decoded;
      } else if (ch < 0x20) {
        throw new ProtocolError("invalidData");
      } else {
        this.index++;
      }
    }
    throw new ProtocolError("invalidData");
  }

  private parseInteger(): number {
    const start = this.index;
    this.consumeIf("-");
    if (this.consumeIf("0")) {
      if (this.isDigit()) throw new ProtocolError("invalidData");
    } else {
      const ch = this.text[this.index];
      if (ch === undefined || ch < "1" || ch > "9") throw new ProtocolError("invalidData");
      while (this.isDigit()) this.index++;
    }
    const after = this.text[this.index];
    if (after === "." || after === "e" || after === "E") throw new ProtocolError("invalidData");
    const value = Number(this.text.slice(start, this.index));
    // Counters are Int64 in Swift; JS cannot represent beyond 2^53 exactly, so refuse.
    if (!Number.isSafeInteger(value)) throw new ProtocolError("capacityExceeded");
    return value;
  }

  private isDigit(): boolean {
    const ch = this.text[this.index];
    return ch !== undefined && ch >= "0" && ch <= "9";
  }

  private literal<T extends JSONValue>(word: string, value: T): T {
    if (this.text.slice(this.index, this.index + word.length) !== word) throw new ProtocolError("invalidData");
    this.index += word.length;
    return value;
  }

  skipWhitespace(): void {
    for (;;) {
      const ch = this.text[this.index];
      if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") this.index++;
      else return;
    }
  }

  private expect(ch: string): void {
    if (this.text[this.index] !== ch) throw new ProtocolError("invalidData");
    this.index++;
  }

  private consumeIf(ch: string): boolean {
    if (this.text[this.index] !== ch) return false;
    this.index++;
    return true;
  }
}

/** Compact JSON with recursively sorted keys and unescaped `/`, like `QVaultJSON.encode`. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function asObject(value: JSONValue | undefined, keys?: readonly string[]): JSONObject {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value === undefined) {
    throw new ProtocolError("invalidData");
  }
  if (keys) {
    const actual = Object.keys(value);
    if (actual.length !== keys.length || !keys.every((k) => Object.hasOwn(value, k))) {
      throw new ProtocolError("invalidData");
    }
  }
  return value;
}

export function asArray(value: JSONValue | undefined): JSONValue[] {
  if (!Array.isArray(value)) throw new ProtocolError("invalidData");
  return value;
}

export function asString(value: JSONValue | undefined): string {
  if (typeof value !== "string") throw new ProtocolError("invalidData");
  return value;
}

export function asOptionalString(value: JSONValue | undefined): string | null {
  if (value === null) return null;
  return asString(value);
}

export function asInteger(value: JSONValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new ProtocolError("invalidData");
  return value;
}

export function asOptionalInteger(value: JSONValue | undefined): number | null {
  if (value === null) return null;
  return asInteger(value);
}

export function asBoolean(value: JSONValue | undefined): boolean {
  if (typeof value !== "boolean") throw new ProtocolError("invalidData");
  return value;
}
