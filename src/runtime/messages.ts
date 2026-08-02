import type { LoginItem, ProviderAccount, ProviderConflict, ProviderConflictResolution, ProviderDiagnosticExport, VaultItem } from "../core/model";
import type { ProviderAttachmentMutationResult, ProviderAttachmentPage, ProviderAttachmentReadBeginResult, ProviderAttachmentReadChunk, ProviderAttachmentUploadBeginResult, ProviderAttachmentUploadChunkResult } from "../providers/attachments/attachment-contract";
import type { Mdbx2CollectionMutationResult, Mdbx2CollectionSummaryPage, Mdbx2CommitDiffResult, Mdbx2CommitHistoryPage, Mdbx2CommitRevertResult, Mdbx2ConflictResolutionChoice, Mdbx2ConflictResolutionResult, Mdbx2ConflictSummaryPage, Mdbx2HostStatus, Mdbx2ManagedSnapshotPage, Mdbx2ObjectDeleteResult, Mdbx2ObjectRecord, Mdbx2ObjectSummaryPage, Mdbx2ObjectUpsertInput, Mdbx2ObjectWriteResult, Mdbx2SnapshotCreateResult, Mdbx2SnapshotDeleteResult, Mdbx2SnapshotPrunePlan, Mdbx2SnapshotPruneResult, Mdbx2SnapshotRestoreResult, Mdbx2SnapshotStructurePage, Mdbx2SnapshotStructureSide, Mdbx2TransferBeginResult, Mdbx2TransferChunkResult, Mdbx2TransferFinishResult, Mdbx2VaultCredential, Mdbx2VaultDiagnosticsReport, Mdbx2VaultInspection, Mdbx2VaultRuntimeStatus, Mdbx2VaultSessionSummary, Mdbx2VaultSource, Mdbx2VaultTigaPosture } from "../providers/mdbx2/native-contract";
import type { KeePassSessionSummary } from "../providers/keepass/keepass-provider";
import type { KeePassGroupMutationResult, KeePassGroupPage } from "../providers/keepass/keepass-groups";
import type { MonicaWebDavConfig } from "../providers/webdav/monica-webdav-provider";
import type { SteamInventoryOverview, SteamInventoryPage, SteamMarketListingsPage, SteamMarketQuote, SteamMarketSellBatchResult, SteamMarketSellEntry, SteamMiniProfileBackground } from "../providers/steam/steam-market";
import type { SteamAuthorizedDevice } from "../providers/steam/steam-network";
import type { EncryptedVaultBackup, VaultLifecycleStatus } from "../security/secure-vault-service";

export interface LoginMatchSummary {
  id: string;
  title: string;
  username: string;
  favorite: boolean;
  uris: string[];
  hasTotp: boolean;
}

export interface PasskeyMatchSummary {
  id: string;
  title: string;
  userName: string;
  userDisplayName: string;
  sourceMode: "browser-local" | "bitwarden" | "android-metadata-only";
  availability: "ready" | "android-metadata-only" | "missing-private-key" | "unsupported-algorithm";
  discoverable: boolean;
  lastUsedAt?: string;
  useCount: number;
}

export type WalletFillKind = "identity" | "billing-address" | "card" | "payment-account";

export type WalletFieldName =
  | "fullName" | "firstName" | "middleName" | "lastName" | "birthDate" | "nationality" | "documentNumber"
  | "documentType" | "documentIssuedDate" | "documentExpiryDate" | "documentIssuedBy" | "passportNumber" | "licenseNumber" | "ssn"
  | "company" | "streetAddress" | "apartment" | "city" | "stateProvince" | "postalCode" | "country" | "phone" | "email"
  | "cardholderName" | "cardNumber" | "cardExpiryMonth" | "cardExpiryYear" | "cardExpiry" | "cardSecurityCode" | "cardBrand" | "cardPin"
  | "paymentProvider" | "paymentAccountName" | "paymentAccountHolder" | "paymentUsername" | "paymentAccountId"
  | "paymentAccountNumber" | "routingNumber" | "iban" | "swiftBic" | "branchCode" | "currency";

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

export interface SteamConfirmation {
  id: string;
  nonce: string;
  type: string;
  headline: string;
  summary: string;
  imageUrl: string;
  creationTime: number;
}

