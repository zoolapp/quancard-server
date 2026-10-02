import type { SyncParent, VaultItem } from "@quancard/protocol";
import { useMemo, useState } from "preact/hooks";
import { Dialog, errorMessage, Icon } from "../components/ui.js";
import { isSample } from "../demo.js";
import { formatTime, locale, type MessageKey, regionName, t, tEnum } from "../i18n.js";
import { goBack, navigate } from "../router.js";
import { revision, vault } from "../session.js";
import { showToast } from "../state.js";
import type { ItemVersion, ProjectedItem, VaultStore } from "../vault.js";

/**
 * Conflict centre: every item with diverging versions on one page, with a
 * field-level comparison and bulk actions. Nothing is chosen automatically;
 * each bulk action is previewed and confirmed. Every resolution pins its
 * parents to the versions shown here, so a version that arrives meanwhile
 * stays a conflict instead of being absorbed (sync-v1 §3.1).
 */

type Field = { key: MessageKey; value: (item: VaultItem) => string; secret?: boolean };

const last4 = (value: string | null | undefined) => (value ? `•••• ${value.replace(/\s/g, "").slice(-4)}` : "—");

const FIELDS: Field[] = [
  { key: "name", value: (i) => i.displayName },
  { key: "institution", value: (i) => i.institutionName ?? "—" },
  { key: "region", value: (i) => (i.country ? regionName(i.country) : "—") },
  { key: "tags", value: (i) => i.tags.join(", ") || "—" },
  { key: "notes", value: (i) => i.notes ?? "—" },
  { key: "status", value: (i) => tEnum("lifecycle", i.lifecycle) },
  { key: "favorites", value: (i) => (i.isFavorite ? "★" : "—") },
  { key: "template", value: (i) => i.artworkTemplateID },
  { key: "cardNumber", value: (i) => last4(i.paymentCard?.pan) },
  { key: "expiry", value: (i) => (i.paymentCard?.expiryMonth ? `${i.paymentCard.expiryMonth}/${i.paymentCard.expiryYear}` : "—"), secret: true },
  { key: "cardholder", value: (i) => i.paymentCard?.cardholderName ?? "—", secret: true },
  { key: "cvc", value: (i) => i.paymentCard?.cvc ?? "—", secret: true },
  { key: "network", value: (i) => (i.paymentCard ? tEnum("network", i.paymentCard.network) : "—") },
  { key: "fundingType", value: (i) => (i.paymentCard ? tEnum("fundingType", i.paymentCard.fundingType) : "—") },
  { key: "accountNumber", value: (i) => i.bankAccount?.accountNumber ?? "—" },
  { key: "accountHolder", value: (i) => i.bankAccount?.accountHolderName ?? "—" },
  { key: "currencies", value: (i) => i.bankAccount?.currencies.join(", ") || "—" },
  { key: "routing", value: (i) => i.bankAccount?.routingIdentifiers.map((r) => `${tEnum("routingScheme", r.scheme)} ${r.value}`).join(" · ") || "—" },
];

function differingFields(entry: ProjectedItem): { field: Field; values: string[] }[] {
  const live = entry.versions.map((v) => v.item);
  if (live.some((item) => item === null)) return [];
  const rows: { field: Field; values: string[] }[] = [];
  for (const field of FIELDS) {
    const values = live.map((item) => field.value(item as VaultItem));
    if (new Set(values).size > 1) rows.push({ field, values });
  }
  const photos = entry.versions.map((v) => v.artwork?.sha256 ?? "");
  if (new Set(photos).size > 1) rows.push({ field: { key: "cardFace", value: () => "" }, values: photos.map((p) => (p ? t("conflictsPhoto") : "—")) });
  return rows;
}

const shown = (entry: ProjectedItem): SyncParent[] => entry.versions.map((v) => ({ revisionID: v.node.revision.revisionID, digest: v.node.digest }));

