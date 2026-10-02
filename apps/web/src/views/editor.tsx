import { isValidCVC, KNOWN_VALUES, type RoutingIdentifier, randomUUID, type VaultArtwork, type VaultItem } from "@quancard/protocol";
import { useState } from "preact/hooks";
import { ArtworkError, processPhoto } from "../artwork.js";
import { CardFace, errorMessage, Field, Icon, suggestTemplate, TEMPLATE_IDS } from "../components/ui.js";
import { regionName, t, tEnum } from "../i18n.js";
import { goBack } from "../router.js";
import { revision, vault } from "../session.js";
import { ISSUERS } from "../templates.js";

/**
 * Add/edit form for cards and bank accounts. Edits start from the current
 * decrypted snapshot so fields this form does not show (wallet provisions,
 * manual order, iOS-only values) survive a round trip unchanged.
 */

type Kind = "paymentCard" | "bankAccount";

function emptyItem(kind: Kind): VaultItem {
  const now = new Date().toISOString();
  return {
    itemSchemaVersion: 1,
    id: randomUUID().toLowerCase(),
    displayName: "",
    institutionName: null,
    country: null,
    tags: [],
    notes: null,
    artworkTemplateID: "graphite",
    artworkBlobID: null,
    lifecycle: "active",
    isFavorite: false,
    manualSortPosition: null,
    createdAt: now,
    updatedAt: now,
    kind,
    paymentCard:
      kind === "paymentCard"
        ? {
            cardholderName: null,
            pan: null,
            expiryMonth: null,
            expiryYear: null,
            network: "visa",
            fundingType: "credit",
            formFactor: "physical",
            walletProvisions: [],
          }
        : null,
    bankAccount:
      kind === "bankAccount" ? { accountHolderName: null, accountNumber: null, accountKind: "checking", currencies: [], routingIdentifiers: [] } : null,
  };
}

const DUPLICATE = "\u0000duplicate";
const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

