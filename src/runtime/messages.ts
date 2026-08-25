import type { LoginItem, ProviderAccount, ProviderConflict, ProviderConflictResolution, ProviderDiagnosticExport, VaultItem } from "../core/model";
import type { BlockedFieldSignatureRecord } from "../autofill/field-policy";
import type { ProviderAttachmentMutationResult, ProviderAttachmentPage, ProviderAttachmentReadBeginResult, ProviderAttachmentReadChunk, ProviderAttachmentUploadBeginResult, ProviderAttachmentUploadChunkResult } from "../providers/attachments/attachment-contract";
import type { ProviderAttachmentTransferRequest, ProviderAttachmentTransferResult } from "../providers/attachments/attachment-transfer";
import type { Mdbx2CollectionMutationResult, Mdbx2CollectionSummaryPage, Mdbx2CommitDiffResult, Mdbx2CommitHistoryPage, Mdbx2CommitRevertResult, Mdbx2ConflictResolutionChoice, Mdbx2ConflictResolutionResult, Mdbx2ConflictSummaryPage, Mdbx2HealthRepairApplyResult, Mdbx2HealthRepairDecision, Mdbx2HealthRepairPlan, Mdbx2HostStatus, Mdbx2ManagedSnapshotPage, Mdbx2ObjectDeleteResult, Mdbx2ObjectRecord, Mdbx2ObjectSummaryPage, Mdbx2ObjectUpsertInput, Mdbx2ObjectWriteResult, Mdbx2SnapshotCreateResult, Mdbx2SnapshotDeleteResult, Mdbx2SnapshotPrunePlan, Mdbx2SnapshotPruneResult, Mdbx2SnapshotRestoreResult, Mdbx2SnapshotStructurePage, Mdbx2SnapshotStructureSide, Mdbx2TransferBeginResult, Mdbx2TransferChunkResult, Mdbx2TransferFinishResult, Mdbx2VaultCredential, Mdbx2VaultDiagnosticsReport, Mdbx2VaultInspection, Mdbx2VaultRuntimeStatus, Mdbx2VaultSessionSummary, Mdbx2VaultSource, Mdbx2VaultTigaPosture, Mdbx2WindowsHelloStatus } from "../providers/mdbx2/native-contract";
import type { Mdbx2BatchTransferExecuteResult, Mdbx2BatchTransferPlanResult, Mdbx2BatchTransferRequest, Mdbx2BatchTransferStatus } from "../providers/mdbx2/mdbx2-batch-transfer-coordinator";
import type { KeePassSessionSummary } from "../providers/keepass/keepass-provider";
import type { KeePassRemoteManagerStatus, KeePassRemoteProbeResult, KeePassWebDavOpenInput } from "../providers/keepass/keepass-remote-session";
import type { KeePassGroupMutationResult, KeePassGroupPage } from "../providers/keepass/keepass-groups";
import type { BitwardenFolderMutationResult, BitwardenFolderPage } from "../providers/bitwarden/bitwarden-folders";
import type { BitwardenCollectionMutationResult, BitwardenCollectionPage } from "../providers/bitwarden/bitwarden-collections";
import type { BitwardenSendDetail, BitwardenSendFileInput, BitwardenSendPage, BitwardenSendTextInput, BitwardenSendUpdateInput } from "../providers/bitwarden/bitwarden-sends";
import type { KeePassHistoryDetail, KeePassHistoryFieldValue, KeePassHistoryPage, KeePassHistoryRestoreResult } from "../providers/keepass/keepass-history";
import type { MonicaWebDavConfig } from "../providers/webdav/monica-webdav-provider";
import type { AndroidGeneratorHistoryEntry, AndroidTimelineEntrySummary } from "../providers/webdav/android-backup-codec";
import type { SteamInventoryOverview, SteamInventoryPage, SteamMarketListingsPage, SteamMarketQuote, SteamMarketSellBatchResult, SteamMarketSellEntry, SteamMiniProfileBackground } from "../providers/steam/steam-market";
import type { SteamAuthorizedDevice } from "../providers/steam/steam-network";
import type { EncryptedVaultBackup, VaultLifecycleStatus } from "../security/secure-vault-service";
import type { AutofillSitePolicy } from "../autofill/site-policy";

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
  userVerificationRequired?: boolean;
  saveTargets: Array<{ providerId: string; name: string; sourceMode: "browser-local" | "bitwarden" }>;
  defaultSaveTargetId?: string;
  credentials: Array<{ itemId: string; title: string; userName: string; userDisplayName: string; sourceMode: "browser-local" | "bitwarden"; providerName: string; credentialConflict: boolean; userVerificationRequired?: boolean; useCount: number; lastUsedAt?: string }>;
  expiresAt: number;
}

