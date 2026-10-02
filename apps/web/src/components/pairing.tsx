import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import otterURL from "../assets/otter-mark.webp";
import { t } from "../i18n.js";
import { revision, syncNow, vault } from "../session.js";
import { Dialog, Icon, QRCanvas } from "./ui.js";

/**
 * Pairing flow: QR code → "iPhone connected" → first sync → done. Geometry and
 * timing follow docs/design/pairing-linked-motion.md, which the iPhone app
 * implements too, so both screens play the same animation.
 */

/** The shared "linked" animation (240 × 160 canvas). CSS drives the timeline; Reduce Motion shows the final frame. */
export function PairingLinked() {
  return (
    <svg class="linked" viewBox="0 0 240 160" role="img" aria-label={t("pairLinkedTitle")}>
      <g class="linked-browser">
        <rect x="14" y="38" width="108" height="78" rx="10" class="linked-frame" />
        <line x1="14" y1="54" x2="122" y2="54" class="linked-line" />
        <circle cx="24" cy="46" r="2" class="linked-ink" />
        <circle cx="31" cy="46" r="2" class="linked-ink" />
        <circle cx="38" cy="46" r="2" class="linked-ink" />
        <rect x="26" y="64" width="40" height="26" rx="4" class="linked-card" />
        <line x1="74" y1="68" x2="110" y2="68" class="linked-line faint" />
        <line x1="74" y1="78" x2="102" y2="78" class="linked-line faint" />
        <line x1="74" y1="88" x2="106" y2="88" class="linked-line faint" />
      </g>
      <line x1="122" y1="77" x2="160" y2="77" class="linked-link" />
      {[0, 1, 2].map((i) => (
        <circle key={i} cx="122" cy="77" r="2.5" class={`linked-dot linked-dot-${i}`} />
      ))}
      <rect x="160" y="18" width="62" height="124" rx="16" pathLength={1} class="linked-frame linked-phone" />
      <rect x="166" y="34" width="50" height="98" rx="9" class="linked-screen" />
      <rect x="182" y="25" width="18" height="4" rx="2" class="linked-ink linked-speaker" />
      <image href={otterURL} x="171" y="63" width="40" height="40" class="linked-otter" />
      <circle cx="218" cy="22" r="12" class="linked-ripple" />
      <g class="linked-badge">
        <circle cx="218" cy="22" r="12" class="linked-ink" />
        <path d="M212 22 l4 4 l8 -8" pathLength={1} class="linked-check" />
      </g>
    </svg>
  );
}

type Step = "connected" | "syncing" | "done";

function StepRow({ state, title, detail }: { state: "pending" | "active" | "done"; title: string; detail?: string }) {
  return (
    <li class={`pair-step ${state}`}>
      <span class="pair-step-glyph" aria-hidden="true">
        {state === "active" ? <span class="spinner" /> : state === "done" ? <Icon name="check" /> : null}
      </span>
      <span class="pair-step-text">
        <span class="pair-step-title">{title}</span>
        {detail && <span class="pair-step-detail">{detail}</span>}
      </span>
    </li>
  );
}

const POLL_MS = 1500;
const FOLLOW_MS = 2 * 60 * 1000;
const QUIET_MS = 6000;

export function PairingFlow({ pairing, onClose }: { pairing: { payload: string; code: string; expiresAt: number } | null; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [device, setDevice] = useState<{ name: string; lastSeenAt: number | null } | null>(null);
  const [expired, setExpired] = useState(false);
  const [step, setStep] = useState<Step>("connected");
  const [received, setReceived] = useState(0);
  const baseline = useRef(0);
  const lastChange = useRef(0);

  // Reset whenever a new code is shown.
  useEffect(() => {
    setDevice(null);
    setExpired(false);
    setStep("connected");
    setReceived(0);
    baseline.current = vault.value?.items().length ?? 0;
  }, [pairing?.code]);

  // Phase 1: wait for the claim. Phase 2: follow the first sync for a bounded time.
  const done = step === "done";
  useEffect(() => {
    if (!pairing || done) return;
    let stopped = false;
    let claimedAt = 0;
    const tick = async () => {
      setNow(Date.now());
      try {
        const status = await api.pairingStatus(pairing.code);
        if (stopped) return;
        if (status.status === "expired") return setExpired(true);
        if (status.status !== "claimed" || !status.device) return;
        if (!claimedAt) {
          claimedAt = Date.now();
          lastChange.current = Date.now();
        }
        setDevice({ name: status.device.name, lastSeenAt: status.device.lastSeenAt });
        await syncNow();
        if (stopped) return;
        const count = Math.max(0, (vault.value?.items().length ?? 0) - baseline.current);
        setReceived((previous) => {
          if (count !== previous) lastChange.current = Date.now();
          return count;
        });
        const active = status.device.lastSeenAt !== null;
        const quiet = Date.now() - lastChange.current > QUIET_MS;
        if (active && quiet) setStep("done");
        else if (Date.now() - claimedAt > FOLLOW_MS) setStep("done");
        else setStep("syncing");
      } catch {
        // Offline or locked meanwhile: the next tick retries; closing the dialog stops it.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pairing?.code, done]);

  void revision.value;
  const items = vault.value?.items() ?? [];
  const cards = items.filter((e) => e.item.kind === "paymentCard").length;
  const accounts = items.length - cards;
  const remaining = pairing ? Math.max(0, Math.round(pairing.expiresAt - now / 1000)) : 0;
  const linked = device !== null;

  return (
    <Dialog open={pairing !== null} onClose={onClose} title={linked ? t("pairLinkedTitle") : t("pairIphone")}>
      {!linked ? (
        <>
          <p class="lead">{t("pairLead")}</p>
          {pairing && !expired && <QRCanvas value={pairing.payload} label={t("pairIphone")} />}
          {expired ? (
            <p class="notice warn">{t("pairExpired")}</p>
          ) : (
            <>
              <p class="pair-waiting">
                <span class="spinner" aria-hidden="true" /> {t("pairWaitingScan")}
              </p>
              <p class="notice warn">{t("pairWarning")}</p>
              <p class="help">{t("pairExpires", { time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` })}</p>
            </>
          )}
          <div class="row-actions">
            <button type="button" class="btn" onClick={onClose}>
              {t("cancel")}
            </button>
          </div>
        </>
      ) : (
        <div class="pair-linked" role="status" aria-live="polite">
          <PairingLinked />
          <ol class="pair-steps">
            <StepRow state="done" title={t("pairLinkedTitle")} detail={device?.name} />
            <StepRow
              state={step === "done" ? "done" : "active"}
              title={step === "done" ? t("pairSynced") : t("pairSyncing")}
              detail={
                received > 0
                  ? t("pairReceived", { n: received })
                  : step === "done"
                    ? t("pairUpToDate")
                    : device?.lastSeenAt === null
                      ? t("pairWaitingFirst")
                      : t("pairSyncing")
              }
            />
            <StepRow
              state={step === "done" ? "done" : "pending"}
              title={t("pairAllSet")}
              detail={
                step === "done"
                  ? `${cards === 1 ? t("countCard") : t("countCards", { n: cards })} · ${accounts === 1 ? t("countAccount") : t("countAccounts", { n: accounts })}`
                  : undefined
              }
            />
          </ol>
          <div class="row-actions">
            <button type="button" class="btn primary block" onClick={onClose}>
              {t("pairDoneButton")}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
