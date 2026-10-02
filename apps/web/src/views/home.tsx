import { useMemo, useState } from "preact/hooks";
import { loadSampleData } from "../actions.js";
import firstCardURL from "../assets/otter-first-card.webp";
import { compare, markStyle, monogram, regionsOf } from "../collection.js";
import { AddMenu, MobileHeader } from "../components/shell.js";
import { CardFace, errorMessage, Icon, itemSummary, last4 } from "../components/ui.js";
import { WELCOME_ID } from "../demo.js";
import { formatTime, regionName, t, tEnum } from "../i18n.js";
import { navigate } from "../router.js";
import { revision, vault } from "../session.js";
import { region, type Section, section, selectSection, showToast } from "../state.js";
import type { ProjectedItem } from "../vault.js";

function SampleButton({ primary }: { primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await loadSampleData();
    } catch (e) {
      showToast(errorMessage(e) || t("errGeneric"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" class={`btn${primary ? " primary" : ""}`} disabled={busy} onClick={() => void run()}>
      {busy ? <span class="spinner" aria-hidden="true" /> : <Icon name="sparkle" />} {t("loadSamples")}
    </button>
  );
}

function EmptyState({ kind }: { kind: Section }) {
  if (kind === "favorites") {
    return (
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">
          <Icon name="star" />
        </div>
        <h2 class="empty-title">{t("emptyFavorites")}</h2>
        <p>{t("emptyFavoritesLead")}</p>
      </div>
    );
  }
  return (
    <div class="empty hero-empty">
      <img class="empty-art" src={firstCardURL} alt="" width={384} height={256} />
      <h2 class="empty-title">{kind === "paymentCard" ? t("emptyCards") : t("emptyAccounts")}</h2>
      <p>{t("emptyLead")}</p>
      <div class="row-actions center">
        <button type="button" class="btn primary" onClick={() => navigate({ name: "edit", itemID: null, kind })}>
          <Icon name="plus" /> {kind === "paymentCard" ? t("addCard") : t("addAccount")}
        </button>
        <SampleButton />
        <button type="button" class="btn ghost" onClick={() => navigate({ name: "settings" })}>
          <Icon name="phone" /> {t("pairIphone")}
        </button>
      </div>
    </div>
  );
}

function CardGrid({ entries }: { entries: ProjectedItem[] }) {
  return (
    <div class="grid">
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
              {entry.item.isFavorite && <span class="fav">★</span>}
              {entry.item.displayName}
              {entry.conflict && <span class="badge conflict">!</span>}
            </span>
            <span class="cap-sub">{entry.item.paymentCard ? tEnum("fundingType", entry.item.paymentCard.fundingType) : ""}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function AccountList({ entries }: { entries: ProjectedItem[] }) {
  return (
    <div class="list">
      {entries.map((entry) => {
        const account = entry.item.bankAccount;
        const suffix = last4(account?.accountNumber);
        return (
          <button key={entry.itemID} type="button" class="list-row" onClick={() => navigate({ name: "item", itemID: entry.itemID })}>
            <span class="account-mark" style={markStyle(entry)} aria-hidden="true">
              {monogram(entry)}
            </span>
            <span class="row-main">
              <span class="row-title">
                {entry.item.isFavorite && <span class="fav">★</span>}
                {entry.item.displayName}
                {entry.conflict && <span class="badge conflict">!</span>}
              </span>
              <span class="row-sub">
                {[entry.item.institutionName, account ? tEnum("accountKind", account.accountKind) : null].filter(Boolean).join(" · ")}
              </span>
            </span>
            {account && account.currencies.length > 0 && (
              <span class="currencies" aria-hidden="true">
                {account.currencies.slice(0, 3).map((c) => (
                  <span key={c} class="currency">
                    {c}
                  </span>
                ))}
              </span>
            )}
            <span class="row-trail">{suffix ? `•••• ${suffix}` : ""}</span>
            <Icon name="chevron" />
          </button>
        );
      })}
    </div>
  );
}

export function HomeView() {
  void revision.value;
  const store = vault.value;
  const current = section.value;
  const selectedRegion = region.value;
  const all = useMemo(() => store?.items() ?? [], [store, revision.value]);

  const counts = {
    paymentCard: all.filter((e) => e.item.kind === "paymentCard").length,
    bankAccount: all.filter((e) => e.item.kind === "bankAccount").length,
    favorites: all.filter((e) => e.item.isFavorite).length,
  };
  const scope = current === "favorites" ? all.filter((e) => e.item.isFavorite) : all.filter((e) => e.item.kind === current);
  const regions = regionsOf(scope);
  const visible = scope.filter((e) => !selectedRegion || e.item.country?.toUpperCase() === selectedRegion).sort(compare);
  const conflicts = all.filter((e) => e.conflict).length;
  const view = store?.view;
  const usage = view ? Math.max(view.revisionCount / view.quota.revisionCount, view.totalBytes / view.quota.totalBytes) : 0;
  const onlyWelcome = all.length === 1 && all[0]?.itemID.toUpperCase() === WELCOME_ID.toUpperCase();

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

  const title = current === "paymentCard" ? t("cards") : current === "bankAccount" ? t("accounts") : t("favorites");
  const n = visible.length;
  const countLabel =
    current === "paymentCard"
      ? n === 1
        ? t("countCard")
        : t("countCards", { n })
      : current === "bankAccount"
        ? n === 1
          ? t("countAccount")
          : t("countAccounts", { n })
        : n === 1
          ? t("countItem")
          : t("countItems", { n });

  return (
    <main class="home">
      <MobileHeader />

      <header class="page-head">
        <div class="page-head-text">
          <h1 class="page-heading">{selectedRegion ? regionName(selectedRegion) : title}</h1>
          <p class="page-sub">
            {selectedRegion ? `${title} · ${countLabel}` : countLabel}
            <span class="dot" aria-hidden="true" />
            <span class="enc">
              <Icon name="shield" /> {t("encrypted")}
            </span>
          </p>
        </div>
        <div class="head-actions desktop-only">
          <AddMenu placement="header" />
        </div>
      </header>

      <div class="mobile-only">
        <div class="tabs" role="tablist">
          {(["paymentCard", "bankAccount", "favorites"] as const).map((key) => (
            <button key={key} type="button" role="tab" class="tab" aria-selected={current === key} onClick={() => selectSection(key)}>
              {key === "paymentCard" ? t("cards") : key === "bankAccount" ? t("accounts") : t("favorites")}
              <span class="count">{counts[key]}</span>
            </button>
          ))}
        </div>
        {regions.length > 1 && (
          <div class="chips" role="toolbar" aria-label={t("regions")}>
            <button type="button" class="chip" aria-pressed={!selectedRegion} onClick={() => (region.value = null)}>
              {t("allRegions")}
            </button>
            {regions.map(({ code, count }) => (
              <button
                key={code}
                type="button"
                class="chip"
                aria-pressed={selectedRegion === code}
                onClick={() => (region.value = selectedRegion === code ? null : code)}
              >
                {regionName(code)} <span class="count">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

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

      {onlyWelcome && current !== "favorites" && (
        <div class="banner">
          <span class="banner-icon" aria-hidden="true">
            <Icon name="sparkle" />
          </span>
          <span class="banner-text">{t("samplesHint")}</span>
          <SampleButton primary />
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState kind={current} />
      ) : (
        [...groups.entries()].map(([code, entries]) => (
          <section key={code || "none"} class="group" aria-label={code ? regionName(code) : t("noRegion")}>
            {groups.size > 1 && (
              <h2 class="section-label">
                {code && (
                  <span class="region-code" aria-hidden="true">
                    {code}
                  </span>
                )}
                {code ? regionName(code) : t("noRegion")} <span class="count">{entries.length}</span>
              </h2>
            )}
            {current === "bankAccount" || (current === "favorites" && entries.every((e) => e.item.kind === "bankAccount")) ? (
              <AccountList entries={entries} />
            ) : current === "favorites" ? (
              <>
                {entries.some((e) => e.item.kind === "paymentCard") && <CardGrid entries={entries.filter((e) => e.item.kind === "paymentCard")} />}
                {entries.some((e) => e.item.kind === "bankAccount") && <AccountList entries={entries.filter((e) => e.item.kind === "bankAccount")} />}
              </>
            ) : (
              <CardGrid entries={entries} />
            )}
          </section>
        ))
      )}

      {view && <p class="footer">{t("syncedAt", { time: formatTime(view.modifiedAt) })}</p>}

      <div class="mobile-only">
        <AddMenu placement="fab" />
      </div>
    </main>
  );
}
