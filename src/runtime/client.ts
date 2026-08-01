import type { ProviderAccount, ProviderConflict, ProviderConflictResolution, ProviderDiagnosticExport } from "../core/model";
import type { MonicaWebDavConfig } from "../providers/webdav/monica-webdav-provider";
import { bytesToBase64 } from "../security/encoding";
import type { EncryptedVaultBackup } from "../security/secure-vault-service";
import type { BitwardenConnectResult, ExtensionRequest, ExtensionResponse, KeePassFileExport, KeePassOpenInput, KeePassSessionSummary, LoginMatchSummary, Mdbx2CollectionSummaryPage, Mdbx2CommitDiffResult, Mdbx2CommitHistoryPage, Mdbx2ConflictResolutionChoice, Mdbx2ConflictResolutionResult, Mdbx2ConflictSummaryPage, Mdbx2HostStatus, Mdbx2ManagedSnapshotPage, Mdbx2ManagerSyncStatus, Mdbx2ObjectDeleteResult, Mdbx2ObjectRecord, Mdbx2ObjectSummaryPage, Mdbx2ObjectUpsertInput, Mdbx2ObjectWriteResult, Mdbx2SnapshotCreateResult, Mdbx2SnapshotDeleteResult, Mdbx2SnapshotRestoreResult, Mdbx2SnapshotStructurePage, Mdbx2SnapshotStructureSide, Mdbx2TransferBeginResult, Mdbx2TransferChunkResult, Mdbx2TransferFinishResult, Mdbx2VaultInspection, Mdbx2VaultOpenInput, Mdbx2VaultRuntimeStatus, Mdbx2VaultSessionSummary, Mdbx2VaultSource, Mdbx2WebDavSettingsInput, PasskeyMatchSummary, SteamAuthorizedDevice, SteamConfirmation, SteamInventoryOverview, SteamInventoryPage, SteamMarketListingsPage, SteamMarketQuote, SteamMarketSellBatchResult, SteamMarketSellEntry, SteamMiniProfileBackground, SteamPendingLogin, VaultItem, VaultStatusResponse, WalletFillKind, WalletFillResult, WalletMatchSummary } from "./messages";

export class ExtensionRuntimeError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "ExtensionRuntimeError";
  }
}

async function send<T>(request: ExtensionRequest): Promise<T> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) throw new Error("请在已安装的 Monica 浏览器插件中打开此页面。");
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse<T>;
  if (!response?.ok) throw new ExtensionRuntimeError(response?.error || "插件后台没有返回有效响应。", response?.code);
  return response.data;
}

