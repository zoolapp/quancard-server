import { base64, deriveAccountSecrets, passwordMeetsPolicy, randomBytes, recoveryCode, unwrapAccountKey, wrapAccountKey } from "@quancard/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loadSampleData, removeSampleData } from "../actions.js";
import { api } from "../api.js";
import { PairingFlow } from "../components/pairing.js";
import { Dialog, errorMessage, Field, Icon, PasswordDialog, QRCanvas } from "../components/ui.js";
import { isSample } from "../demo.js";
import { formatBytes, formatTime, locale, type MessageKey, setLocale, t } from "../i18n.js";
import { argon2id } from "../kdf.js";
import { goBack } from "../router.js";
import { AUTO_LOCK_CHOICES, account, autoLockMinutes, confirmPassword, revision, setAutoLock, signOut, unlock, vault } from "../session.js";
import { showToast } from "../state.js";

type Secrets = Awaited<ReturnType<typeof confirmPassword>>;

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="settings-section" aria-label={title}>
      <h2 class="section-label">{title}</h2>
      <div class="panel">
        <div class="kv">{children}</div>
      </div>
    </section>
  );
}

function Line({ label, children, action }: { label: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="kv-row">
      <span class="k">{label}</span>
      <span class="v">{children}</span>
      {action && <span class="actions">{action}</span>}
    </div>
  );
}

