import { isLoginItem, createLoginItem, type BillingAddressItem, type CardItem, type IdentityItem, type LoginItem, type PasskeyItem, type PaymentAccountItem, type ProviderAccount, type TotpItem, type VaultItem } from "../core/model";
import { loginMatchScore, matchingLogins } from "../core/matching";
import { resolveLoginOtp } from "../core/login-otp";
import { ProviderRegistry, type ProviderSyncResult } from "../core/provider";
import {
  BITWARDEN_ATTACHMENT_MAX_BYTES,
  KEEPASS_ATTACHMENT_MAX_BYTES,
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS,
  PROVIDER_ATTACHMENT_UPLOAD_TTL_MS,
  ProviderAttachmentError,
  type ProviderAttachmentMutationResult,
  type ProviderAttachmentReadBeginResult,
  type ProviderAttachmentReadChunk,
  type ProviderAttachmentUploadBeginResult,
  type ProviderAttachmentUploadChunkResult
} from "../providers/attachments/attachment-contract";
import { paginateProviderAttachments } from "../providers/attachments/attachment-pagination";
import { ProviderAttachmentTransferCoordinator, type ProviderAttachmentTransferBackend } from "../providers/attachments/attachment-transfer";
import { ProviderAttachmentUploadStore } from "../providers/attachments/attachment-upload-store";
import { BitwardenClient } from "../providers/bitwarden/bitwarden-client";
import type { BitwardenSessionConfig } from "../providers/bitwarden/bitwarden-client";
import { BitwardenAttachmentDownloadService } from "../providers/bitwarden/bitwarden-attachments";
import { BitwardenAttachmentMutationService } from "../providers/bitwarden/bitwarden-attachment-mutations";
import { resolveBitwardenOrganizationKeys } from "../providers/bitwarden/bitwarden-organization";
import type { BitwardenSymmetricKey } from "../providers/bitwarden/bitwarden-crypto";
import { BitwardenProvider } from "../providers/bitwarden/bitwarden-provider";
import { BitwardenFolderError, BitwardenFolderService, type BitwardenFolderMutationResult } from "../providers/bitwarden/bitwarden-folders";
import { Mdbx2NativeClient, createChromeMdbx2NativeRuntime } from "../providers/mdbx2/native-client";
import { MDBX2_MAX_BINARY_CHUNK_BYTES, Mdbx2NativeHostError, type Mdbx2SyncStateStatus } from "../providers/mdbx2/native-contract";
import { Mdbx2Provider } from "../providers/mdbx2/mdbx2-provider";
import { Mdbx2BatchTransferCoordinator, type Mdbx2BatchTransferProgress, type Mdbx2BatchTransferStatus } from "../providers/mdbx2/mdbx2-batch-transfer-coordinator";
import { assertMdbx2TransferOperationId } from "../providers/mdbx2/mdbx2-transfer-identity";
import { Mdbx2TransferAttachmentService } from "../providers/mdbx2/mdbx2-transfer-attachments";
import { Mdbx2SyncCoordinator, type Mdbx2CloudSyncInput, type Mdbx2WebDavSyncConfig } from "../providers/mdbx2/mdbx2-sync-coordinator";
import { normalizeMdbx2RemotePath } from "../providers/mdbx2/mdbx2-sync-paths";
import { KeePassProvider, type KeePassSessionSummary } from "../providers/keepass/keepass-provider";
import { KeePassDurableSyncCoordinator } from "../providers/keepass/keepass-durable-sync";
import { KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG } from "../providers/keepass/keepass-receipt-crypto";
import { KeePassGroupError, type KeePassGroupMutationResult } from "../providers/keepass/keepass-groups";
import { KeePassHistoryError, type KeePassHistoryRestoreResult } from "../providers/keepass/keepass-history";
import { keePassMutationIntentSha256, keePassRemoteFailureInfo, KeePassRemoteSessionError, KeePassRemoteSessionService, type KeePassRemoteFailureInfo } from "../providers/keepass/keepass-remote-session";
import { KeePassWebDavError } from "../providers/keepass/keepass-webdav-client";
import {
  IndexedDbKeePassWorkingCopyStorage,
  KeePassWorkingCopyStoreError,
  type KeePassDurableMutationKind,
  type KeePassDurableMutationReceipt,
  type KeePassDurableMutationResult
} from "../providers/keepass/keepass-working-copy-store";
import { MonicaWebDavProvider, type MonicaWebDavConfig } from "../providers/webdav/monica-webdav-provider";
import { normalizeServerUrl } from "../providers/webdav/webdav-client";
import { cancelSteamMarketListing, getSteamInventoryOverview, getSteamMarketQuote, getSteamMiniProfileBackground, listSteamInventoryItems, listSteamMarketListings, sellSteamMarketItems } from "../providers/steam/steam-market";
import { listSteamAuthorizedDevices, listSteamConfirmations, listSteamPendingLogins, respondToSteamConfirmation, respondToSteamLogin } from "../providers/steam/steam-network";
import { revokeSteamAuthorizedDevice } from "../providers/steam/steam-revocation";
import { createProviderDiagnostic, redactProviderMessage } from "../providers/provider-diagnostics";
import { ProviderTransportError } from "../providers/provider-transport";
import { createSourceRecord } from "../core/source-records";
import type { CredentialCaptureInput, ExtensionRequest, ExtensionResponse, LoginMatchSummary, Mdbx2ManagerSyncStatus, Mdbx2WebDavSettingsInput, PasskeyMatchSummary, PasskeyPromptContext, PasskeyRequest, PasskeyResult, SavePromptContext, SavePromptProviderSummary, WalletFillKind, WalletFillPayload, WalletFillResult, WalletMatchSummary } from "../runtime/messages";
import { assertTrustedExtensionPage, assertTrustedManagerPage, isSecureSensitivePageUrl, requireTrustedWebPageSender } from "../runtime/sender-policy";
import { createAssertion, createPasskey, normalizeRpId, validateRpId } from "../passkey/webauthn-core";
import { validatePasskeyRequest } from "../passkey/request-policy";
import { hasExcludedUsablePasskey, normalizeCredentialId, passkeyAvailability, passkeyMatchesPageHost, passkeyRpIdsEqual, selectPasskeyCandidates } from "../passkey/source-policy";
import { base64ToBytes, bytesToBase64 } from "../security/encoding";
import { ChromeVaultSessionStore } from "../security/vault-session";
import { SecureVaultService, VaultLockedError } from "../security/secure-vault-service";
import { IndexedDbVaultStorage } from "../security/vault-storage";
import { ChromeVaultDeviceKeyStore } from "../security/vault-device-key";
import { configureSessionStorageAccess } from "./startup";

const LEGACY_VAULT_KEY = "monica.extension.credentials.v1";
const AUTO_LOCK_ALARM = "monica-vault-auto-lock";
const service = new SecureVaultService(new IndexedDbVaultStorage(), new ChromeVaultSessionStore(), () => Date.now(), new ChromeVaultDeviceKeyStore());
const providers = new ProviderRegistry();
providers.register(new MonicaWebDavProvider());
providers.register(new BitwardenProvider());
const mdbx2NativeClient = new Mdbx2NativeClient(createChromeMdbx2NativeRuntime());
const mdbx2SyncCoordinator = new Mdbx2SyncCoordinator(mdbx2NativeClient);
const mdbx2Provider = new Mdbx2Provider(mdbx2NativeClient, mdbx2SyncCoordinator);
providers.register(mdbx2Provider);
const keePassProvider = new KeePassProvider();
providers.register(keePassProvider);
const keePassWorkingCopies = new IndexedDbKeePassWorkingCopyStorage();
const keePassRemoteSessions = new KeePassRemoteSessionService(keePassProvider, keePassWorkingCopies);
const keePassDurableSync = new KeePassDurableSyncCoordinator(
  keePassProvider,
  keePassRemoteSessions,
  service,
  (account, config) => applyKeePassRemoteAccountConfig(account, config)
);
const mdbx2TransferAttachmentService = new Mdbx2TransferAttachmentService(
  mdbx2NativeClient,
  keePassProvider,
  (providerId) => service.getProviderSourceRecords(providerId)
);
const mdbx2BatchTransferCoordinator = new Mdbx2BatchTransferCoordinator(
  service,
  providers,
  mdbx2Provider,
  mdbx2NativeClient,
  mdbx2TransferAttachmentService
);
const providerAttachmentUploads = new ProviderAttachmentUploadStore();
const providerAttachmentTransfers = new ProviderAttachmentTransferCoordinator();
const providerAttachmentReads = new Map<string, { providerId: string; itemId: string; attachmentId: string; expiresAt: number }>();
const bitwardenAttachmentReadRoutes = new Map<string, { providerId: string; itemId: string; attachmentId: string; expiresAt: number }>();
const bitwardenClient = new BitwardenClient();
const bitwardenFolders = new BitwardenFolderService(bitwardenClient);
const bitwardenAttachmentDownloads = new BitwardenAttachmentDownloadService();
const bitwardenAttachmentMutations = new BitwardenAttachmentMutationService();
const CAPTURE_TTL_MS = 60_000;
const MDBX2_MAX_BASE64_CHUNK_LENGTH = Math.ceil(MDBX2_MAX_BINARY_CHUNK_BYTES / 3) * 4;
const PROVIDER_ATTACHMENT_MAX_BASE64_CHUNK_LENGTH = Math.ceil(PROVIDER_ATTACHMENT_CHUNK_BYTES / 3) * 4;
const USERNAME_CONTEXT_TTL_MS = 2 * 60_000;
const PASSKEY_COMPLETION_TTL_MS = 2 * 60_000;
const activeProviderSyncs = new Map<string, AbortController>();
const keePassMutationQueues = new Map<string, Promise<void>>();
const keePassPendingPersistence = new Map<string, {
  providerId: string;
  kind: KeePassDurableMutationKind;
  intentSha256: string;
  completedAt: string;
  result: unknown;
  durableResult: KeePassDurableMutationResult;
}>();
const MDBX2_BATCH_TRANSFER_STATUS_TTL_MS = 10 * 60_000;
const mdbx2BatchTransferStatuses = new Map<string, Mdbx2BatchTransferStatus>();

interface PendingCredentialCapture extends CredentialCaptureInput {
  id: string;
  tabId: number;
  frameId: number;
  sourceOrigin: string;
  createdAt: number;
  expiresAt: number;
  existingItemId?: string;
  existingTitle?: string;
  existingItemIds: string[];
}

const pendingCredentialCaptures = new Map<string, PendingCredentialCapture>();
interface PendingUsernameContext {
  tabId: number;
  frameId: number;
  documentId: string;
  origin: string;
  username: string;
  expiresAt: number;
}

const USERNAME_CONTEXT_PREFIX = "monica.credential.username.v1.";
const pendingUsernameContexts = new Map<string, PendingUsernameContext>();
interface PendingPasskeyRequest {
  id: string;
  request: PasskeyRequest;
  tabId: number;
  frameId: number;
  documentId: string;
  origin: string;
  rpId: string;
  expiresAt: number;
  matches: string[];
  saveTargets: Array<{ providerId: string; name: string; kind: "local" | "bitwarden" | "mdbx2" }>;
  defaultSaveTargetId?: string;
}

const PASSKEY_PENDING_PREFIX = "monica.passkey.pending.v1.";
interface PasskeyCompletionReceipt {
  id: string;
  tabId: number;
  frameId: number;
  documentId: string;
  origin: string;
  operation: PasskeyRequest["operation"];
  itemId: string;
  result: PasskeyResult;
  status: "prepared" | "committed";
  expiresAt: number;
}

const PASSKEY_COMPLETION_PREFIX = "monica.passkey.completion.v1.";
const pendingPasskeyRequests = new Map<string, PendingPasskeyRequest>();
const passkeyCompletionReceipts = new Map<string, PasskeyCompletionReceipt>();
const processingPasskeyRequests = new Set<string>();
const committingPasskeyRequests = new Set<string>();
const cancelledPasskeyRequests = new Set<string>();
const cancellingPasskeyRequests = new Set<string>();
class PasskeyUnavailableError extends Error {}
class PasskeyExcludedError extends Error {}
class PasskeyCancelledError extends Error {}
class PasskeyCommitUnknownError extends Error {}
const WEB_PAGE_REQUEST_TYPES = new Set<ExtensionRequest["type"]>([
  "CREDENTIAL_USERNAME_REMEMBER",
  "CREDENTIAL_CAPTURE",
  "CREDENTIAL_PENDING",
  "CREDENTIAL_ACCEPT",
  "CREDENTIAL_DISMISS",
  "PASSKEY_BEGIN",
  "PASSKEY_ACCEPT",
  "PASSKEY_DISMISS"
]);

void configureSessionStorageAccess(chrome.storage.session.setAccessLevel?.bind(chrome.storage.session));

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });
  void purgeExpiredPasskeySessionState().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });
  void purgeExpiredPasskeySessionState().catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    void purgeExpiredPasskeySessionState().catch(() => undefined);
    void service.status().then((status) => {
      if (status !== "unlocked") pendingCredentialCaptures.clear();
      if (status !== "unlocked") void clearPendingUsernameContexts();
      if (status !== "unlocked") void clearPendingPasskeyRequests();
      if (status !== "unlocked") abortProviderSyncs();
      if (status !== "unlocked") mdbx2NativeClient.close();
      if (status !== "unlocked") mdbx2Provider.lock();
      if (status !== "unlocked") keePassProvider.lock();
      if (status !== "unlocked") clearKeePassPendingPersistence();
      if (status !== "unlocked") clearBitwardenAttachmentSessions();
      if (status !== "unlocked") providerAttachmentUploads.clear();
      if (status !== "unlocked") mdbx2BatchTransferStatuses.clear();
    });
  }
});

chrome.runtime.onMessage.addListener((message: ExtensionRequest, sender, sendResponse: (response: ExtensionResponse) => void) => {
  handleRequest(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) => {
      const code = error instanceof VaultLockedError
        ? "VAULT_LOCKED"
        : error instanceof PasskeyUnavailableError
          ? "PASSKEY_UNAVAILABLE"
          : error instanceof PasskeyExcludedError
            ? "PASSKEY_EXCLUDED"
            : error instanceof PasskeyCancelledError
              ? "PASSKEY_CANCELLED"
              : error instanceof PasskeyCommitUnknownError
                ? "PASSKEY_COMMIT_UNKNOWN"
                : error instanceof Mdbx2NativeHostError || error instanceof ProviderAttachmentError || error instanceof BitwardenFolderError || error instanceof KeePassGroupError || error instanceof KeePassHistoryError || error instanceof KeePassRemoteSessionError || error instanceof KeePassWebDavError || error instanceof KeePassWorkingCopyStoreError || error instanceof ProviderTransportError
                  ? error.code
                  : undefined;
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "未知后台错误", code });
    });
  return true;
});