export interface SteamPendingLogin {
  clientId: number;
  version: number;
  ip: string;
  city: string;
  country: string;
  deviceName: string;
}

export type PasskeyRequest =
  | { operation: "create"; challenge: string; rpId?: string; rpName: string; userId: string; userName: string; userDisplayName: string; algorithms: number[]; excludeCredentialIds: string[]; discoverable?: boolean; userVerificationRequired?: boolean; credProps?: boolean; timeoutMs?: number }
  | { operation: "get"; challenge: string; rpId?: string; allowCredentialIds: string[]; userVerification?: "required" | "preferred" | "discouraged"; timeoutMs?: number };

export interface PasskeyPromptContext {
  candidateId: string;
  operation: "create" | "get";
  rpId: string;
  rpName: string;
  origin: string;
  userName: string;
  userDisplayName?: string;
  saveTargets: Array<{ providerId: string; name: string; sourceMode: "browser-local" | "bitwarden" }>;
  defaultSaveTargetId?: string;
  credentials: Array<{ itemId: string; title: string; userName: string; userDisplayName: string; sourceMode: "browser-local" | "bitwarden"; useCount: number; lastUsedAt?: string }>;
  expiresAt: number;
}

export type PasskeyResult =
  | { operation: "create"; id: string; rawId: string; response: { clientDataJSON: string; attestationObject: string; authenticatorData: string; publicKey: string; publicKeyAlgorithm: -7 }; clientExtensionResults: { credProps?: { rk: boolean } } }
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

export interface SavePromptUpdateTarget {
  id: string;
  title: string;
  username: string;
  providerName: string;
}

