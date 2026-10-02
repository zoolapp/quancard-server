import { ProtocolError, type VaultArtwork, type VaultItem } from "@quancard/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { APIError } from "../api.js";
import otterURL from "../assets/otter-mark.webp";
import { type MessageKey, t, tEnum } from "../i18n.js";
import { confirmPassword, SupersededError } from "../session.js";
import { BUILTIN_TEMPLATES, ISSUERS, templateFor, templateIDFor, WELCOME_TEMPLATE_ID } from "../templates.js";
import { VaultClosedError } from "../vault.js";

/* Icons: thin stroked line icons, drawn inline (no icon font, no external requests). */

const paths: Record<string, string> = {
  search: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6 6 18",
  back: "M15 18l-6-6 6-6",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff:
    "M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A16.6 16.6 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  check: "M5 12.5l4.5 4.5L19 7.5",
  card: "M3.5 6.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 9.5h17M7 15.5h3",
  bank: "M3 9.5 12 4l9 5.5M5 10v7.5M9.5 10v7.5M14.5 10v7.5M19 10v7.5M3.5 20h17",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 12h17M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z",
  sparkle:
    "M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5ZM18.5 15.5c.3 1.8 1 2.5 2.8 2.8-1.8.3-2.5 1-2.8 2.8-.3-1.8-1-2.5-2.8-2.8 1.8-.3 2.5-1 2.8-2.8Z",
  phone: "M7.5 3.5a1.5 1.5 0 0 1 1.5-1.5h6a1.5 1.5 0 0 1 1.5 1.5v17a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5zM11 18.5h2",
  chevron: "m9.5 6 6 6-6 6",
  shield: "M12 3 5 5.8v5.7c0 4.4 3 7.9 7 9.5 4-1.6 7-5.1 7-9.5V5.8z M9 12l2.2 2.2L15.5 10",
  signOut: "M14 4.5h4.5v15H14M10 8l-4 4 4 4M6.5 12H16",
  trash: "M4.5 7h15M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4.5h6V7",
  command:
    "M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9Zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15Zm0 0v6m0 0h-6m6 0v2.5a2.5 2.5 0 1 0 2.5-2.5H15Zm-6 0v2.5A2.5 2.5 0 1 1 6.5 15H9Z",
};

export function Icon({ name, label }: { name: keyof typeof paths; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label}>
      <path d={paths[name]} />
    </svg>
  );
}

/* Error mapping: server codes and protocol failures to user language. Never echoes input. */

export function errorMessage(error: unknown): string {
  // Work that finished after a lock is discarded silently; the lock screen explains itself.
  if (error instanceof SupersededError || error instanceof VaultClosedError) return "";
  if (error instanceof APIError) {
    const map: Record<string, MessageKey> = {
      invalidCredentials: "errInvalidCredentials",
      invalidSecondFactor: "errSecondFactor",
      accountLocked: "errLocked",
      rateLimited: "errRateLimited",
      invalidSetupToken: "errSetupToken",
      setupClosed: "errSetupClosed",
      usernameTaken: "errUsernameTaken",
      invalidUsername: "errInvalidUsername",
      network: "errNetwork",
      httpsRequired: "errHttps",
      invalidInvite: "errInvite",
      capacity: "errCapacity",
    };
    return t(map[error.code] ?? "errGeneric");
  }
  if (error instanceof ProtocolError) {
    if (error.code === "integrityFailure") return t("errWrongPassword");
    if (error.code === "capacityExceeded") return t("errCapacity");
    if (error.code === "conflict") return t("errConflict");
  }
  return t("errGeneric");
}

/* Dialog: native <dialog> for focus trapping, Esc and inert background. */

export function Dialog({
  open,
  onClose,
  title,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ComponentChildren;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const id = labelledBy ?? `dlg-${title.replace(/\W+/g, "-")}`;
  return (
    <dialog ref={ref} aria-labelledby={id} onClose={onClose} onCancel={(e) => (e.preventDefault(), onClose())}>
      {open && (
        <>
          <h2 id={id}>{title}</h2>
          {children}
        </>
      )}
    </dialog>
  );
}

export function Field({ label, help, children }: { label: string; help?: string; children: ComponentChildren }) {
  return (
    <div class="field">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children and nested inside the label */}
      <label>
        <span class="label">{label}</span>
        {children}
      </label>
      {help && <span class="help">{help}</span>}
    </div>
  );
}

export function Busy({ busy, children }: { busy: boolean; children: ComponentChildren }) {
  return busy ? (
    <>
      <span class="spinner" aria-hidden="true" /> <span>{t("deriving")}</span>
    </>
  ) : (
    children
  );
}