async function handleRequest(request: ExtensionRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!WEB_PAGE_REQUEST_TYPES.has(request.type)) assertExtensionPage(sender);
  switch (request.type) {
    case "VAULT_STATUS":
      return service.status();
    case "VAULT_SETUP": {
      assertExtensionPage(sender);
      const initialItems = await readLegacyItems();
      const state = await service.setup(request.masterPassword, initialItems);
      if (initialItems.length) await chrome.storage.local.remove(LEGACY_VAULT_KEY);
      return state.items.filter((item) => !item.deletedAt);
    }
    case "VAULT_UNLOCK": {
      assertExtensionPage(sender);
      return (await service.unlock(request.masterPassword)).items.filter((item) => !item.deletedAt);
    }
    case "VAULT_LOCK": {
      assertExtensionPage(sender);
      abortProviderSyncs();
      mdbx2NativeClient.close();
      mdbx2Provider.lock();
      keePassProvider.lock();
      clearKeePassPendingPersistence();
      clearBitwardenAttachmentSessions();
      providerAttachmentUploads.clear();
      pendingCredentialCaptures.clear();
      await clearPendingUsernameContexts();
      await clearPendingPasskeyRequests();
      mdbx2BatchTransferStatuses.clear();
      return service.lock();
    }
    case "VAULT_CHANGE_MASTER_PASSWORD":
      assertExtensionPage(sender);
      return service.changeMasterPassword(request.currentPassword, request.newPassword);
    case "VAULT_EXPORT_ENCRYPTED":
      assertExtensionPage(sender);
      return service.exportEncryptedBackup(request.backupPassword);
    case "VAULT_RESTORE_ENCRYPTED": {
      assertExtensionPage(sender);
      abortProviderSyncs();
      mdbx2NativeClient.close();
      mdbx2Provider.lock();
      keePassProvider.lock();
      clearKeePassPendingPersistence();
      clearBitwardenAttachmentSessions();
      providerAttachmentUploads.clear();
      const state = await service.restoreEncryptedBackup(request.backup, request.backupPassword, {
        replaceExisting: request.replaceExisting,
        currentPassword: request.currentPassword
      });
      pendingCredentialCaptures.clear();
      await clearPendingUsernameContexts();
      await clearPendingPasskeyRequests();
      return state.items.filter((item) => !item.deletedAt);
    }
    case "VAULT_IMPORT_ITEMS":
      assertExtensionPage(sender);
      return service.importItems(request.items);
    case "VAULT_LIST_ITEMS":
      assertExtensionPage(sender);
      return service.listItems();
    case "VAULT_GET_ITEM":
      assertExtensionPage(sender);
      return service.getItem(request.itemId);
    case "VAULT_UPSERT_ITEM":
      assertExtensionPage(sender);
      return service.upsertItem(request.item);
    case "VAULT_DELETE_ITEM":
      assertExtensionPage(sender);
      return service.deleteItem(request.itemId);
    case "VAULT_MATCH_LOGINS": {
      assertExtensionPage(sender);
      const matches = matchingLogins((await service.listItems()).filter(isLoginItem), request.pageUrl);
      return matches.map(toMatchSummary);
    }
    case "VAULT_MATCH_PASSKEYS": {
      assertExtensionPage(sender);
      const page = new URL(request.pageUrl);
      if (!isSecureSensitivePageUrl(page.toString())) return [];
      const pageHost = normalizeRpId(page.hostname);
      return (await service.listItems())
        .filter((item): item is PasskeyItem => item.kind === "passkey" && !item.deletedAt && passkeyMatchesPageHost(item, pageHost))
        .map((item): PasskeyMatchSummary => ({ id: item.id, title: item.title, userName: item.userName, userDisplayName: item.userDisplayName, sourceMode: item.sourceMode, availability: passkeyAvailability(item) as PasskeyMatchSummary["availability"], discoverable: item.discoverable, lastUsedAt: item.lastUsedAt, useCount: item.useCount || 0 }));
    }
    case "VAULT_FILL_LOGIN": {
      assertExtensionPage(sender);
      return fillLogin(request.itemId, request.tabId, request.frameId, request.documentId, request.expectedOrigin);
    }
    case "VAULT_LIST_WALLET_ITEMS": {
      assertExtensionPage(sender);
      return listWalletItems(request.kinds);
    }
    case "VAULT_FILL_WALLET": {
      assertExtensionPage(sender);
      return fillWalletItem(request.itemId, request.tabId, request.frameId, request.documentId, request.expectedOrigin);
    }
    case "STEAM_LIST_CONFIRMATIONS": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, listSteamConfirmations);
    }
    case "STEAM_RESPOND_CONFIRMATION": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, (item) => respondToSteamConfirmation(item, request.confirmation, request.accept));
    }
    case "STEAM_LIST_PENDING_LOGINS": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, listSteamPendingLogins);
    }
    case "STEAM_RESPOND_LOGIN": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, (item) => respondToSteamLogin(item, request.login, request.approve));
    }
    case "STEAM_LIST_AUTHORIZED_DEVICES": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, listSteamAuthorizedDevices);
    }
    case "STEAM_GET_INVENTORY_OVERVIEW": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, getSteamInventoryOverview);
    }
    case "STEAM_LIST_INVENTORY_ITEMS": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, (item) => listSteamInventoryItems(item, request));
    }
    case "STEAM_GET_MARKET_QUOTE": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, (item) => getSteamMarketQuote(item, request));
    }
    case "STEAM_LIST_MARKET_LISTINGS": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, (item) => listSteamMarketListings(item, request));
    }
    case "STEAM_SELL_MARKET_ITEMS": {
      assertExtensionPage(sender);
      if (request.confirmed !== true) throw new Error("Steam 出售操作需要明确确认。");
      return runSteamOperation(request.itemId, (item) => sellSteamMarketItems(item, request));
    }
    case "STEAM_CANCEL_MARKET_LISTING": {
      assertExtensionPage(sender);
      if (request.confirmed !== true) throw new Error("Steam 撤销挂单需要明确确认。");
      return runSteamOperation(request.itemId, (item) => cancelSteamMarketListing(item, request.listingId));
    }
    case "STEAM_GET_MINI_PROFILE_BACKGROUND": {
      assertExtensionPage(sender);
      return runSteamOperation(request.itemId, getSteamMiniProfileBackground);
    }
    case "STEAM_REVOKE_AUTHORIZED_DEVICE": {
      assertExtensionPage(sender);
      if (request.confirmed !== true) throw new Error("Steam 设备撤销需要明确确认。");
      let password = request.password;
      request.password = "";
      try {
        return await runSteamOperation(request.itemId, async (item) => {
          const target = (await listSteamAuthorizedDevices(item)).find((device) => device.tokenId === request.tokenId);
          if (!target) throw new Error("Steam 授权设备已不存在，请刷新列表。");
          if (target.isCurrent) throw new Error("当前 Steam 授权设备不能从 Monica 中撤销。");
          const input = { accountName: request.accountName, password, tokenId: target.tokenId };
          password = "";
          return revokeSteamAuthorizedDevice(item, input);
        });
      } finally {
        password = "";
        request.password = "";
      }
    }
    case "CREDENTIAL_USERNAME_REMEMBER":
      return rememberCredentialUsername(request.username, sender);
    case "CREDENTIAL_CAPTURE":
      return captureCredentialCandidate(request.candidate, sender);
    case "CREDENTIAL_PENDING":
      return pendingCredentialCandidate(sender);
    case "CREDENTIAL_ACCEPT":
      return acceptCredentialCandidate(request.candidateId, request.providerId, request.existingItemId, sender);
    case "CREDENTIAL_DISMISS":
      return dismissCredentialCandidate(request.candidateId, sender);
    case "PASSKEY_BEGIN":
      return beginPasskeyRequest(request.request, sender);
    case "PASSKEY_ACCEPT":
      return acceptPasskeyRequest(request.candidateId, request.itemId, request.providerId, sender);
    case "PASSKEY_DISMISS":
      return dismissPasskeyRequest(request.candidateId, sender);
    case "PROVIDER_LIST":
      assertExtensionPage(sender);
      return service.listProviders();
    case "PROVIDER_QUEUE_STATUS": {
      assertExtensionPage(sender);
      const queue = (await service.readState()).mutationQueue;
      return [...new Set(queue.map((item) => item.providerId))].map((providerId) => { const entries = queue.filter((item) => item.providerId === providerId); const lastError = [...entries].reverse().find((item) => item.lastError)?.lastError; return { providerId, pending: entries.length, failed: entries.filter((item) => item.lastError).length, maxAttempts: Math.max(0, ...entries.map((item) => item.attempts)), lastError: lastError ? redactProviderMessage(lastError) : undefined }; });
    }
    case "PROVIDER_CONFLICT_LIST":
      assertExtensionPage(sender);
      return service.listProviderConflicts(request.providerId);
    case "PROVIDER_CONFLICT_RESOLVE":
      assertExtensionPage(sender);
      return service.resolveProviderConflict(request.conflictId, request.resolution);
    case "PROVIDER_DIAGNOSTIC_EXPORT":
      assertExtensionPage(sender);
      return service.exportProviderDiagnostics();
    case "WEBDAV_TEST": {
      assertExtensionPage(sender);
      const existing = request.providerId ? await service.getProvider(request.providerId) : undefined;
      if (existing && existing.kind !== "monica-webdav") throw new Error("所选密码源不是 WebDAV。");
      const temporary: ProviderAccount = {
        id: "webdav-connection-test",
        kind: "monica-webdav",
        name: "WebDAV connection test",
        enabled: true,
        isDefaultSaveTarget: false,
        config: effectiveWebDavConfig(request.config, existing?.config)
      };
      return providers.get("monica-webdav").testConnection(temporary);
    }
    case "WEBDAV_SAVE": {
      assertExtensionPage(sender);
      const existing = request.providerId ? await service.getProvider(request.providerId) : undefined;
      if (existing && existing.kind !== "monica-webdav") throw new Error("所选密码源不是 WebDAV。");
      const previousConfig = existing?.config || {};
      const effectiveConfig = effectiveWebDavConfig(request.config, previousConfig);
      const connectionChanged = ["baseUrl", "username", "password", "backupPassword"].some((key) => previousConfig[key] !== effectiveConfig[key]);
      const config = connectionChanged
        ? effectiveConfig
        : { ...effectiveConfig, lastFileName: previousConfig.lastFileName, lastEtag: previousConfig.lastEtag };
      const account: ProviderAccount = {
        id: existing?.id || crypto.randomUUID(),
        kind: "monica-webdav",
        name: request.name.trim() || "Monica Android WebDAV",
        enabled: true,
        isDefaultSaveTarget: Boolean(request.isDefaultSaveTarget),
        config,
        lastSyncAt: connectionChanged ? undefined : existing?.lastSyncAt,
        lastError: undefined
      };
      await providers.get("monica-webdav").testConnection(account);
      return service.upsertProvider(account);
    }
    case "BITWARDEN_LOGIN": {
      assertExtensionPage(sender);
      const existing = request.providerId ? await service.getProvider(request.providerId) : undefined;
      if (existing && existing.kind !== "bitwarden") throw new Error("所选密码源不是 Bitwarden。");
      const result = await bitwardenClient.login({
        vaultUrl: request.vaultUrl,
        email: request.email,
        masterPassword: request.masterPassword,
        deviceId: typeof existing?.config.deviceId === "string" ? existing.config.deviceId : crypto.randomUUID(),
        twoFactorCode: request.twoFactorCode,
        twoFactorProvider: request.twoFactorProvider,
        rememberTwoFactor: request.rememberTwoFactor
      });
      if (result.status === "two-factor-required") return { status: result.status, providers: result.providers };
      const account: ProviderAccount = {
        id: existing?.id || crypto.randomUUID(),
        kind: "bitwarden",
        name: request.name.trim() || "Bitwarden",
        enabled: true,
        isDefaultSaveTarget: Boolean(request.isDefaultSaveTarget),
        config: result.session,
        lastSyncAt: undefined,
        lastError: undefined
      };
      await service.upsertProvider(account);
      return { status: "authenticated", providerId: account.id };
    }
    case "BITWARDEN_SEND_EMAIL_CODE": {
      assertExtensionPage(sender);
      const existing = request.providerId ? await service.getProvider(request.providerId) : undefined;
      return bitwardenClient.sendTwoFactorEmailCode({
        vaultUrl: request.vaultUrl,
        email: request.email,
        masterPassword: request.masterPassword,
        deviceId: typeof existing?.config.deviceId === "string" ? existing.config.deviceId : crypto.randomUUID()
      });
    }
    case "BITWARDEN_FOLDER_LIST": {
      assertManagerPage(sender);
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenFolders.list(readBitwardenSession(account), request, undefined);
      await persistBitwardenSession(account, result.session);
      return result.page;
    }
    case "BITWARDEN_FOLDER_CREATE": {
      assertManagerPage(sender);
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenFolders.create(readBitwardenSession(account), request.name);
      await persistBitwardenSession(account, result.session);
      return result.result;
    }
    case "BITWARDEN_FOLDER_RENAME": {
      assertManagerPage(sender);
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenFolders.rename(readBitwardenSession(account), request.folderId, request.name, request.expectedRevision);
      await persistBitwardenSession(account, result.session);
      return result.result;
    }
    case "BITWARDEN_FOLDER_DELETE": {
      assertManagerPage(sender);
      if (request.confirmed !== true) throw new BitwardenFolderError("folder-delete-confirmation-required", "删除 Bitwarden 文件夹需要明确确认。");
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenFolders.remove(readBitwardenSession(account), request.folderId, request.expectedRevision);
      await persistBitwardenSession(account, result.session);
      // Bitwarden clears FolderId on affected Ciphers after deleting a folder. Re-read the
      // encrypted projection before touching local references; an empty response is never
      // allowed to erase an existing local baseline.
      const synced = await bitwardenClient.sync(result.session);
      await acknowledgeBitwardenCipherProjection(account, synced.session, bitwardenRecordArray(synced.payload, "Ciphers", "ciphers"));
      await persistBitwardenSession(account, synced.session);
      return result.result;
    }
    case "BITWARDEN_CIPHER_MOVE_FOLDER": {
      assertManagerPage(sender);
      const account = await requireBitwardenAccountRecord(request.providerId);
      const item = await service.getItem(request.itemId);
      if (!item || !item.providerRefs.some((reference) => reference.providerId === account.id)) {
        throw new BitwardenFolderError("cipher-target-not-found", "项目不存在或不属于所选 Bitwarden 密码源。");
      }
      const cipherId = bitwardenCipherIdForItem(account.id, item);
      const result = await bitwardenFolders.moveCipher(
        readBitwardenSession(account),
        cipherId,
        request.targetFolderId,
        request.expectedCipherRevision,
        request.expectedTargetFolderRevision
      );
      if (!result.result.rawCipher) throw new BitwardenFolderError("cipher-response-invalid", "Bitwarden 移动响应缺少项目状态。");
      await acknowledgeBitwardenCipherProjection(account, result.session, [result.result.rawCipher], request.itemId);
      await persistBitwardenSession(account, result.session);
      return publicBitwardenFolderMutationResult(result.result);
    }
    case "MDBX2_HOST_STATUS":
      assertManagerPage(sender);
      return new Mdbx2NativeClient(createChromeMdbx2NativeRuntime()).probe();
    case "MDBX2_TRANSFER_BEGIN":
      assertManagerPage(sender);
      return mdbx2NativeClient.beginInboundTransfer(request.sizeBytes, request.sha256);
    case "MDBX2_TRANSFER_CHUNK":
      assertManagerPage(sender);
      if (typeof request.dataBase64 !== "string" || request.dataBase64.length > MDBX2_MAX_BASE64_CHUNK_LENGTH) throw new Error("MDBX2 文件分块超出允许范围。");
      return mdbx2NativeClient.sendInboundChunk(request.transferId, request.offset, base64ToBytes(request.dataBase64));
    case "MDBX2_TRANSFER_FINISH":
      assertManagerPage(sender);
      return mdbx2NativeClient.finishInboundTransfer(request.transferId);
    case "MDBX2_TRANSFER_ABORT":
      assertManagerPage(sender);
      return mdbx2NativeClient.abortInboundTransfer(request.transferId);
    case "MDBX2_FILE_RELEASE":
      assertManagerPage(sender);
      return mdbx2NativeClient.releaseFile(request.fileHandle);
    case "MDBX2_VAULT_INSPECT":
      assertManagerPage(sender);
      return mdbx2NativeClient.inspectVault(request.source);
    case "MDBX2_VAULT_OPEN": {
      assertManagerPage(sender);
      const existing = request.input.providerId ? await service.getProvider(request.input.providerId) : undefined;
      if (existing && existing.kind !== "mdbx2") throw new Error("所选密码源不是 MDBX2 保险库。");
      const existingHandle = typeof existing?.config.vaultHandle === "string" ? existing.config.vaultHandle : undefined;
      if (existing && (request.input.source.kind !== "vault" || request.input.source.handle !== existingHandle)) {
        throw new Error("已有 MDBX2 密码源只能重新打开其本机工作副本。");
      }
      const session = await mdbx2NativeClient.openVault(request.input.source, request.input.credential);
      const account: ProviderAccount = {
        id: existing?.id || crypto.randomUUID(),
        kind: "mdbx2",
        name: request.input.name.trim() || "Monica MDBX2",
        enabled: true,
        isDefaultSaveTarget: Boolean(request.input.isDefaultSaveTarget),
        config: {
          ...existing?.config,
          mdbxGeneration: 2,
          formatVersion: "MDBX-2",
          vaultHandle: session.vaultHandle,
          schemaVersion: session.schemaVersion,
          hostVerifiedAt: new Date().toISOString()
        },
        lastSyncAt: existing?.lastSyncAt,
        lastError: undefined
      };
      try {
        return { account: await service.upsertProvider(account), session };
      } catch (error) {
        await mdbx2NativeClient.lockVault(session.vaultHandle).catch(() => undefined);
        throw error;
      }
    }
    case "MDBX2_VAULT_STATUS": {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account || account.kind !== "mdbx2") throw new Error("MDBX2 密码源不存在。");
      const vaultHandle = typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : "";
      return mdbx2NativeClient.vaultStatus(vaultHandle);
    }
    case "MDBX2_VAULT_DIAGNOSTICS": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.vaultDiagnostics(vaultHandle);
    }
    case "MDBX2_HEALTH_REPAIR_PLAN": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.planHealthRepair(vaultHandle);
    }
    case "MDBX2_HEALTH_REPAIR_APPLY": {
      assertManagerPage(sender);
      if (!Array.isArray(request.decisions)) {
        throw new Mdbx2NativeHostError("params-invalid", "MDBX2 健康修复选择无效。", false);
      }
      const hasDeleteChoice = request.decisions.some((decision) =>
        (decision as { choice?: unknown } | null)?.choice === "delete-object"
      );
      if (hasDeleteChoice && request.confirmedDelete !== true) {
        throw new Mdbx2NativeHostError(
          "health-repair-delete-confirmation-required",
          "删除冲突项目需要再次明确确认。",
          false
        );
      }
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.applyHealthRepair(
        vaultHandle,
        request.planHandle,
        request.operationId,
        request.decisions
      );
    }
    case "MDBX2_VAULT_TIGA": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.vaultTiga(vaultHandle);
    }
    case "MDBX2_VAULT_LOCK": {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account || account.kind !== "mdbx2") throw new Error("MDBX2 密码源不存在。");
      const vaultHandle = typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : "";
      try {
        return await mdbx2NativeClient.lockVault(vaultHandle);
      } finally {
        mdbx2Provider.lockAccount(request.providerId);
      }
    }
    case "MDBX2_WEBDAV_SAVE": {
      assertManagerPage(sender);
      const account = await requireMdbx2Account(request.providerId);
      const previous = account.config;
      const config = effectiveMdbx2WebDavSettings(request.config, previous);
      const previousBaseUrl = stringAccountConfig(account, "webDavBaseUrl");
      const previousRemotePath = stringAccountConfig(account, "remotePath");
      const remoteBindingChanged = Boolean(previousBaseUrl || previousRemotePath)
        && (previousBaseUrl !== config.baseUrl || previousRemotePath !== config.remotePath);
      return service.upsertProvider({
        ...account,
        name: request.name.trim() || account.name || "Monica MDBX2",
        isDefaultSaveTarget: Boolean(request.isDefaultSaveTarget),
        config: {
          ...previous,
          webDavBaseUrl: config.baseUrl,
          webDavUsername: config.username,
          webDavPassword: config.password,
          remotePath: config.remotePath,
          syncStateHandle: remoteBindingChanged ? undefined : previous.syncStateHandle
        },
        lastSyncAt: remoteBindingChanged ? undefined : account.lastSyncAt,
        lastError: undefined
      });
    }
    case "MDBX2_BOOTSTRAP_DOWNLOAD": {
      assertManagerPage(sender);
      return mdbx2SyncCoordinator.downloadBootstrap(effectiveMdbx2WebDavSettings(request.config));
    }
    case "MDBX2_BOOTSTRAP_PUBLISH": {
      assertManagerPage(sender);
      const account = await requireMdbx2Account(request.providerId);
      const input = mdbx2CloudSyncInput(account, false);
      const published = await mdbx2SyncCoordinator.publishBootstrap(input);
      await service.upsertProvider({
        ...account,
        config: { ...account.config, syncStateHandle: published.stateHandle },
        lastError: undefined
      });
      return managerSyncStatus(published.status, true, true);
    }
    case "MDBX2_BOOTSTRAP_REGISTER": {
      assertManagerPage(sender);
      const account = await requireMdbx2Account(request.providerId);
      const config = mdbx2WebDavSyncConfig(account);
      const vaultHandle = stringAccountConfig(account, "vaultHandle");
      if (!vaultHandle) throw new Error("MDBX2 密码源缺少本机工作副本。");
      const status = await mdbx2SyncCoordinator.registerDownloadedBootstrap(
        vaultHandle,
        config
      );
      await service.upsertProvider({
        ...account,
        config: { ...account.config, syncStateHandle: status.stateHandle },
        lastError: undefined
      });
      return managerSyncStatus(status, true, true);
    }
    case "MDBX2_SYNC_STATUS": {
      assertManagerPage(sender);
      const account = await requireMdbx2Account(request.providerId);
      const configured = Boolean(stringAccountConfig(account, "webDavBaseUrl") && stringAccountConfig(account, "remotePath"));
      const syncStateHandle = stringAccountConfig(account, "syncStateHandle");
      if (!configured || !syncStateHandle) return managerSyncStatus(undefined, configured, false);
      return managerSyncStatus(await mdbx2SyncCoordinator.status(mdbx2CloudSyncInput(account, true)), true, true);
    }
    case "MDBX2_COLLECTION_LIST": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.listCollections(vaultHandle, request);
    }
    case "MDBX2_COLLECTION_CREATE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.createCollection(
        vaultHandle,
        request.operationId,
        request.collectionId,
        request.title,
        request.parentCollectionId
      );
    }
    case "MDBX2_COLLECTION_RENAME": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.renameCollection(
        vaultHandle,
        request.operationId,
        request.collectionId,
        request.title
      );
    }
    case "MDBX2_COLLECTION_MOVE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.moveCollection(
        vaultHandle,
        request.operationId,
        request.collectionId,
        request.parentCollectionId
      );
    }
    case "MDBX2_COLLECTION_DELETE": {
      assertManagerPage(sender);
      if (request.confirmed !== true) throw new Error("删除 MDBX2 文件夹需要明确确认。");
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.deleteCollection(vaultHandle, request.operationId, request.collectionId);
    }
    case "MDBX2_COLLECTION_RESTORE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.restoreCollection(
        vaultHandle,
        request.operationId,
        request.collectionId,
        request.parentCollectionId
      );
    }
    case "MDBX2_OBJECT_LIST": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.listObjects(vaultHandle, request.collectionId, request);
    }
    case "MDBX2_OBJECT_REVEAL": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.revealObject(vaultHandle, request.objectId);
    }
    case "MDBX2_OBJECT_UPSERT": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.upsertObject(vaultHandle, request.operationId, request.input);
    }
    case "MDBX2_OBJECT_DELETE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.deleteObject(vaultHandle, request.operationId, request.logicalObjectId);
    }
    case "MDBX2_BATCH_TRANSFER_PLAN":
      assertManagerPage(sender);
      return mdbx2BatchTransferCoordinator.plan(request.input);
    case "MDBX2_BATCH_TRANSFER_EXECUTE": {
      assertManagerPage(sender);
      pruneMdbx2BatchTransferStatuses();
      const operationId = assertMdbx2TransferOperationId(request.input.operationId || crypto.randomUUID());
      const input = { ...request.input, operationId, confirmed: request.confirmed === true };
      recordMdbx2BatchTransferProgress({
        operationId,
        phase: "preparing",
        processed: 0,
        total: new Set(request.input.itemIds).size,
        completedCount: 0,
        blockedCount: 0,
        failedCount: 0
      });
      try {
        return await mdbx2BatchTransferCoordinator.execute(input, recordMdbx2BatchTransferProgress);
      } catch (error) {
        const current = mdbx2BatchTransferStatuses.get(operationId);
        recordMdbx2BatchTransferProgress({
          operationId,
          phase: "failed",
          processed: current?.processed || 0,
          total: current?.total || new Set(request.input.itemIds).size,
          completedCount: current?.completedCount || 0,
          blockedCount: current?.blockedCount || 0,
          failedCount: Math.max(current?.failedCount || 0, 1)
        });
        throw error;
      }
    }
    case "MDBX2_BATCH_TRANSFER_STATUS":
      assertManagerPage(sender);
      pruneMdbx2BatchTransferStatuses();
      return mdbx2BatchTransferStatuses.get(assertMdbx2TransferOperationId(request.operationId));
    case "MDBX2_HISTORY_LIST": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.listCommitHistory(vaultHandle, request);
    }
    case "MDBX2_HISTORY_DIFF": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.listCommitDiff(vaultHandle, request.commitId);
    }
    case "MDBX2_HISTORY_REVERT": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.revertCommit(vaultHandle, request.operationId, request.commitId);
    }
    case "MDBX2_SNAPSHOT_LIST": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.listSnapshots(vaultHandle, request);
    }
    case "MDBX2_SNAPSHOT_STRUCTURE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.listSnapshotStructure(vaultHandle, request.snapshotId, request.side, request);
    }
    case "MDBX2_SNAPSHOT_PRUNE_PLAN": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.planAutomaticSnapshotPrune(vaultHandle, request.keepLatest);
    }
    case "MDBX2_SNAPSHOT_PRUNE_EXECUTE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.pruneAutomaticSnapshots(vaultHandle, request.planToken, request.keepLatest);
    }
    case "MDBX2_SNAPSHOT_CREATE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.createSnapshot(vaultHandle, request.operationId, request.name);
    }
    case "MDBX2_SNAPSHOT_DELETE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.deleteSnapshot(vaultHandle, request.operationId, request.snapshotId);
    }
    case "MDBX2_SNAPSHOT_RESTORE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.restoreSnapshot(vaultHandle, request.operationId, request.snapshotId);
    }
    case "MDBX2_CONFLICT_LIST": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.listConflicts(vaultHandle, request);
    }
    case "MDBX2_CONFLICT_RESOLVE": {
      assertManagerPage(sender);
      const vaultHandle = await requireMdbx2VaultHandle(request.providerId);
      return mdbx2NativeClient.resolveConflict(vaultHandle, request.operationId, request.conflictId, request.choice);
    }
    case "PROVIDER_ATTACHMENT_TRANSFER": {
      assertManagerPage(sender);
      return providerAttachmentTransfers.execute(request, providerAttachmentTransferBackend(sender));
    }
    case "PROVIDER_ATTACHMENT_LIST": {
      assertManagerPage(sender);
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === "keepass") return paginateProviderAttachments(keePassProvider.listAttachments(account, item), request);
      if (account.kind === "mdbx2") {
        const target = requireMdbx2AttachmentTarget(account, item);
        const page = await mdbx2NativeClient.listAttachments(target.vaultHandle, target.collectionId, target.objectId, request);
        return { items: page.items.map(providerAttachmentSummaryFromMdbx2), nextCursor: page.nextCursor };
      }
      if (account.kind === "bitwarden") {
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          const page = await bitwardenAttachmentDownloads.listAttachments(context, request);
          await persistBitwardenSession(account, context.session);
          return page;
        } finally {
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      throw unsupportedAttachmentProvider(account.kind);
    }
    case "PROVIDER_ATTACHMENT_RECOVERY_STATUS": {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account) throw new ProviderAttachmentError("attachment-provider-not-found", "附件密码源不存在。");
      if (account.kind !== "bitwarden") return { providerId: account.id, pending: [], completedCount: 0 };
      const records = await bitwardenAttachmentMutations.listRecoveryRecords(account.id);
      return {
        providerId: account.id,
        pending: records
          .filter((record) => record.stage !== "completed")
          .map((record) => ({ operationId: record.operationId, kind: record.kind, stage: record.stage, updatedAt: record.updatedAt })),
        completedCount: records.filter((record) => record.stage === "completed").length
      };
    }
    case "PROVIDER_ATTACHMENT_READ_BEGIN": {
      assertManagerPage(sender);
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === "keepass") {
        pruneProviderAttachmentReads();
        if (providerAttachmentReads.size >= PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS) {
          throw new ProviderAttachmentError("attachment-read-limit", "同时进行的附件下载过多，请完成或取消现有下载。");
        }
        const attachment = keePassProvider.listAttachments(account, item).find((candidate) => candidate.attachmentId === request.attachmentId);
        if (!attachment) throw new ProviderAttachmentError("attachment-not-found", "附件不存在或已被删除。");
        const readHandle = crypto.randomUUID();
        providerAttachmentReads.set(readHandle, {
          providerId: account.id,
          itemId: item.id,
          attachmentId: attachment.attachmentId,
          expiresAt: Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS
        });
        return { ...attachment, readHandle, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES };
      }
      if (account.kind === "mdbx2") {
        const target = requireMdbx2AttachmentTarget(account, item);
        const result = await mdbx2NativeClient.beginAttachmentRead(target.vaultHandle, request.attachmentId);
        return { ...providerAttachmentSummaryFromMdbx2(result), readHandle: result.readHandle, maxChunkBytes: result.maxChunkBytes };
      }
      if (account.kind === "bitwarden") {
        pruneProviderAttachmentReads();
        if (bitwardenAttachmentReadRoutes.size >= PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS) {
          throw new ProviderAttachmentError("attachment-read-limit", "同时进行的附件下载过多，请完成或取消现有下载。");
        }
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          const result = await bitwardenAttachmentDownloads.beginDownload({ ...context, attachmentId: request.attachmentId });
          await persistBitwardenSession(account, result.session);
          bitwardenAttachmentReadRoutes.set(result.readHandle, {
            providerId: account.id,
            itemId: item.id,
            attachmentId: result.attachmentId,
            expiresAt: Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS
          });
          const { session: _session, ...publicResult } = result;
          return publicResult;
        } finally {
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      throw unsupportedAttachmentProvider(account.kind);
    }
    case "PROVIDER_ATTACHMENT_READ_CHUNK": {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account) throw new ProviderAttachmentError("attachment-provider-not-found", "附件密码源不存在。");
      if (account.kind === "keepass") {
        pruneProviderAttachmentReads();
        const route = providerAttachmentReads.get(request.readHandle);
        if (!route || route.providerId !== account.id) throw new ProviderAttachmentError("attachment-read-not-found", "附件下载已过期，请重新开始。");
        const { item } = await requireAttachmentTarget(route.providerId, route.itemId);
        const result = keePassProvider.readAttachment(account, item, route.attachmentId, request.offset, request.maxBytes);
        route.expiresAt = Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
        try {
          return {
            readHandle: request.readHandle,
            attachmentId: result.attachment.attachmentId,
            fileName: result.attachment.fileName,
            sizeBytes: result.attachment.sizeBytes,
            offset: result.offset,
            nextOffset: result.nextOffset,
            dataBase64: bytesToBase64(result.bytes),
            eof: result.eof
          };
        } finally {
          result.bytes.fill(0);
        }
      }
      if (account.kind === "mdbx2") {
        const result = await mdbx2NativeClient.readAttachmentChunk(request.readHandle, request.offset, request.maxBytes);
        return { ...result };
      }
      if (account.kind === "bitwarden") {
        pruneProviderAttachmentReads();
        const route = bitwardenAttachmentReadRoutes.get(request.readHandle);
        if (!route || route.providerId !== account.id) throw new ProviderAttachmentError("attachment-read-not-found", "Bitwarden 附件下载已过期，请重新开始。");
        const maximum = request.maxBytes ?? PROVIDER_ATTACHMENT_CHUNK_BYTES;
        const result = bitwardenAttachmentDownloads.readChunk(account.id, request.readHandle, request.offset, maximum);
        route.expiresAt = Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
        try {
          return {
            readHandle: result.readHandle,
            attachmentId: result.attachmentId,
            fileName: result.fileName,
            sizeBytes: result.sizeBytes,
            offset: result.offset,
            nextOffset: result.nextOffset,
            dataBase64: bytesToBase64(result.bytes),
            eof: result.eof
          };
        } finally {
          result.bytes.fill(0);
        }
      }
      throw unsupportedAttachmentProvider(account.kind);
    }
    case "PROVIDER_ATTACHMENT_READ_RELEASE": {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account) return providerAttachmentReads.delete(request.readHandle);
      if (account.kind === "keepass") return providerAttachmentReads.delete(request.readHandle);
      if (account.kind === "mdbx2") return mdbx2NativeClient.releaseAttachmentRead(request.readHandle);
      if (account.kind === "bitwarden") {
        bitwardenAttachmentReadRoutes.delete(request.readHandle);
        return bitwardenAttachmentDownloads.release(account.id, request.readHandle);
      }
      throw unsupportedAttachmentProvider(account.kind);
    }
    case "PROVIDER_ATTACHMENT_UPLOAD_BEGIN": {
      assertManagerPage(sender);
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === "keepass") {
        keePassProvider.assertAttachmentTarget(account, item);
        if (request.replaceExisting) {
          const attachment = request.attachmentId
            ? keePassProvider.listAttachments(account, item).find((candidate) => candidate.attachmentId === request.attachmentId)
            : undefined;
          if (!attachment) throw new ProviderAttachmentError("attachment-not-found", "要替换的 KeePass 附件不存在，请刷新附件列表。");
          if (attachment.fileName !== request.fileName) throw new ProviderAttachmentError("attachment-target-mismatch", "KeePass 附件替换必须保留原文件名。");
        }
        return providerAttachmentUploads.begin({
          providerId: account.id,
          itemId: item.id,
          providerKind: "keepass",
          fileName: request.fileName,
          mediaType: request.mediaType,
          sizeBytes: request.sizeBytes,
          sha256: request.sha256,
          replaceExisting: request.replaceExisting === true,
          operationId: request.operationId,
          attachmentId: request.attachmentId
        }, KEEPASS_ATTACHMENT_MAX_BYTES);
      }
      if (account.kind === "mdbx2") {
        const target = requireMdbx2AttachmentTarget(account, item);
        const operationId = request.operationId || crypto.randomUUID();
        const attachmentId = request.replaceExisting
          ? request.attachmentId
          : request.attachmentId || operationId;
        if (!attachmentId) throw new ProviderAttachmentError("attachment-id-required", "替换 MDBX2 附件需要指定现有附件。");
        const result = await mdbx2NativeClient.beginAttachmentUpload(target.vaultHandle, {
          operationId,
          attachmentId,
          collectionId: target.collectionId,
          objectId: target.objectId,
          fileName: request.fileName,
          mediaType: request.mediaType,
          mode: request.replaceExisting ? "replace" : "create",
          sizeBytes: request.sizeBytes,
          sha256: request.sha256
        });
        return { ...result, expiresAt: Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS };
      }
      if (account.kind === "bitwarden") {
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          if (request.replaceExisting) {
            if (!request.attachmentId) throw new ProviderAttachmentError("attachment-id-required", "替换 Bitwarden 附件需要指定现有附件。");
            const page = await bitwardenAttachmentDownloads.listAttachments(context, { pageSize: 50 });
            const attachment = page.items.find((candidate) => candidate.attachmentId === request.attachmentId);
            if (!attachment) throw new ProviderAttachmentError("attachment-not-found", "要替换的 Bitwarden 附件不存在，请刷新附件列表。");
            if (attachment.fileName !== request.fileName) throw new ProviderAttachmentError("attachment-target-mismatch", "Bitwarden 附件替换必须保留原文件名。");
          }
          const operationId = request.operationId || crypto.randomUUID();
          return providerAttachmentUploads.begin({
            providerId: account.id,
            itemId: item.id,
            providerKind: "bitwarden",
            fileName: request.fileName,
            mediaType: request.mediaType,
            sizeBytes: request.sizeBytes,
            sha256: request.sha256,
            replaceExisting: request.replaceExisting === true,
            operationId,
            attachmentId: request.replaceExisting ? request.attachmentId : undefined
          }, BITWARDEN_ATTACHMENT_MAX_BYTES);
        } finally {
          await persistBitwardenSession(account, context.session);
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      throw unsupportedAttachmentProvider(account.kind);
    }
    case "PROVIDER_ATTACHMENT_UPLOAD_CHUNK": {
      assertManagerPage(sender);
      if (typeof request.dataBase64 !== "string" || request.dataBase64.length > PROVIDER_ATTACHMENT_MAX_BASE64_CHUNK_LENGTH) {
        throw new ProviderAttachmentError("attachment-upload-chunk-invalid", "附件上传分块编码超过安全上限。");
      }
      const account = await service.getProvider(request.providerId);
      if (!account) throw new ProviderAttachmentError("attachment-provider-not-found", "附件密码源不存在。");
      const bytes = base64ToBytes(request.dataBase64);
      try {
        if (account.kind === "keepass") {
          const intent = providerAttachmentUploads.intent(request.transferId);
          if (intent && (intent.providerId !== account.id || intent.providerKind !== "keepass")) {
            throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
          }
          return providerAttachmentUploads.write(request.transferId, request.offset, bytes);
        }
        if (account.kind === "bitwarden") {
          const intent = providerAttachmentUploads.intent(request.transferId);
          if (intent && (intent.providerId !== account.id || intent.providerKind !== "bitwarden")) {
            throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
          }
          return providerAttachmentUploads.write(request.transferId, request.offset, bytes);
        }
        if (account.kind === "mdbx2") return await mdbx2NativeClient.sendAttachmentUploadChunk(request.transferId, request.offset, bytes);
        throw unsupportedAttachmentProvider(account.kind);
      } finally {
        bytes.fill(0);
      }
    }
    case "PROVIDER_ATTACHMENT_UPLOAD_FINISH": {
      assertManagerPage(sender);
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === "keepass") {
        const durableOperationId = request.operationId || request.transferId;
        const durableIntent = request.operationId
          ? { itemId: request.itemId, operationId: request.operationId }
          : { itemId: request.itemId, transferId: request.transferId };
        return executeKeePassDurableMutation({
          account,
          operationId: durableOperationId,
          kind: "attachment-upload",
          intent: durableIntent,
          replay: (result) => {
            const replayed = replayKeePassAttachmentResult(account, item, result);
            if (providerAttachmentUploads.has(request.transferId)) providerAttachmentUploads.markCommitted(request.transferId, replayed);
            return replayed;
          },
          mutate: async () => {
            const intent = providerAttachmentUploads.intent(request.transferId);
            if (intent && (intent.providerId !== account.id || intent.itemId !== item.id || intent.providerKind !== "keepass")) {
              throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传目标与当前项目不一致。");
            }
            const committed = providerAttachmentUploads.committedResult(request.transferId);
            if (committed) return { result: committed, durableResult: durableKeePassAttachmentResult(account, item, committed) };
            const upload = await providerAttachmentUploads.complete(request.transferId);
            if (upload.intent.providerId !== account.id || upload.intent.itemId !== item.id || upload.intent.providerKind !== "keepass") {
              throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传目标与当前项目不一致。");
            }
            const attachment = await keePassProvider.addAttachment(
              account,
              item,
              upload.intent.fileName,
              upload.bytes,
              upload.intent.replaceExisting
            );
            const result = { changed: true, attachment };
            providerAttachmentUploads.markCommitted(request.transferId, result);
            return { result, durableResult: durableKeePassAttachmentResult(account, item, result) };
          }
        });
      }
      if (account.kind === "mdbx2") {
        requireMdbx2AttachmentTarget(account, item);
        const result = await mdbx2NativeClient.finishAttachmentUpload(request.transferId);
        return { changed: result.changed, attachment: providerAttachmentSummaryFromMdbx2(result.attachment) };
      }
      if (account.kind === "bitwarden") {
        const intent = providerAttachmentUploads.intent(request.transferId);
        if (!intent || intent.providerId !== account.id || intent.itemId !== item.id || intent.providerKind !== "bitwarden") {
          throw new ProviderAttachmentError("attachment-upload-target-mismatch", "Bitwarden 附件上传目标与当前项目不一致。");
        }
        const committed = providerAttachmentUploads.committedResult(request.transferId);
        if (committed) return committed;
        const upload = await providerAttachmentUploads.complete(request.transferId);
        const operationId = upload.intent.operationId || request.operationId;
        if (!operationId) throw new ProviderAttachmentError("attachment-operation-invalid", "Bitwarden 附件上传缺少可恢复的操作标识。");
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          const result = await bitwardenAttachmentMutations.upload({
            ...context,
            operationId,
            fileName: upload.intent.fileName,
            bytes: upload.bytes,
            sha256: upload.sha256,
            replaceAttachmentId: upload.intent.replaceExisting ? upload.intent.attachmentId : undefined
          });
          await acknowledgeBitwardenAttachmentMutation(account, item, result.session, result.rawCipher);
          const publicResult: ProviderAttachmentMutationResult = {
            changed: result.changed,
            attachment: result.attachment
          };
          providerAttachmentUploads.markCommitted(request.transferId, publicResult);
          return publicResult;
        } finally {
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      throw unsupportedAttachmentProvider(account.kind);
    }
    case "PROVIDER_ATTACHMENT_UPLOAD_ABORT": {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account) return providerAttachmentUploads.abort(request.transferId);
      if (account.kind === "keepass") {
        const intent = providerAttachmentUploads.intent(request.transferId);
        if (intent && (intent.providerId !== account.id || intent.providerKind !== "keepass")) {
          throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
        }
        return providerAttachmentUploads.abort(request.transferId);
      }
      if (account.kind === "mdbx2") return mdbx2NativeClient.abortAttachmentUpload(request.transferId);
      if (account.kind === "bitwarden") {
        const intent = providerAttachmentUploads.intent(request.transferId);
        if (intent && (intent.providerId !== account.id || intent.providerKind !== "bitwarden")) {
          throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
        }
        return providerAttachmentUploads.abort(request.transferId);
      }
      throw unsupportedAttachmentProvider(account.kind);
    }
    case "PROVIDER_ATTACHMENT_DELETE": {
      assertManagerPage(sender);
      if (request.confirmed !== true) throw new ProviderAttachmentError("attachment-delete-confirmation-required", "删除附件需要明确确认。");
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === "keepass") {
        return executeKeePassDurableMutation({
          account,
          operationId: request.operationId,
          kind: "attachment-delete",
          intent: { itemId: request.itemId, attachmentId: request.attachmentId },
          replay: (result) => {
            if (result.type !== "attachment-delete") throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 持久附件删除回执类型无效。");
            return { changed: result.changed };
          },
          mutate: () => {
            const result = { changed: keePassProvider.deleteAttachment(account, item, request.attachmentId) };
            return { result, durableResult: { type: "attachment-delete", changed: result.changed } };
          }
        });
      }
      if (account.kind === "mdbx2") {
        const target = requireMdbx2AttachmentTarget(account, item);
        const result = await mdbx2NativeClient.deleteAttachment(target.vaultHandle, request.operationId, request.attachmentId);
        return { changed: result.changed, attachment: providerAttachmentSummaryFromMdbx2(result.attachment) };
      }
      if (account.kind === "bitwarden") {
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          const result = await bitwardenAttachmentMutations.delete({
            ...context,
            operationId: request.operationId,
            attachmentId: request.attachmentId
          });
          await acknowledgeBitwardenAttachmentMutation(account, item, result.session, result.rawCipher);
          return { changed: result.changed };
        } finally {
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      throw unsupportedAttachmentProvider(account.kind);
    }
    case "KEEPASS_WEBDAV_TEST": {
      assertManagerPage(sender);
      const input = { ...request.input };
      const existing = input.providerId ? await service.getProvider(input.providerId) : undefined;
      if (existing && existing.kind !== "keepass") throw new Error("所选密码源不是 KeePass 数据库。");
      if (!input.webDavPassword && existing?.config.sourceMode === "webdav" && typeof existing.config.webDavPassword === "string") {
        input.webDavPassword = existing.config.webDavPassword;
      }
      request.input.webDavPassword = "";
      try {
        return await keePassRemoteSessions.probe(input);
      } finally {
        input.webDavPassword = "";
      }
    }
    case "KEEPASS_WEBDAV_OPEN": {
      assertManagerPage(sender);
      const existing = request.input.providerId ? await service.getProvider(request.input.providerId) : undefined;
      if (existing && existing.kind !== "keepass") throw new Error("所选密码源不是 KeePass 数据库。");
      const input = { ...request.input };
      if (existing?.config.sourceMode === "webdav") {
        if (!input.webDavPassword && typeof existing.config.webDavPassword === "string") input.webDavPassword = existing.config.webDavPassword;
        if (!input.databasePassword && typeof existing.config.databasePassword === "string") input.databasePassword = existing.config.databasePassword;
        if (input.keyFile === undefined && typeof existing.config.keyFile === "string") input.keyFile = existing.config.keyFile;
      }
      request.input.webDavPassword = "";
      request.input.databasePassword = "";
      request.input.keyFile = undefined;
      const account: ProviderAccount = {
        id: existing?.id || crypto.randomUUID(),
        kind: "keepass",
        name: input.name.trim() || "KeePass WebDAV",
        enabled: true,
        isDefaultSaveTarget: Boolean(input.isDefaultSaveTarget),
        config: {
          databaseId: Number.isSafeInteger(Number(existing?.config.databaseId)) && Number(existing?.config.databaseId) > 0
            ? Number(existing?.config.databaseId)
            : Date.now(),
          ...(typeof existing?.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG] === "string"
            ? { [KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]: existing.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG] }
            : {})
        },
        lastSyncAt: existing?.lastSyncAt,
        lastError: undefined
      };
      const previousWorkingCopy = await keePassWorkingCopies.read(account.id);
      try {
        const opened = await keePassRemoteSessions.open(account, input);
        let persisted: ProviderAccount;
        try {
          persisted = await service.upsertProvider({ ...account, config: opened.accountConfig });
        } catch (cause) {
          const currentWorkingCopy = await keePassWorkingCopies.read(account.id).catch(() => undefined);
          try {
            if (previousWorkingCopy && currentWorkingCopy) {
              await keePassWorkingCopies.save(previousWorkingCopy, currentWorkingCopy.revision).catch(() => undefined);
            } else if (!previousWorkingCopy) {
              await keePassWorkingCopies.delete(account.id).catch(() => undefined);
            }
          } finally {
            currentWorkingCopy?.baseBytes.fill(0);
            currentWorkingCopy?.workingBytes.fill(0);
          }
          keePassProvider.lockAccount(account.id);
          throw cause;
        }
        return { account: persisted, session: opened.session };
      } catch (cause) {
        if (!existing) await keePassRemoteSessions.remove(account.id).catch(() => undefined);
        throw cause;
      } finally {
        input.webDavPassword = "";
        input.databasePassword = "";
        input.keyFile = undefined;
        previousWorkingCopy?.baseBytes.fill(0);
        previousWorkingCopy?.workingBytes.fill(0);
      }
    }
    case "KEEPASS_REMOTE_RESTORE": {
      assertManagerPage(sender);
      const account = await requireKeePassAccountRecord(request.providerId);
      return ensureKeePassSession(account, true);
    }
    case "KEEPASS_REMOTE_STATUS": {
      assertManagerPage(sender);
      const account = await requireKeePassAccountRecord(request.providerId);
      return keePassRemoteSessions.managerStatus(account);
    }
    case "KEEPASS_OPEN": {
      assertManagerPage(sender);
      const existing = request.input.providerId ? await service.getProvider(request.input.providerId) : undefined;
      if (existing && existing.kind !== "keepass") throw new Error("所选密码源不是 KeePass 数据库。");
      const input = { ...request.input };
      request.input.password = "";
      request.input.keyFile = undefined;
      request.input.file = "";
      const account: ProviderAccount = {
        id: existing?.id || crypto.randomUUID(),
        kind: "keepass",
        name: input.name.trim() || input.fileName || "KeePass 数据库",
        enabled: true,
        isDefaultSaveTarget: Boolean(input.isDefaultSaveTarget),
        config: {
          databaseId: Number.isSafeInteger(Number(existing?.config.databaseId)) && Number(existing?.config.databaseId) > 0
            ? Number(existing?.config.databaseId)
            : Date.now(),
          sourceMode: "local-file",
          fileName: input.fileName,
          protectionMode: input.keyFile
            ? input.password ? "password-and-key-file" : "key-file"
            : input.password ? "password" : "empty"
        },
        lastSyncAt: existing?.lastSyncAt,
        lastError: undefined
      };
      let fileBytes: Uint8Array | undefined;
      let keyFileBytes: Uint8Array | undefined;
      try {
        fileBytes = base64ToBytes(input.file);
        keyFileBytes = input.keyFile ? base64ToBytes(input.keyFile) : undefined;
        // Unlocking first means a wrong credential never leaves a half-configured password source behind.
        const session = await keePassProvider.unlock(account, fileBytes, {
          password: input.password,
          keyFile: keyFileBytes,
          sourceName: input.fileName,
          sourceMode: "local-file"
        });
        const persisted = await service.upsertProvider(account);
        if (existing?.config.sourceMode === "webdav") await keePassWorkingCopies.delete(account.id).catch(() => undefined);
        return { account: persisted, session };
      } finally {
        input.password = "";
        input.keyFile = undefined;
        input.file = "";
        fileBytes?.fill(0);
        keyFileBytes?.fill(0);
      }
    }
    case "KEEPASS_STATUS": {
      assertManagerPage(sender);
      const account = await requireKeePassAccountRecord(request.providerId);
      return ensureKeePassSession(account, false);
    }
    case "KEEPASS_GROUP_LIST": {
      assertManagerPage(sender);
      const account = await requireKeePassAccount(request.providerId);
      return keePassProvider.listGroups(account, request);
    }
    case "KEEPASS_GROUP_CREATE": {
      assertManagerPage(sender);
      const account = await requireKeePassAccount(request.providerId);
      return executeKeePassDurableMutation({
        account,
        operationId: request.operationId,
        kind: "group-create",
        intent: { name: request.name, parentGroupId: request.parentGroupId },
        replay: (result) => replayKeePassGroupResult(account, result),
        mutate: () => {
          const result = keePassProvider.createGroup(account, request.operationId, request.name, request.parentGroupId);
          return { result, durableResult: durableKeePassGroupResult(account, result) };
        }
      });
    }
    case "KEEPASS_GROUP_RENAME": {
      assertManagerPage(sender);
      const account = await requireKeePassAccount(request.providerId);
      return executeKeePassDurableMutation({
        account,
        operationId: request.operationId,
        kind: "group-rename",
        intent: { groupId: request.groupId, name: request.name },
        replay: (result) => replayKeePassGroupResult(account, result),
        mutate: () => {
          const result = keePassProvider.renameGroup(account, request.operationId, request.groupId, request.name);
          return { result, durableResult: durableKeePassGroupResult(account, result) };
        }
      });
    }
    case "KEEPASS_GROUP_MOVE": {
      assertManagerPage(sender);
      const account = await requireKeePassAccount(request.providerId);
      return executeKeePassDurableMutation({
        account,
        operationId: request.operationId,
        kind: "group-move",
        intent: { groupId: request.groupId, targetParentGroupId: request.targetParentGroupId },
        replay: (result) => replayKeePassGroupResult(account, result),
        mutate: () => {
          const result = keePassProvider.moveGroup(account, request.operationId, request.groupId, request.targetParentGroupId);
          return { result, durableResult: durableKeePassGroupResult(account, result) };
        }
      });
    }
    case "KEEPASS_GROUP_DELETE": {
      assertManagerPage(sender);
      if (request.confirmed !== true) throw new KeePassGroupError("keepass-group-delete-confirmation-required", "删除 KeePass 分组需要明确确认。");
      const account = await requireKeePassAccount(request.providerId);
      return executeKeePassDurableMutation({
        account,
        operationId: request.operationId,
        kind: "group-delete",
        intent: { groupId: request.groupId },
        replay: (result) => replayKeePassGroupResult(account, result),
        mutate: () => {
          const result = keePassProvider.deleteGroup(account, request.operationId, request.groupId);
          return { result, durableResult: durableKeePassGroupResult(account, result) };
        }
      });
    }
    case "KEEPASS_GROUP_RESTORE": {
      assertManagerPage(sender);
      const account = await requireKeePassAccount(request.providerId);
      return executeKeePassDurableMutation({
        account,
        operationId: request.operationId,
        kind: "group-restore",
        intent: { groupId: request.groupId, targetParentGroupId: request.targetParentGroupId },
        replay: (result) => replayKeePassGroupResult(account, result),
        mutate: () => {
          const result = keePassProvider.restoreGroup(account, request.operationId, request.groupId, request.targetParentGroupId);
          return { result, durableResult: durableKeePassGroupResult(account, result) };
        }
      });
    }
    case "KEEPASS_HISTORY_LIST": {
      assertManagerPage(sender);
      const { account, item } = await requireKeePassHistoryTarget(request.providerId, request.itemId);
      return keePassProvider.listEntryHistory(account, item, request);
    }
    case "KEEPASS_HISTORY_DETAIL": {
      assertManagerPage(sender);
      const { account, item } = await requireKeePassHistoryTarget(request.providerId, request.itemId);
      return keePassProvider.getEntryHistoryDetail(account, item, request.historyId);
    }
    case "KEEPASS_HISTORY_FIELD_REVEAL": {
      assertManagerPage(sender);
      const { account, item } = await requireKeePassHistoryTarget(request.providerId, request.itemId);
      return keePassProvider.readEntryHistoryField(account, item, request.historyId, request.fieldId);
    }
    case "KEEPASS_HISTORY_RESTORE": {
      assertManagerPage(sender);
      if (request.confirmed !== true) {
        throw new KeePassHistoryError("keepass-history-restore-confirmation-required", "恢复 KeePass 历史版本需要明确确认。");
      }
      const { account, item } = await requireKeePassHistoryTarget(request.providerId, request.itemId);
      return executeKeePassDurableMutation({
        account,
        operationId: request.operationId,
        kind: "history-restore",
        intent: { itemId: request.itemId, historyId: request.historyId },
        replay: replayKeePassHistoryResult,
        mutate: () => {
          const result = keePassProvider.restoreEntryHistory(account, item, request.operationId, request.historyId);
          return { result, durableResult: durableKeePassHistoryResult(result) };
        }
      });
    }
    case "KEEPASS_EXPORT_FILE": {
      assertManagerPage(sender);
      const account = await requireKeePassAccount(request.providerId);
      const fileName = typeof account.config.fileName === "string" && account.config.fileName ? account.config.fileName : "monica.kdbx";
      return { fileName, file: bytesToBase64(await keePassProvider.exportFile(account.id)) };
    }
    case "KEEPASS_LOCK":
      assertManagerPage(sender);
      if (request.providerId) {
        keePassProvider.lockAccount(request.providerId);
        clearKeePassPendingPersistence(request.providerId);
      } else {
        keePassProvider.lock();
        clearKeePassPendingPersistence();
      }
      return undefined;
    case "PROVIDER_SYNC": {
      assertExtensionPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account) throw new Error("密码源不存在。");
      if (account.kind === "local") throw new Error("本地密码源不需要同步。");
      if (account.kind === "mdbx-legacy") throw new Error("MDBX1 密码源已停用，请先在 Monica Android 或桌面端升级为 MDBX2。");
      if (!account.enabled) throw new Error("此密码源已停用。");
      if (activeProviderSyncs.has(account.id)) throw new Error("此密码源正在同步。");
      if (account.kind === "keepass") await ensureKeePassSession(account, true);
      const controller = new AbortController();
      activeProviderSyncs.set(account.id, controller);
      const startedAt = Date.now();
      try {
        let result: ProviderSyncResult;
        if (account.kind === "keepass") {
          result = await synchronizeKeePassProvider(account, controller.signal);
        } else {
          // The adapter mutates its copy, so the snapshot is what `applyProviderSync` diffs a
          // concurrent local edit against. Both must be the same read of the vault.
          const snapshot = (await service.readState()).items;
          result = await providers.get(account.kind).sync(account, {
            signal: controller.signal,
            now: new Date().toISOString(),
            localItems: structuredClone(snapshot)
          });
          await service.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, snapshot);
        }
        await recordProviderDiagnosticIfUnlocked(createProviderDiagnostic(account.id, account.kind, undefined, new Date().toISOString(), {
          operation: "sync",
          outcome: result.conflicts.length ? "conflict" : "success",
          code: result.conflicts.length ? "conflict" : "ok",
          conflicts: result.conflicts.length,
          warnings: result.warnings.length,
          durationMs: Date.now() - startedAt,
          message: result.conflicts.length ? `发现 ${result.conflicts.length} 个同步冲突。` : "同步完成。"
        }));
        if (account.kind === "keepass" && account.config.sourceMode === "webdav") {
          await persistKeePassRemoteFailure(account.id, undefined);
        }
        return { warnings: result.warnings, conflicts: result.conflicts.length };
      } catch (error) {
        if (account.kind === "keepass" && account.config.sourceMode === "webdav") {
          keePassProvider.lockAccount(account.id);
          clearKeePassPendingPersistence(account.id);
        }
        const remoteFailure = account.kind === "keepass" && account.config.sourceMode === "webdav"
          ? keePassRemoteFailureInfo(error)
          : undefined;
        const diagnostic = createProviderDiagnostic(account.id, account.kind, error, new Date().toISOString(), {
          operation: "sync",
          durationMs: Date.now() - startedAt,
          code: remoteFailure?.code,
          retryable: remoteFailure?.retryable
        });
        if (diagnostic.outcome !== "cancelled") {
          await service.markProviderSyncFailure(account.id, diagnostic.message);
          if (remoteFailure) await persistKeePassRemoteFailure(account.id, remoteFailure, diagnostic.message);
          else {
            const latest = await service.getProvider(account.id);
            if (latest) await service.upsertProvider({ ...latest, lastError: diagnostic.message });
          }
        }
        await recordProviderDiagnosticIfUnlocked(diagnostic);
        if (remoteFailure && remoteFailure.code !== "unknown") throw error;
        throw new Error(diagnostic.message);
      } finally {
        activeProviderSyncs.delete(account.id);
      }
    }
    case "PROVIDER_SYNC_CANCEL": {
      assertExtensionPage(sender);
      const controller = activeProviderSyncs.get(request.providerId);
      controller?.abort(new DOMException("用户取消同步", "AbortError"));
      return { cancelled: Boolean(controller) };
    }
    case "PROVIDER_REMOVE":
      assertExtensionPage(sender);
      activeProviderSyncs.get(request.providerId)?.abort(new DOMException("密码源已移除", "AbortError"));
      {
        const account = await service.getProvider(request.providerId);
        const vaultHandle = account?.kind === "mdbx2" && typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : undefined;
        if (vaultHandle) await mdbx2NativeClient.lockVault(vaultHandle).catch(() => undefined);
      }
      mdbx2Provider.lockAccount(request.providerId);
      keePassProvider.lockAccount(request.providerId);
      clearKeePassPendingPersistence(request.providerId);
      clearBitwardenAttachmentSessions(request.providerId);
      providerAttachmentUploads.clear(request.providerId);
      await keePassWorkingCopies.delete(request.providerId).catch(() => undefined);
      return service.removeProvider(request.providerId);
  }
  throw new Error("不支持的 Monica 运行时命令。");
}

