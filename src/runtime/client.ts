import { translateRuntimeError } from "../i18n/runtime";
import type { BitwardenPendingTransfer } from '../core/bitwarden-batch-transfer';
import type { Mdbx2FileExportBegin, Mdbx2FileExportChunk } from "./messages";
import { runtimeInfo, type RuntimeInfo } from "./version";
import type { ProviderAccount, ProviderConflictResolution, ProviderConflictSummary, ProviderDiagnosticExport } from "../core/model";
import type { MonicaWebDavConfig } from "../providers/webdav/monica-webdav-provider";
import { bytesToBase64 } from "../security/encoding";
import type { EncryptedVaultBackup } from "../security/secure-vault-service";
import type { AutofillSitePolicy } from "../autofill/site-policy";
import type { BlockedFieldSignatureRecord } from "../autofill/field-policy";
import type { AndroidGeneratorHistoryEntry, BitwardenConnectResult, ExtensionRequest, ExtensionResponse, KeePassFileExport, KeePassGroupMutationResult, KeePassGroupPage, KeePassHistoryDetail, KeePassHistoryFieldValue, KeePassHistoryPage, KeePassHistoryRestoreResult, KeePassOpenInput, KeePassRemoteManagerStatus, KeePassRemoteOpenInput, KeePassRemoteProbeResult, KeePassSessionSummary, KeePassWebDavTestInput, LoginMatchSummary, Mdbx2BatchTransferExecuteResult, Mdbx2BatchTransferPlanResult, Mdbx2BatchTransferRequest, Mdbx2BatchTransferStatus, Mdbx2BootstrapDownloadInput, Mdbx2CollectionMutationResult, Mdbx2CollectionSummaryPage, Mdbx2CommitDiffResult, Mdbx2CommitHistoryPage, Mdbx2CommitRevertResult, Mdbx2ConflictResolutionChoice, Mdbx2ConflictResolutionResult, Mdbx2ConflictSummaryPage, Mdbx2HealthRepairApplyResult, Mdbx2HealthRepairDecision, Mdbx2HealthRepairPlan, Mdbx2HostStatus, Mdbx2ManagedSnapshotPage, Mdbx2ManagerSyncStatus, Mdbx2ObjectDeleteResult, Mdbx2ObjectRecord, Mdbx2ObjectSummaryPage, Mdbx2ObjectUpsertInput, Mdbx2ObjectWriteResult, Mdbx2OneDriveSettingsInput, Mdbx2SnapshotCreateResult, Mdbx2SnapshotDeleteResult, Mdbx2SnapshotPrunePlan, Mdbx2SnapshotPruneResult, Mdbx2SnapshotRestoreResult, Mdbx2SnapshotStructurePage, Mdbx2SnapshotStructureSide, Mdbx2TransferBeginResult, Mdbx2TransferChunkResult, Mdbx2TransferFinishResult, Mdbx2VaultCredential, Mdbx2VaultDiagnosticsReport, Mdbx2VaultInspection, Mdbx2VaultOpenInput, Mdbx2VaultRuntimeStatus, Mdbx2VaultSessionSummary, Mdbx2VaultSource, Mdbx2VaultTigaPosture, Mdbx2WebDavSettingsInput, MdbxImportCommitResult, MdbxImportDetectResult, MdbxImportOperation, MdbxImportPrepareResult, PasskeyMatchSummary, SteamAuthorizedDevice, SteamConfirmation, SteamInventoryOverview, SteamInventoryPage, SteamMarketListingsPage, SteamMarketQuote, SteamMarketSellBatchResult, SteamMarketSellEntry, SteamMiniProfileBackground, SteamPendingLogin, VaultItem, VaultStatusResponse, VaultWindowsHelloStatus, WalletFillKind, WalletFillResult, WalletMatchSummary } from "./messages";
import type { ProviderAttachmentMutationResult, ProviderAttachmentPage, ProviderAttachmentReadBeginResult, ProviderAttachmentReadChunk, ProviderAttachmentRecoveryStatus, ProviderAttachmentTransferRequest, ProviderAttachmentTransferResult, ProviderAttachmentUploadBeginResult, ProviderAttachmentUploadChunkResult } from "./messages";

import type { BitwardenCollectionMutationResult, BitwardenCollectionPage, BitwardenFolderMutationResult, BitwardenFolderPage, BitwardenSendDetail, BitwardenSendFileUploadInput, BitwardenSendPage, BitwardenSendTextInput, BitwardenSendUpdateInput } from "./messages";

export class ExtensionRuntimeError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "ExtensionRuntimeError";
  }
}

let runtimeChecked = false;
let runtimeCheck: Promise<void> | undefined;

function transportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'Could not establish connection. Receiving end does not exist.'
    || message === 'The message port closed before a response was received.'
    || message === 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';
}

function runtimeConnectionError(error: unknown): unknown {
  runtimeChecked = false;
  if (error instanceof Error && error.message.includes('Extension context invalidated')) return reloadRequired();
  return transportFailure(error)
    ? new ExtensionRuntimeError(translateRuntimeError('暂时无法连接 Monica 后台，请稍后重新打开页面。'), 'RUNTIME_UNAVAILABLE')
    : error;
}

