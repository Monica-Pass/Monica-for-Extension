import type { ExtensionRequest, ExtensionResponse, LoginMatchSummary, VaultItem, VaultStatusResponse } from "./messages";

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
  listItems: () => send<VaultItem[]>({ type: "VAULT_LIST_ITEMS" }),
  getItem: (itemId: string) => send<VaultItem | undefined>({ type: "VAULT_GET_ITEM", itemId }),
  upsertItem: (item: VaultItem) => send<VaultItem>({ type: "VAULT_UPSERT_ITEM", item }),
  deleteItem: (itemId: string) => send<void>({ type: "VAULT_DELETE_ITEM", itemId }),
  matchLogins: (pageUrl: string) => send<LoginMatchSummary[]>({ type: "VAULT_MATCH_LOGINS", pageUrl }),
  fillLogin: (itemId: string, tabId: number) => send<{ filledUsername: boolean; filledPassword: boolean }>({ type: "VAULT_FILL_LOGIN", itemId, tabId })
};
