import { parseRecoveryCode, passwordMeetsPolicy } from "@quancard/protocol";
import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import { APIError } from "../api.js";
import guardianURL from "../assets/otter-guardian.webp";
import { OtterMark } from "../components/shell.js";
import { Busy, CardFace, errorMessage, Field, Icon } from "../components/ui.js";
import { sampleItems, seedSamples, welcomeItem } from "../demo.js";
import { locale, setLocale, t } from "../i18n.js";
import { account, createVault, register, revision, signIn, signOut, unlock, vault } from "../session.js";

function Lockup() {
  return (
    <div class="lockup">
      <OtterMark size={52} />
      <div>
        <div class="wordmark">QuanCard</div>
        <div class="lockup-sub">{t("brandTagline")}</div>
      </div>
    </div>
  );
}

function LanguageSwitch() {
  return (
    <button type="button" class="link-btn quiet" onClick={() => setLocale(locale.value === "zh" ? "en" : "zh")}>
      <Icon name="globe" /> {locale.value === "zh" ? "English" : "简体中文"}
    </button>
  );
}

/** Three original faces fanned out: the welcome card and two issuer palettes. No user data. */
function HeroCards() {
  const faces = useMemo(() => {
    const items = sampleItems(locale.value);
    return [items[5], items[1], items[0]].filter((item): item is NonNullable<typeof item> => !!item);
  }, [locale.value]);
  return (
    <div class="hero-cards" aria-hidden="true">
      {faces.map((item, index) => (
        <div key={item.id} class={`hero-card hero-card-${index}`}>
          <CardFace item={item} artwork={null} showSuffix={false} />
        </div>
      ))}
    </div>
  );
}

function Shell({ children, art = "cards" }: { children: ComponentChildren; art?: "cards" | "guardian" }) {
  return (
    <div class="auth">
      <aside class="auth-hero">
        <div class="auth-hero-inner">
          <Lockup />
          {art === "guardian" ? <img class="hero-guardian" src={guardianURL} alt="" width={420} height={420} /> : <HeroCards />}
          <h2 class="hero-title">{t("heroTitle")}</h2>
          <p class="hero-lead">{t("heroLead")}</p>
          <ul class="features">
            {(
              [
                ["shield", "feature1", "feature1Lead"],
                ["phone", "feature2", "feature2Lead"],
                ["globe", "feature3", "feature3Lead"],
              ] as const
            ).map(([icon, title, lead]) => (
              <li key={title}>
                <span class="feature-icon">
                  <Icon name={icon} />
                </span>
                <span>
                  <strong>{t(title)}</strong>
                  <span>{t(lead)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main class="auth-main">
        <div class="auth-panel">
          <div class="auth-mobile-brand">
            <Lockup />
          </div>
          {children}
        </div>
        <footer class="auth-foot">
          <LanguageSwitch />
          <span>{t("disclaimer")}</span>
        </footer>
      </main>
    </div>
  );
}

function ErrorLine({ error }: { error: string }) {
  return error ? (
    <p class="error" role="alert">
      {error}
    </p>
  ) : null;
}

/** Owner setup (first run) and invite registration share one form. */
export function RegisterView({ kind, inviteCode }: { kind: "setup" | "invite"; inviteCode?: string }) {
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: Event) => {
    event.preventDefault();
    setError("");
    if (!passwordMeetsPolicy(password)) return setError(t("errPasswordPolicy"));
    if (password !== confirm) return setError(t("errPasswordMismatch"));
    setBusy(true);
    try {
      await register(kind, kind === "setup" ? token.trim() : (inviteCode ?? ""), username.trim(), password);
      if (kind === "invite") history.replaceState(null, "", "/");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 class="page-title">{kind === "setup" ? t("setupTitle") : t("inviteTitle")}</h1>
      <p class="lead">{kind === "setup" ? t("setupLead") : t("inviteLead")}</p>
      <form onSubmit={submit}>
        {kind === "setup" && (
          <Field label={t("setupToken")} help={t("setupTokenHelp")}>
            <input class="input mono" autocomplete="off" spellcheck={false} value={token} onInput={(e) => setToken(e.currentTarget.value)} required />
          </Field>
        )}
        <Field label={t("username")}>
          <input
            class="input"
            autocomplete="username"
            autocapitalize="none"
            spellcheck={false}
            value={username}
            onInput={(e) => setUsername(e.currentTarget.value)}
            required
          />
        </Field>
        <Field label={t("password")} help={t("passwordHelp")}>
          <input class="input" type="password" autocomplete="new-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} required />
        </Field>
        <Field label={t("confirmPassword")}>
          <input class="input" type="password" autocomplete="new-password" value={confirm} onInput={(e) => setConfirm(e.currentTarget.value)} required />
        </Field>
        <div class="notice warn">{t("passwordWarning")}</div>
        <label class="check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.currentTarget.checked)} />
          <span>{t("passwordWarningAck")}</span>
        </label>
        <ErrorLine error={error} />
        <button type="submit" class="btn primary block" disabled={busy || !ack}>
          <Busy busy={busy}>{t("createAccount")}</Busy>
        </button>
      </form>
    </Shell>
  );
}

export function SignInView() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [second, setSecond] = useState<"none" | "totp" | "recovery">("none");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const factor = second === "totp" ? { totp: code.replace(/\s/g, "") } : second === "recovery" ? { recoveryCode: code } : undefined;
      await signIn(username.trim(), password, factor);
    } catch (e) {
      if (e instanceof APIError && e.code === "secondFactorRequired") {
        setSecond("totp");
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 class="page-title">{t("signInTitle")}</h1>
      <form onSubmit={submit}>
        <Field label={t("username")}>
          <input
            class="input"
            autocomplete="username"
            autocapitalize="none"
            spellcheck={false}
            value={username}
            onInput={(e) => setUsername(e.currentTarget.value)}
            required
          />
        </Field>
        <Field label={t("password")}>
          <input class="input" type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} required />
        </Field>
        {second !== "none" && (
          <>
            <Field label={second === "totp" ? t("totpCode") : t("recoveryCode")}>
              <input
                class="input mono"
                inputMode={second === "totp" ? "numeric" : "text"}
                autocomplete="one-time-code"
                value={code}
                onInput={(e) => setCode(e.currentTarget.value)}
                required
                // biome-ignore lint/a11y/noAutofocus: the field appears in response to the user's own submit
                autoFocus
              />
            </Field>
            <button type="button" class="link-btn" onClick={() => (setSecond(second === "totp" ? "recovery" : "totp"), setCode(""))}>
              {second === "totp" ? t("useRecoveryCode") : t("useTotp")}
            </button>
          </>
        )}
        <ErrorLine error={error} />
        <div class="row-actions">
          <button type="submit" class="btn primary block" disabled={busy}>
            <Busy busy={busy}>{t("signIn")}</Busy>
          </button>
        </div>
      </form>
    </Shell>
  );
}

export function UnlockView() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await unlock(password);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPassword("");
      setBusy(false);
    }
  };
  const name = account.value?.username ?? "";
  return (
    <Shell art="guardian">
      <div class="unlock-head">
        <span class="avatar large" aria-hidden="true">
          {Array.from(name || "?")[0]?.toUpperCase()}
        </span>
        <div>
          <h1 class="page-title">{t("welcomeBack")}</h1>
          <p class="lead tight">{t("signedInAs", { name })}</p>
        </div>
      </div>
      <p class="lead">{t("unlockLead")}</p>
      <form onSubmit={submit}>
        <input type="text" class="visually-hidden" autocomplete="username" value={name} readOnly tabIndex={-1} aria-hidden="true" />
        <Field label={t("password")}>
          <input
            class="input"
            type="password"
            autocomplete="current-password"
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
            required
            // biome-ignore lint/a11y/noAutofocus: the lock screen has exactly one thing to do
            autoFocus
          />
        </Field>
        <ErrorLine error={error} />
        <button type="submit" class="btn primary block" disabled={busy || !password}>
          <Busy busy={busy}>
            <Icon name="lock" /> {t("unlock")}
          </Busy>
        </button>
      </form>
      <button type="button" class="link-btn" onClick={() => void signOut()}>
        {t("notYou")}
      </button>
    </Shell>
  );
}

