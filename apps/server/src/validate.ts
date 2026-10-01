import { base64, parseUpperUUID } from "@quancard/protocol";
import { ApiError } from "./http-guard.js";

/** Tiny explicit validators: every request field is checked, unknown fields are rejected. */

export function body(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "badRequest");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ApiError(400, "badRequest");
  return value as Record<string, unknown>;
}

export function bytesField(value: unknown, exact?: number, max = 4096): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 + 4) throw new ApiError(400, "badRequest");
  try {
    return base64.decode(value, exact);
  } catch {
    throw new ApiError(400, "badRequest");
  }
}

export function uuidField(value: unknown): string {
  try {
    return parseUpperUUID(value);
  } catch {
    throw new ApiError(400, "badRequest");
  }
}

export function username(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "badRequest");
  const name = value.normalize("NFC").trim();
  if (!/^[\p{L}\p{N}._@+-]{3,64}$/u.test(name)) throw new ApiError(400, "invalidUsername");
  return name;
}

export function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new ApiError(400, "badRequest");
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text.length ? text : null;
}

export function textField(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new ApiError(400, "badRequest");
  return value;
}
