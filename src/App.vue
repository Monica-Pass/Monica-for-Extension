<script setup lang="ts">
import "@m3e/web/theme";
import "@m3e/web/app-bar";
import "@m3e/web/button";
import "@m3e/web/card";
import "@m3e/web/icon";
import "@m3e/web/icon-button";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import AppearancePanel from "./components/AppearancePanel.vue";
import AutofillSitePolicyDialog from "./components/AutofillSitePolicyDialog.vue";
import BitwardenCollectionsDialog from "./components/BitwardenCollectionsDialog.vue";
import BitwardenFoldersDialog from "./components/BitwardenFoldersDialog.vue";
import BitwardenProviderCard from "./components/BitwardenProviderCard.vue";
import BitwardenSendsPanel from "./components/BitwardenSendsPanel.vue";
import GeneratorPanel from "./components/GeneratorPanel.vue";
import KeePassGroupsDialog from "./components/KeePassGroupsDialog.vue";
import KeePassHistoryDialog from "./components/KeePassHistoryDialog.vue";
import Mdbx2BatchTransferDialog from "./components/Mdbx2BatchTransferDialog.vue";
import Mdbx2SourceDialog from "./components/Mdbx2SourceDialog.vue";
import ProviderAttachmentsDialog from "./components/ProviderAttachmentsDialog.vue";
import M3eConfirmationDialog from "./components/ProviderConfirmationDialog.vue";
import SteamNetworkActions from "./components/SteamNetworkActions.vue";
import TotpCodeCell from "./components/TotpCodeCell.vue";
import VaultItemDetail from "./components/VaultItemDetail.vue";
import VaultItemEditor, { type EditableVaultKind } from "./components/VaultItemEditor.vue";
import { normalizeHost } from "./core/matching";
import { createLoginItem, isLoginItem, type LoginItem, type LoginUriMatchType, type LoginUriRule, type ProviderAccount, type ProviderConflictResolution, type ProviderConflictSummary, type SecureCustomField, type TotpItem, type VaultItem } from "./core/model";
import { createQrDataUrl } from "./core/otp-qr";
import { createCode128DataUrl } from "./core/barcode";
import { buildWifiQrPayload, parseSshKeyMetadata, parseWifiMetadata, serializeSshKeyMetadata, serializeWifiMetadata, type SshKeyMetadata, type WifiMetadata } from "./core/special-login";
import { activeScheme, themeColor, useThemePreferences } from "./lib/theme";
import { itemIcon, itemKindLabel, itemSafeSummary, itemSearchText, itemSection, type VaultManagerSection } from "./manager/item-metadata";
import { normalizeImportedVaultItem } from "./manager/import-items";
import { parseCsvToVaultItems } from "./manager/csv-import";
import { projectSteamItem } from "./core/steam-item";
import { passkeyAvailability, passkeyAvailabilityLabel } from "./passkey/source-policy";
import { presentKeePassRemoteError, type KeePassRemoteErrorPresentation } from "./providers/keepass/keepass-remote-status";
import type { Mdbx2HostStatus, Mdbx2VaultRuntimeStatus } from "./providers/mdbx2/native-contract";
import type { MonicaWebDavConfig } from "./providers/webdav/monica-webdav-provider";
import type { AndroidTimelineEntrySummary } from "./providers/webdav/android-backup-codec";
import { ExtensionRuntimeError, vaultClient } from "./runtime/client";
import type { KeePassRemoteManagerStatus, KeePassSessionSummary, Mdbx2ManagerSyncStatus, VaultWindowsHelloStatus } from "./runtime/messages";
import { MIN_MASTER_PASSWORD_LENGTH } from "./security/master-password-policy";
import type { EncryptedVaultBackup, VaultLifecycleStatus } from "./security/secure-vault-service";

type Section = "overview" | VaultManagerSection | "steam" | "sends" | "archive" | "trash" | "timeline" | "generator" | "providers" | "settings";
type LoginType = NonNullable<LoginItem["loginType"]>;
type KeePassSourceMode = "local-file" | "webdav";

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

interface KeePassFormState {
  sourceMode: KeePassSourceMode;
  name: string;
  password: string;
  currentFileName: string;
  baseUrl: string;
  username: string;
  webDavPassword: string;
  remotePath: string;
  webDavPasswordConfigured: boolean;
  databaseCredentialStored: boolean;
  keyFileConfigured: boolean;
  isDefaultSaveTarget: boolean;
}

interface PendingConfirmationAction {
  kind: "bitwarden-empty-remote" | "provider-conflict" | "provider-remove" | "windows-hello-enroll" | "windows-hello-revoke";
  providerId?: string;
  conflictId?: string;
  resolution?: ProviderConflictResolution;
  title: string;
  message: string;
  context: string;
  confirmLabel: string;
  tone: "attention" | "danger";
}

const vaultItems = ref<VaultItem[]>([]);
const archivedItems = ref<VaultItem[]>([]);
const deletedItems = ref<VaultItem[]>([]);
const androidTimeline = ref<Array<AndroidTimelineEntrySummary & { providerName: string }>>([]);
const timelineBusy = ref(false);
const timelineError = ref("");
const providers = ref<ProviderAccount[]>([]);
const providerQueues = ref<Array<{ providerId: string; pending: number; failed: number; recovering?: number; maxAttempts: number; lastError?: string }>>([]);
const providerConflicts = ref<ProviderConflictSummary[]>([]);
const lifecycle = ref<VaultLifecycleStatus>("locked");
const activeSection = ref<Section>("overview");
const query = ref("");
type AndroidQuickFilter = "favorite" | "two-fa" | "notes" | "passkey" | "uncategorized" | "local-only" | "attachments";
const activeQuickFilters = ref<AndroidQuickFilter[]>([]);
const databaseSourceFilter = ref("all");
const folderFilter = ref("all");
const loading = ref(true);
const authBusy = ref(false);
const authError = ref("");
const mobileNavOpen = ref(false);
const filterDialogOpen = ref(false);
const editorOpen = ref(false);
const vaultEditorOpen = ref(false);
const vaultEditorItem = ref<VaultItem | undefined>();
const vaultEditorKind = ref<EditableVaultKind>("card");
const vaultDetailItem = ref<VaultItem | undefined>();
const editingId = ref<string | null>(null);
const revealPassword = ref(false);
const specialQrDataUrl = ref("");
const specialQrError = ref("");
const barcodeRenderMode = ref<"qr" | "code128">("qr");
const formError = ref("");
const notice = ref("");
const webDavBusy = ref<"" | "test" | "save" | "sync" | "remove" | "logout">("");
const activeSyncProviderId = ref("");
const syncingAllBitwarden = ref(false);
const diagnosticBusy = ref(false);
const webDavError = ref("");
const editingWebDavId = ref<string | undefined>();
const webDavDialogOpen = ref(false);
const bitwardenDialogOpen = ref(false);
const bitwardenBusy = ref(false);
const bitwardenError = ref("");
const editingBitwardenId = ref<string | undefined>();
const bitwardenTwoFactorProviders = ref<number[]>([]);
const bitwardenTwoFactorProviderData = ref<Record<string, unknown> | undefined>();
const bitwardenDeviceVerificationRequired = ref(false);
const bitwardenFoldersProvider = ref<ProviderAccount | undefined>();
const bitwardenCollectionsProvider = ref<ProviderAccount | undefined>();
const confirmationDialog = ref<PendingConfirmationAction | null>(null);
const confirmationBusy = ref(false);
const confirmationError = ref("");
const keePassDialogOpen = ref(false);
const keePassBusy = ref<"" | "test" | "open" | "export" | "lock" | "restore">("");
const activeKeePassProviderId = ref("");
const keePassError = ref("");
const keePassDialogNotice = ref("");
const editingKeePassId = ref<string | undefined>();
const keePassDatabaseFile = ref<File | null>(null);
const keePassKeyFile = ref<File | null>(null);
const keePassFileInput = ref<HTMLInputElement | null>(null);
const keePassKeyFileInput = ref<HTMLInputElement | null>(null);
const revealKeePassPassword = ref(false);
const keePassSessions = ref<Record<string, KeePassSessionSummary>>({});
const keePassRemoteStatuses = ref<Record<string, KeePassRemoteManagerStatus>>({});
const keePassCardErrors = ref<Record<string, { message: string; code?: string }>>({});
const keePassGroupsProvider = ref<ProviderAccount | undefined>();
const mdbx2DialogOpen = ref(false);
const mdbx2BatchTransferDialogOpen = ref(false);
const mdbx2BatchTransferTargetProviderId = ref<string | undefined>();
const mdbx2DialogMode = ref<"local" | "remote">("local");
const editingMdbx2Id = ref<string | undefined>();
const mdbx2HostStatus = ref<Mdbx2HostStatus | null>(null);
const mdbx2RuntimeStatuses = ref<Record<string, Mdbx2VaultRuntimeStatus>>({});
const mdbx2SyncStatuses = ref<Record<string, Mdbx2ManagerSyncStatus>>({});
const mdbx2Busy = ref<"" | "lock">("");
const activeMdbx2ProviderId = ref("");
const securityBusy = ref<"" | "password" | "export" | "restore">("");
const securityError = ref("");
const passwordChangeDialogOpen = ref(false);
const autofillSitePolicyDialogOpen = ref(false);
const autofillSitePolicy = ref<{ blockedHosts: string[]; saveBlockedHosts: string[] }>({ blockedHosts: [], saveBlockedHosts: [] });
const selectedEncryptedBackup = ref<EncryptedVaultBackup | null>(null);
const selectedEncryptedBackupName = ref("");
const exportBackupDialogOpen = ref(false);
const exportBackupError = ref("");
const attachmentDialogOpen = ref(false);
const attachmentDialogItem = ref<VaultItem | undefined>();
const attachmentDialogProviders = ref<ProviderAccount[]>([]);
const keePassHistoryItem = ref<VaultItem | undefined>();
const keePassHistoryProviders = ref<ProviderAccount[]>([]);
// protectionMode drives currentPassword validation when replacing the live vault.
// It is a best-effort UI hint persisted alongside the session; the runtime still
// authoritatively re-derives the envelope key, so a stale value can never weaken
// the actual cryptographic check.
const protectionMode = ref<"master-password" | "device-key" | "unknown">("unknown");
const windowsHelloStatus = ref<VaultWindowsHelloStatus | null>(null);
const windowsHelloBusy = ref<"" | "status" | "verify" | "enroll" | "revoke">("");
const windowsHelloError = ref("");
const windowsHelloProtectionMode = computed(() => {
  const runtimeMode = windowsHelloStatus.value?.protectionMode;
  return runtimeMode && runtimeMode !== "unknown" ? runtimeMode : protectionMode.value;
});

const auth = reactive({ masterPassword: "", confirmation: "" });
const passwordChange = reactive({ currentPassword: "", newPassword: "", confirmation: "" });
const restoreForm = reactive({ backupPassword: "", currentPassword: "" });
const exportBackupForm = reactive({ password: "", confirmation: "" });

const PROTECTION_MODE_STORAGE_KEY = "monica.ui.protectionMode.v1";
const MIN_BACKUP_PASSWORD_LENGTH = MIN_MASTER_PASSWORD_LENGTH;
const form = reactive<LoginForm>(emptyLoginForm());
const webDavForm = reactive({ name: "Monica Android WebDAV", baseUrl: "", username: "", password: "", backupPassword: "", passwordConfigured: false, backupPasswordConfigured: false, isDefaultSaveTarget: false });
const bitwardenForm = reactive({ name: "Bitwarden", vaultUrl: "https://vault.bitwarden.com", email: "", masterPassword: "", twoFactorCode: "", twoFactorProvider: 0, rememberTwoFactor: false, newDeviceOtp: "", ssoOrganizationIdentifier: "", isDefaultSaveTarget: false });
const keePassForm = reactive<KeePassFormState>({
  sourceMode: "local-file",
  name: "KeePass",
  password: "",
  currentFileName: "",
  baseUrl: "",
  username: "",
  webDavPassword: "",
  remotePath: "",
  webDavPasswordConfigured: false,
  databaseCredentialStored: false,
  keyFileConfigured: false,
  isDefaultSaveTarget: false
});

useThemePreferences();

