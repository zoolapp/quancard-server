import type { VaultItem } from "@quancard/protocol";
import { useEffect, useState } from "preact/hooks";
import { markStyle, monogram } from "../collection.js";
import { CardFace, Dialog, errorMessage, Icon, PasswordDialog } from "../components/ui.js";
import { formatTime, regionName, t, tEnum } from "../i18n.js";
import { goBack, navigate } from "../router.js";
import { revealGrace, revision, vault } from "../session.js";
import type { ItemVersion, ProjectedItem } from "../vault.js";

/**
 * Card numbers show only the last four digits; expiry, cardholder and CVC are
 * fully masked until the password is re-entered (then shown for 60 seconds,
 * with a 5-minute grace before asking again). Bank accounts and notes are
 * readable once unlocked, matching the iOS policy.
 */

const REVEAL_MS = 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;

const CLIPBOARD_MS = 45 * 1000;
let clipboardTimer: ReturnType<typeof setTimeout> | undefined;

async function copyText(value: string, onDone: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    onDone(t("copied"));
    clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(() => {
      // Best effort only: browsers allow writing the clipboard only while focused.
      if (document.hasFocus()) void navigator.clipboard.writeText("").catch(() => undefined);
    }, CLIPBOARD_MS);
  } catch {
    onDone(t("errGeneric"));
  }
}