async function requireSteamItem(itemId: string): Promise<TotpItem> {
  const item = await service.getItem(itemId);
  if (!item || item.kind !== "totp" || item.otpType !== "STEAM") throw new Error("Steam 验证器不存在或类型不正确。");
  return structuredClone(item);
}

async function runSteamOperation<T>(itemId: string, operation: (item: TotpItem) => Promise<T>): Promise<T> {
  const item = await requireSteamItem(itemId);
  const before = JSON.stringify([item.steamAccessToken, item.steamRefreshToken, item.steamLoginSecure, item.steamRawJson]);
  const result = await operation(item);
  const after = JSON.stringify([item.steamAccessToken, item.steamRefreshToken, item.steamLoginSecure, item.steamRawJson]);
  if (before !== after) await service.upsertItem({ ...item, updatedAt: new Date().toISOString() });
  return result;
}

function abortProviderSyncs(): void {
  for (const controller of activeProviderSyncs.values()) controller.abort(new DOMException("密码库已锁定", "AbortError"));
  activeProviderSyncs.clear();
}

function effectiveWebDavConfig(config: MonicaWebDavConfig, previous: Record<string, unknown> = {}): MonicaWebDavConfig {
  return {
    ...config,
    password: config.password || (typeof previous.password === "string" ? previous.password : ""),
    backupPassword: config.backupPassword || (typeof previous.backupPassword === "string" ? previous.backupPassword : undefined)
  };
}

