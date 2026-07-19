<script setup lang="ts">
import "@m3e/web/theme";
import "@m3e/web/app-bar";
import "@m3e/web/button";
import "@m3e/web/card";
import "@m3e/web/icon";
import "@m3e/web/icon-button";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import AppearancePanel from "./components/AppearancePanel.vue";
import GeneratorPanel from "./components/GeneratorPanel.vue";
import SteamNetworkActions from "./components/SteamNetworkActions.vue";
import TotpCodeCell from "./components/TotpCodeCell.vue";
import VaultItemEditor, { type EditableVaultKind } from "./components/VaultItemEditor.vue";
import { createLoginItem, isLoginItem, type LoginItem, type LoginUriMatchType, type LoginUriRule, type ProviderAccount, type ProviderConflict, type ProviderConflictResolution, type SecureCustomField, type TotpItem, type VaultItem } from "./core/model";
import { createQrDataUrl } from "./core/otp-qr";
import { buildWifiQrPayload, parseSshKeyMetadata, parseWifiMetadata, serializeSshKeyMetadata, serializeWifiMetadata, type SshKeyMetadata, type WifiMetadata } from "./core/special-login";
import { activeScheme, themeColor, useThemePreferences } from "./lib/theme";
import { itemIcon, itemKindLabel, itemSafeSummary, itemSearchText, itemSection, type VaultManagerSection } from "./manager/item-metadata";
import { normalizeImportedVaultItem } from "./manager/import-items";
import { passkeyAvailability, passkeyAvailabilityLabel } from "./passkey/source-policy";
import type { MonicaWebDavConfig } from "./providers/webdav/monica-webdav-provider";
import { vaultClient } from "./runtime/client";
import { MIN_MASTER_PASSWORD_LENGTH } from "./security/master-password-policy";
import type { EncryptedVaultBackup, VaultLifecycleStatus } from "./security/secure-vault-service";

type Section = "overview" | VaultManagerSection | "steam" | "generator" | "providers" | "settings";
type LoginType = NonNullable<LoginItem["loginType"]>;

interface LoginForm {
  name: string;
  username: string;
  password: string;
  wifiPassword: string;
  barcodeContent: string;
  notes: string;
  favorite: boolean;
  archived: boolean;
  providerId: string;
  loginType: LoginType;
  ssoProvider: string;
  ssoRefEntryId: string;
  totpSecret: string;
  boundTotpItemId: string;
  uriRules: LoginUriRule[];
  customFields: SecureCustomField[];
  wifiMetadataRaw: string;
  wifi: WifiMetadata;
  sshKeyDataRaw: string;
  sshKey: SshKeyMetadata;
}

const vaultItems = ref<VaultItem[]>([]);
const providers = ref<ProviderAccount[]>([]);
const providerQueues = ref<Array<{ providerId: string; pending: number; failed: number; maxAttempts: number; lastError?: string }>>([]);
const providerConflicts = ref<ProviderConflict[]>([]);
const lifecycle = ref<VaultLifecycleStatus>("locked");
const activeSection = ref<Section>("overview");
const query = ref("");
const loading = ref(true);
const authBusy = ref(false);
const authError = ref("");
const mobileNavOpen = ref(false);
const editorOpen = ref(false);
const vaultEditorOpen = ref(false);
const vaultEditorItem = ref<VaultItem | undefined>();
const vaultEditorKind = ref<EditableVaultKind>("card");
const editingId = ref<string | null>(null);
const revealPassword = ref(false);
const specialQrDataUrl = ref("");
const specialQrError = ref("");
const formError = ref("");
const notice = ref("");
const webDavBusy = ref<"" | "test" | "save" | "sync" | "remove">("");
const activeSyncProviderId = ref("");
const diagnosticBusy = ref(false);
const webDavError = ref("");
const editingWebDavId = ref<string | undefined>();
const webDavDialogOpen = ref(false);
const bitwardenDialogOpen = ref(false);
const bitwardenBusy = ref(false);
const bitwardenError = ref("");
const editingBitwardenId = ref<string | undefined>();
const bitwardenTwoFactorProviders = ref<number[]>([]);
const securityBusy = ref<"" | "password" | "export" | "restore">("");
const securityError = ref("");
const selectedEncryptedBackup = ref<EncryptedVaultBackup | null>(null);
const selectedEncryptedBackupName = ref("");

const auth = reactive({ masterPassword: "", confirmation: "" });
const passwordChange = reactive({ currentPassword: "", newPassword: "", confirmation: "" });
const restoreForm = reactive({ backupPassword: "", currentPassword: "" });
const form = reactive<LoginForm>(emptyLoginForm());
const webDavForm = reactive({ name: "Monica Android WebDAV", baseUrl: "", username: "", password: "", backupPassword: "", passwordConfigured: false, backupPasswordConfigured: false, isDefaultSaveTarget: false });
const bitwardenForm = reactive({ name: "Bitwarden", vaultUrl: "https://vault.bitwarden.com", email: "", masterPassword: "", twoFactorCode: "", twoFactorProvider: 0, rememberTwoFactor: false, isDefaultSaveTarget: false });

useThemePreferences();

const credentials = computed(() => vaultItems.value.filter(isLoginItem));
const filteredCredentials = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return credentials.value;
  return credentials.value.filter((item) => `${item.title} ${item.username} ${item.uris.join(" ")} ${item.notes}`.toLowerCase().includes(needle));
});
const uniqueHosts = computed(() => new Set(credentials.value.flatMap((item) => item.uris)).size);
const favoriteCount = computed(() => vaultItems.value.filter((item) => item.favorite).length);
const walletItems = computed(() => vaultItems.value.filter((item) => itemSection(item) === "wallet"));
const noteItems = computed(() => vaultItems.value.filter((item) => itemSection(item) === "notes"));
const totpItems = computed(() => vaultItems.value.filter((item) => itemSection(item) === "totp"));
const steamItems = computed(() => totpItems.value.filter((item): item is TotpItem => item.kind === "totp" && item.otpType === "STEAM"));
const passkeyItems = computed(() => vaultItems.value.filter((item) => itemSection(item) === "passkeys"));
const filteredSectionItems = computed(() => {
  if (activeSection.value !== "wallet" && activeSection.value !== "notes" && activeSection.value !== "totp" && activeSection.value !== "passkeys") return [];
  const needle = query.value.trim().toLocaleLowerCase();
  return vaultItems.value.filter((item) => itemSection(item) === activeSection.value && (!needle || itemSearchText(item).toLocaleLowerCase().includes(needle)));
});
const webDavProviders = computed(() => providers.value.filter((provider) => provider.kind === "monica-webdav"));
const bitwardenProviders = computed(() => providers.value.filter((provider) => provider.kind === "bitwarden"));
const externalProviders = computed(() => providers.value.filter((provider) => provider.kind !== "local"));
const defaultProviderId = computed(() => providers.value.find((provider) => provider.isDefaultSaveTarget)?.id || providers.value.find((provider) => provider.kind === "local")?.id || "");
const isWebLoginType = computed(() => form.loginType === "PASSWORD" || form.loginType === "SSO");
const isSpecialLoginType = computed(() => form.loginType === "WIFI" || form.loginType === "SSH_KEY" || form.loginType === "BARCODE");

onMounted(initialize);

const hasOpenDialog = computed(() => editorOpen.value || vaultEditorOpen.value || webDavDialogOpen.value || bitwardenDialogOpen.value);
let dialogTrigger: HTMLElement | null = null;

watch(hasOpenDialog, async (open, wasOpen) => {
  if (open && !wasOpen) {
    dialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener("keydown", handleDialogKeydown, true);
    await nextTick();
    const dialog = activeDialog();
    const target = dialog?.querySelector<HTMLElement>("[autofocus]") || focusableDialogElements(dialog)[0];
    target?.focus();
  } else if (!open && wasOpen) {
    document.removeEventListener("keydown", handleDialogKeydown, true);
    await nextTick();
    dialogTrigger?.focus();
    dialogTrigger = null;
  }
});

onBeforeUnmount(() => document.removeEventListener("keydown", handleDialogKeydown, true));

function activeDialog(): HTMLElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
  return dialogs.at(-1) || null;
}

function focusableDialogElements(dialog: HTMLElement | null): HTMLElement[] {
  if (!dialog) return [];
  const selector = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),m3e-button:not([disabled]),m3e-icon-button:not([disabled])';
  return Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
}

function handleDialogKeydown(event: KeyboardEvent) {
  const dialog = activeDialog();
  if (!dialog) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (bitwardenDialogOpen.value) closeBitwardenDialog();
    else if (webDavDialogOpen.value) closeWebDavDialog();
    else if (vaultEditorOpen.value) vaultEditorOpen.value = false;
    else editorOpen.value = false;
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableDialogElements(dialog);
  if (!focusable.length) return void event.preventDefault();
  const active = document.activeElement as HTMLElement | null;
  const index = active ? focusable.indexOf(active) : -1;
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    focusable.at(-1)?.focus();
  } else if (!event.shiftKey && (index < 0 || index === focusable.length - 1)) {
    event.preventDefault();
    focusable[0].focus();
  }
}

