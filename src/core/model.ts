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

export type LoginUriMatchType = "base-domain" | "domain" | "starts-with" | "exact" | "regex" | "never";

export interface LoginUriRule {
  uri: string;
  matchType: LoginUriMatchType;
}

export interface SecureCustomField {
  name: string;
  value: string;
  protected: boolean;
  type?: "text" | "hidden" | "boolean";
}

export interface ProviderSourceRecord {
  providerId: string;
  itemId?: string;
  remoteId: string;
  revision?: string;
  format: "android-entry" | "bitwarden-cipher";
  encoding: "base64" | "json";
  payload: string;
  contentHash: string;
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
  archivedAt?: string;
  categoryId?: number;
  categoryName?: string;
  sortOrder?: number;
  imagePaths?: string[];
  providerRefs: ProviderReference[];
}

export interface LoginItem extends VaultItemBase {
  kind: "login";
  username: string;
  password: string;
  uris: string[];
  uriRules?: LoginUriRule[];
  totpSecret?: string;
  customFields: SecureCustomField[];
  loginType?: "PASSWORD" | "SSO" | "WIFI" | "SSH" | "BARCODE";
  ssoProvider?: string;
  ssoRefEntryId?: number;
  appPackageName?: string;
  appName?: string;
  email?: string;
  phone?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  passkeyBindings?: string;
  sshKeyData?: string;
  wifiMetadata?: string;
  barcodeData?: string;
  customIconType?: string;
  customIconValue?: string;
  customIconUpdatedAt?: number;
}

export interface SecureNoteItem extends VaultItemBase {
  kind: "secure-note";
  content: string;
  tags?: string[];
  isMarkdown?: boolean;
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
  steamId?: string;
  steamAccessToken?: string;
  steamRefreshToken?: string;
  steamLoginSecure?: string;
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
  bankName?: string;
  cardType?: "CREDIT" | "DEBIT" | "PREPAID";
  billingAddress?: string;
  nickname?: string;
  validFromMonth?: string;
  validFromYear?: string;
  pin?: string;
  iban?: string;
  swiftBic?: string;
  routingNumber?: string;
  accountNumber?: string;
  branchCode?: string;
  currency?: string;
  customerServicePhone?: string;
  customFields?: SecureCustomField[];
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
  additionalInfo?: string;
  company?: string;
  username?: string;
  ssn?: string;
  passportNumber?: string;
  licenseNumber?: string;
  address3?: string;
  email?: string;
  phone?: string;
  address?: Partial<AddressFields>;
  customFields?: SecureCustomField[];
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
  isDefault?: boolean;
  customFields?: SecureCustomField[];
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
  linkedCardLast4?: string;
  routingNumber: string;
  iban: string;
  swiftBic: string;
  website: string;
  currency: string;
  billingAddress?: string;
  isDefault?: boolean;
  customFields?: SecureCustomField[];
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
  userVerificationRequired?: boolean;
  transports?: string[];
  aaguid?: string;
  lastUsedAt?: string;
  useCount?: number;
  iconUrl?: string;
  boundPasswordId?: number;
  passkeyMode?: "LEGACY" | "BW_COMPAT" | "KEEPASS_COMPAT";
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
  schemaVersion: 2;
  createdAt: string;
  updatedAt: string;
  items: VaultItem[];
  providers: ProviderAccount[];
  mutationQueue: PendingMutation[];
  providerConflicts: ProviderConflict[];
  providerDiagnostics: ProviderDiagnostic[];
  sourceRecords: ProviderSourceRecord[];
  settings: {
    autoLockMinutes: number;
    defaultProviderId: string;
    protectionMode: "master-password" | "device-key";
  };
}

export function createEmptyVaultState(now = new Date().toISOString()): VaultState {
  const localProviderId = crypto.randomUUID();
  return {
    magic: "MONICA_EXTENSION_VAULT",
    schemaVersion: 2,
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
    sourceRecords: [],
    settings: {
      autoLockMinutes: 15,
      defaultProviderId: localProviderId,
      protectionMode: "master-password"
    }
  };
}

export function createLoginItem(input: {
  title: string;
  username?: string;
  password?: string;
  uris?: string[];
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
    password: input.password || "",
    uris: normalizeUris(input.uris || []),
    uriRules: normalizeUris(input.uris || []).map((uri) => ({ uri, matchType: "base-domain" })),
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
