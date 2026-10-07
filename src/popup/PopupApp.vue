<script setup lang="ts">
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { tr } from '../i18n';
import { formatAutofillCredential } from '../autofill/credential-identity';

import "@m3e/web/theme";
import "@m3e/web/button";
import "@m3e/web/icon";
import "@m3e/web/icon-button";
import ListPagination from "../components/ListPagination.vue";
import PopupLoginRow from "./PopupLoginRow.vue";
import { openVaultSidePanel } from "./side-panel";
import WebsiteIcon from "../components/WebsiteIcon.vue";
import { websiteIconCache } from "../lib/website-icon-cache";
import { useListPagination } from "../lib/list-pagination";
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { connectLiveVault } from "../runtime/live-vault";
import { normalizeHost } from "../core/matching";
import { activeScheme, themeColor, useThemePreferences } from "../lib/theme";
import { ExtensionRuntimeError, vaultClient } from "../runtime/client";
import type { LoginMatchSummary, PasskeyMatchSummary, WalletFillKind, WalletMatchSummary } from "../runtime/messages";
import type { VaultLifecycleStatus } from "../security/secure-vault-service";
import type { AutofillFieldContext } from "../content/field-signature";

interface PageScan {
  ok: boolean;
  url: string;
  origin: string;
  host: string;
  title: string;
  hasUsernameField: boolean;
  hasPasswordField: boolean;
  hasTotpField: boolean;
  walletKinds: WalletFillKind[];
  hasFocusedLoginField: boolean;
  frameId: number;
  documentId: string;
  currentField?: AutofillFieldContext;
}

const loading = ref(true);
const unlocking = ref(false);
const fillingId = ref<string | null>(null);
const status = ref("");
const error = ref("");
const runtimeReloadRequired = ref(false);
const masterPassword = ref("");
const lifecycle = ref<VaultLifecycleStatus>("locked");
const tabId = ref<number | null>(null);
const windowId = ref<number | null>(null);
const sidePanelAvailable = typeof chrome.sidePanel?.open === "function";
const tabUrl = ref("");
const tabTitle = ref("");
const scans = shallowRef<PageScan[]>([]);
const selectedFrameId = ref(0);
const matches = shallowRef<LoginMatchSummary[]>([]);
const passkeys = shallowRef<PasskeyMatchSummary[]>([]);
const walletItems = shallowRef<WalletMatchSummary[]>([]);
const allLogins = shallowRef<LoginMatchSummary[]>([]);
const search = ref("");
const pageUnsupported = ref(false);
const currentFieldBlocked = ref(false);
const fieldPolicyBusy = ref(false);
let initializeRevision = 0;
let matchRevision = 0;
let disconnectLiveVault: (() => void) | undefined;

useThemePreferences();
const scan = computed(() => scans.value.find((candidate) => candidate.frameId === selectedFrameId.value) || scans.value[0] || null);
const fillTargets = computed(() => scans.value.filter((candidate) => candidate.hasUsernameField || candidate.hasPasswordField || candidate.hasTotpField || candidate.walletKinds.length));
const currentHost = computed(() => normalizeHost(scan.value?.url || tabUrl.value) || tr('当前页面'));
const fillPageAllowed = computed(() => isSensitivePageAllowed(scan.value?.url || tabUrl.value));
const canFill = computed(() => !pageUnsupported.value && fillPageAllowed.value && !currentFieldBlocked.value && Boolean(scan.value));
const readyPasskeys = computed(() => passkeys.value.filter((item) => item.availability === "ready"));
const capabilityLabel = computed(() => lifecycle.value === "locked" && matches.value.length ? tr('免解锁填写') : matches.value.length || walletItems.value.length ? tr('可选择填充') : readyPasskeys.value.length ? tr('Passkey 已保存') : "");

onMounted(() => {
  (window as unknown as { __monicaPopupRefresh?: () => Promise<void> }).__monicaPopupRefresh = initialize;
  void initialize();
  chrome.storage.onChanged.addListener(onSessionChanged);
  disconnectLiveVault = connectLiveVault(async () => {
    if (lifecycle.value === "unlocked" && !loading.value) await loadMatches();
  });
});
onUnmounted(() => {
  disconnectLiveVault?.();
  initializeRevision += 1;
  matchRevision += 1;
  chrome.storage.onChanged.removeListener(onSessionChanged);
});

function onSessionChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== "session" || !Object.values(changes).some((change) => {
    const previous = change.oldValue as { rawKey?: unknown } | undefined;
    const next = change.newValue as { rawKey?: unknown } | undefined;
    return previous?.rawKey !== next?.rawKey;
  })) return;
  matchRevision += 1;
  matches.value = [];
  passkeys.value = [];
  walletItems.value = [];
  allLogins.value = [];
  search.value = "";
  masterPassword.value = "";
  lifecycle.value = "locked";
  websiteIconCache.clear();
  void initialize(true);
}

async function initialize(preserveTarget = false) {
  runtimeReloadRequired.value = false;
  const revision = ++initializeRevision;
  matchRevision += 1;
  loading.value = true;
  error.value = "";
  try {
    const tab = preserveTarget && tabId.value !== null
      ? await chrome.tabs.get(tabId.value)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab?.id) throw new Error(tr('无法读取当前标签页。'));
    let nextScans: PageScan[] = [];
    if (/^https?:\/\//i.test(tab.url || "")) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      const results = await Promise.all((frames || []).filter((frame) => /^https?:\/\//i.test(frame.url)).map(async (frame) => {
        try {
          const result = await chrome.tabs.sendMessage(tab.id!, { type: "MONICA_SCAN_PAGE" }, { documentId: frame.documentId }) as Omit<PageScan, "frameId" | "documentId">;
          return { ...result, url: frame.url, origin: new URL(frame.url).origin, frameId: frame.frameId, documentId: frame.documentId };
        } catch {
          return null;
        }
      }));
      nextScans = results.filter((result): result is PageScan => Boolean(result?.ok));
    }
    const nextLifecycle = await vaultClient.status();
    if (revision !== initializeRevision) return;
    tabId.value = tab.id;
    windowId.value = tab.windowId;
    tabUrl.value = tab.url || "";
    tabTitle.value = tab.title || tr('当前页面');
    scans.value = nextScans;
    pageUnsupported.value = !nextScans.length;
    selectedFrameId.value = fillTargets.value.find((candidate) => candidate.hasFocusedLoginField)?.frameId
      ?? fillTargets.value.find((candidate) => candidate.hasPasswordField || candidate.hasTotpField)?.frameId
      ?? nextScans[0]?.frameId ?? 0;
    lifecycle.value = nextLifecycle;
    if (lifecycle.value !== "uninitialized") await loadMatches();
  } catch (cause) {
    if (revision === initializeRevision) {
      runtimeReloadRequired.value = cause instanceof ExtensionRuntimeError && cause.code === "RUNTIME_RELOAD_REQUIRED";
      if (runtimeReloadRequired.value) masterPassword.value = "";
      error.value = errorMessage(cause, tr('无法连接当前页面，请刷新网页后重试。'));
    }
  } finally {
    if (revision === initializeRevision) loading.value = false;
  }
}

async function unlock() {
  unlocking.value = true;
  status.value = "";
  try {
    await vaultClient.unlock(masterPassword.value);
    masterPassword.value = "";
    await initialize(true);
  } catch (cause) {
    if (cause instanceof ExtensionRuntimeError && cause.code === "RUNTIME_RELOAD_REQUIRED") {
      masterPassword.value = "";
      runtimeReloadRequired.value = true;
      error.value = cause.message;
    } else status.value = errorMessage(cause, tr('解锁失败。'));
  } finally {
    unlocking.value = false;
  }
}

