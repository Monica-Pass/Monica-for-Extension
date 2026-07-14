<script setup lang="ts">
import "@m3e/web/theme";
import "@m3e/web/app-bar";
import "@m3e/web/button";
import "@m3e/web/card";
import "@m3e/web/icon";
import "@m3e/web/icon-button";
import { computed, onMounted, reactive, ref } from "vue";
import AppearancePanel from "./components/AppearancePanel.vue";
import { createLoginItem, isLoginItem, type LoginItem, type ProviderAccount, type VaultItem } from "./core/model";
import { activeScheme, themeColor, useThemePreferences } from "./lib/theme";
import type { MonicaWebDavConfig } from "./providers/webdav/monica-webdav-provider";
import { vaultClient } from "./runtime/client";
import type { VaultLifecycleStatus } from "./security/secure-vault-service";

type Section = "overview" | "passwords" | "providers" | "settings";

const credentials = ref<LoginItem[]>([]);
const providers = ref<ProviderAccount[]>([]);
const lifecycle = ref<VaultLifecycleStatus>("locked");
const activeSection = ref<Section>("overview");
const query = ref("");
const loading = ref(true);
const authBusy = ref(false);
const authError = ref("");
const mobileNavOpen = ref(false);
const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const revealPassword = ref(false);
const formError = ref("");
const notice = ref("");
const webDavBusy = ref<"" | "test" | "save" | "sync" | "remove">("");
const webDavError = ref("");
const editingWebDavId = ref<string | undefined>();

const auth = reactive({ masterPassword: "", confirmation: "" });
const form = reactive({ name: "", username: "", password: "", urls: "", notes: "", favorite: false, providerId: "" });
const webDavForm = reactive({ name: "Monica Android WebDAV", baseUrl: "", username: "", password: "", backupPassword: "", isDefaultSaveTarget: false });

useThemePreferences();

const filteredCredentials = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return credentials.value;
  return credentials.value.filter((item) => `${item.title} ${item.username} ${item.uris.join(" ")} ${item.notes}`.toLowerCase().includes(needle));
});
const uniqueHosts = computed(() => new Set(credentials.value.flatMap((item) => item.uris)).size);
const favoriteCount = computed(() => credentials.value.filter((item) => item.favorite).length);
const webDavProviders = computed(() => providers.value.filter((provider) => provider.kind === "monica-webdav"));
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
    credentials.value = (await action()).filter(isLoginItem);
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
  credentials.value = [];
  lifecycle.value = "locked";
  activeSection.value = "overview";
  editorOpen.value = false;
}

async function refreshItems() {
  credentials.value = (await vaultClient.listItems()).filter(isLoginItem);
}

async function refreshProviders() {
  providers.value = await vaultClient.listProviders();
}

function navigate(section: Section) {
  activeSection.value = section;
  mobileNavOpen.value = false;
  if (section === "providers") void refreshProviders();
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
    editWebDav(providers.value.find((provider) => provider.id === saved.id) || saved);
    showNotice("WebDAV 密码源已保存到加密密码库。");
  });
}

async function syncProvider(provider: ProviderAccount) {
  await runWebDavAction("sync", async () => {
    const result = await vaultClient.syncProvider(provider.id);
    await Promise.all([refreshItems(), refreshProviders()]);
    const details = result.conflicts ? `发现 ${result.conflicts} 个冲突，未覆盖远端数据。` : result.warnings[0] || "同步完成。";
    showNotice(details);
  });
}

