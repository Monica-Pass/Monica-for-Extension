import type { ProviderAccount, ProviderConflict, ProviderConflictResolution, ProviderDiagnosticExport } from "../core/model";
import type { MonicaWebDavConfig } from "../providers/webdav/monica-webdav-provider";
import type { EncryptedVaultBackup } from "../security/secure-vault-service";
import type { BitwardenConnectResult, ExtensionRequest, ExtensionResponse, LoginMatchSummary, SteamAuthorizedDevice, SteamConfirmation, SteamInventoryOverview, SteamInventoryPage, SteamMarketListingsPage, SteamMarketQuote, SteamMarketSellBatchResult, SteamMarketSellEntry, SteamPendingLogin, VaultItem, VaultStatusResponse, WalletFillKind, WalletFillResult, WalletMatchSummary } from "./messages";

async function send<T>(request: ExtensionRequest): Promise<T> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) throw new Error("请在已安装的 Monica 浏览器插件中打开此页面。");
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse<T>;
  if (!response?.ok) throw new Error(response?.error || "插件后台没有返回有效响应。");
  return response.data;
}

export const vaultClient = {
  status: () => send<VaultStatusResponse>({ type: "VAULT_STATUS" }),
  setup: (masterPassword: string) => send<VaultItem[]>({ type: "VAULT_SETUP", masterPassword }),
  unlock: (masterPassword: string) => send<VaultItem[]>({ type: "VAULT_UNLOCK", masterPassword }),
  lock: () => send<void>({ type: "VAULT_LOCK" }),
  changeMasterPassword: (currentPassword: string, newPassword: string) => send<void>({ type: "VAULT_CHANGE_MASTER_PASSWORD", currentPassword, newPassword }),
  exportEncryptedBackup: () => send<EncryptedVaultBackup>({ type: "VAULT_EXPORT_ENCRYPTED" }),
  restoreEncryptedBackup: (backup: EncryptedVaultBackup, backupPassword: string, replaceExisting = false, currentPassword?: string) =>
    send<VaultItem[]>({ type: "VAULT_RESTORE_ENCRYPTED", backup, backupPassword, replaceExisting, currentPassword }),
  importItems: (items: VaultItem[]) => send<VaultItem[]>({ type: "VAULT_IMPORT_ITEMS", items }),
  listItems: () => send<VaultItem[]>({ type: "VAULT_LIST_ITEMS" }),
  getItem: (itemId: string) => send<VaultItem | undefined>({ type: "VAULT_GET_ITEM", itemId }),
  upsertItem: (item: VaultItem) => send<VaultItem>({ type: "VAULT_UPSERT_ITEM", item }),
  deleteItem: (itemId: string) => send<void>({ type: "VAULT_DELETE_ITEM", itemId }),
  matchLogins: (pageUrl: string) => send<LoginMatchSummary[]>({ type: "VAULT_MATCH_LOGINS", pageUrl }),
  fillLogin: (itemId: string, tabId: number, frameId?: number) => send<{ filledUsername: boolean; filledPassword: boolean; filledTotp: boolean }>({ type: "VAULT_FILL_LOGIN", itemId, tabId, frameId }),
  listWalletItems: (kinds: WalletFillKind[]) => send<WalletMatchSummary[]>({ type: "VAULT_LIST_WALLET_ITEMS", kinds }),
  fillWallet: (itemId: string, tabId: number, frameId?: number) => send<WalletFillResult>({ type: "VAULT_FILL_WALLET", itemId, tabId, frameId }),
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
  syncProvider: (providerId: string) => send<{ warnings: string[]; conflicts: number }>({ type: "PROVIDER_SYNC", providerId }),
  cancelProviderSync: (providerId: string) => send<{ cancelled: boolean }>({ type: "PROVIDER_SYNC_CANCEL", providerId }),
  removeProvider: (providerId: string) => send<void>({ type: "PROVIDER_REMOVE", providerId })
};