async function loadMatches() {
  const revision = ++matchRevision;
  const allowFill = isSensitivePageAllowed(scan.value?.url || tabUrl.value) && !pageUnsupported.value;
  const unlocked = lifecycle.value === "unlocked";
  const blocked = Boolean(scan.value?.currentField?.signature && await vaultClient.isAutofillFieldBlocked(scan.value.currentField.signature));
  const [loginMatches, passkeyMatches, walletMatches] = await Promise.all([
    allowFill && !blocked ? vaultClient.matchLogins(scan.value?.url || tabUrl.value, scan.value?.currentField?.signature) : Promise.resolve([]),
    allowFill && unlocked ? vaultClient.matchPasskeys(tabUrl.value) : Promise.resolve([]),
    allowFill && unlocked && !blocked ? vaultClient.listWalletItems(scan.value?.walletKinds || [], scan.value?.url || tabUrl.value, scan.value?.currentField?.signature) : Promise.resolve([])
  ]);
  const summaries = unlocked ? await vaultClient.listLoginSummaries().catch(() => []) : [];
  if (revision !== matchRevision || unlocked !== (lifecycle.value === "unlocked")) return;
  currentFieldBlocked.value = blocked;
  matches.value = loginMatches;
  passkeys.value = passkeyMatches;
  walletItems.value = walletMatches;
  allLogins.value = summaries;
}

const filteredLogins = computed(() => {
  const query = search.value.trim().toLowerCase();
  const matched = new Set(matches.value.map((item) => item.id));
  const base = allLogins.value.filter((item) => !matched.has(item.id));
  if (!query) return base;
  return base.filter((item) => loginSearchText(item).includes(query));
});
const visibleMatches = computed(() => {
  const query = search.value.trim().toLowerCase();
  return matches.value.filter((item) => !query || loginSearchText(item).includes(query));
});

function loginSearchText(item: LoginMatchSummary): string {
  return `${item.title}\n${item.username}\n${item.uris.join(' ')}\n${formatAutofillCredential(item.credentialIdentity, tr)}`.toLowerCase();
}

const loginPagination = useListPagination(() => filteredLogins.value.length, () => [search.value, allLogins.value], 20);
const matchPagination = useListPagination(() => visibleMatches.value.length, () => [search.value, matches.value], 20);
const passkeyPagination = useListPagination(() => passkeys.value.length, () => passkeys.value, 20);
const walletPagination = useListPagination(() => walletItems.value.length, () => walletItems.value, 20);

async function copyLoginSecret(item: LoginMatchSummary, field: "username" | "password") {
  status.value = "";
  try {
    const { value } = await vaultClient.loginSecret(item.id, field);
    if (!value) {
      status.value = field === "password" ? tr('此登录项没有保存密码。') : tr('此登录项没有用户名。');
      return;
    }
    await navigator.clipboard.writeText(value);
    status.value = tr('已复制{0}（{1}），剪贴板请妥善保管。', { 0: field === "password" ? tr('密码') : tr('用户名'), 1: item.title });
  } catch (cause) {
    status.value = errorMessage(cause, tr('复制失败。'));
  }
}

async function setCurrentFieldBlocked(blocked: boolean) {
  if (!tabId.value || !scan.value?.currentField) return;
  fieldPolicyBusy.value = true;
  status.value = "";
  try {
    await vaultClient.setCurrentAutofillFieldBlocked(blocked, tabId.value, selectedFrameId.value, scan.value.documentId, scan.value.origin);
    await initialize(true);
    status.value = blocked ? tr('已禁止此字段自动填充') : tr('已恢复此字段自动填充');
  } catch (cause) {
    status.value = errorMessage(cause, tr('字段排除设置失败。'));
  } finally {
    fieldPolicyBusy.value = false;
  }
}

function fieldRoleLabel() {
  return ({ username: tr('用户名字段'), "current-password": tr('密码字段'), "new-password": tr('新密码字段'), totp: tr('验证码字段'), wallet: tr('证件或支付字段') } as const)[scan.value?.currentField?.role || "username"];
}

function passkeyState(item: PasskeyMatchSummary) {
  return ({
    ready: tr('已保存，等待网站请求'),
    "android-metadata-only": tr('仅兼容保留，不能登录'),
    "missing-private-key": tr('缺少私钥，不能登录'),
    "unsupported-algorithm": tr('当前版本不支持此算法')
  } as const)[item.availability];
}

