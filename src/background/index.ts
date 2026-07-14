import { isLoginItem, createLoginItem, type LoginItem, type ProviderAccount, type VaultItem } from "../core/model";
import { loginMatchScore, matchingLogins } from "../core/matching";
import { ProviderRegistry } from "../core/provider";
import { generateTotp } from "../core/totp";
import { BitwardenClient } from "../providers/bitwarden/bitwarden-client";
import { BitwardenProvider } from "../providers/bitwarden/bitwarden-provider";
import { MonicaWebDavProvider } from "../providers/webdav/monica-webdav-provider";
import type { ExtensionRequest, ExtensionResponse, LoginMatchSummary } from "../runtime/messages";
import { ChromeVaultSessionStore } from "../security/vault-session";
import { SecureVaultService, VaultLockedError } from "../security/secure-vault-service";
import { IndexedDbVaultStorage } from "../security/vault-storage";

const LEGACY_VAULT_KEY = "monica.extension.credentials.v1";
const AUTO_LOCK_ALARM = "monica-vault-auto-lock";
const service = new SecureVaultService(new IndexedDbVaultStorage(), new ChromeVaultSessionStore());
const providers = new ProviderRegistry();
providers.register(new MonicaWebDavProvider());
providers.register(new BitwardenProvider());
const bitwardenClient = new BitwardenClient();

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) void service.status();
});

chrome.runtime.onMessage.addListener((message: ExtensionRequest, sender, sendResponse: (response: ExtensionResponse) => void) => {
  handleRequest(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) => {
      const locked = error instanceof VaultLockedError;
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "未知后台错误", code: locked ? "VAULT_LOCKED" : undefined });
    });
  return true;
});

async function handleRequest(request: ExtensionRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
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
    case "VAULT_LOCK":
      assertExtensionPage(sender);
      return service.lock();
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
    case "VAULT_FILL_LOGIN": {
      assertExtensionPage(sender);
      return fillLogin(request.itemId, request.tabId, request.frameId);
    }
    case "PROVIDER_LIST":
      assertExtensionPage(sender);
      return service.listProviders();
    case "WEBDAV_TEST": {
      assertExtensionPage(sender);
      const temporary: ProviderAccount = {
        id: "webdav-connection-test",
        kind: "monica-webdav",
        name: "WebDAV connection test",
        enabled: true,
        isDefaultSaveTarget: false,
        config: request.config
      };
      return providers.get("monica-webdav").testConnection(temporary);
    }
    case "WEBDAV_SAVE": {
      assertExtensionPage(sender);
      const existing = request.providerId ? await service.getProvider(request.providerId) : undefined;
      if (existing && existing.kind !== "monica-webdav") throw new Error("所选密码源不是 WebDAV。");
      const previousConfig = existing?.config || {};
      const connectionChanged = ["baseUrl", "username", "password", "backupPassword"].some((key) => previousConfig[key] !== request.config[key]);
      const config = connectionChanged
        ? request.config
        : { ...request.config, lastFileName: previousConfig.lastFileName, lastEtag: previousConfig.lastEtag };
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
    case "PROVIDER_SYNC": {
      assertExtensionPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account) throw new Error("密码源不存在。");
      if (account.kind === "local") throw new Error("本地密码源不需要同步。");
      try {
        const result = await providers.get(account.kind).sync(account, { now: new Date().toISOString(), localItems: (await service.readState()).items });
        await service.applyProviderSync(account.id, result.items, result.accountPatch);
        return { warnings: result.warnings, conflicts: result.conflicts.length };
      } catch (error) {
        await service.upsertProvider({ ...account, lastError: error instanceof Error ? error.message : "同步失败" });
        throw error;
      }
    }
    case "PROVIDER_REMOVE":
      assertExtensionPage(sender);
      return service.removeProvider(request.providerId);
  }
}

async function fillLogin(itemId: string, tabId: number, frameId?: number) {
  const item = await service.getItem(itemId);
  if (!item || !isLoginItem(item)) throw new Error("登录项不存在或已被删除。");
  const tab = await chrome.tabs.get(tabId);
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const targetFrame = frameId === undefined ? frames.find((frame) => frame.frameId === 0) : frames.find((frame) => frame.frameId === frameId);
  const targetUrl = targetFrame?.url || tab.url;
  if (!targetUrl || (loginMatchScore(item, targetUrl) <= 0 && (!tab.url || loginMatchScore(item, tab.url) <= 0))) throw new Error("登录项与目标页面不匹配，已阻止填充。");
  const totpCode = item.totpSecret ? await generateTotp(item.totpSecret) : undefined;
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: "MONICA_FILL_CREDENTIAL",
    credential: { username: item.username, password: item.password, totpCode }
  }, frameId === undefined ? undefined : { frameId })) as { ok?: boolean; error?: string; filledUsername?: boolean; filledPassword?: boolean; filledTotp?: boolean };
  if (!response?.ok) throw new Error(response?.error || "网页拒绝了填充请求。");
  return { filledUsername: Boolean(response.filledUsername), filledPassword: Boolean(response.filledPassword), filledTotp: Boolean(response.filledTotp) };
}

function assertExtensionPage(sender: chrome.runtime.MessageSender): void {
  const root = chrome.runtime.getURL("");
  if (!sender.url?.startsWith(root)) throw new Error("此命令只允许 Monica 插件页面调用。");
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