/** Asks for the password again and resolves with fresh secrets. */
export function PasswordDialog({
  open,
  title,
  lead,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  title?: string;
  lead?: string;
  onClose: () => void;
  onConfirmed: (secrets: Awaited<ReturnType<typeof confirmPassword>>) => Promise<void> | void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) {
      setPassword("");
      setError("");
    }
  }, [open]);
  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const secrets = await confirmPassword(password);
      setPassword("");
      await onConfirmed(secrets);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title ?? t("revealTitle")}>
      <form onSubmit={submit}>
        {lead && <p class="lead">{lead}</p>}
        <Field label={t("password")}>
          <input class="input" type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} required />
        </Field>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="row-actions">
          <button type="submit" class="btn primary" disabled={busy || !password}>
            <Busy busy={busy}>{t("confirm")}</Busy>
          </button>
          <button type="button" class="btn" onClick={onClose}>
            {t("cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* QR code drawn to a canvas: the payload never enters the DOM as text. */

export function QRCanvas({ value, label }: { value: string; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const qr = qrcode(0, "M");
    qr.addData(value, "Byte");
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4;
    const scale = Math.max(2, Math.floor(480 / (count + margin * 2)));
    const size = (count + margin * 2) * scale;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#000";
    for (let r = 0; r < count; r++)
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) context.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    return () => context.clearRect(0, 0, size, size);
  }, [value]);
  return <canvas ref={ref} class="qr" role="img" aria-label={label} />;
}

/* Card face: user photo, or an original flat template. Text is never the only source of meaning. */

export const TEMPLATE_IDS = BUILTIN_TEMPLATES.map((template) => template.id);

export function suggestTemplate(network: string, fundingType: string, institutionName?: string | null): string {
  return templateIDFor(institutionName, network, fundingType);
}

export function last4(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function useArtworkURL(artwork: VaultArtwork | null): string | null {
  const url = useMemo(() => {
    if (!artwork) return null;
    const binary = atob(artwork.data.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  }, [artwork]);
  // Blob URLs are revoked as soon as the face unmounts (including on lock).
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
}

export function CardFace({ item, artwork, showSuffix = true }: { item: VaultItem; artwork: VaultArtwork | null; showSuffix?: boolean }) {
  const url = useArtworkURL(artwork);
  const welcome = item.artworkTemplateID === WELCOME_TEMPLATE_ID;
  const template = templateFor(welcome ? "graphite" : item.artworkTemplateID);
  const card = item.paymentCard;
  // Placeholder numbers on the welcome card are not shown; the otter takes that space.
  const suffix = welcome ? null : last4(card?.pan);
  // A matched issuer palette carries a short display name ("ICBC"), like the iOS issuer mark.
  const issuerName = ISSUERS.find((issuer) => issuer.id === item.artworkTemplateID)?.name;
  const style = { "--fill": template.fill, "--accent": template.accent } as Record<string, string>;
  return (
    <div class={`card-face${url ? " has-photo" : ""}`} style={style} aria-hidden="true">
      {url && <img src={url} alt="" draggable={false} />}
      {!url && template.decor !== "none" && (
        <div class={`face-decor-layer face-decor-${template.decor}`}>
          {template.decor === "wave" && (
            <svg viewBox="0 0 400 250" preserveAspectRatio="none" aria-hidden="true">
              <path d="M-40 100 C80 20 220 210 440 100 L440 125 C220 235 80 45-40 125Z" />
              <path d="M-40 150 C100 65 240 255 440 150 L440 168 C240 273 100 83-40 168Z" />
            </svg>
          )}
        </div>
      )}
      {!url && welcome && <img class="face-decor-welcome" src={otterURL} alt="" draggable={false} />}
      <div class="face-top">
        <span class="face-issuer">{welcome ? "QuanCard" : (issuerName ?? item.institutionName ?? item.displayName)}</span>
      </div>
      <div class="face-bottom">
        <span class="face-number">{showSuffix && suffix ? `•••• ${suffix}` : ""}</span>
        {!welcome && <span class="face-network">{card ? tEnum("network", card.network) : ""}</span>}
      </div>
    </div>
  );
}

/** Accessible summary that never includes hidden card details. */
export function itemSummary(item: VaultItem): string {
  const parts = [item.displayName];
  if (item.institutionName) parts.push(item.institutionName);
  if (item.paymentCard) {
    parts.push(tEnum("network", item.paymentCard.network));
    const suffix = last4(item.paymentCard.pan);
    if (suffix) parts.push(`•••• ${suffix}`);
  }
  return parts.join(", ");
}