async function initialize() {
  loading.value = true;
  try {
    lifecycle.value = await vaultClient.status();
    if (lifecycle.value === "unlocked") await Promise.all([refreshItems(), refreshProviders()]);
  } catch (error) {
    authError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

async function setupVault() {
  authError.value = "";
  if (auth.masterPassword && auth.masterPassword.length < MIN_MASTER_PASSWORD_LENGTH) {
    authError.value = `主密码至少需要 ${MIN_MASTER_PASSWORD_LENGTH} 个字符。`;
    return;
  }
  if (auth.masterPassword !== auth.confirmation) {
    authError.value = "两次输入的主密码不一致。";
    return;
  }
  await authenticate(() => vaultClient.setup(auth.masterPassword));
}

async function unlockVault() {
  authError.value = "";
  await authenticate(() => vaultClient.unlock(auth.masterPassword));
}

async function authenticate(action: () => Promise<VaultItem[]>) {
  authBusy.value = true;
  try {
    vaultItems.value = await action();
    await refreshProviders();
    lifecycle.value = "unlocked";
    auth.masterPassword = "";
    auth.confirmation = "";
  } catch (error) {
    authError.value = errorMessage(error);
  } finally {
    authBusy.value = false;
  }
}

async function lockVault() {
  await vaultClient.lock();
  vaultItems.value = [];
  lifecycle.value = "locked";
  activeSection.value = "overview";
  editorOpen.value = false;
  vaultEditorOpen.value = false;
  webDavDialogOpen.value = false;
  bitwardenDialogOpen.value = false;
}

async function refreshItems() {
  vaultItems.value = await vaultClient.listItems();
}

async function refreshProviders() {
  [providers.value, providerQueues.value, providerConflicts.value] = await Promise.all([
    vaultClient.listProviders(),
    vaultClient.providerQueueStatus(),
    vaultClient.listProviderConflicts()
  ]);
}

function queueFor(providerId: string) {
  return providerQueues.value.find((queue) => queue.providerId === providerId);
}

function conflictsFor(providerId: string) {
  return providerConflicts.value.filter((conflict) => conflict.providerId === providerId);
}

function conflictTitle(conflict: ProviderConflict) {
  return conflict.local?.title || conflict.remote?.title || "密码源级冲突";
}

function navigate(section: Section) {
  activeSection.value = section;
  mobileNavOpen.value = false;
  if (section === "providers") void refreshProviders();
}

function sectionTitle(section: Section): string {
  return ({ overview: "密码库概览", passwords: "登录项", wallet: "钱包与身份", notes: "安全笔记", totp: "动态验证码", steam: "Steam", passkeys: "Passkey", generator: "生成器", providers: "密码源", settings: "设置与备份" } as const)[section];
}

function sectionDescription(section: Section): string {
  return ({ overview: "扩展源码复用 WebUI，但运行时完全独立。", passwords: "登录密码只在解锁后显示和编辑。", wallet: "管理证件、账单地址、银行卡与支付账号。", notes: "只管理加密安全笔记，不混入验证码。", totp: "管理 TOTP、HOTP、Yandex、mOTP 和 Steam Guard 验证器。", steam: "管理 Steam 登录批准、交易确认、库存、市场与授权设备。", passkeys: "查看 Passkey 来源与使用状态；私钥始终保持隐藏。", generator: "使用浏览器加密随机源生成密码、PIN 与密码短语。", providers: "连接 Monica Android WebDAV、Bitwarden 或使用本地库。", settings: "管理外观、导入导出与安全边界。" } as const)[section];
}

function providerName(item: VaultItem): string {
  const reference = item.providerRefs[0];
  return reference ? providers.value.find((provider) => provider.id === reference.providerId)?.name || "外部密码源" : "Monica 本地库";
}

function vaultItemStatus(item: VaultItem): string {
  if (item.kind === "passkey") return passkeyAvailabilityLabel(passkeyAvailability(item));
  if (item.kind === "totp" && item.otpType === "STEAM") return "Steam Guard";
  return "敏感字段已遮罩";
}

async function removeVaultItem(item: VaultItem) {
  if (!window.confirm(`确定删除“${item.title}”吗？${item.providerRefs.length ? "此操作会进入同步删除队列。" : ""}`)) return;
  await vaultClient.deleteItem(item.id);
  await refreshItems();
  showNotice(`${itemKindLabel(item.kind)}已删除。`);
}

function openCreate() {
  editingId.value = null;
  Object.assign(form, emptyLoginForm(defaultProviderId.value));
  formError.value = "";
  revealPassword.value = false;
  clearSpecialQr();
  editorOpen.value = true;
}

function openEdit(item: LoginItem) {
  editingId.value = item.id;
  Object.assign(form, {
    name: item.title,
    username: item.username,
    password: item.password,
    wifiPassword: item.password,
    barcodeContent: item.password,
    notes: item.notes,
    favorite: item.favorite,
    archived: Boolean(item.archivedAt),
    providerId: item.providerRefs[0]?.providerId || providers.value.find((provider) => provider.kind === "local")?.id || "",
    loginType: item.loginType === ("SSH" as LoginType) ? "SSH_KEY" : item.loginType || "PASSWORD",
    ssoProvider: item.ssoProvider || "",
    ssoRefEntryId: item.ssoRefEntryId == null ? "" : String(item.ssoRefEntryId),
    totpSecret: item.totpSecret || "",
    boundTotpItemId: item.boundTotpItemId || "",
    uriRules: effectiveLoginUriRules(item).map((rule) => ({ ...rule })),
    customFields: item.customFields.map((field) => ({ ...field })),
    wifiMetadataRaw: item.wifiMetadata || "",
    wifi: parseWifiMetadata(item.wifiMetadata),
    sshKeyDataRaw: item.sshKeyData || "",
    sshKey: parseSshKeyMetadata(item.sshKeyData)
  });
  formError.value = "";
  revealPassword.value = false;
  clearSpecialQr();
  editorOpen.value = true;
  if (specialPayloadValue()) void refreshSpecialQr();
}

function openVaultCreate(section: "wallet" | "notes" | "totp") {
  vaultEditorItem.value = undefined;
  vaultEditorKind.value = section === "wallet" ? "card" : section === "totp" ? "totp" : "secure-note";
  vaultEditorOpen.value = true;
}

function openVaultEdit(item: VaultItem) {
  if (!isEditableVaultItem(item)) return;
  vaultEditorItem.value = item;
  vaultEditorKind.value = item.kind;
  vaultEditorOpen.value = true;
}

async function saveVaultItem(item: VaultItem) {
  await vaultClient.upsertItem(item);
  await refreshItems();
  vaultEditorOpen.value = false;
  showNotice(`${itemKindLabel(item.kind)}已加密保存。`);
}

async function advanceHotpItem(item: TotpItem) {
  if (item.otpType !== "HOTP") return;
  await vaultClient.upsertItem({ ...item, counter: (item.counter || 0) + 1, updatedAt: new Date().toISOString() });
  await refreshItems();
  showNotice("HOTP 已复制，计数器已安全前进。", 1800);
}

function isEditableVaultItem(item: VaultItem): item is VaultItem & { kind: EditableVaultKind } {
  return item.kind === "card" || item.kind === "identity" || item.kind === "billing-address" || item.kind === "payment-account" || item.kind === "secure-note" || item.kind === "totp";
}

async function submitCredential() {
  if (!form.name.trim()) return void (formError.value = "请输入登录项名称。");
  if (form.loginType === "WIFI" && !validJsonObject(form.wifiMetadataRaw)) return void (formError.value = "Wi-Fi Android 元数据必须是有效的 JSON 对象。");
  if (form.loginType === "SSH_KEY" && !validJsonObject(form.sshKeyDataRaw)) return void (formError.value = "SSH Android 元数据必须是有效的 JSON 对象。");
  const uriRules = form.uriRules.map((rule) => ({ uri: rule.uri.trim(), matchType: rule.matchType })).filter((rule) => Boolean(rule.uri));
  const uris = uriRules.map((rule) => rule.uri);
  const customFields = form.customFields.map((field) => ({ ...field, name: field.name.trim() })).filter((field) => field.name || field.value);
  const ssoRefEntryId = form.ssoRefEntryId.trim() ? Number(form.ssoRefEntryId) : undefined;
  if (ssoRefEntryId !== undefined && (!Number.isSafeInteger(ssoRefEntryId) || ssoRefEntryId < 0)) return void (formError.value = "SSO 引用条目 ID 必须是非负整数。");

  const existing = credentials.value.find((item) => item.id === editingId.value);
  const wifiMetadata = form.loginType === "WIFI"
    ? serializeWifiMetadata(form.wifiMetadataRaw, form.wifi)
    : existing?.wifiMetadata;
  const sshKeyData = form.loginType === "SSH_KEY"
    ? serializeSshKeyMetadata(form.sshKeyDataRaw, form.sshKey)
    : existing?.sshKeyData;
  const shared = {
    title: form.name.trim(),
    username: form.username.trim(),
    password: form.loginType === "WIFI" || form.loginType === "BARCODE" ? (form.loginType === "WIFI" ? form.wifiPassword : form.barcodeContent) : form.password,
    uris,
    uriRules,
    notes: form.notes.trim(),
    favorite: form.favorite,
    loginType: form.loginType,
    ssoProvider: form.loginType === "SSO" ? form.ssoProvider.trim() : "",
    ssoRefEntryId: form.loginType === "SSO" ? ssoRefEntryId : undefined,
    totpSecret: form.boundTotpItemId ? undefined : form.totpSecret.trim() || undefined,
    boundTotpItemId: form.boundTotpItemId || undefined,
    customFields,
    wifiMetadata,
    sshKeyData,
    archivedAt: form.archived ? existing?.archivedAt || new Date().toISOString() : undefined
  };
  const item: LoginItem = existing
    ? { ...existing, ...shared }
    : { ...createLoginItem({
        title: form.name,
        username: form.username,
        password: form.loginType === "WIFI" || form.loginType === "BARCODE" ? (form.loginType === "WIFI" ? form.wifiPassword : form.barcodeContent) : form.password,
        uris,
        notes: form.notes,
        favorite: form.favorite,
        providerRefs: providers.value.find((provider) => provider.id === form.providerId)?.kind === "local" || !form.providerId ? [] : [{ providerId: form.providerId }]
      }), ...shared };
  await vaultClient.upsertItem(item);
  await refreshItems();
  showNotice(existing ? "登录项已加密更新。" : "登录项已加密保存。");
  editorOpen.value = false;
}

function emptyLoginForm(providerId = ""): LoginForm {
  return {
    name: "", username: "", password: "", wifiPassword: "", barcodeContent: "", notes: "", favorite: false, archived: false, providerId,
    loginType: "PASSWORD", ssoProvider: "", ssoRefEntryId: "", totpSecret: "", boundTotpItemId: "",
    uriRules: [{ uri: "", matchType: "base-domain" }], customFields: [],
    wifiMetadataRaw: "", wifi: parseWifiMetadata(undefined),
    sshKeyDataRaw: "", sshKey: parseSshKeyMetadata(undefined)
  };
}

function applySpecialRaw(): void {
  if (form.loginType === "WIFI") {
    if (!validJsonObject(form.wifiMetadataRaw)) return void (formError.value = "Wi-Fi Android 元数据必须是有效的 JSON 对象。");
    Object.assign(form.wifi, parseWifiMetadata(form.wifiMetadataRaw));
  } else if (form.loginType === "SSH_KEY") {
    if (!validJsonObject(form.sshKeyDataRaw)) return void (formError.value = "SSH Android 元数据必须是有效的 JSON 对象。");
    Object.assign(form.sshKey, parseSshKeyMetadata(form.sshKeyDataRaw));
  }
  formError.value = "";
  clearSpecialQr();
}

async function refreshSpecialQr(): Promise<void> {
  specialQrDataUrl.value = "";
  specialQrError.value = "";
  try {
    specialQrDataUrl.value = await createQrDataUrl(specialPayloadValue());
  } catch (cause) {
    specialQrError.value = cause instanceof Error ? cause.message : "无法生成二维码。";
  }
}

async function copySpecialPayload(): Promise<void> {
  const payload = specialPayloadValue();
  if (!payload.trim()) return void (specialQrError.value = "没有可复制的内容。");
  await navigator.clipboard.writeText(payload);
  showNotice("内容已复制到剪贴板。", 1800);
}

function clearSpecialQr(): void {
  specialQrDataUrl.value = "";
  specialQrError.value = "";
}

function specialPayloadValue(): string {
  if (form.loginType === "WIFI") return form.wifi.ssid.trim() ? buildWifiQrPayload(form.wifi, form.wifiPassword, form.username) : "";
  if (form.loginType === "SSH_KEY") return form.sshKey.publicKeyOpenSsh.trim();
  if (form.loginType === "BARCODE") return form.barcodeContent;
  return "";
}

function validJsonObject(raw: string): boolean {
  if (!raw.trim()) return true;
  try {
    const value = JSON.parse(raw);
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function effectiveLoginUriRules(item: LoginItem): LoginUriRule[] {
  if (item.uriRules?.length) return item.uriRules;
  return item.uris.map((uri) => ({ uri, matchType: "base-domain" }));
}

function addUriRule() {
  form.uriRules.push({ uri: "", matchType: "base-domain" });
}

function removeUriRule(index: number) {
  form.uriRules.splice(index, 1);
}

function addCustomField() {
  form.customFields.push({ name: "", value: "", protected: false, type: "text" });
}

function removeCustomField(index: number) {
  form.customFields.splice(index, 1);
}

function uriMatchTypeLabel(type: LoginUriMatchType): string {
  return ({ "base-domain": "主域名", domain: "域及子域名", "starts-with": "网址开头", exact: "完全相同", regex: "正则表达式", never: "从不匹配" } as const)[type];
}

async function removeCredential(item: LoginItem) {
  if (!window.confirm(`确定删除“${item.title}”吗？此操作会进入同步删除队列。`)) return;
  await vaultClient.deleteItem(item.id);
  await refreshItems();
  showNotice("登录项已删除。");
}

function newWebDav() {
  editingWebDavId.value = undefined;
  Object.assign(webDavForm, { name: "Monica Android WebDAV", baseUrl: "", username: "", password: "", backupPassword: "", passwordConfigured: false, backupPasswordConfigured: false, isDefaultSaveTarget: false });
  webDavError.value = "";
  webDavDialogOpen.value = true;
}

function editWebDav(provider: ProviderAccount) {
  const config = provider.config as Partial<MonicaWebDavConfig>;
  editingWebDavId.value = provider.id;
  Object.assign(webDavForm, {
    name: provider.name,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "",
    username: typeof config.username === "string" ? config.username : "",
    password: "",
    backupPassword: "",
    passwordConfigured: config.passwordConfigured === true,
    backupPasswordConfigured: config.backupPasswordConfigured === true,
    isDefaultSaveTarget: provider.isDefaultSaveTarget
  });
  webDavError.value = "";
  webDavDialogOpen.value = true;
}

function closeWebDavDialog() {
  webDavDialogOpen.value = false;
  webDavForm.password = "";
  webDavForm.backupPassword = "";
  webDavError.value = "";
}

function webDavConfig(): MonicaWebDavConfig {
  return {
    baseUrl: webDavForm.baseUrl.trim(),
    username: webDavForm.username.trim(),
    password: webDavForm.password,
    backupPassword: webDavForm.backupPassword || undefined
  };
}

async function testWebDav() {
  await runWebDavAction("test", async () => {
    await vaultClient.testWebDav(webDavConfig(), editingWebDavId.value);
    showNotice("WebDAV 连接成功，Monica_Backups 目录可访问。");
  });
}

async function saveWebDav() {
  await runWebDavAction("save", async () => {
    const saved = await vaultClient.saveWebDav(webDavForm.name, webDavConfig(), editingWebDavId.value, webDavForm.isDefaultSaveTarget);
    editingWebDavId.value = saved.id;
    await refreshProviders();
    showNotice("WebDAV 密码源已保存到加密密码库。");
    closeWebDavDialog();
  });
}

async function syncProvider(provider: ProviderAccount) {
  activeSyncProviderId.value = provider.id;
  await runWebDavAction("sync", async () => {
    let result: Awaited<ReturnType<typeof vaultClient.syncProvider>>;
    try {
      result = await vaultClient.syncProvider(provider.id);
    } finally {
      await refreshProviders();
    }
    await refreshItems();
    const details = result.conflicts ? `发现 ${result.conflicts} 个冲突，未覆盖远端数据。` : result.warnings[0] || "同步完成。";
    showNotice(details);
  });
  activeSyncProviderId.value = "";
}

async function cancelProviderSync(provider: ProviderAccount) {
  const result = await vaultClient.cancelProviderSync(provider.id);
  if (result.cancelled) showNotice(`正在取消 ${provider.name} 同步…`);
}

async function resolveProviderConflict(conflict: ProviderConflict, resolution: ProviderConflictResolution) {
  const action = resolution === "keep-local" ? "保留浏览器版本并在下次同步写回" : conflict.remote ? "采用远端版本并丢弃浏览器修改" : "接受远端删除";
  if (!window.confirm(`确定${action}“${conflictTitle(conflict)}”吗？`)) return;
  await vaultClient.resolveProviderConflict(conflict.id, resolution);
  await Promise.all([refreshItems(), refreshProviders()]);
  showNotice("同步冲突已原子解决。");
}

async function exportProviderDiagnostics() {
  diagnosticBusy.value = true;
  try {
    const diagnostics = await vaultClient.exportProviderDiagnostics();
    downloadJsonFile(`monica-provider-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, diagnostics);
    showNotice(`已导出 ${diagnostics.summary.total} 条脱敏诊断；文件不包含凭据或密码库内容。`);
  } catch (error) {
    webDavError.value = errorMessage(error);
  } finally {
    diagnosticBusy.value = false;
  }
}

async function removeProvider(provider: ProviderAccount) {
  const remoteName = provider.kind === "bitwarden" ? "Bitwarden 密码库" : "WebDAV 文件";
  if (!window.confirm(`确定移除“${provider.name}”吗？插件中的该源缓存项目会移除，远端 ${remoteName} 不会被删除。`)) return;
  await runWebDavAction("remove", async () => {
    await vaultClient.removeProvider(provider.id);
    await Promise.all([refreshItems(), refreshProviders()]);
    if (editingWebDavId.value === provider.id) closeWebDavDialog();
    if (editingBitwardenId.value === provider.id) closeBitwardenDialog();
    showNotice(`${provider.name} 已从插件中移除，远端数据未改动。`);
  });
}

async function runWebDavAction(kind: typeof webDavBusy.value, action: () => Promise<void>) {
  webDavError.value = "";
  webDavBusy.value = kind;
  try {
    await action();
  } catch (error) {
    webDavError.value = errorMessage(error);
  } finally {
    webDavBusy.value = "";
  }
}

function openBitwarden(provider?: ProviderAccount) {
  editingBitwardenId.value = provider?.id;
  const config = provider?.config || {};
  Object.assign(bitwardenForm, {
    name: provider?.name || "Bitwarden",
    vaultUrl: typeof config.vaultUrl === "string" ? config.vaultUrl : "https://vault.bitwarden.com",
    email: typeof config.email === "string" ? config.email : "",
    masterPassword: "",
    twoFactorCode: "",
    twoFactorProvider: 0,
    rememberTwoFactor: false,
    isDefaultSaveTarget: provider?.isDefaultSaveTarget || false
  });
  bitwardenTwoFactorProviders.value = [];
  bitwardenError.value = "";
  bitwardenDialogOpen.value = true;
}

function closeBitwardenDialog() {
  bitwardenDialogOpen.value = false;
  bitwardenForm.masterPassword = "";
  bitwardenForm.twoFactorCode = "";
  bitwardenTwoFactorProviders.value = [];
  bitwardenError.value = "";
}

async function connectBitwarden() {
  if (!bitwardenForm.masterPassword) return void (bitwardenError.value = "请输入 Bitwarden 主密码。");
  if (bitwardenTwoFactorProviders.value.length && !bitwardenForm.twoFactorCode.trim()) return void (bitwardenError.value = "请输入两步验证代码。");
  bitwardenBusy.value = true;
  bitwardenError.value = "";
  try {
    const result = await vaultClient.loginBitwarden({
      providerId: editingBitwardenId.value,
      name: bitwardenForm.name,
      vaultUrl: bitwardenForm.vaultUrl,
      email: bitwardenForm.email,
      masterPassword: bitwardenForm.masterPassword,
      twoFactorCode: bitwardenForm.twoFactorCode || undefined,
      twoFactorProvider: bitwardenTwoFactorProviders.value.length ? bitwardenForm.twoFactorProvider : undefined,
      rememberTwoFactor: bitwardenForm.rememberTwoFactor,
      isDefaultSaveTarget: bitwardenForm.isDefaultSaveTarget
    });
    if (result.status === "two-factor-required") {
      const supported = result.providers.filter((provider) => provider === 0 || provider === 1 || provider === 3);
      if (!supported.length) {
        bitwardenError.value = "此账号只启用了 Duo/WebAuthn 等交互式两步验证；当前插件阶段支持身份验证器、邮箱和 YubiKey 代码。";
        return;
      }
      bitwardenTwoFactorProviders.value = supported;
      bitwardenForm.twoFactorProvider = supported.includes(0) ? 0 : supported[0];
      showNotice("Bitwarden 需要两步验证，请输入代码后继续。");
      return;
    }
    await refreshProviders();
    closeBitwardenDialog();
    showNotice("Bitwarden 已连接；点击立即同步导入密码库。");
  } catch (error) {
    bitwardenError.value = errorMessage(error);
  } finally {
    bitwardenBusy.value = false;
  }
}

async function sendBitwardenEmailCode() {
  bitwardenBusy.value = true;
  bitwardenError.value = "";
  try {
    await vaultClient.sendBitwardenEmailCode(bitwardenForm.vaultUrl, bitwardenForm.email, bitwardenForm.masterPassword, editingBitwardenId.value);
    showNotice("Bitwarden 邮箱验证码已发送。");
  } catch (error) {
    bitwardenError.value = errorMessage(error);
  } finally {
    bitwardenBusy.value = false;
  }
}

function twoFactorName(provider: number): string {
  return ({ 0: "身份验证器", 1: "邮箱", 2: "Duo", 3: "YubiKey", 4: "Duo（组织）", 5: "WebAuthn" } as Record<number, string>)[provider] || `方式 ${provider}`;
}

function downloadJsonFile(fileName: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportVault() {
  downloadJsonFile(`monica-extension-export-${new Date().toISOString().slice(0, 10)}.json`, { version: 1, items: vaultItems.value });
}

async function exportEncryptedVault() {
  securityBusy.value = "export";
  securityError.value = "";
  try {
    const backup = await vaultClient.exportEncryptedBackup();
    downloadJsonFile(`monica-extension-encrypted-${new Date().toISOString().slice(0, 10)}.json`, backup);
    showNotice("已导出加密整库备份；恢复时需要当前主密码。");
  } catch (error) {
    securityError.value = errorMessage(error);
  } finally {
    securityBusy.value = "";
  }
}

async function selectEncryptedBackup(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  securityError.value = "";
  if (!file) return;
  if (file.size > 96 * 1024 * 1024) return void (securityError.value = "加密备份文件过大。");
  try {
    const parsed = JSON.parse(await file.text()) as EncryptedVaultBackup;
    if (parsed.magic !== "MONICA_EXTENSION_BACKUP" || parsed.version !== 1 || !parsed.envelope) throw new Error("格式无效");
    selectedEncryptedBackup.value = parsed;
    selectedEncryptedBackupName.value = file.name;
    restoreForm.backupPassword = "";
    restoreForm.currentPassword = "";
  } catch {
    selectedEncryptedBackup.value = null;
    selectedEncryptedBackupName.value = "";
    securityError.value = "所选文件不是受支持的 Monica 加密整库备份。";
  }
}

async function restoreEncryptedVault() {
  if (!selectedEncryptedBackup.value) return void (securityError.value = "请先选择加密整库备份。");
  if (!restoreForm.backupPassword) return void (securityError.value = "请输入备份主密码。");
  const replacing = lifecycle.value === "unlocked";
  if (replacing && !restoreForm.currentPassword) return void (securityError.value = "替换当前密码库需要验证当前主密码。");
  if (replacing && !window.confirm("恢复会完整替换当前本地密码库。确定继续吗？")) return;
  securityBusy.value = "restore";
  securityError.value = "";
  try {
    vaultItems.value = await vaultClient.restoreEncryptedBackup(selectedEncryptedBackup.value, restoreForm.backupPassword, replacing, replacing ? restoreForm.currentPassword : undefined);
    lifecycle.value = "unlocked";
    selectedEncryptedBackup.value = null;
    selectedEncryptedBackupName.value = "";
    restoreForm.backupPassword = "";
    restoreForm.currentPassword = "";
    auth.masterPassword = "";
    auth.confirmation = "";
    await Promise.all([refreshItems(), refreshProviders()]);
    showNotice("加密整库备份已完成原子恢复。");
  } catch (error) {
    securityError.value = errorMessage(error);
  } finally {
    securityBusy.value = "";
  }
}

async function changeMasterPassword() {
  securityError.value = "";
  if (passwordChange.newPassword && passwordChange.newPassword.length < MIN_MASTER_PASSWORD_LENGTH) return void (securityError.value = `新主密码至少需要 ${MIN_MASTER_PASSWORD_LENGTH} 个字符，或留空改为设备密钥。`);
  if (passwordChange.newPassword !== passwordChange.confirmation) return void (securityError.value = "两次输入的新主密码不一致。");
  securityBusy.value = "password";
  try {
    await vaultClient.changeMasterPassword(passwordChange.currentPassword, passwordChange.newPassword);
    passwordChange.currentPassword = "";
    passwordChange.newPassword = "";
    passwordChange.confirmation = "";
    showNotice("主密码已更改，密码库已使用新盐重新加密。");
  } catch (error) {
    securityError.value = errorMessage(error);
  } finally {
    securityBusy.value = "";
  }
}

async function importVault(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()) as { items?: unknown[]; credentials?: Array<Record<string, unknown>> };
    const items: VaultItem[] = Array.isArray(parsed.items) ? parsed.items.flatMap((item) => {
      const normalized = normalizeImportedVaultItem(item);
      return normalized ? [{ ...normalized, providerRefs: normalized.providerRefs.filter((reference) => providers.value.some((provider) => provider.id === reference.providerId)) } as VaultItem] : [];
    }) : [];
    if (!items.length && Array.isArray(parsed.credentials)) {
      for (const legacy of parsed.credentials) {
        if (typeof legacy.password !== "string" || !Array.isArray(legacy.urls)) continue;
        items.push(createLoginItem({ title: String(legacy.name || "导入登录项"), username: String(legacy.username || ""), password: legacy.password, uris: legacy.urls.map(String), notes: String(legacy.notes || ""), favorite: Boolean(legacy.favorite) }));
      }
    }
    if (!items.length) throw new Error("no supported items");
    await vaultClient.importItems(items);
    await refreshItems();
    showNotice(`已加密导入 ${items.length} 个密码库项目。`);
  } catch {
    showNotice("导入失败：文件中没有可识别的 Monica 密码库项目。");
  }
}

function showNotice(message: string) {
  notice.value = message;
  window.setTimeout(() => {
    if (notice.value === message) notice.value = "";
  }, 3500);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
</script>

<template>
  <m3e-theme :color="themeColor" :scheme="activeScheme" variant="expressive" motion="expressive" strong-focus>
    <div v-if="loading" class="loading">
      <img src="/icons/logo-256.png" alt="" /><h1>Monica</h1><p>正在检查加密密码库…</p>
    </div>

    <form v-else-if="lifecycle !== 'unlocked'" class="login vault-auth" @submit.prevent="lifecycle === 'uninitialized' ? setupVault() : unlockVault()">
      <div class="brand"><img src="/icons/logo-256.png" alt="" /><span>Monica<small>浏览器插件</small></span></div>
      <m3e-card variant="outlined" class="login-card">
        <div slot="content" class="stack">
          <div><h1>{{ lifecycle === 'uninitialized' ? '创建加密密码库' : '解锁 Monica' }}</h1><p class="supporting">{{ lifecycle === 'uninitialized' ? '主密码可留空。留空时使用本机设备密钥自动解锁；设置主密码可获得更强的离线保护。' : '主密码模式请输入密码；设备密钥模式可留空解锁。' }}</p></div>
          <label class="field"><span>主密码{{ lifecycle === 'uninitialized' ? '（可选）' : '' }}</span><input v-model="auth.masterPassword" aria-label="主密码" type="password" :minlength="auth.masterPassword ? MIN_MASTER_PASSWORD_LENGTH : undefined" autocomplete="current-password" autofocus /></label>
          <label v-if="lifecycle === 'uninitialized'" class="field"><span>确认主密码</span><input v-model="auth.confirmation" type="password" :minlength="auth.confirmation ? MIN_MASTER_PASSWORD_LENGTH : undefined" autocomplete="new-password" /></label>
          <p v-if="authError" class="form-error" role="alert">{{ authError }}</p>
          <m3e-button variant="filled" type="submit" :disabled="authBusy">{{ authBusy ? '处理中…' : lifecycle === 'uninitialized' ? '创建并解锁' : '解锁' }}</m3e-button>
          <div v-if="lifecycle === 'uninitialized'" class="recovery-panel stack">
            <div><strong>已有加密整库备份？</strong><p class="supporting">选择备份并输入它原来的主密码，可恢复项目、密码源和设置。</p></div>
            <label class="file-action"><m3e-icon name="upload"></m3e-icon><span>选择加密整库备份</span><input type="file" accept="application/json,.json" @change="selectEncryptedBackup" /></label>
            <template v-if="selectedEncryptedBackup">
              <p class="supporting">已选择：{{ selectedEncryptedBackupName }}</p>
              <label class="field"><span>备份主密码</span><input v-model="restoreForm.backupPassword" type="password" autocomplete="current-password" /></label>
              <m3e-button variant="tonal" type="button" :disabled="Boolean(securityBusy)" @click="restoreEncryptedVault">{{ securityBusy === 'restore' ? '正在恢复…' : '恢复并解锁' }}</m3e-button>
            </template>
            <p v-if="securityError" class="form-error" role="alert">{{ securityError }}</p>
          </div>
          <div class="security-note"><m3e-icon name="encrypted"></m3e-icon><span>AES-256-GCM · Argon2id 或设备密钥 · 自动锁定</span></div>
        </div>
      </m3e-card>
    </form>

    <div v-else class="shell" :class="{ 'nav-open': mobileNavOpen }">
      <a class="skip-link" href="#main-content">跳到主内容</a>
      <aside id="primary-navigation" class="sidebar">
        <div class="brand sidebar-brand"><img src="/icons/logo-256.png" alt="" /><span>Monica<small>浏览器插件</small></span></div>
        <nav aria-label="主导航">
          <section>
            <p class="nav-title">密码库</p>
            <button class="nav-item" :class="{ selected: activeSection === 'overview' }" :aria-current="activeSection === 'overview' ? 'page' : undefined" type="button" @click="navigate('overview')"><m3e-icon name="dashboard"></m3e-icon><span>概览</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'passwords' }" :aria-current="activeSection === 'passwords' ? 'page' : undefined" type="button" @click="navigate('passwords')"><m3e-icon name="password"></m3e-icon><span>登录项</span><span class="nav-count">{{ credentials.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'wallet' }" :aria-current="activeSection === 'wallet' ? 'page' : undefined" type="button" @click="navigate('wallet')"><m3e-icon name="wallet"></m3e-icon><span>钱包与身份</span><span class="nav-count">{{ walletItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'notes' }" :aria-current="activeSection === 'notes' ? 'page' : undefined" type="button" @click="navigate('notes')"><m3e-icon name="note_stack"></m3e-icon><span>安全笔记</span><span class="nav-count">{{ noteItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'totp' }" :aria-current="activeSection === 'totp' ? 'page' : undefined" type="button" @click="navigate('totp')"><m3e-icon name="timer"></m3e-icon><span>动态验证码</span><span class="nav-count">{{ totpItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'steam' }" :aria-current="activeSection === 'steam' ? 'page' : undefined" type="button" @click="navigate('steam')"><m3e-icon name="sports_esports"></m3e-icon><span>Steam</span><span class="nav-count">{{ steamItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'passkeys' }" :aria-current="activeSection === 'passkeys' ? 'page' : undefined" type="button" @click="navigate('passkeys')"><m3e-icon name="key_vertical"></m3e-icon><span>Passkey</span><span class="nav-count">{{ passkeyItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'providers' }" :aria-current="activeSection === 'providers' ? 'page' : undefined" type="button" @click="navigate('providers')"><m3e-icon name="cloud_sync"></m3e-icon><span>密码源</span></button>
          </section>
          <section>
            <p class="nav-title">插件</p>
            <button class="nav-item" :class="{ selected: activeSection === 'settings' }" :aria-current="activeSection === 'settings' ? 'page' : undefined" type="button" @click="navigate('settings')"><m3e-icon name="settings"></m3e-icon><span>设置与备份</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'generator' }" :aria-current="activeSection === 'generator' ? 'page' : undefined" type="button" @click="navigate('generator')"><m3e-icon name="tune"></m3e-icon><span>生成器</span></button>
          </section>
        </nav>
        <div class="sidebar-footer">
          <div class="local-badge"><m3e-icon name="encrypted"></m3e-icon><span>密码库已加密并解锁</span></div>
          <m3e-button variant="tonal" @click="lockVault"><m3e-icon slot="icon" name="lock"></m3e-icon>立即锁定</m3e-button>
        </div>
      </aside>

      <main id="main-content" tabindex="-1">
        <m3e-app-bar size="small" class="page-appbar">
          <m3e-icon-button slot="leading" class="mobile-menu" aria-label="打开导航" aria-controls="primary-navigation" :aria-expanded="mobileNavOpen" @click="mobileNavOpen = !mobileNavOpen"><m3e-icon name="menu"></m3e-icon></m3e-icon-button>
          <div slot="trailing" class="appbar-trailing"><label class="search"><m3e-icon name="search"></m3e-icon><input v-model="query" aria-label="搜索密码库" placeholder="搜索当前分类" /></label></div>
        </m3e-app-bar>

        <div class="page-heading">
          <div><h1>{{ sectionTitle(activeSection) }}</h1><p>{{ sectionDescription(activeSection) }}</p></div>
          <m3e-button v-if="activeSection === 'overview' || activeSection === 'passwords'" class="primary-action" variant="filled" @click="openCreate"><m3e-icon slot="icon" name="add"></m3e-icon>添加登录项</m3e-button>
          <m3e-button v-else-if="activeSection === 'wallet' || activeSection === 'notes' || activeSection === 'totp'" class="primary-action" variant="filled" @click="openVaultCreate(activeSection)"><m3e-icon slot="icon" name="add"></m3e-icon>{{ activeSection === 'wallet' ? '添加钱包项目' : activeSection === 'totp' ? '添加验证码' : '添加安全笔记' }}</m3e-button>
        </div>
        <p class="sr-status" aria-live="polite">{{ notice }}</p>

        <section v-if="activeSection === 'overview'" class="metrics">
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="password"></m3e-icon><p>登录项</p><strong>{{ credentials.length }}</strong><small>加密缓存中的有效项</small></div></m3e-card>
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="inventory_2"></m3e-icon><p>全部项目</p><strong>{{ vaultItems.length }}</strong><small>所有可管理的加密记录</small></div></m3e-card>
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="star"></m3e-icon><p>收藏</p><strong>{{ favoriteCount }}</strong><small>优先匹配的账号</small></div></m3e-card>
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="encrypted"></m3e-icon><p>安全状态</p><strong class="metric-word">已解锁</strong><small>15 分钟无操作自动锁定</small></div></m3e-card>
        </section>

        <section v-if="activeSection === 'overview'" class="content-grid"><m3e-card variant="filled" class="motion-card"><div slot="content" class="getting-started"><span class="feature-icon"><m3e-icon name="auto_fix_high"></m3e-icon></span><div><h2>自动填充基线已连接加密核心</h2><p>Popup 只读取匹配项摘要；点击填充后由后台解密单个登录项并发送给当前网页。</p></div><m3e-button variant="tonal" @click="navigate('passwords')">管理登录项</m3e-button></div></m3e-card></section>

        <section v-else-if="activeSection === 'passwords'" class="content-grid">
          <m3e-card variant="filled" class="data-card motion-card">
            <div slot="header" class="card-head"><h2>全部登录项</h2><p>{{ filteredCredentials.length }} 个结果</p></div>
            <div v-if="filteredCredentials.length" class="table-wrap"><table><thead><tr><th>名称</th><th>用户名</th><th>匹配网站</th><th>更新时间</th><th><span class="visually-hidden">操作</span></th></tr></thead><tbody>
              <tr v-for="item in filteredCredentials" :key="item.id"><td class="item-cell" data-label="名称"><div class="row-title"><span class="row-icon"><m3e-icon :name="item.favorite ? 'star' : 'language'"></m3e-icon></span><div><strong>{{ item.title }}</strong><small>••••••••••••</small></div></div></td><td data-label="用户名">{{ item.username || '—' }}</td><td data-label="匹配网站"><span class="url-list">{{ item.uris.join(' · ') }}</span></td><td data-label="更新时间">{{ new Date(item.updatedAt).toLocaleString() }}</td><td class="action-cell"><m3e-icon-button aria-label="编辑登录项" @click="openEdit(item)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="删除登录项" @click="removeCredential(item)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></td></tr>
            </tbody></table></div>
            <div v-else class="empty-state" slot="content"><m3e-icon name="key_off"></m3e-icon><h2>{{ query ? '没有匹配的登录项' : '加密密码库还是空的' }}</h2><p>{{ query ? '换一个关键词试试。' : '添加第一个账号后即可在 Popup 中匹配。' }}</p><m3e-button v-if="!query" variant="filled" @click="openCreate">添加登录项</m3e-button></div>
          </m3e-card>
        </section>

        <section v-else-if="activeSection === 'steam'" class="steam-page">
          <m3e-card v-for="item in steamItems" :key="item.id" variant="filled" class="motion-card steam-account-card"><div slot="content"><SteamNetworkActions :item="item" :query="query" /></div></m3e-card>
          <div v-if="!steamItems.length" class="empty-state steam-page-empty"><m3e-icon name="sports_esports"></m3e-icon><h2>还没有 Steam 验证器</h2><p>从 Monica Android 同步，或在动态验证码中添加 Steam Guard。</p><m3e-button variant="filled" @click="openVaultCreate('totp')">添加 Steam Guard</m3e-button></div>
        </section>

        <GeneratorPanel v-else-if="activeSection === 'generator'" />

        <section v-else-if="activeSection === 'wallet' || activeSection === 'notes' || activeSection === 'totp' || activeSection === 'passkeys'" class="content-grid">
          <m3e-card variant="filled" class="data-card motion-card">
            <div slot="header" class="card-head"><h2>{{ sectionTitle(activeSection) }}</h2><p>{{ filteredSectionItems.length }} 个结果</p></div>
            <div v-if="filteredSectionItems.length" class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>安全摘要</th><th>密码源</th><th>更新时间</th><th><span class="visually-hidden">操作</span></th></tr></thead><tbody>
              <tr v-for="item in filteredSectionItems" :key="item.id"><td class="item-cell" data-label="名称"><div class="row-title"><span class="row-icon"><m3e-icon :name="item.favorite ? 'star' : itemIcon(item.kind)"></m3e-icon></span><div><strong>{{ item.title }}</strong><small>{{ vaultItemStatus(item) }}</small></div></div></td><td data-label="类型"><span class="state state-local-only">{{ itemKindLabel(item.kind) }}</span></td><td data-label="安全摘要"><template v-if="item.kind === 'totp'"><TotpCodeCell :item="item" allow-use @used="advanceHotpItem(item)" /></template><template v-else>{{ itemSafeSummary(item) }}</template></td><td data-label="密码源">{{ providerName(item) }}</td><td data-label="更新时间">{{ new Date(item.updatedAt).toLocaleString() }}</td><td class="action-cell"><m3e-icon-button v-if="isEditableVaultItem(item)" :aria-label="`编辑${itemKindLabel(item.kind)}`" @click="openVaultEdit(item)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button :aria-label="`删除${itemKindLabel(item.kind)}`" @click="removeVaultItem(item)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></td></tr>
            </tbody></table></div>
            <div v-else class="empty-state" slot="content"><m3e-icon :name="activeSection === 'wallet' ? 'wallet' : activeSection === 'notes' ? 'note_stack' : activeSection === 'totp' ? 'timer' : 'key_vertical'"></m3e-icon><h2>{{ query ? '没有匹配项目' : `还没有${sectionTitle(activeSection)}` }}</h2><p>{{ query ? '换一个关键词试试。' : '从密码源同步，或使用右上角的添加操作。' }}</p></div>
          </m3e-card>
        </section>

        <section v-else-if="activeSection === 'providers'" class="provider-page">
          <div class="provider-connect-grid" aria-label="添加密码源">
            <m3e-card variant="filled" class="motion-card connect-source-card"><button class="connect-source" type="button" @click="newWebDav"><span class="connect-icon"><m3e-icon name="folder_copy"></m3e-icon></span><span><strong>连接 Monica Android WebDAV</strong><small>读取并无损写回 Monica_Backups 快照</small></span><m3e-icon class="connect-arrow" name="arrow_forward"></m3e-icon></button></m3e-card>
            <m3e-card variant="filled" class="motion-card connect-source-card"><button class="connect-source" type="button" @click="openBitwarden()"><span class="connect-icon"><m3e-icon name="shield"></m3e-icon></span><span><strong>连接 Bitwarden</strong><small>官方 US/EU 或标准自托管服务</small></span><m3e-icon class="connect-arrow" name="arrow_forward"></m3e-icon></button></m3e-card>
          </div>

          <div class="provider-list" aria-label="已连接的密码源">
            <m3e-card v-for="provider in webDavProviders" :key="provider.id" variant="filled" class="motion-card source-card"><div slot="content" class="stack">
              <div class="source-title"><span class="source-icon"><m3e-icon name="folder_copy"></m3e-icon></span><div><h2>{{ provider.name }}</h2><p>{{ String(provider.config.baseUrl || '') }}</p></div></div>
              <span class="state" :class="provider.lastError || conflictsFor(provider.id).length ? 'state-attention' : 'state-healthy'">{{ conflictsFor(provider.id).length ? `${conflictsFor(provider.id).length} 个冲突` : provider.lastError ? '需要处理' : provider.lastSyncAt ? '已同步' : '已连接' }}</span>
              <p v-if="provider.lastError" class="form-error">{{ provider.lastError }}</p>
              <p v-if="queueFor(provider.id)" class="supporting">同步队列：{{ queueFor(provider.id)?.pending }} 项<span v-if="queueFor(provider.id)?.failed"> · {{ queueFor(provider.id)?.failed }} 项失败 · 已尝试 {{ queueFor(provider.id)?.maxAttempts }}/5 次</span></p>
              <div v-for="conflict in conflictsFor(provider.id)" :key="conflict.id" class="provider-conflict"><strong>{{ conflictTitle(conflict) }}</strong><p>{{ conflict.reason }}</p><small>检测于 {{ new Date(conflict.detectedAt).toLocaleString() }}；敏感字段不在此处显示。</small><div v-if="conflict.local || conflict.remote" class="conflict-actions"><m3e-button v-if="conflict.local" variant="tonal" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'keep-local')">保留浏览器版本</m3e-button><m3e-button variant="text" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'use-remote')">{{ conflict.remote ? '采用 Android 版本' : '接受远端删除' }}</m3e-button></div></div>
              <p class="supporting">{{ provider.lastSyncAt ? `上次同步：${new Date(provider.lastSyncAt).toLocaleString()}` : '尚未同步；首次同步会导入最新 Android 快照。' }}</p>
              <div class="source-actions"><m3e-button v-if="activeSyncProviderId === provider.id" variant="text" @click="cancelProviderSync(provider)"><m3e-icon slot="icon" name="cancel"></m3e-icon>取消同步</m3e-button><m3e-button v-else variant="tonal" :disabled="Boolean(webDavBusy)" @click="syncProvider(provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ queueFor(provider.id)?.failed ? '重试同步' : '立即同步' }}</m3e-button><m3e-icon-button aria-label="编辑 WebDAV" @click="editWebDav(provider)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="移除 WebDAV" @click="removeProvider(provider)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></div>
            </div></m3e-card>
            <m3e-card v-for="provider in bitwardenProviders" :key="provider.id" variant="filled" class="motion-card source-card"><div slot="content" class="stack">
              <div class="source-title"><span class="source-icon"><m3e-icon name="shield"></m3e-icon></span><div><h2>{{ provider.name }}</h2><p>{{ String(provider.config.email || '') }}</p></div></div>
              <span class="state" :class="provider.lastError || conflictsFor(provider.id).length ? 'state-attention' : 'state-healthy'">{{ conflictsFor(provider.id).length ? `${conflictsFor(provider.id).length} 个冲突` : provider.lastError ? '需要处理' : provider.lastSyncAt ? '已同步' : '已连接' }}</span>
              <p v-if="provider.lastError" class="form-error">{{ provider.lastError }}</p>
              <p v-if="queueFor(provider.id)" class="supporting">同步队列：{{ queueFor(provider.id)?.pending }} 项<span v-if="queueFor(provider.id)?.failed"> · {{ queueFor(provider.id)?.failed }} 项失败 · 已尝试 {{ queueFor(provider.id)?.maxAttempts }}/5 次</span></p>
              <div v-for="conflict in conflictsFor(provider.id)" :key="conflict.id" class="provider-conflict"><strong>{{ conflictTitle(conflict) }}</strong><p>{{ conflict.reason }}</p><small>检测于 {{ new Date(conflict.detectedAt).toLocaleString() }}；敏感字段不在此处显示。</small><div v-if="conflict.local || conflict.remote" class="conflict-actions"><m3e-button v-if="conflict.local" variant="tonal" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'keep-local')">保留浏览器版本</m3e-button><m3e-button variant="text" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'use-remote')">{{ conflict.remote ? '采用 Bitwarden 版本' : '接受远端删除' }}</m3e-button></div></div>
              <p class="supporting">{{ provider.lastSyncAt ? `上次同步：${new Date(provider.lastSyncAt).toLocaleString()}` : String(provider.config.vaultUrl || 'Bitwarden') }}</p>
              <div class="source-actions"><m3e-button v-if="activeSyncProviderId === provider.id" variant="text" @click="cancelProviderSync(provider)"><m3e-icon slot="icon" name="cancel"></m3e-icon>取消同步</m3e-button><m3e-button v-else variant="tonal" :disabled="Boolean(webDavBusy)" @click="syncProvider(provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ queueFor(provider.id)?.failed ? '重试同步' : '立即同步' }}</m3e-button><m3e-icon-button aria-label="重新登录 Bitwarden" @click="openBitwarden(provider)"><m3e-icon name="login"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="移除 Bitwarden" @click="removeProvider(provider)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></div>
            </div></m3e-card>
            <m3e-card variant="filled" class="motion-card source-card"><div slot="content" class="stack"><div class="source-title"><span class="source-icon"><m3e-icon name="database"></m3e-icon></span><div><h2>Monica 本地库</h2><p>加密 IndexedDB 信封</p></div></div><p class="supporting">{{ externalProviders.length ? '可与外部密码源并存。' : '当前唯一的密码源。' }}</p><span class="state state-healthy">已连接</span><div class="source-actions"><m3e-button variant="tonal" :disabled="diagnosticBusy" @click="exportProviderDiagnostics"><m3e-icon slot="icon" name="download"></m3e-icon>{{ diagnosticBusy ? '正在导出…' : '导出脱敏诊断' }}</m3e-button></div></div></m3e-card>
          </div>
        </section>

        <section v-else class="settings-grid">
          <AppearancePanel class="motion-card" />
          <m3e-card variant="filled" class="motion-card"><div slot="content" class="stack">
            <h2>加密整库备份</h2>
            <p class="supporting">包含项目、密码源和设置，仍由主密码加密；恢复后将使用备份原来的主密码。</p>
            <m3e-button variant="tonal" :disabled="Boolean(securityBusy)" @click="exportEncryptedVault"><m3e-icon slot="icon" name="encrypted"></m3e-icon>{{ securityBusy === 'export' ? '正在导出…' : '导出加密整库备份' }}</m3e-button>
            <label class="file-action"><m3e-icon name="upload"></m3e-icon><span>选择加密整库备份</span><input type="file" accept="application/json,.json" @change="selectEncryptedBackup" /></label>
            <template v-if="selectedEncryptedBackup">
              <p class="supporting">已选择：{{ selectedEncryptedBackupName }}</p>
              <label class="field"><span>备份主密码</span><input v-model="restoreForm.backupPassword" type="password" autocomplete="current-password" /></label>
              <label class="field"><span>恢复前的当前主密码</span><input v-model="restoreForm.currentPassword" type="password" autocomplete="current-password" /></label>
              <m3e-button variant="filled" :disabled="Boolean(securityBusy)" @click="restoreEncryptedVault">{{ securityBusy === 'restore' ? '正在验证并恢复…' : '验证并替换当前密码库' }}</m3e-button>
            </template>
          </div></m3e-card>
          <m3e-card variant="filled" class="motion-card"><div slot="content" class="stack">
            <h2>更改保护方式</h2>
            <p class="supporting">新主密码留空时改用本机设备密钥；设置主密码时使用新的 Argon2id 盐重新加密。</p>
            <label class="field"><span>当前主密码（设备密钥模式留空）</span><input v-model="passwordChange.currentPassword" type="password" autocomplete="current-password" /></label>
            <label class="field"><span>新主密码（可选）</span><input v-model="passwordChange.newPassword" type="password" :minlength="passwordChange.newPassword ? MIN_MASTER_PASSWORD_LENGTH : undefined" autocomplete="new-password" /></label>
            <label class="field"><span>确认新主密码</span><input v-model="passwordChange.confirmation" type="password" :minlength="passwordChange.confirmation ? MIN_MASTER_PASSWORD_LENGTH : undefined" autocomplete="new-password" /></label>
            <m3e-button variant="filled" :disabled="Boolean(securityBusy)" @click="changeMasterPassword">{{ securityBusy === 'password' ? '正在重新加密…' : '更改主密码' }}</m3e-button>
          </div></m3e-card>
          <m3e-card variant="filled" class="motion-card"><div slot="content" class="stack"><h2>明文手动迁移</h2><p class="supporting">仅导出项目，不包含密码源；文件是明文，请只保存到可信位置。</p><m3e-button variant="tonal" @click="exportVault"><m3e-icon slot="icon" name="download"></m3e-icon>导出明文 JSON</m3e-button><label class="file-action"><m3e-icon name="upload"></m3e-icon><span>导入明文 JSON</span><input type="file" accept="application/json,.json" @change="importVault" /></label></div></m3e-card>
          <m3e-card variant="filled" class="motion-card"><div slot="content" class="stack"><h2>安全边界</h2><div class="boundary-row"><m3e-icon name="encrypted"></m3e-icon><span>持久数据使用 AES-256-GCM 加密</span></div><div class="boundary-row"><m3e-icon name="timer"></m3e-icon><span>解锁密钥仅保留在浏览器会话存储</span></div><div class="boundary-row"><m3e-icon name="visibility_off"></m3e-icon><span>内容脚本无法读取完整密码库</span></div></div></m3e-card>
          <p v-if="securityError" class="form-error settings-message" role="alert">{{ securityError }}</p>
        </section>
      </main>
    </div>

    <VaultItemEditor v-if="vaultEditorOpen" :item="vaultEditorItem" :initial-kind="vaultEditorKind" :providers="providers" @cancel="vaultEditorOpen = false" @save="saveVaultItem" />

    <div v-if="webDavDialogOpen" class="modal-backdrop" role="presentation" @mousedown.self="closeWebDavDialog"><section class="editor-dialog provider-dialog" role="dialog" aria-modal="true" aria-labelledby="webdav-dialog-title"><header><div><h2 id="webdav-dialog-title">{{ editingWebDavId ? '编辑 WebDAV' : '连接 Monica Android WebDAV' }}</h2><p>读取并无损写回 Android 的 Monica_Backups 快照。</p></div><m3e-icon-button aria-label="关闭 WebDAV 设置" @click="closeWebDavDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header>
      <form class="provider-form" @submit.prevent="saveWebDav">
        <label class="field"><span>显示名称</span><input v-model="webDavForm.name" autocomplete="off" placeholder="Monica Android WebDAV" /></label>
        <label class="field field-wide"><span>WebDAV 地址 *</span><input v-model="webDavForm.baseUrl" type="url" autocomplete="url" placeholder="https://cloud.example.com/remote.php/dav/files/user" required /><small>可以填写服务器根路径，也可以直接填写 Monica_Backups 路径。</small></label>
        <label class="field"><span>用户名</span><input v-model="webDavForm.username" autocomplete="username" /></label>
        <label class="field"><span>WebDAV 密码</span><input v-model="webDavForm.password" type="password" autocomplete="current-password" :placeholder="webDavForm.passwordConfigured ? '已加密保存；留空保持不变' : ''" /></label>
        <label class="field field-wide"><span>Android 备份加密密码（可选）</span><input v-model="webDavForm.backupPassword" type="password" autocomplete="new-password" :placeholder="webDavForm.backupPasswordConfigured ? '已加密保存；留空保持不变' : '留空使用普通 ZIP'" /><small>留空时读写普通 ZIP；填写任意长度密码后，后续快照使用 MONICA_ENC_V1。导入加密快照时需要填写对应密码。</small></label>
        <label class="favorite-row field-wide"><input v-model="webDavForm.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
        <p v-if="webDavError" class="form-error field-wide" role="alert">{{ webDavError }}</p>
        <footer class="provider-actions field-wide"><m3e-button variant="text" type="button" @click="closeWebDavDialog">取消</m3e-button><m3e-button variant="tonal" type="button" :disabled="Boolean(webDavBusy)" @click="testWebDav">{{ webDavBusy === 'test' ? '测试中…' : '测试连接' }}</m3e-button><m3e-button variant="filled" type="submit" :disabled="Boolean(webDavBusy)">{{ webDavBusy === 'save' ? '保存中…' : '加密保存' }}</m3e-button></footer>
      </form>
    </section></div>

    <div v-if="editorOpen" class="modal-backdrop" role="presentation" @mousedown.self="editorOpen = false"><section class="editor-dialog login-item-dialog" role="dialog" aria-modal="true" :aria-labelledby="editingId ? 'editor-title-edit' : 'editor-title-new'"><header><div><h2 :id="editingId ? 'editor-title-edit' : 'editor-title-new'">{{ editingId ? '编辑登录项' : '添加登录项' }}</h2><p>空用户名、空密码和无网址项目均可保存。</p></div><m3e-icon-button aria-label="关闭" @click="editorOpen = false"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header><form class="editor-form login-item-form" @submit.prevent="submitCredential">
      <label class="field"><span>名称 *</span><input v-model="form.name" autofocus autocomplete="off" placeholder="例如：GitHub 工作账号" /></label>
      <fieldset class="login-type-picker field-wide"><legend>登录类型</legend><div class="login-type-segments"><label><input v-model="form.loginType" type="radio" value="PASSWORD" /><span>密码</span></label><label><input v-model="form.loginType" type="radio" value="SSO" /><span>SSO</span></label><label><input v-model="form.loginType" type="radio" value="WIFI" /><span>Wi-Fi</span></label><label><input v-model="form.loginType" type="radio" value="SSH_KEY" /><span>SSH 密钥</span></label><label><input v-model="form.loginType" type="radio" value="BARCODE" /><span>条码</span></label></div></fieldset>
      <label v-if="form.loginType !== 'SSH_KEY' && form.loginType !== 'BARCODE'" class="field"><span>{{ form.loginType === 'WIFI' ? '企业身份（Identity）' : '用户名' }}</span><input v-model="form.username" autocomplete="username" :placeholder="form.loginType === 'WIFI' ? '企业网络可选' : 'name@example.com'" /></label>
      <label v-if="form.loginType === 'WIFI'" class="field"><span>Wi-Fi 密码</span><div class="password-field"><input v-model="form.wifiPassword" :type="revealPassword ? 'text' : 'password'" autocomplete="off" /><button type="button" @click="revealPassword = !revealPassword">{{ revealPassword ? '隐藏' : '显示' }}</button></div></label>
      <label v-else-if="form.loginType !== 'SSH_KEY' && form.loginType !== 'BARCODE'" class="field"><span>密码</span><div class="password-field"><input v-model="form.password" :type="revealPassword ? 'text' : 'password'" autocomplete="new-password" /><button type="button" @click="revealPassword = !revealPassword">{{ revealPassword ? '隐藏' : '显示' }}</button></div></label>
      <template v-if="form.loginType === 'SSO'"><label class="field"><span>SSO 提供商</span><input v-model="form.ssoProvider" autocomplete="off" placeholder="GOOGLE" /></label><label class="field"><span>引用条目 ID</span><input v-model="form.ssoRefEntryId" inputmode="numeric" placeholder="可选" /></label></template>
      <template v-if="form.loginType === 'WIFI'">
        <fieldset class="editor-fieldset special-record-fields field-wide"><legend>Wi-Fi 配置</legend>
          <label class="field"><span>SSID</span><input v-model="form.wifi.ssid" autocomplete="off" /></label>
          <label class="field"><span>安全类型</span><select v-model="form.wifi.security"><option value="NONE">开放网络</option><option value="WEP">WEP</option><option value="WPA_WPA2">WPA/WPA2</option><option value="WPA2_WPA3">WPA2/WPA3</option><option value="WPA3">WPA3</option><option value="WPA2_ENTERPRISE">WPA2 企业</option><option value="WPA3_ENTERPRISE">WPA3 企业</option></select></label>
          <label class="field"><span>BSSID</span><input v-model="form.wifi.bssid" autocomplete="off" placeholder="可选" /></label>
          <label class="favorite-row"><input v-model="form.wifi.hiddenNetwork" type="checkbox" /><span>隐藏网络</span></label>
          <details class="special-advanced field-wide"><summary>Android 原始元数据</summary><label class="field"><span>JSON</span><textarea v-model="form.wifiMetadataRaw" rows="6" spellcheck="false"></textarea><small>代理、静态 IP、EAP 和未来字段保留在此对象中；应用后同步到上方已知字段。</small></label><m3e-button variant="tonal" type="button" @click="applySpecialRaw">应用原始元数据</m3e-button></details>
        </fieldset>
      </template>
      <template v-else-if="form.loginType === 'SSH_KEY'">
        <fieldset class="editor-fieldset special-record-fields field-wide"><legend>SSH 密钥</legend>
          <label class="field"><span>算法</span><input v-model="form.sshKey.algorithm" list="ssh-algorithms" autocomplete="off" /><datalist id="ssh-algorithms"><option value="ED25519"></option><option value="RSA"></option></datalist></label>
          <label class="field"><span>密钥位数</span><input v-model.number="form.sshKey.keySize" type="number" min="0" step="1" inputmode="numeric" /></label>
          <label class="field field-wide"><span>OpenSSH 公钥</span><textarea v-model="form.sshKey.publicKeyOpenSsh" rows="3" spellcheck="false"></textarea></label>
          <label class="field field-wide"><span>OpenSSH 私钥</span><textarea v-model="form.sshKey.privateKeyOpenSsh" rows="7" spellcheck="false"></textarea></label>
          <label class="field"><span>SHA-256 指纹</span><input v-model="form.sshKey.fingerprintSha256" autocomplete="off" /></label>
          <label class="field"><span>注释</span><input v-model="form.sshKey.comment" autocomplete="off" /></label>
          <label class="field"><span>格式</span><input v-model="form.sshKey.format" autocomplete="off" /></label>
          <details class="special-advanced field-wide"><summary>Android 原始元数据</summary><label class="field"><span>JSON</span><textarea v-model="form.sshKeyDataRaw" rows="6" spellcheck="false"></textarea><small>未知字段逐项保留；应用后同步到上方已知字段。</small></label><m3e-button variant="tonal" type="button" @click="applySpecialRaw">应用原始元数据</m3e-button></details>
        </fieldset>
      </template>
      <label v-else-if="form.loginType === 'BARCODE'" class="field field-wide"><span>条码内容</span><input v-model="form.barcodeContent" autocomplete="off" spellcheck="false" /><small>按 Monica Android 格式保存到密码字段。</small></label>
      <fieldset v-if="isSpecialLoginType" class="editor-fieldset special-transfer field-wide"><legend>复制与二维码</legend><div class="special-transfer-actions"><m3e-button variant="tonal" type="button" @click="copySpecialPayload"><m3e-icon slot="icon" name="content_copy"></m3e-icon>复制</m3e-button><m3e-button variant="text" type="button" @click="refreshSpecialQr"><m3e-icon slot="icon" name="qr_code_2"></m3e-icon>生成二维码</m3e-button></div><img v-if="specialQrDataUrl" :src="specialQrDataUrl" :alt="`${form.loginType} 二维码`" width="240" height="240" /><p v-if="specialQrError" class="form-error" role="alert">{{ specialQrError }}</p></fieldset>
      <template v-if="isWebLoginType">
        <label class="field"><span>绑定独立验证器</span><select v-model="form.boundTotpItemId"><option value="">不绑定独立项目</option><option v-for="item in totpItems" :key="item.id" :value="item.id">{{ item.title }} · {{ item.otpType || 'TOTP' }}</option></select></label>
        <label class="field"><span>内嵌验证码密钥</span><input v-model="form.totpSecret" :disabled="Boolean(form.boundTotpItemId)" autocomplete="off" placeholder="Base32 或 otpauth URI" /><small>独立验证器优先；验证码仅在点击填充时由后台生成。</small></label>
        <fieldset class="editor-fieldset field-wide"><legend>匹配网站（可选）</legend><div class="uri-rule-list"><div v-for="(rule, index) in form.uriRules" :key="index" class="uri-rule-row"><select v-model="rule.matchType" :aria-label="`网址 ${index + 1} 匹配方式`"><option v-for="type in (['base-domain','domain','starts-with','exact','regex','never'] as LoginUriMatchType[])" :key="type" :value="type">{{ uriMatchTypeLabel(type) }}</option></select><input v-model="rule.uri" :aria-label="`网址 ${index + 1}`" placeholder="https://accounts.example.com" /><m3e-icon-button type="button" :aria-label="`删除网址 ${index + 1}`" @click="removeUriRule(index)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></div></div><m3e-button variant="text" type="button" @click="addUriRule"><m3e-icon slot="icon" name="add"></m3e-icon>添加网址</m3e-button></fieldset>
      </template>
      <fieldset class="editor-fieldset field-wide"><legend>自定义字段</legend><div class="custom-field-list"><div v-for="(field, index) in form.customFields" :key="index" class="custom-field-row"><input v-model="field.name" :aria-label="`自定义字段 ${index + 1} 名称`" placeholder="字段名称" /><input v-model="field.value" :type="field.protected ? 'password' : 'text'" :aria-label="`自定义字段 ${index + 1} 值`" placeholder="字段值" /><label class="compact-check"><input v-model="field.protected" type="checkbox" /><span>隐藏</span></label><m3e-icon-button type="button" :aria-label="`删除自定义字段 ${index + 1}`" @click="removeCustomField(index)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></div></div><m3e-button variant="text" type="button" @click="addCustomField"><m3e-icon slot="icon" name="add"></m3e-icon>添加字段</m3e-button></fieldset>
      <label class="field field-wide"><span>备注</span><textarea v-model="form.notes" rows="3" placeholder="可选备注"></textarea></label>
      <label class="field field-wide"><span>保存到</span><select v-model="form.providerId" :disabled="Boolean(editingId)"><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select><small>{{ editingId ? '已有项目保留原密码源。' : '外部密码源项目会在下次同步时写入。' }}</small></label>
      <label class="favorite-row"><input v-model="form.favorite" type="checkbox" /><span>收藏并优先显示</span></label><label class="favorite-row"><input v-model="form.archived" type="checkbox" /><span>归档并停止自动填充</span></label><p v-if="formError" class="form-error field-wide" role="alert">{{ formError }}</p><footer class="field-wide"><m3e-button variant="text" type="button" @click="editorOpen = false">取消</m3e-button><m3e-button variant="filled" type="submit">加密保存</m3e-button></footer>
    </form></section></div>

    <div v-if="bitwardenDialogOpen" class="modal-backdrop" role="presentation" @mousedown.self="closeBitwardenDialog"><section class="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="bitwarden-dialog-title"><header><div><h2 id="bitwarden-dialog-title">{{ editingBitwardenId ? '重新登录 Bitwarden' : '连接 Bitwarden' }}</h2><p>主密码只用于本次登录和密钥派生，不会保存。</p></div><m3e-icon-button aria-label="关闭" @click="closeBitwardenDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header><form class="editor-form" @submit.prevent="connectBitwarden">
      <label class="field"><span>显示名称</span><input v-model="bitwardenForm.name" autocomplete="off" /></label>
      <label class="field"><span>服务器地址 *</span><input v-model="bitwardenForm.vaultUrl" type="url" list="bitwarden-server-list" autocomplete="url" required /><datalist id="bitwarden-server-list"><option value="https://vault.bitwarden.com">Bitwarden US</option><option value="https://vault.bitwarden.eu">Bitwarden EU</option></datalist><small>自托管请填写 Vault 根地址，例如 https://vault.example.com。</small></label>
      <label class="field"><span>邮箱 *</span><input v-model="bitwardenForm.email" type="email" autocomplete="username" required /></label>
      <label class="field"><span>主密码 *</span><input v-model="bitwardenForm.masterPassword" type="password" autocomplete="current-password" required /></label>
      <template v-if="bitwardenTwoFactorProviders.length"><label class="field"><span>两步验证方式</span><select v-model.number="bitwardenForm.twoFactorProvider"><option v-for="provider in bitwardenTwoFactorProviders" :key="provider" :value="provider">{{ twoFactorName(provider) }}</option></select></label><label class="field"><span>验证码 *</span><input v-model="bitwardenForm.twoFactorCode" autocomplete="one-time-code" required autofocus /></label><m3e-button v-if="bitwardenForm.twoFactorProvider === 1" variant="tonal" type="button" :disabled="bitwardenBusy" @click="sendBitwardenEmailCode">发送邮箱验证码</m3e-button><label class="favorite-row"><input v-model="bitwardenForm.rememberTwoFactor" type="checkbox" /><span>让 Bitwarden 记住此设备</span></label></template>
      <label class="favorite-row"><input v-model="bitwardenForm.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
      <p v-if="bitwardenError" class="form-error" role="alert">{{ bitwardenError }}</p>
      <div class="boundary-row"><m3e-icon name="verified_user"></m3e-icon><span>支持个人与组织共享 Cipher；缺失组织密钥的项目会保留本地缓存并给出提示。</span></div>
      <footer><m3e-button variant="text" type="button" @click="closeBitwardenDialog">取消</m3e-button><m3e-button variant="filled" type="submit" :disabled="bitwardenBusy">{{ bitwardenBusy ? '连接中…' : bitwardenTwoFactorProviders.length ? '验证并连接' : '登录并连接' }}</m3e-button></footer>
    </form></section></div>
  </m3e-theme>
</template>
