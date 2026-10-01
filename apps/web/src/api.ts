import { base64 } from "@quancard/protocol";

/** Same-origin JSON API client. Cookies are HttpOnly; the client header satisfies the server's CSRF check. */

export class APIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

async function call<T>(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<T> {
  const headers: Record<string, string> = { "X-QuanCard-Client": "web" };
  let payload: BodyInit | undefined;
  if (raw) {
    headers["Content-Type"] = "application/octet-stream";
    payload = new Blob([raw as Uint8Array<ArrayBuffer>]);
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(path, { method, headers, body: payload, credentials: "same-origin", cache: "no-store", redirect: "error" });
  } catch {
    throw new APIError(0, "network");
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const data = type.includes("json") ? ((await response.json()) as Record<string, unknown>) : {};
    throw new APIError(response.status, typeof data.error === "string" ? data.error : "http", data);
  }
  if (type.includes("application/octet-stream")) return new Uint8Array(await response.arrayBuffer()) as T;
  return (await response.json()) as T;
}

export interface KDFDescriptor {
  algorithm: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  outputBytes: number;
  normalization: string;
  salt: string;
}

export interface AccountView {
  accountID: string;
  username: string;
  isOwner: boolean;
  kdf: KDFDescriptor;
  wrappedAccountKey: string;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  createdAt: number;
  passwordChangedAt: number;
}

export interface VaultView {
  vaultID: string;
  wrappedKey: string;
  createdAt: number;
  modifiedAt: number;
  revisionCount: number;
  totalBytes: number;
  lastSeq: number;
  quota: { revisionCount: number; totalBytes: number };
}

export interface RevisionPage {
  revisions: { revisionID: string; seq: number; createdAt: number; body: string }[];
  nextAfter: number;
  hasMore: boolean;
  lastSeq: number;
  modifiedAt: number;
}

export const api = {
  status: () => call<{ version: string; setupRequired: boolean; setupEnabled: boolean }>("GET", "/api/v1/status"),
  setup: (body: Record<string, string>) => call<AccountView>("POST", "/api/v1/setup", body),
  register: (body: Record<string, string>) => call<AccountView>("POST", "/api/v1/register", body),
  prelogin: (username: string) => call<{ kdf: KDFDescriptor }>("POST", "/api/v1/auth/prelogin", { username }),
  login: (body: Record<string, string>) => call<AccountView>("POST", "/api/v1/auth/login", body),
  logout: () => call<void>("POST", "/api/v1/auth/logout", {}),
  account: () => call<AccountView>("GET", "/api/v1/account"),
  changePassword: (body: Record<string, string>) => call<AccountView>("POST", "/api/v1/account/password", body),
  totpSetup: (authKey: Uint8Array) => call<{ otpauthURI: string }>("POST", "/api/v1/account/totp/setup", { authKey: base64.encode(authKey) }),
  totpEnable: (code: string) => call<{ recoveryCodes: string[] }>("POST", "/api/v1/account/totp/enable", { code }),
  totpDisable: (authKey: Uint8Array, totp: string) => call<void>("POST", "/api/v1/account/totp/disable", { authKey: base64.encode(authKey), totp }),
  sessions: () =>
    call<{ sessions: { id: string; current: boolean; createdAt: number; lastSeenAt: number; client: string | null }[] }>("GET", "/api/v1/account/sessions"),
  revokeOtherSessions: () => call<{ revoked: number }>("POST", "/api/v1/account/sessions/revoke-others", {}),
  audit: () => call<{ events: { id: number; at: number; event: string; client: string | null }[] }>("GET", "/api/v1/account/audit"),
  deleteAccount: (authKey: Uint8Array, confirm: string) => call<void>("DELETE", "/api/v1/account", { authKey: base64.encode(authKey), confirm }),
  invite: () => call<{ code: string; expiresAt: number }>("POST", "/api/v1/invites", {}),
  vaults: () => call<{ vaults: VaultView[] }>("GET", "/api/v1/vaults"),
  createVault: (vaultID: string, manifest: Uint8Array, wrappedKey: Uint8Array) =>
    call<VaultView>("POST", "/api/v1/vaults", { vaultID, manifest: base64.encode(manifest), wrappedKey: base64.encode(wrappedKey) }),
  manifest: (vaultID: string) => call<Uint8Array>("GET", `/api/v1/vaults/${vaultID}/manifest`),
  revisions: (vaultID: string, after: number) => call<RevisionPage>("GET", `/api/v1/vaults/${vaultID}/revisions?after=${after}`),
  putRevision: (vaultID: string, revisionID: string, bytes: Uint8Array) =>
    call<{ revisionID: string; seq: number }>("PUT", `/api/v1/vaults/${vaultID}/revisions/${revisionID}`, undefined, bytes),
  createPairing: (vaultID: string, authKey: Uint8Array) =>
    call<{ code: string; expiresAt: number }>("POST", `/api/v1/vaults/${vaultID}/pairings`, { authKey: base64.encode(authKey) }),
  devices: () =>
    call<{ devices: { deviceID: string; vaultID: string; name: string; createdAt: number; lastSeenAt: number | null }[] }>("GET", "/api/v1/devices"),
  revokeDevice: (deviceID: string) => call<void>("DELETE", `/api/v1/devices/${deviceID}`),
};
