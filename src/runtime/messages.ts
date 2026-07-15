import type { LoginItem, ProviderAccount, VaultItem } from "../core/model";
import type { MonicaWebDavConfig } from "../providers/webdav/monica-webdav-provider";
import type { EncryptedVaultBackup, VaultLifecycleStatus } from "../security/secure-vault-service";

export interface LoginMatchSummary {
  id: string;
  title: string;
  username: string;
  favorite: boolean;
  uris: string[];
  hasTotp: boolean;
}

export type WalletFillKind = "identity" | "billing-address" | "card" | "payment-account";

export type WalletFieldName =
  | "fullName" | "firstName" | "middleName" | "lastName" | "birthDate" | "nationality" | "documentNumber"
  | "company" | "streetAddress" | "apartment" | "city" | "stateProvince" | "postalCode" | "country" | "phone" | "email"
  | "cardholderName" | "cardNumber" | "cardExpiryMonth" | "cardExpiryYear" | "cardExpiry" | "cardSecurityCode" | "cardBrand"
  | "paymentProvider" | "paymentAccountName" | "paymentAccountHolder" | "paymentUsername" | "paymentAccountId"
  | "paymentAccountNumber" | "routingNumber" | "iban" | "swiftBic" | "currency";

export interface WalletMatchSummary {
  id: string;
  kind: WalletFillKind;
  title: string;
  subtitle: string;
  favorite: boolean;
  sensitive: boolean;
}

export interface WalletFillPayload {
  kind: WalletFillKind;
  fields: Partial<Record<WalletFieldName, string>>;
}

export interface WalletFillResult {
  filledCount: number;
  filledFields: WalletFieldName[];
}

export type PasskeyRequest =
  | { operation: "create"; challenge: string; rpId?: string; rpName: string; userId: string; userName: string; userDisplayName: string; algorithms: number[]; excludeCredentialIds: string[] }
  | { operation: "get"; challenge: string; rpId?: string; allowCredentialIds: string[] };

export interface PasskeyPromptContext {
  candidateId: string;
  operation: "create" | "get";
  rpId: string;
  rpName: string;
  userName: string;
  saveTargetName?: string;
  credentials: Array<{ itemId: string; title: string; userName: string; sourceMode: "browser-local" | "bitwarden" }>;
  expiresAt: number;
}

export type PasskeyResult =
  | { operation: "create"; id: string; rawId: string; response: { clientDataJSON: string; attestationObject: string; authenticatorData: string; publicKey: string; publicKeyAlgorithm: -7 } }
  | { operation: "get"; id: string; rawId: string; response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string } };

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
  | { type: "VAULT_CHANGE_MASTER_PASSWORD"; currentPassword: string; newPassword: string }
  | { type: "VAULT_EXPORT_ENCRYPTED" }
  | { type: "VAULT_RESTORE_ENCRYPTED"; backup: EncryptedVaultBackup; backupPassword: string; replaceExisting?: boolean; currentPassword?: string }
  | { type: "VAULT_IMPORT_ITEMS"; items: VaultItem[] }
  | { type: "VAULT_LIST_ITEMS" }
  | { type: "VAULT_GET_ITEM"; itemId: string }
  | { type: "VAULT_UPSERT_ITEM"; item: VaultItem }
  | { type: "VAULT_DELETE_ITEM"; itemId: string }
  | { type: "VAULT_MATCH_LOGINS"; pageUrl: string }
  | { type: "VAULT_FILL_LOGIN"; itemId: string; tabId: number; frameId?: number }
  | { type: "VAULT_LIST_WALLET_ITEMS"; kinds: WalletFillKind[] }
  | { type: "VAULT_FILL_WALLET"; itemId: string; tabId: number; frameId?: number }
  | { type: "CREDENTIAL_CAPTURE"; candidate: CredentialCaptureInput }
  | { type: "CREDENTIAL_PENDING" }
  | { type: "CREDENTIAL_ACCEPT"; candidateId: string; providerId?: string }
  | { type: "CREDENTIAL_DISMISS"; candidateId: string }
  | { type: "PASSKEY_BEGIN"; request: PasskeyRequest }
  | { type: "PASSKEY_ACCEPT"; candidateId: string; itemId?: string }
  | { type: "PASSKEY_DISMISS"; candidateId: string }
  | { type: "PROVIDER_LIST" }
  | { type: "PROVIDER_QUEUE_STATUS" }
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