function passkeySource(item: PasskeyMatchSummary) {
  return item.sourceMode === "bitwarden" ? "Bitwarden" : item.sourceMode === "android-metadata-only" ? "Android" : tr('浏览器本地');
}

async function fillWallet(item: WalletMatchSummary) {
  if (!tabId.value) return;
  fillingId.value = item.id;
  status.value = "";
  try {
    const result = await vaultClient.fillWallet(item.id, tabId.value, selectedFrameId.value, scan.value?.documentId, scan.value?.origin);
    status.value = tr('已填充 {0}（{1} 个字段）', { 0: item.title, 1: result.filledCount });
  } catch (cause) {
    status.value = errorMessage(cause, tr('填充失败，请刷新网页后重试。'));
  } finally {
    fillingId.value = null;
  }
}

function walletKindLabel(kind: WalletFillKind) {
  return ({ identity: tr('证件'), "billing-address": tr('地址'), card: tr('银行卡'), "payment-account": tr('支付方式') } as const)[kind];
}

function walletIcon(kind: WalletFillKind) {
  return ({ identity: "badge", "billing-address": "home_pin", card: "credit_card", "payment-account": "account_balance" } as const)[kind];
}

async function fill(item: LoginMatchSummary) {
  if (!tabId.value) return;
  fillingId.value = item.id;
  status.value = "";
  try {
    const result = await vaultClient.fillLogin(item.id, tabId.value, selectedFrameId.value, scan.value?.documentId, scan.value?.origin);
    const fields = [result.filledUsername && tr('用户名'), result.filledPassword && tr('密码'), result.filledTotp && tr('验证码')].filter(Boolean).join("、");
    status.value = tr('已填充 {0}{1}', { 0: item.title, 1: fields ? `（${fields}）` : "" });
  } catch (cause) {
    status.value = errorMessage(cause, tr('填充失败，请刷新网页后重试。'));
  } finally {
    fillingId.value = null;
  }
}

async function selectTarget(event: Event) {
  selectedFrameId.value = Number((event.target as HTMLSelectElement).value);
  status.value = "";
  await loadMatches();
}

async function openManager() {
  await chrome.runtime.openOptionsPage();
  window.close();
}

function openSidePanel() {
  void openVaultSidePanel(chrome.sidePanel, windowId.value).then(() => window.close()).catch((cause) => {
    status.value = errorMessage(cause, tr('无法打开侧栏，请重试。'));
  });
}

function reloadRuntime() {
  masterPassword.value = "";
  chrome.runtime.reload();
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function isSensitivePageAllowed(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
  } catch {
    return false;
  }
}
</script>

