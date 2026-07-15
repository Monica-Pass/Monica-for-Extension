<script setup lang="ts">
import "@m3e/web/theme";
import "@m3e/web/app-bar";
import "@m3e/web/button";
import "@m3e/web/card";
import "@m3e/web/icon";
import "@m3e/web/icon-button";
import { computed, onMounted, reactive, ref } from "vue";
import AppearancePanel from "./components/AppearancePanel.vue";
import VaultItemEditor, { type EditableVaultKind } from "./components/VaultItemEditor.vue";
import { createLoginItem, isLoginItem, type LoginItem, type ProviderAccount, type VaultItem } from "./core/model";
import { activeScheme, themeColor, useThemePreferences } from "./lib/theme";
import { itemIcon, itemKindLabel, itemSafeSummary, itemSearchText, itemSection, type VaultManagerSection } from "./manager/item-metadata";
import { normalizeImportedVaultItem } from "./manager/import-items";
import type { MonicaWebDavConfig } from "./providers/webdav/monica-webdav-provider";
import { vaultClient } from "./runtime/client";
import type { EncryptedVaultBackup, VaultLifecycleStatus } from "./security/secure-vault-service";

type Section = "overview" | VaultManagerSection | "providers" | "settings";

const vaultItems = ref<VaultItem[]>([]);
const providers = ref<ProviderAccount[]>([]);
const providerQueues = ref<Array<{ providerId: string; pending: number; failed: number; maxAttempts: number; lastError?: string }>>([]);
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
const formError = ref("");
const notice = ref("");
const webDavBusy = ref<"" | "test" | "save" | "sync" | "remove">("");
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
const form = reactive({ name: "", username: "", password: "", urls: "", notes: "", favorite: false, providerId: "" });
const webDavForm = reactive({ name: "Monica Android WebDAV", baseUrl: "", username: "", password: "", backupPassword: "", isDefaultSaveTarget: false });
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
const passkeyItems = computed(() => vaultItems.value.filter((item) => itemSection(item) === "passkeys"));
const filteredSectionItems = computed(() => {
  if (activeSection.value !== "wallet" && activeSection.value !== "notes" && activeSection.value !== "passkeys") return [];
  const needle = query.value.trim().toLocaleLowerCase();
  return vaultItems.value.filter((item) => itemSection(item) === activeSection.value && (!needle || itemSearchText(item).toLocaleLowerCase().includes(needle)));
});
const webDavProviders = computed(() => providers.value.filter((provider) => provider.kind === "monica-webdav"));
const bitwardenProviders = computed(() => providers.value.filter((provider) => provider.kind === "bitwarden"));
const externalProviders = computed(() => providers.value.filter((provider) => provider.kind !== "local"));
const defaultProviderId = computed(() => providers.value.find((provider) => provider.isDefaultSaveTarget)?.id || providers.value.find((provider) => provider.kind === "local")?.id || "");

onMounted(initialize);

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
  if (auth.masterPassword.length < 10) {
    authError.value = "主密码至少需要 10 个字符。";
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
  if (!auth.masterPassword) {
    authError.value = "请输入主密码。";
    return;
  }
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
  [providers.value, providerQueues.value] = await Promise.all([vaultClient.listProviders(), vaultClient.providerQueueStatus()]);
}

function queueFor(providerId: string) {
  return providerQueues.value.find((queue) => queue.providerId === providerId);
}

function navigate(section: Section) {
  activeSection.value = section;
  mobileNavOpen.value = false;
  if (section === "providers") void refreshProviders();
}

function sectionTitle(section: Section): string {
  return ({ overview: "密码库概览", passwords: "登录项", wallet: "钱包与身份", notes: "笔记与验证码", passkeys: "Passkey", providers: "密码源", settings: "设置与备份" } as const)[section];
}

function sectionDescription(section: Section): string {
  return ({ overview: "扩展源码复用 WebUI，但运行时完全独立。", passwords: "登录密码只在解锁后显示和编辑。", wallet: "管理证件、账单地址、银行卡与支付账号。", notes: "管理安全笔记和 TOTP 动态验证码。", passkeys: "查看 Passkey 来源与使用状态；私钥始终保持隐藏。", providers: "连接 Monica Android WebDAV、Bitwarden 或使用本地库。", settings: "管理外观、导入导出与安全边界。" } as const)[section];
}

