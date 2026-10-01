import { signal } from "@preact/signals";

/** In-memory routes. URLs stay at "/" so item identifiers never land in browser history. */
export type Route =
  | { name: "home" }
  | { name: "item"; itemID: string }
  | { name: "edit"; itemID: string | null; kind: "paymentCard" | "bankAccount" }
  | { name: "settings" };

export const route = signal<Route>({ name: "home" });

const stack: Route[] = [];

export function navigate(next: Route): void {
  stack.push(route.value);
  route.value = next;
  history.pushState({ depth: stack.length }, "", "/");
  window.scrollTo(0, 0);
}

export function goBack(): void {
  if (stack.length) history.back();
  else route.value = { name: "home" };
}

export function resetRoute(): void {
  stack.length = 0;
  route.value = { name: "home" };
}

window.addEventListener("popstate", () => {
  route.value = stack.pop() ?? { name: "home" };
});