async function recordProviderDiagnosticIfUnlocked(diagnostic: Parameters<SecureVaultService["recordProviderDiagnostic"]>[0]): Promise<void> {
  try {
    await service.recordProviderDiagnostic(diagnostic);
  } catch (error) {
    if (!(error instanceof VaultLockedError)) throw error;
  }
}

function usernameContextStorageKey(source: { tabId: number; frameId: number; origin: string }): string {
  return `${USERNAME_CONTEXT_PREFIX}${source.tabId}.${source.frameId}.${encodeURIComponent(source.origin)}`;
}

async function rememberCredentialUsername(usernameInput: string, sender: chrome.runtime.MessageSender): Promise<void> {
  const source = assertWebPageSender(sender);
  if (!isSecureSensitivePageUrl(source.url) || (await service.status()) !== "unlocked") return;
  const username = String(usernameInput || "").trim().slice(0, 1024);
  if (!username) return;
  const context: PendingUsernameContext = {
    tabId: source.tabId,
    frameId: source.frameId,
    documentId: source.documentId,
    origin: source.origin,
    username,
    expiresAt: Date.now() + USERNAME_CONTEXT_TTL_MS
  };
  const key = usernameContextStorageKey(source);
  pendingUsernameContexts.set(key, context);
  await chrome.storage.session.set({ [key]: context });
}

