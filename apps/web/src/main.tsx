import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AppShell, Sheet } from "./components/shell.js";
import { locale, setLocale, t } from "./i18n.js";
import { resetRoute, route } from "./router.js";
import { boot, installLifecycleGuards, phase, setupEnabled, vault } from "./session.js";
import { NoVaultView, RegisterView, SignInView, UnlockView } from "./views/auth.js";
import { ConflictsView } from "./views/conflicts.js";
import { EditorView } from "./views/editor.js";
import { HomeView } from "./views/home.js";
import { ItemView } from "./views/item.js";
import { SettingsView } from "./views/settings.js";
import "./styles.css";

declare const __APP_VERSION__: string;

function inviteFromFragment(): string | null {
  const match = /^#invite=([A-Za-z0-9_-]{16,64})$/.exec(location.hash);
  return match?.[1] ?? null;
}

function App() {
  const [invite, setInvite] = useState(inviteFromFragment);
  useEffect(() => {
    // An invite link pasted into an already open tab only changes the fragment.
    const onHash = () => setInvite(inviteFromFragment());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    setLocale(locale.value);
    installLifecycleGuards();
    void boot();
  }, []);
  useEffect(() => {
    if (phase.value !== "ready") resetRoute();
  }, [phase.value]);

  if (phase.value === "loading") return <main class="boot" aria-busy="true" />;
  if (invite && phase.value === "signIn") return <RegisterView kind="invite" inviteCode={invite} />;
  if (phase.value === "setup") return setupEnabled.value ? <RegisterView kind="setup" /> : <SignInView />;
  if (phase.value === "signIn") return <SignInView />;
  if (phase.value === "unlock") return <UnlockView />;
  if (!vault.value) return <NoVaultView />;

  const current = route.value;
  // Detail and editor open as a sheet over the collection; Settings replaces it.
  const overlay =
    current.name === "item" ? (
      <Sheet label={t("details")} key={current.itemID}>
        <ItemView itemID={current.itemID} />
      </Sheet>
    ) : current.name === "edit" ? (
      <Sheet
        label={current.itemID ? t("edit") : current.kind === "paymentCard" ? t("addCard") : t("addAccount")}
        key={`edit-${current.itemID ?? current.kind}`}
      >
        <EditorView itemID={current.itemID} kind={current.kind} />
      </Sheet>
    ) : undefined;
  return (
    <AppShell overlay={overlay}>
      {current.name === "settings" ? <SettingsView version={__APP_VERSION__} /> : current.name === "conflicts" ? <ConflictsView /> : <HomeView />}
    </AppShell>
  );
}

render(<App />, document.getElementById("app") as HTMLElement);