async function removeProvider(provider: ProviderAccount) {
  if (!window.confirm(`确定移除“${provider.name}”吗？插件中的该源缓存项目会移除，远端 WebDAV 文件不会被删除。`)) return;
  await runWebDavAction("remove", async () => {
    await vaultClient.removeProvider(provider.id);
    await Promise.all([refreshItems(), refreshProviders()]);
    if (editingWebDavId.value === provider.id) newWebDav();
    showNotice("WebDAV 密码源已从插件中移除，远端备份未改动。");
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

function exportVault() {
  const blob = new Blob([JSON.stringify({ version: 1, items: credentials.value }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `monica-extension-export-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importVault(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()) as { items?: VaultItem[]; credentials?: Array<Record<string, unknown>> };
    const items = Array.isArray(parsed.items) ? parsed.items.filter(isLoginItem) : [];
    if (!items.length && Array.isArray(parsed.credentials)) {
      for (const legacy of parsed.credentials) {
        if (typeof legacy.password !== "string" || !Array.isArray(legacy.urls)) continue;
        items.push(createLoginItem({ title: String(legacy.name || "导入登录项"), username: String(legacy.username || ""), password: legacy.password, uris: legacy.urls.map(String), notes: String(legacy.notes || ""), favorite: Boolean(legacy.favorite) }));
      }
    }
    if (!items.length) throw new Error("no supported items");
    for (const item of items) await vaultClient.upsertItem(item);
    await refreshItems();
    showNotice(`已加密导入 ${items.length} 个登录项。`);
  } catch {
    showNotice("导入失败：文件中没有可识别的 Monica 登录项。");
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
          <div class="avatar-icon"><m3e-icon :name="lifecycle === 'uninitialized' ? 'shield_lock' : 'lock'"></m3e-icon></div>
          <div><h1>{{ lifecycle === 'uninitialized' ? '创建加密密码库' : '解锁 Monica' }}</h1><p class="supporting">{{ lifecycle === 'uninitialized' ? '主密码仅用于本机派生加密密钥，Monica 不会保存它。' : '输入主密码以解密本地缓存并连接密码源。' }}</p></div>
          <label class="field"><span>主密码</span><input v-model="auth.masterPassword" type="password" autocomplete="current-password" autofocus /></label>
          <label v-if="lifecycle === 'uninitialized'" class="field"><span>确认主密码</span><input v-model="auth.confirmation" type="password" autocomplete="new-password" /></label>
          <p v-if="authError" class="form-error" role="alert">{{ authError }}</p>
          <m3e-button variant="filled" type="submit" :disabled="authBusy">{{ authBusy ? '处理中…' : lifecycle === 'uninitialized' ? '创建并解锁' : '解锁' }}</m3e-button>
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
          <div slot="trailing" class="appbar-trailing"><label class="search"><m3e-icon name="search"></m3e-icon><input v-model="query" aria-label="搜索登录项" placeholder="搜索名称、用户名或网站" /></label></div>
        </m3e-app-bar>

        <div class="page-heading">
          <div><h1>{{ activeSection === 'overview' ? '密码库概览' : activeSection === 'passwords' ? '登录项' : activeSection === 'providers' ? '密码源' : '设置与备份' }}</h1><p>{{ activeSection === 'passwords' ? '敏感字段只在解锁后解密。' : activeSection === 'providers' ? 'WebDAV 与 Bitwarden 将作为独立密码源接入。' : '扩展源码复用 WebUI，但运行时完全独立。' }}</p></div>
          <m3e-button v-if="activeSection === 'overview' || activeSection === 'passwords'" class="primary-action" variant="filled" @click="openCreate"><m3e-icon slot="icon" name="add"></m3e-icon>添加登录项</m3e-button>
        </div>
        <p class="sr-status" aria-live="polite">{{ notice }}</p>

        <section v-if="activeSection === 'overview'" class="metrics">
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="password"></m3e-icon><p>登录项</p><strong>{{ credentials.length }}</strong><small>加密缓存中的有效项</small></div></m3e-card>
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="language"></m3e-icon><p>网站规则</p><strong>{{ uniqueHosts }}</strong><small>域名或网址匹配项</small></div></m3e-card>
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="star"></m3e-icon><p>收藏</p><strong>{{ favoriteCount }}</strong><small>优先匹配的账号</small></div></m3e-card>
          <m3e-card variant="filled" class="motion-card metric-card"><div slot="content" class="metric"><m3e-icon name="encrypted"></m3e-icon><p>安全状态</p><strong class="metric-word">已解锁</strong><small>15 分钟无操作自动锁定</small></div></m3e-card>
        </section>

        <section v-if="activeSection === 'overview'" class="content-grid"><m3e-card variant="filled" class="motion-card"><div slot="content" class="getting-started"><m3e-icon name="auto_fix_high"></m3e-icon><div><h2>自动填充基线已连接加密核心</h2><p>Popup 只读取匹配项摘要；点击填充后由后台解密单个登录项并发送给当前网页。</p></div><m3e-button variant="tonal" @click="navigate('passwords')">管理登录项</m3e-button></div></m3e-card></section>

        <section v-else-if="activeSection === 'passwords'" class="content-grid">
          <m3e-card variant="filled" class="data-card motion-card">
            <div slot="header" class="card-head"><h2>全部登录项</h2><p>{{ filteredCredentials.length }} 个结果</p></div>
            <div v-if="filteredCredentials.length" class="table-wrap"><table><thead><tr><th>名称</th><th>用户名</th><th>匹配网站</th><th>更新时间</th><th><span class="visually-hidden">操作</span></th></tr></thead><tbody>
              <tr v-for="item in filteredCredentials" :key="item.id"><td class="item-cell" data-label="名称"><div class="row-title"><m3e-icon :name="item.favorite ? 'star' : 'language'"></m3e-icon><div><strong>{{ item.title }}</strong><small>••••••••••••</small></div></div></td><td data-label="用户名">{{ item.username || '—' }}</td><td data-label="匹配网站"><span class="url-list">{{ item.uris.join(' · ') }}</span></td><td data-label="更新时间">{{ new Date(item.updatedAt).toLocaleString() }}</td><td class="action-cell"><m3e-icon-button aria-label="编辑登录项" @click="openEdit(item)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="删除登录项" @click="removeCredential(item)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></td></tr>
            </tbody></table></div>
            <div v-else class="empty-state" slot="content"><m3e-icon name="key_off"></m3e-icon><h2>{{ query ? '没有匹配的登录项' : '加密密码库还是空的' }}</h2><p>{{ query ? '换一个关键词试试。' : '添加第一个账号后即可在 Popup 中匹配。' }}</p><m3e-button v-if="!query" variant="filled" @click="openCreate">添加登录项</m3e-button></div>
          </m3e-card>
        </section>

        <section v-else-if="activeSection === 'providers'" class="provider-layout">
          <m3e-card variant="filled" class="motion-card provider-config-card">
            <div slot="header" class="card-head provider-card-head"><div><h2>{{ editingWebDavId ? '编辑 WebDAV' : '连接 Monica Android WebDAV' }}</h2><p>读取并无损写回 Android 的 Monica_Backups 快照。</p></div><m3e-button v-if="editingWebDavId" variant="text" @click="newWebDav"><m3e-icon slot="icon" name="add"></m3e-icon>新连接</m3e-button></div>
            <form slot="content" class="provider-form" @submit.prevent="saveWebDav">
              <label class="field"><span>显示名称</span><input v-model="webDavForm.name" autocomplete="off" placeholder="Monica Android WebDAV" /></label>
              <label class="field field-wide"><span>WebDAV 地址 *</span><input v-model="webDavForm.baseUrl" type="url" autocomplete="url" placeholder="https://cloud.example.com/remote.php/dav/files/user" required /><small>可以填写服务器根路径，也可以直接填写 Monica_Backups 路径。</small></label>
              <label class="field"><span>用户名</span><input v-model="webDavForm.username" autocomplete="username" /></label>
              <label class="field"><span>WebDAV 密码</span><input v-model="webDavForm.password" type="password" autocomplete="current-password" /></label>
              <label class="field field-wide"><span>Android 备份加密密码</span><input v-model="webDavForm.backupPassword" type="password" autocomplete="off" /><small>仅用于 .enc.zip 的 MONICA_ENC_V1 解密；未加密备份请留空。</small></label>
              <label class="favorite-row field-wide"><input v-model="webDavForm.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
              <p v-if="webDavError" class="form-error field-wide" role="alert">{{ webDavError }}</p>
              <footer class="provider-actions field-wide"><m3e-button variant="tonal" type="button" :disabled="Boolean(webDavBusy)" @click="testWebDav">{{ webDavBusy === 'test' ? '测试中…' : '测试连接' }}</m3e-button><m3e-button variant="filled" type="submit" :disabled="Boolean(webDavBusy)">{{ webDavBusy === 'save' ? '保存中…' : '加密保存' }}</m3e-button></footer>
            </form>
          </m3e-card>

          <div class="provider-list">
            <m3e-card v-for="provider in webDavProviders" :key="provider.id" variant="filled" class="motion-card source-card"><div slot="content" class="stack"><div class="source-title"><m3e-icon name="folder_copy"></m3e-icon><div><h2>{{ provider.name }}</h2><p>{{ String(provider.config.baseUrl || '') }}</p></div></div><span class="state" :class="provider.lastError ? 'state-attention' : 'state-healthy'">{{ provider.lastError ? '需要处理' : provider.lastSyncAt ? '已同步' : '已连接' }}</span><p v-if="provider.lastError" class="form-error">{{ provider.lastError }}</p><p class="supporting">{{ provider.lastSyncAt ? `上次同步：${new Date(provider.lastSyncAt).toLocaleString()}` : '尚未同步；首次同步会导入最新 Android 快照。' }}</p><div class="source-actions"><m3e-button variant="tonal" :disabled="Boolean(webDavBusy)" @click="syncProvider(provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ webDavBusy === 'sync' ? '同步中…' : '立即同步' }}</m3e-button><m3e-icon-button aria-label="编辑 WebDAV" @click="editWebDav(provider)"><m3e-icon name="edit"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="移除 WebDAV" @click="removeProvider(provider)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></div></div></m3e-card>
            <m3e-card variant="filled" class="motion-card source-card"><div slot="content" class="stack"><div class="source-title"><m3e-icon name="shield"></m3e-icon><div><h2>Bitwarden</h2><p>官方及自托管服务</p></div></div><p class="supporting">下一阶段接入 KDF、2FA、Cipher CRUD 与 FIDO2 Passkey。</p><span class="state state-attention">即将接入</span></div></m3e-card>
            <m3e-card variant="filled" class="motion-card source-card"><div slot="content" class="stack"><div class="source-title"><m3e-icon name="database"></m3e-icon><div><h2>Monica 本地库</h2><p>加密 IndexedDB 信封</p></div></div><p class="supporting">{{ externalProviders.length ? '可与外部密码源并存。' : '当前唯一的密码源。' }}</p><span class="state state-healthy">已连接</span></div></m3e-card>
          </div>
        </section>

        <section v-else class="settings-grid">
          <AppearancePanel class="motion-card" />
          <m3e-card variant="filled" class="motion-card"><div slot="content" class="stack"><h2>手动迁移</h2><p class="supporting">导出文件是用户主动生成的明文，请只保存到可信位置。</p><m3e-button variant="tonal" @click="exportVault"><m3e-icon slot="icon" name="download"></m3e-icon>导出 JSON</m3e-button><label class="file-action"><m3e-icon name="upload"></m3e-icon><span>导入 JSON</span><input type="file" accept="application/json,.json" @change="importVault" /></label></div></m3e-card>
          <m3e-card variant="filled" class="motion-card"><div slot="content" class="stack"><h2>安全边界</h2><div class="boundary-row"><m3e-icon name="encrypted"></m3e-icon><span>持久数据使用 AES-256-GCM 加密</span></div><div class="boundary-row"><m3e-icon name="timer"></m3e-icon><span>解锁密钥仅保留在浏览器会话存储</span></div><div class="boundary-row"><m3e-icon name="visibility_off"></m3e-icon><span>内容脚本无法读取完整密码库</span></div></div></m3e-card>
        </section>
      </main>
    </div>

    <div v-if="editorOpen" class="modal-backdrop" role="presentation" @mousedown.self="editorOpen = false"><section class="editor-dialog" role="dialog" aria-modal="true" :aria-labelledby="editingId ? 'editor-title-edit' : 'editor-title-new'"><header><div><h2 :id="editingId ? 'editor-title-edit' : 'editor-title-new'">{{ editingId ? '编辑登录项' : '添加登录项' }}</h2><p>保存时整个密码库会重新加密。</p></div><m3e-icon-button aria-label="关闭" @click="editorOpen = false"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header><form class="editor-form" @submit.prevent="submitCredential">
      <label class="field"><span>名称 *</span><input v-model="form.name" autofocus autocomplete="off" placeholder="例如：GitHub 工作账号" /></label><label class="field"><span>用户名</span><input v-model="form.username" autocomplete="username" placeholder="name@example.com" /></label><label class="field"><span>密码 *</span><div class="password-field"><input v-model="form.password" :type="revealPassword ? 'text' : 'password'" autocomplete="new-password" /><button type="button" @click="revealPassword = !revealPassword">{{ revealPassword ? '隐藏' : '显示' }}</button></div></label><label class="field"><span>匹配网站 *</span><textarea v-model="form.urls" rows="3" placeholder="github.com&#10;https://accounts.example.com"></textarea><small>每行一个域名或网址；子域名会自动匹配。</small></label><label class="field"><span>备注</span><textarea v-model="form.notes" rows="3" placeholder="可选备注"></textarea></label><label class="field"><span>保存到</span><select v-model="form.providerId" :disabled="Boolean(editingId)"><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select><small>{{ editingId ? '已有项目保留原密码源；复制到其他源将在后续批量操作中提供。' : '外部密码源项目会在下次同步时写入。' }}</small></label><label class="favorite-row"><input v-model="form.favorite" type="checkbox" /><span>收藏并优先显示</span></label><p v-if="formError" class="form-error" role="alert">{{ formError }}</p><footer><m3e-button variant="text" type="button" @click="editorOpen = false">取消</m3e-button><m3e-button variant="filled" type="submit">加密保存</m3e-button></footer>
    </form></section></div>
  </m3e-theme>
</template>