function groupPAN(pan: string): string {
  return pan
    .replace(/\s+/g, "")
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

function Row({ label, value, mono, masked, onCopy }: { label: string; value: string | null; mono?: boolean; masked?: boolean; onCopy?: () => void }) {
  if (value === null || value === "") return null;
  return (
    <div class="kv-row">
      <span class="k">{label}</span>
      <span class={`v${mono ? " mono" : ""}`}>
        {masked ? (
          <>
            <span aria-hidden="true">••••</span>
            <span class="visually-hidden">{t("hiddenUntilRevealed")}</span>
          </>
        ) : (
          value
        )}
      </span>
      {onCopy && !masked && (
        <span class="actions">
          <button type="button" class="icon-btn" aria-label={`${t("copy")} ${label}`} onClick={onCopy}>
            <Icon name="copy" />
          </button>
        </span>
      )}
    </div>
  );
}

function Details({ item, revealed, onCopy }: { item: VaultItem; revealed: boolean; onCopy: (value: string) => void }) {
  const card = item.paymentCard;
  const account = item.bankAccount;
  const expiry = card?.expiryMonth && card.expiryYear ? `${String(card.expiryMonth).padStart(2, "0")} / ${card.expiryYear}` : null;
  const suffix = card?.pan ? card.pan.replace(/\D/g, "").slice(-4) : null;
  return (
    <div class="kv">
      {card && (
        <>
          <Row
            label={t("cardNumber")}
            value={card.pan ? (revealed ? groupPAN(card.pan) : `•••• ${suffix}`) : null}
            mono
            onCopy={revealed && card.pan ? () => onCopy(card.pan as string) : undefined}
          />
          <Row label={t("expiry")} value={expiry} mono masked={!revealed} onCopy={expiry ? () => onCopy(expiry.replace(/\s/g, "")) : undefined} />
          <Row label={t("cardholder")} value={card.cardholderName} masked={!revealed} onCopy={() => onCopy(card.cardholderName ?? "")} />
          <Row label={t("cvc")} value={card.cvc ?? null} mono masked={!revealed} onCopy={() => onCopy(card.cvc ?? "")} />
          <Row label={t("network")} value={tEnum("network", card.network)} />
          <Row label={t("fundingType")} value={`${tEnum("fundingType", card.fundingType)} · ${tEnum("formFactor", card.formFactor)}`} />
        </>
      )}
      {account && (
        <>
          <Row label={t("accountHolder")} value={account.accountHolderName} onCopy={() => onCopy(account.accountHolderName ?? "")} />
          <Row label={t("accountNumber")} value={account.accountNumber} mono onCopy={() => onCopy(account.accountNumber ?? "")} />
          <Row label={t("accountKind")} value={tEnum("accountKind", account.accountKind)} />
          <Row label={t("currencies")} value={account.currencies.join(" · ")} />
          {account.routingIdentifiers.map((r) => (
            <Row
              key={r.id}
              label={r.label ? `${tEnum("routingScheme", r.scheme)} · ${r.label}` : tEnum("routingScheme", r.scheme)}
              value={r.value}
              mono
              onCopy={() => onCopy(r.value)}
            />
          ))}
        </>
      )}
      <Row label={t("institution")} value={item.institutionName} />
      <Row label={t("region")} value={item.country ? `${regionName(item.country)} (${item.country.toUpperCase()})` : null} />
      <Row label={t("status")} value={tEnum("lifecycle", item.lifecycle)} />
      <Row label={t("tags")} value={item.tags.join(", ")} />
      <Row label={t("notes")} value={item.notes} onCopy={() => onCopy(item.notes ?? "")} />
      <Row label={t("updated")} value={formatTime(item.updatedAt)} />
    </div>
  );
}

function ConflictView({ entry }: { entry: ProjectedItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const store = vault.value;
  const choose = async (version: ItemVersion) => {
    if (!store) return;
    setBusy(true);
    setError("");
    try {
      // The chosen snapshot becomes a new revision whose parents cover every head.
      await store.save(version.item ? { ...version.item, updatedAt: new Date().toISOString() } : null, entry.itemID, version.artwork, true);
      revision.value++;
      if (!version.item) goBack();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const keepAll = async () => {
    if (!store) return;
    setBusy(true);
    try {
      await store.keepAll(entry);
      revision.value++;
      goBack();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="settings-section" aria-labelledby="conflict-title">
      <h2 class="section-label" id="conflict-title">
        {t("conflictTitle")}
      </h2>
      <p class="lead">{t("conflictLead")}</p>
      {entry.versions.map((version, index) => (
        <div class="panel" key={version.node.revision.revisionID} style={{ marginBottom: "12px", padding: "12px 16px" }}>
          <div class="row-title">
            {t("version", { n: index + 1 })} · {version.item ? version.item.displayName : t("deletedVersion")}
          </div>
          {version.item && (
            <div class="row-sub">{[version.item.institutionName, version.item.notes, formatTime(version.item.updatedAt)].filter(Boolean).join(" · ")}</div>
          )}
          <div class="row-actions" style={{ marginTop: "12px" }}>
            <button type="button" class="btn small" disabled={busy} onClick={() => void choose(version)}>
              {t("useThisVersion")}
            </button>
          </div>
        </div>
      ))}
      <button type="button" class="btn" disabled={busy} onClick={() => void keepAll()}>
        {t("keepAll")}
      </button>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function ItemView({ itemID }: { itemID: string }) {
  void revision.value;
  const store = vault.value;
  const entry = store?.items().find((e) => e.itemID === itemID);
  const [revealed, setRevealed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(false), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealed]);

  if (!entry) {
    return (
      <div class="pane">
        <header class="topbar">
          <button type="button" class="icon-btn" aria-label={t("back")} onClick={goBack}>
            <Icon name="back" />
          </button>
        </header>
        <div class="empty">{t("noResults")}</div>
      </div>
    );
  }
  const { item } = entry;
  const hasSecrets = !!item.paymentCard && !!(item.paymentCard.pan || item.paymentCard.cvc || item.paymentCard.expiryMonth || item.paymentCard.cardholderName);

  const toggleReveal = () => {
    if (revealed) return setRevealed(false);
    if (Date.now() < revealGrace.until) return setRevealed(true);
    setAsking(true);
  };

  const remove = async () => {
    if (!store) return;
    setBusy(true);
    try {
      await store.save(null, itemID, null);
      revision.value++;
      setConfirmDelete(false);
      goBack();
    } catch (e) {
      setMessage(errorMessage(e));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="pane">
      <header class="topbar">
        <button type="button" class="icon-btn" aria-label={t("back")} onClick={goBack}>
          <Icon name="back" />
        </button>
        <h1 class="title">{item.displayName}</h1>
        {!entry.conflict && (
          <button type="button" class="btn small" onClick={() => navigate({ name: "edit", itemID, kind: item.kind })}>
            {t("edit")}
          </button>
        )}
      </header>

      {entry.conflict ? (
        <ConflictView entry={entry} />
      ) : (
        <div class="detail">
          <div>
            {item.paymentCard ? (
              <CardFace item={item} artwork={entry.artwork} />
            ) : (
              <div class="account-mark large" style={markStyle(entry)} aria-hidden="true">
                {monogram(entry)}
              </div>
            )}
            {hasSecrets && (
              <div class="row-actions">
                <button type="button" class="btn" aria-pressed={revealed} onClick={toggleReveal}>
                  <Icon name={revealed ? "eyeOff" : "eye"} /> {revealed ? t("hide") : t("reveal")}
                </button>
              </div>
            )}
          </div>
          <div>
            <Details item={item} revealed={revealed} onCopy={(value) => void copyText(value, setMessage)} />
            {message && (
              <p class="notice" role="status">
                {message} {message === t("copied") ? t("copyNote") : ""}
              </p>
            )}
            <div class="row-actions">
              <button type="button" class="btn danger" onClick={() => setConfirmDelete(true)}>
                {t("delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      <PasswordDialog
        open={asking}
        lead={t("revealLead")}
        onClose={() => setAsking(false)}
        onConfirmed={() => {
          revealGrace.until = Date.now() + GRACE_MS;
          setAsking(false);
          setRevealed(true);
        }}
      />
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t("deleteTitle")}>
        <p class="lead">{t("deleteLead")}</p>
        <div class="row-actions">
          <button type="button" class="btn danger solid" disabled={busy} onClick={() => void remove()}>
            {t("delete")}
          </button>
          <button type="button" class="btn" onClick={() => setConfirmDelete(false)}>
            {t("cancel")}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
