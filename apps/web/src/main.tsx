import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { locale, setLocale } from "./i18n.js";
import { resetRoute, route } from "./router.js";
import { boot, installLifecycleGuards, phase, setupEnabled, vault } from "./session.js";
import { NoVaultView, RegisterView, SignInView, UnlockView } from "./views/auth.js";
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
  const [invite] = useState(inviteFromFragment);
  useEffect(() => {
    setLocale(locale.value);
    installLifecycleGuards();
    void boot();
  }, []);
  useEffect(() => {
    if (phase.value !== "ready") resetRoute();
  }, [phase.value]);

  if (phase.value === "loading") return <main class="narrow" aria-busy="true" />;
  if (invite && phase.value === "signIn") return <RegisterView kind="invite" inviteCode={invite} />;
  if (phase.value === "setup") return setupEnabled.value ? <RegisterView kind="setup" /> : <SignInView />;
  if (phase.value === "signIn") return <SignInView />;
  if (phase.value === "unlock") return <UnlockView />;
  if (!vault.value) return <NoVaultView />;

  const current = route.value;
  switch (current.name) {
    case "item":
      return <ItemView itemID={current.itemID} />;
    case "edit":
      return <EditorView itemID={current.itemID} kind={current.kind} />;
    case "settings":
      return <SettingsView version={__APP_VERSION__} />;
    default:
      return <HomeView />;
  }
}

render(<App />, document.getElementById("app") as HTMLElement);
