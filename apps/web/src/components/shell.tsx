import { type ComponentChildren, Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import otterURL from "../assets/otter-mark.webp";
import { compare, markStyle, matches, monogram, regionsOf } from "../collection.js";
import { formatShort, regionName, t } from "../i18n.js";
import { goBack, navigate, route } from "../router.js";
import { account, lock, revision, syncNow, vault } from "../session.js";
import { paletteOpen, region, type Section, section, selectSection, toast } from "../state.js";
import type { ProjectedItem } from "../vault.js";
import { CardFace, Icon } from "./ui.js";

/* App frame: a sidebar on wide screens, a compact header on phones, a ⌘K palette everywhere. */

export function OtterMark({ size = 36 }: { size?: number }) {
  return (
    <span class="otter-mark" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <img src={otterURL} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
export const shortcutLabel = isMac ? "⌘K" : "Ctrl K";

function useItems(): ProjectedItem[] {
  void revision.value;
  const store = vault.value;
  return useMemo(() => store?.items() ?? [], [store, revision.value]);
}

export function AddMenu({ placement }: { placement: "sidebar" | "header" | "fab" }) {
  // Per instance: the header menu and the phone FAB must not share one open state.
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => (document.removeEventListener("pointerdown", close), document.removeEventListener("keydown", esc));
  }, [open]);
  const go = (kind: "paymentCard" | "bankAccount") => {
    setOpen(false);
    navigate({ name: "edit", itemID: null, kind });
  };
  return (
    <div class={`add-menu add-menu-${placement}`} ref={ref}>
      {placement === "fab" ? (
        <button type="button" class="fab" aria-label={t("add")} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
          <Icon name={open ? "close" : "plus"} />
        </button>
      ) : (
        <button
          type="button"
          class={`btn primary${placement === "sidebar" ? " block" : ""}`}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen(!open)}
        >
          <Icon name="plus" /> {t("newItem")}
        </button>
      )}
      {open && (
        <div class="popover" role="menu">
          <button type="button" role="menuitem" class="menu-item" onClick={() => go("paymentCard")}>
            <Icon name="card" /> {t("addCard")}
          </button>
          <button type="button" role="menuitem" class="menu-item" onClick={() => go("bankAccount")}>
            <Icon name="bank" /> {t("addAccount")}
          </button>
        </div>
      )}
    </div>
  );
}

function NavItem({ icon, label, count, active, onClick }: { icon: string; label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" class="nav-item" aria-current={active ? "page" : undefined} onClick={onClick}>
      <Icon name={icon} />
      <span class="nav-label">{label}</span>
      {count !== undefined && <span class="nav-count">{count}</span>}
    </button>
  );
}

