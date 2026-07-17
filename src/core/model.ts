export type VaultItemKind =
  | "login"
  | "secure-note"
  | "totp"
  | "card"
  | "identity"
  | "billing-address"
  | "payment-account"
  | "passkey";

export type ProviderKind = "local" | "monica-webdav" | "bitwarden";

export interface ProviderReference {
  providerId: string;
  remoteId?: string;
  remoteFolderId?: string;
  revision?: string;
  etag?: string;
}

export interface VaultItemBase {
  id: string;
  kind: VaultItemKind;
  title: string;
  favorite: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  providerRefs: ProviderReference[];
}

export interface LoginItem extends VaultItemBase {
  kind: "login";
  username: string;
  password: string;
  uris: string[];
  totpSecret?: string;
  customFields: Array<{ name: string; value: string; protected: boolean }>;
}

export interface SecureNoteItem extends VaultItemBase {
  kind: "secure-note";
  content: string;
}

export interface TotpItem extends VaultItemBase {
  kind: "totp";
  secret: string;
  issuer?: string;
  accountName?: string;
  /** Monica Android's OTP discriminator. STEAM uses the Steam Guard alphabet. */
  otpType?: "TOTP" | "HOTP" | "STEAM" | "YANDEX" | "MOTP";
  counter?: number;
  pin?: string;
  link?: string;
  associatedApp?: string;
  customIconType?: string;
  customIconValue?: string;
  customIconUpdatedAt?: number;
  boundPasswordId?: number;
  categoryId?: number;
  keepassDatabaseId?: number;
  steamFingerprint?: string;
  steamDeviceId?: string;
  steamSerialNumber?: string;
  steamSharedSecretBase64?: string;
  steamRevocationCode?: string;
  steamIdentitySecret?: string;
  steamTokenGid?: string;
  steamRawJson?: string;
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: number;
  period: number;
}

export interface CardItem extends VaultItemBase {
  kind: "card";
  cardholderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  securityCode: string;
  brand?: string;
  billingAddressId?: string;
}

export interface IdentityItem extends VaultItemBase {
  kind: "identity";
  documentType: "ID_CARD" | "PASSPORT" | "DRIVER_LICENSE" | "SOCIAL_SECURITY" | "OTHER";
  documentNumber: string;
  firstName: string;
  middleName: string;
  lastName: string;
  fullName: string;
  birthDate?: string;
  issuedDate?: string;
  expiryDate?: string;
  issuedBy?: string;
  nationality?: string;
  email?: string;
  phone?: string;
  address?: Partial<AddressFields>;
}

export interface AddressFields {
  fullName: string;
  company: string;
  streetAddress: string;
  apartment: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
}

export interface BillingAddressItem extends VaultItemBase, AddressFields {
  kind: "billing-address";
}

export interface PaymentAccountItem extends VaultItemBase {
  kind: "payment-account";
  paymentType: string;
  provider: string;
  accountName: string;
  accountHolderName: string;
  email: string;
  phone: string;
  username: string;
  accountId: string;
  maskedAccountNumber: string;
  routingNumber: string;
  iban: string;
  swiftBic: string;
  website: string;
  currency: string;
}

export interface PasskeyItem extends VaultItemBase {
  kind: "passkey";
  credentialId: string;
  rpId: string;
  rpName: string;
  userHandle: string;
  userName: string;
  userDisplayName: string;
  algorithm: -7 | -257 | -37 | -8;
  publicKey: string;
  privateKeyPkcs8?: string;
  signCount: number;
  discoverable: boolean;
  sourceMode: "browser-local" | "bitwarden" | "android-metadata-only";
}

export type VaultItem = LoginItem | SecureNoteItem | TotpItem | CardItem | IdentityItem | BillingAddressItem | PaymentAccountItem | PasskeyItem;

export interface ProviderAccount {
  id: string;
  kind: ProviderKind;
  name: string;
  enabled: boolean;
  isDefaultSaveTarget: boolean;
  config: Record<string, unknown>;
  lastSyncAt?: string;
  lastError?: string;
}

export interface PendingMutation {
  id: string;
  providerId: string;
  itemId: string;
  operation: "create" | "update" | "delete";
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface ProviderConflictInput {
  itemId: string;
  reason: string;
  local?: VaultItem;
  remote?: VaultItem;
}

export interface ProviderConflict extends ProviderConflictInput {
  id: string;
  providerId: string;
  detectedAt: string;
}

export type ProviderConflictResolution = "keep-local" | "use-remote";

export interface ProviderDiagnostic {
  at: string;
  providerRef: string;
  kind: ProviderKind;
  operation: string;
  outcome: "success" | "conflict" | "failure" | "cancelled";
  code: string;
  status?: number;
  retryable: boolean;
  attempts: number;
  retryAfterMs?: number;
  durationMs?: number;
  conflicts?: number;
  warnings?: number;
  message: string;
}

export interface ProviderDiagnosticExport {
  magic: "MONICA_PROVIDER_DIAGNOSTICS";
  version: 1;
  generatedAt: string;
  summary: {
    total: number;
    successes: number;
    conflicts: number;
    failures: number;
    cancellations: number;
  };
  diagnostics: ProviderDiagnostic[];
}

export interface VaultState {
  magic: "MONICA_EXTENSION_VAULT";
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  items: VaultItem[];
  providers: ProviderAccount[];
  mutationQueue: PendingMutation[];
  providerConflicts: ProviderConflict[];
  providerDiagnostics: ProviderDiagnostic[];
  settings: {
    autoLockMinutes: number;
    defaultProviderId: string;
  };
}

export function createEmptyVaultState(now = new Date().toISOString()): VaultState {
  const localProviderId = crypto.randomUUID();
  return {
    magic: "MONICA_EXTENSION_VAULT",
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    items: [],
    providers: [
      {
        id: localProviderId,
        kind: "local",
        name: "Monica 本地库",
        enabled: true,
        isDefaultSaveTarget: true,
        config: {}
      }
    ],
    mutationQueue: [],
    providerConflicts: [],
    providerDiagnostics: [],
    settings: {
      autoLockMinutes: 15,
      defaultProviderId: localProviderId
    }
  };
}

export function createLoginItem(input: {
  title: string;
  username?: string;
  password: string;
  uris: string[];
  notes?: string;
  favorite?: boolean;
  providerRefs?: ProviderReference[];
}): LoginItem {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind: "login",
    title: input.title.trim() || "未命名登录项",
    username: input.username?.trim() || "",
    password: input.password,
    uris: normalizeUris(input.uris),
    notes: input.notes?.trim() || "",
    favorite: Boolean(input.favorite),
    customFields: [],
    providerRefs: input.providerRefs || [],
    createdAt: now,
    updatedAt: now
  };
}

export function isLoginItem(item: VaultItem): item is LoginItem {
  return item.kind === "login" && !item.deletedAt;
}

export function normalizeUris(uris: string[]): string[] {
  return [...new Set(uris.map((uri) => uri.trim()).filter(Boolean))];
}
