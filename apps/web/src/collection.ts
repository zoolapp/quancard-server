import { regionName } from "./i18n.js";
import { templateFor } from "./templates.js";
import type { ProjectedItem } from "./vault.js";

/** Pure helpers for listing and searching decrypted items (in memory only). */

export function matches(entry: ProjectedItem, query: string): boolean {
  if (!query) return true;
  const item = entry.item;
  const haystack = [item.displayName, item.institutionName, item.country, regionName(item.country), item.notes, ...item.tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((part) => haystack.includes(part));
}

/** Manual order first (shared with iOS), then name. Time never reorders silently. */
export function compare(a: ProjectedItem, b: ProjectedItem): number {
  const pa = a.item.manualSortPosition;
  const pb = b.item.manualSortPosition;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  return a.item.displayName.localeCompare(b.item.displayName);
}

/** Region codes with counts, in localized alphabetical order. */
export function regionsOf(entries: ProjectedItem[]): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const code = entry.item.country?.toUpperCase();
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => regionName(a.code).localeCompare(regionName(b.code)));
}

/** Monogram tile colors for accounts: the item's own template fill, so accounts carry the same identity as cards. */
export function markStyle(entry: ProjectedItem): Record<string, string> {
  const template = templateFor(entry.item.artworkTemplateID);
  return { "--fill": template.fill, "--accent": template.accent };
}

export function monogram(entry: ProjectedItem): string {
  return Array.from((entry.item.institutionName ?? entry.item.displayName).trim())[0]?.toUpperCase() ?? "·";
}