export interface SavePromptContext {
  candidateId: string;
  action: "save" | "update" | "choose";
  title: string;
  username: string;
  host: string;
  existingItemId?: string;
  existingTitle?: string;
  updateTargets: SavePromptUpdateTarget[];
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

export interface Mdbx2VaultOpenInput {
  providerId?: string;
  name: string;
  source: Mdbx2VaultSource;
  credential: Mdbx2VaultCredential;
  isDefaultSaveTarget?: boolean;
}

export interface Mdbx2WebDavSettingsInput {
  baseUrl: string;
  username: string;
  password: string;
  remotePath: string;
}

export interface Mdbx2ManagerSyncStatus {
  configured: boolean;
  registered: boolean;
  initialized: boolean;
  hasLocalChanges: boolean;
  pendingBootstrap: boolean;
  pendingSegment: boolean;
  pendingRemoteAcknowledgement: boolean;
  remoteStreamCount: number;
  blockedStreamCount: number;
  blobTransferCount: number;
  verifiedRemoteBlobCount: number;
}

/**
 * A `.kdbx` file the user picks in an extension page, so the bytes travel as Base64 through the
 * runtime channel. Neither the password nor the key file is persisted: the unlocked session lives in
 * the background worker only, and locking the vault drops it. The password may be empty when the
 * database is protected by a key file alone.
 */
export interface KeePassOpenInput {
  providerId?: string;
  name: string;
  fileName: string;
  /** Base64 of the whole `.kdbx` file. */
  file: string;
  password: string;
  /** Base64 of the key file, when the database uses one. */
  keyFile?: string;
  isDefaultSaveTarget?: boolean;
}

/**
 * Writes stay in memory until the user exports. The browser cannot hold a writable handle to the
 * picked file across a service-worker restart, so the user saves this back over the original.
 */
export interface KeePassFileExport {
  fileName: string;
  /** Base64 of the re-encrypted `.kdbx` file. */
  file: string;
}

export type ExtensionRequest =
  | { type: "VAULT_STATUS" }
  | { type: "VAULT_SETUP"; masterPassword: string }
  | { type: "VAULT_UNLOCK"; masterPassword: string }
  | { type: "VAULT_LOCK" }
  | { type: "VAULT_CHANGE_MASTER_PASSWORD"; currentPassword: string; newPassword: string }
  | { type: "VAULT_EXPORT_ENCRYPTED"; backupPassword: string }
  | { type: "VAULT_RESTORE_ENCRYPTED"; backup: EncryptedVaultBackup; backupPassword: string; replaceExisting?: boolean; currentPassword?: string }
  | { type: "VAULT_IMPORT_ITEMS"; items: VaultItem[] }
  | { type: "VAULT_LIST_ITEMS" }
  | { type: "VAULT_GET_ITEM"; itemId: string }
  | { type: "VAULT_UPSERT_ITEM"; item: VaultItem }
  | { type: "VAULT_DELETE_ITEM"; itemId: string }
  | { type: "VAULT_MATCH_LOGINS"; pageUrl: string }
  | { type: "VAULT_MATCH_PASSKEYS"; pageUrl: string }
  | { type: "VAULT_FILL_LOGIN"; itemId: string; tabId: number; frameId?: number; documentId?: string; expectedOrigin?: string }
  | { type: "VAULT_LIST_WALLET_ITEMS"; kinds: WalletFillKind[] }
  | { type: "VAULT_FILL_WALLET"; itemId: string; tabId: number; frameId?: number; documentId?: string; expectedOrigin?: string }
  | { type: "STEAM_LIST_CONFIRMATIONS"; itemId: string }
  | { type: "STEAM_RESPOND_CONFIRMATION"; itemId: string; confirmation: SteamConfirmation; accept: boolean }
  | { type: "STEAM_LIST_PENDING_LOGINS"; itemId: string }
  | { type: "STEAM_RESPOND_LOGIN"; itemId: string; login: Pick<SteamPendingLogin, "clientId" | "version">; approve: boolean }
  | { type: "STEAM_LIST_AUTHORIZED_DEVICES"; itemId: string }
  | { type: "STEAM_GET_INVENTORY_OVERVIEW"; itemId: string }
  | { type: "STEAM_LIST_INVENTORY_ITEMS"; itemId: string; appId: number; contextId: string; language?: string; startAssetId?: string; count?: number }
  | { type: "STEAM_GET_MARKET_QUOTE"; itemId: string; appId: number; marketHashName: string; currency: number; points?: number }
  | { type: "STEAM_LIST_MARKET_LISTINGS"; itemId: string; language?: string; start?: number; count?: number }
  | { type: "STEAM_SELL_MARKET_ITEMS"; itemId: string; entries: SteamMarketSellEntry[]; autoConfirm?: boolean; confirmed: true }
  | { type: "STEAM_CANCEL_MARKET_LISTING"; itemId: string; listingId: string; confirmed: true }
  | { type: "STEAM_GET_MINI_PROFILE_BACKGROUND"; itemId: string }
  | { type: "STEAM_REVOKE_AUTHORIZED_DEVICE"; itemId: string; tokenId: string; accountName: string; password: string; confirmed: true }
  | { type: "CREDENTIAL_USERNAME_REMEMBER"; username: string }
  | { type: "CREDENTIAL_CAPTURE"; candidate: CredentialCaptureInput }
  | { type: "CREDENTIAL_PENDING" }
  | { type: "CREDENTIAL_ACCEPT"; candidateId: string; providerId?: string; existingItemId?: string }
  | { type: "CREDENTIAL_DISMISS"; candidateId: string }
  | { type: "PASSKEY_BEGIN"; request: PasskeyRequest }
  | { type: "PASSKEY_ACCEPT"; candidateId: string; itemId?: string; providerId?: string }
  | { type: "PASSKEY_DISMISS"; candidateId: string }
  | { type: "PROVIDER_LIST" }
  | { type: "PROVIDER_QUEUE_STATUS" }
  | { type: "PROVIDER_CONFLICT_LIST"; providerId?: string }
  | { type: "PROVIDER_CONFLICT_RESOLVE"; conflictId: string; resolution: ProviderConflictResolution }
  | { type: "PROVIDER_DIAGNOSTIC_EXPORT" }
  | { type: "WEBDAV_TEST"; providerId?: string; config: MonicaWebDavConfig }
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
  | { type: "MDBX2_HOST_STATUS" }
  | { type: "MDBX2_TRANSFER_BEGIN"; sizeBytes: number; sha256?: string }
  | { type: "MDBX2_TRANSFER_CHUNK"; transferId: string; offset: number; dataBase64: string }
  | { type: "MDBX2_TRANSFER_FINISH"; transferId: string }
  | { type: "MDBX2_TRANSFER_ABORT"; transferId: string }
  | { type: "MDBX2_FILE_RELEASE"; fileHandle: string }
  | { type: "MDBX2_VAULT_INSPECT"; source: Mdbx2VaultSource }
  | { type: "MDBX2_VAULT_OPEN"; input: Mdbx2VaultOpenInput }
  | { type: "MDBX2_VAULT_STATUS"; providerId: string }
  | { type: "MDBX2_VAULT_DIAGNOSTICS"; providerId: string }
  | { type: "MDBX2_VAULT_TIGA"; providerId: string }
  | { type: "MDBX2_VAULT_LOCK"; providerId: string }
  | { type: "MDBX2_WEBDAV_SAVE"; providerId: string; name: string; config: Mdbx2WebDavSettingsInput; isDefaultSaveTarget?: boolean }
  | { type: "MDBX2_BOOTSTRAP_DOWNLOAD"; config: Mdbx2WebDavSettingsInput }
  | { type: "MDBX2_BOOTSTRAP_PUBLISH"; providerId: string }
  | { type: "MDBX2_BOOTSTRAP_REGISTER"; providerId: string }
  | { type: "MDBX2_SYNC_STATUS"; providerId: string }
  | { type: "MDBX2_COLLECTION_LIST"; providerId: string; deleted?: boolean; excludeRoot?: boolean; pageSize?: number; cursor?: string }
  | { type: "MDBX2_COLLECTION_CREATE"; providerId: string; operationId: string; collectionId: string; title: string; parentCollectionId?: string }
  | { type: "MDBX2_COLLECTION_RENAME"; providerId: string; operationId: string; collectionId: string; title: string }
  | { type: "MDBX2_COLLECTION_MOVE"; providerId: string; operationId: string; collectionId: string; parentCollectionId?: string }
  | { type: "MDBX2_COLLECTION_DELETE"; providerId: string; operationId: string; collectionId: string; confirmed: true }
  | { type: "MDBX2_COLLECTION_RESTORE"; providerId: string; operationId: string; collectionId: string; parentCollectionId?: string }
  | { type: "MDBX2_OBJECT_LIST"; providerId: string; collectionId: string; objectTypeId?: string; deleted?: boolean; pageSize?: number; cursor?: string }
  | { type: "MDBX2_OBJECT_REVEAL"; providerId: string; objectId: string }
  | { type: "MDBX2_OBJECT_UPSERT"; providerId: string; operationId: string; input: Mdbx2ObjectUpsertInput }
  | { type: "MDBX2_OBJECT_DELETE"; providerId: string; operationId: string; logicalObjectId: string }
  | { type: "MDBX2_HISTORY_LIST"; providerId: string; pageSize?: number; cursor?: string }
  | { type: "MDBX2_HISTORY_DIFF"; providerId: string; commitId: string }
  | { type: "MDBX2_HISTORY_REVERT"; providerId: string; operationId: string; commitId: string }
  | { type: "MDBX2_SNAPSHOT_LIST"; providerId: string; pageSize?: number; cursor?: string }
  | { type: "MDBX2_SNAPSHOT_STRUCTURE"; providerId: string; snapshotId: string; side: Mdbx2SnapshotStructureSide; pageSize?: number; cursor?: string }
  | { type: "MDBX2_SNAPSHOT_PRUNE_PLAN"; providerId: string; keepLatest: number }
  | { type: "MDBX2_SNAPSHOT_PRUNE_EXECUTE"; providerId: string; planToken: string; keepLatest: number }
  | { type: "MDBX2_SNAPSHOT_CREATE"; providerId: string; operationId: string; name: string }
  | { type: "MDBX2_SNAPSHOT_DELETE"; providerId: string; operationId: string; snapshotId: string }
  | { type: "MDBX2_SNAPSHOT_RESTORE"; providerId: string; operationId: string; snapshotId: string }
  | { type: "MDBX2_CONFLICT_LIST"; providerId: string; pageSize?: number; cursor?: string }
  | { type: "MDBX2_CONFLICT_RESOLVE"; providerId: string; operationId: string; conflictId: string; choice: Mdbx2ConflictResolutionChoice }
  | { type: "PROVIDER_ATTACHMENT_LIST"; providerId: string; itemId: string; pageSize?: number; cursor?: string }
  | { type: "PROVIDER_ATTACHMENT_READ_BEGIN"; providerId: string; itemId: string; attachmentId: string }
  | { type: "PROVIDER_ATTACHMENT_READ_CHUNK"; providerId: string; readHandle: string; offset: number; maxBytes?: number }
  | { type: "PROVIDER_ATTACHMENT_READ_RELEASE"; providerId: string; readHandle: string }
  | { type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN"; providerId: string; itemId: string; fileName: string; mediaType?: string; sizeBytes: number; sha256?: string; replaceExisting?: boolean; operationId?: string; attachmentId?: string }
  | { type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK"; providerId: string; transferId: string; offset: number; dataBase64: string }
  | { type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH"; providerId: string; itemId: string; transferId: string }
  | { type: "PROVIDER_ATTACHMENT_UPLOAD_ABORT"; providerId: string; transferId: string }
  | { type: "PROVIDER_ATTACHMENT_DELETE"; providerId: string; itemId: string; attachmentId: string; confirmed: boolean }
  | { type: "KEEPASS_OPEN"; input: KeePassOpenInput }
  | { type: "KEEPASS_STATUS"; providerId: string }
  | { type: "KEEPASS_GROUP_LIST"; providerId: string; includeRecycleBin?: boolean; pageSize?: number; cursor?: string }
  | { type: "KEEPASS_GROUP_CREATE"; providerId: string; operationId: string; name: string; parentGroupId?: string }
  | { type: "KEEPASS_GROUP_RENAME"; providerId: string; operationId: string; groupId: string; name: string }
  | { type: "KEEPASS_GROUP_MOVE"; providerId: string; operationId: string; groupId: string; targetParentGroupId?: string }
  | { type: "KEEPASS_GROUP_DELETE"; providerId: string; operationId: string; groupId: string; confirmed: boolean }
  | { type: "KEEPASS_GROUP_RESTORE"; providerId: string; operationId: string; groupId: string; targetParentGroupId?: string }
  | { type: "KEEPASS_EXPORT_FILE"; providerId: string }
  | { type: "KEEPASS_LOCK"; providerId?: string }
  | { type: "PROVIDER_SYNC"; providerId: string }
  | { type: "PROVIDER_SYNC_CANCEL"; providerId: string }
  | { type: "PROVIDER_REMOVE"; providerId: string };

export type ExtensionResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export type VaultStatusResponse = VaultLifecycleStatus;

// Type-only re-exports keep UI imports centered on the runtime contract.
export type { LoginItem, ProviderAccount, ProviderConflict, ProviderConflictResolution, ProviderDiagnosticExport, VaultItem };
export type { ProviderAttachmentMutationResult, ProviderAttachmentPage, ProviderAttachmentReadBeginResult, ProviderAttachmentReadChunk, ProviderAttachmentUploadBeginResult, ProviderAttachmentUploadChunkResult };
export type { Mdbx2CollectionMutationResult, Mdbx2CollectionSummaryPage, Mdbx2CommitDiffResult, Mdbx2CommitHistoryPage, Mdbx2CommitRevertResult, Mdbx2ConflictResolutionChoice, Mdbx2ConflictResolutionResult, Mdbx2ConflictSummaryPage, Mdbx2HostStatus, Mdbx2ManagedSnapshotPage, Mdbx2ObjectDeleteResult, Mdbx2ObjectRecord, Mdbx2ObjectSummaryPage, Mdbx2ObjectUpsertInput, Mdbx2ObjectWriteResult, Mdbx2SnapshotCreateResult, Mdbx2SnapshotDeleteResult, Mdbx2SnapshotPrunePlan, Mdbx2SnapshotPruneResult, Mdbx2SnapshotRestoreResult, Mdbx2SnapshotStructurePage, Mdbx2SnapshotStructureSide, Mdbx2TransferBeginResult, Mdbx2TransferChunkResult, Mdbx2TransferFinishResult, Mdbx2VaultCredential, Mdbx2VaultDiagnosticsReport, Mdbx2VaultInspection, Mdbx2VaultRuntimeStatus, Mdbx2VaultSessionSummary, Mdbx2VaultSource, Mdbx2VaultTigaPosture, KeePassSessionSummary };
export type { KeePassGroupMutationResult, KeePassGroupPage };
export type { SteamAuthorizedDevice, SteamInventoryOverview, SteamInventoryPage, SteamMarketListingsPage, SteamMarketQuote, SteamMarketSellBatchResult, SteamMarketSellEntry, SteamMiniProfileBackground };