function providerName(item: VaultItem): string {
  const reference = item.providerRefs[0];
  return reference ? providers.value.find((provider) => provider.id === reference.providerId)?.name || "外部密码源" : "Monica 本地库";
}

async function removeVaultItem(item: VaultItem) {
  if (!window.confirm(`确定删除“${item.title}”吗？${item.providerRefs.length ? "此操作会进入同步删除队列。" : ""}`)) return;
  await vaultClient.deleteItem(item.id);
  await refreshItems();
  showNotice(`${itemKindLabel(item.kind)}已删除。`);
}

function openCreate() {
  editingId.value = null;
  Object.assign(form, { name: "", username: "", password: "", urls: "", notes: "", favorite: false, providerId: defaultProviderId.value });
  formError.value = "";
  revealPassword.value = false;
  editorOpen.value = true;
}

function openEdit(item: LoginItem) {
  editingId.value = item.id;
  Object.assign(form, { name: item.title, username: item.username, password: item.password, urls: item.uris.join("\n"), notes: item.notes, favorite: item.favorite, providerId: item.providerRefs[0]?.providerId || providers.value.find((provider) => provider.kind === "local")?.id || "" });
  formError.value = "";
  revealPassword.value = false;
  editorOpen.value = true;
}

function openVaultCreate(section: "wallet" | "notes") {
  vaultEditorItem.value = undefined;
  vaultEditorKind.value = section === "wallet" ? "card" : "secure-note";
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

function isEditableVaultItem(item: VaultItem): item is VaultItem & { kind: EditableVaultKind } {
  return item.kind === "card" || item.kind === "identity" || item.kind === "billing-address" || item.kind === "payment-account" || item.kind === "secure-note" || item.kind === "totp";
}

async function submitCredential() {
  if (!form.name.trim()) return void (formError.value = "请输入登录项名称。");
  if (!form.password) return void (formError.value = "请输入密码。");
  const uris = form.urls.split(/\r?\n|,/).map((url) => url.trim()).filter(Boolean);
  if (!uris.length) return void (formError.value = "至少填写一个用于匹配的网站域名或网址。");

  const existing = credentials.value.find((item) => item.id === editingId.value);
  const item: LoginItem = existing
    ? { ...existing, title: form.name.trim(), username: form.username.trim(), password: form.password, uris, notes: form.notes.trim(), favorite: form.favorite }
    : createLoginItem({
        title: form.name,
        username: form.username,
        password: form.password,
        uris,
        notes: form.notes,
        favorite: form.favorite,
        providerRefs: providers.value.find((provider) => provider.id === form.providerId)?.kind === "local" || !form.providerId ? [] : [{ providerId: form.providerId }]
      });
  await vaultClient.upsertItem(item);
  await refreshItems();
  showNotice(existing ? "登录项已加密更新。" : "登录项已加密保存。");
  editorOpen.value = false;
}

async function removeCredential(item: LoginItem) {
  if (!window.confirm(`确定删除“${item.title}”吗？此操作会进入同步删除队列。`)) return;
  await vaultClient.deleteItem(item.id);
  await refreshItems();
  showNotice("登录项已删除。");
}

function newWebDav() {
  editingWebDavId.value = undefined;
  Object.assign(webDavForm, { name: "Monica Android WebDAV", baseUrl: "", username: "", password: "", backupPassword: "", isDefaultSaveTarget: false });
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
    password: typeof config.password === "string" ? config.password : "",
    backupPassword: typeof config.backupPassword === "string" ? config.backupPassword : "",
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
    await vaultClient.testWebDav(webDavConfig());
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
  if (!passwordChange.currentPassword) return void (securityError.value = "请输入当前主密码。");
  if (passwordChange.newPassword.length < 10) return void (securityError.value = "新主密码至少需要 10 个字符。");
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
      <img src="/monica-logo.png" alt="" /><h1>Monica</h1><p>正在检查加密密码库…</p>
    </div>

    <form v-else-if="lifecycle !== 'unlocked'" class="login vault-auth" @submit.prevent="lifecycle === 'uninitialized' ? setupVault() : unlockVault()">
      <div class="brand"><img src="/monica-logo.png" alt="" /><span>Monica<small>浏览器插件</small></span></div>
      <m3e-card variant="outlined" class="login-card">
        <div slot="content" class="stack">
          <div><h1>{{ lifecycle === 'uninitialized' ? '创建加密密码库' : '解锁 Monica' }}</h1><p class="supporting">{{ lifecycle === 'uninitialized' ? '主密码仅用于本机派生加密密钥，Monica 不会保存它。' : '输入主密码以解密本地缓存并连接密码源。' }}</p></div>
          <label class="field"><span>主密码</span><input v-model="auth.masterPassword" type="password" autocomplete="current-password" autofocus /></label>
          <label v-if="lifecycle === 'uninitialized'" class="field"><span>确认主密码</span><input v-model="auth.confirmation" type="password" autocomplete="new-password" /></label>
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
          <div class="security-note"><m3e-icon name="encrypted"></m3e-icon><span>AES-256-GCM · PBKDF2-SHA256 · 自动锁定</span></div>
        </div>
      </m3e-card>
    </form>

    <div v-else class="shell" :class="{ 'nav-open': mobileNavOpen }">
      <aside class="sidebar">
        <div class="brand sidebar-brand"><img src="/monica-logo.png" alt="" /><span>Monica<small>浏览器插件</small></span></div>
        <nav aria-label="主导航">
          <section>
            <p class="nav-title">密码库</p>
            <button class="nav-item" :class="{ selected: activeSection === 'overview' }" type="button" @click="navigate('overview')"><m3e-icon name="dashboard"></m3e-icon><span>概览</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'passwords' }" type="button" @click="navigate('passwords')"><m3e-icon name="password"></m3e-icon><span>登录项</span><span class="nav-count">{{ credentials.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'wallet' }" type="button" @click="navigate('wallet')"><m3e-icon name="wallet"></m3e-icon><span>钱包与身份</span><span class="nav-count">{{ walletItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'notes' }" type="button" @click="navigate('notes')"><m3e-icon name="note_stack"></m3e-icon><span>笔记与验证码</span><span class="nav-count">{{ noteItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'passkeys' }" type="button" @click="navigate('passkeys')"><m3e-icon name="key_vertical"></m3e-icon><span>Passkey</span><span class="nav-count">{{ passkeyItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'providers' }" type="button" @click="navigate('providers')"><m3e-icon name="cloud_sync"></m3e-icon><span>密码源</span></button>
          </section>
          <section>
            <p class="nav-title">插件</p>
            <button class="nav-item" :class="{ selected: activeSection === 'settings' }" type="button" @click="navigate('settings')"><m3e-icon name="settings"></m3e-icon><span>设置与备份</span></button>
          </section>
        </nav>
        <div class="sidebar-footer">
          <div class="local-badge"><m3e-icon name="encrypted"></m3e-icon><span>密码库已加密并解锁</span></div>
          <m3e-button variant="tonal" @click="lockVault"><m3e-icon slot="icon" name="lock"></m3e-icon>立即锁定</m3e-button>
        </div>
      </aside>

      <main>
        <m3e-app-bar size="small" class="page-appbar">
          <m3e-icon-button slot="leading" class="mobile-menu" aria-label="打开导航" @click="mobileNavOpen = !mobileNavOpen"><m3e-icon name="menu"></m3e-icon></m3e-icon-button>
          <div slot="trailing" class="appbar-trailing"><label class="search"><m3e-icon name="search"></m3e-icon><input v-model="query" aria-label="搜索密码库" placeholder="搜索当前分类" /></label></div>
        </m3e-app-bar>

        <div class="page-heading">
          <div><h1>{{ sectionTitle(activeSection) }}</h1><p>{{ sectionDescription(activeSection) }}</p></div>
          <m3e-button v-if="activeSection === 'overview' || activeSection === 'passwords'" class="primary-action" variant="filled" @click="openCreate"><m3e-icon slot="icon" name="add"></m3e-icon>添加登录项</m3e-button>
          <m3e-button v-else-if="activeSection === 'wallet' || activeSection === 'notes'" class="primary-action" variant="filled" @click="openVaultCreate(activeSection)"><m3e-icon slot="icon" name="add"></m3e-icon>{{ activeSection === 'wallet' ? '添加钱包项目' : '添加笔记或验证码' }}</m3e-button>
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

        <section v-else-if="activeSection === 'wallet' || activeSection === 'notes' || activeSection === 'passkeys'" class="content-grid">
          <m3e-card variant="filled" class="data-card motion-card">
            <div slot="header" class="card-head"><h2>{{ sectionTitle(activeSection) }}</h2><p>{{ filteredSectionItems.length }} 个结果</p></div>
            <div v-if="filteredSectionItems.length" class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>安全摘要</th><th>密码源</th><th>更新时间</th><th><span class="visually-hidden">操作</span></th></tr></thead><tbody>
              <tr v-for="item in filteredSectionItems" :key="item.id"><td class="item-cell" data-label="名称"><div class="row-title"><span class="row-icon"><m3e-icon :name="item.favorite ? 'star' : itemIcon(item.kind)"></m3e-icon></span><div><strong>{{ item.title }}</strong><small>{{ item.kind === 'passkey' ? '私钥已隐藏' : '敏感字段已遮罩' }}</small></div></div></td><td data-label="类型"><span class="state state-local-only">{{ itemKindLabel(item.kind) }}</span></td><td data-label="安全摘要">{{ itemSafeSummary(item) }}</td><td data-label="密码源">{{ providerName(item) }}</td><td data-label="更新时间">{{ new Date(item.updatedAt).toLocaleString() }}</td><td class="action-cell"><m3e-icon-button v-if="isEditableVaultItem(item)" :aria-label="`编辑${itemKindLabel(item.kind)}`" @click="openVaultEdit(item)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button :aria-label="`删除${itemKindLabel(item.kind)}`" @click="removeVaultItem(item)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></td></tr>
            </tbody></table></div>
            <div v-else class="empty-state" slot="content"><m3e-icon :name="activeSection === 'wallet' ? 'wallet' : activeSection === 'notes' ? 'note_stack' : 'key_vertical'"></m3e-icon><h2>{{ query ? '没有匹配项目' : `还没有${sectionTitle(activeSection)}` }}</h2><p>{{ query ? '换一个关键词试试。' : '从密码源同步，或使用右上角的添加操作。' }}</p></div>
          </m3e-card>
        </section>

        <section v-else-if="activeSection === 'providers'" class="provider-page">
          <div class="provider-connect-grid" aria-label="添加密码源">
            <m3e-card variant="filled" class="motion-card connect-source-card"><button class="connect-source" type="button" @click="newWebDav"><span class="connect-icon"><m3e-icon name="folder_copy"></m3e-icon></span><span><strong>连接 Monica Android WebDAV</strong><small>读取并无损写回 Monica_Backups 快照</small></span><m3e-icon class="connect-arrow" name="arrow_forward"></m3e-icon></button></m3e-card>
            <m3e-card variant="filled" class="motion-card connect-source-card"><button class="connect-source" type="button" @click="openBitwarden()"><span class="connect-icon"><m3e-icon name="shield"></m3e-icon></span><span><strong>连接 Bitwarden</strong><small>官方 US/EU 或标准自托管服务</small></span><m3e-icon class="connect-arrow" name="arrow_forward"></m3e-icon></button></m3e-card>
          </div>

          <div class="provider-list" aria-label="已连接的密码源">
            <m3e-card v-for="provider in webDavProviders" :key="provider.id" variant="filled" class="motion-card source-card"><div slot="content" class="stack"><div class="source-title"><span class="source-icon"><m3e-icon name="folder_copy"></m3e-icon></span><div><h2>{{ provider.name }}</h2><p>{{ String(provider.config.baseUrl || '') }}</p></div></div><span class="state" :class="provider.lastError ? 'state-attention' : 'state-healthy'">{{ provider.lastError ? '需要处理' : provider.lastSyncAt ? '已同步' : '已连接' }}</span><p v-if="provider.lastError" class="form-error">{{ provider.lastError }}</p><p v-if="queueFor(provider.id)" class="supporting">同步队列：{{ queueFor(provider.id)?.pending }} 项<span v-if="queueFor(provider.id)?.failed"> · {{ queueFor(provider.id)?.failed }} 项失败 · 已尝试 {{ queueFor(provider.id)?.maxAttempts }}/5 次</span></p><p class="supporting">{{ provider.lastSyncAt ? `上次同步：${new Date(provider.lastSyncAt).toLocaleString()}` : '尚未同步；首次同步会导入最新 Android 快照。' }}</p><div class="source-actions"><m3e-button variant="tonal" :disabled="Boolean(webDavBusy)" @click="syncProvider(provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ webDavBusy === 'sync' ? '同步中…' : queueFor(provider.id)?.failed ? '重试同步' : '立即同步' }}</m3e-button><m3e-icon-button aria-label="编辑 WebDAV" @click="editWebDav(provider)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="移除 WebDAV" @click="removeProvider(provider)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></div></div></m3e-card>
            <m3e-card v-for="provider in bitwardenProviders" :key="provider.id" variant="filled" class="motion-card source-card"><div slot="content" class="stack"><div class="source-title"><span class="source-icon"><m3e-icon name="shield"></m3e-icon></span><div><h2>{{ provider.name }}</h2><p>{{ String(provider.config.email || '') }}</p></div></div><span class="state" :class="provider.lastError ? 'state-attention' : 'state-healthy'">{{ provider.lastError ? '需要处理' : provider.lastSyncAt ? '已同步' : '已连接' }}</span><p v-if="provider.lastError" class="form-error">{{ provider.lastError }}</p><p v-if="queueFor(provider.id)" class="supporting">同步队列：{{ queueFor(provider.id)?.pending }} 项<span v-if="queueFor(provider.id)?.failed"> · {{ queueFor(provider.id)?.failed }} 项失败 · 已尝试 {{ queueFor(provider.id)?.maxAttempts }}/5 次</span></p><p class="supporting">{{ provider.lastSyncAt ? `上次同步：${new Date(provider.lastSyncAt).toLocaleString()}` : String(provider.config.vaultUrl || 'Bitwarden') }}</p><div class="source-actions"><m3e-button variant="tonal" :disabled="Boolean(webDavBusy)" @click="syncProvider(provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ queueFor(provider.id)?.failed ? '重试同步' : '立即同步' }}</m3e-button><m3e-icon-button aria-label="重新登录 Bitwarden" @click="openBitwarden(provider)"><m3e-icon name="login"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="移除 Bitwarden" @click="removeProvider(provider)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></div></div></m3e-card>
            <m3e-card variant="filled" class="motion-card source-card"><div slot="content" class="stack"><div class="source-title"><span class="source-icon"><m3e-icon name="database"></m3e-icon></span><div><h2>Monica 本地库</h2><p>加密 IndexedDB 信封</p></div></div><p class="supporting">{{ externalProviders.length ? '可与外部密码源并存。' : '当前唯一的密码源。' }}</p><span class="state state-healthy">已连接</span></div></m3e-card>
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
            <h2>更改主密码</h2>
            <p class="supporting">验证当前主密码后，使用新盐重新加密完整密码库。</p>
            <label class="field"><span>当前主密码</span><input v-model="passwordChange.currentPassword" type="password" autocomplete="current-password" /></label>
            <label class="field"><span>新主密码</span><input v-model="passwordChange.newPassword" type="password" autocomplete="new-password" /></label>
            <label class="field"><span>确认新主密码</span><input v-model="passwordChange.confirmation" type="password" autocomplete="new-password" /></label>
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
        <label class="field"><span>WebDAV 密码</span><input v-model="webDavForm.password" type="password" autocomplete="current-password" /></label>
        <label class="field field-wide"><span>Android 备份加密密码</span><input v-model="webDavForm.backupPassword" type="password" autocomplete="off" /><small>仅用于 .enc.zip 的 MONICA_ENC_V1 解密；未加密备份请留空。</small></label>
        <label class="favorite-row field-wide"><input v-model="webDavForm.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
        <p v-if="webDavError" class="form-error field-wide" role="alert">{{ webDavError }}</p>
        <footer class="provider-actions field-wide"><m3e-button variant="text" type="button" @click="closeWebDavDialog">取消</m3e-button><m3e-button variant="tonal" type="button" :disabled="Boolean(webDavBusy)" @click="testWebDav">{{ webDavBusy === 'test' ? '测试中…' : '测试连接' }}</m3e-button><m3e-button variant="filled" type="submit" :disabled="Boolean(webDavBusy)">{{ webDavBusy === 'save' ? '保存中…' : '加密保存' }}</m3e-button></footer>
      </form>
    </section></div>

    <div v-if="editorOpen" class="modal-backdrop" role="presentation" @mousedown.self="editorOpen = false"><section class="editor-dialog" role="dialog" aria-modal="true" :aria-labelledby="editingId ? 'editor-title-edit' : 'editor-title-new'"><header><div><h2 :id="editingId ? 'editor-title-edit' : 'editor-title-new'">{{ editingId ? '编辑登录项' : '添加登录项' }}</h2><p>保存时整个密码库会重新加密。</p></div><m3e-icon-button aria-label="关闭" @click="editorOpen = false"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header><form class="editor-form" @submit.prevent="submitCredential">
      <label class="field"><span>名称 *</span><input v-model="form.name" autofocus autocomplete="off" placeholder="例如：GitHub 工作账号" /></label><label class="field"><span>用户名</span><input v-model="form.username" autocomplete="username" placeholder="name@example.com" /></label><label class="field"><span>密码 *</span><div class="password-field"><input v-model="form.password" :type="revealPassword ? 'text' : 'password'" autocomplete="new-password" /><button type="button" @click="revealPassword = !revealPassword">{{ revealPassword ? '隐藏' : '显示' }}</button></div></label><label class="field"><span>匹配网站 *</span><textarea v-model="form.urls" rows="3" placeholder="github.com&#10;https://accounts.example.com"></textarea><small>每行一个域名或网址；子域名会自动匹配。</small></label><label class="field"><span>备注</span><textarea v-model="form.notes" rows="3" placeholder="可选备注"></textarea></label><label class="field"><span>保存到</span><select v-model="form.providerId" :disabled="Boolean(editingId)"><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select><small>{{ editingId ? '已有项目保留原密码源；复制到其他源将在后续批量操作中提供。' : '外部密码源项目会在下次同步时写入。' }}</small></label><label class="favorite-row"><input v-model="form.favorite" type="checkbox" /><span>收藏并优先显示</span></label><p v-if="formError" class="form-error" role="alert">{{ formError }}</p><footer><m3e-button variant="text" type="button" @click="editorOpen = false">取消</m3e-button><m3e-button variant="filled" type="submit">加密保存</m3e-button></footer>
    </form></section></div>

    <div v-if="bitwardenDialogOpen" class="modal-backdrop" role="presentation" @mousedown.self="closeBitwardenDialog"><section class="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="bitwarden-dialog-title"><header><div><h2 id="bitwarden-dialog-title">{{ editingBitwardenId ? '重新登录 Bitwarden' : '连接 Bitwarden' }}</h2><p>主密码只用于本次登录和密钥派生，不会保存。</p></div><m3e-icon-button aria-label="关闭" @click="closeBitwardenDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header><form class="editor-form" @submit.prevent="connectBitwarden">
      <label class="field"><span>显示名称</span><input v-model="bitwardenForm.name" autocomplete="off" /></label>
      <label class="field"><span>服务器地址 *</span><input v-model="bitwardenForm.vaultUrl" type="url" list="bitwarden-server-list" autocomplete="url" required /><datalist id="bitwarden-server-list"><option value="https://vault.bitwarden.com">Bitwarden US</option><option value="https://vault.bitwarden.eu">Bitwarden EU</option></datalist><small>自托管请填写 Vault 根地址，例如 https://vault.example.com。</small></label>
      <label class="field"><span>邮箱 *</span><input v-model="bitwardenForm.email" type="email" autocomplete="username" required /></label>
      <label class="field"><span>主密码 *</span><input v-model="bitwardenForm.masterPassword" type="password" autocomplete="current-password" required /></label>
      <template v-if="bitwardenTwoFactorProviders.length"><label class="field"><span>两步验证方式</span><select v-model.number="bitwardenForm.twoFactorProvider"><option v-for="provider in bitwardenTwoFactorProviders" :key="provider" :value="provider">{{ twoFactorName(provider) }}</option></select></label><label class="field"><span>验证码 *</span><input v-model="bitwardenForm.twoFactorCode" autocomplete="one-time-code" required autofocus /></label><m3e-button v-if="bitwardenForm.twoFactorProvider === 1" variant="tonal" type="button" :disabled="bitwardenBusy" @click="sendBitwardenEmailCode">发送邮箱验证码</m3e-button><label class="favorite-row"><input v-model="bitwardenForm.rememberTwoFactor" type="checkbox" /><span>让 Bitwarden 记住此设备</span></label></template>
      <label class="favorite-row"><input v-model="bitwardenForm.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
      <p v-if="bitwardenError" class="form-error" role="alert">{{ bitwardenError }}</p>
      <div class="boundary-row warning"><m3e-icon name="info"></m3e-icon><span>本阶段支持个人 Cipher；组织共享 Cipher 会跳过并在同步结果中提示。</span></div>
      <footer><m3e-button variant="text" type="button" @click="closeBitwardenDialog">取消</m3e-button><m3e-button variant="filled" type="submit" :disabled="bitwardenBusy">{{ bitwardenBusy ? '连接中…' : bitwardenTwoFactorProviders.length ? '验证并连接' : '登录并连接' }}</m3e-button></footer>
    </form></section></div>
  </m3e-theme>
</template>