async function loadCredentialUsername(source: { tabId: number; frameId: number; documentId: string; origin: string }): Promise<PendingUsernameContext | undefined> {
  const key = usernameContextStorageKey(source);
  const context = pendingUsernameContexts.get(key)
    || (await chrome.storage.session.get(key))[key] as PendingUsernameContext | undefined;
  if (!context
    || context.tabId !== source.tabId
    || context.frameId !== source.frameId
    || context.origin !== source.origin
    || context.expiresAt <= Date.now()) {
    pendingUsernameContexts.delete(key);
    if (context) await chrome.storage.session.remove(key);
    return undefined;
  }
  pendingUsernameContexts.set(key, context);
  return context;
}

async function deleteCredentialUsername(source: { tabId: number; frameId: number; origin: string }): Promise<void> {
  const key = usernameContextStorageKey(source);
  pendingUsernameContexts.delete(key);
  await chrome.storage.session.remove(key);
}

async function clearPendingUsernameContexts(): Promise<void> {
  pendingUsernameContexts.clear();
  const stored = await chrome.storage.session.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(USERNAME_CONTEXT_PREFIX));
  if (keys.length) await chrome.storage.session.remove(keys);
}

async function captureCredentialCandidate(input: CredentialCaptureInput, sender: chrome.runtime.MessageSender): Promise<SavePromptContext> {
  const source = assertWebPageSender(sender);
  if ((await service.status()) !== "unlocked") throw new VaultLockedError("密码库已锁定；请先解锁 Monica，再重新提交登录表单。");
  const submittedUsername = String(input.username || "").trim();
  const remembered = submittedUsername ? undefined : await loadCredentialUsername(source);
  let candidate: CredentialCaptureInput;
  try {
    candidate = validateCredentialCapture({
      ...input,
      username: submittedUsername || (remembered?.documentId !== source.documentId ? remembered?.username || "" : "")
    }, source.url);
  } finally {
    await deleteCredentialUsername(source);
  }
  purgeExpiredCaptures();

  const state = await service.readState();
  const matches = matchingLogins(state.items.filter(isLoginItem), candidate.pageUrl);
  const normalizedUsername = candidate.username.trim().toLocaleLowerCase();
  const existingCandidates = normalizedUsername
    ? matches.filter((item) => item.username.trim().toLocaleLowerCase() === normalizedUsername)
    : candidate.captureKind === "password-change" ? matches : [];
  const existing = existingCandidates.length === 1 ? existingCandidates[0] : undefined;
  const duplicate = [...pendingCredentialCaptures.values()].find((pending) =>
    pending.tabId === source.tabId
    && pending.sourceOrigin === source.origin
    && pending.username === candidate.username
    && pending.password === candidate.password
  );
  const now = Date.now();
  const pending: PendingCredentialCapture = {
    ...candidate,
    id: duplicate?.id || crypto.randomUUID(),
    tabId: source.tabId,
    frameId: source.frameId,
    sourceOrigin: source.origin,
    createdAt: duplicate?.createdAt || now,
    expiresAt: now + CAPTURE_TTL_MS,
    existingItemId: existing?.id,
    existingTitle: existing?.title,
    existingItemIds: existingCandidates.map((item) => item.id)
  };
  pendingCredentialCaptures.set(pending.id, pending);
  scheduleCaptureExpiry(pending.id, pending.expiresAt);
  const context = savePromptContext(pending, state.providers, state.settings.defaultProviderId, state.items.filter(isLoginItem));
  if (source.frameId !== 0) {
    void chrome.tabs.sendMessage(source.tabId, { type: "MONICA_SHOW_SAVE_PROMPT", context }, { frameId: 0 }).catch(() => undefined);
  }
  return context;
}

async function pendingCredentialCandidate(sender: chrome.runtime.MessageSender): Promise<SavePromptContext | null> {
  const source = assertWebPageSender(sender);
  purgeExpiredCaptures();
  const pending = [...pendingCredentialCaptures.values()]
    .filter((candidate) => candidate.tabId === source.tabId && candidate.sourceOrigin === source.origin)
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  if (!pending || (await service.status()) !== "unlocked") return null;
  const state = await service.readState();
  return savePromptContext(pending, state.providers, state.settings.defaultProviderId, state.items.filter(isLoginItem));
}

async function acceptCredentialCandidate(candidateId: string, requestedProviderId: string | undefined, requestedExistingItemId: string | undefined, sender: chrome.runtime.MessageSender) {
  const source = assertWebPageSender(sender);
  purgeExpiredCaptures();
  const pending = pendingCredentialCaptures.get(candidateId);
  if (!pending || pending.tabId !== source.tabId || (source.frameId !== pending.frameId && source.frameId !== 0)) throw new Error("保存候选已过期，请重新提交表单。");
  if ((await service.status()) !== "unlocked") throw new VaultLockedError("密码库已锁定，保存候选未写入。");

  let saved: LoginItem;
  let providerName = "Monica 本地库";
  const selectedExistingItemId = pending.existingItemId || requestedExistingItemId;
  if (requestedExistingItemId && !pending.existingItemIds.includes(requestedExistingItemId)) throw new Error("所选更新目标不属于当前保存候选。");
  if (pending.existingItemId && requestedExistingItemId && requestedExistingItemId !== pending.existingItemId) throw new Error("当前保存候选只能更新已匹配的登录项。");
  if (selectedExistingItemId) {
    const existing = await service.getItem(selectedExistingItemId);
    if (!existing || !isLoginItem(existing) || loginMatchScore(existing, pending.pageUrl) <= 0) throw new Error("待更新的登录项已不存在或网站不匹配。");
    saved = await service.upsertItem({
      ...existing,
      username: pending.username.trim() || existing.username,
      password: pending.password
    }) as LoginItem;
    const firstReference = saved.providerRefs[0];
    if (firstReference) providerName = (await service.getProvider(firstReference.providerId))?.name || providerName;
  } else {
    const state = await service.readState();
    const providerId = requestedProviderId || state.settings.defaultProviderId;
    const provider = state.providers.find((candidate) => candidate.id === providerId && candidate.enabled);
    if (!provider) throw new Error("所选密码源不存在或已禁用。");
    providerName = provider.name;
    saved = await service.upsertItem(createLoginItem({
      title: pending.pageTitle || new URL(pending.pageUrl).hostname,
      username: pending.username,
      password: pending.password,
      uris: [new URL(pending.pageUrl).origin],
      providerRefs: provider.kind === "local" ? [] : [{ providerId: provider.id }]
    })) as LoginItem;
  }
  pendingCredentialCaptures.delete(candidateId);
  return {
    action: selectedExistingItemId ? "updated" : "saved",
    itemId: saved.id,
    title: saved.title,
    providerName,
    syncPending: saved.providerRefs.length > 0
  };
}

function dismissCredentialCandidate(candidateId: string, sender: chrome.runtime.MessageSender): void {
  const source = assertWebPageSender(sender);
  const pending = pendingCredentialCaptures.get(candidateId);
  if (pending?.tabId === source.tabId && (source.frameId === pending.frameId || source.frameId === 0)) pendingCredentialCaptures.delete(candidateId);
}

function savePromptContext(pending: PendingCredentialCapture, providers: ProviderAccount[], defaultProviderId: string, logins: LoginItem[]): SavePromptContext {
  const summaries: SavePromptProviderSummary[] = providers.filter((provider) => provider.enabled).map((provider) => ({
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    isDefault: provider.id === defaultProviderId
  }));
  const updateTargets = pending.existingItemIds.flatMap((itemId) => {
    const item = logins.find((candidate) => candidate.id === itemId);
    if (!item) return [];
    const providerNames = item.providerRefs.map((reference) => providers.find((provider) => provider.id === reference.providerId)?.name).filter(Boolean);
    return [{ id: item.id, title: item.title, username: item.username, providerName: providerNames.join("、") || "Monica 本地库" }];
  });
  return {
    candidateId: pending.id,
    action: pending.existingItemId ? "update" : updateTargets.length > 1 ? "choose" : "save",
    title: pending.pageTitle,
    username: pending.username,
    host: new URL(pending.pageUrl).hostname,
    existingItemId: pending.existingItemId,
    existingTitle: pending.existingTitle,
    updateTargets,
    providers: summaries,
    defaultProviderId,
    expiresAt: pending.expiresAt
  };
}

function validateCredentialCapture(input: CredentialCaptureInput, senderUrl: string): CredentialCaptureInput {
  const page = new URL(input.pageUrl);
  const sender = new URL(senderUrl);
  if (!/^https?:$/.test(page.protocol) || page.origin !== sender.origin) throw new Error("凭据候选来源与当前页面不匹配。");
  if (!isSecureSensitivePageUrl(page.toString())) throw new Error("已阻止从不安全的 HTTP 页面保存密码。");
  const username = String(input.username || "").trim().slice(0, 1024);
  const password = String(input.password || "");
  if (!password || password.length > 8192) throw new Error("捕获的密码为空或过长。");
  return {
    username,
    password,
    pageUrl: page.toString(),
    pageTitle: String(input.pageTitle || "").trim().slice(0, 200),
    captureKind: input.captureKind === "password-change" ? "password-change" : "login"
  };
}

function assertWebPageSender(sender: chrome.runtime.MessageSender): { tabId: number; frameId: number; documentId: string; url: string; origin: string } {
  return requireTrustedWebPageSender(sender, chrome.runtime.id);
}

function purgeExpiredCaptures(): void {
  const now = Date.now();
  for (const [id, capture] of pendingCredentialCaptures) if (capture.expiresAt <= now) pendingCredentialCaptures.delete(id);
}

function scheduleCaptureExpiry(candidateId: string, expiresAt: number): void {
  setTimeout(() => {
    const candidate = pendingCredentialCaptures.get(candidateId);
    if (candidate && candidate.expiresAt <= Date.now()) pendingCredentialCaptures.delete(candidateId);
  }, Math.max(0, expiresAt - Date.now()) + 50);
}

function pendingPasskeyStorageKey(candidateId: string): string {
  return `${PASSKEY_PENDING_PREFIX}${candidateId}`;
}

function passkeyCompletionStorageKey(candidateId: string): string {
  return `${PASSKEY_COMPLETION_PREFIX}${candidateId}`;
}

async function persistPendingPasskeyRequest(pending: PendingPasskeyRequest): Promise<void> {
  pendingPasskeyRequests.set(pending.id, pending);
  await chrome.storage.session.set({ [pendingPasskeyStorageKey(pending.id)]: pending });
}

async function loadPendingPasskeyRequest(candidateId: string): Promise<PendingPasskeyRequest | undefined> {
  const cached = pendingPasskeyRequests.get(candidateId);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      await deletePendingPasskeyRequest(candidateId);
      return undefined;
    }
    return cached;
  }
  const key = pendingPasskeyStorageKey(candidateId);
  const stored = (await chrome.storage.session.get(key))[key] as PendingPasskeyRequest | undefined;
  if (!stored || stored.id !== candidateId || stored.expiresAt <= Date.now()) {
    if (stored) await chrome.storage.session.remove(key);
    return undefined;
  }
  pendingPasskeyRequests.set(candidateId, stored);
  return stored;
}

async function deletePendingPasskeyRequest(candidateId: string): Promise<void> {
  pendingPasskeyRequests.delete(candidateId);
  await chrome.storage.session.remove(pendingPasskeyStorageKey(candidateId));
}

async function persistPasskeyCompletionReceipt(receipt: PasskeyCompletionReceipt): Promise<void> {
  passkeyCompletionReceipts.set(receipt.id, receipt);
  await chrome.storage.session.set({ [passkeyCompletionStorageKey(receipt.id)]: receipt });
}

async function refreshPasskeyCompletionReceipt(receipt: PasskeyCompletionReceipt, status = receipt.status): Promise<PasskeyCompletionReceipt> {
  const refreshed = { ...receipt, status, expiresAt: Date.now() + PASSKEY_COMPLETION_TTL_MS };
  passkeyCompletionReceipts.set(receipt.id, refreshed);
  try {
    await chrome.storage.session.set({ [passkeyCompletionStorageKey(receipt.id)]: refreshed });
  } catch {
    // Keep the recoverable receipt in memory; a later query can retry persistence.
  }
  return refreshed;
}

async function resolveExpiredPasskeyCompletionReceipt(receipt: PasskeyCompletionReceipt): Promise<PasskeyCompletionReceipt | undefined> {
  if (receipt.status !== "prepared") {
    await deletePasskeyCompletionReceipt(receipt.id);
    return undefined;
  }
  const commitState = await passkeyReceiptCommitState(receipt);
  if (commitState === "not-committed") {
    await deletePasskeyCompletionReceipt(receipt.id);
    return undefined;
  }
  return refreshPasskeyCompletionReceipt(receipt, commitState === "committed" ? "committed" : "prepared");
}

async function loadPasskeyCompletionReceipt(candidateId: string): Promise<PasskeyCompletionReceipt | undefined> {
  const cached = passkeyCompletionReceipts.get(candidateId);
  if (cached) {
    if (cached.expiresAt <= Date.now()) return resolveExpiredPasskeyCompletionReceipt(cached);
    return cached;
  }
  const key = passkeyCompletionStorageKey(candidateId);
  const stored = (await chrome.storage.session.get(key))[key] as PasskeyCompletionReceipt | undefined;
  if (!stored || stored.id !== candidateId) {
    if (stored) await chrome.storage.session.remove(key);
    return undefined;
  }
  if (stored.expiresAt <= Date.now()) return resolveExpiredPasskeyCompletionReceipt(stored);
  passkeyCompletionReceipts.set(candidateId, stored);
  return stored;
}

async function deletePasskeyCompletionReceipt(candidateId: string): Promise<void> {
  passkeyCompletionReceipts.delete(candidateId);
  await chrome.storage.session.remove(passkeyCompletionStorageKey(candidateId));
}

function passkeyReceiptMatchesSource(receipt: PasskeyCompletionReceipt, source: { tabId: number; frameId: number; documentId: string; origin: string }): boolean {
  return receipt.tabId === source.tabId
    && receipt.frameId === source.frameId
    && receipt.documentId === source.documentId
    && receipt.origin === source.origin;
}

async function promotePasskeyCompletionReceipt(receipt: PasskeyCompletionReceipt): Promise<void> {
  if (receipt.status === "committed") return;
  const committed = { ...receipt, status: "committed" as const };
  passkeyCompletionReceipts.set(receipt.id, committed);
  try {
    await chrome.storage.session.set({ [passkeyCompletionStorageKey(receipt.id)]: committed });
  } catch {
    // The in-memory committed receipt still closes the response/cancellation race.
    // A persisted prepared receipt is reconciled against the stable item id after a worker restart.
  }
}