function Select({
  label,
  group,
  value,
  values,
  onChange,
}: {
  label: string;
  group: string;
  value: string;
  values: readonly string[];
  onChange: (v: string) => void;
}) {
  const options = values.includes(value) ? values : [...values, value];
  return (
    <Field label={label}>
      <select class="input" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {options.map((v) => (
          <option key={v} value={v}>
            {tEnum(group, v)}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function EditorView({ itemID, kind }: { itemID: string | null; kind: Kind }) {
  const store = vault.value;
  const existing = itemID ? store?.items().find((e) => e.itemID === itemID) : undefined;
  const [item, setItem] = useState<VaultItem>(() => structuredClone(existing?.item ?? emptyItem(kind)));
  const [artwork, setArtwork] = useState<VaultArtwork | null>(existing?.artwork ?? null);
  const [templateTouched, setTemplateTouched] = useState(!!existing);
  const [tags, setTags] = useState(item.tags.join(", "));
  const [currencies, setCurrencies] = useState(item.bankAccount?.currencies.join(", ") ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const update = (patch: Partial<VaultItem>) => setItem((current) => ({ ...current, ...patch }));
  const updateCard = (patch: Partial<NonNullable<VaultItem["paymentCard"]>>) =>
    setItem((current) => {
      const card = { ...(current.paymentCard as NonNullable<VaultItem["paymentCard"]>), ...patch };
      const artworkTemplateID = templateTouched ? current.artworkTemplateID : suggestTemplate(card.network, card.fundingType, current.institutionName);
      return { ...current, paymentCard: card, artworkTemplateID };
    });
  const updateAccount = (patch: Partial<NonNullable<VaultItem["bankAccount"]>>) =>
    setItem((current) => ({ ...current, bankAccount: { ...(current.bankAccount as NonNullable<VaultItem["bankAccount"]>), ...patch } }));

  const card = item.paymentCard;
  const account = item.bankAccount;
  const currentIssuer = ISSUERS.find((issuer) => issuer.id === item.artworkTemplateID);
  const templateIDs = currentIssuer ? [...TEMPLATE_IDS, currentIssuer.id] : TEMPLATE_IDS;

  const choosePhoto = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      const processed = await processPhoto(file);
      setArtwork(processed);
    } catch (e) {
      setError(e instanceof ArtworkError && e.message === "size" ? t("photoTooLarge") : t("errImage"));
    }
  };

  const validate = (draft: VaultItem): string | null => {
    if (!draft.displayName.trim()) return t("name");
    if (draft.country && !/^[A-Za-z]{2}$/.test(draft.country)) return t("regionHelp");
    const c = draft.paymentCard;
    if (c) {
      if (c.pan && !/^[0-9]{8,19}$/.test(c.pan)) return t("cardNumber");
      if (c.expiryMonth !== null && (c.expiryMonth < 1 || c.expiryMonth > 12)) return t("expiryMonth");
      if (c.expiryYear !== null && (c.expiryYear < 1950 || c.expiryYear > 2200)) return t("expiryYear");
      if (c.cvc !== undefined && !isValidCVC(c.cvc)) return t("cvc");
      // Same rule as iOS: a new or changed card number may not duplicate another live card.
      const duplicate = store?.items().some((e) => e.itemID !== itemID && e.item.paymentCard?.pan && e.item.paymentCard.pan === c.pan);
      if (c.pan && duplicate && c.pan !== existing?.item.paymentCard?.pan) return DUPLICATE;
    }
    return null;
  };

  const save = async (event: Event) => {
    event.preventDefault();
    if (!store) return;
    const draft: VaultItem = {
      ...item,
      displayName: item.displayName.trim(),
      country: item.country ? item.country.toUpperCase() : null,
      tags: tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      artworkBlobID: artwork?.id ?? null,
      updatedAt: new Date().toISOString(),
    };
    if (draft.bankAccount) {
      draft.bankAccount = {
        ...draft.bankAccount,
        currencies: currencies
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
        routingIdentifiers: draft.bankAccount.routingIdentifiers.filter((r) => r.value.trim() !== ""),
      };
    }
    const problem = validate(draft);
    if (problem) {
      setError(problem === DUPLICATE ? t("errDuplicateCard") : t("errCheckField", { field: problem }));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await store.save(draft, existing?.itemID ?? draft.id, artwork);
      revision.value++;
      goBack();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const setRouting = (index: number, patch: Partial<RoutingIdentifier>) =>
    updateAccount({ routingIdentifiers: (account?.routingIdentifiers ?? []).map((r, i) => (i === index ? { ...r, ...patch } : r)) });

  return (
    <main class="page">
      <header class="topbar">
        <button type="button" class="icon-btn" aria-label={t("cancel")} onClick={goBack}>
          <Icon name="close" />
        </button>
        <h1 class="title">{existing ? t("edit") : kind === "paymentCard" ? t("addCard") : t("addAccount")}</h1>
        <button type="submit" form="editor" class="btn small primary" disabled={busy}>
          {busy ? <span class="spinner" aria-hidden="true" /> : t("save")}
        </button>
      </header>

      <form id="editor" onSubmit={save} class="detail">
        <div>
          {card && <CardFace item={{ ...item, artworkBlobID: artwork?.id ?? null }} artwork={artwork} />}
          {card && (
            <section class="settings-section" aria-label={t("cardFace")}>
              <div class="chips wrap" role="toolbar" aria-label={t("template")}>
                {templateIDs.map((id) => (
                  <button
                    key={id}
                    type="button"
                    class="chip"
                    aria-pressed={item.artworkTemplateID === id}
                    onClick={() => (setTemplateTouched(true), update({ artworkTemplateID: id }))}
                  >
                    {currentIssuer?.id === id ? currentIssuer.name : tEnum("template", id)}
                  </button>
                ))}
              </div>
              <div class="row-actions">
                <label class="btn small">
                  {artwork ? t("replacePhoto") : t("uploadPhoto")}
                  <input type="file" accept="image/*" class="visually-hidden" onChange={(e) => void choosePhoto(e.currentTarget.files?.[0])} />
                </label>
                {artwork && (
                  <button type="button" class="btn small" onClick={() => setArtwork(null)}>
                    {t("removePhoto")}
                  </button>
                )}
              </div>
              <p class="help" style={{ color: "var(--ink-3)", fontSize: "13px" }}>
                {t("photoNote")}
              </p>
            </section>
          )}
        </div>

        <div>
          <Field label={t("name")}>
            <input class="input" value={item.displayName} maxLength={200} onInput={(e) => update({ displayName: e.currentTarget.value })} required />
          </Field>
          <Field label={t("institution")}>
            <input
              class="input"
              value={item.institutionName ?? ""}
              maxLength={200}
              onInput={(e) => {
                const institutionName = orNull(e.currentTarget.value);
                update({
                  institutionName,
                  ...(!templateTouched && card ? { artworkTemplateID: suggestTemplate(card.network, card.fundingType, institutionName) } : {}),
                });
              }}
            />
          </Field>
          <Field label={t("region")} help={item.country && /^[A-Za-z]{2}$/.test(item.country) ? regionName(item.country) : t("regionHelp")}>
            <input
              class="input"
              value={item.country ?? ""}
              maxLength={2}
              autocapitalize="characters"
              spellcheck={false}
              onInput={(e) => update({ country: orNull(e.currentTarget.value.toUpperCase()) })}
            />
          </Field>

          {card && (
            <>
              <Field label={t("cardNumber")}>
                <input
                  class="input mono"
                  inputMode="numeric"
                  autocomplete="off"
                  value={card.pan ?? ""}
                  maxLength={23}
                  onInput={(e) => updateCard({ pan: orNull(e.currentTarget.value.replace(/[\s-]/g, "")) })}
                />
              </Field>
              <div class="field-row">
                <Field label={`${t("expiry")} · ${t("expiryMonth")}`}>
                  <input
                    class="input mono"
                    inputMode="numeric"
                    autocomplete="off"
                    placeholder="MM"
                    value={card.expiryMonth ?? ""}
                    maxLength={2}
                    onInput={(e) => updateCard({ expiryMonth: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
                  />
                </Field>
                <Field label={t("expiryYear")}>
                  <input
                    class="input mono"
                    inputMode="numeric"
                    autocomplete="off"
                    placeholder="YYYY"
                    value={card.expiryYear ?? ""}
                    maxLength={4}
                    onInput={(e) => updateCard({ expiryYear: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
                  />
                </Field>
              </div>
              <div class="field-row">
                <Field label={t("cardholder")}>
                  <input
                    class="input"
                    autocomplete="off"
                    value={card.cardholderName ?? ""}
                    onInput={(e) => updateCard({ cardholderName: orNull(e.currentTarget.value) })}
                  />
                </Field>
                <Field label={t("cvc")}>
                  <input
                    class="input mono"
                    inputMode="numeric"
                    autocomplete="off"
                    type="password"
                    maxLength={4}
                    value={card.cvc ?? ""}
                    onInput={(e) => updateCard({ cvc: e.currentTarget.value === "" ? undefined : e.currentTarget.value })}
                  />
                </Field>
              </div>
              <div class="field-row">
                <Select label={t("network")} group="network" value={card.network} values={KNOWN_VALUES.network} onChange={(v) => updateCard({ network: v })} />
                <Select
                  label={t("fundingType")}
                  group="fundingType"
                  value={card.fundingType}
                  values={KNOWN_VALUES.fundingType}
                  onChange={(v) => updateCard({ fundingType: v })}
                />
              </div>
              <Select
                label={t("formFactor")}
                group="formFactor"
                value={card.formFactor}
                values={KNOWN_VALUES.formFactor}
                onChange={(v) => updateCard({ formFactor: v })}
              />
            </>
          )}

          {account && (
            <>
              <Field label={t("accountHolder")}>
                <input
                  class="input"
                  value={account.accountHolderName ?? ""}
                  onInput={(e) => updateAccount({ accountHolderName: orNull(e.currentTarget.value) })}
                />
              </Field>
              <Field label={t("accountNumber")}>
                <input
                  class="input mono"
                  autocomplete="off"
                  value={account.accountNumber ?? ""}
                  onInput={(e) => updateAccount({ accountNumber: orNull(e.currentTarget.value) })}
                />
              </Field>
              <Select
                label={t("accountKind")}
                group="accountKind"
                value={account.accountKind}
                values={KNOWN_VALUES.accountKind}
                onChange={(v) => updateAccount({ accountKind: v })}
              />
              <Field label={t("currencies")} help={t("currenciesHelp")}>
                <input class="input" value={currencies} autocapitalize="characters" onInput={(e) => setCurrencies(e.currentTarget.value)} />
              </Field>
              <h2 class="section-label">{t("routing")}</h2>
              {account.routingIdentifiers.map((routing, index) => (
                <div class="panel" key={routing.id} style={{ padding: "12px 16px", marginBottom: "12px" }}>
                  <Select
                    label={t("routingScheme")}
                    group="routingScheme"
                    value={routing.scheme}
                    values={KNOWN_VALUES.routingScheme}
                    onChange={(v) => setRouting(index, { scheme: v })}
                  />
                  <Field label={t("routingValue")}>
                    <input class="input mono" value={routing.value} onInput={(e) => setRouting(index, { value: e.currentTarget.value })} />
                  </Field>
                  <Field label={t("routingLabel")}>
                    <input class="input" value={routing.label ?? ""} onInput={(e) => setRouting(index, { label: orNull(e.currentTarget.value) })} />
                  </Field>
                  <button
                    type="button"
                    class="btn small"
                    onClick={() => updateAccount({ routingIdentifiers: account.routingIdentifiers.filter((_, i) => i !== index) })}
                  >
                    {t("remove")}
                  </button>
                </div>
              ))}
              <button
                type="button"
                class="btn small"
                onClick={() =>
                  updateAccount({
                    routingIdentifiers: [...account.routingIdentifiers, { id: randomUUID().toLowerCase(), scheme: "iban", value: "", label: null }],
                  })
                }
              >
                {t("addRouting")}
              </button>
            </>
          )}

          <div class="settings-section">
            <Select label={t("status")} group="lifecycle" value={item.lifecycle} values={KNOWN_VALUES.lifecycle} onChange={(v) => update({ lifecycle: v })} />
            <Field label={t("tags")} help={t("tagsHelp")}>
              <input class="input" value={tags} onInput={(e) => setTags(e.currentTarget.value)} />
            </Field>
            <Field label={t("notes")}>
              <textarea
                class="input"
                value={item.notes ?? ""}
                onInput={(e) => update({ notes: e.currentTarget.value === "" ? null : e.currentTarget.value })}
              />
            </Field>
            <label class="check">
              <input type="checkbox" checked={item.isFavorite} onChange={(e) => update({ isFavorite: e.currentTarget.checked })} />
              <span>{t("favorite")}</span>
            </label>
          </div>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          {busy && <p class="lead">{t("saving")}</p>}
        </div>
      </form>
    </main>
  );
}
