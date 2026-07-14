import { isLoginItem, createLoginItem, type LoginItem, type VaultItem } from "../core/model";
import { loginMatchScore, matchingLogins } from "../core/matching";
import type { ExtensionRequest, ExtensionResponse, LoginMatchSummary } from "../runtime/messages";
import { ChromeVaultSessionStore } from "../security/vault-session";
import { SecureVaultService, VaultLockedError } from "../security/secure-vault-service";
import { IndexedDbVaultStorage } from "../security/vault-storage";

const LEGACY_VAULT_KEY = "monica.extension.credentials.v1";
const AUTO_LOCK_ALARM = "monica-vault-auto-lock";
const service = new SecureVaultService(new IndexedDbVaultStorage(), new ChromeVaultSessionStore());

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
      return fillLogin(request.itemId, request.tabId);
    }
  }
}

async function fillLogin(itemId: string, tabId: number) {
  const item = await service.getItem(itemId);
  if (!item || !isLoginItem(item)) throw new Error("登录项不存在或已被删除。");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || loginMatchScore(item, tab.url) <= 0) throw new Error("登录项与当前网站不匹配，已阻止填充。");
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: "MONICA_FILL_CREDENTIAL",
    credential: { username: item.username, password: item.password }
  })) as { ok?: boolean; error?: string; filledUsername?: boolean; filledPassword?: boolean };
  if (!response?.ok) throw new Error(response?.error || "网页拒绝了填充请求。");
  return { filledUsername: Boolean(response.filledUsername), filledPassword: Boolean(response.filledPassword) };
}

function assertExtensionPage(sender: chrome.runtime.MessageSender): void {
  const root = chrome.runtime.getURL("");
  if (!sender.url?.startsWith(root)) throw new Error("此命令只允许 Monica 插件页面调用。");
}

function toMatchSummary(item: LoginItem): LoginMatchSummary {
  return { id: item.id, title: item.title, username: item.username, favorite: item.favorite, uris: item.uris };
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