async function probeRuntime(): Promise<ExtensionResponse<RuntimeInfo>> {
  // Only this secret-free, read-only probe is replayed while the worker wakes.
  const delays = [100, 250, 500, 1000, 2000];
  for (let attempt = 0; ; attempt++) {
    try { return await chrome.runtime.sendMessage({ type: 'RUNTIME_INFO' }); }
    catch (error) {
      runtimeChecked = false;
      if (!transportFailure(error) || attempt >= delays.length) throw runtimeConnectionError(error);
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

function reloadRequired(): ExtensionRuntimeError {
  runtimeChecked = false;
  return new ExtensionRuntimeError(translateRuntimeError("Monica 已更新，请重新加载扩展后再解锁。"), "RUNTIME_RELOAD_REQUIRED");
}

function checkResponse<T>(response: ExtensionResponse<T> | undefined): T {
  if (!response?.ok) {
    if (response?.error === "不支持的 Monica 运行时命令。") throw reloadRequired();
    throw new ExtensionRuntimeError(translateRuntimeError(response?.error || "插件后台没有返回有效响应。"), response?.code);
  }
  return response.data;
}

async function checkRuntime(force: boolean): Promise<void> {
  if (runtimeChecked && !force) return;
  if (!runtimeCheck) {
    runtimeChecked = false;
    runtimeCheck = (async () => {
      const response = await probeRuntime();
      const info = checkResponse(response);
      if (!info || info.version !== runtimeInfo.version || info.protocolVersion !== runtimeInfo.protocolVersion || info.buildId !== runtimeInfo.buildId) throw reloadRequired();
      runtimeChecked = true;
    })().finally(() => { runtimeCheck = undefined; });
  }
  return runtimeCheck;
}

async function send<T>(request: ExtensionRequest): Promise<T> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) throw new Error("请在已安装的 Monica 浏览器插件中打开此页面。");
  // Share one initial check across UI reads; recheck before sending a password.
  await checkRuntime(request.type === "VAULT_SETUP" || request.type === "VAULT_UNLOCK" || request.type === "VAULT_UNLOCK_HELLO" || request.type === 'VAULT_AUTHENTICATED_EXPORT'
    || request.type === 'BITWARDEN_LOGIN' || request.type === 'BITWARDEN_SEND_EMAIL_CODE' || request.type === 'MDBX2_IMPORT_COMMIT' || request.type === 'MDBX2_IMPORT_PREPARE' || request.type === 'KEEPASS_OPEN');
  let response: ExtensionResponse<T>;
  try { response = await chrome.runtime.sendMessage(request); }
  catch (error) {
    runtimeChecked = false;
    // A status read may race worker suspension after a successful version check.
    // Writes, unlocks, authenticator counters and prompts are never replayed.
    if (request.type !== 'VAULT_STATUS' || !transportFailure(error)) throw runtimeConnectionError(error);
    await checkRuntime(true);
    try { response = await chrome.runtime.sendMessage(request); }
    catch (retryError) { throw runtimeConnectionError(retryError); }
  }
  return checkResponse(response);
}

export const vaultClient = {
  loginOneDrive: (loginId: string, clientId?: string) => send<OneDriveLoginSummary>({ type: "ONEDRIVE_LOGIN", loginId, clientId }),
  cancelOneDriveLogin: (loginId: string) => send<void>({ type: "ONEDRIVE_LOGIN_CANCEL", loginId }),
  browseOneDrive: (input: OneDriveBrowserInput) => send<OneDriveBrowserPage>({ type: "ONEDRIVE_BROWSE", input }),
  openKeePassOneDrive: (input: KeePassOneDriveConnectInput) => send<KeePassOneDriveConnectResult>({ type: "KEEPASS_ONEDRIVE_OPEN", input }),
  status: () => send<VaultStatusResponse>({ type: "VAULT_STATUS" }),
  getAutoLockMinutes: () => send<number>({ type: 'VAULT_AUTO_LOCK_GET' }),
  setAutoLockMinutes: (minutes: number) => send<number>({ type: 'VAULT_AUTO_LOCK_SET', minutes }),
  setup: (masterPassword: string) => send<VaultItem[]>({ type: "VAULT_SETUP", masterPassword }),
  unlock: (masterPassword: string) => send<VaultItem[]>({ type: "VAULT_UNLOCK", masterPassword }),
  unlockWithWindowsHello: () => send<VaultItem[]>({ type: "VAULT_UNLOCK_HELLO" }),
  lock: () => send<void>({ type: "VAULT_LOCK" }),
  windowsHelloStatus: () => send<VaultWindowsHelloStatus>({ type: "VAULT_HELLO_STATUS" }),
  enrollWindowsHello: () => send<{ version: 1; bindingId: string; rpId: "monica-extension.local"; enrolledAt: string }>({ type: "VAULT_HELLO_ENROLL" }),
  revokeWindowsHello: () => send<void>({ type: "VAULT_HELLO_REVOKE", confirmed: true }),
  changeMasterPassword: (currentPassword: string, newPassword: string) => send<void>({ type: "VAULT_CHANGE_MASTER_PASSWORD", currentPassword, newPassword }),
  exportEncryptedBackup: async (backupPassword: string, masterPassword?: string) => {
    const result = await send<import('../security/authenticated-export').VaultExportResult>({ type: 'VAULT_AUTHENTICATED_EXPORT', input: { format: 'encrypted', backupPassword, masterPassword, confirmed: true } });
    if (result.format !== 'encrypted') throw new Error('Invalid export result');
    return result.backup;
  },
  authenticatedExport: (input: import('../security/authenticated-export').VaultExportInput) => send<import('../security/authenticated-export').VaultExportResult>({ type: 'VAULT_AUTHENTICATED_EXPORT', input }),
  storageOverview: () => send<import('../security/vault-recovery').VaultStorageOverview>({ type: 'VAULT_STORAGE_OVERVIEW' }),
  clearRecoveryCopies: () => send<void>({ type: 'VAULT_RECOVERY_CLEAR', confirmed: true }),
  restoreEncryptedBackup: (backup: EncryptedVaultBackup, backupPassword: string, replaceExisting = false, currentPassword?: string) =>
    send<VaultItem[]>({ type: "VAULT_RESTORE_ENCRYPTED", backup, backupPassword, replaceExisting, currentPassword }),
  importItems: (items: VaultItem[]) => send<VaultItem[]>({ type: "VAULT_IMPORT_ITEMS", items }),
  listItems: () => send<VaultItem[]>({ type: "VAULT_LIST_ITEMS" }),
  itemSnapshot: () => send<{ items: VaultItem[]; lockedAutofillIds: string[] }>({ type: "VAULT_ITEM_SNAPSHOT" }),
  getHomePreferences: () => send<import("../core/home-preferences").HomePreferences>({ type: "VAULT_HOME_GET" }),
  setHomePreferences: (preferences: Partial<import("../core/home-preferences").HomePreferences>) => send<import("../core/home-preferences").HomePreferences>({ type: "VAULT_HOME_SET", preferences }),
  listArchivedItems: () => send<VaultItem[]>({ type: "VAULT_LIST_ARCHIVED_ITEMS" }),
  listDeletedItems: () => send<VaultItem[]>({ type: "VAULT_LIST_DELETED_ITEMS" }),
  getItem: (itemId: string) => send<VaultItem | undefined>({ type: "VAULT_GET_ITEM", itemId }),
  upsertItem: (item: VaultItem, allowLockedAutofill?: boolean, expectedUpdatedAt?: string) => send<VaultItem>({ type: "VAULT_UPSERT_ITEM", item, allowLockedAutofill, expectedUpdatedAt }),
  consumeHotp: (usage: import('../core/login-otp').HotpUsage) => send<boolean>({ type: 'VAULT_CONSUME_HOTP', usage }),
  unarchiveItem: (itemId: string, expectedUpdatedAt: string) => send<VaultItem>({ type: 'VAULT_UNARCHIVE_ITEM', itemId, expectedUpdatedAt }),
  deletePasswordHistory: (itemId: string, index: number, expectedUpdatedAt: string) => send<LoginItem>({ type: 'VAULT_DELETE_PASSWORD_HISTORY', itemId, index, expectedUpdatedAt }),
  savePasswordGroup: (items: LoginItem[], expected: Record<string, string>, allowLockedAutofill?: boolean) => send<LoginItem[]>({ type: "VAULT_SAVE_PASSWORD_GROUP", items, expected, allowLockedAutofill }),
  setPasswordCover: (anchorItemId: string, enabled: boolean, expected: Record<string, string>) => send<LoginItem[]>({ type: "VAULT_SET_PASSWORD_COVER", anchorItemId, enabled, expected }),
  setPasswordStack: (anchorItemIds: string[], action: import("../core/password-manual-stacks").PasswordStackAction, expected: Record<string, string>) => send<LoginItem[]>({ type: "VAULT_SET_PASSWORD_STACK", anchorItemIds, action, expected }),
  removePasswordProjectMembers: (input: import('../background/password-project-removal').PasswordProjectRemovalRequest, confirmed: true) =>
    send<import('../background/password-project-removal').PasswordProjectRemovalStatus>({ type: 'VAULT_PASSWORD_PROJECT_REMOVE', input, confirmed }),
  listPasswordProjectRemovals: (operationId?: string) => send<import('../background/password-project-removal').PasswordProjectRemovalStatus[]>({ type: 'VAULT_PASSWORD_PROJECT_REMOVALS', ...(operationId ? { operationId } : {}) }),
  resumePasswordProjectRemoval: (operationId: string) => send<import('../background/password-project-removal').PasswordProjectRemovalStatus>({ type: 'VAULT_PASSWORD_PROJECT_REMOVAL_RESUME', operationId }),
  cancelPasswordProjectRemoval: (operationId: string) => send<import('../background/password-project-removal').PasswordProjectRemovalStatus>({ type: 'VAULT_PASSWORD_PROJECT_REMOVAL_CANCEL', operationId }),
  keePassProjectSourceToken: (providerId: string) => send<string>({ type: 'VAULT_KEEPASS_PROJECT_SOURCE_TOKEN', providerId }),
  removeKeePassProjectMembers: (input: import('../background/keepass-project-removal').KeePassProjectRemovalRequest, confirmed: true) =>
    send<import('../background/keepass-project-removal').KeePassProjectRemovalStatus>({ type: 'VAULT_KEEPASS_PROJECT_REMOVE', input, confirmed }),
  listKeePassProjectRemovals: (operationId?: string) => send<import('../background/keepass-project-removal').KeePassProjectRemovalStatus[]>({ type: 'VAULT_KEEPASS_PROJECT_REMOVALS', operationId }),
  resumeKeePassProjectRemoval: (operationId: string) => send<import('../background/keepass-project-removal').KeePassProjectRemovalStatus>({ type: 'VAULT_KEEPASS_PROJECT_REMOVAL_RESUME', operationId }),
  cancelKeePassProjectRemoval: (operationId: string) => send<import('../background/keepass-project-removal').KeePassProjectRemovalStatus>({ type: 'VAULT_KEEPASS_PROJECT_REMOVAL_CANCEL', operationId }),
  reviewKeePassProjectConflicts: (providerId: string) => send<import('../providers/keepass/keepass-remote-session').KeePassProjectConflictReview>({ type: 'VAULT_KEEPASS_PROJECT_CONFLICT_REVIEW', providerId }),
  resolveKeePassProjectConflicts: (providerId: string, input: import('../providers/keepass/keepass-project-resolution').KeePassProjectResolutionRequest, confirmed: true) =>
    send<import('../background/keepass-project-resolution').KeePassProjectResolutionStatus>({ type: 'VAULT_KEEPASS_PROJECT_RESOLVE', providerId, input, confirmed }),
  listKeePassProjectResolutions: (operationId?: string) => send<import('../background/keepass-project-resolution').KeePassProjectResolutionStatus[]>({ type: 'VAULT_KEEPASS_PROJECT_RESOLUTIONS', operationId }),
  resumeKeePassProjectResolution: (operationId: string) => send<import('../background/keepass-project-resolution').KeePassProjectResolutionStatus>({ type: 'VAULT_KEEPASS_PROJECT_RESOLUTION_RESUME', operationId }),
  cancelKeePassProjectResolution: (operationId: string) => send<import('../background/keepass-project-resolution').KeePassProjectResolutionStatus>({ type: 'VAULT_KEEPASS_PROJECT_RESOLUTION_CANCEL', operationId }),
  listKeePassProjectRecoveryCopies: (providerId: string) => send<Awaited<ReturnType<import('../background/keepass-project-resolution').KeePassProjectResolutionWorkflow['recoveryCopies']>>>({ type: 'VAULT_KEEPASS_PROJECT_RECOVERY_LIST', providerId }),
  deleteKeePassProjectRecoveryCopy: (providerId: string, operationId: string, expectedIntentTag: string, confirmed: true) =>
    send<{ deleted: boolean }>({ type: 'VAULT_KEEPASS_PROJECT_RECOVERY_DELETE', providerId, operationId, expectedIntentTag, confirmed }),
  beginKeePassRecoveryExport: (providerId: string, operationId: string, expectedIntentTag: string, exportPassword: string, requestId: string) =>
    send<import('../background/keepass-recovery-download').RecoveryDownloadDescriptor>({ type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_BEGIN', providerId, operationId, expectedIntentTag, exportPassword, requestId }),
  statusKeePassRecoveryExport: (providerId: string, requestId: string) =>
    send<import('../background/keepass-recovery-download').RecoveryDownloadStatus>({ type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_STATUS', providerId, requestId }),
  cancelKeePassRecoveryExport: (providerId: string, requestId: string) => send<void>({ type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_CANCEL', providerId, requestId }),
  readKeePassRecoveryExport: (providerId: string, downloadHandle: string, offset: number) =>
    send<import('../background/keepass-recovery-download').RecoveryDownloadChunk>({ type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_READ', providerId, downloadHandle, offset }),
  releaseKeePassRecoveryExport: (providerId: string, downloadHandle: string) =>
    send<boolean>({ type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_RELEASE', providerId, downloadHandle }),
  lockedAutofillIds: () => send<string[]>({ type: "VAULT_LOCKED_AUTOFILL_IDS" }),
  setLockedAutofill: (itemId: string, enabled: boolean) => send<void>({ type: "VAULT_SET_LOCKED_AUTOFILL", itemId, enabled }),
  batchMutateItems: (input: import('../core/vault-batch').VaultBatchRequest) => send<{ affected: number }>({ type: 'VAULT_BATCH_MUTATE', input }),
  deleteItem: (itemId: string) => send<void>({ type: "VAULT_DELETE_ITEM", itemId }),
  emptyLocalTrash: () => send<{ removed: number; retained: number }>({ type: "VAULT_EMPTY_LOCAL_TRASH" }),
  deletePasswordGroup: (anchorItemId: string, expected: Record<string, string>) => send<void>({ type: "VAULT_DELETE_PASSWORD_GROUP", anchorItemId, expected }),
  restoreItem: (itemId: string) => send<VaultItem>({ type: "VAULT_RESTORE_ITEM", itemId }),
  restorePasswordProject: (input: import('../background/password-project-restore').PasswordProjectRestoreRequest, confirmed: true) => send<import('../background/password-project-restore').PasswordProjectRestoreStatus>({ type: 'VAULT_PASSWORD_PROJECT_RESTORE', input, confirmed }),
  listPasswordProjectRestores: (operationId?: string) => send<import('../background/password-project-restore').PasswordProjectRestoreStatus[]>({ type: 'VAULT_PASSWORD_PROJECT_RESTORES', ...(operationId ? { operationId } : {}) }),
  resumePasswordProjectRestore: (operationId: string) => send<import('../background/password-project-restore').PasswordProjectRestoreStatus>({ type: 'VAULT_PASSWORD_PROJECT_RESTORE_RESUME', operationId }),
  matchLogins: (pageUrl: string, fieldSignature?: string) => send<LoginMatchSummary[]>({ type: "VAULT_MATCH_LOGINS", pageUrl, fieldSignature }),
  listLoginSummaries: () => send<LoginMatchSummary[]>({ type: "VAULT_LIST_LOGIN_SUMMARIES" }),
  loginSecret: (itemId: string, field: "username" | "password") => send<{ value: string }>({ type: "VAULT_LOGIN_SECRET", itemId, field }),
  matchPasskeys: (pageUrl: string) => send<PasskeyMatchSummary[]>({ type: "VAULT_MATCH_PASSKEYS", pageUrl }),
  fillLogin: (itemId: string, tabId: number, frameId?: number, documentId?: string, expectedOrigin?: string) => send<{ filledUsername: boolean; filledPassword: boolean; filledTotp: boolean; filledCustomFields: number }>({ type: "VAULT_FILL_LOGIN", itemId, tabId, frameId, documentId, expectedOrigin }),
  listWalletItems: (kinds: WalletFillKind[], pageUrl: string, fieldSignature?: string) => send<WalletMatchSummary[]>({ type: "VAULT_LIST_WALLET_ITEMS", kinds, pageUrl, fieldSignature }),
  fillWallet: (itemId: string, tabId: number, frameId?: number, documentId?: string, expectedOrigin?: string) => send<WalletFillResult>({ type: "VAULT_FILL_WALLET", itemId, tabId, frameId, documentId, expectedOrigin }),
  getAutofillSitePolicy: () => send<AutofillSitePolicy>({ type: "AUTOFILL_SITE_POLICY_GET" }),
  setAutofillSitePolicy: (policy: AutofillSitePolicy) => send<AutofillSitePolicy>({ type: "AUTOFILL_SITE_POLICY_SET", policy }),
  listAutofillBlockedFields: () => send<BlockedFieldSignatureRecord[]>({ type: "AUTOFILL_FIELD_POLICY_LIST" }),
  isAutofillFieldBlocked: (signature: string) => send<boolean>({ type: "AUTOFILL_FIELD_POLICY_STATUS", signature }),
  setCurrentAutofillFieldBlocked: (blocked: boolean, tabId: number, frameId?: number, documentId?: string, expectedOrigin?: string) =>
    send<BlockedFieldSignatureRecord | null>({ type: "AUTOFILL_FIELD_POLICY_SET_CURRENT", blocked, tabId, frameId, documentId, expectedOrigin }),
  removeAutofillBlockedField: (signature: string) => send<boolean>({ type: "AUTOFILL_FIELD_POLICY_REMOVE", signature }),
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
  providerQueueStatus: () => send<Array<{ providerId: string; pending: number; failed: number; recovering?: number; maxAttempts: number; lastError?: string }>>({ type: "PROVIDER_QUEUE_STATUS" }),
  listProviderConflicts: (providerId?: string) => send<ProviderConflictSummary[]>({ type: "PROVIDER_CONFLICT_LIST", providerId }),
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
    twoFactorProviderData?: Record<string, unknown>;
    rememberTwoFactor?: boolean;
    newDeviceOtp?: string;
    ssoOrganizationIdentifier?: string;
    isDefaultSaveTarget?: boolean;
  }) => send<BitwardenConnectResult>({ type: "BITWARDEN_LOGIN", ...input }),
  logoutBitwarden: (providerId: string) => send<void>({ type: "BITWARDEN_LOGOUT", providerId }),
  sendBitwardenEmailCode: (vaultUrl: string, email: string, masterPassword: string, providerId?: string) =>
    send<void>({ type: "BITWARDEN_SEND_EMAIL_CODE", vaultUrl, email, masterPassword, providerId }),
  listBitwardenFolders: (providerId: string, input: { pageSize?: number; cursor?: string } = {}) => send<BitwardenFolderPage>({ type: "BITWARDEN_FOLDER_LIST", providerId, ...input }),
  createBitwardenFolder: (providerId: string, name: string) => send<BitwardenFolderMutationResult>({ type: "BITWARDEN_FOLDER_CREATE", providerId, name }),
  renameBitwardenFolder: (providerId: string, folderId: string, name: string, expectedRevision?: string) => send<BitwardenFolderMutationResult>({ type: "BITWARDEN_FOLDER_RENAME", providerId, folderId, name, expectedRevision }),
  deleteBitwardenFolder: (providerId: string, folderId: string, expectedRevision?: string) => send<BitwardenFolderMutationResult>({ type: "BITWARDEN_FOLDER_DELETE", providerId, folderId, expectedRevision, confirmed: true }),
  moveBitwardenCipherToFolder: (providerId: string, itemId: string, targetFolderId?: string, expectedCipherRevision?: string, expectedTargetFolderRevision?: string) => send<BitwardenFolderMutationResult>({ type: "BITWARDEN_CIPHER_MOVE_FOLDER", providerId, itemId, targetFolderId, expectedCipherRevision, expectedTargetFolderRevision }),
  listBitwardenCollections: (providerId: string, input: { pageSize?: number; cursor?: string } = {}) => send<BitwardenCollectionPage>({ type: "BITWARDEN_COLLECTION_LIST", providerId, ...input }),
  moveBitwardenCipherToCollections: (providerId: string, itemId: string, collectionIds: string[], expectedCipherRevision?: string) => send<BitwardenCollectionMutationResult>({ type: "BITWARDEN_CIPHER_MOVE_COLLECTIONS", providerId, itemId, collectionIds, expectedCipherRevision }),
  listBitwardenSends: (providerId: string, input: { pageSize?: number; cursor?: string } = {}) => send<BitwardenSendPage>({ type: "BITWARDEN_SEND_LIST", providerId, ...input }),
  getBitwardenSend: (providerId: string, sendId: string) => send<BitwardenSendDetail>({ type: "BITWARDEN_SEND_GET", providerId, sendId }),
  createBitwardenTextSend: (providerId: string, input: BitwardenSendTextInput) => send<BitwardenSendDetail>({ type: "BITWARDEN_SEND_CREATE_TEXT", providerId, input }),
  updateBitwardenSend: (providerId: string, input: BitwardenSendUpdateInput) => send<BitwardenSendDetail>({ type: "BITWARDEN_SEND_UPDATE", providerId, input }),
  deleteBitwardenSend: (providerId: string, sendId: string, expectedRevision?: string) => send<{ deleted: boolean }>({ type: "BITWARDEN_SEND_DELETE", providerId, sendId, expectedRevision, confirmed: true }),
  removeBitwardenSendPassword: (providerId: string, sendId: string, expectedRevision?: string) => send<BitwardenSendDetail>({ type: "BITWARDEN_SEND_REMOVE_PASSWORD", providerId, sendId, expectedRevision, confirmed: true }),
  beginBitwardenSendFileUpload: (providerId: string, input: BitwardenSendFileUploadInput) => send<ProviderAttachmentUploadBeginResult>({ type: "BITWARDEN_SEND_FILE_UPLOAD_BEGIN", providerId, input }),
  writeBitwardenSendFileChunk: (providerId: string, transferId: string, offset: number, bytes: Uint8Array) => send<ProviderAttachmentUploadChunkResult>({ type: "BITWARDEN_SEND_FILE_UPLOAD_CHUNK", providerId, transferId, offset, dataBase64: bytesToBase64(bytes) }),
  finishBitwardenSendFileUpload: (providerId: string, transferId: string) => send<BitwardenSendDetail>({ type: "BITWARDEN_SEND_FILE_UPLOAD_FINISH", providerId, transferId }),
  abortBitwardenSendFileUpload: (providerId: string, transferId: string) => send<boolean>({ type: "BITWARDEN_SEND_FILE_UPLOAD_ABORT", providerId, transferId }),
  mdbx2HostStatus: (providerId?: string) => send<Mdbx2HostStatus>({ type: "MDBX2_HOST_STATUS", providerId }),
  createMdbx2Vault: (input: { name: string; password: string; isDefaultSaveTarget?: boolean }) => send<{ account: ProviderAccount; session: Mdbx2VaultSessionSummary }>({ type: 'MDBX2_VAULT_CREATE', input }),
  beginMdbx2FileExport: (providerId: string) => send<Mdbx2FileExportBegin>({ type: "MDBX2_FILE_EXPORT_BEGIN", providerId }),
  readMdbx2FileExport: (providerId: string, downloadHandle: string, offset: number) => send<Mdbx2FileExportChunk>({ type: "MDBX2_FILE_EXPORT_READ", providerId, downloadHandle, offset }),
  releaseMdbx2FileExport: (providerId: string, downloadHandle: string) => send<boolean>({ type: "MDBX2_FILE_EXPORT_RELEASE", providerId, downloadHandle }),
  beginMdbx2Transfer: (sizeBytes: number, sha256?: string) => send<Mdbx2TransferBeginResult>({ type: "MDBX2_TRANSFER_BEGIN", sizeBytes, sha256 }),
  sendMdbx2Chunk: (transferId: string, offset: number, bytes: Uint8Array) => send<Mdbx2TransferChunkResult>({ type: "MDBX2_TRANSFER_CHUNK", transferId, offset, dataBase64: bytesToBase64(bytes) }),
  finishMdbx2Transfer: (transferId: string) => send<Mdbx2TransferFinishResult>({ type: "MDBX2_TRANSFER_FINISH", transferId }),
  abortMdbx2Transfer: (transferId: string) => send<boolean>({ type: "MDBX2_TRANSFER_ABORT", transferId }),
  releaseMdbx2File: (fileHandle: string) => send<boolean>({ type: "MDBX2_FILE_RELEASE", fileHandle }),
  inspectMdbx2Vault: (source: Mdbx2VaultSource) => send<Mdbx2VaultInspection>({ type: "MDBX2_VAULT_INSPECT", source }),
  openMdbx2Vault: (input: Mdbx2VaultOpenInput) => send<{ account: ProviderAccount; session: Mdbx2VaultSessionSummary }>({ type: "MDBX2_VAULT_OPEN", input }),
  detectMdbx2Import: (source: Mdbx2VaultSource, kind?: "mdbx-vault" | "mdbx-complete-backup-zip") => send<MdbxImportDetectResult>({ type: "MDBX2_IMPORT_DETECT", source, kind }),
  prepareMdbx2Import: (input: { operationId: string; source: Mdbx2VaultSource; credential: Mdbx2VaultCredential; name: string; kind?: "mdbx-vault" | "mdbx-complete-backup-zip" }) => send<MdbxImportPrepareResult>({ type: "MDBX2_IMPORT_PREPARE", ...input }),
  commitMdbx2Import: (input: { operationId: string; name: string; isDefaultSaveTarget?: boolean; pluginMasterPassword?: string }) => send<MdbxImportCommitResult>({ type: "MDBX2_IMPORT_COMMIT", ...input }),
  cancelMdbx2Import: (operationId: string) => send<{ cancelled: true }>({ type: "MDBX2_IMPORT_CANCEL", operationId }),
  recoverMdbx2Imports: (operationId?: string) => send<MdbxImportOperation[]>({ type: "MDBX2_IMPORT_RECOVER", operationId }),
  mdbx2VaultStatus: (providerId: string) => send<Mdbx2VaultRuntimeStatus>({ type: "MDBX2_VAULT_STATUS", providerId }),
  mdbx2VaultDiagnostics: (providerId: string) => send<Mdbx2VaultDiagnosticsReport>({ type: "MDBX2_VAULT_DIAGNOSTICS", providerId }),
  planMdbx2HealthRepair: (providerId: string) => send<Mdbx2HealthRepairPlan>({ type: "MDBX2_HEALTH_REPAIR_PLAN", providerId }),
  applyMdbx2HealthRepair: (providerId: string, planHandle: string, operationId: string, decisions: Mdbx2HealthRepairDecision[], confirmedDelete = false) =>
    send<Mdbx2HealthRepairApplyResult>({
      type: "MDBX2_HEALTH_REPAIR_APPLY",
      providerId,
      planHandle,
      operationId,
      decisions: decisions.map(({ itemHandle, choice }) => ({ itemHandle, choice })),
      ...(confirmedDelete ? { confirmedDelete: true as const } : {})
    }),
  mdbx2VaultTiga: (providerId: string) => send<Mdbx2VaultTigaPosture>({ type: "MDBX2_VAULT_TIGA", providerId }),
  lockMdbx2Vault: (providerId: string) => send<boolean>({ type: "MDBX2_VAULT_LOCK", providerId }),
  saveMdbx2WebDav: (providerId: string, name: string, config: Mdbx2WebDavSettingsInput, isDefaultSaveTarget = false) =>
    send<ProviderAccount>({ type: "MDBX2_WEBDAV_SAVE", providerId, name, config, isDefaultSaveTarget }),
  saveMdbx2OneDrive: (providerId: string, name: string, config: Mdbx2OneDriveSettingsInput, isDefaultSaveTarget = false) =>
    send<ProviderAccount>({ type: "MDBX2_ONEDRIVE_SAVE", providerId, name, config, isDefaultSaveTarget }),
  downloadMdbx2Bootstrap: (config: Mdbx2BootstrapDownloadInput) => send<Mdbx2TransferFinishResult>({ type: "MDBX2_BOOTSTRAP_DOWNLOAD", config }),
  publishMdbx2Bootstrap: (providerId: string) => send<Mdbx2ManagerSyncStatus>({ type: "MDBX2_BOOTSTRAP_PUBLISH", providerId }),
  registerMdbx2Bootstrap: (providerId: string) => send<Mdbx2ManagerSyncStatus>({ type: "MDBX2_BOOTSTRAP_REGISTER", providerId }),
  mdbx2SyncStatus: (providerId: string) => send<Mdbx2ManagerSyncStatus>({ type: "MDBX2_SYNC_STATUS", providerId }),
  listMdbx2Collections: (providerId: string, input: { deleted?: boolean; excludeRoot?: boolean; pageSize?: number; cursor?: string } = {}) => send<Mdbx2CollectionSummaryPage>({ type: "MDBX2_COLLECTION_LIST", providerId, ...input }),
  createMdbx2Collection: (providerId: string, operationId: string, collectionId: string, title: string, parentCollectionId?: string) => send<Mdbx2CollectionMutationResult>({ type: "MDBX2_COLLECTION_CREATE", providerId, operationId, collectionId, title, parentCollectionId }),
  renameMdbx2Collection: (providerId: string, operationId: string, collectionId: string, title: string) => send<Mdbx2CollectionMutationResult>({ type: "MDBX2_COLLECTION_RENAME", providerId, operationId, collectionId, title }),
  moveMdbx2Collection: (providerId: string, operationId: string, collectionId: string, parentCollectionId?: string) => send<Mdbx2CollectionMutationResult>({ type: "MDBX2_COLLECTION_MOVE", providerId, operationId, collectionId, parentCollectionId }),
  deleteMdbx2Collection: (providerId: string, operationId: string, collectionId: string) => send<Mdbx2CollectionMutationResult>({ type: "MDBX2_COLLECTION_DELETE", providerId, operationId, collectionId, confirmed: true }),
  restoreMdbx2Collection: (providerId: string, operationId: string, collectionId: string, parentCollectionId?: string) => send<Mdbx2CollectionMutationResult>({ type: "MDBX2_COLLECTION_RESTORE", providerId, operationId, collectionId, parentCollectionId }),
  listMdbx2Objects: (providerId: string, collectionId: string, input: { objectTypeId?: string; deleted?: boolean; pageSize?: number; cursor?: string } = {}) => send<Mdbx2ObjectSummaryPage>({ type: "MDBX2_OBJECT_LIST", providerId, collectionId, ...input }),
  revealMdbx2Object: (providerId: string, objectId: string) => send<Mdbx2ObjectRecord>({ type: "MDBX2_OBJECT_REVEAL", providerId, objectId }),
  upsertMdbx2Object: (providerId: string, operationId: string, input: Mdbx2ObjectUpsertInput) => send<Mdbx2ObjectWriteResult>({ type: "MDBX2_OBJECT_UPSERT", providerId, operationId, input }),
  deleteMdbx2Object: (providerId: string, operationId: string, logicalObjectId: string, expectedHeadCommitId?: string) => send<Mdbx2ObjectDeleteResult>({ type: "MDBX2_OBJECT_DELETE", providerId, operationId, logicalObjectId, expectedHeadCommitId }),
  listMdbx2PendingMoves: () => send<import("./messages").Mdbx2PendingMove[]>({ type: "MDBX2_PENDING_MOVES" }),
  planMdbx2BatchTransfer: (input: Mdbx2BatchTransferRequest) => send<Mdbx2BatchTransferPlanResult>({ type: "MDBX2_BATCH_TRANSFER_PLAN", input }),
  localTransferFolders: () => send<Array<{ key: string; categoryId?: number; categoryName: string }>>({ type: 'LOCAL_TRANSFER_FOLDERS' }),
  pendingKeePassTransfers: (providerId: string) => send<Array<{ request: Mdbx2BatchTransferRequest; plan: Mdbx2BatchTransferPlanResult }>>({ type: 'KEEPASS_PENDING_TRANSFERS', providerId }),
  cancelUnwrittenKeePassTransfer: (providerId: string, operationId: string) => send<void>({ type: 'KEEPASS_CANCEL_UNWRITTEN_TRANSFER', providerId, operationId }),
  pendingBitwardenTransfers: (providerId: string) => send<BitwardenPendingTransfer[]>({ type: 'BITWARDEN_PENDING_TRANSFERS', providerId }),
  keepBothBitwardenTransfer: (providerId: string, operationId: string, confirmed: boolean) => send<BitwardenPendingTransfer>({ type: 'BITWARDEN_KEEP_BOTH_TRANSFER', providerId, operationId, confirmed }),
  cancelUnwrittenBitwardenTransfer: (providerId: string, operationId: string) => send<void>({ type: 'BITWARDEN_CANCEL_UNWRITTEN_TRANSFER', providerId, operationId }),
  executeMdbx2BatchTransfer: (input: Mdbx2BatchTransferRequest, confirmed = false) => send<Mdbx2BatchTransferExecuteResult>({ type: "MDBX2_BATCH_TRANSFER_EXECUTE", input, ...(confirmed ? { confirmed: true as const } : {}) }),
  mdbx2BatchTransferStatus: (operationId: string) => send<Mdbx2BatchTransferStatus | undefined>({ type: "MDBX2_BATCH_TRANSFER_STATUS", operationId }),
  listMdbx2History: (providerId: string, input: { pageSize?: number; cursor?: string } = {}) => send<Mdbx2CommitHistoryPage>({ type: "MDBX2_HISTORY_LIST", providerId, ...input }),
  listMdbx2CommitDiff: (providerId: string, commitId: string) => send<Mdbx2CommitDiffResult>({ type: "MDBX2_HISTORY_DIFF", providerId, commitId }),
  revertMdbx2Commit: (providerId: string, operationId: string, commitId: string) => send<Mdbx2CommitRevertResult>({ type: "MDBX2_HISTORY_REVERT", providerId, operationId, commitId }),
  listMdbx2Snapshots: (providerId: string, input: { pageSize?: number; cursor?: string } = {}) => send<Mdbx2ManagedSnapshotPage>({ type: "MDBX2_SNAPSHOT_LIST", providerId, ...input }),
  listMdbx2SnapshotStructure: (providerId: string, snapshotId: string, side: Mdbx2SnapshotStructureSide, input: { pageSize?: number; cursor?: string } = {}) => send<Mdbx2SnapshotStructurePage>({ type: "MDBX2_SNAPSHOT_STRUCTURE", providerId, snapshotId, side, ...input }),
  planMdbx2AutomaticSnapshotPrune: (providerId: string, keepLatest = 0) => send<Mdbx2SnapshotPrunePlan>({ type: "MDBX2_SNAPSHOT_PRUNE_PLAN", providerId, keepLatest }),
  pruneMdbx2AutomaticSnapshots: (providerId: string, planToken: string, keepLatest = 0) => send<Mdbx2SnapshotPruneResult>({ type: "MDBX2_SNAPSHOT_PRUNE_EXECUTE", providerId, planToken, keepLatest }),
  createMdbx2Snapshot: (providerId: string, operationId: string, name: string) => send<Mdbx2SnapshotCreateResult>({ type: "MDBX2_SNAPSHOT_CREATE", providerId, operationId, name }),
  deleteMdbx2Snapshot: (providerId: string, operationId: string, snapshotId: string) => send<Mdbx2SnapshotDeleteResult>({ type: "MDBX2_SNAPSHOT_DELETE", providerId, operationId, snapshotId }),
  restoreMdbx2Snapshot: (providerId: string, operationId: string, snapshotId: string) => send<Mdbx2SnapshotRestoreResult>({ type: "MDBX2_SNAPSHOT_RESTORE", providerId, operationId, snapshotId }),
  listMdbx2Conflicts: (providerId: string, input: { pageSize?: number; cursor?: string } = {}) => send<Mdbx2ConflictSummaryPage>({ type: "MDBX2_CONFLICT_LIST", providerId, ...input }),
  resolveMdbx2Conflict: (providerId: string, operationId: string, conflictId: string, choice: Mdbx2ConflictResolutionChoice) => send<Mdbx2ConflictResolutionResult>({ type: "MDBX2_CONFLICT_RESOLVE", providerId, operationId, conflictId, choice }),
  transferProviderAttachment: (input: ProviderAttachmentTransferRequest) => send<ProviderAttachmentTransferResult>({ type: "PROVIDER_ATTACHMENT_TRANSFER", ...input }),
  listProviderAttachments: (providerId: string, itemId: string, input: { pageSize?: number; cursor?: string } = {}) => send<ProviderAttachmentPage>({ type: "PROVIDER_ATTACHMENT_LIST", providerId, itemId, ...input }),
  providerAttachmentRecoveryStatus: (providerId: string) => send<ProviderAttachmentRecoveryStatus>({ type: "PROVIDER_ATTACHMENT_RECOVERY_STATUS", providerId }),
  beginProviderAttachmentRead: (providerId: string, itemId: string, attachmentId: string) => send<ProviderAttachmentReadBeginResult>({ type: "PROVIDER_ATTACHMENT_READ_BEGIN", providerId, itemId, attachmentId }),
  readProviderAttachmentChunk: (providerId: string, readHandle: string, offset: number, maxBytes?: number) => send<ProviderAttachmentReadChunk>({ type: "PROVIDER_ATTACHMENT_READ_CHUNK", providerId, readHandle, offset, maxBytes }),
  releaseProviderAttachmentRead: (providerId: string, readHandle: string) => send<boolean>({ type: "PROVIDER_ATTACHMENT_READ_RELEASE", providerId, readHandle }),
  beginProviderAttachmentUpload: (providerId: string, itemId: string, input: { fileName: string; mediaType?: string; sizeBytes: number; sha256?: string; replaceExisting?: boolean; operationId?: string; attachmentId?: string; expectedRevision?: string }) => send<ProviderAttachmentUploadBeginResult>({ type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN", providerId, itemId, ...input }),
  sendProviderAttachmentChunk: (providerId: string, transferId: string, offset: number, bytes: Uint8Array) => send<ProviderAttachmentUploadChunkResult>({ type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK", providerId, transferId, offset, dataBase64: bytesToBase64(bytes) }),
  finishProviderAttachmentUpload: (providerId: string, itemId: string, transferId: string, operationId?: string) => send<ProviderAttachmentMutationResult>({ type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH", providerId, itemId, transferId, operationId }),
  abortProviderAttachmentUpload: (providerId: string, transferId: string) => send<boolean>({ type: "PROVIDER_ATTACHMENT_UPLOAD_ABORT", providerId, transferId }),
  deleteProviderAttachment: (providerId: string, itemId: string, attachmentId: string, operationId: string = crypto.randomUUID(), expectedRevision?: string) => send<ProviderAttachmentMutationResult>({ type: "PROVIDER_ATTACHMENT_DELETE", providerId, itemId, attachmentId, operationId, confirmed: true, expectedRevision }),
  listAndroidGeneratorHistory: (providerId: string) => send<AndroidGeneratorHistoryEntry[]>({ type: "ANDROID_GENERATOR_HISTORY_LIST", providerId }),
  deleteAndroidGeneratorHistory: (providerId: string, entryId: string) => send<boolean>({ type: "ANDROID_GENERATOR_HISTORY_DELETE", providerId, entryId, confirmed: true }),
  openKeePass: (input: KeePassOpenInput) => send<{ account: ProviderAccount; session: KeePassSessionSummary }>({ type: "KEEPASS_OPEN", input }),
  testKeePassWebDav: (input: KeePassWebDavTestInput) => send<KeePassRemoteProbeResult>({ type: "KEEPASS_WEBDAV_TEST", input }),
  openKeePassWebDav: (input: KeePassRemoteOpenInput) => send<{ account: ProviderAccount; session: KeePassSessionSummary }>({ type: "KEEPASS_WEBDAV_OPEN", input }),
  restoreKeePassRemote: (providerId: string) => send<KeePassSessionSummary>({ type: "KEEPASS_REMOTE_RESTORE", providerId }),
  keePassRemoteStatus: (providerId: string) => send<KeePassRemoteManagerStatus>({ type: "KEEPASS_REMOTE_STATUS", providerId }),
  keePassStatus: (providerId: string) => send<KeePassSessionSummary | undefined>({ type: "KEEPASS_STATUS", providerId }),
  listKeePassGroups: (providerId: string, input: { includeRecycleBin?: boolean; pageSize?: number; cursor?: string } = {}) => send<KeePassGroupPage>({ type: "KEEPASS_GROUP_LIST", providerId, ...input }),
  createKeePassGroup: (providerId: string, operationId: string, name: string, parentGroupId?: string) => send<KeePassGroupMutationResult>({ type: "KEEPASS_GROUP_CREATE", providerId, operationId, name, parentGroupId }),
  renameKeePassGroup: (providerId: string, operationId: string, groupId: string, name: string) => send<KeePassGroupMutationResult>({ type: "KEEPASS_GROUP_RENAME", providerId, operationId, groupId, name }),
  moveKeePassGroup: (providerId: string, operationId: string, groupId: string, targetParentGroupId?: string) => send<KeePassGroupMutationResult>({ type: "KEEPASS_GROUP_MOVE", providerId, operationId, groupId, targetParentGroupId }),
  deleteKeePassGroup: (providerId: string, operationId: string, groupId: string) => send<KeePassGroupMutationResult>({ type: "KEEPASS_GROUP_DELETE", providerId, operationId, groupId, confirmed: true }),
  restoreKeePassGroup: (providerId: string, operationId: string, groupId: string, targetParentGroupId?: string) => send<KeePassGroupMutationResult>({ type: "KEEPASS_GROUP_RESTORE", providerId, operationId, groupId, targetParentGroupId }),
  listKeePassHistory: (providerId: string, itemId: string, input: { pageSize?: number; cursor?: string } = {}) => send<KeePassHistoryPage>({ type: "KEEPASS_HISTORY_LIST", providerId, itemId, ...input }),
  getKeePassHistoryDetail: (providerId: string, itemId: string, historyId: string) => send<KeePassHistoryDetail>({ type: "KEEPASS_HISTORY_DETAIL", providerId, itemId, historyId }),
  revealKeePassHistoryField: (providerId: string, itemId: string, historyId: string, fieldId: string) => send<KeePassHistoryFieldValue>({ type: "KEEPASS_HISTORY_FIELD_REVEAL", providerId, itemId, historyId, fieldId }),
  restoreKeePassHistory: (providerId: string, itemId: string, operationId: string, historyId: string) => send<KeePassHistoryRestoreResult>({ type: "KEEPASS_HISTORY_RESTORE", providerId, itemId, operationId, historyId, confirmed: true }),
  exportKeePassFile: (providerId: string) => send<KeePassFileExport>({ type: "KEEPASS_EXPORT_FILE", providerId }),
  lockKeePass: (providerId?: string) => send<void>({ type: "KEEPASS_LOCK", providerId }),
  syncProvider: (providerId: string, allowEmptyRemote = false) => send<{ warnings: string[]; conflicts: number }>({
    type: "PROVIDER_SYNC",
    providerId,
    ...(allowEmptyRemote ? { allowEmptyRemote: true as const } : {})
  }),
  syncAllBitwarden: () => send<Array<{ providerId: string; ok: boolean; conflicts: number; warnings: number }>>({ type: "BITWARDEN_SYNC_ALL" }),
  cancelProviderSync: (providerId: string) => send<{ cancelled: boolean }>({ type: "PROVIDER_SYNC_CANCEL", providerId }),
  removeProvider: (providerId: string) => send<void>({ type: "PROVIDER_REMOVE", providerId })
};
import type { LoginItem } from "../core/model";
import type { KeePassOneDriveConnectInput, KeePassOneDriveConnectResult } from "../background/onedrive-keepass-connection";
import type { OneDriveBrowserInput, OneDriveBrowserPage, OneDriveLoginSummary } from "../providers/onedrive/onedrive-session";
