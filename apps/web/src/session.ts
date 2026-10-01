import { signal } from "@preact/signals";
import {
  type AccountSecrets,
  base64,
  bytesEqual,
  deriveAccountSecrets,
  ProtocolError,
  randomBytes,
  randomUUID,
  unwrapAccountKey,
  unwrapVaultKey,
  wrapAccountKey,
} from "@quancard/protocol";
import { type AccountView, api } from "./api.js";
import { argon2id } from "./kdf.js";
import { VaultStore } from "./vault.js";

/**
 * Key lifecycle. Key material lives only in memory (non-extractable CryptoKeys
 * where WebCrypto allows) and is dropped on lock: after 5 minutes idle, after
 * 60 seconds in the background, on sign-out and on page unload. Nothing secret
 * is written to localStorage, sessionStorage, IndexedDB or cookies.
 */

export type Phase = "loading" | "setup" | "signIn" | "unlock" | "ready";

export const phase = signal<Phase>("loading");
export const account = signal<AccountView | null>(null);
export const vault = signal<VaultStore | null>(null);
/** Bumped whenever vault contents change so views re-project. */
export const revision = signal(0);
export const setupEnabled = signal(false);

let accountKey: CryptoKey | null = null;
/** SHA-256 of the authKey from the last successful unlock, for local re-verification only. */
let authCheck: Uint8Array | null = null;

const IDLE_MS = 5 * 60 * 1000;
const BACKGROUND_MS = 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let hiddenAt: number | null = null;

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

export async function boot(): Promise<void> {
  try {
    const status = await api.status();
    setupEnabled.value = status.setupEnabled;
    if (status.setupRequired) {
      phase.value = "setup";
      return;
    }
  } catch {
    phase.value = "signIn";
    return;
  }
  try {
    account.value = await api.account();
    phase.value = "unlock";
  } catch {
    phase.value = "signIn";
  }
}

export async function deriveFor(password: string, saltB64: string): Promise<AccountSecrets> {
  return deriveAccountSecrets(password, base64.decode(saltB64, 16), argon2id);
}

async function finishUnlock(view: AccountView, secrets: AccountSecrets): Promise<void> {
  const { key, raw } = await unwrapAccountKey(base64.decode(view.wrappedAccountKey), view.accountID, secrets.kek);
  raw.fill(0);
  accountKey = key;
  authCheck = await digest(secrets.authKey);
  account.value = view;
  await openDefaultVault();
  phase.value = "ready";
  armIdleTimer();
}

export async function openDefaultVault(): Promise<void> {
  if (!accountKey) throw new ProtocolError("invalidData");
  const { vaults } = await api.vaults();
  const first = vaults[0];
  vault.value?.close();
  if (!first) {
    vault.value = null;
    return;
  }
  const material = await unwrapVaultKey(base64.decode(first.wrappedKey), first.vaultID, accountKey);
  vault.value = await VaultStore.open(first, material);
  revision.value++;
}

export async function createVault(imported?: { vaultID: string; key: Uint8Array }): Promise<void> {
  if (!accountKey) throw new ProtocolError("invalidData");
  const material = imported ?? { vaultID: randomUUID(), key: randomBytes(32) };
  await VaultStore.create(accountKey, material);
  await openDefaultVault();
}

export async function signIn(username: string, password: string, secondFactor?: { totp?: string; recoveryCode?: string }): Promise<void> {
  const { kdf } = await api.prelogin(username);
  const secrets = await deriveFor(password, kdf.salt);
  const view = await api.login({ username, authKey: base64.encode(secrets.authKey), ...secondFactor });
  await finishUnlock(view, secrets);
}

export async function unlock(password: string): Promise<void> {
  const view = await api.account();
  const secrets = await deriveFor(password, view.kdf.salt);
  await finishUnlock(view, secrets);
}

/** Registration (owner setup or invite): keys are generated and wrapped in the browser. */
export async function register(kind: "setup" | "invite", code: string, username: string, password: string): Promise<void> {
  const salt = randomBytes(16);
  const secrets = await deriveAccountSecrets(password, salt, argon2id);
  const accountID = randomUUID();
  const raw = randomBytes(32);
  const fields = {
    username,
    accountID,
    kdfSalt: base64.encode(salt),
    authKey: base64.encode(secrets.authKey),
    wrappedAccountKey: base64.encode(await wrapAccountKey(raw, accountID, secrets.kek)),
  };
  raw.fill(0);
  const view = kind === "setup" ? await api.setup({ ...fields, setupToken: code }) : await api.register({ ...fields, inviteCode: code });
  await finishUnlock(view, secrets);
}

/**
 * Fresh proof of the password for sensitive actions (reveal, pairing,
 * password change). Verified locally first; the authKey is returned for
 * endpoints that also check it server-side.
 */
export async function confirmPassword(password: string): Promise<AccountSecrets> {
  const view = account.value;
  if (!view || !authCheck) throw new ProtocolError("invalidData");
  const secrets = await deriveFor(password, view.kdf.salt);
  if (!bytesEqual(await digest(secrets.authKey), authCheck)) throw new ProtocolError("integrityFailure");
  return secrets;
}

export function currentAccountKey(): CryptoKey {
  if (!accountKey) throw new ProtocolError("invalidData");
  return accountKey;
}

export function lock(): void {
  vault.value?.close();
  vault.value = null;
  accountKey = null;
  authCheck = null;
  clearTimeout(idleTimer);
  revision.value++;
  if (phase.value === "ready") phase.value = "unlock";
}

export async function signOut(): Promise<void> {
  lock();
  try {
    await api.logout();
  } finally {
    account.value = null;
    phase.value = "signIn";
  }
}

function armIdleTimer(): void {
  clearTimeout(idleTimer);
  if (phase.value === "ready") idleTimer = setTimeout(lock, IDLE_MS);
}

export function installLifecycleGuards(): void {
  for (const event of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(event, armIdleTimer, { passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      document.documentElement.dataset.privacy = "on";
    } else {
      if (hiddenAt !== null && Date.now() - hiddenAt > BACKGROUND_MS) lock();
      hiddenAt = null;
      delete document.documentElement.dataset.privacy;
    }
  });
  window.addEventListener("pagehide", lock);
}