export const vaultClient = {
  status: () => send<VaultStatusResponse>({ type: "VAULT_STATUS" }),
  setup: (masterPassword: string) => send<VaultItem[]>({ type: "VAULT_SETUP", masterPassword }),
  unlock: (masterPassword: string) => send<VaultItem[]>({ type: "VAULT_UNLOCK", masterPassword }),
  lock: () => send<void>({ type: "VAULT_LOCK" }),
  changeMasterPassword: (currentPassword: string, newPassword: string) => send<void>({ type: "VAULT_CHANGE_MASTER_PASSWORD", currentPassword, newPassword }),
  exportEncryptedBackup: (backupPassword: string) => send<EncryptedVaultBackup>({ type: "VAULT_EXPORT_ENCRYPTED", backupPassword }),
  restoreEncryptedBackup: (backup: EncryptedVaultBackup, backupPassword: string, replaceExisting = false, currentPassword?: string) =>
    send<VaultItem[]>({ type: "VAULT_RESTORE_ENCRYPTED", backup, backupPassword, replaceExisting, currentPassword }),
  importItems: (items: VaultItem[]) => send<VaultItem[]>({ type: "VAULT_IMPORT_ITEMS", items }),
  listItems: () => send<VaultItem[]>({ type: "VAULT_LIST_ITEMS" }),
  getItem: (itemId: string) => send<VaultItem | undefined>({ type: "VAULT_GET_ITEM", itemId }),
  upsertItem: (item: VaultItem) => send<VaultItem>({ type: "VAULT_UPSERT_ITEM", item }),
  deleteItem: (itemId: string) => send<void>({ type: "VAULT_DELETE_ITEM", itemId }),
  matchLogins: (pageUrl: string) => send<LoginMatchSummary[]>({ type: "VAULT_MATCH_LOGINS", pageUrl }),
  matchPasskeys: (pageUrl: string) => send<PasskeyMatchSummary[]>({ type: "VAULT_MATCH_PASSKEYS", pageUrl }),
  fillLogin: (itemId: string, tabId: number, frameId?: number, documentId?: string, expectedOrigin?: string) => send<{ filledUsername: boolean; filledPassword: boolean; filledTotp: boolean; filledCustomFields: number }>({ type: "VAULT_FILL_LOGIN", itemId, tabId, frameId, documentId, expectedOrigin }),
  listWalletItems: (kinds: WalletFillKind[]) => send<WalletMatchSummary[]>({ type: "VAULT_LIST_WALLET_ITEMS", kinds }),
  fillWallet: (itemId: string, tabId: number, frameId?: number, documentId?: string, expectedOrigin?: string) => send<WalletFillResult>({ type: "VAULT_FILL_WALLET", itemId, tabId, frameId, documentId, expectedOrigin }),
  listSteamConfirmations: (itemId: string) => send<SteamConfirmation[]>({ type: "STEAM_LIST_CONFIRMATIONS", itemId }),
  respondSteamConfirmation: (itemId: string, confirmation: SteamConfirmation, accept: boolean) => send<boolean>({ type: "STEAM_RESPOND_CONFIRMATION", itemId, confirmation, accept }),
  listSteamPendingLogins: (itemId: string) => send<SteamPendingLogin[]>({ type: "STEAM_LIST_PENDING_LOGINS", itemId }),
  respondSteamLogin: (itemId: string, login: Pick<SteamPendingLogin, "clientId" | "version">, approve: boolean) => send<boolean>({ type: "STEAM_RESPOND_LOGIN", itemId, login, approve }),
  listSteamAuthorizedDevices: (itemId: string) => send<SteamAuthorizedDevice[]>({ type: "STEAM_LIST_AUTHORIZED_DEVICES", itemId }),
  getSteamInventoryOverview: (itemId: string) => send<SteamInventoryOverview>({ type: "STEAM_GET_INVENTORY_OVERVIEW", itemId }),
  listSteamInventoryItems: (itemId: string, input: { appId: number; contextId: string; language?: string; startAssetId?: string; count?: number }) => send<SteamInventoryPage>({ type: "STEAM_LIST_INVENTORY_ITEMS", itemId, ...input }),
  getSteamMarketQuote: (itemId: string, input: { appId: number; marketHashName: string; currency: number; points?: number }) => send<SteamMarketQuote>({ type: "STEAM_GET_MARKET_QUOTE", itemId, ...input }),
  listSteamMarketListings: (itemId: string, input: { language?: string; start?: number; count?: number } = {}) => send<SteamMarketListingsPage>({ type: "STEAM_LIST_MARKET_LISTINGS", itemId, ...input }),
  sellSteamMarketItems: (itemId: string, entries: SteamMarketSellEntry[], autoConfirm = false) => send<SteamMarketSellBatchResult>({ type: "STEAM_SELL_MARKET_ITEMS", itemId, entries, autoConfirm, confirmed: true }),
  cancelSteamMarketListing: (itemId: string, listingId: string) => send<boolean>({ type: "STEAM_CANCEL_MARKET_LISTING", itemId, listingId, confirmed: true }),
  getSteamMiniProfileBackground: (itemId: string) => send<SteamMiniProfileBackground | undefined>({ type: "STEAM_GET_MINI_PROFILE_BACKGROUND", itemId }),
  revokeSteamAuthorizedDevice: (itemId: string, input: { tokenId: string; accountName: string; password: string }) => send<{ success: true; tokenId: string }>({ type: "STEAM_REVOKE_AUTHORIZED_DEVICE", itemId, ...input, confirmed: true }),
  listProviders: () => send<ProviderAccount[]>({ type: "PROVIDER_LIST" }),
  providerQueueStatus: () => send<Array<{ providerId: string; pending: number; failed: number; maxAttempts: number; lastError?: string }>>({ type: "PROVIDER_QUEUE_STATUS" }),
  listProviderConflicts: (providerId?: string) => send<ProviderConflict[]>({ type: "PROVIDER_CONFLICT_LIST", providerId }),
  resolveProviderConflict: (conflictId: string, resolution: ProviderConflictResolution) => send<void>({ type: "PROVIDER_CONFLICT_RESOLVE", conflictId, resolution }),
  exportProviderDiagnostics: () => send<ProviderDiagnosticExport>({ type: "PROVIDER_DIAGNOSTIC_EXPORT" }),
  testWebDav: (config: MonicaWebDavConfig, providerId?: string) => send<void>({ type: "WEBDAV_TEST", config, providerId }),
  saveWebDav: (name: string, config: MonicaWebDavConfig, providerId?: string, isDefaultSaveTarget = false) =>
    send<ProviderAccount>({ type: "WEBDAV_SAVE", name, config, providerId, isDefaultSaveTarget }),
  loginBitwarden: (input: {
    providerId?: string;
    name: string;
    vaultUrl: string;
    email: string;
    masterPassword: string;
    twoFactorCode?: string;
    twoFactorProvider?: number;
    rememberTwoFactor?: boolean;
    isDefaultSaveTarget?: boolean;
  }) => send<BitwardenConnectResult>({ type: "BITWARDEN_LOGIN", ...input }),
  sendBitwardenEmailCode: (vaultUrl: string, email: string, masterPassword: string, providerId?: string) =>
    send<void>({ type: "BITWARDEN_SEND_EMAIL_CODE", vaultUrl, email, masterPassword, providerId }),
  mdbx2HostStatus: () => send<Mdbx2HostStatus>({ type: "MDBX2_HOST_STATUS" }),
  beginMdbx2Transfer: (sizeBytes: number, sha256?: string) => send<Mdbx2TransferBeginResult>({ type: "MDBX2_TRANSFER_BEGIN", sizeBytes, sha256 }),
  sendMdbx2Chunk: (transferId: string, offset: number, bytes: Uint8Array) => send<Mdbx2TransferChunkResult>({ type: "MDBX2_TRANSFER_CHUNK", transferId, offset, dataBase64: bytesToBase64(bytes) }),
  finishMdbx2Transfer: (transferId: string) => send<Mdbx2TransferFinishResult>({ type: "MDBX2_TRANSFER_FINISH", transferId }),
  abortMdbx2Transfer: (transferId: string) => send<boolean>({ type: "MDBX2_TRANSFER_ABORT", transferId }),
  releaseMdbx2File: (fileHandle: string) => send<boolean>({ type: "MDBX2_FILE_RELEASE", fileHandle }),
  inspectMdbx2Vault: (source: Mdbx2VaultSource) => send<Mdbx2VaultInspection>({ type: "MDBX2_VAULT_INSPECT", source }),
  openMdbx2Vault: (input: Mdbx2VaultOpenInput) => send<{ account: ProviderAccount; session: Mdbx2VaultSessionSummary }>({ type: "MDBX2_VAULT_OPEN", input }),
  mdbx2VaultStatus: (providerId: string) => send<Mdbx2VaultRuntimeStatus>({ type: "MDBX2_VAULT_STATUS", providerId }),
  lockMdbx2Vault: (providerId: string) => send<boolean>({ type: "MDBX2_VAULT_LOCK", providerId }),
  saveMdbx2WebDav: (providerId: string, name: string, config: Mdbx2WebDavSettingsInput, isDefaultSaveTarget = false) =>
    send<ProviderAccount>({ type: "MDBX2_WEBDAV_SAVE", providerId, name, config, isDefaultSaveTarget }),
  downloadMdbx2Bootstrap: (config: Mdbx2WebDavSettingsInput) => send<Mdbx2TransferFinishResult>({ type: "MDBX2_BOOTSTRAP_DOWNLOAD", config }),
  publishMdbx2Bootstrap: (providerId: string) => send<Mdbx2ManagerSyncStatus>({ type: "MDBX2_BOOTSTRAP_PUBLISH", providerId }),
  registerMdbx2Bootstrap: (providerId: string) => send<Mdbx2ManagerSyncStatus>({ type: "MDBX2_BOOTSTRAP_REGISTER", providerId }),
  mdbx2SyncStatus: (providerId: string) => send<Mdbx2ManagerSyncStatus>({ type: "MDBX2_SYNC_STATUS", providerId }),
  listMdbx2Collections: (providerId: string, input: { deleted?: boolean; pageSize?: number; cursor?: string } = {}) => send<Mdbx2CollectionSummaryPage>({ type: "MDBX2_COLLECTION_LIST", providerId, ...input }),
  listMdbx2Objects: (providerId: string, collectionId: string, input: { objectTypeId?: string; deleted?: boolean; pageSize?: number; cursor?: string } = {}) => send<Mdbx2ObjectSummaryPage>({ type: "MDBX2_OBJECT_LIST", providerId, collectionId, ...input }),
  revealMdbx2Object: (providerId: string, objectId: string) => send<Mdbx2ObjectRecord>({ type: "MDBX2_OBJECT_REVEAL", providerId, objectId }),
  upsertMdbx2Object: (providerId: string, operationId: string, input: Mdbx2ObjectUpsertInput) => send<Mdbx2ObjectWriteResult>({ type: "MDBX2_OBJECT_UPSERT", providerId, operationId, input }),
  deleteMdbx2Object: (providerId: string, operationId: string, logicalObjectId: string) => send<Mdbx2ObjectDeleteResult>({ type: "MDBX2_OBJECT_DELETE", providerId, operationId, logicalObjectId }),
  listMdbx2History: (providerId: string, input: { pageSize?: number; cursor?: string } = {}) => send<Mdbx2CommitHistoryPage>({ type: "MDBX2_HISTORY_LIST", providerId, ...input }),
  listMdbx2CommitDiff: (providerId: string, commitId: string) => send<Mdbx2CommitDiffResult>({ type: "MDBX2_HISTORY_DIFF", providerId, commitId }),
  listMdbx2Snapshots: (providerId: string, input: { pageSize?: number; cursor?: string } = {}) => send<Mdbx2ManagedSnapshotPage>({ type: "MDBX2_SNAPSHOT_LIST", providerId, ...input }),
  listMdbx2SnapshotStructure: (providerId: string, snapshotId: string, side: Mdbx2SnapshotStructureSide, input: { pageSize?: number; cursor?: string } = {}) => send<Mdbx2SnapshotStructurePage>({ type: "MDBX2_SNAPSHOT_STRUCTURE", providerId, snapshotId, side, ...input }),
  createMdbx2Snapshot: (providerId: string, operationId: string, name: string) => send<Mdbx2SnapshotCreateResult>({ type: "MDBX2_SNAPSHOT_CREATE", providerId, operationId, name }),
  deleteMdbx2Snapshot: (providerId: string, operationId: string, snapshotId: string) => send<Mdbx2SnapshotDeleteResult>({ type: "MDBX2_SNAPSHOT_DELETE", providerId, operationId, snapshotId }),
  restoreMdbx2Snapshot: (providerId: string, operationId: string, snapshotId: string) => send<Mdbx2SnapshotRestoreResult>({ type: "MDBX2_SNAPSHOT_RESTORE", providerId, operationId, snapshotId }),
  listMdbx2Conflicts: (providerId: string, input: { pageSize?: number; cursor?: string } = {}) => send<Mdbx2ConflictSummaryPage>({ type: "MDBX2_CONFLICT_LIST", providerId, ...input }),
  resolveMdbx2Conflict: (providerId: string, operationId: string, conflictId: string, choice: Mdbx2ConflictResolutionChoice) => send<Mdbx2ConflictResolutionResult>({ type: "MDBX2_CONFLICT_RESOLVE", providerId, operationId, conflictId, choice }),
  openKeePass: (input: KeePassOpenInput) => send<{ account: ProviderAccount; session: KeePassSessionSummary }>({ type: "KEEPASS_OPEN", input }),
  keePassStatus: (providerId: string) => send<KeePassSessionSummary | undefined>({ type: "KEEPASS_STATUS", providerId }),
  exportKeePassFile: (providerId: string) => send<KeePassFileExport>({ type: "KEEPASS_EXPORT_FILE", providerId }),
  lockKeePass: (providerId?: string) => send<void>({ type: "KEEPASS_LOCK", providerId }),
  syncProvider: (providerId: string) => send<{ warnings: string[]; conflicts: number }>({ type: "PROVIDER_SYNC", providerId }),
  cancelProviderSync: (providerId: string) => send<{ cancelled: boolean }>({ type: "PROVIDER_SYNC_CANCEL", providerId }),
  removeProvider: (providerId: string) => send<void>({ type: "PROVIDER_REMOVE", providerId })
};