export function Sidebar({ inert }: { inert?: boolean }) {
  const all = useItems();
  const store = vault.value;
  const onHome = route.value.name !== "settings" && route.value.name !== "conflicts";
  const current = section.value;
  const counts = {
    paymentCard: all.filter((e) => e.item.kind === "paymentCard").length,
    bankAccount: all.filter((e) => e.item.kind === "bankAccount").length,
    favorites: all.filter((e) => e.item.isFavorite).length,
  };
  const scope = current === "favorites" ? all.filter((e) => e.item.isFavorite) : all.filter((e) => e.item.kind === current);
  const regions = regionsOf(scope);
  const show = (next: Section) => {
    selectSection(next);
    if (!onHome) navigate({ name: "home" });
  };
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await syncNow();
    setRefreshing(false);
  };
  return (
    <aside class="sidebar" aria-label={t("appName")} inert={inert}>
      <div class="sidebar-brand">
        <OtterMark size={40} />
        <div class="sidebar-brand-text">
          <span class="wordmark">QuanCard</span>
          <span class="sidebar-host">{location.host}</span>
        </div>
      </div>

      <button type="button" class="search-trigger" onClick={() => (paletteOpen.value = true)}>
        <Icon name="search" />
        <span>{t("searchEllipsis")}</span>
        <kbd>{shortcutLabel}</kbd>
      </button>

      <nav class="nav-group" aria-label={t("library")}>
        <span class="nav-heading">{t("library")}</span>
        <NavItem icon="card" label={t("cards")} count={counts.paymentCard} active={onHome && current === "paymentCard"} onClick={() => show("paymentCard")} />
        <NavItem
          icon="bank"
          label={t("accounts")}
          count={counts.bankAccount}
          active={onHome && current === "bankAccount"}
          onClick={() => show("bankAccount")}
        />
        <NavItem icon="star" label={t("favorites")} count={counts.favorites} active={onHome && current === "favorites"} onClick={() => show("favorites")} />
      </nav>

      {onHome && regions.length > 0 && (
        <nav class="nav-group" aria-label={t("regions")}>
          <span class="nav-heading">{t("regions")}</span>
          {regions.map(({ code, count }) => (
            <button
              key={code}
              type="button"
              class="nav-item"
              aria-pressed={region.value === code}
              onClick={() => (region.value = region.value === code ? null : code)}
            >
              <span class="region-code" aria-hidden="true">
                {code}
              </span>
              <span class="nav-label">{regionName(code)}</span>
              <span class="nav-count">{count}</span>
            </button>
          ))}
        </nav>
      )}

      <div class="sidebar-foot">
        <NavItem icon="settings" label={t("settings")} active={route.value.name === "settings"} onClick={() => navigate({ name: "settings" })} />
        <div class="account-chip">
          <span class="avatar" aria-hidden="true">
            {Array.from(account.value?.username ?? "?")[0]?.toUpperCase()}
          </span>
          <span class="account-text">
            <span class="account-name">{account.value?.username}</span>
            <span class="account-sync">{store ? t("syncedAt", { time: formatShort(store.view.modifiedAt) }) : ""}</span>
          </span>
          <button type="button" class="icon-btn small" aria-label={t("refresh")} onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <span class="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
          </button>
          <button type="button" class="icon-btn small" aria-label={t("lock")} onClick={lock}>
            <Icon name="lock" />
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Phone header: brand, search, settings, lock. Navigation lives in the tabs below. */
export function MobileHeader({ title }: { title?: string }) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await syncNow();
    setRefreshing(false);
  };
  return (
    <header class="topbar mobile-only">
      <OtterMark size={34} />
      <h1 class="title">{title ?? "QuanCard"}</h1>
      <button type="button" class="icon-btn" aria-label={t("search")} onClick={() => (paletteOpen.value = true)}>
        <Icon name="search" />
      </button>
      <button type="button" class="icon-btn" aria-label={t("refresh")} onClick={() => void refresh()} disabled={refreshing}>
        {refreshing ? <span class="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
      </button>
      <button type="button" class="icon-btn" aria-label={t("settings")} onClick={() => navigate({ name: "settings" })}>
        <Icon name="settings" />
      </button>
      <button type="button" class="icon-btn" aria-label={t("lock")} onClick={lock}>
        <Icon name="lock" />
      </button>
    </header>
  );
}

type PaletteEntry = { key: string; label: string; sub?: string; run: () => void; entry?: ProjectedItem; icon?: string };