async function passkeyReceiptCommitState(receipt: PasskeyCompletionReceipt): Promise<"committed" | "not-committed" | "unknown"> {
  if (receipt.status === "committed" || receipt.operation === "get") return "committed";
  try {
    const item = await service.getItem(receipt.itemId);
    return item && item.kind === "passkey" && !item.deletedAt && normalizeCredentialId(item.credentialId) === normalizeCredentialId(receipt.result.id)
      ? "committed"
      : "not-committed";
  } catch (error) {
    if (error instanceof VaultLockedError) return "unknown";
    throw error;
  }
}

async function cancelPendingPasskeyRequest(candidateId: string): Promise<boolean> {
  if (committingPasskeyRequests.has(candidateId)) return false;
  if (processingPasskeyRequests.has(candidateId)) {
    cancelledPasskeyRequests.add(candidateId);
    await Promise.allSettled([deletePendingPasskeyRequest(candidateId), deletePasskeyCompletionReceipt(candidateId)]);
    return true;
  }
  if (cancellingPasskeyRequests.has(candidateId)) return true;
  cancellingPasskeyRequests.add(candidateId);
  try {
    const receipt = await loadPasskeyCompletionReceipt(candidateId);
    if (committingPasskeyRequests.has(candidateId)) return false;
    if (receipt) {
      const commitState = await passkeyReceiptCommitState(receipt);
      if (commitState !== "not-committed") {
        if (commitState === "committed") await promotePasskeyCompletionReceipt(receipt);
        return false;
      }
    }
    if (receipt) await deletePasskeyCompletionReceipt(candidateId);
    await deletePendingPasskeyRequest(candidateId);
    return true;
  } finally {
    cancellingPasskeyRequests.delete(candidateId);
  }
}

async function clearPendingPasskeyRequests(): Promise<void> {
  const stored = await chrome.storage.session.get(null);
  const pendingById = new Map(pendingPasskeyRequests);
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PASSKEY_PENDING_PREFIX)) continue;
    const pending = value as PendingPasskeyRequest | undefined;
    if (pending?.id && pending.expiresAt > Date.now()) pendingById.set(pending.id, pending);
  }
  const cancelled: string[] = [];
  for (const candidateId of processingPasskeyRequests) {
    if (!committingPasskeyRequests.has(candidateId)) {
      cancelledPasskeyRequests.add(candidateId);
      cancelled.push(candidateId);
    }
  }
  await Promise.allSettled(cancelled.map((candidateId) => deletePasskeyCompletionReceipt(candidateId)));
  pendingPasskeyRequests.clear();
  const keys = Object.keys(stored).filter((key) => key.startsWith(PASSKEY_PENDING_PREFIX));
  if (keys.length) await chrome.storage.session.remove(keys);
  const cancelledPending: PendingPasskeyRequest[] = [];
  for (const pending of pendingById.values()) {
    if (committingPasskeyRequests.has(pending.id)) continue;
    const receipt = await loadPasskeyCompletionReceipt(pending.id);
    if (receipt) {
      const commitState = await passkeyReceiptCommitState(receipt);
      if (commitState !== "not-committed") {
        if (commitState === "committed") await promotePasskeyCompletionReceipt(receipt);
        continue;
      }
    }
    cancelledPending.push(pending);
  }
  await Promise.allSettled(cancelledPending.map((pending) => chrome.tabs.sendMessage(
    pending.tabId,
    { type: "MONICA_CANCEL_PASSKEY", candidateId: pending.id },
    { documentId: pending.documentId }
  )));
}

async function purgeExpiredPasskeySessionState(): Promise<void> {
  const now = Date.now();
  const stored = await chrome.storage.session.get(null);
  const expiredKeys: string[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PASSKEY_PENDING_PREFIX) && !key.startsWith(PASSKEY_COMPLETION_PREFIX)) continue;
    const expiresAt = Number((value as { expiresAt?: unknown } | undefined)?.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > now) continue;
    if (key.startsWith(PASSKEY_COMPLETION_PREFIX)) {
      const receipt = value as PasskeyCompletionReceipt | undefined;
      if (receipt?.id && receipt.status === "prepared") {
        await resolveExpiredPasskeyCompletionReceipt(receipt);
        continue;
      }
    }
    expiredKeys.push(key);
    const candidateId = key.slice(key.lastIndexOf(".") + 1);
    pendingPasskeyRequests.delete(candidateId);
    passkeyCompletionReceipts.delete(candidateId);
  }
  if (expiredKeys.length) await chrome.storage.session.remove(expiredKeys);
}

function schedulePasskeyCompletionExpiry(candidateId: string, expiresAt: number): void {
  setTimeout(() => void (async () => {
    const receipt = await loadPasskeyCompletionReceipt(candidateId);
    if (receipt && receipt.expiresAt <= Date.now()) await deletePasskeyCompletionReceipt(candidateId);
  })(), Math.max(0, expiresAt - Date.now()) + 100);
}

function schedulePasskeyExpiry(candidateId: string, expiresAt: number): void {
  setTimeout(() => void (async () => {
    const cached = pendingPasskeyRequests.get(candidateId);
    const key = pendingPasskeyStorageKey(candidateId);
    const pending = cached || (await chrome.storage.session.get(key))[key] as PendingPasskeyRequest | undefined;
    if (pending && pending.expiresAt <= Date.now()) await cancelPendingPasskeyRequest(candidateId);
  })(), Math.max(0, expiresAt - Date.now()) + 100);
}

async function beginPasskeyRequest(request: PasskeyRequest, sender: chrome.runtime.MessageSender): Promise<PasskeyPromptContext> {
  request = validatePasskeyRequest(request);
  const source = assertWebPageSender(sender);
  if ((await service.status()) !== "unlocked") throw new VaultLockedError("密码库已锁定，请先解锁 Monica。");
  const rpId = validateRpId(source.origin, request.rpId);
  const state = await service.readState();
  const passkeys = state.items.filter((item): item is PasskeyItem => item.kind === "passkey" && !item.deletedAt && passkeyRpIdsEqual(item.rpId, rpId));
  const saveTargets = state.providers
    .filter((provider): provider is ProviderAccount & { kind: "local" | "bitwarden" | "mdbx2" } => provider.enabled && (provider.kind === "local" || provider.kind === "bitwarden" || provider.kind === "mdbx2"))
    .map((provider) => ({ providerId: provider.id, name: provider.name, kind: provider.kind }));
  const configuredTarget = saveTargets.find((provider) => provider.providerId === state.settings.defaultProviderId);
  const defaultSaveTarget = configuredTarget || saveTargets.find((provider) => provider.kind === "local") || saveTargets[0];
  let matches: PasskeyItem[] = [];
  if (request.operation === "create") {
    if (!request.rpName || !request.userName || !request.userId) throw new Error("Passkey 注册请求缺少用户或网站信息。");
    if (!request.algorithms.includes(-7)) throw new Error("当前仅支持 ES256 Passkey。");
    if (hasExcludedUsablePasskey(passkeys, rpId, request.excludeCredentialIds)) throw new PasskeyExcludedError("网站已排除此账户现有的 Passkey。");
  } else {
    matches = selectPasskeyCandidates(passkeys, rpId, request.allowCredentialIds);
    if (!matches.length) throw new PasskeyUnavailableError("Monica 中没有可用于此网站的 Passkey。");
  }
  const id = crypto.randomUUID(); const expiresAt = Date.now() + (request.timeoutMs || 120_000);
  const pending: PendingPasskeyRequest = { id, request, tabId: source.tabId, frameId: source.frameId, documentId: source.documentId, origin: source.origin, rpId, expiresAt, matches: matches.map((item) => item.id), saveTargets: request.operation === "create" ? saveTargets : [], defaultSaveTargetId: request.operation === "create" ? defaultSaveTarget?.providerId : undefined };
  await persistPendingPasskeyRequest(pending);
  schedulePasskeyExpiry(id, expiresAt);
  return {
    candidateId: id,
    operation: request.operation,
    rpId,
    rpName: request.operation === "create" ? request.rpName : matches[0]?.rpName || rpId,
    origin: source.origin,
    userName: request.operation === "create" ? request.userName : matches[0]?.userName || "",
    userDisplayName: request.operation === "create" ? request.userDisplayName : matches[0]?.userDisplayName,
    saveTargets: request.operation === "create" ? saveTargets.map((target) => ({ providerId: target.providerId, name: target.name, sourceMode: target.kind === "bitwarden" ? "bitwarden" : "browser-local" })) : [],
    defaultSaveTargetId: request.operation === "create" ? defaultSaveTarget?.providerId : undefined,
    credentials: matches.map((item) => ({ itemId: item.id, title: item.title, userName: item.userName, userDisplayName: item.userDisplayName, sourceMode: item.sourceMode === "bitwarden" ? "bitwarden" : "browser-local", useCount: item.useCount || 0, lastUsedAt: item.lastUsedAt })),
    expiresAt
  };
}

async function acceptPasskeyRequest(candidateId: string, itemId: string | undefined, providerId: string | undefined, sender: chrome.runtime.MessageSender): Promise<PasskeyResult> {
  const source = assertWebPageSender(sender);
  if (cancellingPasskeyRequests.has(candidateId)) throw new PasskeyCancelledError("Passkey 请求已取消。");
  if (processingPasskeyRequests.has(candidateId)) throw new Error("Passkey 请求正在处理中。");
  processingPasskeyRequests.add(candidateId);
  let pending: PendingPasskeyRequest | undefined;
  let preparedReceipt: PasskeyCompletionReceipt | undefined;
  let commitSucceeded = false;
  try {
    const existingReceipt = await loadPasskeyCompletionReceipt(candidateId);
    if (existingReceipt) {
      if (!passkeyReceiptMatchesSource(existingReceipt, source)) throw new Error("Passkey 请求已过期或来源不匹配。");
      const commitState = await passkeyReceiptCommitState(existingReceipt);
      if (commitState === "committed") {
        await promotePasskeyCompletionReceipt(existingReceipt);
        await deletePendingPasskeyRequest(candidateId).catch(() => undefined);
        return existingReceipt.result;
      }
      if (commitState === "unknown") throw new PasskeyCommitUnknownError("密码库已锁定，暂时无法确认 Passkey 是否已保存。");
      await deletePasskeyCompletionReceipt(candidateId);
    }

    pending = await loadPendingPasskeyRequest(candidateId);
    if (!pending || pending.expiresAt <= Date.now() || pending.tabId !== source.tabId || pending.frameId !== source.frameId || pending.documentId !== source.documentId || pending.origin !== source.origin) throw new Error("Passkey 请求已过期或来源不匹配。");
    const activePending = pending;
    if (cancelledPasskeyRequests.has(candidateId)) throw new PasskeyCancelledError("Passkey 请求已取消。");
    if ((await service.status()) !== "unlocked") throw new VaultLockedError("密码库已锁定。");
    if (cancelledPasskeyRequests.has(candidateId)) throw new PasskeyCancelledError("Passkey 请求已取消。");
    if (activePending.request.operation === "create") {
      const target = activePending.saveTargets.find((candidate) => candidate.providerId === (providerId || activePending.defaultSaveTargetId));
      if (!target) throw new Error("所选 Passkey 保存位置不可用。");
      const created = await createPasskey({ ...activePending.request, origin: activePending.origin, rpId: activePending.rpId, userVerified: false });
      if (cancelledPasskeyRequests.has(candidateId)) throw new PasskeyCancelledError("Passkey 请求已取消。");
      const liveState = await service.readState();
      const liveTarget = liveState.providers.find((candidate) => candidate.id === target.providerId && candidate.enabled && candidate.kind === target.kind);
      if (!liveTarget) throw new Error("所选 Passkey 保存位置已变化，请重新发起注册。");
      const currentPasskeys = liveState.items.filter((item): item is PasskeyItem => item.kind === "passkey" && !item.deletedAt && passkeyRpIdsEqual(item.rpId, activePending.rpId));
      if (hasExcludedUsablePasskey(currentPasskeys, activePending.rpId, activePending.request.excludeCredentialIds)) {
        await deletePendingPasskeyRequest(candidateId);
        throw new PasskeyExcludedError("网站已排除此账户现有的 Passkey。");
      }
      const now = new Date().toISOString();
      const bitwarden = target.kind === "bitwarden";
      const item: PasskeyItem = { id: candidateId, kind: "passkey", title: activePending.request.rpName || activePending.rpId, favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: target.kind === "local" ? [] : [{ providerId: target.providerId }], credentialId: created.credentialId, rpId: created.rpId, rpName: activePending.request.rpName, userHandle: activePending.request.userId, userName: activePending.request.userName, userDisplayName: activePending.request.userDisplayName, algorithm: -7, keyAlgorithm: "ECDSA", publicKey: created.publicKeySpki, privateKeyPkcs8: created.privateKeyPkcs8, signCount: 0, discoverable: activePending.request.discoverable === true, userVerificationRequired: false, transports: ["internal"], aaguid: "", lastUsedAt: now, useCount: 0, passkeyMode: "BW_COMPAT", sourceMode: bitwarden ? "bitwarden" : "browser-local" };
      const result: PasskeyResult = { operation: "create", id: created.credentialId, rawId: created.credentialId, response: created.response, clientExtensionResults: activePending.request.credProps ? { credProps: { rk: item.discoverable } } : {} };
      preparedReceipt = {
        id: candidateId,
        tabId: activePending.tabId,
        frameId: activePending.frameId,
        documentId: activePending.documentId,
        origin: activePending.origin,
        operation: "create",
        itemId: item.id,
        result,
        status: "prepared",
        expiresAt: Date.now() + PASSKEY_COMPLETION_TTL_MS
      };
      await persistPasskeyCompletionReceipt(preparedReceipt);
      if (cancelledPasskeyRequests.has(candidateId)) throw new PasskeyCancelledError("Passkey 请求已取消。");
      committingPasskeyRequests.add(candidateId);
      await service.upsertItem(item);
      commitSucceeded = true;
      await promotePasskeyCompletionReceipt(preparedReceipt);
      schedulePasskeyCompletionExpiry(candidateId, preparedReceipt.expiresAt);
      await deletePendingPasskeyRequest(candidateId).catch(() => undefined);
      return result;
    }
    const selectedId = itemId || activePending.matches[0];
    if (!activePending.matches.includes(selectedId)) throw new Error("所选 Passkey 不属于当前请求。");
    const item = await service.getItem(selectedId);
    if (!item || item.kind !== "passkey" || passkeyAvailability(item, activePending.rpId) !== "ready" || !item.privateKeyPkcs8) throw new Error("所选 Passkey 没有可用私钥或算法不受支持。");
    const assertion = await createAssertion({ origin: activePending.origin, challenge: activePending.request.challenge, rpId: activePending.rpId, credentialId: item.credentialId, userHandle: item.userHandle, privateKeyPkcs8: item.privateKeyPkcs8, signCount: item.signCount, userVerified: false });
    if (cancelledPasskeyRequests.has(candidateId)) throw new PasskeyCancelledError("Passkey 请求已取消。");
    const id = normalizeCredentialId(item.credentialId);
    const result: PasskeyResult = { operation: "get", id, rawId: id, response: assertion.response };
    preparedReceipt = {
      id: candidateId,
      tabId: activePending.tabId,
      frameId: activePending.frameId,
      documentId: activePending.documentId,
      origin: activePending.origin,
      operation: "get",
      itemId: item.id,
      result,
      status: "prepared",
      expiresAt: Date.now() + PASSKEY_COMPLETION_TTL_MS
    };
    await persistPasskeyCompletionReceipt(preparedReceipt);
    if (cancelledPasskeyRequests.has(candidateId)) throw new PasskeyCancelledError("Passkey 请求已取消。");
    committingPasskeyRequests.add(candidateId);
    await service.recordPasskeyUse(item.id, assertion.signCount, new Date().toISOString());
    commitSucceeded = true;
    await promotePasskeyCompletionReceipt(preparedReceipt);
    schedulePasskeyCompletionExpiry(candidateId, preparedReceipt.expiresAt);
    await deletePendingPasskeyRequest(candidateId).catch(() => undefined);
    return result;
  } finally {
    if (preparedReceipt && !commitSucceeded) await deletePasskeyCompletionReceipt(candidateId).catch(() => undefined);
    processingPasskeyRequests.delete(candidateId);
    committingPasskeyRequests.delete(candidateId);
    cancelledPasskeyRequests.delete(candidateId);
    if (pending?.expiresAt && pending.expiresAt <= Date.now()) await deletePendingPasskeyRequest(candidateId).catch(() => undefined);
  }
}

interface PasskeyDismissResult {
  cancelled: boolean;
  pending?: boolean;
  result?: PasskeyResult;
}

async function dismissPasskeyRequest(candidateId: string, sender: chrome.runtime.MessageSender): Promise<PasskeyDismissResult> {
  const source = assertWebPageSender(sender);
  if (committingPasskeyRequests.has(candidateId)) return { cancelled: false, pending: true };
  const receipt = await loadPasskeyCompletionReceipt(candidateId);
  if (receipt && !passkeyReceiptMatchesSource(receipt, source)) throw new Error("Passkey 请求来源不匹配。");
  if (receipt) {
    const commitState = await passkeyReceiptCommitState(receipt);
    if (commitState === "committed") {
      await promotePasskeyCompletionReceipt(receipt);
      return { cancelled: false, result: receipt.result };
    }
    if (commitState === "unknown") return { cancelled: false, pending: true };
  }
  const pending = await loadPendingPasskeyRequest(candidateId);
  if (pending && (pending.tabId !== source.tabId || pending.frameId !== source.frameId || pending.documentId !== source.documentId || pending.origin !== source.origin)) throw new Error("Passkey 请求来源不匹配。");
  if (!receipt && !pending && !processingPasskeyRequests.has(candidateId) && !committingPasskeyRequests.has(candidateId)) return { cancelled: true };
  const cancelled = await cancelPendingPasskeyRequest(candidateId);
  if (cancelled) return { cancelled: true };
  const completed = await loadPasskeyCompletionReceipt(candidateId);
  if (completed && passkeyReceiptMatchesSource(completed, source)) {
    const commitState = await passkeyReceiptCommitState(completed);
    if (commitState === "committed") {
      await promotePasskeyCompletionReceipt(completed);
      return { cancelled: false, result: completed.result };
    }
  }
  return { cancelled: false, pending: true };
}

