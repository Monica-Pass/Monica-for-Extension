<script setup lang="ts">
import "@m3e/web/theme";
import "@m3e/web/button";
import "@m3e/web/icon";
import "@m3e/web/icon-button";
import { computed, onMounted, ref } from "vue";
import { normalizeHost } from "../core/matching";
import { activeScheme, themeColor, useThemePreferences } from "../lib/theme";
import { vaultClient } from "../runtime/client";
import type { LoginMatchSummary, WalletFillKind, WalletMatchSummary } from "../runtime/messages";
import type { VaultLifecycleStatus } from "../security/secure-vault-service";

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
  frameId: number;
}

const loading = ref(true);
const unlocking = ref(false);
const fillingId = ref<string | null>(null);
const status = ref("");
const error = ref("");
const masterPassword = ref("");
const lifecycle = ref<VaultLifecycleStatus>("locked");
const tabId = ref<number | null>(null);
const tabUrl = ref("");
const tabTitle = ref("");
const scans = ref<PageScan[]>([]);
const selectedFrameId = ref(0);
const matches = ref<LoginMatchSummary[]>([]);
const walletItems = ref<WalletMatchSummary[]>([]);

useThemePreferences();
const scan = computed(() => scans.value.find((candidate) => candidate.frameId === selectedFrameId.value) || scans.value[0] || null);
const fillTargets = computed(() => scans.value.filter((candidate) => candidate.hasUsernameField || candidate.hasPasswordField || candidate.hasTotpField || candidate.walletKinds.length));
const currentHost = computed(() => normalizeHost(scan.value?.url || tabUrl.value) || "当前页面");

onMounted(initialize);

async function initialize() {
  loading.value = true;
  error.value = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("无法读取当前标签页。");
    tabId.value = tab.id;
    tabUrl.value = tab.url || "";
    tabTitle.value = tab.title || "当前页面";
    if (!/^https?:\/\//i.test(tabUrl.value)) throw new Error("此浏览器页面不允许插件执行自动填充。");
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const results = await Promise.all(frames.filter((frame) => /^https?:\/\//i.test(frame.url)).map(async (frame) => {
      try {
        const result = await chrome.tabs.sendMessage(tab.id!, { type: "MONICA_SCAN_PAGE" }, { frameId: frame.frameId }) as Omit<PageScan, "frameId">;
        return { ...result, frameId: frame.frameId };
      } catch {
        return null;
      }
    }));
    scans.value = results.filter((result): result is PageScan => Boolean(result?.ok));
    if (!scans.value.length) throw new Error("页面内容脚本尚未就绪。");
    selectedFrameId.value = fillTargets.value.find((candidate) => candidate.hasPasswordField || candidate.hasTotpField)?.frameId ?? scans.value[0].frameId;
    lifecycle.value = await vaultClient.status();
    if (lifecycle.value === "unlocked") await loadMatches();
  } catch (cause) {
    error.value = errorMessage(cause, "无法连接当前页面，请刷新网页后重试。");
  } finally {
    loading.value = false;
  }
}

async function unlock() {
  unlocking.value = true;
  status.value = "";
  try {
    await vaultClient.unlock(masterPassword.value);
    masterPassword.value = "";
    lifecycle.value = "unlocked";
    await loadMatches();
  } catch (cause) {
    status.value = errorMessage(cause, "解锁失败。");
  } finally {
    unlocking.value = false;
  }
}

async function loadMatches() {
  const [loginMatches, walletMatches] = await Promise.all([
    vaultClient.matchLogins(scan.value?.url || tabUrl.value),
    vaultClient.listWalletItems(scan.value?.walletKinds || [])
  ]);
  matches.value = loginMatches;
  walletItems.value = walletMatches;
}

async function fillWallet(item: WalletMatchSummary) {
  if (!tabId.value) return;
  fillingId.value = item.id;
  status.value = "";
  try {
    const result = await vaultClient.fillWallet(item.id, tabId.value, selectedFrameId.value);
    status.value = `已填充 ${item.title}（${result.filledCount} 个字段）`;
  } catch (cause) {
    status.value = errorMessage(cause, "填充失败，请刷新网页后重试。");
  } finally {
    fillingId.value = null;
  }
}

function walletKindLabel(kind: WalletFillKind) {
  return ({ identity: "证件", "billing-address": "地址", card: "银行卡", "payment-account": "支付方式" } as const)[kind];
}

function walletIcon(kind: WalletFillKind) {
  return ({ identity: "badge", "billing-address": "home_pin", card: "credit_card", "payment-account": "account_balance" } as const)[kind];
}