export function CommandPalette() {
  const open = paletteOpen.value;
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const all = useItems();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) setQuery("");
  }, [open]);

  const close = () => (paletteOpen.value = false);
  const items: PaletteEntry[] = (query ? all.filter((e) => matches(e, query)) : all.filter((e) => e.item.isFavorite))
    .sort(compare)
    .slice(0, 8)
    .map((entry) => ({
      key: entry.itemID,
      label: entry.item.displayName,
      sub: [entry.item.institutionName, regionName(entry.item.country)].filter(Boolean).join(" · "),
      entry,
      run: () => navigate({ name: "item", itemID: entry.itemID }),
    }));
  const actions: PaletteEntry[] = [
    { key: "add-card", icon: "card", label: t("addCard"), run: () => navigate({ name: "edit", itemID: null, kind: "paymentCard" }) },
    { key: "add-account", icon: "bank", label: t("addAccount"), run: () => navigate({ name: "edit", itemID: null, kind: "bankAccount" }) },
    { key: "cards", icon: "card", label: t("cards"), run: () => (selectSection("paymentCard"), navigate({ name: "home" })) },
    { key: "accounts", icon: "bank", label: t("accounts"), run: () => (selectSection("bankAccount"), navigate({ name: "home" })) },
    ...(all.some((e) => e.conflict) ? [{ key: "conflicts", icon: "refresh", label: t("conflictsTitle"), run: () => navigate({ name: "conflicts" }) }] : []),
    { key: "settings", icon: "settings", label: t("settings"), run: () => navigate({ name: "settings" }) },
    { key: "pair", icon: "phone", label: t("pairIphone"), run: () => navigate({ name: "settings" }) },
    { key: "lock", icon: "lock", label: t("lock"), run: lock },
  ].filter((a) => !query || a.label.toLowerCase().includes(query.toLowerCase()));
  const entries = [...items, ...actions];
  const clamped = Math.min(active, Math.max(0, entries.length - 1));

  const choose = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    close();
    // Navigation must not ride on the dialog's own history entry; run after it closes.
    queueMicrotask(entry.run);
  };
  const onKey = (event: KeyboardEvent) => {
    // A search field would swallow Esc to clear itself; the palette closes instead.
    if (event.key === "Escape") event.preventDefault(), close();
    else if (event.key === "ArrowDown") event.preventDefault(), setActive((clamped + 1) % Math.max(1, entries.length));
    else if (event.key === "ArrowUp") event.preventDefault(), setActive((clamped - 1 + entries.length) % Math.max(1, entries.length));
    else if (event.key === "Enter") event.preventDefault(), choose(entries[clamped]);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop is a mouse convenience; Esc closes for keyboards
    <dialog
      ref={ref}
      class="palette"
      aria-label={t("search")}
      onClose={close}
      onCancel={(e) => (e.preventDefault(), close())}
      onClick={(e) => e.target === ref.current && close()}
    >
      {open && (
        <div class="palette-body">
          <div class="palette-input">
            <Icon name="search" />
            <input
              type="search"
              aria-label={t("search")}
              placeholder={t("searchPlaceholder")}
              value={query}
              onInput={(e) => (setQuery(e.currentTarget.value), setActive(0))}
              onKeyDown={onKey}
              autoFocus
              aria-controls="palette-list"
              aria-activedescendant={entries[clamped] ? `pal-${entries[clamped].key}` : undefined}
            />
            <kbd>Esc</kbd>
          </div>
          <div class="palette-list" id="palette-list" role="listbox" aria-label={t("search")}>
            {items.length > 0 && <div class="palette-heading">{query ? t("paletteItems") : t("favorites")}</div>}
            {entries.map((entry, index) => (
              <Fragment key={entry.key}>
                {index === items.length && actions.length > 0 && <div class="palette-heading">{t("paletteActions")}</div>}
                <div
                  id={`pal-${entry.key}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === clamped}
                  class="palette-row"
                  onPointerMove={() => index !== clamped && setActive(index)}
                  onClick={() => choose(entry)}
                  onKeyDown={onKey}
                >
                  {entry.entry ? (
                    entry.entry.item.kind === "paymentCard" ? (
                      <span class="palette-thumb">
                        <CardFace item={entry.entry.item} artwork={entry.entry.artwork} showSuffix={false} />
                      </span>
                    ) : (
                      <span class="account-mark small" style={markStyle(entry.entry)} aria-hidden="true">
                        {monogram(entry.entry)}
                      </span>
                    )
                  ) : (
                    <span class="palette-icon">
                      <Icon name={entry.icon ?? "chevron"} />
                    </span>
                  )}
                  <span class="palette-text">
                    <span class="palette-label">{entry.label}</span>
                    {entry.sub && <span class="palette-sub">{entry.sub}</span>}
                  </span>
                  {index === clamped && <Icon name="chevron" />}
                </div>
              </Fragment>
            ))}
            {entries.length === 0 && <p class="palette-empty">{t("paletteEmpty")}</p>}
          </div>
          <div class="palette-foot">{t("paletteHint")}</div>
        </div>
      )}
    </dialog>
  );
}

export function Toast() {
  const current = toast.value;
  return (
    <div class="toast-region" role="status" aria-live="polite">
      {current && (
        <div class="toast" key={current.id}>
          <Icon name="shield" />
          {current.text}
        </div>
      )}
    </div>
  );
}

/** Detail and editor: a side sheet over the collection on wide screens, a full page on phones. */
export function Sheet({ label, children }: { label: string; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    document.documentElement.classList.add("sheet-open");
    const onKey = (event: KeyboardEvent) => {
      // Nested dialogs (password, delete) handle their own Esc.
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) goBack();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("sheet-open");
      previous?.focus?.();
    };
  }, []);
  return (
    <div class="sheet-layer">
      <div class="sheet-scrim" aria-hidden="true" onClick={goBack} />
      <div class="sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        {children}
      </div>
    </div>
  );
}

/** Global shortcuts: ⌘K / Ctrl+K and "/" open the palette. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        paletteOpen.value = !paletteOpen.value;
      } else if (event.key === "/" && !typing && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        paletteOpen.value = true;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** `overlay` (a Sheet) renders above the frame; everything behind it becomes inert. */
export function AppShell({ children, overlay }: { children: ComponentChildren; overlay?: ComponentChildren }) {
  useShortcuts();
  const covered = !!overlay;
  return (
    <div class="app">
      <Sidebar inert={covered} />
      <div class="app-main" inert={covered}>
        {children}
      </div>
      {overlay}
      <CommandPalette />
      <Toast />
    </div>
  );
}
