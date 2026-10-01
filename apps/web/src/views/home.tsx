import { useMemo, useState } from "preact/hooks";
import { CardFace, Icon, itemSummary, last4 } from "../components/ui.js";
import { regionName, t, tEnum } from "../i18n.js";
import { navigate } from "../router.js";
import { lock, revision, vault } from "../session.js";
import type { ProjectedItem } from "../vault.js";

type Tab = "paymentCard" | "bankAccount";

let rememberedTab: Tab = "paymentCard";

function matches(entry: ProjectedItem, query: string): boolean {
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
function compare(a: ProjectedItem, b: ProjectedItem): number {
  const pa = a.item.manualSortPosition;
  const pb = b.item.manualSortPosition;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  return a.item.displayName.localeCompare(b.item.displayName);
}

export function HomeView() {
  void revision.value;
  const store = vault.value;
  const [tab, setTab] = useState<Tab>(rememberedTab);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [region, setRegion] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [menu, setMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const all = useMemo(() => store?.items() ?? [], [store, revision.value]);
  const counts = {
    paymentCard: all.filter((e) => e.item.kind === "paymentCard").length,
    bankAccount: all.filter((e) => e.item.kind === "bankAccount").length,
  };
  const inTab = all.filter((e) => e.item.kind === tab);
  const regions = [...new Set(inTab.map((e) => e.item.country?.toUpperCase()).filter((c): c is string => !!c))].sort();
  const visible = inTab
    .filter((e) => !region || e.item.country?.toUpperCase() === region)
    .filter((e) => !favoritesOnly || e.item.isFavorite)
    .filter((e) => matches(e, query))
    .sort(compare);
  const conflicts = all.filter((e) => e.conflict).length;
  const view = store?.view;
  const usage = view ? Math.max(view.revisionCount / view.quota.revisionCount, view.totalBytes / view.quota.totalBytes) : 0;

  // Region groups in a stable, localized alphabetical order; items without a region last.
  const groups = new Map<string, ProjectedItem[]>();
  const keys = [...new Set(visible.map((e) => e.item.country?.toUpperCase() ?? ""))].sort((a, b) =>
    a === "" ? 1 : b === "" ? -1 : regionName(a).localeCompare(regionName(b)),
  );
  for (const key of keys)
    groups.set(
      key,
      visible.filter((e) => (e.item.country?.toUpperCase() ?? "") === key),
    );

  const selectTab = (next: Tab) => {
    rememberedTab = next;
    setTab(next);
    setRegion(null);
  };

  const refresh = async () => {
    if (!store) return;
    setRefreshing(true);
    try {
      await store.refresh();
      revision.value++;
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <main class="page">
      <header class="topbar">
        {searching ? (
          <>
            <div class="search">
              <Icon name="search" />
              <input
                type="search"
                aria-label={t("search")}
                placeholder={t("searchPlaceholder")}
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
                // biome-ignore lint/a11y/noAutofocus: opened explicitly by the search button
                autoFocus
              />
              {query && (
                <button type="button" class="icon-btn" aria-label={t("clear")} onClick={() => setQuery("")}>
                  <Icon name="close" />
                </button>
              )}
            </div>
            <button type="button" class="btn small" onClick={() => (setSearching(false), setQuery(""))}>
              {t("closeSearch")}
            </button>
          </>
        ) : (
          <>
            <h1 class="title">{t("appName")}</h1>
            <button type="button" class="icon-btn" aria-label={t("search")} onClick={() => setSearching(true)}>
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
          </>
        )}
      </header>

      <div class="tabs" role="tablist">
        {(["paymentCard", "bankAccount"] as const).map((key) => (
          <button key={key} type="button" role="tab" class="tab" aria-selected={tab === key} onClick={() => selectTab(key)}>
            {key === "paymentCard" ? t("cards") : t("accounts")}
            <span class="count">{counts[key]}</span>
          </button>
        ))}
      </div>

      {(regions.length > 0 || inTab.some((e) => e.item.isFavorite)) && (
        <div class="chips" role="toolbar" aria-label={t("region")}>
          <button type="button" class="chip" aria-pressed={!region && !favoritesOnly} onClick={() => (setRegion(null), setFavoritesOnly(false))}>
            {t("allRegions")}
          </button>
          {inTab.some((e) => e.item.isFavorite) && (
            <button type="button" class="chip" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>
              ★ {t("favorites")}
            </button>
          )}
          {regions.map((code) => (
            <button key={code} type="button" class="chip" aria-pressed={region === code} onClick={() => setRegion(region === code ? null : code)}>
              {regionName(code)}
            </button>
          ))}
        </div>
      )}

      {conflicts > 0 && (
        <div class="notice warn" role="status">
          {t("conflicts", { n: conflicts })}
          <button
            type="button"
            class="link-btn notice-action"
            onClick={() => {
              const first = all.find((e) => e.conflict);
              if (first) navigate({ name: "item", itemID: first.itemID });
            }}
          >
            {t("review")}
          </button>
        </div>
      )}
      {(store?.pendingItems ?? 0) > 0 && <div class="notice">{t("pendingItems", { n: store?.pendingItems ?? 0 })}</div>}
      {(store?.unreadable ?? 0) > 0 && <div class="notice warn">{t("unreadable", { n: store?.unreadable ?? 0 })}</div>}
      {usage >= 0.8 && <div class="notice warn">{t("capacityWarning", { pct: Math.round(usage * 100) })}</div>}

      {visible.length === 0 ? (
        <div class="empty">
          <div class="empty-title">{query || region || favoritesOnly ? t("noResults") : tab === "paymentCard" ? t("emptyCards") : t("emptyAccounts")}</div>
          {!query && !region && <p>{t("emptyLead")}</p>}
        </div>
      ) : (
        [...groups.entries()].map(([code, entries]) => (
          <section key={code || "none"} aria-label={code ? regionName(code) : t("allRegions")}>
            {groups.size > 1 && (
              <h2 class="section-label">
                {code ? regionName(code) : "—"} <span class="count">{entries.length}</span>
              </h2>
            )}
            {tab === "paymentCard" ? (
              <div class="grid" style={groups.size > 1 ? undefined : { marginTop: "12px" }}>
                {entries.map((entry) => (
                  <button
                    key={entry.itemID}
                    type="button"
                    class="card-tile"
                    aria-label={itemSummary(entry.item)}
                    onClick={() => navigate({ name: "item", itemID: entry.itemID })}
                  >
                    <CardFace item={entry.item} artwork={entry.artwork} />
                    <div class="card-caption" aria-hidden="true">
                      <span class="cap-title">
                        {entry.item.isFavorite ? "★ " : ""}
                        {entry.item.displayName}
                        {entry.conflict && <span class="badge conflict">!</span>}
                      </span>
                      <span class="cap-sub">{entry.item.paymentCard ? tEnum("fundingType", entry.item.paymentCard.fundingType) : ""}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div class="list">
                {entries.map((entry) => {
                  const account = entry.item.bankAccount;
                  const suffix = last4(account?.accountNumber);
                  return (
                    <button key={entry.itemID} type="button" class="list-row" onClick={() => navigate({ name: "item", itemID: entry.itemID })}>
                      <span class="account-mark" aria-hidden="true">
                        {(entry.item.institutionName ?? entry.item.displayName).slice(0, 1).toUpperCase()}
                      </span>
                      <span class="row-main">
                        <span class="row-title">
                          {entry.item.isFavorite ? "★ " : ""}
                          {entry.item.displayName}
                          {entry.conflict && <span class="badge conflict">!</span>}
                        </span>
                        <br />
                        <span class="row-sub">
                          {[entry.item.institutionName, account ? tEnum("accountKind", account.accountKind) : null, account?.currencies.join(" · ")]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span class="row-trail">{suffix ? `•••• ${suffix}` : ""}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        ))
      )}

      {view && <p class="footer">{t("syncedAt", { time: new Date(view.modifiedAt * 1000).toLocaleString() })}</p>}

      {menu && (
        <div class="menu">
          <button type="button" class="btn" onClick={() => (setMenu(false), navigate({ name: "edit", itemID: null, kind: "paymentCard" }))}>
            {t("addCard")}
          </button>
          <button type="button" class="btn" onClick={() => (setMenu(false), navigate({ name: "edit", itemID: null, kind: "bankAccount" }))}>
            {t("addAccount")}
          </button>
        </div>
      )}
      <button type="button" class="fab" aria-label={t("add")} aria-expanded={menu} onClick={() => setMenu(!menu)}>
        <Icon name={menu ? "close" : "plus"} />
      </button>
    </main>
  );
}
