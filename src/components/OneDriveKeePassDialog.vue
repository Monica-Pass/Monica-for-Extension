<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { tr } from "../i18n";
import type { ProviderAccount } from "../core/model";
import type { OneDriveItem } from "../providers/onedrive/onedrive-graph-client";
import type { OneDriveBrowserPage, OneDriveLoginSummary } from "../providers/onedrive/onedrive-session";
import type { KeePassOneDriveConnectResult } from "../background/onedrive-keepass-connection";
import { vaultClient } from "../runtime/client";
import { bytesToBase64 } from "../security/encoding";
import { MONICA_ONEDRIVE_CLIENT_ID } from "../providers/onedrive/onedrive-auth";

const props = defineProps<{ provider?: ProviderAccount }>();
const emit = defineEmits<{ close: []; connected: [result: KeePassOneDriveConnectResult] }>();
const name = ref(props.provider?.name || "KeePass OneDrive");
const password = ref("");
const keyFile = ref<File>();
const revealPassword = ref(false);
const defaultTarget = ref(props.provider?.isDefaultSaveTarget || false);
const clientId = ref(String(props.provider?.config.oneDriveClientId || MONICA_ONEDRIVE_CLIENT_ID));
const login = ref<OneDriveLoginSummary>();
const page = ref<OneDriveBrowserPage>();
const selected = ref<OneDriveItem | undefined>(props.provider ? {
  driveId: String(props.provider.config.oneDriveDriveId), itemId: String(props.provider.config.oneDriveItemId),
  name: String(props.provider.config.fileName || props.provider.name), kind: "file", size: 0
} : undefined);
const folders = ref<Array<{ id: string; name: string }>>([]);
const query = ref("");
const busy = ref<"" | "login" | "browse" | "connect">("");
const error = ref("");
const loginHandle = ref("");
let generation = 0;
const items = computed(() => (page.value?.items || []).filter(item => item.name.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
const accountLabel = computed(() => login.value?.profile.username || login.value?.profile.displayName || props.provider?.config.oneDriveUsername || props.provider?.config.oneDriveDisplayName || "");
const canConnect = computed(() => !busy.value && !!selected.value && (!!login.value || !!props.provider));
const redirectUri = typeof chrome !== "undefined" && chrome.identity ? chrome.identity.getRedirectURL("onedrive") : "";

function invalidateLogin() {
  generation++;
  const handle = loginHandle.value;
  loginHandle.value = "";
  if (handle) void vaultClient.cancelOneDriveLogin(handle).catch(() => undefined);
}
function close() {
  if (busy.value === "connect") return;
  invalidateLogin(); password.value = ""; keyFile.value = undefined;
  emit("close");
}
onBeforeUnmount(() => { invalidateLogin(); password.value = ""; keyFile.value = undefined; });

async function signIn() {
  if (busy.value) return;
  invalidateLogin();
  login.value = undefined; page.value = undefined; folders.value = []; query.value = "";
  if (!props.provider) selected.value = undefined;
  const revision = generation;
  const handle = crypto.randomUUID(); loginHandle.value = handle;
  busy.value = "login"; error.value = "";
  try {
    const result = await vaultClient.loginOneDrive(handle, clientId.value);
    if (revision !== generation) return;
    login.value = result;
    if (!props.provider) await browse([]);
  } catch (cause) {
    if (revision === generation) error.value = cause instanceof Error ? cause.message : tr("OneDrive 登录未完成，请重试。");
  } finally { if (revision === generation) busy.value = ""; }
}

async function browse(path: Array<{ id: string; name: string }>) {
  if (!login.value) return;
  const revision = generation;
  busy.value = "browse"; error.value = "";
  try {
    const result = await vaultClient.browseOneDrive({ loginId: login.value.loginId, parentId: path.at(-1)?.id });
    if (revision !== generation) return;
    page.value = result; folders.value = path; query.value = "";
  } catch (cause) {
    if (revision === generation) error.value = cause instanceof Error ? cause.message : tr("无法读取 OneDrive 文件，请重试。");
  } finally { if (revision === generation) busy.value = ""; }
}

function choose(item: OneDriveItem) {
  if (busy.value) return;
  if (item.kind === "folder") void browse([...folders.value, { id: item.itemId, name: item.name }]);
  else { selected.value = item; if (name.value === "KeePass OneDrive") name.value = item.name.replace(/\.kdbx$/i, ""); }
}

async function connect() {
  if (!canConnect.value) return;
  const revision = generation;
  busy.value = "connect"; error.value = "";
  let encodedKey: string | undefined;
  try {
    if (keyFile.value) {
      if (keyFile.value.size > 16 * 1024 * 1024) throw new Error(tr("密钥文件过大，请选择小于 16 MB 的文件。"));
      const bytes = new Uint8Array(await keyFile.value.arrayBuffer());
      try { encodedKey = bytesToBase64(bytes); } finally { bytes.fill(0); }
    }
    if (revision !== generation) return;
    const result = await vaultClient.openKeePassOneDrive({ providerId: props.provider?.id, loginId: login.value?.loginId,
      driveId: selected.value!.driveId, itemId: selected.value!.itemId, name: name.value,
      databasePassword: password.value, keyFile: encodedKey, isDefaultSaveTarget: defaultTarget.value });
    if (revision !== generation) return;
    loginHandle.value = "";
    password.value = ""; keyFile.value = undefined;
    emit("connected", result); emit("close");
  } catch (cause) {
    if (revision === generation) error.value = cause instanceof Error ? cause.message : tr("无法连接数据库，请重试。");
  } finally { encodedKey = undefined; if (revision === generation) busy.value = ""; }
}
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="close">
    <section class="editor-dialog provider-dialog onedrive-dialog" role="dialog" aria-modal="true" aria-labelledby="onedrive-title">
      <header><div><h2 id="onedrive-title">{{ provider ? tr('管理 OneDrive 数据库') : tr('连接 OneDrive 数据库') }}</h2><p>{{ tr('登录 Microsoft 账号，选择与 Android 共用的 KDBX 文件。') }}</p></div><m3e-icon-button data-dialog-close :aria-label="tr('关闭 OneDrive 设置')" :disabled="busy === 'connect'" @click="close"><m3e-icon name="close" /></m3e-icon-button></header>
      <form class="onedrive-form" @submit.prevent="connect">
        <section class="onedrive-account" :aria-label="tr('Microsoft 账号')">
          <m3e-icon name="cloud" aria-hidden="true" /><div><strong>{{ accountLabel || tr('尚未登录') }}</strong><p>{{ login ? tr('已登录，选择数据库后保存连接。') : provider ? tr('重新登录会保留本机未同步的修改。') : tr('连接后可自动同步密码、Passkey 和附件。') }}</p></div>
          <m3e-button variant="tonal" type="button" :disabled="Boolean(busy)" @click="signIn">{{ busy === 'login' ? tr('正在登录…') : provider ? tr('重新登录') : login ? tr('切换账号') : tr('登录 Microsoft') }}</m3e-button>
        </section>

        <section v-if="login && !provider" class="onedrive-browser" :aria-label="tr('选择 OneDrive 数据库')" :aria-busy="busy === 'browse'">
          <div class="onedrive-path"><m3e-icon-button :aria-label="tr('上一级文件夹')" :disabled="Boolean(busy) || !folders.length" @click="browse(folders.slice(0, -1))"><m3e-icon name="arrow_back" /></m3e-icon-button><strong>{{ folders.at(-1)?.name || tr('我的文件') }}</strong><m3e-icon-button :aria-label="tr('刷新文件列表')" :disabled="Boolean(busy)" @click="browse(folders)"><m3e-icon name="refresh" /></m3e-icon-button></div>
          <m3e-form-field v-field-label variant="filled" hide-subscript="always"><label slot="label">{{ tr('搜索当前文件夹') }}</label><m3e-icon slot="leading-icon" name="search" /><input v-model="query" type="search" :disabled="Boolean(busy)" /></m3e-form-field>
          <p v-if="busy === 'browse'" role="status">{{ tr('正在读取文件…') }}</p>
          <div v-else class="onedrive-files" role="group" :aria-label="tr('文件夹与 KDBX 文件')">
            <button v-for="item in items" :key="item.itemId" class="onedrive-file" type="button" :disabled="Boolean(busy)" :aria-pressed="item.kind === 'file' ? selected?.itemId === item.itemId : undefined" @click="choose(item)"><m3e-icon :name="item.kind === 'folder' ? 'folder' : 'key'" aria-hidden="true" /><span>{{ item.name }}</span><m3e-icon :name="item.kind === 'folder' ? 'chevron_right' : selected?.itemId === item.itemId ? 'check_circle' : 'radio_button_unchecked'" aria-hidden="true" /></button>
            <p v-if="!items.length">{{ query ? tr('没有匹配的文件。') : tr('此文件夹中没有可选择的 KDBX 文件或文件夹。') }}</p>
          </div>
        </section>

        <div v-if="selected" class="onedrive-selection" role="status"><m3e-icon name="encrypted" aria-hidden="true" /><div><strong>{{ tr('已选数据库') }}</strong><p>{{ selected.name }}</p></div></div>
        <template v-if="selected">
          <m3e-form-field v-field-label variant="filled" hide-subscript="always"><label slot="label">{{ tr('密码源名称') }}</label><input v-model="name" :disabled="Boolean(busy)" maxlength="256" /></m3e-form-field>
          <m3e-form-field v-field-label variant="filled" hide-subscript="never"><label slot="label">{{ tr('数据库密码（可留空）') }}</label><input v-model="password" :disabled="Boolean(busy)" :type="revealPassword ? 'text' : 'password'" autocomplete="current-password" :placeholder="provider?.config.databaseCredentialStored ? tr('已加密保存；留空保持不变') : ''" /><m3e-button slot="suffix" variant="text" type="button" @click="revealPassword = !revealPassword">{{ revealPassword ? tr('隐藏') : tr('显示') }}</m3e-button><small slot="hint">{{ tr('使用这个 KDBX 文件的密码。登录凭据和数据库密码会加密保存。') }}</small></m3e-form-field>
          <label class="onedrive-keyfile"><span>{{ tr('密钥文件（可选）') }}</span><input type="file" :disabled="Boolean(busy)" @change="keyFile = ($event.target as HTMLInputElement).files?.[0]" /><small v-if="provider?.config.keyFileConfigured">{{ tr('已加密保存；选择新文件可替换') }}</small></label>
          <label class="onedrive-default"><input v-model="defaultTarget" type="checkbox" :disabled="Boolean(busy)" /><span>{{ tr('设为默认保存位置') }}</span></label>
        </template>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <details v-if="error" class="onedrive-help"><summary>{{ tr('OneDrive 登录设置') }}</summary><p>{{ tr('若 Microsoft 提示重定向地址未注册，请由应用管理员将下方地址添加为 SPA 重定向地址。') }}</p><code>{{ redirectUri }}</code><m3e-form-field v-field-label variant="filled" hide-subscript="never"><label slot="label">{{ tr('Microsoft 应用 ID') }}</label><input v-model="clientId" :disabled="Boolean(busy) || Boolean(provider)" /><small slot="hint">{{ tr('使用自己的应用注册时可在此填写公共应用 ID，无需客户端密钥。') }}</small></m3e-form-field></details>
        <footer><m3e-button variant="text" type="button" :disabled="busy === 'connect'" @click="close">{{ tr('取消') }}</m3e-button><m3e-button variant="filled" type="submit" :disabled="!canConnect">{{ busy === 'connect' ? tr('正在验证并解锁…') : provider ? tr('保存并继续同步') : tr('连接并解锁') }}</m3e-button></footer>
      </form>
    </section>
  </div>
</template>

<style scoped>
.onedrive-dialog { width: min(620px, 100%); }
.onedrive-form { display: grid; gap: 20px; min-width: 0; }
.onedrive-account, .onedrive-selection { display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: center; gap: 12px; padding: 16px; background: var(--md-sys-color-surface-container-high, var(--app-surface-2)); border-radius: 24px; }
.onedrive-account m3e-button { grid-column: 2; justify-self: start; }
.onedrive-account strong, .onedrive-selection p, .onedrive-path strong { overflow-wrap: anywhere; }
.onedrive-account p, .onedrive-selection p { margin: 4px 0 0; color: var(--app-muted); font-size: 14px; }
.onedrive-browser { display: grid; gap: 12px; min-width: 0; }
.onedrive-path { display: grid; grid-template-columns: 48px minmax(0, 1fr) 48px; align-items: center; gap: 4px; }
.onedrive-files { display: grid; gap: 4px; max-height: 280px; overflow: auto; border-radius: 24px; }
.onedrive-file { display: grid; grid-template-columns: 24px minmax(0, 1fr) 24px; align-items: center; gap: 12px; min-height: 64px; padding: 12px 16px; border: 0; border-radius: 4px; background: var(--md-sys-color-surface-container-high, var(--app-surface-2)); color: var(--app-text); text-align: start; font: inherit; cursor: pointer; }
.onedrive-file:first-child { border-start-start-radius: 24px; border-start-end-radius: 24px; }
.onedrive-file:last-child { border-end-start-radius: 24px; border-end-end-radius: 24px; }
.onedrive-file span { overflow-wrap: anywhere; }
.onedrive-file[aria-pressed="true"] { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.onedrive-file:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: -3px; }
.onedrive-file:disabled { cursor: default; opacity: .6; }
.onedrive-keyfile { display: grid; gap: 8px; min-width: 0; }
.onedrive-keyfile input { min-width: 0; width: 100%; }
.onedrive-keyfile input::file-selector-button { min-height: 48px; border: 0; border-radius: 16px; padding: 8px 16px; margin-inline-end: 8px; font: inherit; background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.onedrive-default { display: flex; align-items: center; gap: 12px; min-height: 48px; }
.onedrive-default input { width: 22px; height: 22px; accent-color: var(--md-sys-color-primary); }
.onedrive-help { min-width: 0; color: var(--app-muted); font-size: 14px; }
.onedrive-help code { display: block; overflow-wrap: anywhere; margin-block: 12px; }
.onedrive-help summary { cursor: pointer; min-height: 48px; align-content: center; }
.onedrive-form footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 12px; }
.onedrive-form m3e-form-field { min-width: 0; width: 100%; }
@media (max-width: 580px) {
  .onedrive-dialog { padding: 20px 12px; }
  .onedrive-form m3e-button { --m3e-button-container-height: 48px; }
}
</style>