export type PasskeyResult =
  | { operation: "create"; id: string; rawId: string; response: { clientDataJSON: string; attestationObject: string; authenticatorData: string; publicKey: string; publicKeyAlgorithm: -7 }; clientExtensionResults: { credProps?: { rk: boolean } } }
  | { operation: "get"; id: string; rawId: string; response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string } };

export type BitwardenConnectResult =
  | { status: "authenticated"; providerId: string }
  | { status: "two-factor-required"; providers: number[]; providerData?: Record<string, unknown> }
  | { status: "device-verification-required" }
  | { status: "sso-required"; organizationIdentifier: string };

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
  fieldSignatures?: string[];
}

export interface VaultWindowsHelloStatus {
  native: Mdbx2WindowsHelloStatus;
  vaultEnrolled: boolean;
  bindingConsistent: boolean;
  protectionMode: "master-password" | "device-key" | "unknown";
  unlockAvailable: boolean;
}

export interface ProviderAttachmentRecoveryRecord {
  operationId: string;
  kind: "upload" | "replace" | "delete";
  stage: string;
  updatedAt: string;
}

export interface ProviderAttachmentRecoveryStatus {
  providerId: string;
  pending: ProviderAttachmentRecoveryRecord[];
  completedCount: number;
}

export interface BitwardenSendFileUploadInput extends Omit<BitwardenSendFileInput, "bytes"> {
  sizeBytes: number;
  sha256?: string;
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

export interface KeePassWebDavTestInput extends Pick<KeePassWebDavOpenInput, "baseUrl" | "username" | "webDavPassword" | "remotePath"> {
  providerId?: string;
}

export interface KeePassRemoteOpenInput extends KeePassWebDavOpenInput {
  providerId?: string;
  name: string;
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
  | { type: "VAULT_UNLOCK_HELLO" }
  | { type: "VAULT_LOCK" }
  | { type: "VAULT_HELLO_STATUS" }
  | { type: "VAULT_HELLO_ENROLL" }
  | { type: "VAULT_HELLO_REVOKE"; confirmed: true }
  | { type: "VAULT_CHANGE_MASTER_PASSWORD"; currentPassword: string; newPassword: string }
  | { type: "VAULT_EXPORT_ENCRYPTED"; backupPassword: string }
  | { type: "VAULT_RESTORE_ENCRYPTED"; backup: EncryptedVaultBackup; backupPassword: string; replaceExisting?: boolean; currentPassword?: string }
  | { type: "VAULT_IMPORT_ITEMS"; items: VaultItem[] }
  | { type: "VAULT_LIST_ITEMS" }
  | { type: "VAULT_LIST_ARCHIVED_ITEMS" }
  | { type: "VAULT_LIST_DELETED_ITEMS" }
  | { type: "VAULT_GET_ITEM"; itemId: string }
  | { type: "VAULT_UPSERT_ITEM"; item: VaultItem }
  | { type: "VAULT_DELETE_ITEM"; itemId: string }
  | { type: "VAULT_RESTORE_ITEM"; itemId: string }
  | { type: "VAULT_MATCH_LOGINS"; pageUrl: string; fieldSignature?: string }
  | { type: "VAULT_LIST_LOGIN_SUMMARIES" }
  | { type: "VAULT_LOGIN_SECRET"; itemId: string; field: "username" | "password" }
  | { type: "VAULT_MATCH_PASSKEYS"; pageUrl: string }
  | { type: "VAULT_FILL_LOGIN"; itemId: string; tabId: number; frameId?: number; documentId?: string; expectedOrigin?: string }
  | { type: "VAULT_LIST_WALLET_ITEMS"; kinds: WalletFillKind[]; pageUrl: string; fieldSignature?: string }
  | { type: "VAULT_FILL_WALLET"; itemId: string; tabId: number; frameId?: number; documentId?: string; expectedOrigin?: string }
  | { type: "AUTOFILL_SITE_POLICY_GET" }
  | { type: "AUTOFILL_SITE_POLICY_SET"; policy: AutofillSitePolicy }
  | { type: "AUTOFILL_FIELD_POLICY_LIST" }
  | { type: "AUTOFILL_FIELD_POLICY_STATUS"; signature: string }
  | { type: "AUTOFILL_FIELD_POLICY_SET_CURRENT"; blocked: boolean; tabId: number; frameId?: number; documentId?: string; expectedOrigin?: string }
  | { type: "AUTOFILL_FIELD_POLICY_REMOVE"; signature: string }
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
      twoFactorProviderData?: Record<string, unknown>;
      rememberTwoFactor?: boolean;
      newDeviceOtp?: string;
      ssoOrganizationIdentifier?: string;
      isDefaultSaveTarget?: boolean;
    }
  | { type: "BITWARDEN_LOGOUT"; providerId: string }
  | { type: "BITWARDEN_SEND_EMAIL_CODE"; providerId?: string; vaultUrl: string; email: string; masterPassword: string }
  | { type: "BITWARDEN_FOLDER_LIST"; providerId: string; pageSize?: number; cursor?: string }
  | { type: "BITWARDEN_FOLDER_CREATE"; providerId: string; name: string }
  | { type: "BITWARDEN_FOLDER_RENAME"; providerId: string; folderId: string; name: string; expectedRevision?: string }
  | { type: "BITWARDEN_FOLDER_DELETE"; providerId: string; folderId: string; expectedRevision?: string; confirmed: boolean }
  | { type: "BITWARDEN_CIPHER_MOVE_FOLDER"; providerId: string; itemId: string; targetFolderId?: string; expectedCipherRevision?: string; expectedTargetFolderRevision?: string }
  | { type: "BITWARDEN_COLLECTION_LIST"; providerId: string; pageSize?: number; cursor?: string }
  | { type: "BITWARDEN_CIPHER_MOVE_COLLECTIONS"; providerId: string; itemId: string; collectionIds: string[]; expectedCipherRevision?: string }
  | { type: "BITWARDEN_SEND_LIST"; providerId: string; pageSize?: number; cursor?: string }
  | { type: "BITWARDEN_SEND_GET"; providerId: string; sendId: string }
  | { type: "BITWARDEN_SEND_CREATE_TEXT"; providerId: string; input: BitwardenSendTextInput }
  | { type: "BITWARDEN_SEND_UPDATE"; providerId: string; input: BitwardenSendUpdateInput }
  | { type: "BITWARDEN_SEND_DELETE"; providerId: string; sendId: string; expectedRevision?: string; confirmed: boolean }
  | { type: "BITWARDEN_SEND_REMOVE_PASSWORD"; providerId: string; sendId: string; expectedRevision?: string; confirmed: boolean }
  | { type: "BITWARDEN_SEND_FILE_UPLOAD_BEGIN"; providerId: string; input: BitwardenSendFileUploadInput }
  | { type: "BITWARDEN_SEND_FILE_UPLOAD_CHUNK"; providerId: string; transferId: string; offset: number; dataBase64: string }
  | { type: "BITWARDEN_SEND_FILE_UPLOAD_FINISH"; providerId: string; transferId: string }
  | { type: "BITWARDEN_SEND_FILE_UPLOAD_ABORT"; providerId: string; transferId: string }
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
  | { type: "MDBX2_HEALTH_REPAIR_PLAN"; providerId: string }
  | { type: "MDBX2_HEALTH_REPAIR_APPLY"; providerId: string; planHandle: string; operationId: string; decisions: Mdbx2HealthRepairDecision[]; confirmedDelete?: true }
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
  | { type: "MDBX2_BATCH_TRANSFER_PLAN"; input: Mdbx2BatchTransferRequest }
  | { type: "MDBX2_BATCH_TRANSFER_EXECUTE"; input: Mdbx2BatchTransferRequest; confirmed?: true }
  | { type: "MDBX2_BATCH_TRANSFER_STATUS"; operationId: string }
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
  | ({ type: "PROVIDER_ATTACHMENT_TRANSFER" } & ProviderAttachmentTransferRequest)
  | { type: "PROVIDER_ATTACHMENT_LIST"; providerId: string; itemId: string; pageSize?: number; cursor?: string }
  | { type: "PROVIDER_ATTACHMENT_RECOVERY_STATUS"; providerId: string }
  | { type: "PROVIDER_ATTACHMENT_READ_BEGIN"; providerId: string; itemId: string; attachmentId: string }
  | { type: "PROVIDER_ATTACHMENT_READ_CHUNK"; providerId: string; readHandle: string; offset: number; maxBytes?: number }
  | { type: "PROVIDER_ATTACHMENT_READ_RELEASE"; providerId: string; readHandle: string }
  | { type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN"; providerId: string; itemId: string; fileName: string; mediaType?: string; sizeBytes: number; sha256?: string; replaceExisting?: boolean; operationId?: string; attachmentId?: string }
  | { type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK"; providerId: string; transferId: string; offset: number; dataBase64: string }
  | { type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH"; providerId: string; itemId: string; transferId: string; operationId?: string }
  | { type: "PROVIDER_ATTACHMENT_UPLOAD_ABORT"; providerId: string; transferId: string }
  | { type: "PROVIDER_ATTACHMENT_DELETE"; providerId: string; itemId: string; attachmentId: string; operationId: string; confirmed: boolean }
  | { type: "ANDROID_TIMELINE_LIST"; providerId: string }
  | { type: "ANDROID_GENERATOR_HISTORY_LIST"; providerId: string }
  | { type: "ANDROID_GENERATOR_HISTORY_DELETE"; providerId: string; entryId: string; confirmed: true }
  | { type: "KEEPASS_OPEN"; input: KeePassOpenInput }
  | { type: "KEEPASS_WEBDAV_TEST"; input: KeePassWebDavTestInput }
  | { type: "KEEPASS_WEBDAV_OPEN"; input: KeePassRemoteOpenInput }
  | { type: "KEEPASS_REMOTE_RESTORE"; providerId: string }
  | { type: "KEEPASS_REMOTE_STATUS"; providerId: string }
  | { type: "KEEPASS_STATUS"; providerId: string }
  | { type: "KEEPASS_GROUP_LIST"; providerId: string; includeRecycleBin?: boolean; pageSize?: number; cursor?: string }
  | { type: "KEEPASS_GROUP_CREATE"; providerId: string; operationId: string; name: string; parentGroupId?: string }
  | { type: "KEEPASS_GROUP_RENAME"; providerId: string; operationId: string; groupId: string; name: string }
  | { type: "KEEPASS_GROUP_MOVE"; providerId: string; operationId: string; groupId: string; targetParentGroupId?: string }
  | { type: "KEEPASS_GROUP_DELETE"; providerId: string; operationId: string; groupId: string; confirmed: boolean }
  | { type: "KEEPASS_GROUP_RESTORE"; providerId: string; operationId: string; groupId: string; targetParentGroupId?: string }
  | { type: "KEEPASS_HISTORY_LIST"; providerId: string; itemId: string; pageSize?: number; cursor?: string }
  | { type: "KEEPASS_HISTORY_DETAIL"; providerId: string; itemId: string; historyId: string }
  | { type: "KEEPASS_HISTORY_FIELD_REVEAL"; providerId: string; itemId: string; historyId: string; fieldId: string }
  | { type: "KEEPASS_HISTORY_RESTORE"; providerId: string; itemId: string; operationId: string; historyId: string; confirmed: boolean }
  | { type: "KEEPASS_EXPORT_FILE"; providerId: string }
  | { type: "KEEPASS_LOCK"; providerId?: string }
  | { type: "PROVIDER_SYNC"; providerId: string; allowEmptyRemote?: true }
  | { type: "BITWARDEN_SYNC_ALL" }
  | { type: "PROVIDER_SYNC_CANCEL"; providerId: string }
  | { type: "PROVIDER_REMOVE"; providerId: string };

export type ExtensionResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export type VaultStatusResponse = VaultLifecycleStatus;

// Type-only re-exports keep UI imports centered on the runtime contract.
export type { LoginItem, ProviderAccount, ProviderConflict, ProviderConflictResolution, ProviderDiagnosticExport, VaultItem };
export type { ProviderAttachmentMutationResult, ProviderAttachmentPage, ProviderAttachmentReadBeginResult, ProviderAttachmentReadChunk, ProviderAttachmentUploadBeginResult, ProviderAttachmentUploadChunkResult };
export type { ProviderAttachmentTransferRequest, ProviderAttachmentTransferResult };
export type { AndroidGeneratorHistoryEntry, AndroidTimelineEntrySummary };
export type { BitwardenSendDetail, BitwardenSendPage, BitwardenSendSummary, BitwardenSendTextInput, BitwardenSendUpdateInput } from "../providers/bitwarden/bitwarden-sends";
export type { Mdbx2CollectionMutationResult, Mdbx2CollectionSummaryPage, Mdbx2CommitDiffResult, Mdbx2CommitHistoryPage, Mdbx2CommitRevertResult, Mdbx2ConflictResolutionChoice, Mdbx2ConflictResolutionResult, Mdbx2ConflictSummaryPage, Mdbx2HealthRepairApplyResult, Mdbx2HealthRepairDecision, Mdbx2HealthRepairPlan, Mdbx2HostStatus, Mdbx2ManagedSnapshotPage, Mdbx2ObjectDeleteResult, Mdbx2ObjectRecord, Mdbx2ObjectSummaryPage, Mdbx2ObjectUpsertInput, Mdbx2ObjectWriteResult, Mdbx2SnapshotCreateResult, Mdbx2SnapshotDeleteResult, Mdbx2SnapshotPrunePlan, Mdbx2SnapshotPruneResult, Mdbx2SnapshotRestoreResult, Mdbx2SnapshotStructurePage, Mdbx2SnapshotStructureSide, Mdbx2TransferBeginResult, Mdbx2TransferChunkResult, Mdbx2TransferFinishResult, Mdbx2VaultCredential, Mdbx2VaultDiagnosticsReport, Mdbx2VaultInspection, Mdbx2VaultRuntimeStatus, Mdbx2VaultSessionSummary, Mdbx2VaultSource, Mdbx2VaultTigaPosture, KeePassSessionSummary };
export type { Mdbx2BatchTransferExecuteResult, Mdbx2BatchTransferPlanResult, Mdbx2BatchTransferRequest, Mdbx2BatchTransferStatus };
export type { KeePassGroupMutationResult, KeePassGroupPage };
export type { BitwardenFolderMutationResult, BitwardenFolderPage };
export type { BitwardenCollectionMutationResult, BitwardenCollectionPage };
export type { KeePassHistoryDetail, KeePassHistoryFieldValue, KeePassHistoryPage, KeePassHistoryRestoreResult };
export type { KeePassRemoteManagerStatus, KeePassRemoteProbeResult };
export type { SteamAuthorizedDevice, SteamInventoryOverview, SteamInventoryPage, SteamMarketListingsPage, SteamMarketQuote, SteamMarketSellBatchResult, SteamMarketSellEntry, SteamMiniProfileBackground };