export function NoVaultView() {
  const [mode, setMode] = useState<"choose" | "import">("choose");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const importCode = () => {
    let material: ReturnType<typeof parseRecoveryCode>;
    try {
      material = parseRecoveryCode(code.trim());
    } catch {
      setError(t("errRecoveryCode"));
      return;
    }
    setCode("");
    void run(() => createVault(material));
  };
  const createNew = () =>
    run(async () => {
      await createVault();
      // A new vault starts with the welcome card, like a fresh iPhone install. Imports start as they are.
      const store = vault.value;
      if (store) {
        await seedSamples(store, [welcomeItem(locale.value)]);
        revision.value++;
      }
    });
  return (
    <Shell>
      <h1 class="page-title">{t("noVaultTitle")}</h1>
      <p class="lead">{t("noVaultLead")}</p>
      {mode === "choose" ? (
        <div class="choices">
          <button type="button" class="choice" disabled={busy} onClick={() => void createNew()}>
            <span class="choice-icon" aria-hidden="true">
              {busy ? <span class="spinner" /> : <Icon name="sparkle" />}
            </span>
            <span class="choice-text">
              <strong>{t("createVault")}</strong>
              <span>{t("createVaultLead")}</span>
            </span>
            <Icon name="chevron" />
          </button>
          <button type="button" class="choice" disabled={busy} onClick={() => setMode("import")}>
            <span class="choice-icon" aria-hidden="true">
              <Icon name="refresh" />
            </span>
            <span class="choice-text">
              <strong>{t("importVault")}</strong>
              <span>{t("importVaultLead")}</span>
            </span>
            <Icon name="chevron" />
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            importCode();
          }}
        >
          <p class="lead">{t("importLead")}</p>
          <Field label={t("recoveryCode")}>
            <input class="input mono" autocomplete="off" spellcheck={false} value={code} onInput={(e) => setCode(e.currentTarget.value)} required />
          </Field>
          <div class="row-actions">
            <button type="submit" class="btn primary" disabled={busy}>
              {t("import")}
            </button>
            <button type="button" class="btn" onClick={() => setMode("choose")}>
              {t("back")}
            </button>
          </div>
        </form>
      )}
      <ErrorLine error={error} />
      <button type="button" class="link-btn" onClick={() => void signOut()}>
        {t("signOut")}
      </button>
    </Shell>
  );
}