interface SensitiveFillTarget {
  url: string;
  origin: string;
  documentId: string;
}

async function resolveSensitiveFillTarget(tabId: number, frameId = 0, documentId?: string, expectedOrigin?: string): Promise<SensitiveFillTarget> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error("已阻止向非活动标签页填充敏感信息。");
  const target = documentId
    ? await chrome.webNavigation.getFrame({ tabId, frameId, documentId })
    : ((await chrome.webNavigation.getAllFrames({ tabId })) || []).find((frame) => frame.frameId === frameId) || null;
  if (!target || target.documentLifecycle !== "active") throw new Error("页面已变化，请重新打开 Monica 后再填充。");
  const origin = new URL(target.url).origin;
  if (expectedOrigin && origin !== expectedOrigin) throw new Error("页面来源已变化，已阻止敏感信息填充。");
  if (!isSecureSensitivePageUrl(target.url)) throw new Error("已阻止向不安全的 HTTP 页面填充敏感信息。");
  return { url: target.url, origin, documentId: target.documentId };
}

async function fillLogin(itemId: string, tabId: number, frameId?: number, documentId?: string, expectedOrigin?: string) {
  const target = await resolveSensitiveFillTarget(tabId, frameId ?? 0, documentId, expectedOrigin);
  const item = await service.getItem(itemId);
  if (!item || !isLoginItem(item)) throw new Error("登录项不存在或已被删除。");
  if (loginMatchScore(item, target.url) <= 0) throw new Error("登录项与目标页面不匹配，已阻止填充。");
  const otp = await resolveLoginOtp(item, await service.listItems());
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: "MONICA_FILL_CREDENTIAL",
    expectedOrigin: target.origin,
    credential: { username: item.username, password: item.password, totpCode: otp?.code, customFields: item.customFields.map(({ name, value }) => ({ name, value })) }
  }, { documentId: target.documentId })) as { ok?: boolean; error?: string; filledUsername?: boolean; filledPassword?: boolean; filledTotp?: boolean; filledCustomFields?: number };
  if (!response?.ok) throw new Error(response?.error || "网页拒绝了填充请求。");
  if (response.filledTotp && otp?.updatedItem) await service.upsertItem(otp.updatedItem);
  return { filledUsername: Boolean(response.filledUsername), filledPassword: Boolean(response.filledPassword), filledTotp: Boolean(response.filledTotp), filledCustomFields: response.filledCustomFields || 0 };
}

type WalletItem = IdentityItem | BillingAddressItem | CardItem | PaymentAccountItem;

async function listWalletItems(requestedKinds: WalletFillKind[]): Promise<WalletMatchSummary[]> {
  const kinds = new Set(requestedKinds.filter(isWalletKind));
  return (await service.listItems()).filter(isWalletItem).filter((item) => kinds.has(item.kind)).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    subtitle: walletSubtitle(item),
    favorite: item.favorite,
    sensitive: item.kind !== "billing-address"
  })).sort((left, right) => Number(right.favorite) - Number(left.favorite) || left.title.localeCompare(right.title));
}

async function fillWalletItem(itemId: string, tabId: number, frameId?: number, documentId?: string, expectedOrigin?: string): Promise<WalletFillResult> {
  const target = await resolveSensitiveFillTarget(tabId, frameId ?? 0, documentId, expectedOrigin);
  const item = await service.getItem(itemId);
  if (!item || !isWalletItem(item)) throw new Error("证件或支付项目不存在或已被删除。");
  const response = await chrome.tabs.sendMessage(tabId, { type: "MONICA_FILL_WALLET", expectedOrigin: target.origin, wallet: walletPayload(item) }, { documentId: target.documentId }) as { ok?: boolean; error?: string; filledCount?: number; filledFields?: WalletFillResult["filledFields"] };
  if (!response?.ok) throw new Error(response?.error || "网页拒绝了证件或支付信息填充。");
  return { filledCount: Number(response.filledCount) || 0, filledFields: response.filledFields || [] };
}

function walletPayload(item: WalletItem): WalletFillPayload {
  if (item.kind === "identity") return { kind: item.kind, fields: {
    fullName: item.fullName, firstName: item.firstName, middleName: item.middleName, lastName: item.lastName,
    birthDate: item.birthDate, nationality: item.nationality, documentNumber: item.documentNumber, documentType: item.documentType,
    documentIssuedDate: item.issuedDate, documentExpiryDate: item.expiryDate, documentIssuedBy: item.issuedBy,
    passportNumber: item.passportNumber || (item.documentType === "PASSPORT" ? item.documentNumber : undefined),
    licenseNumber: item.licenseNumber || (item.documentType === "DRIVER_LICENSE" ? item.documentNumber : undefined),
    ssn: item.ssn || (item.documentType === "SOCIAL_SECURITY" ? item.documentNumber : undefined), email: item.email, phone: item.phone,
    streetAddress: item.address?.streetAddress, apartment: item.address?.apartment, city: item.address?.city,
    stateProvince: item.address?.stateProvince, postalCode: item.address?.postalCode, country: item.address?.country
  } };
  if (item.kind === "billing-address") return { kind: item.kind, fields: {
    fullName: item.fullName, company: item.company, streetAddress: item.streetAddress, apartment: item.apartment, city: item.city,
    stateProvince: item.stateProvince, postalCode: item.postalCode, country: item.country, phone: item.phone, email: item.email
  } };
  if (item.kind === "card") return { kind: item.kind, fields: {
    cardholderName: item.cardholderName, cardNumber: item.number, cardExpiryMonth: item.expiryMonth, cardExpiryYear: item.expiryYear,
    cardExpiry: [item.expiryMonth, item.expiryYear.length === 4 ? item.expiryYear.slice(-2) : item.expiryYear].filter(Boolean).join("/"),
    cardSecurityCode: item.securityCode, cardBrand: item.brand, cardPin: item.pin, paymentProvider: item.bankName,
    paymentAccountNumber: item.accountNumber, routingNumber: item.routingNumber, iban: item.iban,
    swiftBic: item.swiftBic, branchCode: item.branchCode, currency: item.currency
  } };
  return { kind: item.kind, fields: {
    paymentProvider: item.provider, paymentAccountName: item.accountName, paymentAccountHolder: item.accountHolderName,
    email: item.email, phone: item.phone, paymentUsername: item.username, paymentAccountId: item.accountId,
    paymentAccountNumber: unmaskedAccountNumber(item.maskedAccountNumber), routingNumber: item.routingNumber, iban: item.iban,
    swiftBic: item.swiftBic, currency: item.currency
  } };
}

function isWalletItem(item: VaultItem): item is WalletItem {
  return !item.deletedAt && !item.archivedAt && isWalletKind(item.kind);
}

function isWalletKind(kind: string): kind is WalletFillKind {
  return kind === "identity" || kind === "billing-address" || kind === "card" || kind === "payment-account";
}

function walletSubtitle(item: WalletItem): string {
  if (item.kind === "card") return `${item.brand || "银行卡"}${lastFour(item.number)}`;
  if (item.kind === "identity") return `${documentLabel(item.documentType)}${lastFour(item.documentNumber)}`;
  if (item.kind === "billing-address") return [item.city, item.country].filter(Boolean).join(" · ") || "地址";
  return [item.provider, item.accountName || item.accountHolderName].filter(Boolean).join(" · ") || item.paymentType || "支付账户";
}

function lastFour(value: string): string {
  const suffix = value.replace(/\s+/g, "").slice(-4);
  return suffix ? ` · •••• ${suffix}` : "";
}

function documentLabel(type: IdentityItem["documentType"]): string {
  return ({ ID_CARD: "身份证", PASSPORT: "护照", DRIVER_LICENSE: "驾驶证", SOCIAL_SECURITY: "社会保障号", OTHER: "证件" } as const)[type];
}

function unmaskedAccountNumber(value: string): string | undefined {
  const normalized = value.trim();
  return normalized && !/[x*•]/i.test(normalized) ? normalized : undefined;
}

function effectiveMdbx2WebDavSettings(
  config: Mdbx2WebDavSettingsInput,
  previous: Record<string, unknown> = {}
): Mdbx2WebDavSyncConfig {
  return {
    baseUrl: normalizeServerUrl(config.baseUrl),
    username: config.username.trim(),
    password: config.password || (typeof previous.webDavPassword === "string" ? previous.webDavPassword : ""),
    remotePath: normalizeMdbx2RemotePath(config.remotePath),
    syncStateHandle: typeof previous.syncStateHandle === "string" ? previous.syncStateHandle : undefined
  };
}

async function requireMdbx2Account(providerId: string): Promise<ProviderAccount> {
  const account = await service.getProvider(providerId);
  if (!account || account.kind !== "mdbx2") throw new Error("MDBX2 密码源不存在。");
  return account;
}

function mdbx2WebDavSyncConfig(account: ProviderAccount): Mdbx2WebDavSyncConfig {
  const baseUrl = stringAccountConfig(account, "webDavBaseUrl");
  const remotePath = stringAccountConfig(account, "remotePath");
  if (!baseUrl) throw new Error("MDBX2 WebDAV 地址未配置。");
  if (!remotePath) throw new Error("MDBX2 WebDAV 远端文件位置未配置。");
  return {
    baseUrl,
    username: stringAccountConfig(account, "webDavUsername"),
    password: stringAccountConfig(account, "webDavPassword"),
    remotePath,
    syncStateHandle: stringAccountConfig(account, "syncStateHandle") || undefined
  };
}

function mdbx2CloudSyncInput(account: ProviderAccount, requireState: true): Mdbx2CloudSyncInput;
function mdbx2CloudSyncInput(account: ProviderAccount, requireState: false): Omit<Mdbx2CloudSyncInput, "syncStateHandle"> & { syncStateHandle?: string };
function mdbx2CloudSyncInput(account: ProviderAccount, requireState: boolean): Mdbx2CloudSyncInput | (Omit<Mdbx2CloudSyncInput, "syncStateHandle"> & { syncStateHandle?: string }) {
  const config = mdbx2WebDavSyncConfig(account);
  const vaultHandle = stringAccountConfig(account, "vaultHandle");
  if (!vaultHandle) throw new Error("MDBX2 密码源缺少本机工作副本。");
  if (requireState && !config.syncStateHandle) throw new Error("MDBX2 WebDAV 尚未完成 bootstrap 注册。");
  return { ...config, vaultHandle, syncStateHandle: config.syncStateHandle };
}

function managerSyncStatus(status: Mdbx2SyncStateStatus | undefined, configured: boolean, registered: boolean): Mdbx2ManagerSyncStatus {
  return {
    configured,
    registered,
    initialized: status?.initialized || false,
    hasLocalChanges: status?.hasLocalChanges || false,
    pendingBootstrap: status?.pendingBootstrap || false,
    pendingSegment: status?.pendingSegment || false,
    pendingRemoteAcknowledgement: status?.pendingRemoteAcknowledgement || false,
    remoteStreamCount: status?.remoteStreamCount || 0,
    blockedStreamCount: status?.blockedStreamCount || 0,
    blobTransferCount: status?.blobTransferCount || 0,
    verifiedRemoteBlobCount: status?.verifiedRemoteBlobCount || 0
  };
}

function stringAccountConfig(account: ProviderAccount, key: string): string {
  return typeof account.config[key] === "string" ? account.config[key] as string : "";
}