function ChangePassword({ onDone }: { onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: Event) => {
    event.preventDefault();
    setError("");
    if (!passwordMeetsPolicy(next)) return setError(t("errPasswordPolicy"));
    if (next !== confirm) return setError(t("errPasswordMismatch"));
    setBusy(true);
    try {
      const view = account.value;
      if (!view) return;
      const old = await confirmPassword(current);
      // Re-wrap the same Account Key under the new password; vault keys and revisions are untouched.
      const { raw } = await unwrapAccountKey(base64.decode(view.wrappedAccountKey), view.accountID, old.kek);
      const salt = randomBytes(16);
      const fresh = await deriveAccountSecrets(next, salt, argon2id);
      const wrapped = await wrapAccountKey(raw, view.accountID, fresh.kek);
      raw.fill(0);
      account.value = await api.changePassword({
        currentAuthKey: base64.encode(old.authKey),
        kdfSalt: base64.encode(salt),
        authKey: base64.encode(fresh.authKey),
        wrappedAccountKey: base64.encode(wrapped),
      });
      // Refresh the local re-verification digest by unlocking again with the new password.
      await unlock(next);
      setOpen(false);
      onDone(t("passwordChanged"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCurrent("");
      setNext("");
      setConfirm("");
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" class="btn small" onClick={() => setOpen(true)}>
        {t("changePassword")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("changePassword")}>
        <form onSubmit={submit}>
          <input type="text" class="visually-hidden" autocomplete="username" value={account.value?.username ?? ""} readOnly tabIndex={-1} aria-hidden="true" />
          <Field label={t("currentPassword")}>
            <input class="input" type="password" autocomplete="current-password" value={current} onInput={(e) => setCurrent(e.currentTarget.value)} required />
          </Field>
          <Field label={t("newPassword")} help={t("passwordHelp")}>
            <input class="input" type="password" autocomplete="new-password" value={next} onInput={(e) => setNext(e.currentTarget.value)} required />
          </Field>
          <Field label={t("confirmPassword")}>
            <input class="input" type="password" autocomplete="new-password" value={confirm} onInput={(e) => setConfirm(e.currentTarget.value)} required />
          </Field>
          <div class="notice warn">{t("passwordWarning")}</div>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <div class="row-actions">
            <button type="submit" class="btn primary" disabled={busy}>
              {busy ? <span class="spinner" aria-hidden="true" /> : t("save")}
            </button>
            <button type="button" class="btn" onClick={() => setOpen(false)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function TwoFactor() {
  const [askPassword, setAskPassword] = useState<"enable" | "disable" | null>(null);
  const [uri, setURI] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disableSecrets, setDisableSecrets] = useState<Secrets | null>(null);
  const [error, setError] = useState("");
  const enabled = account.value?.totpEnabled ?? false;

  const begin = async (secrets: Secrets) => {
    setAskPassword(null);
    try {
      setURI((await api.totpSetup(secrets.authKey)).otpauthURI);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const finish = async (event: Event) => {
    event.preventDefault();
    try {
      const result = await api.totpEnable(code.replace(/\s/g, ""));
      setURI(null);
      setCode("");
      setCodes(result.recoveryCodes);
      account.value = await api.account();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const disable = async (event: Event) => {
    event.preventDefault();
    if (!disableSecrets) return;
    try {
      await api.totpDisable(disableSecrets.authKey, code.replace(/\s/g, ""));
      setDisableSecrets(null);
      setCode("");
      account.value = await api.account();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const secret = uri ? new URL(uri).searchParams.get("secret") : null;

  return (
    <>
      <Line
        label={t("twoFactor")}
        action={
          <button type="button" class="btn small" onClick={() => (setError(""), setAskPassword(enabled ? "disable" : "enable"))}>
            {enabled ? t("disable") : t("enable")}
          </button>
        }
      >
        {enabled ? t("twoFactorOn") : t("twoFactorOff")}
      </Line>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <PasswordDialog
        open={askPassword !== null}
        title={t("twoFactor")}
        onClose={() => setAskPassword(null)}
        onConfirmed={(secrets) => {
          if (askPassword === "enable") return begin(secrets);
          setAskPassword(null);
          setDisableSecrets(secrets);
        }}
      />
      <Dialog open={uri !== null} onClose={() => setURI(null)} title={t("twoFactor")}>
        <form onSubmit={finish}>
          <p class="lead">{t("totpScan")}</p>
          {uri && <QRCanvas value={uri} label={t("twoFactor")} />}
          <p class="help">{t("totpManual")}</p>
          <p class="mono-wrap">{secret}</p>
          <Field label={t("totpCode")}>
            <input class="input mono" inputMode="numeric" autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} required />
          </Field>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <div class="row-actions">
            <button type="submit" class="btn primary">
              {t("enable")}
            </button>
            <button type="button" class="btn" onClick={() => setURI(null)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      </Dialog>
      <Dialog open={codes !== null} onClose={() => setCodes(null)} title={t("recoveryCodesTitle")}>
        <p class="lead">{t("recoveryCodesLead")}</p>
        <div class="codes">
          {codes?.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div class="row-actions">
          <button type="button" class="btn primary" onClick={() => setCodes(null)}>
            {t("savedCodes")}
          </button>
        </div>
      </Dialog>
      <Dialog open={disableSecrets !== null} onClose={() => setDisableSecrets(null)} title={t("twoFactor")}>
        <form onSubmit={disable}>
          <Field label={t("totpCode")}>
            <input class="input mono" inputMode="numeric" autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} required />
          </Field>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <div class="row-actions">
            <button type="submit" class="btn danger">
              {t("disable")}
            </button>
            <button type="button" class="btn" onClick={() => setDisableSecrets(null)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function Sessions() {
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.sessions>>["sessions"]>([]);
  const load = () =>
    void api.sessions().then(
      (r) => setSessions(r.sessions),
      () => undefined,
    );
  useEffect(load, []);
  return (
    <>
      {sessions.map((s) => (
        <Line key={s.id} label={s.current ? t("thisBrowser") : (s.client ?? "")}>
          {s.current ? s.client : t("lastActive", { time: formatTime(s.lastSeenAt) })}
        </Line>
      ))}
      {sessions.length > 1 && (
        <div class="row-actions" style={{ margin: "12px 0" }}>
          <button type="button" class="btn small" onClick={() => void api.revokeOtherSessions().then(load)}>
            {t("signOutOthers")}
          </button>
        </div>
      )}
    </>
  );
}

const PAIRING_SCHEME = "quancard://pair/v1";

function Devices() {
  const store = vault.value;
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof api.devices>>["devices"]>([]);
  const [asking, setAsking] = useState(false);
  const [pairing, setPairing] = useState<{ payload: string; code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    void api.devices().then(
      (r) => setDevices(r.devices),
      () => undefined,
    );
  useEffect(load, []);

  const start = async (secrets: Secrets) => {
    setAsking(false);
    if (!store) return;
    try {
      const { code, expiresAt } = await api.createPairing(store.vaultID, secrets.authKey);
      // The vault key is added here, in the browser; the server only ever saw the one-time code.
      const params = new URLSearchParams({ host: location.origin, code, key: recoveryCode(store.syncMaterial()) });
      setPairing({ payload: `${PAIRING_SCHEME}?${params.toString()}`, code, expiresAt });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const close = () => {
    setPairing(null);
    load();
  };

  return (
    <>
      {devices.length === 0 && <Line label={t("devices")}>{t("noDevices")}</Line>}
      {devices.map((d) => (
        <Line
          key={d.deviceID}
          label={d.name}
          action={
            <button type="button" class="btn small" title={t("revokeLead")} onClick={() => void api.revokeDevice(d.deviceID).then(load)}>
              {t("revoke")}
            </button>
          }
        >
          {t("pairedOn", { time: formatTime(d.createdAt) })}
          {d.lastSeenAt ? ` · ${t("lastActive", { time: formatTime(d.lastSeenAt) })}` : ""}
        </Line>
      ))}
      <div class="row-actions" style={{ margin: "12px 0" }}>
        <button type="button" class="btn small" disabled={!store} onClick={() => (setError(""), setAsking(true))}>
          {t("pairIphone")}
        </button>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <PasswordDialog open={asking} title={t("pairIphone")} onClose={() => setAsking(false)} onConfirmed={start} />
      <PairingFlow pairing={pairing} onClose={close} />
    </>
  );
}

function Members() {
  const [link, setLink] = useState<string | null>(null);
  const create = async () => {
    const { code } = await api.invite();
    // The code travels in the fragment, which browsers never send to the server.
    setLink(`${location.origin}/#invite=${code}`);
  };
  return (
    <>
      <Line label={t("members")}>{t("inviteNote")}</Line>
      <div class="row-actions" style={{ margin: "12px 0" }}>
        <button type="button" class="btn small" onClick={() => void create()}>
          {t("inviteMember")}
        </button>
      </div>
      {link && (
        <div style={{ paddingBottom: "12px" }}>
          <p class="help">{t("inviteCreated")}</p>
          <p class="mono-wrap">{link}</p>
        </div>
      )}
    </>
  );
}

function Activity() {
  const [events, setEvents] = useState<Awaited<ReturnType<typeof api.audit>>["events"]>([]);
  useEffect(
    () =>
      void api.audit().then(
        (r) => setEvents(r.events.slice(0, 30)),
        () => undefined,
      ),
    [],
  );
  if (!events.length) return <Line label={t("activity")}>{t("noActivity")}</Line>;
  return (
    <>
      {events.map((e) => (
        <Line key={e.id} label={formatTime(e.at)}>
          {t(`event.${e.event}` as MessageKey)}
          {e.client ? <span class="row-sub"> · {e.client}</span> : null}
        </Line>
      ))}
    </>
  );
}

function DeleteAccount() {
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [asking, setAsking] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const remove = async () => {
    if (!secrets) return;
    try {
      await api.deleteAccount(secrets.authKey, confirm);
      await signOut().catch(() => undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <>
      <Line
        label={t("deleteAccount")}
        action={
          <button type="button" class="btn small danger" onClick={() => setAsking(true)}>
            {t("delete")}
          </button>
        }
      >
        {t("deleteAccountLead")}
      </Line>
      <PasswordDialog open={asking} title={t("deleteAccount")} onClose={() => setAsking(false)} onConfirmed={(s) => (setAsking(false), setSecrets(s))} />
      <Dialog open={secrets !== null} onClose={() => setSecrets(null)} title={t("deleteAccount")}>
        <p class="lead">{t("deleteAccountLead")}</p>
        <Field label={t("username")}>
          <input class="input" autocomplete="off" value={confirm} onInput={(e) => setConfirm(e.currentTarget.value)} />
        </Field>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="row-actions">
          <button type="button" class="btn danger solid" disabled={confirm !== account.value?.username} onClick={() => void remove()}>
            {t("deleteAccountConfirm")}
          </button>
          <button type="button" class="btn" onClick={() => setSecrets(null)}>
            {t("cancel")}
          </button>
        </div>
      </Dialog>
    </>
  );
}

function SampleData() {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  void revision.value;
  const count = vault.value?.items().filter((e) => isSample(e.item)).length ?? 0;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      showToast(errorMessage(e) || t("errGeneric"));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <>
      <div class="setting-block">
        <p class="muted">{t("samplesLead")}</p>
        <div class="row-actions">
          <button type="button" class="btn small" disabled={busy} onClick={() => void run(loadSampleData)}>
            <Icon name="sparkle" /> {t("loadSamples")}
          </button>
          {count > 0 && (
            <button type="button" class="btn small danger" disabled={busy} onClick={() => setConfirm(true)}>
              <Icon name="trash" /> {t("removeSamples")}
            </button>
          )}
        </div>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={t("removeSamplesTitle")}>
        <p class="lead">{t("removeSamplesLead")}</p>
        <div class="row-actions">
          <button type="button" class="btn danger solid" disabled={busy} onClick={() => void run(removeSampleData)}>
            {t("removeSamples")} ({count})
          </button>
          <button type="button" class="btn" onClick={() => setConfirm(false)}>
            {t("cancel")}
          </button>
        </div>
      </Dialog>
    </>
  );
}

export function SettingsView({ version }: { version: string }) {
  const store = vault.value;
  const view = store?.view;
  const [message, setMessage] = useState("");
  return (
    <main class="page settings-page">
      <header class="topbar">
        <button type="button" class="icon-btn" aria-label={t("back")} onClick={goBack}>
          <Icon name="back" />
        </button>
        <h1 class="title">{t("settings")}</h1>
      </header>
      {message && (
        <p class="notice" role="status">
          {message}
        </p>
      )}

      <Section title={t("account")}>
        <Line
          label={t("username")}
          action={
            <button type="button" class="btn small" onClick={() => void signOut()}>
              {t("signOut")}
            </button>
          }
        >
          {account.value?.username}
        </Line>
        <Line
          label={t("language")}
          action={
            <button type="button" class="btn small" onClick={() => setLocale(locale.value === "zh" ? "en" : "zh")}>
              {locale.value === "zh" ? "English" : "简体中文"}
            </button>
          }
        >
          {locale.value === "zh" ? "简体中文" : "English"}
        </Line>
      </Section>

      <Section title={t("security")}>
        <Line
          label={t("autoLock")}
          action={
            <select
              class="input compact-select"
              aria-label={t("autoLock")}
              value={autoLockMinutes.value}
              onChange={(e) => setAutoLock(Number(e.currentTarget.value))}
            >
              {AUTO_LOCK_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {t("autoLockAfter", { n })}
                </option>
              ))}
            </select>
          }
        >
          <span class="muted">{t("autoLockHelp")}</span>
        </Line>
        <Line label={t("password")} action={<ChangePassword onDone={setMessage} />}>
          {account.value ? formatTime(account.value.passwordChangedAt) : ""}
        </Line>
        <TwoFactor />
        <h3 class="section-label" style={{ marginTop: "20px" }}>
          {t("sessions")}
        </h3>
        <Sessions />
      </Section>

      <Section title={t("devices")}>
        <Devices />
      </Section>

      <Section title={t("samplesSection")}>
        <SampleData />
      </Section>

      {view && (
        <Section title={t("vaultSection")}>
          <Line label={t("vaultID")}>
            <span class="mono-wrap">{view.vaultID}</span>
          </Line>
          <Line label={t("storage")}>
            {t("revisions", { n: view.revisionCount, max: view.quota.revisionCount })} ·{" "}
            {t("bytes", { used: formatBytes(view.totalBytes), max: formatBytes(view.quota.totalBytes) })}
            <span class="meter" aria-hidden="true">
              <span
                style={{ width: `${Math.min(100, Math.max(view.revisionCount / view.quota.revisionCount, view.totalBytes / view.quota.totalBytes) * 100)}%` }}
              />
            </span>
          </Line>
          <Line label={t("protocol")}>envelope v1 · sync v1 · AES-256-GCM · Argon2id</Line>
        </Section>
      )}

      {account.value?.isOwner && (
        <Section title={t("members")}>
          <Members />
        </Section>
      )}

      <Section title={t("activity")}>
        <Activity />
      </Section>

      <Section title={t("about")}>
        <Line label={t("version_", { v: "" }).trim()}>{version}</Line>
        <Line label={t("about")}>{t("aboutLead")}</Line>
        <Line label={t("security")}>{t("threatNote")}</Line>
        <Line label={t("sourceCode")}>
          <a href="https://github.com/zoolapp/quancard-server" rel="noopener noreferrer" target="_blank">
            github.com/zoolapp/quancard-server
          </a>
        </Line>
      </Section>

      <Section title={t("dangerZone")}>
        <DeleteAccount />
      </Section>

      <p class="footer">{t("disclaimer")}</p>
    </main>
  );
}
