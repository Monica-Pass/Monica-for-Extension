import { isLoginItem, createLoginItem, type BillingAddressItem, type CardItem, type IdentityItem, type LoginItem, type PasskeyItem, type PaymentAccountItem, type ProviderAccount, type VaultItem } from "../core/model";
import { loginMatchScore, matchingLogins } from "../core/matching";
import { ProviderRegistry } from "../core/provider";
import { generateTotp } from "../core/totp";
import { BitwardenClient } from "../providers/bitwarden/bitwarden-client";
import { BitwardenProvider } from "../providers/bitwarden/bitwarden-provider";
import { MonicaWebDavProvider } from "../providers/webdav/monica-webdav-provider";
import type { CredentialCaptureInput, ExtensionRequest, ExtensionResponse, LoginMatchSummary, PasskeyPromptContext, PasskeyRequest, PasskeyResult, SavePromptContext, SavePromptProviderSummary, WalletFillKind, WalletFillPayload, WalletFillResult, WalletMatchSummary } from "../runtime/messages";
import { createAssertion, createPasskey, fromBase64Url, toBase64Url, validateRpId } from "../passkey/webauthn-core";
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
const CAPTURE_TTL_MS = 60_000;

interface PendingCredentialCapture extends CredentialCaptureInput {
  id: string;
  tabId: number;
  frameId: number;
  sourceOrigin: string;
  createdAt: number;
  expiresAt: number;
  existingItemId?: string;
  existingTitle?: string;
}

const pendingCredentialCaptures = new Map<string, PendingCredentialCapture>();
const pendingPasskeyRequests = new Map<string, { id: string; request: PasskeyRequest; tabId: number; frameId: number; origin: string; rpId: string; expiresAt: number; matches: string[]; targetProviderId?: string }>();

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    void service.status().then((status) => {
      if (status !== "unlocked") pendingCredentialCaptures.clear();
      if (status !== "unlocked") pendingPasskeyRequests.clear();
    });
  }
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
      pendingCredentialCaptures.clear();
      pendingPasskeyRequests.clear();
      return service.lock();
    case "VAULT_CHANGE_MASTER_PASSWORD":
      assertExtensionPage(sender);
      return service.changeMasterPassword(request.currentPassword, request.newPassword);
    case "VAULT_EXPORT_ENCRYPTED":
      assertExtensionPage(sender);
      return service.exportEncryptedBackup();
    case "VAULT_RESTORE_ENCRYPTED": {
      assertExtensionPage(sender);
      const state = await service.restoreEncryptedBackup(request.backup, request.backupPassword, {
        replaceExisting: request.replaceExisting,
        currentPassword: request.currentPassword
      });
      pendingCredentialCaptures.clear();
      pendingPasskeyRequests.clear();
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
    case "VAULT_FILL_LOGIN": {
      assertExtensionPage(sender);
      return fillLogin(request.itemId, request.tabId, request.frameId);
    }
    case "VAULT_LIST_WALLET_ITEMS": {
      assertExtensionPage(sender);
      return listWalletItems(request.kinds);
    }
    case "VAULT_FILL_WALLET": {
      assertExtensionPage(sender);
      return fillWalletItem(request.itemId, request.tabId, request.frameId);
    }
    case "CREDENTIAL_CAPTURE":
      return captureCredentialCandidate(request.candidate, sender);
    case "CREDENTIAL_PENDING":
      return pendingCredentialCandidate(sender);
    case "CREDENTIAL_ACCEPT":
      return acceptCredentialCandidate(request.candidateId, request.providerId, sender);
    case "CREDENTIAL_DISMISS":
      return dismissCredentialCandidate(request.candidateId, sender);
    case "PASSKEY_BEGIN":
      return beginPasskeyRequest(request.request, sender);
    case "PASSKEY_ACCEPT":
      return acceptPasskeyRequest(request.candidateId, request.itemId, sender);
    case "PASSKEY_DISMISS":
      return dismissPasskeyRequest(request.candidateId, sender);
    case "PROVIDER_LIST":
      assertExtensionPage(sender);
      return service.listProviders();
    case "PROVIDER_QUEUE_STATUS": {
      assertExtensionPage(sender);
      const queue = (await service.readState()).mutationQueue;
      return [...new Set(queue.map((item) => item.providerId))].map((providerId) => { const entries = queue.filter((item) => item.providerId === providerId); return { providerId, pending: entries.length, failed: entries.filter((item) => item.lastError).length, maxAttempts: Math.max(0, ...entries.map((item) => item.attempts)), lastError: [...entries].reverse().find((item) => item.lastError)?.lastError }; });
    }
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
        await service.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts);
        return { warnings: result.warnings, conflicts: result.conflicts.length };
      } catch (error) {
        await service.markProviderSyncFailure(account.id, error instanceof Error ? error.message : "同步失败");
        await service.upsertProvider({ ...account, lastError: error instanceof Error ? error.message : "同步失败" });
        throw error;
      }
    }
    case "PROVIDER_REMOVE":
      assertExtensionPage(sender);
      return service.removeProvider(request.providerId);
  }
}