function providerAttachmentTransferBackend(sender: chrome.runtime.MessageSender): ProviderAttachmentTransferBackend {
  return {
    beginRead: async (providerId, itemId, attachmentId) => await handleRequest({ type: "PROVIDER_ATTACHMENT_READ_BEGIN", providerId, itemId, attachmentId }, sender) as ProviderAttachmentReadBeginResult,
    readChunk: async (providerId, readHandle, offset, maxBytes) => await handleRequest({ type: "PROVIDER_ATTACHMENT_READ_CHUNK", providerId, readHandle, offset, maxBytes }, sender) as ProviderAttachmentReadChunk,
    releaseRead: async (providerId, readHandle) => await handleRequest({ type: "PROVIDER_ATTACHMENT_READ_RELEASE", providerId, readHandle }, sender) as boolean,
    beginUpload: async (providerId, itemId, input) => await handleRequest({ type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN", providerId, itemId, ...input }, sender) as ProviderAttachmentUploadBeginResult,
    uploadChunk: async (providerId, transferId, offset, bytes) => await handleRequest({ type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK", providerId, transferId, offset, dataBase64: bytesToBase64(bytes) }, sender) as ProviderAttachmentUploadChunkResult,
    finishUpload: async (providerId, itemId, transferId, operationId) => await handleRequest({ type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH", providerId, itemId, transferId, operationId }, sender) as ProviderAttachmentMutationResult,
    abortUpload: async (providerId, transferId) => await handleRequest({ type: "PROVIDER_ATTACHMENT_UPLOAD_ABORT", providerId, transferId }, sender) as boolean,
    deleteAttachment: async (providerId, itemId, attachmentId, operationId) => await handleRequest({ type: "PROVIDER_ATTACHMENT_DELETE", providerId, itemId, attachmentId, operationId, confirmed: true }, sender) as ProviderAttachmentMutationResult
  };
}

async function requireAttachmentTarget(providerId: string, itemId: string): Promise<{ account: ProviderAccount; item: VaultItem }> {
  const [account, item] = await Promise.all([service.getProvider(providerId), service.getItem(itemId)]);
  if (!account) throw new ProviderAttachmentError("attachment-provider-not-found", "附件密码源不存在。");
  if (account.kind === "keepass") await ensureKeePassSession(account, true);
  if (!item || !item.providerRefs.some((reference) => reference.providerId === providerId)) {
    throw new ProviderAttachmentError("attachment-target-not-found", "附件项目不存在或不属于所选密码源。");
  }
  return { account, item };
}

function requireMdbx2AttachmentTarget(account: ProviderAccount, item: VaultItem): { vaultHandle: string; collectionId: string; objectId: string } {
  const vaultHandle = account.kind === "mdbx2" ? stringAccountConfig(account, "vaultHandle") : "";
  const reference = item.providerRefs.find((candidate) => candidate.providerId === account.id);
  const collectionId = reference?.remoteFolderId || item.mdbxFolderId || "";
  const objectId = reference?.remoteId || "";
  if (!vaultHandle) throw new ProviderAttachmentError("attachment-vault-locked", "MDBX2 本机工作副本尚未解锁。");
  if (!collectionId || !objectId) throw new ProviderAttachmentError("attachment-target-not-synced", "该项目尚未写入 MDBX2，完成项目同步后才能管理附件。");
  return { vaultHandle, collectionId, objectId };
}

function providerAttachmentSummaryFromMdbx2(input: { attachmentId: string; fileName: string; sizeBytes: number; mediaType?: string }) {
  return {
    attachmentId: input.attachmentId,
    providerKind: "mdbx2" as const,
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    protected: true,
    mediaType: input.mediaType
  };
}

interface BitwardenAttachmentContext {
  providerId: string;
  itemId: string;
  session: BitwardenSessionConfig;
  rawCipher: Record<string, unknown>;
  organizationKeys: Map<string, BitwardenSymmetricKey>;
}

async function requireBitwardenAccountRecord(providerId: string): Promise<ProviderAccount> {
  const account = await service.getProvider(providerId);
  if (!account || account.kind !== "bitwarden") throw new BitwardenFolderError("folder-provider-not-found", "Bitwarden 密码源不存在。");
  return account;
}

/**
 * A folder-only mutation changes encrypted routing metadata, not the decrypted item body. Apply
 * the authoritative Cipher projection to every local sibling (including Passkey children) while
 * keeping raw encrypted fields in the source envelope. No raw Cipher is returned to runtime pages.
 */
async function acknowledgeBitwardenCipherProjection(
  account: ProviderAccount,
  session: BitwardenSessionConfig,
  rawCiphers: Record<string, unknown>[],
  requiredItemId?: string
): Promise<void> {
  if (account.kind !== "bitwarden") throw new BitwardenFolderError("folder-provider-not-found", "Bitwarden 密码源不存在。");
  const state = await service.readState();
  const scoped = state.items.filter((item) => item.providerRefs.some((reference) => reference.providerId === account.id));
  const hasBaseline = scoped.some((item) => Boolean(item.providerRefs.find((reference) => reference.providerId === account.id)?.revision));
  if (!rawCiphers.length && hasBaseline) throw new BitwardenFolderError("sync-empty-protected", "Bitwarden 返回空密码库，未更新本地文件夹路由。");
  const rawByCipherId = new Map<string, Record<string, unknown>>();
  for (const raw of rawCiphers) {
    const cipherId = bitwardenStringValue(raw, "Id", "id");
    const revision = bitwardenStringValue(raw, "RevisionDate", "revisionDate");
    if (!cipherId || !revision || !Number.isFinite(Date.parse(revision))) {
      throw new BitwardenFolderError("cipher-projection-invalid", "Bitwarden 返回了无法验证的 Cipher 修订信息，未更新本地状态。");
    }
    rawByCipherId.set(cipherId, raw);
  }
  let requiredFound = requiredItemId === undefined;
  const patchedItems = state.items.map((candidate) => {
    const reference = candidate.providerRefs.find((entry) => entry.providerId === account.id);
    if (!reference) return candidate;
    const cipherId = reference.remoteId?.split("#fido2:")[0] || "";
    const raw = rawByCipherId.get(cipherId);
    if (!raw) return candidate;
    if (candidate.id === requiredItemId) requiredFound = true;
    const revision = bitwardenStringValue(raw, "RevisionDate", "revisionDate");
    const folderId = bitwardenStringValue(raw, "FolderId", "folderId");
    return {
      ...candidate,
      updatedAt: revision,
      providerRefs: [...candidate.providerRefs.filter((entry) => entry.providerId !== account.id), {
        ...reference,
        revision,
        remoteFolderId: folderId || undefined
      }]
    } as VaultItem;
  });
  if (!requiredFound) throw new BitwardenFolderError("cipher-target-not-found", "移动完成后找不到本地项目，已停止更新本地状态。");
  const newRecords = await Promise.all([...rawByCipherId.entries()].map(async ([cipherId, raw]) => createSourceRecord({
    providerId: account.id,
    remoteId: cipherId,
    revision: bitwardenStringValue(raw, "RevisionDate", "revisionDate"),
    format: "bitwarden-cipher",
    encoding: "json",
    payload: JSON.stringify(raw)
  })));
  const sourceRecords = [
    ...state.sourceRecords.filter((record) => !(record.providerId === account.id && rawByCipherId.has(record.remoteId))),
    ...newRecords
  ];
  await service.applyProviderSync(
    account.id,
    patchedItems,
    { config: { ...account.config, ...session }, lastSyncAt: new Date().toISOString(), lastError: undefined },
    [],
    sourceRecords,
    state.items
  );
  account.config = { ...account.config, ...session };
}

function publicBitwardenFolderMutationResult(result: BitwardenFolderMutationResult): BitwardenFolderMutationResult {
  const { rawCipher: _rawCipher, ...publicResult } = result;
  return publicResult;
}

async function loadBitwardenAttachmentContext(account: ProviderAccount, item: VaultItem): Promise<BitwardenAttachmentContext> {
  if (account.kind !== "bitwarden") throw unsupportedAttachmentProvider(account.kind);
  const session = readBitwardenSession(account);
  const cipherId = bitwardenCipherIdForItem(account.id, item);
  const synced = await bitwardenClient.sync(session);
  const ciphers = bitwardenRecordArray(synced.payload, "Ciphers", "ciphers");
  const rawCipher = ciphers.find((candidate) => bitwardenStringValue(candidate, "Id", "id") === cipherId);
  if (!rawCipher) throw new ProviderAttachmentError("attachment-target-not-found", "Bitwarden 项目不存在或已被删除，请先同步密码源。");

  const vaultKey = bitwardenClient.vaultKey(synced.session);
  try {
    const organizations = await resolveBitwardenOrganizationKeys(synced.payload, vaultKey);
    return {
      providerId: account.id,
      itemId: item.id,
      session: synced.session,
      rawCipher,
      organizationKeys: organizations.keys
    };
  } finally {
    clearBitwardenSymmetricKey(vaultKey);
  }
}

function readBitwardenSession(account: ProviderAccount): BitwardenSessionConfig {
  const config = account.config as Partial<BitwardenSessionConfig>;
  const required = [config.vaultUrl, config.apiUrl, config.identityUrl, config.email, config.deviceId, config.accessToken, config.vaultKeyEnc, config.vaultKeyMac];
  if (required.some((value) => typeof value !== "string" || !value) || !config.kdf || typeof config.expiresAt !== "number") {
    throw new ProviderAttachmentError("attachment-provider-not-authenticated", "Bitwarden 密码源尚未完成登录，请重新登录。");
  }
  return config as BitwardenSessionConfig;
}

function bitwardenCipherIdForItem(providerId: string, item: VaultItem): string {
  const reference = item.providerRefs.find((candidate) => candidate.providerId === providerId);
  const remoteId = reference?.remoteId?.split("#fido2:")[0] || "";
  if (!remoteId) throw new ProviderAttachmentError("attachment-target-not-synced", "该项目尚未写入 Bitwarden，完成项目同步后才能管理附件。");
  return remoteId;
}

async function persistBitwardenSession(account: ProviderAccount, session: BitwardenSessionConfig): Promise<void> {
  if (account.kind !== "bitwarden") return;
  const config = { ...account.config, ...session };
  if (sameBitwardenConfig(account.config, config)) return;
  await service.upsertProvider({ ...account, config, lastError: undefined });
  account.config = config;
}

async function acknowledgeBitwardenAttachmentMutation(
  account: ProviderAccount,
  item: VaultItem,
  session: BitwardenSessionConfig,
  rawCipher: Record<string, unknown>
): Promise<void> {
  if (account.kind !== "bitwarden") throw unsupportedAttachmentProvider(account.kind);
  const cipherId = bitwardenStringValue(rawCipher, "Id", "id");
  const revision = bitwardenStringValue(rawCipher, "RevisionDate", "revisionDate");
  if (!cipherId || !revision || !Number.isFinite(Date.parse(revision))) {
    throw new ProviderAttachmentError("bitwarden-cipher-revision-invalid", "Bitwarden 附件操作返回了无效的 Cipher 修订时间。");
  }
  const state = await service.readState();
  const folderValue = bitwardenStringValue(rawCipher, "FolderId", "folderId");
  let matchedTarget = false;
  const patchedItems = state.items.map((candidate) => {
    const reference = candidate.providerRefs.find((entry) => entry.providerId === account.id);
    if (!reference || reference.remoteId?.split("#fido2:")[0] !== cipherId) return candidate;
    if (candidate.id === item.id) matchedTarget = true;
    const updatedReference = {
      ...reference,
      revision,
      remoteFolderId: folderValue || undefined
    };
    return {
      ...candidate,
      updatedAt: revision,
      providerRefs: [...candidate.providerRefs.filter((entry) => entry.providerId !== account.id), updatedReference]
    } as VaultItem;
  });
  if (!matchedTarget) {
    throw new ProviderAttachmentError("attachment-target-not-found", "Bitwarden 附件操作完成后找不到原项目，已停止更新本地状态。");
  }
  const sourceRecord = await createSourceRecord({
    providerId: account.id,
    remoteId: cipherId,
    revision,
    format: "bitwarden-cipher",
    encoding: "json",
    payload: JSON.stringify(rawCipher)
  });
  const sourceRecords = [
    ...state.sourceRecords.filter((record) => !(record.providerId === account.id && record.remoteId === cipherId)),
    sourceRecord
  ];
  await service.applyProviderSync(
    account.id,
    patchedItems,
    { config: { ...account.config, ...session }, lastSyncAt: new Date().toISOString(), lastError: undefined },
    [],
    sourceRecords,
    state.items
  );
  account.config = { ...account.config, ...session };
}

function clearBitwardenAttachmentSessions(providerId?: string): void {
  bitwardenAttachmentDownloads.clear();
  for (const [readHandle, route] of bitwardenAttachmentReadRoutes) {
    if (providerId === undefined || route.providerId === providerId) bitwardenAttachmentReadRoutes.delete(readHandle);
  }
}

function clearBitwardenOrganizationKeys(keys: Map<string, BitwardenSymmetricKey>): void {
  for (const key of keys.values()) clearBitwardenSymmetricKey(key);
  keys.clear();
}

function clearBitwardenSymmetricKey(key: BitwardenSymmetricKey): void {
  key.encKey.fill(0);
  key.macKey.fill(0);
}

function sameBitwardenConfig(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const normalize = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)));
  return normalize(left) === normalize(right);
}

function bitwardenRecordArray(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown>[] {
  const value = names.map((name) => raw[name]).find((candidate) => candidate !== undefined);
  if (!Array.isArray(value)) throw new ProviderAttachmentError("bitwarden-sync-response-invalid", "Bitwarden 同步响应缺少 Cipher 列表。");
  return value.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate));
}

function bitwardenStringValue(raw: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) if (typeof raw[name] === "string") return raw[name] as string;
  return "";
}

function pruneProviderAttachmentReads(): void {
  const now = Date.now();
  for (const [readHandle, route] of providerAttachmentReads) {
    if (route.expiresAt <= now) providerAttachmentReads.delete(readHandle);
  }
  for (const [readHandle, route] of bitwardenAttachmentReadRoutes) {
    if (route.expiresAt <= now) {
      bitwardenAttachmentReadRoutes.delete(readHandle);
      bitwardenAttachmentDownloads.release(route.providerId, readHandle);
    }
  }
}

function unsupportedAttachmentProvider(kind: ProviderAccount["kind"]): ProviderAttachmentError {
  return new ProviderAttachmentError("attachment-provider-unsupported", `${kind} 附件操作尚未接入此共享传输接口。`);
}

async function requireKeePassAccount(providerId: string): Promise<ProviderAccount> {
  const account = await requireKeePassAccountRecord(providerId);
  await ensureKeePassSession(account, true);
  return account;
}

async function executeKeePassDurableMutation<T>(input: {
  account: ProviderAccount;
  operationId: string;
  kind: KeePassDurableMutationKind;
  intent: unknown;
  replay: (result: KeePassDurableMutationResult) => T | Promise<T>;
  mutate: () => { result: T; durableResult: KeePassDurableMutationResult } | Promise<{ result: T; durableResult: KeePassDurableMutationResult }>;
}): Promise<T> {
  if (input.account.kind !== "keepass" || input.account.config.sourceMode !== "webdav") {
    return (await input.mutate()).result;
  }
  return runKeePassMutationExclusive(input.account.id, async () => {
    const account = await reconcileKeePassRemoteAccount(input.account);
    const intentSha256 = await keePassMutationIntentSha256(input.intent);
    const durable = await keePassRemoteSessions.readDurableReceipt(account, input.operationId, input.kind, intentSha256);
    if (durable) return input.replay(durable.result);

    const key = `${account.id}\u0000${input.operationId}`;
    let pending = keePassPendingPersistence.get(key);
    if (pending && (pending.providerId !== account.id || pending.kind !== input.kind || pending.intentSha256 !== intentSha256)) {
      throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 操作标识已经用于其他持久操作。");
    }
    if (!pending) {
      const mutation = await input.mutate();
      if (keePassPendingPersistence.size >= 256) keePassPendingPersistence.delete(keePassPendingPersistence.keys().next().value!);
      pending = {
        providerId: account.id,
        kind: input.kind,
        intentSha256,
        completedAt: new Date().toISOString(),
        result: structuredClone(mutation.result),
        durableResult: structuredClone(mutation.durableResult)
      };
      keePassPendingPersistence.set(key, pending);
    }

    const receipt: KeePassDurableMutationReceipt = {
      providerId: account.id,
      operationId: input.operationId,
      kind: input.kind,
      intentSha256,
      completedAt: pending.completedAt,
      result: pending.durableResult
    };
    const persisted = await keePassRemoteSessions.persistWorkingCopy(account, receipt);
    if (persisted) await applyKeePassRemoteAccountConfig(account, persisted.accountConfig);
    keePassPendingPersistence.delete(key);
    return structuredClone(pending.result) as T;
  });
}

async function runKeePassMutationExclusive<T>(providerId: string, task: () => Promise<T>): Promise<T> {
  const previous = keePassMutationQueues.get(providerId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  keePassMutationQueues.set(providerId, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (keePassMutationQueues.get(providerId) === queued) keePassMutationQueues.delete(providerId);
  }
}

function clearKeePassPendingPersistence(providerId?: string): void {
  if (!providerId) {
    keePassPendingPersistence.clear();
    keePassMutationQueues.clear();
    return;
  }
  for (const [key, pending] of keePassPendingPersistence) if (pending.providerId === providerId) keePassPendingPersistence.delete(key);
  keePassMutationQueues.delete(providerId);
}

function durableKeePassGroupResult(account: ProviderAccount, result: KeePassGroupMutationResult): KeePassDurableMutationResult {
  return {
    type: "group",
    changed: result.changed,
    groupUuid: keePassProvider.groupUuidForHandle(account.id, result.group.groupId)
  };
}

function replayKeePassGroupResult(account: ProviderAccount, result: KeePassDurableMutationResult): KeePassGroupMutationResult {
  if (result.type !== "group") throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 持久分组回执类型无效。");
  return keePassProvider.groupResultFromUuid(account, result.groupUuid, result.changed);
}

function durableKeePassHistoryResult(result: KeePassHistoryRestoreResult): KeePassDurableMutationResult {
  return { type: "history", changed: result.changed, historyCount: result.historyCount, modifiedAt: result.modifiedAt };
}

function replayKeePassHistoryResult(result: KeePassDurableMutationResult): KeePassHistoryRestoreResult {
  if (result.type !== "history" || result.changed !== true) {
    throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 持久历史回执类型无效。");
  }
  return { changed: true, historyCount: result.historyCount, modifiedAt: result.modifiedAt };
}

function durableKeePassAttachmentResult(account: ProviderAccount, item: VaultItem, result: ProviderAttachmentMutationResult): KeePassDurableMutationResult {
  if (!result.attachment) throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 附件操作缺少持久结果。");
  return {
    type: "attachment",
    changed: result.changed,
    entryUuid: keePassProvider.attachmentEntryUuid(account, item),
    fileName: result.attachment.fileName
  };
}

function replayKeePassAttachmentResult(account: ProviderAccount, item: VaultItem, result: KeePassDurableMutationResult): ProviderAttachmentMutationResult {
  if (result.type !== "attachment") throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 持久附件回执类型无效。");
  return keePassProvider.attachmentResultFromName(account, item, result.fileName, result.changed);
}

async function synchronizeKeePassProvider(account: ProviderAccount, signal: AbortSignal): Promise<ProviderSyncResult> {
  return runKeePassMutationExclusive(account.id, async () => {
    if (account.config.sourceMode === "webdav") {
      return keePassDurableSync.synchronize(await reconcileKeePassRemoteAccount(account), signal);
    }
    signal.throwIfAborted();
    const snapshot = (await service.readState()).items;
    const result = await keePassProvider.sync(account, {
      signal,
      now: new Date().toISOString(),
      localItems: structuredClone(snapshot)
    });
    await service.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, snapshot);
    return result;
  });
}

async function requireKeePassAccountRecord(providerId: string): Promise<ProviderAccount> {
  const account = await service.getProvider(providerId);
  if (!account || account.kind !== "keepass") {
    throw new KeePassGroupError("keepass-group-provider-not-found", "KeePass 密码源不存在。");
  }
  return account;
}

async function ensureKeePassSession(account: ProviderAccount, required: true): Promise<KeePassSessionSummary>;
async function ensureKeePassSession(account: ProviderAccount, required: false): Promise<KeePassSessionSummary | undefined>;
async function ensureKeePassSession(account: ProviderAccount, required: boolean): Promise<KeePassSessionSummary | undefined> {
  if (keePassProvider.isUnlocked(account.id)) {
    if (account.config.sourceMode === "webdav") await reconcileKeePassRemoteAccount(account);
    return keePassProvider.summarize(account.id);
  }
  if (account.config.sourceMode === "webdav") {
    const restored = await keePassRemoteSessions.restore(account);
    await applyKeePassRemoteAccountConfig(account, restored.accountConfig);
    return restored.session;
  }
  if (required) throw new KeePassRemoteSessionError("remote-working-copy-missing", "此 KeePass 本地文件会话尚未解锁，请重新选择 .kdbx 文件。");
  return undefined;
}

async function reconcileKeePassRemoteAccount(account: ProviderAccount): Promise<ProviderAccount> {
  if (account.kind !== "keepass" || account.config.sourceMode !== "webdav") return account;
  return applyKeePassRemoteAccountConfig(account, await keePassRemoteSessions.reconcileAccountConfig(account));
}

async function applyKeePassRemoteAccountConfig(account: ProviderAccount, config: Record<string, unknown>): Promise<ProviderAccount> {
  if (sameKeePassAccountConfig(account.config, config)) return account;
  const updated = { ...account, config };
  await service.upsertProvider(updated);
  account.config = config;
  return updated;
}

function sameKeePassAccountConfig(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const normalize = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)));
  return normalize(left) === normalize(right);
}

async function persistKeePassRemoteFailure(providerId: string, failure?: KeePassRemoteFailureInfo, message?: string): Promise<void> {
  const latest = await service.getProvider(providerId);
  if (!latest || latest.kind !== "keepass" || latest.config.sourceMode !== "webdav") return;
  const config = { ...latest.config };
  delete config.remoteLastErrorCode;
  delete config.remoteLastErrorRetryable;
  delete config.remoteLastErrorAt;
  if (failure) {
    config.remoteLastErrorCode = failure.code;
    config.remoteLastErrorRetryable = failure.retryable;
    config.remoteLastErrorAt = new Date().toISOString();
  }
  await service.upsertProvider({ ...latest, config, lastError: message });
}

async function requireKeePassHistoryTarget(providerId: string, itemId: string): Promise<{ account: ProviderAccount; item: VaultItem }> {
  const [account, item] = await Promise.all([requireKeePassAccount(providerId), service.getItem(itemId)]);
  if (!item || !item.providerRefs.some((reference) => reference.providerId === providerId)) {
    throw new KeePassHistoryError("keepass-history-target-not-found", "KeePass 历史项目不存在或不属于所选密码源。");
  }
  return { account, item };
}

async function requireMdbx2VaultHandle(providerId: string): Promise<string> {
  const account = await service.getProvider(providerId);
  const vaultHandle = account?.kind === "mdbx2" && typeof account.config.vaultHandle === "string"
    ? account.config.vaultHandle
    : "";
  if (!vaultHandle) throw new Error("MDBX2 密码源不存在或缺少本机工作副本。");
  return vaultHandle;
}

function recordMdbx2BatchTransferProgress(progress: Mdbx2BatchTransferProgress): void {
  mdbx2BatchTransferStatuses.set(progress.operationId, {
    ...progress,
    finished: progress.phase === "completed" || progress.phase === "failed",
    updatedAt: new Date().toISOString()
  });
  pruneMdbx2BatchTransferStatuses();
}

function pruneMdbx2BatchTransferStatuses(now = Date.now()): void {
  for (const [operationId, status] of mdbx2BatchTransferStatuses) {
    const updatedAt = Date.parse(status.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt > MDBX2_BATCH_TRANSFER_STATUS_TTL_MS) {
      mdbx2BatchTransferStatuses.delete(operationId);
    }
  }
}

function assertManagerPage(sender: chrome.runtime.MessageSender): void {
  const managerPageUrl = chrome.runtime.getURL("index.html");
  const extensionRoot = managerPageUrl.slice(0, -"/index.html".length);
  assertTrustedManagerPage(sender, chrome.runtime.id, `${extensionRoot}/`);
}

function assertExtensionPage(sender: chrome.runtime.MessageSender): void {
  assertTrustedExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""));
}

function toMatchSummary(item: LoginItem): LoginMatchSummary {
  return { id: item.id, title: item.title, username: item.username, favorite: item.favorite, uris: item.uris, hasTotp: Boolean(item.totpSecret) };
}

async function readLegacyItems(): Promise<VaultItem[]> {
  const result = await chrome.storage.local.get(LEGACY_VAULT_KEY);
  const records = result[LEGACY_VAULT_KEY];
  if (!Array.isArray(records)) return [];
  return records.flatMap((record): LoginItem[] => {
    if (!record || typeof record !== "object") return [];
    const value = record as Record<string, unknown>;
    const password = typeof value.password === "string" ? value.password : "";
    const urls = Array.isArray(value.urls) ? value.urls.map(String) : [];
    if (!password || !urls.length) return [];
    return [
      createLoginItem({
        title: typeof value.name === "string" ? value.name : "已迁移登录项",
        username: typeof value.username === "string" ? value.username : "",
        password,
        uris: urls,
        notes: typeof value.notes === "string" ? value.notes : "",
        favorite: Boolean(value.favorite)
      })
    ];
  });
}
