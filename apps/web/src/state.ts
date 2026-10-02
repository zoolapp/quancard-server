import { signal } from "@preact/signals";

/** View state shared by the sidebar, the home grid and the command palette. Never secret. */

export type Section = "paymentCard" | "bankAccount" | "favorites";

export const section = signal<Section>("paymentCard");
export const region = signal<string | null>(null);
export const paletteOpen = signal(false);
export const addMenuOpen = signal(false);

export function selectSection(next: Section): void {
  section.value = next;
  region.value = null;
}

/** Transient confirmation line ("Copied", "Sample data added"). */
export const toast = signal<{ id: number; text: string } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(text: string): void {
  clearTimeout(toastTimer);
  toast.value = { id: Date.now(), text };
  toastTimer = setTimeout(() => (toast.value = null), 3200);
}