async function captureCredentialCandidate(input: CredentialCaptureInput, sender: chrome.runtime.MessageSender): Promise<SavePromptContext> {
  const source = assertWebPageSender(sender);
  if ((await service.status()) !== "unlocked") throw new VaultLockedError("密码库已锁定；请先解锁 Monica，再重新提交登录表单。");
  const candidate = validateCredentialCapture(input, source.url);
  purgeExpiredCaptures();

  const state = await service.readState();
  const matches = matchingLogins(state.items.filter(isLoginItem), candidate.pageUrl);
  const normalizedUsername = candidate.username.trim().toLocaleLowerCase();
  const existing = matches.find((item) => normalizedUsername && item.username.trim().toLocaleLowerCase() === normalizedUsername)
    || (candidate.captureKind === "password-change" && matches.length === 1 ? matches[0] : undefined);
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
    existingTitle: existing?.title
  };
  pendingCredentialCaptures.set(pending.id, pending);
  scheduleCaptureExpiry(pending.id, pending.expiresAt);
  const context = savePromptContext(pending, state.providers, state.settings.defaultProviderId);
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
  return savePromptContext(pending, state.providers, state.settings.defaultProviderId);
}

async function acceptCredentialCandidate(candidateId: string, requestedProviderId: string | undefined, sender: chrome.runtime.MessageSender) {
  const source = assertWebPageSender(sender);
  purgeExpiredCaptures();
  const pending = pendingCredentialCaptures.get(candidateId);
  if (!pending || pending.tabId !== source.tabId) throw new Error("保存候选已过期，请重新提交表单。");
  if ((await service.status()) !== "unlocked") throw new VaultLockedError("密码库已锁定，保存候选未写入。");

  let saved: LoginItem;
  let providerName = "Monica 本地库";
  if (pending.existingItemId) {
    const existing = await service.getItem(pending.existingItemId);
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
    action: pending.existingItemId ? "updated" : "saved",
    itemId: saved.id,
    title: saved.title,
    providerName,
    syncPending: saved.providerRefs.length > 0
  };
}

function dismissCredentialCandidate(candidateId: string, sender: chrome.runtime.MessageSender): void {
  const source = assertWebPageSender(sender);
  const pending = pendingCredentialCaptures.get(candidateId);
  if (pending?.tabId === source.tabId) pendingCredentialCaptures.delete(candidateId);
}

function savePromptContext(pending: PendingCredentialCapture, providers: ProviderAccount[], defaultProviderId: string): SavePromptContext {
  const summaries: SavePromptProviderSummary[] = providers.filter((provider) => provider.enabled).map((provider) => ({
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    isDefault: provider.id === defaultProviderId
  }));
  return {
    candidateId: pending.id,
    action: pending.existingItemId ? "update" : "save",
    title: pending.pageTitle,
    username: pending.username,
    host: new URL(pending.pageUrl).hostname,
    existingItemId: pending.existingItemId,
    existingTitle: pending.existingTitle,
    providers: summaries,
    defaultProviderId,
    expiresAt: pending.expiresAt
  };
}

