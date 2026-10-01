import { ProtocolError, type VaultArtwork, type VaultItem } from "@quancard/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { APIError } from "../api.js";
import { type MessageKey, t, tEnum } from "../i18n.js";
import { confirmPassword } from "../session.js";

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
    <>{children}</>
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

const TEMPLATES: Record<string, { fill: string; accent: string }> = {
  graphite: { fill: "rgb(41,43,51)", accent: "#fff" },
  azure: { fill: "rgb(20,51,115)", accent: "rgb(242,209,115)" },
  ember: { fill: "rgb(41,33,36)", accent: "rgb(255,158,77)" },
  nebula: { fill: "rgb(51,23,97)", accent: "rgb(115,230,242)" },
  carbon: { fill: "rgb(23,28,31)", accent: "rgb(89,242,166)" },
  vermilion: { fill: "rgb(140,31,26)", accent: "rgb(255,217,153)" },
  ocean: { fill: "rgb(13,82,140)", accent: "rgb(166,217,255)" },
  sunset: { fill: "rgb(217,89,64)", accent: "rgb(255,217,179)" },
  forest: { fill: "rgb(26,97,71)", accent: "rgb(191,242,204)" },
  plum: { fill: "rgb(97,41,128)", accent: "rgb(230,204,255)" },
  gold: { fill: "rgb(140,107,46)", accent: "rgb(255,242,204)" },
  silver: { fill: "rgb(92,97,110)", accent: "#fff" },
  sakura: { fill: "rgb(168,71,112)", accent: "rgb(255,230,242)" },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

export function suggestTemplate(network: string, fundingType: string): string {
  if (fundingType === "cryptoLinked") return network === "mastercard" ? "carbon" : "nebula";
  const byNetwork: Record<string, string> = {
    visa: "azure",
    mastercard: "ember",
    amex: "silver",
    unionPay: "vermilion",
    jcb: "sakura",
    discover: "gold",
    dinersClub: "gold",
    rupay: "forest",
    mir: "plum",
  };
  return byNetwork[network] ?? "graphite";
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
  const template = TEMPLATES[item.artworkTemplateID] ?? (TEMPLATES.graphite as { fill: string; accent: string });
  const card = item.paymentCard;
  const suffix = last4(card?.pan);
  const style = { "--fill": template.fill, "--accent": template.accent } as Record<string, string>;
  return (
    <div class={`card-face${url ? " has-photo" : ""}`} style={style} aria-hidden="true">
      {url && <img src={url} alt="" draggable={false} />}
      <div class="face-top">
        <span class="face-issuer">{item.institutionName ?? item.displayName}</span>
      </div>
      <div class="face-bottom">
        <span class="face-number">{showSuffix && suffix ? `•••• ${suffix}` : ""}</span>
        <span class="face-network">{card ? tEnum("network", card.network) : ""}</span>
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
