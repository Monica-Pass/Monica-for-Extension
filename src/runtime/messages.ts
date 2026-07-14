import type { LoginItem, ProviderAccount, VaultItem } from "../core/model";
import type { MonicaWebDavConfig } from "../providers/webdav/monica-webdav-provider";
import type { VaultLifecycleStatus } from "../security/secure-vault-service";

export interface LoginMatchSummary {
  id: string;
  title: string;
  username: string;
  favorite: boolean;
  uris: string[];
  hasTotp: boolean;
}

export type BitwardenConnectResult =
  | { status: "authenticated"; providerId: string }
  | { status: "two-factor-required"; providers: number[] };

export interface SavePromptProviderSummary {
  id: string;
  name: string;
  kind: ProviderAccount["kind"];
  isDefault: boolean;
}

export interface SavePromptContext {
  candidateId: string;
  action: "save" | "update";
  title: string;
  username: string;
  host: string;
  existingItemId?: string;
  existingTitle?: string;
  providers: SavePromptProviderSummary[];
  defaultProviderId: string;
  expiresAt: number;
}

export interface CredentialCaptureInput {
  username: string;
  password: string;
  pageUrl: string;
  pageTitle: string;
  captureKind: "login" | "password-change";
}

export type ExtensionRequest =
  | { type: "VAULT_STATUS" }
  | { type: "VAULT_SETUP"; masterPassword: string }
  | { type: "VAULT_UNLOCK"; masterPassword: string }
  | { type: "VAULT_LOCK" }
  | { type: "VAULT_LIST_ITEMS" }
  | { type: "VAULT_GET_ITEM"; itemId: string }
  | { type: "VAULT_UPSERT_ITEM"; item: VaultItem }
  | { type: "VAULT_DELETE_ITEM"; itemId: string }
  | { type: "VAULT_MATCH_LOGINS"; pageUrl: string }
  | { type: "VAULT_FILL_LOGIN"; itemId: string; tabId: number; frameId?: number }
  | { type: "CREDENTIAL_CAPTURE"; candidate: CredentialCaptureInput }
  | { type: "CREDENTIAL_PENDING" }
  | { type: "CREDENTIAL_ACCEPT"; candidateId: string; providerId?: string }
  | { type: "CREDENTIAL_DISMISS"; candidateId: string }
  | { type: "PROVIDER_LIST" }
  | { type: "WEBDAV_TEST"; config: MonicaWebDavConfig }
  | { type: "WEBDAV_SAVE"; providerId?: string; name: string; config: MonicaWebDavConfig; isDefaultSaveTarget?: boolean }
  | {
      type: "BITWARDEN_LOGIN";
      providerId?: string;
      name: string;
      vaultUrl: string;
      email: string;
      masterPassword: string;
      twoFactorCode?: string;
      twoFactorProvider?: number;
      rememberTwoFactor?: boolean;
      isDefaultSaveTarget?: boolean;
    }
  | { type: "BITWARDEN_SEND_EMAIL_CODE"; providerId?: string; vaultUrl: string; email: string; masterPassword: string }
  | { type: "PROVIDER_SYNC"; providerId: string }
  | { type: "PROVIDER_REMOVE"; providerId: string };

export type ExtensionResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export type VaultStatusResponse = VaultLifecycleStatus;

// Type-only re-exports keep UI imports centered on the runtime contract.
export type { LoginItem, ProviderAccount, VaultItem };