<template>
  <m3e-theme :color="themeColor" :scheme="activeScheme" variant="monochrome" motion="standard" strong-focus>
    <main class="popup-shell">
      <header class="popup-header"><div class="popup-brand"><img class="brand-logo" src="/icons/logo-256.png" width="36" height="36" alt="" /><div><strong>Monica</strong><small>{{ tr('安全自动填充') }}</small></div></div><m3e-icon-button :aria-label="tr('打开密码库管理')" @click="openManager"><m3e-icon name="settings"></m3e-icon></m3e-icon-button></header>

      <section class="site-summary" :aria-label="tr('当前网站')"><WebsiteIcon class="site-icon" :url="scan?.url || tabUrl" /><div><strong>{{ currentHost }}</strong><small>{{ scan?.frameId ? `${scan.hasPasswordField || scan.hasTotpField ? tr('嵌入登录框') : tr('嵌入填充框')} · ${scan.title || tabTitle}` : tabTitle || tr('正在读取当前页面') }}</small></div><span v-if="fillPageAllowed && capabilityLabel" class="ready-badge"><m3e-icon name="check_circle"></m3e-icon>{{ capabilityLabel }}</span></section>

      <div v-if="loading" class="popup-state" aria-live="polite"><span class="spinner" aria-hidden="true"></span><strong>{{ tr('正在检查页面与密码库…') }}</strong><small>{{ tr('敏感数据尚未发送到网页') }}</small></div>
      <div v-else-if="error" class="popup-state error-state" :class="{ 'runtime-reload': runtimeReloadRequired }" role="alert"><m3e-icon name="block"></m3e-icon><strong>{{ runtimeReloadRequired ? tr('重新加载扩展') : tr('当前页面不可用') }}</strong><small>{{ runtimeReloadRequired ? tr('Monica 已更新，请重新加载扩展后再解锁。') : error }}</small><template v-if="runtimeReloadRequired"><small>{{ tr('请先保存其他 Monica 窗口中的修改。重新加载后，再打开 Monica。') }}</small><m3e-button variant="tonal" type="button" @click="reloadRuntime">{{ tr('重新加载扩展') }}</m3e-button></template><m3e-button v-else variant="tonal" @click="initialize(true)">{{ tr('重试') }}</m3e-button></div>

      <div v-else-if="lifecycle === 'uninitialized'" class="popup-state"><m3e-icon name="shield_lock"></m3e-icon><strong>{{ tr('尚未创建加密密码库') }}</strong><small>{{ tr('先在管理页设置主密码，再连接 WebDAV 或 Bitwarden。') }}</small><m3e-button variant="filled" @click="openManager">{{ tr('开始设置') }}</m3e-button></div>

      <template v-else-if="lifecycle === 'locked'">
        <section v-if="matches.length" id="popup-locked-matches" tabindex="-1" class="match-section locked-autofill-section" :aria-label="tr('免解锁填写')">
          <div class="section-title"><h2>{{ tr('免解锁填写') }}</h2><span>{{ matches.length }}</span></div>
          <p class="section-support">{{ tr('仅显示你在此浏览器标记的匹配账号，密码库保持锁定。') }}</p>
          <m3e-form-field v-field-label variant="filled" hide-required-marker v-if="fillTargets.length > 1" class="frame-picker"><label slot="label">{{ tr('填充目标') }}</label><component :is="materialSelectTag"  @change="selectTarget"><component :is="materialOptionTag" :selected.prop="String(selectedFrameId ?? '') === String(target.frameId)" v-for="target in fillTargets" :key="target.frameId" :value="target.frameId">{{ target.frameId === 0 ? tr('主页面') : tr('嵌入框：{0}', { 0: normalizeHost(target.url) }) }}</component></component></m3e-form-field>
          <m3e-list class="match-list"><PopupLoginRow v-for="item in matchPagination.slice(matches)" :key="item.id" :item="item" :can-fill="canFill" :busy="Boolean(fillingId)" :filling="fillingId === item.id" :show-totp="false" fallback="lock_open" @fill="fill" /></m3e-list>
        <ListPagination :page="matchPagination.page.value" :total="matches.length" :page-size="20" target="popup-locked-matches" @change="matchPagination.change" /></section>
      <form class="popup-unlock" @submit.prevent="unlock">
        <span class="unlock-icon"><m3e-icon name="lock"></m3e-icon></span><div><strong>{{ tr('密码库已锁定') }}</strong><small>{{ matches.length ? tr('解锁可使用验证码、Passkey 和其他项目。') : tr('解锁以使用密码库，或先在管理页为该账号开启免解锁填写。') }}</small></div>
        <m3e-form-field v-field-label variant="outlined" hide-required-marker hide-subscript="never" class="auth-password-field"><label slot="label">{{ tr('主密码') }}</label><input v-model="masterPassword" :aria-label="tr('主密码')" type="password" autocomplete="current-password" :autofocus="!matches.length" /><span slot="hint">{{ tr('设备密钥模式可留空解锁。') }}</span></m3e-form-field>
        <m3e-button variant="filled" type="submit" :disabled="unlocking">{{ unlocking ? tr('解锁中…') : tr('解锁') }}</m3e-button>
        <m3e-button variant="text" type="button" :disabled="unlocking" @click="openManager"><m3e-icon slot="icon" name="fingerprint"></m3e-icon>{{ tr('在管理页使用 Windows Hello') }}</m3e-button>
      </form>
      </template>

      <template v-else>
        <m3e-form-field v-field-label variant="filled" hide-required-marker v-if="fillTargets.length > 1" class="frame-picker"><label slot="label">{{ tr('填充目标') }}</label><component :is="materialSelectTag"  @change="selectTarget"><component :is="materialOptionTag" :selected.prop="String(selectedFrameId ?? '') === String(target.frameId)" v-for="target in fillTargets" :key="target.frameId" :value="target.frameId">{{ target.frameId === 0 ? tr('主页面') : tr('嵌入框：{0}', { 0: normalizeHost(target.url) }) }}{{ target.hasTotpField && !target.hasPasswordField ? tr('（验证码）') : '' }}</component></component></m3e-form-field>
        <div v-if="pageUnsupported" class="inline-warning danger-warning"><m3e-icon name="gpp_bad"></m3e-icon><span>{{ tr('此浏览器页面不允许自动填充；可搜索密码库并复制账号密码。') }}</span></div>
        <div v-else-if="!fillPageAllowed" class="inline-warning danger-warning"><m3e-icon name="gpp_bad"></m3e-icon><span>{{ tr('当前页面不是安全 HTTPS，已禁用密码、证件与支付信息填充。') }}</span></div>
        <div v-else-if="currentFieldBlocked" class="field-policy-row"><span><m3e-icon name="block"></m3e-icon><span><strong>{{ tr('此字段已排除') }}</strong><small>{{ fieldRoleLabel() }}</small></span></span><m3e-button variant="text" type="button" :disabled="fieldPolicyBusy" @click="setCurrentFieldBlocked(false)">{{ tr('恢复填充') }}</m3e-button></div>
        <m3e-button variant="text" v-else-if="scan?.currentField" class="field-policy-action" type="button" :disabled="fieldPolicyBusy" @click="setCurrentFieldBlocked(true)"><m3e-icon slot="icon" name="do_not_disturb_on"></m3e-icon><span>{{ tr('此字段不再填充') }}</span></m3e-button>
        <div v-else-if="!scan?.hasPasswordField && !scan?.hasTotpField && !scan?.hasUsernameField && !scan?.walletKinds.length && !passkeys.length" class="inline-warning"><m3e-icon name="info"></m3e-icon><span>{{ tr('当前目标暂未检测到可安全填充的字段。') }}</span></div>

        <m3e-search-bar class="popup-search-bar" clearable :clear-label="tr('清除搜索')" @clear="search = ''"><m3e-icon slot="leading" name="search"></m3e-icon><input slot="input" v-model="search" type="search" :placeholder="tr('搜索全部登录项')" :aria-label="tr('搜索全部登录项')" /></m3e-search-bar>
        <section v-if="visibleMatches.length" id="popup-matches" tabindex="-1" class="match-section"><div class="section-title"><h2>{{ tr('匹配的登录项') }}</h2><span>{{ visibleMatches.length }}</span></div><m3e-list class="match-list">
          <PopupLoginRow v-for="item in matchPagination.slice(visibleMatches)" :key="item.id" :item="item" :can-fill="canFill" :busy="Boolean(fillingId)" :filling="fillingId === item.id" :fallback="item.hasTotp && scan?.hasTotpField ? 'timer' : 'language'" @fill="fill" />
        </m3e-list><ListPagination :page="matchPagination.page.value" :total="visibleMatches.length" :page-size="20" target="popup-matches" @change="matchPagination.change" /></section>
        <section v-if="!currentFieldBlocked && filteredLogins.length" id="popup-login-results" tabindex="-1" class="match-section"><div class="section-title"><h2>{{ search.trim() ? tr('搜索结果') : tr('全部登录项') }}</h2><span>{{ filteredLogins.length }}</span></div><m3e-list class="match-list">
          <PopupLoginRow v-for="item in loginPagination.slice(filteredLogins)" :key="item.id" :item="item" :can-fill="canFill" :busy="Boolean(fillingId)" :filling="fillingId === item.id" copy-actions @fill="fill" @copy="copyLoginSecret" />
        </m3e-list><ListPagination :page="loginPagination.page.value" :total="filteredLogins.length" :page-size="20" target="popup-login-results" @change="loginPagination.change" /></section>

        <section v-if="passkeys.length" id="popup-passkeys" tabindex="-1" class="match-section"><div class="section-title"><h2>Passkey</h2><span>{{ passkeys.length }}</span></div><m3e-list class="match-list" variant="segmented">
          <m3e-list-item v-for="item in passkeyPagination.slice(passkeys)" :key="item.id" class="passkey-card"><span slot="leading" class="credential-icon"><m3e-icon name="passkey" /></span><span class="popup-item-title">{{ item.title }}</span><span slot="supporting-text" class="popup-passkey-support"><span>{{ item.userName || tr('无用户名') }} · {{ passkeySource(item) }}</span><span class="passkey-state" :class="{ ready: item.availability === 'ready' }"><m3e-icon aria-hidden="true" :name="item.availability === 'ready' ? 'check_circle' : 'info'" /><span>{{ passkeyState(item) }}</span></span></span></m3e-list-item>
        </m3e-list><p class="section-support">{{ tr('网站发起后 Monica 会显示已验证的 RP ID；要求系统级用户验证的请求会交还浏览器处理。') }}</p><ListPagination :page="passkeyPagination.page.value" :total="passkeys.length" :page-size="20" target="popup-passkeys" @change="passkeyPagination.change" /></section>
        <section v-if="walletItems.length" id="popup-wallet" tabindex="-1" class="match-section"><div class="section-title"><h2>{{ tr('证件与支付方式') }}</h2><span>{{ walletItems.length }}</span></div><m3e-action-list class="match-list" variant="segmented">
          <m3e-list-action v-for="item in walletPagination.slice(walletItems)" :key="item.id" v-list-action="`${tr('填充')} · ${item.title} · ${walletKindLabel(item.kind)}`" class="wallet-row" :disabled="Boolean(fillingId) || !canFill" @click="!fillingId && canFill && fillWallet(item)"><span slot="leading" class="credential-icon"><m3e-icon :name="walletIcon(item.kind)" /></span><span class="popup-item-title">{{ item.title }}</span><span slot="supporting-text" class="popup-wallet-support">{{ walletKindLabel(item.kind) }} · {{ item.subtitle }}{{ item.sensitive ? tr(' · 点击后填充敏感信息') : '' }}</span><span slot="trailing" class="fill-action">{{ fillingId === item.id ? tr('填充中') : tr('填充') }}<m3e-icon name="arrow_forward" aria-hidden="true" /></span></m3e-list-action>
        </m3e-action-list><ListPagination :page="walletPagination.page.value" :total="walletItems.length" :page-size="20" target="popup-wallet" @change="walletPagination.change" /></section>
        <div v-if="!visibleMatches.length && !passkeys.length && !walletItems.length && !filteredLogins.length" class="popup-state empty-popup"><m3e-icon name="key_off"></m3e-icon><strong>{{ search.trim() ? tr('没有匹配的登录项') : tr('密码库还是空的') }}</strong><small>{{ search.trim() ? tr('换个关键词试试。') : tr('请在密码库中添加当前页面可使用的登录、Passkey、证件、地址或支付项目。') }}</small><m3e-button variant="filled" @click="openManager"><m3e-icon slot="icon" name="add"></m3e-icon>{{ tr('打开密码库') }}</m3e-button></div>
      </template>

      <p class="popup-status" aria-live="polite">{{ status }}</p>
      <footer v-if="sidePanelAvailable" class="popup-footer"><m3e-button variant="text" type="button" @click="openManager"><m3e-icon slot="icon" name="database"></m3e-icon>{{ tr('管理密码库') }}</m3e-button><m3e-button variant="text" type="button" :disabled="windowId === null" :aria-label="tr('在侧栏打开密码库')" @click="openSidePanel">{{ tr('打开侧栏') }}</m3e-button></footer>
      <footer v-else class="popup-footer"><m3e-button variant="text" type="button" @click="openManager"><m3e-icon slot="icon" name="database"></m3e-icon>{{ tr('管理密码库') }}</m3e-button><span>{{ tr('仅点击后填充') }}</span></footer>
    </main>
  </m3e-theme>
</template>