async function fill(item: LoginMatchSummary) {
  if (!tabId.value) return;
  fillingId.value = item.id;
  status.value = "";
  try {
    const result = await vaultClient.fillLogin(item.id, tabId.value, selectedFrameId.value);
    const fields = [result.filledUsername && "用户名", result.filledPassword && "密码", result.filledTotp && "验证码"].filter(Boolean).join("、");
    status.value = `已填充 ${item.title}${fields ? `（${fields}）` : ""}`;
  } catch (cause) {
    status.value = errorMessage(cause, "填充失败，请刷新网页后重试。");
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

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
</script>

<template>
  <m3e-theme :color="themeColor" :scheme="activeScheme" variant="expressive" motion="expressive" strong-focus>
    <main class="popup-shell">
      <header class="popup-header"><div class="popup-brand"><img src="/icons/logo-256.png" alt="" /><div><strong>Monica</strong><small>安全自动填充</small></div></div><m3e-icon-button aria-label="打开密码库管理" @click="openManager"><m3e-icon name="settings"></m3e-icon></m3e-icon-button></header>

      <section class="site-summary" aria-label="当前网站"><span class="site-icon"><m3e-icon name="language"></m3e-icon></span><div><strong>{{ currentHost }}</strong><small>{{ scan?.frameId ? `${scan.hasPasswordField || scan.hasTotpField ? '嵌入登录框' : '嵌入填充框'} · ${scan.title || tabTitle}` : tabTitle || '正在读取当前页面' }}</small></div><span v-if="scan?.hasPasswordField || scan?.hasTotpField || scan?.walletKinds.length" class="ready-badge"><m3e-icon name="check_circle"></m3e-icon>可填充</span></section>

      <div v-if="loading" class="popup-state" aria-live="polite"><span class="spinner" aria-hidden="true"></span><strong>正在检查页面与密码库…</strong><small>敏感数据尚未发送到网页</small></div>
      <div v-else-if="error" class="popup-state error-state" role="alert"><m3e-icon name="block"></m3e-icon><strong>当前页面不可用</strong><small>{{ error }}</small><m3e-button variant="tonal" @click="initialize">重试</m3e-button></div>

      <div v-else-if="lifecycle === 'uninitialized'" class="popup-state"><m3e-icon name="shield_lock"></m3e-icon><strong>尚未创建加密密码库</strong><small>先在管理页设置主密码，再连接 WebDAV 或 Bitwarden。</small><m3e-button variant="filled" @click="openManager">开始设置</m3e-button></div>

      <form v-else-if="lifecycle === 'locked'" class="popup-unlock" @submit.prevent="unlock">
        <span class="unlock-icon"><m3e-icon name="lock"></m3e-icon></span><div><strong>密码库已锁定</strong><small>解锁后才会读取当前网站的匹配项。</small></div>
        <label><span>主密码</span><input v-model="masterPassword" type="password" autocomplete="current-password" autofocus /></label>
        <m3e-button variant="filled" type="submit" :disabled="unlocking || !masterPassword">{{ unlocking ? '解锁中…' : '解锁' }}</m3e-button>
      </form>

      <template v-else>
        <label v-if="fillTargets.length > 1" class="frame-picker"><span>填充目标</span><select :value="selectedFrameId" @change="selectTarget"><option v-for="target in fillTargets" :key="target.frameId" :value="target.frameId">{{ target.frameId === 0 ? '主页面' : `嵌入框：${normalizeHost(target.url)}` }}{{ target.hasTotpField && !target.hasPasswordField ? '（验证码）' : '' }}</option></select></label>
        <div v-if="!scan?.hasPasswordField && !scan?.hasTotpField && !scan?.hasUsernameField && !scan?.walletKinds.length" class="inline-warning"><m3e-icon name="info"></m3e-icon><span>当前目标暂未检测到可安全填充的字段。</span></div>
        <section v-if="matches.length" class="match-section"><div class="section-title"><h1>匹配的登录项</h1><span>{{ matches.length }}</span></div><div class="match-list">
          <button v-for="item in matches" :key="item.id" class="credential-card" type="button" :disabled="Boolean(fillingId)" @click="fill(item)"><span class="credential-icon"><m3e-icon :name="item.favorite ? 'star' : item.hasTotp && scan?.hasTotpField ? 'timer' : 'key'"></m3e-icon></span><span class="credential-copy"><strong>{{ item.title }}</strong><small>{{ item.username || '无用户名' }}{{ item.hasTotp ? ' · 含验证码' : '' }}</small></span><span class="fill-action">{{ fillingId === item.id ? '填充中' : '填充' }}<m3e-icon name="arrow_forward"></m3e-icon></span></button>
        </div></section>
        <section v-if="walletItems.length" class="match-section"><div class="section-title"><h1>证件与支付方式</h1><span>{{ walletItems.length }}</span></div><div class="match-list">
          <button v-for="item in walletItems" :key="item.id" class="credential-card" type="button" :disabled="Boolean(fillingId)" @click="fillWallet(item)"><span class="credential-icon"><m3e-icon :name="walletIcon(item.kind)"></m3e-icon></span><span class="credential-copy"><strong>{{ item.title }}</strong><small>{{ walletKindLabel(item.kind) }} · {{ item.subtitle }}{{ item.sensitive ? ' · 点击后填充敏感信息' : '' }}</small></span><span class="fill-action">{{ fillingId === item.id ? '填充中' : '填充' }}<m3e-icon name="arrow_forward"></m3e-icon></span></button>
        </div></section>
        <div v-if="!matches.length && !walletItems.length" class="popup-state empty-popup"><m3e-icon name="key_off"></m3e-icon><strong>没有匹配项</strong><small>请在密码库中添加当前页面可使用的登录、证件、地址或支付项目。</small><m3e-button variant="filled" @click="openManager"><m3e-icon slot="icon" name="add"></m3e-icon>打开密码库</m3e-button></div>
      </template>

      <p class="popup-status" aria-live="polite">{{ status }}</p>
      <footer class="popup-footer"><button type="button" @click="openManager"><m3e-icon name="database"></m3e-icon>管理密码库</button><span>仅点击后解密填充</span></footer>
    </main>
  </m3e-theme>
</template>