const credentials = computed(() => vaultItems.value.filter(isLoginItem));
const filteredCredentials = computed(() => credentials.value.filter(matchesManagerFilters));
const uniqueHosts = computed(() => new Set(credentials.value.flatMap((item) => item.uris)).size);
const favoriteCount = computed(() => vaultItems.value.filter((item) => item.favorite).length);
const walletItems = computed(() => vaultItems.value.filter((item) => itemSection(item) === "wallet"));
const noteItems = computed(() => vaultItems.value.filter((item) => itemSection(item) === "notes"));
const totpItems = computed(() => vaultItems.value.filter((item) => itemSection(item) === "totp"));
const steamItems = computed(() => vaultItems.value.flatMap((item) => {
  const projected = item.kind === "login" ? projectSteamItem(item) : undefined;
  return projected ? [projected] : item.kind === "totp" && item.otpType === "STEAM" ? [item] : [];
}));
const passkeyItems = computed(() => vaultItems.value.filter((item) => itemSection(item) === "passkeys"));
const databaseFolders = computed(() => {
  const categories = new Map<string, { key: string; label: string }>();
  for (const item of vaultItems.value) {
    const label = item.categoryName?.trim();
    if (!label) continue;
    const key = item.categoryId === undefined ? `name:${label}` : `id:${item.categoryId}`;
    categories.set(key, { key, label });
  }
  return [...categories.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
});
const databaseSources = computed(() => providers.value.filter((provider) => provider.kind !== "local"));
const filterableSection = computed(() => ["passwords", "wallet", "notes", "totp", "steam", "passkeys", "archive", "trash"].includes(activeSection.value));
const filteredSteamItems = computed(() => steamItems.value.filter(matchesManagerFilters));
const archivedCredentials = computed(() => archivedItems.value.filter(isLoginItem));
const credentialById = computed(() => new Map([...credentials.value, ...archivedCredentials.value].map((item) => [item.id, item])));
const filteredArchiveItems = computed(() => filterManagerItems(archivedItems.value));
const filteredDeletedItems = computed(() => filterManagerItems(deletedItems.value));
const filteredSectionItems = computed(() => {
  if (activeSection.value !== "wallet" && activeSection.value !== "notes" && activeSection.value !== "totp" && activeSection.value !== "passkeys") return [];
  const needle = query.value.trim().toLocaleLowerCase();
  return vaultItems.value.filter((item) => itemSection(item) === activeSection.value && matchesManagerFilters(item));
});
const webDavProviders = computed(() => providers.value.filter((provider) => provider.kind === "monica-webdav"));
const bitwardenProviders = computed(() => providers.value.filter((provider) => provider.kind === "bitwarden"));
const syncableBitwardenProviders = computed(() => bitwardenProviders.value.filter((provider) => provider.enabled && provider.config.authenticated === true));
const keePassProviders = computed(() => providers.value.filter((provider) => provider.kind === "keepass"));
const editingKeePassProvider = computed(() => providers.value.find((provider) => provider.id === editingKeePassId.value && provider.kind === "keepass"));
const mdbx2Providers = computed(() => providers.value.filter((provider) => provider.kind === "mdbx2"));
const editingMdbx2Provider = computed(() => providers.value.find((provider) => provider.id === editingMdbx2Id.value && provider.kind === "mdbx2"));
const externalProviders = computed(() => providers.value.filter((provider) => provider.kind !== "local"));
const attachmentProviderById = computed(() => new Map(providers.value
  .filter((provider) => provider.kind === "keepass" || provider.kind === "mdbx2" || provider.kind === "bitwarden" || provider.kind === "monica-webdav")
  .map((provider) => [provider.id, provider])));
const keePassHistoryProviderById = computed(() => new Map(keePassProviders.value
  .filter((provider) => Boolean(keePassSessions.value[provider.id]))
  .map((provider) => [provider.id, provider])));
const defaultProviderId = computed(() => providers.value.find((provider) => provider.isDefaultSaveTarget)?.id || providers.value.find((provider) => provider.kind === "local")?.id || "");
const isWebLoginType = computed(() => form.loginType === "PASSWORD" || form.loginType === "SSO");
const isSpecialLoginType = computed(() => form.loginType === "WIFI" || form.loginType === "SSH_KEY" || form.loginType === "BARCODE");
const nativeBitwardenSshEdit = computed(() => credentialById.value.get(editingId.value || "")?.bitwardenSshKeyMode === "native");
const sshBitwardenFormatHint = computed(() => {
  if (form.loginType !== "SSH_KEY") return "";
  const existing = credentialById.value.get(editingId.value || "");
  const providerId = existing?.providerRefs[0]?.providerId || form.providerId;
  if (providers.value.find((provider) => provider.id === providerId)?.kind !== "bitwarden") return "";
  if (existing?.bitwardenSshKeyMode === "native") return "Bitwarden 原生 SSH Cipher（Type 5）：公钥、私钥和指纹同步；算法按公钥识别，位数、注释、格式与未来 Android 元数据只保留在当前扩展的加密库。";
  return existing
    ? "Monica Android 兼容格式（Type 1 + 加密字段）：适用于官方 Bitwarden 与 Vaultwarden。"
    : "保存到 Bitwarden 时将使用 Monica Android 兼容格式（Type 1 + 加密字段）。";
});
const restoreCurrentPasswordHint = computed(() => protectionMode.value === "master-password" ? "替换主密码库时必须验证当前主密码。" : "设备密钥模式可留空；后台仍会重新派生密钥并拒绝无效输入。");
const keePassProtectionPreview = computed(() => {
  if (keePassKeyFile.value && keePassForm.password) return "密码 + 密钥文件";
  if (keePassKeyFile.value) return "仅密钥文件";
  if (keePassForm.password) return "仅密码";
  if (keePassForm.sourceMode === "webdav" && editingKeePassProvider.value) return keePassProtectionLabel(editingKeePassProvider.value);
  return "空密码";
});
const keePassDialogTitle = computed(() => editingKeePassId.value ? "管理 KeePass" : "连接 KeePass");

onMounted(initialize);

const hasOpenDialog = computed(() => editorOpen.value || vaultEditorOpen.value || Boolean(vaultDetailItem.value) || mdbx2DialogOpen.value || mdbx2BatchTransferDialogOpen.value || webDavDialogOpen.value || bitwardenDialogOpen.value || keePassDialogOpen.value || autofillSitePolicyDialogOpen.value || Boolean(bitwardenFoldersProvider.value) || Boolean(bitwardenCollectionsProvider.value) || Boolean(keePassGroupsProvider.value) || Boolean(keePassHistoryItem.value) || exportBackupDialogOpen.value || attachmentDialogOpen.value || Boolean(confirmationDialog.value));
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
    if (confirmationDialog.value) dialog.querySelector<HTMLElement>("[data-dialog-close]")?.click();
    else if (keePassHistoryItem.value) dialog.querySelector<HTMLElement>("[data-dialog-close]")?.click();
    else if (attachmentDialogOpen.value) dialog.querySelector<HTMLElement>("[data-dialog-close]")?.click();
    else if (mdbx2BatchTransferDialogOpen.value) dialog.querySelector<HTMLElement>("[data-dialog-close]")?.click();
    else if (bitwardenCollectionsProvider.value) dialog.querySelector<HTMLElement>("[data-dialog-close]")?.click();
    else if (bitwardenFoldersProvider.value) dialog.querySelector<HTMLElement>("[data-dialog-close]")?.click();
    else if (keePassGroupsProvider.value) dialog.querySelector<HTMLElement>("[data-dialog-close]")?.click();
    else if (exportBackupDialogOpen.value) closeExportBackupDialog();
    else if (mdbx2DialogOpen.value) dialog.querySelector<HTMLElement>("[data-dialog-close]")?.click();
    else if (keePassDialogOpen.value) closeKeePassDialog();
    else if (bitwardenDialogOpen.value) closeBitwardenDialog();
    else if (webDavDialogOpen.value) closeWebDavDialog();
    else if (vaultDetailItem.value) vaultDetailItem.value = undefined;
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
  readPersistedProtectionMode();
  loading.value = true;
  try {
    lifecycle.value = await vaultClient.status();
    if (lifecycle.value === "unlocked") await Promise.all([refreshItems(), refreshProviders(), refreshWindowsHelloStatus(), refreshAutofillSitePolicy()]);
    else if (lifecycle.value === "locked") await refreshWindowsHelloStatus();
  } catch (error) {
    authError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

function readPersistedProtectionMode() {
  try {
    const value = localStorage.getItem(PROTECTION_MODE_STORAGE_KEY);
    if (value === "master-password" || value === "device-key") protectionMode.value = value;
    else protectionMode.value = "unknown";
  } catch {
    protectionMode.value = "unknown";
  }
}

function rememberProtectionMode(mode: "master-password" | "device-key") {
  protectionMode.value = mode;
  try {
    localStorage.setItem(PROTECTION_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable in private mode; the runtime still validates.
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
    await Promise.all([refreshItems(), refreshProviders()]);
    lifecycle.value = "unlocked";
    rememberProtectionMode(auth.masterPassword ? "master-password" : "device-key");
    auth.masterPassword = "";
    auth.confirmation = "";
  } catch (error) {
    authError.value = errorMessage(error);
  } finally {
    authBusy.value = false;
  }
}

async function lockVault() {
  const hasLocalKeePassChanges = Object.entries(keePassSessions.value).some(([providerId, session]) =>
    session.dirty && providers.value.find((provider) => provider.id === providerId)?.config.sourceMode !== "webdav");
  if (hasLocalKeePassChanges && !window.confirm("KeePass 数据库还有未导出的修改。现在锁定会丢失这些内存中的 KDBX 改动，仍要继续吗？")) return;
  await vaultClient.lock();
  vaultItems.value = [];
  archivedItems.value = [];
  deletedItems.value = [];
  lifecycle.value = "locked";
  activeSection.value = "overview";
  editorOpen.value = false;
  vaultEditorOpen.value = false;
  webDavDialogOpen.value = false;
  bitwardenDialogOpen.value = false;
  confirmationDialog.value = null;
  confirmationBusy.value = false;
  confirmationError.value = "";
  closeBitwardenFolders();
  closeBitwardenCollections();
  mdbx2DialogOpen.value = false;
  mdbx2BatchTransferDialogOpen.value = false;
  mdbx2BatchTransferTargetProviderId.value = undefined;
  editingMdbx2Id.value = undefined;
  closeAttachmentDialog();
  closeKeePassHistory();
  closeKeePassGroups();
  closeKeePassDialog();
  keePassSessions.value = {};
  keePassRemoteStatuses.value = {};
  keePassCardErrors.value = {};
  mdbx2RuntimeStatuses.value = {};
  mdbx2SyncStatuses.value = {};
  void refreshWindowsHelloStatus();
}

async function refreshAutofillSitePolicy() {
  autofillSitePolicy.value = await vaultClient.getAutofillSitePolicy();
}

async function openAutofillSitePolicyDialog() {
  await refreshAutofillSitePolicy();
  autofillSitePolicyDialogOpen.value = true;
}

async function refreshWindowsHelloStatus() {
  windowsHelloBusy.value = "status";
  windowsHelloError.value = "";
  try {
    windowsHelloStatus.value = await vaultClient.windowsHelloStatus();
    if (windowsHelloStatus.value.protectionMode !== "unknown") rememberProtectionMode(windowsHelloStatus.value.protectionMode);
  } catch (error) {
    windowsHelloStatus.value = null;
    windowsHelloError.value = errorMessage(error);
  } finally {
    windowsHelloBusy.value = "";
  }
}

async function unlockVaultWithWindowsHello() {
  windowsHelloBusy.value = "verify";
  authError.value = "";
  windowsHelloError.value = "";
  try {
    vaultItems.value = await vaultClient.unlockWithWindowsHello();
    lifecycle.value = "unlocked";
    rememberProtectionMode("device-key");
    await Promise.all([refreshItems(), refreshProviders(), refreshWindowsHelloStatus()]);
  } catch (error) {
    authError.value = errorMessage(error);
  } finally {
    windowsHelloBusy.value = "";
  }
}

function enrollWindowsHello() {
  confirmationError.value = "";
  confirmationDialog.value = {
    kind: "windows-hello-enroll",
    title: "注册 Windows Hello？",
    message: "Windows 将显示系统验证界面，并为 Monica 创建专用平台凭据。",
    context: "注册后，设备密钥解锁将要求 Windows Hello。私钥始终留在 Windows；取消、超时或失败不会改变当前解锁方式，主密码恢复路径继续保留。",
    confirmLabel: "确认注册 Windows Hello",
    tone: "attention"
  };
}

async function applyWindowsHelloEnrollment() {
  windowsHelloBusy.value = "enroll";
  windowsHelloError.value = "";
  try {
    await vaultClient.enrollWindowsHello();
    await refreshWindowsHelloStatus();
    showNotice("Windows Hello 已注册；下次设备密钥解锁将要求系统验证。");
  } catch (error) {
    windowsHelloError.value = errorMessage(error);
    throw error;
  } finally {
    windowsHelloBusy.value = "";
  }
}

function revokeWindowsHello() {
  confirmationError.value = "";
  confirmationDialog.value = {
    kind: "windows-hello-revoke",
    title: "撤销本机 Windows Hello 绑定？",
    message: "此操作会删除 Monica 在当前 Windows 用户下的平台凭据绑定。",
    context: "加密密码库和设备密钥不会被删除。撤销后，设备密钥解锁不再要求 Windows Hello；主密码恢复路径保持不变。",
    confirmLabel: "确认撤销本机绑定",
    tone: "danger"
  };
}

async function applyWindowsHelloRevocation() {
  windowsHelloBusy.value = "revoke";
  windowsHelloError.value = "";
  try {
    await vaultClient.revokeWindowsHello();
    await refreshWindowsHelloStatus();
    showNotice("Windows Hello 本机绑定已撤销。");
  } catch (error) {
    windowsHelloError.value = errorMessage(error);
    throw error;
  } finally {
    windowsHelloBusy.value = "";
  }
}

async function refreshItems() {
  const [active, archived, deleted] = await Promise.all([
    vaultClient.listItems(),
    vaultClient.listArchivedItems(),
    vaultClient.listDeletedItems()
  ]);
  vaultItems.value = active;
  archivedItems.value = archived;
  deletedItems.value = deleted;
}

async function refreshProviders() {
  const [nextProviders, nextQueues, nextConflicts] = await Promise.all([
    vaultClient.listProviders(),
    vaultClient.providerQueueStatus(),
    vaultClient.listProviderConflicts()
  ]);
  providers.value = nextProviders;
  providerQueues.value = nextQueues;
  providerConflicts.value = nextConflicts;
  await Promise.all([refreshKeePassSessions(nextProviders), refreshMdbx2Statuses(nextProviders)]);
}

async function refreshKeePassSessions(accounts = providers.value) {
  const entries = await Promise.all(accounts.filter((provider) => provider.kind === "keepass").map(async (provider) => {
    if (provider.config.sourceMode === "webdav") {
      try {
        const remote = await vaultClient.keePassRemoteStatus(provider.id);
        const session = remote.sessionState === "unlocked" ? await vaultClient.keePassStatus(provider.id) : undefined;
        return { providerId: provider.id, remote, session };
      } catch (error) {
        return { providerId: provider.id, error };
      }
    }
    try {
      return { providerId: provider.id, session: await vaultClient.keePassStatus(provider.id) };
    } catch (error) {
      return { providerId: provider.id, error };
    }
  }));
  keePassSessions.value = Object.fromEntries(entries.flatMap((entry) => entry.session ? [[entry.providerId, entry.session]] : []));
  keePassRemoteStatuses.value = Object.fromEntries(entries.flatMap((entry) => entry.remote ? [[entry.providerId, entry.remote]] : []));
  const nextErrors = { ...keePassCardErrors.value };
  for (const entry of entries) {
    if (entry.error) nextErrors[entry.providerId] = { message: errorMessage(entry.error), code: errorCode(entry.error) };
    else delete nextErrors[entry.providerId];
  }
  keePassCardErrors.value = nextErrors;
}

async function refreshMdbx2Statuses(accounts = providers.value) {
  const mdbx2Accounts = accounts.filter((provider) => provider.kind === "mdbx2");
  if (!mdbx2Accounts.length) {
    mdbx2RuntimeStatuses.value = {};
    mdbx2SyncStatuses.value = {};
    return;
  }
  try {
    const host = await vaultClient.mdbx2HostStatus();
    mdbx2HostStatus.value = host;
    if (host.availability !== "ready") {
      mdbx2RuntimeStatuses.value = {};
      mdbx2SyncStatuses.value = {};
      return;
    }
  } catch {
    mdbx2RuntimeStatuses.value = {};
    mdbx2SyncStatuses.value = {};
    return;
  }
  const entries = await Promise.all(mdbx2Accounts.map(async (provider) => {
    const runtime = await vaultClient.mdbx2VaultStatus(provider.id).catch(() => undefined);
    const sync = await vaultClient.mdbx2SyncStatus(provider.id).catch(() => undefined);
    return { providerId: provider.id, runtime, sync };
  }));
  mdbx2RuntimeStatuses.value = Object.fromEntries(entries.flatMap((entry) => entry.runtime ? [[entry.providerId, entry.runtime]] : []));
  mdbx2SyncStatuses.value = Object.fromEntries(entries.flatMap((entry) => entry.sync ? [[entry.providerId, entry.sync]] : []));
}

function queueFor(providerId: string) {
  return providerQueues.value.find((queue) => queue.providerId === providerId);
}

function conflictsFor(providerId: string) {
  return providerConflicts.value.filter((conflict) => conflict.providerId === providerId);
}

function conflictTitle(conflict: ProviderConflictSummary) {
  return conflict.local?.title || conflict.remote?.title || "密码源级冲突";
}

function webDavEndpointLabel(provider: ProviderAccount): string {
  const raw = typeof provider.config.baseUrl === "string" ? provider.config.baseUrl.trim() : "";
  if (!raw) return "WebDAV 服务器";
  try {
    const url = new URL(raw);
    return url.host || "WebDAV 服务器";
  } catch {
    return "WebDAV 服务器地址已配置";
  }
}

function navigate(section: Section) {
  activeSection.value = section;
  mobileNavOpen.value = false;
  if (section === "providers") void refreshProviders();
  if (section === "timeline") void loadAndroidTimeline();
  if (section === "settings") void Promise.all([refreshWindowsHelloStatus(), refreshAutofillSitePolicy()]);
}

function sectionTitle(section: Section): string {
  return ({ overview: "密码库概览", passwords: "登录项", wallet: "钱包与身份", notes: "安全笔记", totp: "动态验证码", steam: "Steam", passkeys: "Passkey", sends: "安全发送", archive: "归档", trash: "回收站", timeline: "Android 时间线", generator: "生成器", providers: "密码源", settings: "设置与备份" } as const)[section];
}

function sectionDescription(section: Section): string {
  return ({ overview: "扩展源码复用 WebUI，但运行时完全独立。", passwords: "登录密码只在解锁后显示和编辑。", wallet: "管理证件、账单地址、银行卡与支付账号。", notes: "只管理加密安全笔记，不混入验证码。", totp: "管理 TOTP、HOTP、Yandex、mOTP 和 Steam Guard 验证器。", steam: "管理 Steam 登录批准、交易确认、库存、市场与授权设备。", passkeys: "查看 Passkey 来源与使用状态；私钥始终保持隐藏。", sends: "创建和管理 Bitwarden 文本与文件 Send；内容只在选择后由后台解密。", archive: "归档项目从普通分类、自动填充和 Passkey 候选中隐藏，取消归档后恢复使用。", trash: "远端回收站项目保存在加密墓碑中，可恢复且不会被静默永久删除。", timeline: "查看 Android WebDAV 备份中的操作摘要，不显示字段旧值和新值。", generator: "使用浏览器加密随机源生成密码、PIN 与密码短语。", providers: "连接 MDBX2、Monica Android WebDAV、KeePass、Bitwarden 或使用本地库。", settings: "管理外观、导入导出与安全边界。" } as const)[section];
}

async function loadAndroidTimeline() {
  timelineBusy.value = true;
  timelineError.value = "";
  try {
    const pages = await Promise.all(webDavProviders.value.map(async (provider) =>
      (await vaultClient.listAndroidTimeline(provider.id)).map((entry) => ({ ...entry, providerName: provider.name }))
    ));
    androidTimeline.value = pages.flat().sort((left, right) => right.timestamp - left.timestamp);
  } catch (error) {
    timelineError.value = errorMessage(error);
  } finally {
    timelineBusy.value = false;
  }
}

function filterManagerItems(items: VaultItem[]): VaultItem[] {
  return items.filter(matchesManagerFilters);
}

function itemFolderLabel(item: VaultItem): string {
  return item.categoryName?.trim() || "未分类";
}

function itemCategoryKey(item: VaultItem): string {
  const label = item.categoryName?.trim();
  if (!label) return "uncategorized";
  return item.categoryId === undefined ? `name:${label}` : `id:${item.categoryId}`;
}

function isLocalItem(item: VaultItem): boolean {
  return item.providerRefs.length === 0 || item.providerRefs.every((reference) => reference.providerId === "local");
}

function toggleAndroidQuickFilter(filter: AndroidQuickFilter): void {
  activeQuickFilters.value = activeQuickFilters.value.includes(filter)
    ? activeQuickFilters.value.filter((value) => value !== filter)
    : [...activeQuickFilters.value, filter];
}

function hasAndroidFilter(filter: AndroidQuickFilter): boolean {
  return activeQuickFilters.value.includes(filter);
}

const hasActiveManagerFilter = computed(() => databaseSourceFilter.value !== "all" || folderFilter.value !== "all" || activeQuickFilters.value.length > 0);

function matchesManagerFilters(item: VaultItem): boolean {
  const needle = query.value.trim().toLocaleLowerCase();
  if (needle && !itemSearchText(item).toLocaleLowerCase().includes(needle)) return false;
  if (databaseSourceFilter.value === "local" && !isLocalItem(item)) return false;
  if (databaseSourceFilter.value !== "all" && databaseSourceFilter.value !== "local" && !item.providerRefs.some((reference) => reference.providerId === databaseSourceFilter.value)) return false;
  if (folderFilter.value === "uncategorized" && itemCategoryKey(item) !== "uncategorized") return false;
  if (folderFilter.value.startsWith("id:") || folderFilter.value.startsWith("name:")) {
    if (itemCategoryKey(item) !== folderFilter.value) return false;
  }
  if (hasAndroidFilter("favorite") && !item.favorite) return false;
  if (hasAndroidFilter("two-fa") && itemSection(item) !== "totp") return false;
  if (hasAndroidFilter("notes") && itemSection(item) !== "notes") return false;
  if (hasAndroidFilter("passkey") && itemSection(item) !== "passkeys") return false;
  if (hasAndroidFilter("uncategorized") && itemCategoryKey(item) !== "uncategorized") return false;
  if (hasAndroidFilter("local-only") && !isLocalItem(item)) return false;
  if (hasAndroidFilter("attachments") && !(item.imagePaths?.length || item.boundNoteId !== undefined)) return false;
  return true;
}

function providerName(item: VaultItem): string {
  const reference = item.providerRefs[0];
  return reference ? providers.value.find((provider) => provider.id === reference.providerId)?.name || "外部密码源" : "Monica 本地库";
}

function providerDisplayName(provider: ProviderAccount): string {
  if (provider.kind !== "bitwarden") return provider.name;
  const email = typeof provider.config.email === "string" ? provider.config.email.trim() : "";
  return email ? `${provider.name} · ${email}` : provider.name;
}

function credentialCompactSummary(item: LoginItem): string {
  const username = item.username.trim() || "无用户名";
  const rawUri = item.uriRules?.find((rule) => rule.matchType !== "never" && rule.uri.trim())?.uri || item.uris.find((uri) => uri.trim()) || "";
  const host = normalizeHost(rawUri);
  return host ? `${username} · ${host}` : username;
}

function attachmentProvidersFor(item: VaultItem): ProviderAccount[] {
  const seen = new Set<string>();
  return item.providerRefs.flatMap((reference) => {
    const provider = attachmentProviderById.value.get(reference.providerId);
    if (!provider || seen.has(provider.id)) return [];
    seen.add(provider.id);
    return [provider];
  });
}

function openAttachmentDialog(item: VaultItem) {
  const candidates = attachmentProvidersFor(item);
  if (!candidates.length) return;
  attachmentDialogItem.value = item;
  attachmentDialogProviders.value = candidates;
  attachmentDialogOpen.value = true;
}

function closeAttachmentDialog() {
  attachmentDialogOpen.value = false;
  attachmentDialogItem.value = undefined;
  attachmentDialogProviders.value = [];
}

function keePassHistoryProvidersFor(item: VaultItem): ProviderAccount[] {
  const seen = new Set<string>();
  return item.providerRefs.flatMap((reference) => {
    const provider = keePassHistoryProviderById.value.get(reference.providerId);
    if (!provider || seen.has(provider.id)) return [];
    seen.add(provider.id);
    return [provider];
  });
}

function openKeePassHistory(item: VaultItem) {
  const candidates = keePassHistoryProvidersFor(item);
  if (!candidates.length) return;
  keePassHistoryItem.value = item;
  keePassHistoryProviders.value = candidates;
}

function closeKeePassHistory() {
  keePassHistoryItem.value = undefined;
  keePassHistoryProviders.value = [];
}

async function handleKeePassHistoryChanged() {
  await Promise.all([refreshKeePassSessions(), refreshItems()]);
}

function openBitwardenFolders(provider: ProviderAccount) {
  bitwardenFoldersProvider.value = provider;
}

function closeBitwardenFolders() {
  bitwardenFoldersProvider.value = undefined;
}

function openBitwardenCollections(provider: ProviderAccount) {
  bitwardenCollectionsProvider.value = provider;
}

function closeBitwardenCollections() {
  bitwardenCollectionsProvider.value = undefined;
}

async function handleBitwardenFoldersChanged() {
  await Promise.all([refreshItems(), refreshProviders()]);
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

async function unarchiveItem(item: VaultItem) {
  await vaultClient.upsertItem({ ...item, archivedAt: undefined });
  await refreshItems();
  showNotice(`${itemKindLabel(item.kind)}已取消归档。`);
}

async function restoreDeletedItem(item: VaultItem) {
  await vaultClient.restoreItem(item.id);
  await refreshItems();
  showNotice(`${itemKindLabel(item.kind)}已从回收站恢复。`);
}

function openCreate() {
  editingId.value = null;
  Object.assign(form, emptyLoginForm(defaultProviderId.value));
  formError.value = "";
  revealPassword.value = false;
  clearSpecialQr();
  barcodeRenderMode.value = "qr";
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
  barcodeRenderMode.value = "qr";
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

function openVaultDetail(item: VaultItem) {
  vaultDetailItem.value = item;
}

function editFromDetail(item: VaultItem) {
  vaultDetailItem.value = undefined;
  if (item.kind === "login") openEdit(item);
  else openVaultEdit(item);
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

  const existing = credentialById.value.get(editingId.value || "");
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
    specialQrDataUrl.value = form.loginType === "BARCODE" && barcodeRenderMode.value === "code128"
      ? await createCode128DataUrl(specialPayloadValue())
      : await createQrDataUrl(specialPayloadValue());
  } catch (cause) {
    specialQrError.value = cause instanceof Error ? cause.message : "无法生成条码。";
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

function openMdbx2Dialog(provider?: ProviderAccount, mode: "local" | "remote" = "local") {
  editingMdbx2Id.value = provider?.id;
  mdbx2DialogMode.value = mode;
  mdbx2DialogOpen.value = true;
}

function closeMdbx2Dialog() {
  mdbx2DialogOpen.value = false;
  editingMdbx2Id.value = undefined;
}

function openMdbx2BatchTransfer(provider?: ProviderAccount) {
  mdbx2BatchTransferTargetProviderId.value = provider?.id;
  mdbx2BatchTransferDialogOpen.value = true;
}

function closeMdbx2BatchTransfer() {
  mdbx2BatchTransferDialogOpen.value = false;
  mdbx2BatchTransferTargetProviderId.value = undefined;
}

async function handleMdbx2BatchTransferCompleted() {
  await Promise.all([refreshItems(), refreshProviders()]);
}

async function handleMdbx2Changed() {
  await Promise.all([refreshItems(), refreshProviders()]);
}

function mdbx2RuntimeFor(providerId: string): Mdbx2VaultRuntimeStatus | undefined {
  return mdbx2RuntimeStatuses.value[providerId];
}

function mdbx2SyncFor(providerId: string): Mdbx2ManagerSyncStatus | undefined {
  return mdbx2SyncStatuses.value[providerId];
}

function mdbx2StateLabel(provider: ProviderAccount): string {
  const runtime = mdbx2RuntimeFor(provider.id);
  const sync = mdbx2SyncFor(provider.id);
  if (provider.lastError || conflictsFor(provider.id).length || sync?.blockedStreamCount) return "需要处理";
  if (mdbx2HostStatus.value && mdbx2HostStatus.value.availability !== "ready") return "Host 未就绪";
  if (!runtime?.available) return "本机副本缺失";
  if (!runtime.open) return "已锁定";
  if (!sync?.initialized) return sync?.configured ? "待发布" : "仅本机";
  if (sync.hasLocalChanges || sync.pendingSegment || sync.pendingRemoteAcknowledgement) return "待同步";
  return provider.lastSyncAt ? "已同步" : "已连接";
}

function mdbx2StateClass(provider: ProviderAccount): string {
  const state = mdbx2StateLabel(provider);
  if (state === "已同步" || state === "已连接") return "state-healthy";
  if (state === "已锁定" || state === "仅本机") return "state-local-only";
  return "state-attention";
}

function mdbx2CanSync(provider: ProviderAccount): boolean {
  return Boolean(mdbx2RuntimeFor(provider.id)?.open && mdbx2SyncFor(provider.id)?.initialized);
}

async function lockMdbx2(provider: ProviderAccount) {
  mdbx2Busy.value = "lock";
  activeMdbx2ProviderId.value = provider.id;
  try {
    await vaultClient.lockMdbx2Vault(provider.id);
    await refreshMdbx2Statuses();
    showNotice(`${provider.name} 已锁定；本机工作副本仍保持 MDBX2 加密。`);
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    mdbx2Busy.value = "";
    activeMdbx2ProviderId.value = "";
  }
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

async function syncProvider(provider: ProviderAccount, allowEmptyRemote = false): Promise<boolean> {
  activeSyncProviderId.value = provider.id;
  try {
    return await runWebDavAction("sync", async () => {
      let result: Awaited<ReturnType<typeof vaultClient.syncProvider>>;
      try {
        result = await vaultClient.syncProvider(provider.id, allowEmptyRemote);
        if (provider.kind === "keepass") {
          const nextErrors = { ...keePassCardErrors.value };
          delete nextErrors[provider.id];
          keePassCardErrors.value = nextErrors;
        }
      } catch (error) {
        if (provider.kind === "keepass") {
          keePassCardErrors.value = {
            ...keePassCardErrors.value,
            [provider.id]: { message: errorMessage(error), code: errorCode(error) }
          };
        }
        throw error;
      } finally {
        await refreshProviders();
      }
      await refreshItems();
      const details = result.conflicts ? `发现 ${result.conflicts} 个冲突，未覆盖远端数据。` : result.warnings[0] || "同步完成。";
      showNotice(details);
    });
  } finally {
    activeSyncProviderId.value = "";
  }
}

async function syncAllBitwarden(): Promise<void> {
  if (syncingAllBitwarden.value || syncableBitwardenProviders.value.length < 2) return;
  syncingAllBitwarden.value = true;
  webDavError.value = "";
  try {
    const results = await vaultClient.syncAllBitwarden();
    await Promise.all([refreshProviders(), refreshItems()]);
    const succeeded = results.filter((result) => result.ok).length;
    const failed = results.length - succeeded;
    const conflicts = results.reduce((total, result) => total + result.conflicts, 0);
    const parts = [`${succeeded} 个账户已同步`];
    if (failed) parts.push(`${failed} 个失败`);
    if (conflicts) parts.push(`${conflicts} 个冲突`);
    showNotice(parts.join(" · "));
  } catch (error) {
    webDavError.value = errorMessage(error);
  } finally {
    syncingAllBitwarden.value = false;
  }
}

function confirmBitwardenEmptyRemote(provider: ProviderAccount) {
  if (provider.kind !== "bitwarden") return;
  confirmationError.value = "";
  confirmationDialog.value = {
    kind: "bitwarden-empty-remote",
    providerId: provider.id,
    title: "采用服务器空密码库？",
    message: "此操作会采用已认证同步返回的空结果。只有确认服务器确实被清空后才能继续。",
    context: `“${provider.name}”的本地活动项目将按空库结果移除；未同步修改仍受冲突保护，回收站墓碑和加密来源记录按同步结果保留。`,
    confirmLabel: "确认采用空库",
    tone: "danger"
  };
}

async function cancelProviderSync(provider: ProviderAccount) {
  const result = await vaultClient.cancelProviderSync(provider.id);
  if (result.cancelled) showNotice(`正在取消 ${provider.name} 同步…`);
}

function resolveProviderConflict(conflict: ProviderConflictSummary, resolution: ProviderConflictResolution) {
  const provider = providers.value.find((candidate) => candidate.id === conflict.providerId);
  const title = conflictTitle(conflict);
  const remoteLabel = providerConflictRemoteLabel(provider?.kind);
  confirmationError.value = "";
  confirmationDialog.value = {
    kind: "provider-conflict",
    providerId: conflict.providerId,
    conflictId: conflict.id,
    resolution,
    title: resolution === "keep-local" ? "保留浏览器版本？" : conflict.remote ? `采用${remoteLabel}？` : "接受远端删除？",
    message: resolution === "keep-local" ? `下次同步会把浏览器版本写回“${provider?.name || "远端密码源"}”。` : conflict.remote ? `此操作会丢弃当前浏览器修改，并采用${remoteLabel}。` : "此操作会接受服务器端删除结果。",
    context: resolution === "keep-local" ? `“${title}”的${remoteLabel}将在下次同步时被浏览器版本替换；未知字段仍按当前密码源的保留规则处理。` : conflict.remote ? `“${title}”将使用${remoteLabel}；用户名、密码、备注和自定义字段不会进入确认界面。` : `“${title}”将从当前活动列表移除，删除状态继续由当前密码源的加密记录保存。`,
    confirmLabel: resolution === "keep-local" ? "确认保留浏览器版本" : conflict.remote ? `确认采用${remoteLabel}` : "确认接受远端删除",
    tone: resolution === "keep-local" ? "attention" : "danger"
  };
}

function providerConflictRemoteLabel(kind: ProviderAccount["kind"] | undefined): string {
  return ({
    bitwarden: " Bitwarden 版本",
    mdbx2: " MDBX2 版本",
    "mdbx-legacy": "旧 MDBX1 版本",
    keepass: " KDBX 版本",
    "monica-webdav": " Android 版本",
    local: "远端版本"
  } as Record<ProviderAccount["kind"], string>)[kind || "local"];
}

async function applyProviderConflictResolution(conflict: ProviderConflictSummary, resolution: ProviderConflictResolution) {
  await vaultClient.resolveProviderConflict(conflict.id, resolution);
  await Promise.all([refreshItems(), refreshProviders()]);
  showNotice("同步冲突已原子解决。");
}

function closeConfirmationDialog() {
  if (confirmationBusy.value) return;
  confirmationDialog.value = null;
  confirmationError.value = "";
}

async function submitConfirmationAction() {
  const action = confirmationDialog.value;
  if (!action || confirmationBusy.value) return;
  confirmationBusy.value = true;
  confirmationError.value = "";
  try {
    if (action.kind === "bitwarden-empty-remote") {
      const provider = providers.value.find((candidate) => candidate.id === action.providerId && candidate.kind === "bitwarden");
      if (!provider) throw new Error("Bitwarden 密码源已不存在，请关闭对话框后刷新页面。");
      const completed = await syncProvider(provider, true);
      if (!completed) throw new Error(webDavError.value || "空库确认同步未完成，请检查网络后重试。");
    } else if (action.kind === "provider-conflict") {
      const conflict = providerConflicts.value.find((candidate) => candidate.id === action.conflictId && candidate.providerId === action.providerId);
      if (!conflict || !action.resolution) throw new Error("此冲突已变化，请关闭对话框并刷新最新状态。");
      await applyProviderConflictResolution(conflict, action.resolution);
    } else if (action.kind === "provider-remove") {
      const provider = providers.value.find((candidate) => candidate.id === action.providerId);
      if (!provider) throw new Error("密码源已不存在，请关闭对话框后刷新页面。");
      await applyProviderRemoval(provider);
    } else if (action.kind === "windows-hello-enroll") {
      await applyWindowsHelloEnrollment();
    } else {
      await applyWindowsHelloRevocation();
    }
    confirmationDialog.value = null;
  } catch (error) {
    confirmationError.value = errorMessage(error);
  } finally {
    confirmationBusy.value = false;
  }
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

function removeProvider(provider: ProviderAccount) {
  const remoteName = { bitwarden: "Bitwarden 密码库", mdbx2: "MDBX2 保险库", "mdbx-legacy": "旧 MDBX1 数据库", keepass: "KeePass 数据库" }[provider.kind as string] || "WebDAV 文件";
  const remoteKeePassStatus = provider.kind === "keepass" ? keePassRemoteStatusFor(provider.id) : undefined;
  const unsavedWarning = provider.kind === "keepass" && isRemoteKeePass(provider) && remoteKeePassStatus && remoteKeePassStatus.publicationState !== "clean"
    ? "此数据库的本机工作副本还有待上传或待确认修改，移除后这些本机修改会丢失。"
    : provider.kind === "keepass" && keePassSessionFor(provider.id)?.dirty
      ? "此数据库还有未导出的内存修改，移除后这些修改会丢失。"
      : "";
  confirmationError.value = "";
  confirmationDialog.value = {
    kind: "provider-remove",
    providerId: provider.id,
    title: `移除“${provider.name}”？`,
    message: "此操作只移除 Monica Extension 中的密码源连接和本地缓存。",
    context: `${unsavedWarning ? `${unsavedWarning} ` : ""}远端 ${remoteName} 不会被删除。重新连接前，此密码源不再参与同步、保存目标选择或管理操作。`,
    confirmLabel: "确认移除密码源",
    tone: "danger"
  };
}

async function logoutBitwarden(provider: ProviderAccount) {
  if (provider.kind !== "bitwarden") return;
  if (!window.confirm(`退出“${provider.name}”吗？已同步的本地项目会保留，访问令牌和本地 Vault 密钥会立即清除。`)) return;
  await runWebDavAction("logout", async () => {
    await vaultClient.logoutBitwarden(provider.id);
    await refreshProviders();
    showNotice(`${provider.name} 已退出；本地缓存仍保留，重新登录后可继续同步。`);
  });
}

async function applyProviderRemoval(provider: ProviderAccount) {
  const completed = await runWebDavAction("remove", async () => {
    await vaultClient.removeProvider(provider.id);
    await Promise.all([refreshItems(), refreshProviders()]);
    if (editingWebDavId.value === provider.id) closeWebDavDialog();
    if (editingBitwardenId.value === provider.id) closeBitwardenDialog();
    if (bitwardenFoldersProvider.value?.id === provider.id) closeBitwardenFolders();
    if (bitwardenCollectionsProvider.value?.id === provider.id) closeBitwardenCollections();
    if (editingKeePassId.value === provider.id) closeKeePassDialog();
    if (keePassGroupsProvider.value?.id === provider.id) closeKeePassGroups();
    if (keePassHistoryProviders.value.some((candidate) => candidate.id === provider.id)) closeKeePassHistory();
    if (editingMdbx2Id.value === provider.id) closeMdbx2Dialog();
    if (provider.kind === "keepass") {
      const next = { ...keePassSessions.value };
      delete next[provider.id];
      keePassSessions.value = next;
      const nextRemote = { ...keePassRemoteStatuses.value };
      delete nextRemote[provider.id];
      keePassRemoteStatuses.value = nextRemote;
      const nextErrors = { ...keePassCardErrors.value };
      delete nextErrors[provider.id];
      keePassCardErrors.value = nextErrors;
    }
    if (provider.kind === "mdbx2") {
      const nextRuntime = { ...mdbx2RuntimeStatuses.value };
      const nextSync = { ...mdbx2SyncStatuses.value };
      delete nextRuntime[provider.id];
      delete nextSync[provider.id];
      mdbx2RuntimeStatuses.value = nextRuntime;
      mdbx2SyncStatuses.value = nextSync;
    }
    showNotice(`${provider.name} 已从插件中移除，远端数据未改动。`);
  });
  if (!completed) throw new Error(webDavError.value || "密码源移除未完成，请重试。");
}

async function runWebDavAction(kind: typeof webDavBusy.value, action: () => Promise<void>): Promise<boolean> {
  webDavError.value = "";
  webDavBusy.value = kind;
  try {
    await action();
    return true;
  } catch (error) {
    webDavError.value = errorMessage(error);
    return false;
  } finally {
    webDavBusy.value = "";
  }
}

function openKeePassDialog(provider?: ProviderAccount) {
  editingKeePassId.value = provider?.id;
  const sourceMode: KeePassSourceMode = provider?.config.sourceMode === "webdav" ? "webdav" : "local-file";
  Object.assign(keePassForm, {
    sourceMode,
    name: provider?.name || "KeePass",
    password: "",
    currentFileName: typeof provider?.config.fileName === "string" ? provider.config.fileName : "",
    baseUrl: sourceMode === "webdav" && typeof provider?.config.webDavBaseUrl === "string" ? provider.config.webDavBaseUrl : "",
    username: sourceMode === "webdav" && typeof provider?.config.webDavUsername === "string" ? provider.config.webDavUsername : "",
    webDavPassword: "",
    remotePath: sourceMode === "webdav" && typeof provider?.config.remotePath === "string" ? provider.config.remotePath : "",
    webDavPasswordConfigured: provider?.config.webDavPasswordConfigured === true,
    databaseCredentialStored: provider?.config.databaseCredentialStored === true,
    keyFileConfigured: provider?.config.keyFileConfigured === true,
    isDefaultSaveTarget: provider?.isDefaultSaveTarget || false
  });
  keePassDatabaseFile.value = null;
  keePassKeyFile.value = null;
  revealKeePassPassword.value = false;
  keePassError.value = "";
  keePassDialogNotice.value = "";
  if (keePassFileInput.value) keePassFileInput.value.value = "";
  if (keePassKeyFileInput.value) keePassKeyFileInput.value.value = "";
  keePassDialogOpen.value = true;
}

function closeKeePassDialog() {
  if (keePassBusy.value === "open") return;
  keePassDialogOpen.value = false;
  editingKeePassId.value = undefined;
  keePassForm.password = "";
  keePassForm.webDavPassword = "";
  keePassDatabaseFile.value = null;
  keePassKeyFile.value = null;
  revealKeePassPassword.value = false;
  keePassError.value = "";
  keePassDialogNotice.value = "";
  if (keePassFileInput.value) keePassFileInput.value.value = "";
  if (keePassKeyFileInput.value) keePassKeyFileInput.value.value = "";
}

function openKeePassGroups(provider: ProviderAccount) {
  if (!keePassSessionFor(provider.id)) return;
  keePassGroupsProvider.value = provider;
}

function closeKeePassGroups() {
  keePassGroupsProvider.value = undefined;
}

async function handleKeePassGroupsChanged() {
  await Promise.all([refreshKeePassSessions(), refreshItems()]);
}

function selectKeePassDatabase(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0] || null;
  keePassDatabaseFile.value = file;
  keePassError.value = "";
  if (file && keePassForm.name === "KeePass") keePassForm.name = file.name.replace(/\.kdbx$/i, "") || "KeePass";
}

function selectKeePassKeyFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  keePassKeyFile.value = input.files?.[0] || null;
  keePassError.value = "";
}

async function connectKeePass() {
  if (keePassForm.sourceMode === "webdav") {
    await connectKeePassWebDav();
    return;
  }
  const databaseFile = keePassDatabaseFile.value;
  if (!databaseFile) return void (keePassError.value = "请选择要打开的 .kdbx 数据库文件。每次浏览器后台重启后都需要重新选择。");
  if (!databaseFile.name.toLocaleLowerCase().endsWith(".kdbx")) return void (keePassError.value = "KeePass 数据库文件必须使用 .kdbx 扩展名。");
  if (editingKeePassId.value && keePassSessionFor(editingKeePassId.value)?.dirty && !window.confirm("当前 KeePass 会话还有未导出的修改。重新解锁会用所选文件替换内存会话并丢失这些修改，仍要继续吗？")) return;
  keePassBusy.value = "open";
  activeKeePassProviderId.value = editingKeePassId.value || "new";
  keePassError.value = "";
  try {
    const [file, keyFile] = await Promise.all([
      fileAsBase64(databaseFile),
      keePassKeyFile.value ? fileAsBase64(keePassKeyFile.value) : Promise.resolve(undefined)
    ]);
    const opened = await vaultClient.openKeePass({
      providerId: editingKeePassId.value,
      name: keePassForm.name,
      fileName: databaseFile.name,
      file,
      password: keePassForm.password,
      keyFile,
      isDefaultSaveTarget: keePassForm.isDefaultSaveTarget
    });
    keePassSessions.value = { ...keePassSessions.value, [opened.account.id]: opened.session };
    await refreshProviders();
    keePassBusy.value = "";
    activeKeePassProviderId.value = "";
    closeKeePassDialog();
    showNotice(`已解锁 ${opened.session.databaseName}（${opened.session.itemCount} 个项目）；点击“立即同步”导入或写回修改。`);
  } catch (error) {
    keePassError.value = errorMessage(error);
  } finally {
    keePassBusy.value = "";
    activeKeePassProviderId.value = "";
  }
}

async function testKeePassWebDav() {
  const error = validateKeePassRemoteForm();
  if (error) return void (keePassError.value = error);
  keePassBusy.value = "test";
  keePassError.value = "";
  keePassDialogNotice.value = "";
  try {
    const result = await vaultClient.testKeePassWebDav({
      providerId: editingKeePassId.value,
      baseUrl: keePassForm.baseUrl,
      username: keePassForm.username,
      webDavPassword: keePassForm.webDavPassword,
      remotePath: keePassForm.remotePath
    });
    keePassDialogNotice.value = result.file
      ? "连接成功，远端文件可读取。"
      : "连接成功，但远端位置没有可读取的 KDBX 文件。";
  } catch (error) {
    keePassError.value = errorMessage(error);
  } finally {
    keePassBusy.value = "";
  }
}

async function connectKeePassWebDav() {
  const validationError = validateKeePassRemoteForm();
  if (validationError) return void (keePassError.value = validationError);
  const currentStatus = editingKeePassId.value ? keePassRemoteStatusFor(editingKeePassId.value) : undefined;
  if (editingKeePassId.value && currentStatus && currentStatus.publicationState !== "clean" &&
    !window.confirm("当前本机工作副本存在待上传或待确认修改。重新连接会以远端文件建立新的工作副本，仍要继续吗？")) return;
  keePassBusy.value = "open";
  activeKeePassProviderId.value = editingKeePassId.value || "new";
  keePassError.value = "";
  keePassDialogNotice.value = "";
  try {
    const keyFile = keePassKeyFile.value ? await fileAsBase64(keePassKeyFile.value) : undefined;
    const opened = await vaultClient.openKeePassWebDav({
      providerId: editingKeePassId.value,
      name: keePassForm.name,
      baseUrl: keePassForm.baseUrl,
      username: keePassForm.username,
      webDavPassword: keePassForm.webDavPassword,
      remotePath: keePassForm.remotePath,
      databasePassword: keePassForm.password,
      keyFile,
      isDefaultSaveTarget: keePassForm.isDefaultSaveTarget
    });
    keePassSessions.value = { ...keePassSessions.value, [opened.account.id]: opened.session };
    delete keePassCardErrors.value[opened.account.id];
    await refreshProviders();
    keePassBusy.value = "";
    activeKeePassProviderId.value = "";
    closeKeePassDialog();
    showNotice(`已连接 ${opened.session.databaseName}；加密工作副本可在浏览器后台重启后恢复。`);
  } catch (error) {
    keePassError.value = errorMessage(error);
  } finally {
    keePassBusy.value = "";
    activeKeePassProviderId.value = "";
  }
}

function validateKeePassRemoteForm(): string | undefined {
  if (!keePassForm.baseUrl.trim()) return "请填写 WebDAV 地址。";
  if (!keePassForm.remotePath.trim()) return "请填写远端 .kdbx 位置。";
  if (!keePassForm.remotePath.trim().toLocaleLowerCase().endsWith(".kdbx")) return "远端 KeePass 文件必须使用 .kdbx 扩展名。";
  return undefined;
}

function keePassSessionFor(providerId: string): KeePassSessionSummary | undefined {
  return keePassSessions.value[providerId];
}

function keePassRemoteStatusFor(providerId: string): KeePassRemoteManagerStatus | undefined {
  return keePassRemoteStatuses.value[providerId];
}

function isRemoteKeePass(provider: ProviderAccount): boolean {
  return provider.config.sourceMode === "webdav";
}

function keePassRemoteErrorPresentationFor(provider: ProviderAccount): KeePassRemoteErrorPresentation | undefined {
  if (!isRemoteKeePass(provider)) return undefined;
  const statusError = keePassRemoteStatusFor(provider.id)?.lastError;
  if (statusError) return presentKeePassRemoteError(statusError);
  const local = keePassCardErrors.value[provider.id];
  if (!local) return undefined;
  return presentKeePassRemoteError({
    code: (local.code || "unknown") as NonNullable<KeePassRemoteManagerStatus["lastError"]>["code"],
    retryable: false,
    at: new Date().toISOString()
  });
}

function keePassStateLabel(provider: ProviderAccount): string {
  if (provider.lastError || conflictsFor(provider.id).length || keePassRemoteErrorPresentationFor(provider)) return "需要处理";
  if (isRemoteKeePass(provider)) {
    const status = keePassRemoteStatusFor(provider.id);
    if (!status) return "正在检查";
    if (status.publicationState === "pending-confirmation") return "结果待确认";
    if (status.workingCopyState === "missing" || status.sessionState === "reconnect-required") return "需要重新连接";
    if (status.sessionState === "restorable") return "可恢复";
    if (status.publicationState === "local-changes") return "待上传";
    return "已解锁";
  }
  const session = keePassSessionFor(provider.id);
  if (!session) return "已锁定";
  return session.dirty ? "待导出" : "已解锁";
}

function keePassStateClass(provider: ProviderAccount): string {
  if (provider.lastError || conflictsFor(provider.id).length || keePassRemoteErrorPresentationFor(provider) || keePassSessionFor(provider.id)?.dirty) return "state-attention";
  if (isRemoteKeePass(provider)) {
    const status = keePassRemoteStatusFor(provider.id);
    if (!status || status.publicationState !== "clean") return "state-attention";
    return status.sessionState === "unlocked" ? "state-healthy" : "state-local-only";
  }
  return keePassSessionFor(provider.id) ? "state-healthy" : "state-local-only";
}

function keePassProtectionLabel(provider: ProviderAccount): string {
  return ({
    password: "仅密码",
    "key-file": "仅密钥文件",
    "password-and-key-file": "密码 + 密钥文件",
    empty: "空密码"
  } as Record<string, string>)[String(provider.config.protectionMode || "")] || "保护方式未记录";
}

async function exportKeePass(provider: ProviderAccount) {
  keePassBusy.value = "export";
  activeKeePassProviderId.value = provider.id;
  try {
    const exported = await vaultClient.exportKeePassFile(provider.id);
    downloadBase64File(exported.fileName, exported.file, "application/octet-stream");
    await refreshKeePassSessions();
    showNotice(isRemoteKeePass(provider)
      ? "KDBX 加密副本已导出；WebDAV 发布状态保持不变。"
      : "KDBX 已导出。请确认下载完成后手动覆盖原文件；浏览器不会直接改写所选文件。");
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    keePassBusy.value = "";
    activeKeePassProviderId.value = "";
  }
}

async function lockKeePass(provider: ProviderAccount) {
  const session = keePassSessionFor(provider.id);
  if (!isRemoteKeePass(provider) && session?.dirty && !window.confirm("此 KeePass 数据库还有未导出的修改。锁定后这些内存修改会丢失，仍要继续吗？")) return;
  keePassBusy.value = "lock";
  activeKeePassProviderId.value = provider.id;
  try {
    await vaultClient.lockKeePass(provider.id);
    const next = { ...keePassSessions.value };
    delete next[provider.id];
    keePassSessions.value = next;
    if (isRemoteKeePass(provider)) await refreshKeePassSessions();
    if (keePassHistoryProviders.value.some((candidate) => candidate.id === provider.id)) closeKeePassHistory();
    showNotice(isRemoteKeePass(provider)
      ? `${provider.name} 已锁定；解锁对象已清除，加密工作副本仍可恢复。`
      : `${provider.name} 已锁定；密码、密钥文件和解锁后的数据库对象均已从后台会话中清除。`);
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    keePassBusy.value = "";
    activeKeePassProviderId.value = "";
  }
}

async function restoreKeePassRemoteSession(provider: ProviderAccount) {
  keePassBusy.value = "restore";
  activeKeePassProviderId.value = provider.id;
  const nextErrors = { ...keePassCardErrors.value };
  delete nextErrors[provider.id];
  keePassCardErrors.value = nextErrors;
  try {
    const session = await vaultClient.restoreKeePassRemote(provider.id);
    keePassSessions.value = { ...keePassSessions.value, [provider.id]: session };
    await refreshProviders();
    showNotice(`${provider.name} 已从本机加密工作副本恢复，无需重新下载 WebDAV 文件。`);
  } catch (error) {
    keePassCardErrors.value = {
      ...keePassCardErrors.value,
      [provider.id]: { message: errorMessage(error), code: errorCode(error) }
    };
  } finally {
    keePassBusy.value = "";
    activeKeePassProviderId.value = "";
  }
}

async function handleKeePassRecoveryAction(provider: ProviderAccount, presentation: KeePassRemoteErrorPresentation | undefined) {
  if (!presentation) return;
  if (presentation.action === "reconnect") {
    openKeePassDialog(provider);
    return;
  }
  if (presentation.action === "retry") await syncProvider(provider);
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error(`无法读取文件：${file.name}`));
    reader.onload = () => {
      if (typeof reader.result !== "string") return void reject(new Error(`无法读取文件：${file.name}`));
      const separator = reader.result.indexOf(",");
      if (separator < 0) return void reject(new Error(`文件编码无效：${file.name}`));
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function downloadBase64File(fileName: string, value: string, type: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
    newDeviceOtp: "",
    ssoOrganizationIdentifier: "",
    isDefaultSaveTarget: provider?.isDefaultSaveTarget || false
  });
  bitwardenTwoFactorProviders.value = [];
  bitwardenTwoFactorProviderData.value = undefined;
  bitwardenDeviceVerificationRequired.value = false;
  bitwardenError.value = "";
  bitwardenDialogOpen.value = true;
}

function closeBitwardenDialog() {
  bitwardenDialogOpen.value = false;
  bitwardenForm.masterPassword = "";
  bitwardenForm.twoFactorCode = "";
  bitwardenForm.newDeviceOtp = "";
  bitwardenForm.ssoOrganizationIdentifier = "";
  bitwardenTwoFactorProviders.value = [];
  bitwardenTwoFactorProviderData.value = undefined;
  bitwardenDeviceVerificationRequired.value = false;
  bitwardenError.value = "";
}

async function connectBitwarden() {
  if (!bitwardenForm.masterPassword) return void (bitwardenError.value = "请输入 Bitwarden 主密码。");
  if (bitwardenDeviceVerificationRequired.value && !bitwardenForm.newDeviceOtp.trim()) return void (bitwardenError.value = "请输入 Bitwarden 新设备验证码。");
  if (bitwardenTwoFactorProviders.value.length && ![2, 4, 5].includes(bitwardenForm.twoFactorProvider) && !bitwardenForm.twoFactorCode.trim()) return void (bitwardenError.value = "请输入两步验证代码。");
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
      twoFactorProviderData: bitwardenForm.twoFactorProvider === 5 ? bitwardenTwoFactorProviderData.value : undefined,
      rememberTwoFactor: bitwardenForm.rememberTwoFactor,
      newDeviceOtp: bitwardenDeviceVerificationRequired.value ? bitwardenForm.newDeviceOtp : undefined,
      ssoOrganizationIdentifier: bitwardenForm.ssoOrganizationIdentifier.trim() || undefined,
      isDefaultSaveTarget: bitwardenForm.isDefaultSaveTarget
    });
    if (result.status === "device-verification-required") {
      const submittedCode = bitwardenDeviceVerificationRequired.value && Boolean(bitwardenForm.newDeviceOtp.trim());
      bitwardenDeviceVerificationRequired.value = true;
      bitwardenTwoFactorProviders.value = [];
      bitwardenError.value = submittedCode ? "Bitwarden 新设备验证码错误或已过期，请获取新验证码后重试。" : "";
      return;
    }
    if (result.status === "sso-required") {
      bitwardenForm.ssoOrganizationIdentifier = result.organizationIdentifier;
      bitwardenTwoFactorProviders.value = [];
      bitwardenError.value = "此账号需要组织 SSO。确认组织标识后再次提交，将打开安全登录窗口。";
      return;
    }
    if (result.status === "two-factor-required") {
      bitwardenDeviceVerificationRequired.value = false;
      bitwardenForm.newDeviceOtp = "";
      const supported = result.providers.filter((provider) => provider === 0 || provider === 1 || provider === 2 || provider === 3 || provider === 4 || provider === 5);
      if (!supported.length) {
        bitwardenError.value = "此账号只启用了当前浏览器无法完成的两步验证方式。";
        return;
      }
      bitwardenTwoFactorProviders.value = supported;
      bitwardenTwoFactorProviderData.value = result.providerData;
      bitwardenForm.twoFactorProvider = supported.includes(0) ? 0 : supported[0];
      showNotice(bitwardenForm.twoFactorProvider === 5 ? "Bitwarden 需要 WebAuthn 验证，请继续完成硬件密钥或 Passkey 验证。" : bitwardenForm.twoFactorProvider === 2 || bitwardenForm.twoFactorProvider === 4 ? "Bitwarden 需要 Duo 验证，请在安全窗口中批准登录。" : "Bitwarden 需要两步验证，请输入代码后继续。");
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

function openExportBackupDialog() {
  exportBackupForm.password = "";
  exportBackupForm.confirmation = "";
  exportBackupError.value = "";
  exportBackupDialogOpen.value = true;
}

function closeExportBackupDialog() {
  exportBackupDialogOpen.value = false;
  exportBackupForm.password = "";
  exportBackupForm.confirmation = "";
  exportBackupError.value = "";
}

async function submitExportBackup() {
  exportBackupError.value = "";
  if (exportBackupForm.password.length < MIN_BACKUP_PASSWORD_LENGTH) {
    exportBackupError.value = `独立备份密码至少需要 ${MIN_BACKUP_PASSWORD_LENGTH} 个字符。`;
    return;
  }
  if (exportBackupForm.password !== exportBackupForm.confirmation) {
    exportBackupError.value = "两次输入的备份密码不一致。";
    return;
  }
  securityBusy.value = "export";
  try {
    const backup = await vaultClient.exportEncryptedBackup(exportBackupForm.password);
    downloadJsonFile(`monica-extension-encrypted-${new Date().toISOString().slice(0, 10)}.json`, backup);
    showNotice("已导出可移植的加密整库备份；恢复时需要此独立备份密码。");
    closeExportBackupDialog();
  } catch (error) {
    exportBackupError.value = errorMessage(error);
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
  if (!restoreForm.backupPassword) return void (securityError.value = "请输入备份时使用的独立备份密码。");
  const replacing = lifecycle.value !== "uninitialized";
  // DEVICE-KEY vaults do not have a master password, so an empty currentPassword
  // must not be blocked here. The runtime re-derives the device key and rejects
  // invalid input authoritatively. Master-password vaults still need UI validation
  // so the user gets an immediate, clear error before the destructive replace.
  if (replacing && protectionMode.value === "master-password" && !restoreForm.currentPassword) {
    return void (securityError.value = "替换当前主密码库需要验证当前主密码。");
  }
  if (replacing && !window.confirm("恢复会完整替换当前本地密码库。确定继续吗？")) return;
  securityBusy.value = "restore";
  securityError.value = "";
  try {
    vaultItems.value = await vaultClient.restoreEncryptedBackup(selectedEncryptedBackup.value, restoreForm.backupPassword, replacing, replacing ? restoreForm.currentPassword : undefined);
    lifecycle.value = "unlocked";
    // New portable backups are password-derived. Legacy DEVICE-KEY envelopes may
    // still restore on the same device and must keep that protection mode.
    const restoredMode = selectedEncryptedBackup.value.envelope.kdf.name === "DEVICE-KEY" ? "device-key" : "master-password";
    rememberProtectionMode(restoredMode);
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
    rememberProtectionMode(passwordChange.newPassword ? "master-password" : "device-key");
    passwordChange.currentPassword = "";
    passwordChange.newPassword = "";
    passwordChange.confirmation = "";
    passwordChangeDialogOpen.value = false;
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
    const isCsv = file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv";
    let items: VaultItem[] = [];
    if (isCsv) {
      const result = parseCsvToVaultItems(await file.text());
      items = result.items.flatMap((normalized) => {
        return [{ ...normalized, providerRefs: normalized.providerRefs.filter((reference) => providers.value.some((provider) => provider.id === reference.providerId)) } as VaultItem];
      });
    } else {
      const parsed = JSON.parse(await file.text()) as { items?: unknown[]; credentials?: Array<Record<string, unknown>> };
      items = Array.isArray(parsed.items) ? parsed.items.flatMap((item) => {
        const normalized = normalizeImportedVaultItem(item);
        return normalized ? [{ ...normalized, providerRefs: normalized.providerRefs.filter((reference) => providers.value.some((provider) => provider.id === reference.providerId)) } as VaultItem] : [];
      }) : [];
      if (!items.length && Array.isArray(parsed.credentials)) {
        for (const legacy of parsed.credentials) {
          if (typeof legacy.password !== "string" || !Array.isArray(legacy.urls)) continue;
          items.push(createLoginItem({ title: String(legacy.name || "导入登录项"), username: String(legacy.username || ""), password: legacy.password, uris: legacy.urls.map(String), notes: String(legacy.notes || ""), favorite: Boolean(legacy.favorite) }));
        }
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

function errorCode(error: unknown): string | undefined {
  return error instanceof ExtensionRuntimeError ? error.code : undefined;
}
</script>

<template>
  <m3e-theme :color="themeColor" :scheme="activeScheme" variant="expressive" motion="expressive" strong-focus>
    <div v-if="loading" class="loading">
      <img src="/icons/logo-256.png" alt="" /><h1>Monica</h1><p>正在检查加密密码库…</p>
    </div>

    <form v-else-if="lifecycle !== 'unlocked'" class="login vault-auth" @submit.prevent="lifecycle === 'uninitialized' ? setupVault() : unlockVault()">
      <m3e-card variant="outlined" class="login-card">
        <div slot="content" class="stack login-stack">
          <div class="login-brand"><img src="/icons/logo-256.png" alt="" /><span class="login-brand-copy">Monica<small>浏览器插件</small></span></div>
          <div class="login-heading"><h1>{{ lifecycle === 'uninitialized' ? '创建加密密码库' : '解锁 Monica' }}</h1><p class="supporting">{{ lifecycle === 'uninitialized' ? '主密码可选，也可使用设备密钥。' : protectionMode === 'device-key' ? '设备密钥模式可留空解锁。' : '输入主密码解锁。' }}</p></div>
          <label class="field"><span>主密码{{ lifecycle === 'uninitialized' || protectionMode === 'device-key' ? '（可选）' : '' }}</span><input v-model="auth.masterPassword" aria-label="主密码" type="password" :minlength="auth.masterPassword ? MIN_MASTER_PASSWORD_LENGTH : undefined" autocomplete="current-password" autofocus /></label>
          <label v-if="lifecycle === 'uninitialized'" class="field"><span>确认主密码</span><input v-model="auth.confirmation" type="password" :minlength="auth.confirmation ? MIN_MASTER_PASSWORD_LENGTH : undefined" autocomplete="new-password" /></label>
          <div v-if="lifecycle === 'locked' && windowsHelloStatus?.unlockAvailable" class="hello-unlock-action">
            <m3e-button variant="tonal" type="button" :disabled="Boolean(windowsHelloBusy) || authBusy" @click="unlockVaultWithWindowsHello"><m3e-icon slot="icon" name="fingerprint"></m3e-icon>{{ windowsHelloBusy === 'verify' ? '正在等待 Windows Hello…' : '使用 Windows Hello 解锁' }}</m3e-button>
            <small>仅解锁当前浏览器会话。</small>
          </div>
          <p v-else-if="lifecycle === 'locked' && windowsHelloStatus?.vaultEnrolled && !windowsHelloStatus.bindingConsistent" class="supporting hello-status-note">Windows Hello 绑定不可用。</p>
          <p v-else-if="lifecycle === 'locked' && windowsHelloStatus?.vaultEnrolled && !windowsHelloStatus.native.available" class="supporting hello-status-note">Windows Hello 暂不可用。</p>
          <p v-else-if="lifecycle === 'locked' && windowsHelloError" class="supporting hello-status-note">Windows Hello 状态检查失败。</p>
          <p v-if="authError" class="form-error" role="alert">{{ authError }}</p>
          <m3e-button variant="filled" type="submit" :disabled="authBusy">{{ authBusy ? '处理中…' : lifecycle === 'uninitialized' ? '创建并解锁' : '解锁' }}</m3e-button>
          <div v-if="lifecycle === 'uninitialized' || lifecycle === 'locked' && windowsHelloStatus?.vaultEnrolled" class="recovery-panel stack">
            <div><strong>{{ lifecycle === 'locked' ? '备份恢复' : '已有加密整库备份？' }}</strong><p class="supporting">选择备份文件恢复。</p></div>
            <label class="file-action"><m3e-icon name="upload"></m3e-icon><span>选择加密整库备份</span><input type="file" accept="application/json,.json" @change="selectEncryptedBackup" /></label>
            <template v-if="selectedEncryptedBackup">
              <p class="supporting">已选择：{{ selectedEncryptedBackupName }}</p>
              <label class="field"><span>备份密码</span><input v-model="restoreForm.backupPassword" type="password" autocomplete="current-password" /></label>
              <m3e-button variant="tonal" type="button" :disabled="Boolean(securityBusy)" @click="restoreEncryptedVault">{{ securityBusy === 'restore' ? '正在恢复…' : lifecycle === 'locked' ? '验证备份并替换恢复' : '恢复并解锁' }}</m3e-button>
            </template>
            <p v-if="securityError" class="form-error" role="alert">{{ securityError }}</p>
          </div>
        <div class="security-note"><m3e-icon name="encrypted"></m3e-icon><span>AES-256-GCM · 会话级解锁</span></div>
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
            <button class="nav-item" :class="{ selected: activeSection === 'sends' }" :aria-current="activeSection === 'sends' ? 'page' : undefined" type="button" @click="navigate('sends')"><m3e-icon name="send"></m3e-icon><span>安全发送</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'archive' }" :aria-current="activeSection === 'archive' ? 'page' : undefined" type="button" @click="navigate('archive')"><m3e-icon name="archive"></m3e-icon><span>归档</span><span class="nav-count">{{ archivedItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'trash' }" :aria-current="activeSection === 'trash' ? 'page' : undefined" type="button" @click="navigate('trash')"><m3e-icon name="delete"></m3e-icon><span>回收站</span><span class="nav-count">{{ deletedItems.length }}</span></button>
            <button class="nav-item" :class="{ selected: activeSection === 'timeline' }" :aria-current="activeSection === 'timeline' ? 'page' : undefined" type="button" @click="navigate('timeline')"><m3e-icon name="history"></m3e-icon><span>时间线</span></button>
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

      <main id="main-content" :class="{ 'settings-main': activeSection === 'settings' }" tabindex="-1">
        <m3e-app-bar size="small" class="page-appbar">
          <m3e-icon-button slot="leading" class="mobile-menu" aria-label="打开导航" aria-controls="primary-navigation" :aria-expanded="mobileNavOpen" @click="mobileNavOpen = !mobileNavOpen"><m3e-icon name="menu"></m3e-icon></m3e-icon-button>
          <div slot="trailing" class="appbar-trailing"><label class="search"><m3e-icon name="search"></m3e-icon><input v-model="query" aria-label="搜索密码库" placeholder="搜索当前分类" /></label><m3e-button v-if="activeSection === 'providers' && syncableBitwardenProviders.length > 1" variant="tonal" :disabled="syncingAllBitwarden || Boolean(activeSyncProviderId)" @click="syncAllBitwarden"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ syncingAllBitwarden ? '正在同步' : '同步全部' }}</m3e-button><m3e-button v-if="activeSection === 'overview' || activeSection === 'passwords'" class="appbar-create" variant="filled" aria-label="新建" @click="openCreate"><m3e-icon slot="icon" name="add"></m3e-icon><span class="appbar-action-label">新建</span></m3e-button><m3e-button v-else-if="activeSection === 'wallet' || activeSection === 'notes' || activeSection === 'totp'" class="appbar-create" variant="filled" :aria-label="activeSection === 'wallet' ? '添加钱包项目' : activeSection === 'notes' ? '添加安全笔记' : '添加验证码'" @click="openVaultCreate(activeSection)"><m3e-icon slot="icon" name="add"></m3e-icon><span class="appbar-action-label">新建</span></m3e-button><m3e-button v-if="filterableSection" class="appbar-filter" variant="tonal" aria-label="筛选" @click="filterDialogOpen = true"><m3e-icon slot="icon" name="tune"></m3e-icon><span class="appbar-action-label">筛选</span><span v-if="hasActiveManagerFilter" class="filter-count">{{ (databaseSourceFilter !== 'all' ? 1 : 0) + (folderFilter !== 'all' ? 1 : 0) + activeQuickFilters.length }}</span></m3e-button></div>
        </m3e-app-bar>

        <div class="page-heading">
          <div><h1>{{ sectionTitle(activeSection) }}</h1><p>{{ sectionDescription(activeSection) }}</p></div>
        </div>
        <p class="sr-status" aria-live="polite">{{ notice }}</p>
        <div v-if="filterableSection && false" class="manager-filters" aria-label="快捷筛选">
          <span class="filter-caption">密码源</span>
          <div class="filter-chip-row" role="group" aria-label="密码源">
            <button type="button" :class="{ selected: databaseSourceFilter === 'all' }" :aria-pressed="databaseSourceFilter === 'all'" @click="databaseSourceFilter = 'all'"><m3e-icon name="list"></m3e-icon>全部</button>
            <button type="button" :class="{ selected: databaseSourceFilter === 'local' }" :aria-pressed="databaseSourceFilter === 'local'" @click="databaseSourceFilter = 'local'"><m3e-icon name="smartphone"></m3e-icon>Monica 本地库</button>
            <button v-for="source in databaseSources" :key="source.id" type="button" :class="{ selected: databaseSourceFilter === source.id }" :aria-pressed="databaseSourceFilter === source.id" @click="databaseSourceFilter = source.id"><m3e-icon :name="source.kind === 'bitwarden' ? 'cloud_sync' : source.kind === 'mdbx2' ? 'storage' : 'key'"></m3e-icon>{{ source.name }}</button>
          </div>
          <span class="filter-caption filter-caption-category">分类</span>
          <div class="filter-chip-row" role="group" aria-label="Android 分类">
            <button type="button" :class="{ selected: folderFilter === 'all' }" :aria-pressed="folderFilter === 'all'" @click="folderFilter = 'all'"><m3e-icon name="list"></m3e-icon>全部分类</button>
            <button type="button" :class="{ selected: folderFilter === 'uncategorized' }" :aria-pressed="folderFilter === 'uncategorized'" @click="folderFilter = 'uncategorized'"><m3e-icon name="folder_off"></m3e-icon>未分类</button>
            <button v-for="folder in databaseFolders" :key="folder.key" type="button" :class="{ selected: folderFilter === folder.key }" :aria-pressed="folderFilter === folder.key" @click="folderFilter = folder.key"><m3e-icon name="folder"></m3e-icon>{{ folder.label }}</button>
          </div>
          <span class="filter-caption filter-caption-quick">快捷筛选</span>
          <div class="filter-chip-row" role="group" aria-label="快捷筛选条件">
            <button type="button" :class="{ selected: hasAndroidFilter('favorite') }" :aria-pressed="hasAndroidFilter('favorite')" @click="toggleAndroidQuickFilter('favorite')"><m3e-icon name="star"></m3e-icon>收藏</button>
            <button type="button" :class="{ selected: hasAndroidFilter('two-fa') }" :aria-pressed="hasAndroidFilter('two-fa')" @click="toggleAndroidQuickFilter('two-fa')"><m3e-icon name="security"></m3e-icon>验证码</button>
            <button type="button" :class="{ selected: hasAndroidFilter('notes') }" :aria-pressed="hasAndroidFilter('notes')" @click="toggleAndroidQuickFilter('notes')"><m3e-icon name="description"></m3e-icon>笔记</button>
            <button type="button" :class="{ selected: hasAndroidFilter('passkey') }" :aria-pressed="hasAndroidFilter('passkey')" @click="toggleAndroidQuickFilter('passkey')"><m3e-icon name="key_vertical"></m3e-icon>Passkey</button>
            <button type="button" :class="{ selected: hasAndroidFilter('uncategorized') }" :aria-pressed="hasAndroidFilter('uncategorized')" @click="toggleAndroidQuickFilter('uncategorized')"><m3e-icon name="folder_off"></m3e-icon>未分类</button>
            <button type="button" :class="{ selected: hasAndroidFilter('local-only') }" :aria-pressed="hasAndroidFilter('local-only')" @click="toggleAndroidQuickFilter('local-only')"><m3e-icon name="key"></m3e-icon>仅本地</button>
            <button type="button" :class="{ selected: hasAndroidFilter('attachments') }" :aria-pressed="hasAndroidFilter('attachments')" @click="toggleAndroidQuickFilter('attachments')"><m3e-icon name="attach_file"></m3e-icon>附件</button>
          </div>
          <button v-if="hasActiveManagerFilter" type="button" class="filter-reset" @click="databaseSourceFilter = 'all'; folderFilter = 'all'; activeQuickFilters = []">清除筛选</button>
        </div>

          <div v-if="filterDialogOpen" class="modal-backdrop" role="presentation" @mousedown.self="filterDialogOpen = false"><section class="filter-dialog" role="dialog" aria-modal="true" aria-labelledby="filter-dialog-title"><header><div><h2 id="filter-dialog-title">筛选密码库</h2><p>按密码源、Android 分类和快捷条件组合筛选。</p></div><m3e-icon-button aria-label="关闭筛选" @click="filterDialogOpen = false"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header><div class="filter-dialog-body"><span class="filter-caption">密码源</span><div class="filter-chip-row" role="group" aria-label="密码源"><button type="button" :class="{ selected: databaseSourceFilter === 'all' }" :aria-pressed="databaseSourceFilter === 'all'" @click="databaseSourceFilter = 'all'"><m3e-icon name="list"></m3e-icon>全部</button><button type="button" :class="{ selected: databaseSourceFilter === 'local' }" :aria-pressed="databaseSourceFilter === 'local'" @click="databaseSourceFilter = 'local'"><m3e-icon name="smartphone"></m3e-icon>Monica 本地库</button><button v-for="source in databaseSources" :key="source.id" type="button" :class="{ selected: databaseSourceFilter === source.id }" :aria-pressed="databaseSourceFilter === source.id" @click="databaseSourceFilter = source.id"><m3e-icon :name="source.kind === 'bitwarden' ? 'cloud_sync' : source.kind === 'mdbx2' ? 'storage' : 'key'"></m3e-icon><span class="filter-label">{{ providerDisplayName(source) }}</span></button></div><span class="filter-caption">分类</span><div class="filter-chip-row" role="group" aria-label="Android 分类"><button type="button" :class="{ selected: folderFilter === 'all' }" :aria-pressed="folderFilter === 'all'" @click="folderFilter = 'all'"><m3e-icon name="list"></m3e-icon>全部分类</button><button type="button" :class="{ selected: folderFilter === 'uncategorized' }" :aria-pressed="folderFilter === 'uncategorized'" @click="folderFilter = 'uncategorized'"><m3e-icon name="folder_off"></m3e-icon>未分类</button><button v-for="folder in databaseFolders" :key="folder.key" type="button" :class="{ selected: folderFilter === folder.key }" :aria-pressed="folderFilter === folder.key" @click="folderFilter = folder.key"><m3e-icon name="folder"></m3e-icon>{{ folder.label }}</button></div><span class="filter-caption">快捷筛选</span><div class="filter-chip-row filter-dialog-quick" role="group" aria-label="快捷筛选条件"><button type="button" :class="{ selected: hasAndroidFilter('favorite') }" :aria-pressed="hasAndroidFilter('favorite')" @click="toggleAndroidQuickFilter('favorite')"><m3e-icon name="star"></m3e-icon>收藏</button><button type="button" :class="{ selected: hasAndroidFilter('two-fa') }" :aria-pressed="hasAndroidFilter('two-fa')" @click="toggleAndroidQuickFilter('two-fa')"><m3e-icon name="security"></m3e-icon>验证码</button><button type="button" :class="{ selected: hasAndroidFilter('notes') }" :aria-pressed="hasAndroidFilter('notes')" @click="toggleAndroidQuickFilter('notes')"><m3e-icon name="description"></m3e-icon>笔记</button><button type="button" :class="{ selected: hasAndroidFilter('passkey') }" :aria-pressed="hasAndroidFilter('passkey')" @click="toggleAndroidQuickFilter('passkey')"><m3e-icon name="key_vertical"></m3e-icon>Passkey</button><button type="button" :class="{ selected: hasAndroidFilter('uncategorized') }" :aria-pressed="hasAndroidFilter('uncategorized')" @click="toggleAndroidQuickFilter('uncategorized')"><m3e-icon name="folder_off"></m3e-icon>未分类</button><button type="button" :class="{ selected: hasAndroidFilter('local-only') }" :aria-pressed="hasAndroidFilter('local-only')" @click="toggleAndroidQuickFilter('local-only')"><m3e-icon name="key"></m3e-icon>仅本地</button><button type="button" :class="{ selected: hasAndroidFilter('attachments') }" :aria-pressed="hasAndroidFilter('attachments')" @click="toggleAndroidQuickFilter('attachments')"><m3e-icon name="attach_file"></m3e-icon>附件</button></div></div><footer><m3e-button variant="text" @click="databaseSourceFilter = 'all'; folderFilter = 'all'; activeQuickFilters = []">清除筛选</m3e-button><m3e-button variant="filled" @click="filterDialogOpen = false">完成</m3e-button></footer></section></div>

        <section v-if="activeSection === 'overview'" class="metrics">
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="password"></m3e-icon><p>登录项</p><strong>{{ credentials.length }}</strong><small>加密缓存中的有效项</small></div></m3e-card>
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="inventory_2"></m3e-icon><p>全部项目</p><strong>{{ vaultItems.length + archivedItems.length + deletedItems.length }}</strong><small>含归档与回收站的加密记录</small></div></m3e-card>
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="star"></m3e-icon><p>收藏</p><strong>{{ favoriteCount }}</strong><small>优先匹配的账号</small></div></m3e-card>
        <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="encrypted"></m3e-icon><p>安全状态</p><strong class="metric-word">已解锁</strong><small>15 分钟无操作自动锁定 · 关闭浏览器后自动锁定</small></div></m3e-card>
        </section>

        <section v-if="activeSection === 'overview'" class="content-grid"><m3e-card variant="filled" class="motion-card"><div slot="content" class="getting-started"><span class="feature-icon"><m3e-icon name="auto_fix_high"></m3e-icon></span><div><h2>自动填充基线已连接加密核心</h2><p>Popup 只读取匹配项摘要；点击填充后由后台解密单个登录项并发送给当前网页。</p></div><div class="getting-started-actions"><m3e-button variant="tonal" @click="navigate('passwords')">管理登录项</m3e-button><m3e-button variant="filled" @click="openCreate"><m3e-icon slot="icon" name="add"></m3e-icon>添加登录项</m3e-button></div></div></m3e-card></section>

        <section v-else-if="activeSection === 'passwords'" class="content-grid">
          <m3e-card variant="filled" class="data-card login-data-card motion-card">
            <div slot="header" class="card-head"><h2>全部登录项</h2><p>{{ filteredCredentials.length }} 个结果</p></div>
            <div v-if="filteredCredentials.length" class="table-wrap"><table class="credential-table" aria-label="登录项列表"><thead><tr><th>名称</th><th>用户名</th><th>匹配网站</th><th>更新时间</th><th><span class="visually-hidden">操作</span></th></tr></thead><tbody>
              <tr v-for="item in filteredCredentials" :key="item.id" class="row-clickable" @click="openVaultDetail(item)"><td class="item-cell" data-label="名称"><button class="row-title" type="button" :aria-label="`查看${item.title}详情`" @click="openVaultDetail(item)"><span class="row-icon"><m3e-icon :name="item.favorite ? 'star' : 'language'"></m3e-icon></span><span class="row-title-copy"><strong :title="item.title">{{ item.title }}</strong><small class="credential-compact-summary" :title="credentialCompactSummary(item)">{{ credentialCompactSummary(item) }}</small></span></button></td><td class="credential-detail-cell" data-label="用户名">{{ item.username || '—' }}</td><td class="credential-detail-cell" data-label="匹配网站"><span class="url-list">{{ item.uris.join(' · ') }}</span></td><td class="credential-detail-cell" data-label="更新时间">{{ new Date(item.updatedAt).toLocaleString() }}</td><td class="action-cell" @click.stop><m3e-icon-button v-if="keePassHistoryProvidersFor(item).length" :aria-label="`查看 ${item.title} 的 KeePass 历史`" @click="openKeePassHistory(item)"><m3e-icon name="history"></m3e-icon></m3e-icon-button><m3e-icon-button v-if="attachmentProvidersFor(item).length" :aria-label="`管理 ${item.title} 的附件`" @click="openAttachmentDialog(item)"><m3e-icon name="attach_file"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="编辑登录项" @click="openEdit(item)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="删除登录项" @click="removeCredential(item)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></td></tr>
            </tbody></table></div>
            <div v-else class="empty-state" slot="content"><m3e-icon name="key_off"></m3e-icon><h2>{{ query ? '没有匹配的登录项' : '加密密码库还是空的' }}</h2><p>{{ query ? '换一个关键词试试。' : '添加第一个账号后即可在 Popup 中匹配。' }}</p><m3e-button v-if="!query" variant="filled" @click="openCreate">添加登录项</m3e-button></div>
          </m3e-card>
        </section>

        <section v-else-if="activeSection === 'steam'" class="steam-page">
          <m3e-card v-for="item in filteredSteamItems" :key="item.id" variant="filled" class="motion-card steam-account-card"><div slot="content"><SteamNetworkActions :item="item" :query="query" /></div></m3e-card>
          <div v-if="!filteredSteamItems.length" class="empty-state steam-page-empty"><m3e-icon name="sports_esports"></m3e-icon><h2>{{ query || hasActiveManagerFilter ? '没有匹配的 Steam 项目' : '还没有 Steam 验证器' }}</h2><p>{{ query || hasActiveManagerFilter ? '调整分类或快捷筛选条件。' : '从 Monica Android 同步，或在动态验证码中添加 Steam Guard。' }}</p><m3e-button v-if="!query && !hasActiveManagerFilter" variant="filled" aria-label="添加 Steam Guard 验证器" @click="openVaultCreate('totp')">添加 Steam</m3e-button></div>
        </section>

        <GeneratorPanel v-else-if="activeSection === 'generator'" :providers="webDavProviders" />

        <BitwardenSendsPanel v-else-if="activeSection === 'sends'" :providers="providers" :query="query" />

        <section v-else-if="activeSection === 'timeline'" class="content-grid lifecycle-page">
          <m3e-card variant="filled" class="data-card motion-card">
            <div slot="header" class="card-head"><h2>Android 操作记录</h2><p>{{ androidTimeline.length }} 条</p></div>
            <p v-if="timelineError" class="form-error" slot="content">{{ timelineError }}</p>
            <div v-else-if="androidTimeline.length" class="table-wrap"><table><thead><tr><th>操作</th><th>类型</th><th>变更字段</th><th>设备</th><th>时间</th><th>状态</th></tr></thead><tbody>
              <tr v-for="entry in androidTimeline" :key="`${entry.providerName}:${entry.id}:${entry.timestamp}`"><td data-label="操作"><strong>{{ entry.operationType }}</strong><small class="timeline-title">{{ entry.itemTitle }}</small></td><td data-label="类型">{{ entry.itemType }}</td><td data-label="变更字段">{{ entry.changedFields.join('、') || '—' }}</td><td data-label="设备">{{ entry.deviceName }}<small class="timeline-title">{{ entry.providerName }}</small></td><td data-label="时间">{{ new Date(entry.timestamp).toLocaleString() }}</td><td data-label="状态"><span class="state" :class="entry.reverted ? 'state-attention' : 'state-healthy'">{{ entry.reverted ? '已恢复' : '有效' }}</span></td></tr>
            </tbody></table></div>
            <div v-else class="empty-state" slot="content"><m3e-icon :name="timelineBusy ? 'progress_activity' : 'history'" /><h2>{{ timelineBusy ? '正在读取时间线' : '暂无 Android 时间线' }}</h2><p>{{ timelineBusy ? '正在从已连接的 WebDAV 备份读取。' : 'Android 开启时间线备份后，操作摘要会显示在这里。' }}</p></div>
          </m3e-card>
        </section>

        <section v-else-if="activeSection === 'archive' || activeSection === 'trash'" class="content-grid lifecycle-page">
          <m3e-card variant="filled" class="data-card motion-card">
            <div slot="header" class="card-head"><h2>{{ activeSection === 'archive' ? '已归档项目' : '回收站项目' }}</h2><p>{{ activeSection === 'archive' ? filteredArchiveItems.length : filteredDeletedItems.length }} 个结果</p></div>
            <div v-if="(activeSection === 'archive' ? filteredArchiveItems : filteredDeletedItems).length" slot="content" class="item-grid">
              <article v-for="item in (activeSection === 'archive' ? filteredArchiveItems : filteredDeletedItems)" :key="item.id" class="item-card row-clickable" @click="openVaultDetail(item)">
                <button class="item-card-main" type="button" :aria-label="`查看${item.title}详情`" @click="openVaultDetail(item)"><span class="row-icon"><m3e-icon :name="itemIcon(item.kind)"></m3e-icon></span><span class="item-card-copy"><strong :title="item.title">{{ item.title }}</strong><small>{{ item.kind === 'passkey' ? passkeyAvailabilityLabel(passkeyAvailability(item)) : itemKindLabel(item.kind) }}</small></span></button>
                <div class="item-card-summary"><span class="item-summary-text" :title="itemSafeSummary(item)">{{ itemSafeSummary(item) }}</span></div>
                <div class="item-card-meta"><span :title="providerName(item)">{{ providerName(item) }}</span><time :datetime="item.deletedAt || item.archivedAt || item.updatedAt">{{ new Date(item.deletedAt || item.archivedAt || item.updatedAt).toLocaleDateString() }}</time></div>
                <div class="item-card-actions" @click.stop><m3e-icon-button v-if="activeSection === 'archive' && item.kind === 'login'" :aria-label="`编辑归档的 ${item.title}`" @click="openEdit(item)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button v-if="activeSection === 'archive' && isEditableVaultItem(item) && item.kind !== 'login'" :aria-label="`编辑归档的 ${item.title}`" @click="openVaultEdit(item)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button v-if="activeSection === 'archive'" :aria-label="`取消归档 ${item.title}`" @click="unarchiveItem(item)"><m3e-icon name="unarchive"></m3e-icon></m3e-icon-button><m3e-icon-button v-if="activeSection === 'archive'" :aria-label="`删除归档的 ${item.title}`" @click="removeVaultItem(item)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button><m3e-icon-button v-else :aria-label="`恢复 ${item.title}`" @click="restoreDeletedItem(item)"><m3e-icon name="restore"></m3e-icon></m3e-icon-button></div>
              </article>
            </div>
            <div v-else class="empty-state" slot="content"><m3e-icon :name="activeSection === 'archive' ? 'archive' : 'delete'" /><h2>{{ query ? '没有匹配项目' : activeSection === 'archive' ? '还没有归档项目' : '回收站为空' }}</h2><p>{{ query ? '换一个关键词试试。' : activeSection === 'archive' ? '归档项目会从普通列表和自动填充候选中隐藏。' : 'Bitwarden 软删除项目会保留在这里，恢复前不会永久清除。' }}</p></div>
          </m3e-card>
        </section>

        <section v-else-if="activeSection === 'wallet' || activeSection === 'notes' || activeSection === 'totp' || activeSection === 'passkeys'" class="content-grid">
          <m3e-card variant="filled" class="data-card motion-card">
            <div slot="header" class="card-head"><h2>{{ sectionTitle(activeSection) }}</h2><p>{{ filteredSectionItems.length }} 个结果</p></div>
            <div v-if="filteredSectionItems.length" slot="content" class="item-grid">
              <article v-for="item in filteredSectionItems" :key="item.id" class="item-card row-clickable" @click="openVaultDetail(item)">
                <button class="item-card-main" type="button" :aria-label="`查看${item.title}详情`" @click="openVaultDetail(item)"><span class="row-icon"><m3e-icon :name="item.favorite ? 'star' : itemIcon(item.kind)"></m3e-icon></span><span class="item-card-copy"><strong :title="item.title">{{ item.title }}</strong><small>{{ vaultItemStatus(item) }}<template v-if="item.favorite"> · 已收藏</template></small></span></button>
                <div class="item-card-summary"><template v-if="item.kind === 'totp'"><span class="item-card-otp" @click.stop><TotpCodeCell :item="item" allow-use @used="advanceHotpItem(item)" /></span></template><span v-else class="item-summary-text" :title="itemSafeSummary(item)">{{ itemSafeSummary(item) }}</span></div>
                <div class="item-card-meta"><span :title="providerName(item)">{{ providerName(item) }}</span><time :datetime="item.updatedAt">{{ new Date(item.updatedAt).toLocaleDateString() }}</time></div>
                <div class="item-card-actions" @click.stop><m3e-icon-button v-if="keePassHistoryProvidersFor(item).length" :aria-label="`查看 ${item.title} 的 KeePass 历史`" @click="openKeePassHistory(item)"><m3e-icon name="history"></m3e-icon></m3e-icon-button><m3e-icon-button v-if="attachmentProvidersFor(item).length" :aria-label="`管理 ${item.title} 的附件`" @click="openAttachmentDialog(item)"><m3e-icon name="attach_file"></m3e-icon></m3e-icon-button><m3e-icon-button v-if="isEditableVaultItem(item)" :aria-label="`编辑${itemKindLabel(item.kind)}`" @click="openVaultEdit(item)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button :aria-label="`删除${itemKindLabel(item.kind)}`" @click="removeVaultItem(item)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></div>
              </article>
            </div>
            <div v-else class="empty-state" slot="content"><m3e-icon :name="activeSection === 'wallet' ? 'wallet' : activeSection === 'notes' ? 'note_stack' : activeSection === 'totp' ? 'timer' : 'key_vertical'"></m3e-icon><h2>{{ query ? '没有匹配项目' : `还没有${sectionTitle(activeSection)}` }}</h2><p>{{ query ? '换一个关键词试试。' : '从密码源同步，或使用右上角的添加操作。' }}</p></div>
          </m3e-card>
        </section>

        <section v-else-if="activeSection === 'providers'" class="provider-page">
          <div class="provider-connect-grid" aria-label="添加密码源">
            <m3e-card variant="filled" class="motion-card connect-source-card"><button class="connect-source" type="button" @click="openMdbx2Dialog()"><span class="connect-icon"><m3e-icon name="database"></m3e-icon></span><span><strong>连接 MDBX2 保险库</strong><small>打开本机文件或从 WebDAV 增量加入</small></span><m3e-icon class="connect-arrow" name="arrow_forward"></m3e-icon></button></m3e-card>
            <m3e-card variant="filled" class="motion-card connect-source-card"><button class="connect-source" type="button" @click="newWebDav"><span class="connect-icon"><m3e-icon name="folder_copy"></m3e-icon></span><span><strong>连接 Monica Android WebDAV</strong><small>读取并无损写回 Monica_Backups 快照</small></span><m3e-icon class="connect-arrow" name="arrow_forward"></m3e-icon></button></m3e-card>
            <m3e-card variant="filled" class="motion-card connect-source-card"><button class="connect-source" type="button" @click="openKeePassDialog()"><span class="connect-icon"><m3e-icon name="key"></m3e-icon></span><span><strong>连接 KeePass</strong><small>打开本地 KDBX 或连接 WebDAV 文件</small></span><m3e-icon class="connect-arrow" name="arrow_forward"></m3e-icon></button></m3e-card>
            <m3e-card variant="filled" class="motion-card connect-source-card"><button class="connect-source" type="button" @click="openBitwarden()"><span class="connect-icon"><m3e-icon name="shield"></m3e-icon></span><span><strong>连接 Bitwarden</strong><small>官方 US/EU 或标准自托管服务</small></span><m3e-icon class="connect-arrow" name="arrow_forward"></m3e-icon></button></m3e-card>
          </div>

          <div class="provider-list" aria-label="已连接的密码源">
            <m3e-card v-for="provider in mdbx2Providers" :key="provider.id" variant="filled" class="motion-card source-card"><div slot="content" class="stack">
              <div class="source-title"><span class="source-icon"><m3e-icon name="database"></m3e-icon></span><div><h2>{{ provider.name }}</h2><p>{{ String(provider.config.remotePath || '本机加密工作副本') }}</p></div></div>
              <span class="state" :class="mdbx2StateClass(provider)">{{ mdbx2StateLabel(provider) }}</span>
              <p v-if="provider.lastError" class="form-error">{{ provider.lastError }}</p>
              <div class="mdbx2-card-facts" aria-label="MDBX2 状态摘要">
                <span><strong>{{ mdbx2RuntimeFor(provider.id)?.open ? '已解锁' : '已锁定' }}</strong><small>本机副本</small></span>
                <span><strong>Schema {{ String(provider.config.schemaVersion ?? '—') }}</strong><small>MDBX-2</small></span>
                <span><strong>{{ mdbx2SyncFor(provider.id)?.remoteStreamCount || 0 }}</strong><small>远端 stream</small></span>
                <span><strong>{{ mdbx2SyncFor(provider.id)?.blockedStreamCount || 0 }}</strong><small>受阻 stream</small></span>
              </div>
              <p v-if="mdbx2SyncFor(provider.id)?.hasLocalChanges" class="supporting">本机存在尚未发布的 Commit 或 state delta。</p>
              <div v-if="mdbx2SyncFor(provider.id)?.blockedStreamCount" class="provider-conflict"><strong>远端 stream 已受阻</strong><p>检测到序号缺口、摘要碰撞、缺失父 Commit 或 Blob 未完成。同步不会跳过该位置，也不会静默覆盖。</p></div>
              <div v-for="conflict in conflictsFor(provider.id)" :key="conflict.id" class="provider-conflict"><strong>{{ conflictTitle(conflict) }}</strong><p>{{ conflict.reason }}</p><small>检测于 {{ new Date(conflict.detectedAt).toLocaleString() }}；敏感字段不在此处显示。</small><div v-if="conflict.local || conflict.remote" class="conflict-actions"><m3e-button v-if="conflict.local" variant="tonal" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'keep-local')">保留浏览器版本</m3e-button><m3e-button variant="text" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'use-remote')">{{ conflict.remote ? '采用 MDBX2 版本' : '接受远端删除' }}</m3e-button></div></div>
              <p class="provider-capability-note"><m3e-icon name="info"></m3e-icon><span>可移植 .mdbx 只用于首次加入与完整备份；日常多设备同步使用 Commit DAG、不可变增量段和加密 Blob。MDBX1 不受支持。</span></p>
              <p class="supporting">{{ provider.lastSyncAt ? `上次同步：${new Date(provider.lastSyncAt).toLocaleString()}` : mdbx2SyncFor(provider.id)?.initialized ? '增量同步已注册，尚未执行首次同步。' : '尚未发布或注册 WebDAV bootstrap。' }}</p>
              <div class="source-actions">
                <m3e-button variant="tonal" :disabled="!mdbx2RuntimeFor(provider.id)?.open || Boolean(mdbx2Busy)" @click="openMdbx2BatchTransfer(provider)"><m3e-icon slot="icon" name="drive_file_move"></m3e-icon>批量传输</m3e-button>
                <m3e-button v-if="activeSyncProviderId === provider.id" variant="text" @click="cancelProviderSync(provider)"><m3e-icon slot="icon" name="cancel"></m3e-icon>取消同步</m3e-button>
                <m3e-button v-else-if="mdbx2CanSync(provider)" variant="tonal" :disabled="Boolean(webDavBusy)" @click="syncProvider(provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ queueFor(provider.id)?.failed ? '重试同步' : '立即同步' }}</m3e-button>
                <m3e-button v-else variant="tonal" :disabled="Boolean(mdbx2Busy)" @click="openMdbx2Dialog(provider)"><m3e-icon slot="icon" :name="mdbx2RuntimeFor(provider.id)?.open ? 'cloud_upload' : 'lock_open'"></m3e-icon>{{ mdbx2RuntimeFor(provider.id)?.open ? '配置并发布' : '解锁并设置' }}</m3e-button>
                <m3e-button v-if="mdbx2RuntimeFor(provider.id)?.open" variant="text" :disabled="Boolean(mdbx2Busy)" @click="lockMdbx2(provider)"><m3e-icon slot="icon" name="lock"></m3e-icon>{{ activeMdbx2ProviderId === provider.id && mdbx2Busy === 'lock' ? '锁定中…' : '锁定' }}</m3e-button>
                <m3e-icon-button aria-label="管理 MDBX2" @click="openMdbx2Dialog(provider)"><m3e-icon name="settings"></m3e-icon></m3e-icon-button>
                <m3e-icon-button aria-label="移除 MDBX2" @click="removeProvider(provider)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button>
              </div>
            </div></m3e-card>
            <m3e-card v-for="provider in webDavProviders" :key="provider.id" variant="filled" class="motion-card source-card"><div slot="content" class="stack">
              <div class="source-title"><span class="source-icon"><m3e-icon name="folder_copy"></m3e-icon></span><div><h2>{{ provider.name }}</h2><p>{{ webDavEndpointLabel(provider) }}</p></div></div>
              <span class="state" :class="provider.lastError || conflictsFor(provider.id).length ? 'state-attention' : 'state-healthy'">{{ conflictsFor(provider.id).length ? `${conflictsFor(provider.id).length} 个冲突` : provider.lastError ? '需要处理' : provider.lastSyncAt ? '已同步' : '已连接' }}</span>
              <p v-if="provider.lastError" class="form-error">{{ provider.lastError }}</p>
              <p v-if="queueFor(provider.id)" class="supporting">同步队列：{{ queueFor(provider.id)?.pending }} 项<span v-if="queueFor(provider.id)?.failed"> · {{ queueFor(provider.id)?.failed }} 项失败 · 已尝试 {{ queueFor(provider.id)?.maxAttempts }}/5 次</span></p>
              <div v-for="conflict in conflictsFor(provider.id)" :key="conflict.id" class="provider-conflict"><strong>{{ conflictTitle(conflict) }}</strong><p>{{ conflict.reason }}</p><small>检测于 {{ new Date(conflict.detectedAt).toLocaleString() }}；敏感字段不在此处显示。</small><div v-if="conflict.local || conflict.remote" class="conflict-actions"><m3e-button v-if="conflict.local" variant="tonal" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'keep-local')">保留浏览器版本</m3e-button><m3e-button variant="text" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'use-remote')">{{ conflict.remote ? '采用 Android 版本' : '接受远端删除' }}</m3e-button></div></div>
              <p class="supporting">{{ provider.lastSyncAt ? `上次同步：${new Date(provider.lastSyncAt).toLocaleString()}` : '尚未同步；首次同步会导入最新 Android 快照。' }}</p>
              <div class="source-actions"><m3e-button v-if="activeSyncProviderId === provider.id" variant="text" @click="cancelProviderSync(provider)"><m3e-icon slot="icon" name="cancel"></m3e-icon>取消同步</m3e-button><m3e-button v-else variant="tonal" :disabled="Boolean(webDavBusy)" @click="syncProvider(provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ queueFor(provider.id)?.failed ? '重试同步' : '立即同步' }}</m3e-button><m3e-icon-button aria-label="编辑 WebDAV" @click="editWebDav(provider)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="移除 WebDAV" @click="removeProvider(provider)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></div>
            </div></m3e-card>
            <m3e-card v-for="provider in keePassProviders" :key="provider.id" variant="filled" class="motion-card source-card"><div slot="content" class="stack" :aria-busy="activeKeePassProviderId === provider.id && Boolean(keePassBusy)">
              <div class="source-title"><span class="source-icon"><m3e-icon name="key"></m3e-icon></span><div><h2>{{ provider.name }}</h2><p>{{ String(isRemoteKeePass(provider) ? provider.config.remotePath || 'WebDAV KDBX' : provider.config.fileName || '请选择 .kdbx 文件') }}</p></div></div>
              <span class="state" :class="keePassStateClass(provider)" aria-live="polite">{{ keePassStateLabel(provider) }}</span>

              <template v-if="isRemoteKeePass(provider)">
                <div class="keepass-remote-facts" aria-label="KeePass WebDAV 状态摘要" aria-live="polite">
                  <span><strong>{{ keePassRemoteStatusFor(provider.id)?.sessionState === 'unlocked' ? '已解锁' : keePassRemoteStatusFor(provider.id)?.sessionState === 'restorable' ? '可恢复' : '需重新连接' }}</strong><small>本机会话</small></span>
                  <span><strong>{{ keePassRemoteStatusFor(provider.id)?.workingCopyState === 'ready' ? '工作副本可用' : '工作副本缺失' }}</strong><small>本机加密副本</small></span>
                  <span><strong>{{ keePassRemoteStatusFor(provider.id)?.remoteBaselineState === 'available' ? '远端基线可用' : '远端基线缺失' }}</strong><small>ETag 条件写入</small></span>
                  <span><strong>{{ keePassRemoteStatusFor(provider.id)?.publicationState === 'pending-confirmation' ? '结果待确认' : keePassRemoteStatusFor(provider.id)?.publicationState === 'local-changes' ? '本机有修改' : '同步完成' }}</strong><small>发布状态</small></span>
                </div>
                <div v-if="keePassRemoteErrorPresentationFor(provider)" class="keepass-remote-error" role="alert">
                  <m3e-icon :name="keePassRemoteErrorPresentationFor(provider)?.icon || 'error'"></m3e-icon>
                  <div><strong>{{ keePassRemoteErrorPresentationFor(provider)?.title }}</strong><p>{{ keePassRemoteErrorPresentationFor(provider)?.message }}</p></div>
                  <m3e-button v-if="keePassRemoteErrorPresentationFor(provider)?.action !== 'none'" variant="tonal" :disabled="Boolean(webDavBusy) || Boolean(keePassBusy)" @click="handleKeePassRecoveryAction(provider, keePassRemoteErrorPresentationFor(provider))">{{ keePassRemoteErrorPresentationFor(provider)?.actionLabel }}</m3e-button>
                </div>
                <div v-if="keePassRemoteStatusFor(provider.id)?.publicationState === 'pending-confirmation'" class="provider-dirty-warning" role="status"><m3e-icon name="pending_actions"></m3e-icon><div><strong>上次结果待确认</strong><p>检测到加密持久操作记录。本机工作副本仍保留，恢复会话或再次同步会复用原操作语义。</p></div></div>
                <div v-else-if="keePassRemoteStatusFor(provider.id)?.publicationState === 'local-changes'" class="provider-dirty-warning" role="status"><m3e-icon name="cloud_upload"></m3e-icon><div><strong>本机工作副本有待上传修改</strong><p>修改已经加密保存，浏览器后台重启不会丢失；同步后其他设备才能读取。</p></div></div>
                <p class="supporting">{{ provider.lastSyncAt ? `上次同步：${new Date(provider.lastSyncAt).toLocaleString()}` : keePassRemoteStatusFor(provider.id)?.updatedAt ? `本机副本更新：${new Date(String(keePassRemoteStatusFor(provider.id)?.updatedAt)).toLocaleString()}` : '尚未完成首次同步。' }}</p>
              </template>
              <p v-else-if="provider.lastError" class="form-error">{{ provider.lastError }}</p>

              <div class="provider-session-summary" :class="{ locked: !keePassSessionFor(provider.id) }">
                <template v-if="keePassSessionFor(provider.id)">
                  <span><strong>{{ keePassSessionFor(provider.id)?.itemCount }}</strong><small>项目</small></span>
                  <span><strong>KDBX {{ keePassSessionFor(provider.id)?.versionMajor }}</strong><small>{{ keePassSessionFor(provider.id)?.cipherName || '现有加密算法' }}</small></span>
                  <span><strong>{{ keePassProtectionLabel(provider) }}</strong><small>解锁保护</small></span>
                </template>
                <p v-else-if="isRemoteKeePass(provider)"><m3e-icon name="encrypted"></m3e-icon><span>{{ keePassRemoteStatusFor(provider.id)?.sessionState === 'restorable' ? '本机加密工作副本可恢复，无需重新下载远端文件。' : '请重新连接 WebDAV 文件并验证数据库凭据。' }}</span></p>
                <p v-else><m3e-icon name="lock"></m3e-icon><span>本地文件会话已锁定；需要重新选择文件并解锁。</span></p>
              </div>
              <ul v-if="keePassSessionFor(provider.id)?.warnings.length" class="provider-warning-list" aria-label="KeePass 兼容性提示"><li v-for="warning in keePassSessionFor(provider.id)?.warnings" :key="warning">{{ warning }}</li></ul>
              <p v-if="keePassSessionFor(provider.id)?.skipped.length" class="supporting">有 {{ keePassSessionFor(provider.id)?.skipped.length }} 个本版本无法解析的条目，已保留在 KDBX 中且不会被改写。</p>
              <div v-if="!isRemoteKeePass(provider) && keePassSessionFor(provider.id)?.dirty" class="provider-dirty-warning" role="status"><m3e-icon name="save"></m3e-icon><div><strong>有尚未导出的 KDBX 修改</strong><p>修改只在内存中。请立即导出并手动覆盖原文件；锁库、关闭浏览器或后台重启都会丢失未导出的文件改动。</p></div></div>
              <div v-for="conflict in conflictsFor(provider.id)" :key="conflict.id" class="provider-conflict"><strong>{{ conflictTitle(conflict) }}</strong><p>{{ conflict.reason }}</p><small>检测于 {{ new Date(conflict.detectedAt).toLocaleString() }}；敏感字段不在此处显示。</small><div v-if="conflict.local || conflict.remote" class="conflict-actions"><m3e-button v-if="conflict.local" variant="tonal" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'keep-local')">保留浏览器版本</m3e-button><m3e-button variant="text" :disabled="Boolean(webDavBusy)" @click="resolveProviderConflict(conflict, 'use-remote')">{{ conflict.remote ? '采用 KDBX 版本' : '接受文件删除' }}</m3e-button></div></div>
              <p class="provider-capability-note"><m3e-icon name="info"></m3e-icon><span>{{ isRemoteKeePass(provider) ? 'WebDAV 使用本机加密工作副本和精确 ETag 条件写入；并发修改会重组或明确停止，远端文件不会按最后修改时间静默覆盖。' : '本地文件由浏览器内存编辑，完成后需要导出覆盖原 KDBX。Twofish KDBX 请先在 Monica Android 或 KeePassXC 中转换为 AES-256。' }}</span></p>
              <p v-if="queueFor(provider.id)" class="supporting">同步队列：{{ queueFor(provider.id)?.pending }} 项<span v-if="queueFor(provider.id)?.recovering"> · {{ queueFor(provider.id)?.recovering }} 项正在恢复远端结果</span><span v-if="queueFor(provider.id)?.failed"> · {{ queueFor(provider.id)?.failed }} 项失败 · 已尝试 {{ queueFor(provider.id)?.maxAttempts }}/5 次</span></p>
              <div class="source-actions">
                <m3e-button v-if="activeSyncProviderId === provider.id" variant="text" @click="cancelProviderSync(provider)"><m3e-icon slot="icon" name="cancel"></m3e-icon>取消同步</m3e-button>
                <m3e-button v-else-if="isRemoteKeePass(provider) && keePassRemoteStatusFor(provider.id)?.sessionState === 'restorable'" variant="filled" :disabled="Boolean(keePassBusy) || Boolean(webDavBusy)" @click="restoreKeePassRemoteSession(provider)"><m3e-icon slot="icon" name="restore"></m3e-icon>{{ activeKeePassProviderId === provider.id && keePassBusy === 'restore' ? '恢复中…' : '恢复本机会话' }}</m3e-button>
                <m3e-button v-else variant="tonal" :disabled="!keePassSessionFor(provider.id) || Boolean(keePassBusy) || Boolean(webDavBusy)" @click="syncProvider(provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ queueFor(provider.id)?.failed ? '重试同步' : '立即同步' }}</m3e-button>
                <m3e-button v-if="keePassSessionFor(provider.id)" variant="tonal" :disabled="Boolean(keePassBusy)" @click="openKeePassGroups(provider)"><m3e-icon slot="icon" name="folder_managed"></m3e-icon>管理分组</m3e-button>
                <m3e-button v-if="keePassSessionFor(provider.id)" :variant="!isRemoteKeePass(provider) && keePassSessionFor(provider.id)?.dirty ? 'filled' : 'text'" :disabled="Boolean(keePassBusy)" @click="exportKeePass(provider)"><m3e-icon slot="icon" name="download"></m3e-icon>{{ activeKeePassProviderId === provider.id && keePassBusy === 'export' ? '导出中…' : isRemoteKeePass(provider) ? '导出备份副本' : '导出 KDBX' }}</m3e-button>
                <m3e-button v-if="keePassSessionFor(provider.id)" variant="text" :disabled="Boolean(keePassBusy)" @click="lockKeePass(provider)"><m3e-icon slot="icon" name="lock"></m3e-icon>{{ activeKeePassProviderId === provider.id && keePassBusy === 'lock' ? '锁定中…' : '锁定' }}</m3e-button>
                <m3e-icon-button aria-label="管理 KeePass" @click="openKeePassDialog(provider)"><m3e-icon name="settings"></m3e-icon></m3e-icon-button>
                <m3e-icon-button aria-label="移除 KeePass" @click="removeProvider(provider)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button>
              </div>
            </div></m3e-card>
            <BitwardenProviderCard
              v-for="provider in bitwardenProviders"
              :key="provider.id"
              :provider="provider"
              :queue="queueFor(provider.id)"
              :conflicts="conflictsFor(provider.id)"
              :active-sync="activeSyncProviderId === provider.id"
              :busy="Boolean(webDavBusy)"
              @sync="syncProvider"
              @cancel="cancelProviderSync"
              @empty-remote="confirmBitwardenEmptyRemote"
              @resolve-conflict="resolveProviderConflict"
              @folders="openBitwardenFolders"
              @collections="openBitwardenCollections"
              @relogin="openBitwarden"
              @logout="logoutBitwarden"
              @remove="removeProvider"
            />
            <m3e-card variant="filled" class="motion-card source-card"><div slot="content" class="stack"><div class="source-title"><span class="source-icon"><m3e-icon name="database"></m3e-icon></span><div><h2>Monica 本地库</h2><p>加密 IndexedDB 信封</p></div></div><p class="supporting">{{ externalProviders.length ? '可与外部密码源并存。' : '当前唯一的密码源。' }}</p><span class="state state-healthy">已连接</span><div class="source-actions"><m3e-button variant="tonal" :disabled="diagnosticBusy" @click="exportProviderDiagnostics"><m3e-icon slot="icon" name="download"></m3e-icon>{{ diagnosticBusy ? '正在导出…' : '导出脱敏诊断' }}</m3e-button></div></div></m3e-card>
          </div>
        </section>

        <section v-else class="settings-grid settings-page">
          <AppearancePanel class="motion-card" />
          <m3e-card variant="filled" class="motion-card"><div slot="content" class="stack">
            <button class="settings-entry" type="button" @click="openAutofillSitePolicyDialog">
              <span class="settings-entry-icon"><m3e-icon name="domain_disabled" aria-hidden="true"></m3e-icon></span>
              <span><strong>自动填充排除项</strong><small>自动填充 {{ autofillSitePolicy.blockedHosts.length }} 个 · 保存提示 {{ autofillSitePolicy.saveBlockedHosts.length }} 个</small></span>
              <m3e-icon class="settings-entry-chevron" name="chevron_right" aria-hidden="true"></m3e-icon>
            </button>
          </div></m3e-card>
          <AutofillSitePolicyDialog :open="autofillSitePolicyDialogOpen" @close="autofillSitePolicyDialogOpen = false" @saved="refreshAutofillSitePolicy" />
          <m3e-card variant="filled" class="motion-card windows-hello-card"><div slot="content" class="stack">
            <details class="settings-disclosure hello-disclosure">
              <summary><span><strong>Windows Hello</strong><small>{{ windowsHelloStatus?.native.available ? '设备可用' : '设备不可用' }} · {{ windowsHelloProtectionMode === 'device-key' ? '设备密钥' : windowsHelloProtectionMode === 'master-password' ? '主密码' : '保护方式未知' }}</small></span><span class="settings-entry-icon"><m3e-icon name="fingerprint" aria-hidden="true"></m3e-icon></span><m3e-icon class="settings-disclosure-chevron" name="expand_more" aria-hidden="true"></m3e-icon></summary>
              <div class="settings-disclosure-content">
            <p class="supporting">使用 Windows Hello 保护设备密钥；私钥不离开本机。</p>
            <div v-if="windowsHelloStatus" class="hello-status-grid" aria-live="polite"><span><strong>{{ windowsHelloStatus.native.available ? '设备可用' : '设备不可用' }}</strong><small>平台验证器</small></span><span><strong>{{ windowsHelloStatus.vaultEnrolled ? windowsHelloStatus.bindingConsistent ? '已注册' : '绑定异常' : '未注册' }}</strong><small>当前密码库</small></span><span><strong>{{ windowsHelloStatus.protectionMode === 'device-key' ? '设备密钥' : windowsHelloStatus.protectionMode === 'master-password' ? '主密码' : '未知' }}</strong><small>保护方式</small></span></div>
            <p v-if="windowsHelloStatus && !windowsHelloStatus.native.available" class="supporting">Windows Hello Host 或平台验证器当前不可用。</p>
            <p v-else-if="windowsHelloStatus?.protectionMode === 'master-password'" class="supporting">当前使用主密码保护。转换为设备密钥后才能使用 Windows Hello 免输入解锁。</p>
            <p v-else-if="windowsHelloStatus?.vaultEnrolled && !windowsHelloStatus.bindingConsistent" class="supporting">加密密码库记录与 Native Host 本机凭据不一致。当前保持锁定；撤销失效绑定后可重新注册。</p>
            <p v-else-if="windowsHelloStatus?.vaultEnrolled" class="supporting">每次自动锁定后需要重新完成系统验证；取消、超时和 Native Host 异常均保持锁定。</p>
            <p v-else class="supporting">解锁密码库后即可注册本机凭据。</p>
            <div class="source-actions"><m3e-button v-if="!windowsHelloStatus?.vaultEnrolled" variant="filled" aria-label="注册 Windows Hello 本机凭据" :disabled="Boolean(windowsHelloBusy) || windowsHelloStatus?.protectionMode !== 'device-key' || !windowsHelloStatus?.native.available" @click="enrollWindowsHello"><m3e-icon slot="icon" name="fingerprint"></m3e-icon>{{ windowsHelloBusy === 'enroll' ? '正在注册…' : '注册本机凭据' }}</m3e-button><m3e-button v-else variant="text" :disabled="Boolean(windowsHelloBusy)" @click="revokeWindowsHello"><m3e-icon slot="icon" name="delete"></m3e-icon>{{ windowsHelloBusy === 'revoke' ? '正在撤销…' : '撤销本机绑定' }}</m3e-button><m3e-button variant="text" :disabled="Boolean(windowsHelloBusy)" @click="refreshWindowsHelloStatus"><m3e-icon slot="icon" name="refresh"></m3e-icon>刷新状态</m3e-button></div>
            <p v-if="windowsHelloError" class="form-error" role="alert">{{ windowsHelloError }}</p>
              </div>
            </details>
          </div></m3e-card>
          <m3e-card variant="filled" class="motion-card settings-list-card"><div slot="content">
            <details class="settings-disclosure backup-disclosure">
              <summary><span><strong>加密整库备份</strong><small>导出或恢复完整密码库</small></span><span class="settings-entry-icon"><m3e-icon name="encrypted" aria-hidden="true"></m3e-icon></span><m3e-icon class="settings-disclosure-chevron" name="expand_more" aria-hidden="true"></m3e-icon></summary>
              <div class="settings-disclosure-content">
            <p class="supporting">使用独立密码加密备份。</p>
            <m3e-button variant="tonal" aria-label="导出加密整库备份" :disabled="Boolean(securityBusy)" @click="openExportBackupDialog"><m3e-icon slot="icon" name="encrypted"></m3e-icon>{{ securityBusy === 'export' ? '正在导出…' : '导出备份' }}</m3e-button>
            <label class="file-action"><m3e-icon name="upload"></m3e-icon><span>选择加密整库备份</span><input type="file" accept="application/json,.json" @change="selectEncryptedBackup" /></label>
            <template v-if="selectedEncryptedBackup">
              <p class="supporting">已选择：{{ selectedEncryptedBackupName }}</p>
              <label class="field"><span>备份密码</span><input v-model="restoreForm.backupPassword" type="password" autocomplete="current-password" /></label>
              <label class="field"><span>恢复前的当前主密码</span><input v-model="restoreForm.currentPassword" type="password" autocomplete="current-password" /><small>{{ restoreCurrentPasswordHint }}</small></label>
              <m3e-button variant="filled" :disabled="Boolean(securityBusy)" @click="restoreEncryptedVault">{{ securityBusy === 'restore' ? '正在验证并恢复…' : '验证并替换当前密码库' }}</m3e-button>
            </template>
              </div>
            </details>
          </div></m3e-card>
          <m3e-card variant="filled" class="motion-card"><div slot="content" class="stack">
            <button class="settings-entry" type="button" @click="passwordChangeDialogOpen = true"><span class="settings-entry-icon"><m3e-icon name="key_vertical" aria-hidden="true"></m3e-icon></span><span><strong>更改保护方式</strong><small>留空使用设备密钥；填写则使用 Argon2id。</small></span><m3e-icon class="settings-entry-chevron" name="chevron_right" aria-hidden="true"></m3e-icon></button>
            <Teleport to="body">
            <div v-if="passwordChangeDialogOpen" class="settings-modal" role="presentation" @click.self="passwordChangeDialogOpen = false">
              <section class="settings-modal-panel" role="dialog" aria-modal="true" aria-labelledby="password-change-title">
                <header class="settings-modal-header"><div><h2 id="password-change-title">更改保护方式</h2><p>留空使用设备密钥；填写则使用 Argon2id。</p></div><button class="settings-modal-close" type="button" aria-label="关闭更改保护方式" @click="passwordChangeDialogOpen = false"><m3e-icon name="close"></m3e-icon></button></header>
                <div class="settings-modal-content">
                <label class="field"><span>当前主密码（设备密钥模式留空）</span><input v-model="passwordChange.currentPassword" type="password" autocomplete="current-password" /></label>
                <label class="field"><span>新主密码（可选）</span><input v-model="passwordChange.newPassword" type="password" :minlength="passwordChange.newPassword ? MIN_MASTER_PASSWORD_LENGTH : undefined" autocomplete="new-password" /></label>
                <label class="field"><span>确认新主密码</span><input v-model="passwordChange.confirmation" type="password" :minlength="passwordChange.confirmation ? MIN_MASTER_PASSWORD_LENGTH : undefined" autocomplete="new-password" /></label>
                <m3e-button variant="filled" :disabled="Boolean(securityBusy)" @click="changeMasterPassword">{{ securityBusy === 'password' ? '正在重新加密…' : '更改主密码' }}</m3e-button>
                <p v-if="securityError" class="form-error" role="alert">{{ securityError }}</p>
                </div>
              </section>
            </div>
            </Teleport>
          </div></m3e-card>
          <m3e-card variant="filled" class="motion-card settings-list-card"><div slot="content"><details class="settings-disclosure"><summary><span><strong>明文手动迁移</strong><small>导出项目或导入 JSON / CSV</small></span><span class="settings-entry-icon"><m3e-icon name="swap_vert" aria-hidden="true"></m3e-icon></span><m3e-icon class="settings-disclosure-chevron" name="expand_more" aria-hidden="true"></m3e-icon></summary><div class="settings-disclosure-content"><p class="supporting">明文文件不包含密码源，请保存到可信位置。</p><m3e-button variant="tonal" aria-label="导出明文 JSON" @click="exportVault"><m3e-icon slot="icon" name="download"></m3e-icon>导出 JSON</m3e-button><label class="file-action"><m3e-icon name="upload"></m3e-icon><span>导入明文 JSON / CSV</span><input type="file" accept="application/json,.json,.csv,text/csv" @change="importVault" /></label></div></details></div></m3e-card>
          <m3e-card variant="filled" class="motion-card settings-list-card"><div slot="content"><details class="settings-disclosure"><summary><span><strong>安全边界</strong><small>AES-256-GCM · 会话级解锁</small></span><span class="settings-entry-icon"><m3e-icon name="security" aria-hidden="true"></m3e-icon></span><m3e-icon class="settings-disclosure-chevron" name="expand_more" aria-hidden="true"></m3e-icon></summary><div class="settings-disclosure-content"><div class="boundary-row"><m3e-icon name="encrypted"></m3e-icon><span>持久数据使用 AES-256-GCM 加密</span></div><div class="boundary-row"><m3e-icon name="timer"></m3e-icon><span>解锁密钥仅保留在浏览器会话存储</span></div><div class="boundary-row"><m3e-icon name="visibility_off"></m3e-icon><span>内容脚本无法读取完整密码库</span></div></div></details></div></m3e-card>
          <p v-if="securityError" class="form-error settings-message" role="alert">{{ securityError }}</p>
        </section>
      </main>
    </div>

    <VaultItemDetail v-if="vaultDetailItem" :item="vaultDetailItem" :providers="providers" @close="vaultDetailItem = undefined" @edit="editFromDetail" />

    <VaultItemEditor v-if="vaultEditorOpen" :item="vaultEditorItem" :initial-kind="vaultEditorKind" :providers="providers" @cancel="vaultEditorOpen = false" @save="saveVaultItem" />

    <Mdbx2BatchTransferDialog
      v-if="mdbx2BatchTransferDialogOpen"
      :items="vaultItems"
      :providers="providers"
      :runtime-statuses="mdbx2RuntimeStatuses"
      :initial-target-provider-id="mdbx2BatchTransferTargetProviderId"
      @close="closeMdbx2BatchTransfer"
      @completed="handleMdbx2BatchTransferCompleted"
      @notice="showNotice"
    />

    <Mdbx2SourceDialog
      v-if="mdbx2DialogOpen"
      :provider="editingMdbx2Provider"
      :initial-mode="mdbx2DialogMode"
      :host-status="mdbx2HostStatus"
      :runtime-status="editingMdbx2Id ? mdbx2RuntimeFor(editingMdbx2Id) : undefined"
      :sync-status="editingMdbx2Id ? mdbx2SyncFor(editingMdbx2Id) : undefined"
      @close="closeMdbx2Dialog"
      @changed="handleMdbx2Changed"
      @notice="showNotice"
      @host-status="mdbx2HostStatus = $event"
    />

    <ProviderAttachmentsDialog
      v-if="attachmentDialogOpen && attachmentDialogItem"
      :key="`${attachmentDialogItem.id}:${attachmentDialogProviders.map((provider) => provider.id).join(',')}`"
      :item="attachmentDialogItem"
      :providers="attachmentDialogProviders"
      @close="closeAttachmentDialog"
      @notice="showNotice"
    />

    <KeePassHistoryDialog
      v-if="keePassHistoryItem"
      :key="`${keePassHistoryItem.id}:${keePassHistoryProviders.map((provider) => provider.id).join(',')}`"
      :item="keePassHistoryItem"
      :providers="keePassHistoryProviders"
      @close="closeKeePassHistory"
      @changed="handleKeePassHistoryChanged"
      @notice="showNotice"
    />

    <KeePassGroupsDialog
      v-if="keePassGroupsProvider"
      :key="keePassGroupsProvider.id"
      :provider="keePassGroupsProvider"
      @close="closeKeePassGroups"
      @changed="handleKeePassGroupsChanged"
      @notice="showNotice"
    />

    <BitwardenFoldersDialog
      v-if="bitwardenFoldersProvider"
      :key="bitwardenFoldersProvider.id"
      :provider="bitwardenFoldersProvider"
      :items="vaultItems"
      @close="closeBitwardenFolders"
      @changed="handleBitwardenFoldersChanged"
      @notice="showNotice"
    />

    <BitwardenCollectionsDialog
      v-if="bitwardenCollectionsProvider"
      :key="bitwardenCollectionsProvider.id"
      :provider="bitwardenCollectionsProvider"
      :items="vaultItems"
      @close="closeBitwardenCollections"
      @changed="handleBitwardenFoldersChanged"
      @notice="showNotice"
    />

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

    <div v-if="keePassDialogOpen" class="modal-backdrop" role="presentation" @mousedown.self="closeKeePassDialog"><section class="editor-dialog provider-dialog keepass-provider-dialog" role="dialog" aria-modal="true" aria-labelledby="keepass-dialog-title"><header><div><h2 id="keepass-dialog-title">{{ keePassDialogTitle }}</h2><p>{{ keePassForm.sourceMode === 'webdav' ? 'WebDAV 与 KDBX 凭据会加密保存在 Monica 密码库中，本机工作副本仅保存 KDBX 密文。' : '本地文件密码和密钥文件仅用于当前后台会话。' }}</p></div><m3e-icon-button aria-label="关闭 KeePass 设置" :disabled="keePassBusy === 'open'" @click="closeKeePassDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header>
      <form class="provider-form" @submit.prevent="connectKeePass">
        <fieldset class="login-type-picker keepass-source-picker field-wide"><legend>来源</legend><div class="login-type-segments keepass-source-segments"><label><input v-model="keePassForm.sourceMode" type="radio" value="local-file" @change="keePassError = ''; keePassDialogNotice = ''" /><span>本地文件</span></label><label><input v-model="keePassForm.sourceMode" type="radio" value="webdav" @change="keePassError = ''; keePassDialogNotice = ''" /><span>WebDAV 文件</span></label></div></fieldset>
        <label class="field"><span>显示名称</span><input v-model="keePassForm.name" autofocus autocomplete="off" placeholder="KeePass" /></label>
        <div class="field"><span>当前保护方式</span><div class="protection-preview" aria-live="polite"><m3e-icon :name="keePassKeyFile || keePassForm.keyFileConfigured ? 'key' : 'password'"></m3e-icon><strong>{{ keePassProtectionPreview }}</strong></div><small>密码允许留空；数据库必须与密码和密钥文件组合匹配。</small></div>

        <template v-if="keePassForm.sourceMode === 'local-file'">
          <div class="field field-wide"><span>KeePass 数据库文件 *</span><label class="file-action provider-file-action"><m3e-icon name="folder_open"></m3e-icon><span>{{ keePassDatabaseFile?.name || (keePassForm.currentFileName ? '重新选择 ' + keePassForm.currentFileName : '选择 .kdbx 文件') }}</span><input ref="keePassFileInput" type="file" accept=".kdbx,application/octet-stream" aria-label="KeePass 数据库文件" @change="selectKeePassDatabase" /></label><small>浏览器不会保存文件内容或可写句柄；后台重启后需要重新选择。</small></div>
        </template>
        <template v-else>
          <label class="field"><span>WebDAV 地址</span><input v-model="keePassForm.baseUrl" autocomplete="off" placeholder="https://dav.example.com/files" /></label>
          <label class="field"><span>用户名</span><input v-model="keePassForm.username" autocomplete="username" /></label>
          <label class="field"><span>WebDAV 密码</span><input v-model="keePassForm.webDavPassword" type="password" autocomplete="current-password" :placeholder="keePassForm.webDavPasswordConfigured ? '已加密保存；留空保持不变' : ''" /></label>
          <label class="field"><span>远端 .kdbx 位置</span><input v-model="keePassForm.remotePath" autocomplete="off" placeholder="vaults/main.kdbx" /></label>
        </template>

        <div class="field field-wide"><span>密钥文件（可选）</span><label class="file-action provider-file-action secondary"><m3e-icon name="key"></m3e-icon><span>{{ keePassKeyFile?.name || (keePassForm.sourceMode === 'webdav' && keePassForm.keyFileConfigured ? '已加密保存；选择新文件可替换' : '选择 .key / .keyx / XML / 二进制密钥文件') }}</span><input ref="keePassKeyFileInput" type="file" aria-label="密钥文件（可选）" @change="selectKeePassKeyFile" /></label><small>兼容 KeePass XML v1/v2、32 字节二进制、64 位十六进制文本及任意文件哈希模式。</small></div>
        <label class="field field-wide"><span>数据库密码（可留空）</span><div class="password-field"><input v-model="keePassForm.password" :type="revealKeePassPassword ? 'text' : 'password'" autocomplete="current-password" :placeholder="keePassForm.sourceMode === 'webdav' && keePassForm.databaseCredentialStored ? '已加密保存；留空保持不变' : ''" /><button type="button" @click="revealKeePassPassword = !revealKeePassPassword">{{ revealKeePassPassword ? '隐藏' : '显示' }}</button></div><small>长度不受限制；编辑远端来源时留空沿用现有加密凭据。</small></label>
        <label class="favorite-row field-wide"><input v-model="keePassForm.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
        <div class="provider-boundaries field-wide" aria-label="KeePass 浏览器能力边界">
          <div class="boundary-row"><m3e-icon name="info"></m3e-icon><span>{{ keePassForm.sourceMode === 'webdav' ? '远端写入使用精确 ETag；字段或结构冲突会停止覆盖，并保留本机加密工作副本。' : '本地文件只在内存编辑，需要导出覆盖原 KDBX；Twofish 需先转换为 AES-256。' }}</span></div>
        </div>
        <p v-if="keePassDialogNotice" class="keepass-dialog-notice field-wide" role="status" aria-live="polite"><m3e-icon name="check_circle"></m3e-icon><span>{{ keePassDialogNotice }}</span></p>
        <p v-if="keePassError" class="form-error field-wide" role="alert">{{ keePassError }}</p>
        <footer class="provider-actions field-wide"><m3e-button variant="text" type="button" :disabled="keePassBusy === 'open'" @click="closeKeePassDialog">取消</m3e-button><m3e-button v-if="keePassForm.sourceMode === 'webdav'" variant="tonal" type="button" :disabled="Boolean(keePassBusy)" @click="testKeePassWebDav">{{ keePassBusy === 'test' ? '测试中…' : '测试连接' }}</m3e-button><m3e-button variant="filled" type="submit" :disabled="Boolean(keePassBusy)">{{ keePassBusy === 'open' ? '正在验证并解锁…' : keePassForm.sourceMode === 'webdav' ? editingKeePassId ? '保存并重新连接' : '连接并解锁' : editingKeePassId ? '重新选择并解锁' : '解锁并连接' }}</m3e-button></footer>
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
          <p v-if="sshBitwardenFormatHint" class="ssh-format-hint">{{ sshBitwardenFormatHint }}</p>
          <label class="field"><span>算法</span><input v-model="form.sshKey.algorithm" list="ssh-algorithms" autocomplete="off" :readonly="nativeBitwardenSshEdit" /><datalist id="ssh-algorithms"><option value="ED25519"></option><option value="RSA"></option></datalist></label>
          <label class="field"><span>密钥位数</span><input v-model.number="form.sshKey.keySize" type="number" min="0" step="1" inputmode="numeric" /></label>
          <label class="field field-wide"><span>OpenSSH 公钥</span><textarea v-model="form.sshKey.publicKeyOpenSsh" rows="3" spellcheck="false"></textarea></label>
          <label class="field field-wide"><span>OpenSSH 私钥</span><textarea v-model="form.sshKey.privateKeyOpenSsh" rows="7" spellcheck="false"></textarea></label>
          <label class="field"><span>SHA-256 指纹</span><input v-model="form.sshKey.fingerprintSha256" autocomplete="off" /></label>
          <label class="field"><span>注释</span><input v-model="form.sshKey.comment" autocomplete="off" /></label>
          <label class="field"><span>格式</span><input v-model="form.sshKey.format" autocomplete="off" /></label>
          <details class="special-advanced field-wide"><summary>Android 原始元数据</summary><label class="field"><span>JSON</span><textarea v-model="form.sshKeyDataRaw" rows="6" spellcheck="false"></textarea><small>未知字段逐项保留；应用后同步到上方已知字段。</small></label><m3e-button variant="tonal" type="button" @click="applySpecialRaw">应用原始元数据</m3e-button></details>
        </fieldset>
      </template>
      <label v-else-if="form.loginType === 'BARCODE'" class="field field-wide"><span>条码内容</span><input v-model="form.barcodeContent" aria-label="条码内容" autocomplete="off" spellcheck="false" /><small>按 Monica Android 格式保存到密码字段。</small></label>
      <fieldset v-if="isSpecialLoginType" class="editor-fieldset special-transfer field-wide"><legend>{{ form.loginType === 'BARCODE' ? '复制与条码' : '复制与二维码' }}</legend><div v-if="form.loginType === 'BARCODE'" class="barcode-render-modes" role="radiogroup" aria-label="条码显示方式"><label><input v-model="barcodeRenderMode" type="radio" value="qr" @change="clearSpecialQr" /><span>QR</span></label><label><input v-model="barcodeRenderMode" type="radio" value="code128" @change="clearSpecialQr" /><span>Code 128</span></label></div><div class="special-transfer-actions"><m3e-button variant="tonal" type="button" @click="copySpecialPayload"><m3e-icon slot="icon" name="content_copy"></m3e-icon>复制</m3e-button><m3e-button variant="text" type="button" @click="refreshSpecialQr"><m3e-icon slot="icon" :name="form.loginType === 'BARCODE' && barcodeRenderMode === 'code128' ? 'barcode' : 'qr_code_2'"></m3e-icon>{{ form.loginType === 'BARCODE' && barcodeRenderMode === 'code128' ? '生成条码' : '生成二维码' }}</m3e-button></div><img v-if="specialQrDataUrl" :class="{ 'barcode-linear-preview': form.loginType === 'BARCODE' && barcodeRenderMode === 'code128' }" :src="specialQrDataUrl" :alt="form.loginType === 'BARCODE' ? `BARCODE ${barcodeRenderMode === 'code128' ? 'Code 128 条码' : 'QR 二维码'}` : `${form.loginType} 二维码`" width="240" :height="form.loginType === 'BARCODE' && barcodeRenderMode === 'code128' ? 96 : 240" /><p v-if="specialQrError" class="form-error" role="alert">{{ specialQrError }}</p></fieldset>
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
      <label class="field"><span>组织 SSO 标识（可选）</span><input v-model="bitwardenForm.ssoOrganizationIdentifier" autocomplete="off" placeholder="仅企业 SSO 账户填写" /><small>填写后将通过 Bitwarden 官方 OAuth 窗口登录，回调只在后台校验。</small></label>
      <label v-if="bitwardenDeviceVerificationRequired" class="field"><span>新设备验证码 *</span><input v-model="bitwardenForm.newDeviceOtp" inputmode="numeric" autocomplete="one-time-code" required autofocus /><small>Bitwarden 已向账号邮箱发送新设备验证码，验证后即可连接。</small></label>
      <template v-else-if="bitwardenTwoFactorProviders.length"><label class="field"><span>两步验证方式</span><select v-model.number="bitwardenForm.twoFactorProvider"><option v-for="provider in bitwardenTwoFactorProviders" :key="provider" :value="provider">{{ twoFactorName(provider) }}</option></select></label><label v-if="![2, 4, 5].includes(bitwardenForm.twoFactorProvider)" class="field"><span>验证码 *</span><input v-model="bitwardenForm.twoFactorCode" autocomplete="one-time-code" required autofocus /></label><div v-else class="boundary-row"><m3e-icon name="key"></m3e-icon><span>点击连接后会打开 Bitwarden 安全验证页面，验证结果只在后台转交给登录接口。</span></div><m3e-button v-if="bitwardenForm.twoFactorProvider === 1" variant="tonal" type="button" :disabled="bitwardenBusy" @click="sendBitwardenEmailCode">发送邮箱验证码</m3e-button><label class="favorite-row"><input v-model="bitwardenForm.rememberTwoFactor" type="checkbox" /><span>让 Bitwarden 记住此设备</span></label></template>
       <label class="favorite-row"><input v-model="bitwardenForm.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
      <p v-if="bitwardenError" class="form-error" role="alert">{{ bitwardenError }}</p>
      <div class="boundary-row"><m3e-icon name="verified_user"></m3e-icon><span>支持个人与组织共享 Cipher；缺失组织密钥的项目会保留本地缓存并给出提示。</span></div>
      <footer><m3e-button variant="text" type="button" @click="closeBitwardenDialog">取消</m3e-button><m3e-button variant="filled" type="submit" :disabled="bitwardenBusy">{{ bitwardenBusy ? '连接中…' : bitwardenDeviceVerificationRequired ? '验证新设备并连接' : bitwardenTwoFactorProviders.length ? '验证并连接' : bitwardenForm.ssoOrganizationIdentifier.trim() ? '打开 SSO 并连接' : '登录并连接' }}</m3e-button></footer>
    </form></section></div>

    <M3eConfirmationDialog
      v-if="confirmationDialog"
      :title="confirmationDialog.title"
      :message="confirmationDialog.message"
      :context="confirmationDialog.context"
      :confirm-label="confirmationDialog.confirmLabel"
      :tone="confirmationDialog.tone"
      :busy="confirmationBusy"
      :error="confirmationError"
      @close="closeConfirmationDialog"
      @confirm="submitConfirmationAction"
    />

    <div v-if="exportBackupDialogOpen" class="modal-backdrop" role="presentation" @mousedown.self="closeExportBackupDialog"><section class="editor-dialog backup-password-dialog" role="dialog" aria-modal="true" aria-labelledby="export-backup-title"><header><div><h2 id="export-backup-title">导出加密整库备份</h2><p>设置独立备份密码；恢复时需要此密码，与当前主密码互不影响。</p></div><m3e-icon-button aria-label="关闭" @click="closeExportBackupDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header><form class="editor-form" @submit.prevent="submitExportBackup">
      <label class="field"><span>备份密码 *</span><input v-model="exportBackupForm.password" type="password" :minlength="MIN_BACKUP_PASSWORD_LENGTH" autocomplete="new-password" autofocus /></label>
      <label class="field"><span>确认备份密码 *</span><input v-model="exportBackupForm.confirmation" type="password" :minlength="MIN_BACKUP_PASSWORD_LENGTH" autocomplete="new-password" /></label>
      <p v-if="exportBackupError" class="form-error" role="alert">{{ exportBackupError }}</p>
      <footer><m3e-button variant="text" type="button" @click="closeExportBackupDialog">取消</m3e-button><m3e-button variant="filled" type="submit" :disabled="Boolean(securityBusy)">{{ securityBusy === 'export' ? '正在导出…' : '加密导出' }}</m3e-button></footer>
    </form></section></div>
  </m3e-theme>
</template>