function validateCredentialCapture(input: CredentialCaptureInput, senderUrl: string): CredentialCaptureInput {
  const page = new URL(input.pageUrl);
  const sender = new URL(senderUrl);
  if (!/^https?:$/.test(page.protocol) || page.origin !== sender.origin) throw new Error("凭据候选来源与当前页面不匹配。");
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

function assertWebPageSender(sender: chrome.runtime.MessageSender): { tabId: number; frameId: number; url: string; origin: string } {
  const url = sender.url || "";
  if (sender.tab?.id === undefined || !/^https?:\/\//i.test(url)) throw new Error("此命令只允许网页内容脚本调用。");
  return { tabId: sender.tab.id, frameId: sender.frameId || 0, url, origin: new URL(url).origin };
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

async function beginPasskeyRequest(request: PasskeyRequest, sender: chrome.runtime.MessageSender): Promise<PasskeyPromptContext> {
  const source = assertWebPageSender(sender);
  if ((await service.status()) !== "unlocked") throw new VaultLockedError("密码库已锁定，请先解锁 Monica。");
  const rpId = validateRpId(source.origin, request.rpId);
  const state = await service.readState();
  const passkeys = state.items.filter((item): item is PasskeyItem => item.kind === "passkey" && !item.deletedAt && item.rpId.toLowerCase() === rpId);
  const configuredTarget = state.providers.find((provider) => provider.id === state.settings.defaultProviderId && provider.enabled);
  const localTarget = state.providers.find((provider) => provider.kind === "local");
  const saveTarget = configuredTarget?.kind === "bitwarden" ? configuredTarget : localTarget;
  let matches: PasskeyItem[] = [];
  if (request.operation === "create") {
    if (!request.rpName || !request.userName || !request.userId) throw new Error("Passkey 注册请求缺少用户或网站信息。");
    if (!request.algorithms.includes(-7)) throw new Error("当前仅支持 ES256 Passkey。");
    const excluded = new Set(request.excludeCredentialIds.map(normalizeCredentialId));
    if (passkeys.some((item) => excluded.has(normalizeCredentialId(item.credentialId)))) throw new Error("网站已排除此账户现有的 Passkey。");
  } else {
    const allowed = new Set(request.allowCredentialIds.map(normalizeCredentialId));
    matches = passkeys.filter((item) => item.sourceMode !== "android-metadata-only" && Boolean(item.privateKeyPkcs8) && (!allowed.size || allowed.has(normalizeCredentialId(item.credentialId))));
    if (!matches.length) throw new Error("Monica 中没有可用于此网站的 Passkey。");
  }
  const id = crypto.randomUUID(); const expiresAt = Date.now() + 120_000;
  pendingPasskeyRequests.set(id, { id, request, tabId: source.tabId, frameId: source.frameId, origin: source.origin, rpId, expiresAt, matches: matches.map((item) => item.id), targetProviderId: request.operation === "create" && saveTarget?.kind === "bitwarden" ? saveTarget.id : undefined });
  setTimeout(() => { if ((pendingPasskeyRequests.get(id)?.expiresAt || 0) <= Date.now()) pendingPasskeyRequests.delete(id); }, 120_100);
  return { candidateId: id, operation: request.operation, rpId, rpName: request.operation === "create" ? request.rpName : rpId, userName: request.operation === "create" ? request.userName : matches[0]?.userName || "", saveTargetName: request.operation === "create" ? saveTarget?.name || "Monica 本地库" : undefined, credentials: matches.map((item) => ({ itemId: item.id, title: item.title, userName: item.userName, sourceMode: item.sourceMode === "bitwarden" ? "bitwarden" : "browser-local" })), expiresAt };
}

async function acceptPasskeyRequest(candidateId: string, itemId: string | undefined, sender: chrome.runtime.MessageSender): Promise<PasskeyResult> {
  const source = assertWebPageSender(sender); const pending = pendingPasskeyRequests.get(candidateId);
  if (!pending || pending.expiresAt <= Date.now() || pending.tabId !== source.tabId || pending.frameId !== source.frameId || pending.origin !== source.origin) throw new Error("Passkey 请求已过期或来源不匹配。");
  if ((await service.status()) !== "unlocked") throw new VaultLockedError("密码库已锁定。");
  pendingPasskeyRequests.delete(candidateId);
  if (pending.request.operation === "create") {
    const created = await createPasskey({ ...pending.request, origin: pending.origin, rpId: pending.rpId });
    const now = new Date().toISOString();
    const item: PasskeyItem = { id: crypto.randomUUID(), kind: "passkey", title: pending.request.rpName || pending.rpId, favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: pending.targetProviderId ? [{ providerId: pending.targetProviderId }] : [], credentialId: created.credentialId, rpId: created.rpId, rpName: pending.request.rpName, userHandle: pending.request.userId, userName: pending.request.userName, userDisplayName: pending.request.userDisplayName, algorithm: -7, publicKey: created.publicKeySpki, privateKeyPkcs8: created.privateKeyPkcs8, signCount: 0, discoverable: true, sourceMode: pending.targetProviderId ? "bitwarden" : "browser-local" };
    await service.upsertItem(item);
    return { operation: "create", id: created.credentialId, rawId: created.credentialId, response: created.response };
  }
  const selectedId = itemId || pending.matches[0];
  if (!pending.matches.includes(selectedId)) throw new Error("所选 Passkey 不属于当前请求。");
  const item = await service.getItem(selectedId);
  if (!item || item.kind !== "passkey" || !item.privateKeyPkcs8 || item.sourceMode === "android-metadata-only") throw new Error("所选 Passkey 没有可用私钥。");
  const assertion = await createAssertion({ origin: pending.origin, challenge: pending.request.challenge, rpId: pending.rpId, credentialId: item.credentialId, userHandle: item.userHandle, privateKeyPkcs8: item.privateKeyPkcs8, signCount: item.signCount });
  await service.upsertItem({ ...item, signCount: assertion.signCount });
  const id = normalizeCredentialId(item.credentialId);
  return { operation: "get", id, rawId: id, response: assertion.response };
}

function dismissPasskeyRequest(candidateId: string, sender: chrome.runtime.MessageSender): void { const source = assertWebPageSender(sender); const pending = pendingPasskeyRequests.get(candidateId); if (pending?.tabId === source.tabId && pending.frameId === source.frameId) pendingPasskeyRequests.delete(candidateId); }

function normalizeCredentialId(value: string): string {
  const uuid = value.trim().match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i);
  if (uuid) { const hex = uuid.slice(1).join(""); return toBase64Url(Uint8Array.from(hex.match(/../g) || [], (part) => parseInt(part, 16))); }
  try { return toBase64Url(fromBase64Url(value)); } catch { return value.trim(); }
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

async function fillWalletItem(itemId: string, tabId: number, frameId?: number): Promise<WalletFillResult> {
  const item = await service.getItem(itemId);
  if (!item || !isWalletItem(item)) throw new Error("证件或支付项目不存在或已被删除。");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error("已阻止向非活动标签页填充敏感信息。");
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const target = frames.find((frame) => frame.frameId === (frameId ?? 0));
  const targetUrl = target?.url || (frameId === undefined || frameId === 0 ? tab.url : undefined);
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) throw new Error("当前目标不是可填充的网页。");
  const response = await chrome.tabs.sendMessage(tabId, { type: "MONICA_FILL_WALLET", wallet: walletPayload(item) }, frameId === undefined ? undefined : { frameId }) as { ok?: boolean; error?: string; filledCount?: number; filledFields?: WalletFillResult["filledFields"] };
  if (!response?.ok) throw new Error(response?.error || "网页拒绝了证件或支付信息填充。");
  return { filledCount: Number(response.filledCount) || 0, filledFields: response.filledFields || [] };
}

function walletPayload(item: WalletItem): WalletFillPayload {
  if (item.kind === "identity") return { kind: item.kind, fields: {
    fullName: item.fullName, firstName: item.firstName, middleName: item.middleName, lastName: item.lastName,
    birthDate: item.birthDate, nationality: item.nationality, documentNumber: item.documentNumber, email: item.email, phone: item.phone,
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
    cardSecurityCode: item.securityCode, cardBrand: item.brand
  } };
  return { kind: item.kind, fields: {
    paymentProvider: item.provider, paymentAccountName: item.accountName, paymentAccountHolder: item.accountHolderName,
    email: item.email, phone: item.phone, paymentUsername: item.username, paymentAccountId: item.accountId,
    paymentAccountNumber: unmaskedAccountNumber(item.maskedAccountNumber), routingNumber: item.routingNumber, iban: item.iban,
    swiftBic: item.swiftBic, currency: item.currency
  } };
}

function isWalletItem(item: VaultItem): item is WalletItem {
  return !item.deletedAt && isWalletKind(item.kind);
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