/** The version edited most recently, by the item's own `updatedAt`; a deletion counts as oldest. */
function latest(entry: ProjectedItem): ItemVersion {
  return [...entry.versions].sort((a, b) => (Date.parse(b.item?.updatedAt ?? "") || 0) - (Date.parse(a.item?.updatedAt ?? "") || 0))[0] as ItemVersion;
}

/** Sample conflicts: every version is a reserved sample ID still tagged as a sample. Prefer this language's copy. */
function sampleChoice(entry: ProjectedItem): ItemVersion | null {
  if (!/^00000000-0000-4000-800[01]-/i.test(entry.itemID)) return null;
  if (!entry.versions.every((v) => v.item && isSample(v.item))) return null;
  const tag = locale.value === "zh" ? "示例" : "Demo";
  return entry.versions.find((v) => v.item?.tags.includes(tag)) ?? latest(entry);
}

async function resolve(store: VaultStore, entry: ProjectedItem, version: ItemVersion): Promise<void> {
  const item = version.item ? { ...version.item, updatedAt: new Date().toISOString() } : null;
  await store.save(item, entry.itemID, version.artwork, true, shown(entry));
}

type Bulk = { kind: "latest" | "samples" | "keepAll"; entries: ProjectedItem[] };

export function ConflictsView() {
  void revision.value;
  const store = vault.value;
  const conflicts = useMemo(() => (store?.items() ?? []).filter((e) => e.conflict), [store, revision.value]);
  const samples = conflicts.filter((e) => sampleChoice(e) !== null);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (work: (store: VaultStore) => Promise<number>, done: (n: number) => string) => {
    if (!store) return;
    setBusy(true);
    setError("");
    try {
      const n = await work(store);
      revision.value++;
      showToast(done(n));
    } catch (e) {
      revision.value++;
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setBulk(null);
    }
  };

  const applyBulk = (plan: Bulk) =>
    run(
      async (s) => {
        let n = 0;
        for (const entry of plan.entries) {
          if (plan.kind === "keepAll") await s.keepAll(entry);
          else await resolve(s, entry, plan.kind === "samples" ? (sampleChoice(entry) as ItemVersion) : latest(entry));
          n++;
        }
        return n;
      },
      (n) => t("conflictsResolved", { n }),
    );

  return (
    <main class="page settings-page conflicts-page">
      <header class="topbar">
        <button type="button" class="icon-btn" aria-label={t("back")} onClick={goBack}>
          <Icon name="back" />
        </button>
        <h1 class="title">{t("conflictsTitle")}</h1>
      </header>

      {conflicts.length === 0 ? (
        <div class="empty">
          <div class="empty-icon" aria-hidden="true">
            <Icon name="check" />
          </div>
          <h2 class="empty-title">{t("conflictsNone")}</h2>
          <p>{t("conflictsNoneLead")}</p>
          <div class="row-actions center">
            <button type="button" class="btn" onClick={() => navigate({ name: "home" })}>
              {t("cards")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p class="lead">{conflicts.length === 1 ? t("conflictsLeadOne") : t("conflictsLead", { n: conflicts.length })}</p>
          <div class="bulk-bar" role="toolbar" aria-label={t("conflictsBulk")}>
            <button type="button" class="btn small" disabled={busy} onClick={() => setBulk({ kind: "latest", entries: conflicts })}>
              <Icon name="refresh" /> {t("conflictsUseLatest")}
            </button>
            {samples.length > 0 && (
              <button type="button" class="btn small" disabled={busy} onClick={() => setBulk({ kind: "samples", entries: samples })}>
                <Icon name="sparkle" /> {t("conflictsSamples", { n: samples.length })}
              </button>
            )}
            <button type="button" class="btn small" disabled={busy} onClick={() => setBulk({ kind: "keepAll", entries: conflicts })}>
              <Icon name="copy" /> {t("conflictsKeepAll")}
            </button>
          </div>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          {conflicts.map((entry) => (
            <ConflictCard
              key={entry.itemID}
              entry={entry}
              busy={busy}
              onChoose={(v) =>
                run(
                  async (s) => (await resolve(s, entry, v), 1),
                  () => t("conflictsResolved", { n: 1 }),
                )
              }
            />
          ))}
        </>
      )}

      <Dialog
        open={bulk !== null}
        onClose={() => setBulk(null)}
        title={bulk ? t(bulk.kind === "latest" ? "conflictsUseLatest" : bulk.kind === "samples" ? "conflictsSamplesTitle" : "conflictsKeepAll") : ""}
      >
        {bulk && (
          <>
            <p class="lead">
              {t(bulk.kind === "latest" ? "conflictsLatestLead" : bulk.kind === "samples" ? "conflictsSamplesLead" : "conflictsKeepAllLead", {
                n: bulk.entries.length,
              })}
            </p>
            <ul class="bulk-preview">
              {bulk.entries.map((entry) => {
                const pick = bulk.kind === "latest" ? latest(entry) : bulk.kind === "samples" ? sampleChoice(entry) : null;
                return (
                  <li key={entry.itemID}>
                    <span class="bulk-name">{entry.item.displayName}</span>
                    <span class="bulk-pick">
                      {pick
                        ? pick.item
                          ? `${pick.item.displayName} · ${formatTime(pick.item.updatedAt)}`
                          : t("deletedVersion")
                        : t("conflictsCopies", { n: entry.versions.filter((v) => v.item).length })}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div class="row-actions">
              <button type="button" class="btn primary" disabled={busy} onClick={() => void applyBulk(bulk)}>
                {busy ? <span class="spinner" aria-hidden="true" /> : t("confirm")}
              </button>
              <button type="button" class="btn" onClick={() => setBulk(null)}>
                {t("cancel")}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </main>
  );
}

function ConflictCard({ entry, busy, onChoose }: { entry: ProjectedItem; busy: boolean; onChoose: (version: ItemVersion) => void }) {
  const diff = differingFields(entry);
  const sample = sampleChoice(entry) !== null;
  return (
    <section class="panel conflict-card" aria-label={entry.item.displayName}>
      <div class="conflict-head">
        <div>
          <h2 class="conflict-name">
            {entry.item.displayName}
            {sample && <span class="badge">{t("samplesSection")}</span>}
          </h2>
          <p class="muted">
            {entry.versions.some((v) => v.item === null)
              ? t("conflictsDeletedSomewhere")
              : diff.length === 1
                ? t("conflictsField")
                : t("conflictsFields", { n: diff.length })}
          </p>
        </div>
        <button type="button" class="btn small ghost" onClick={() => navigate({ name: "item", itemID: entry.itemID })}>
          {t("details")}
        </button>
      </div>
      <div class="diff" style={{ "--cols": String(entry.versions.length) } as Record<string, string>}>
        <div class="diff-row diff-header">
          <span class="diff-k" />
          {entry.versions.map((v, i) => (
            <span key={v.node.revision.revisionID} class="diff-v">
              <strong>{t("version", { n: i + 1 })}</strong>
              <span class="muted">{v.item ? formatTime(v.item.updatedAt) : t("deletedVersion")}</span>
            </span>
          ))}
        </div>
        {diff.map(({ field, values }) => (
          <div key={field.key} class="diff-row">
            <span class="diff-k">{t(field.key)}</span>
            {values.map((value, i) => (
              <span key={entry.versions[i]?.node.revision.revisionID} class="diff-v">
                {field.secret ? t("conflictsHiddenDiffers") : value}
              </span>
            ))}
          </div>
        ))}
        <div class="diff-row diff-actions">
          <span class="diff-k" />
          {entry.versions.map((v) => (
            <span key={v.node.revision.revisionID} class="diff-v">
              <button type="button" class="btn small" disabled={busy} onClick={() => onChoose(v)}>
                {v.item ? t("useThisVersion") : t("conflictsUseDeletion")}
              </button>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
