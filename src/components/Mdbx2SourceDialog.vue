<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type { ProviderAccount } from "../core/model";
import {
  MDBX2_MAX_INBOUND_FILE_BYTES,
  type Mdbx2HostStatus,
  type Mdbx2UnlockMethod,
  type Mdbx2VaultCredential,
  type Mdbx2VaultInspection,
  type Mdbx2VaultRuntimeStatus,
  type Mdbx2VaultSource
} from "../providers/mdbx2/native-contract";
import { vaultClient } from "../runtime/client";
import type { Mdbx2ManagerSyncStatus, Mdbx2WebDavSettingsInput } from "../runtime/messages";

type NewSourceMode = "local" | "remote";
type BusyState = "" | "probe" | "upload" | "download" | "open" | "save" | "publish";

const props = defineProps<{
  provider?: ProviderAccount;
  initialMode?: NewSourceMode;
  hostStatus?: Mdbx2HostStatus | null;
  runtimeStatus?: Mdbx2VaultRuntimeStatus;
  syncStatus?: Mdbx2ManagerSyncStatus;
}>();

const emit = defineEmits<{
  close: [];
  changed: [];
  notice: [message: string];
  hostStatus: [status: Mdbx2HostStatus];
}>();

const activeProvider = ref<ProviderAccount | undefined>(props.provider);
const providerId = ref(props.provider?.id || "");
const hostStatus = ref<Mdbx2HostStatus | null>(props.hostStatus || null);
const runtimeStatus = ref<Mdbx2VaultRuntimeStatus | undefined>(props.runtimeStatus);
const syncStatus = ref<Mdbx2ManagerSyncStatus | undefined>(props.syncStatus);
const busy = ref<BusyState>("");
const error = ref("");
const uploadProgress = ref(0);
const vaultFile = ref<File | null>(null);
const securityKeyFile = ref<File | null>(null);
const pendingSource = ref<Mdbx2VaultSource | undefined>();
const pendingOriginKey = ref("");
const inspection = ref<Mdbx2VaultInspection | undefined>();
const revealVaultPassword = ref(false);

const config = props.provider?.config || {};
const form = reactive({
  mode: (props.provider ? "local" : props.initialMode || "local") as NewSourceMode,
  name: props.provider?.name || "Monica MDBX2",
  baseUrl: typeof config.webDavBaseUrl === "string" ? config.webDavBaseUrl : "",
  username: typeof config.webDavUsername === "string" ? config.webDavUsername : "",
  webDavPassword: "",
  webDavPasswordConfigured: config.webDavPasswordConfigured === true,
  remotePath: typeof config.remotePath === "string" ? config.remotePath : "",
  unlockMethod: "password" as Mdbx2UnlockMethod,
  vaultPassword: "",
  isDefaultSaveTarget: props.provider?.isDefaultSaveTarget || false
});

const isExisting = computed(() => Boolean(providerId.value));
const hostReady = computed(() => hostStatus.value?.availability === "ready");
const vaultOpen = computed(() => runtimeStatus.value?.open === true);
const remoteFieldsComplete = computed(() => Boolean(form.baseUrl.trim() && form.remotePath.trim()));
const needsSecurityKey = computed(() => form.unlockMethod !== "password");
const canPublish = computed(() => isExisting.value && vaultOpen.value && remoteFieldsComplete.value && !syncStatus.value?.initialized);
const dialogTitle = computed(() => {
  if (isExisting.value) return `管理 ${activeProvider.value?.name || form.name}`;
  return form.mode === "remote" ? "从 WebDAV 加入 MDBX2" : "打开 MDBX2 保险库";
});
const busyLabel = computed(() => ({
  probe: "正在检查 Native Host…",
  upload: `正在传输本地文件… ${uploadProgress.value}%`,
  download: "正在下载并校验可移植备份…",
  open: "正在验证、解锁并检查保险库…",
  save: "正在加密保存设置…",
  publish: "正在生成并发布可移植备份…"
} as Record<Exclude<BusyState, "">, string>)[busy.value as Exclude<BusyState, "">] || "");

onMounted(refreshStatus);
onBeforeUnmount(() => { void releasePendingSource(); });

async function refreshStatus() {
  busy.value = "probe";
  error.value = "";
  try {
    const nextHost = await vaultClient.mdbx2HostStatus();
    hostStatus.value = nextHost;
    emit("hostStatus", nextHost);
    if (!providerId.value || nextHost.availability !== "ready") return;
    const [nextRuntime, nextSync] = await Promise.all([
      vaultClient.mdbx2VaultStatus(providerId.value).catch(() => undefined),
      vaultClient.mdbx2SyncStatus(providerId.value).catch(() => undefined)
    ]);
    runtimeStatus.value = nextRuntime;
    syncStatus.value = nextSync;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

function setMode(mode: NewSourceMode) {
  if (busy.value || form.mode === mode) return;
  form.mode = mode;
  error.value = "";
  inspection.value = undefined;
  void releasePendingSource();
}

function selectVaultFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0] || null;
  vaultFile.value = file;
  inspection.value = undefined;
  error.value = "";
  void releasePendingSource();
  if (file && form.name === "Monica MDBX2") form.name = file.name.replace(/\.mdbx$/i, "") || "Monica MDBX2";
}

function selectSecurityKey(event: Event) {
  securityKeyFile.value = (event.currentTarget as HTMLInputElement).files?.[0] || null;
  error.value = "";
}

async function connectNewSource() {
  if (!hostReady.value) return void (error.value = hostStatus.value?.message || "MDBX2 Native Host 尚未就绪。");
  error.value = "";
  try {
    const source = form.mode === "local" ? await stageLocalFile() : await stageRemoteBootstrap();
    busy.value = "open";
    const opened = await vaultClient.openMdbx2Vault({
      name: form.name,
      source,
      credential: await buildCredential(),
      isDefaultSaveTarget: form.isDefaultSaveTarget
    });
    pendingSource.value = undefined;
    pendingOriginKey.value = "";
    activeProvider.value = opened.account;
    providerId.value = opened.account.id;
    runtimeStatus.value = { vaultHandle: opened.session.vaultHandle, open: true, available: true };

    if (form.mode === "remote") {
      activeProvider.value = await vaultClient.saveMdbx2WebDav(
        opened.account.id,
        form.name,
        webDavSettings(),
        form.isDefaultSaveTarget
      );
      syncStatus.value = await vaultClient.registerMdbx2Bootstrap(opened.account.id);
    }

    const result = await vaultClient.syncProvider(opened.account.id);
    emit("changed");
    emit("notice", syncNotice(result, form.mode === "remote" ? "MDBX2 WebDAV 已加入并同步。" : "MDBX2 本机保险库已打开并导入。"));
    clearSecrets();
    emit("close");
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
    uploadProgress.value = 0;
  }
}

async function unlockExisting() {
  const provider = activeProvider.value;
  const vaultHandle = typeof provider?.config.vaultHandle === "string" ? provider.config.vaultHandle : "";
  if (!providerId.value || !vaultHandle) return void (error.value = "MDBX2 本机工作副本不存在。");
  busy.value = "open";
  error.value = "";
  try {
    const opened = await vaultClient.openMdbx2Vault({
      providerId: providerId.value,
      name: form.name,
      source: { kind: "vault", handle: vaultHandle },
      credential: await buildCredential(),
      isDefaultSaveTarget: form.isDefaultSaveTarget
    });
    activeProvider.value = opened.account;
    runtimeStatus.value = { vaultHandle: opened.session.vaultHandle, open: true, available: true };
    emit("changed");
    emit("notice", `${opened.account.name} 已解锁；可在密码源列表执行增量同步。`);
    clearSecrets();
    emit("close");
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function saveSettings() {
  if (!providerId.value) return;
  busy.value = "save";
  error.value = "";
  try {
    activeProvider.value = await vaultClient.saveMdbx2WebDav(
      providerId.value,
      form.name,
      webDavSettings(),
      form.isDefaultSaveTarget
    );
    form.webDavPassword = "";
    form.webDavPasswordConfigured = activeProvider.value.config.webDavPasswordConfigured === true;
    syncStatus.value = await vaultClient.mdbx2SyncStatus(providerId.value).catch(() => undefined);
    emit("changed");
    emit("notice", "MDBX2 WebDAV 设置已保存到加密密码库。远端位置变化时旧 checkpoint 已解除绑定。");
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function publishBootstrap() {
  if (!providerId.value) return;
  busy.value = "publish";
  error.value = "";
  try {
    activeProvider.value = await vaultClient.saveMdbx2WebDav(
      providerId.value,
      form.name,
      webDavSettings(),
      form.isDefaultSaveTarget
    );
    syncStatus.value = await vaultClient.publishMdbx2Bootstrap(providerId.value);
    form.webDavPassword = "";
    form.webDavPasswordConfigured = activeProvider.value.config.webDavPasswordConfigured === true;
    emit("changed");
    emit("notice", "MDBX2 可移植备份已发布；后续多设备同步使用不可变增量段和加密 Blob。");
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function stageLocalFile(): Promise<Mdbx2VaultSource> {
  const file = vaultFile.value;
  if (!file) throw new Error("请选择 MDBX2 .mdbx 文件。");
  if (!file.name.toLocaleLowerCase().endsWith(".mdbx")) throw new Error("MDBX2 可移植备份必须使用 .mdbx 扩展名。");
  if (!file.size || file.size > MDBX2_MAX_INBOUND_FILE_BYTES) throw new Error("MDBX2 文件为空或超过 2 GiB 安全上限。");
  const originKey = `local:${file.name}:${file.size}:${file.lastModified}`;
  if (pendingSource.value && pendingOriginKey.value === originKey) return pendingSource.value;
  await releasePendingSource();
  busy.value = "upload";
  const transfer = await vaultClient.beginMdbx2Transfer(file.size);
  try {
    let offset = transfer.nextOffset;
    while (offset < file.size) {
      const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + transfer.maxChunkBytes)).arrayBuffer());
      const accepted = await vaultClient.sendMdbx2Chunk(transfer.transferId, offset, bytes);
      offset = accepted.nextOffset;
      uploadProgress.value = Math.min(100, Math.round((offset / file.size) * 100));
    }
    const finished = await vaultClient.finishMdbx2Transfer(transfer.transferId);
    return await acceptPendingSource({ kind: "file", handle: finished.fileHandle }, originKey);
  } catch (cause) {
    await vaultClient.abortMdbx2Transfer(transfer.transferId).catch(() => undefined);
    throw cause;
  }
}

async function stageRemoteBootstrap(): Promise<Mdbx2VaultSource> {
  if (!remoteFieldsComplete.value) throw new Error("请填写 WebDAV 地址和 Android 兼容远端位置。");
  const settings = webDavSettings();
  const originKey = `remote:${settings.baseUrl}\n${settings.username}\n${settings.password}\n${settings.remotePath}`;
  if (pendingSource.value && pendingOriginKey.value === originKey) return pendingSource.value;
  await releasePendingSource();
  busy.value = "download";
  const finished = await vaultClient.downloadMdbx2Bootstrap(settings);
  return acceptPendingSource({ kind: "file", handle: finished.fileHandle }, originKey);
}

async function acceptPendingSource(source: Mdbx2VaultSource, originKey: string): Promise<Mdbx2VaultSource> {
  pendingSource.value = source;
  pendingOriginKey.value = originKey;
  try {
    inspection.value = await vaultClient.inspectMdbx2Vault(source);
    return source;
  } catch (cause) {
    await releasePendingSource();
    throw cause;
  }
}

async function releasePendingSource() {
  const source = pendingSource.value;
  pendingSource.value = undefined;
  pendingOriginKey.value = "";
  inspection.value = undefined;
  if (source?.kind === "file") await vaultClient.releaseMdbx2File(source.handle).catch(() => undefined);
}

async function buildCredential(): Promise<Mdbx2VaultCredential> {
  if (form.unlockMethod === "password") return { method: "password", password: form.vaultPassword };
  const file = securityKeyFile.value;
  if (!file) throw new Error("所选解锁方式需要安全密钥文件。");
  if (!file.size || file.size > 64 * 1024) throw new Error("MDBX2 安全密钥文件为空或超过 64 KiB 上限。");
  const keyMaterialBase64 = await fileAsBase64(file);
  return form.unlockMethod === "security-key"
    ? { method: "security-key", keyMaterialBase64 }
    : { method: "password-security-key", password: form.vaultPassword, keyMaterialBase64 };
}

function webDavSettings(): Mdbx2WebDavSettingsInput {
  return {
    baseUrl: form.baseUrl.trim(),
    username: form.username.trim(),
    password: form.webDavPassword,
    remotePath: form.remotePath.trim()
  };
}

function closeDialog() {
  if (busy.value) return;
  void releasePendingSource();
  clearSecrets();
  emit("close");
}

function clearSecrets() {
  form.vaultPassword = "";
  form.webDavPassword = "";
  securityKeyFile.value = null;
  revealVaultPassword.value = false;
}

function hostStateLabel(status: Mdbx2HostStatus | null): string {
  if (!status) return "检查中";
  return ({ ready: "Host 已就绪", "not-installed": "Host 未安装", incompatible: "Host 版本不兼容", unavailable: "Host 暂不可用" } as const)[status.availability];
}

function hostStateClass(status: Mdbx2HostStatus | null): string {
  return status?.availability === "ready" ? "ready" : status ? "attention" : "neutral";
}

function syncNotice(result: { warnings: string[]; conflicts: number }, fallback: string): string {
  if (result.conflicts) return `${fallback} 检测到 ${result.conflicts} 个需要人工处理的冲突。`;
  return result.warnings[0] || fallback;
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "MDBX2 操作失败。";
}
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section class="editor-dialog provider-dialog mdbx2-dialog" role="dialog" aria-modal="true" aria-labelledby="mdbx2-dialog-title">
      <header>
        <div>
          <h2 id="mdbx2-dialog-title">{{ dialogTitle }}</h2>
          <p>浏览器保存本机加密工作副本，网盘只交换可移植备份、增量段和加密 Blob。</p>
        </div>
        <m3e-icon-button data-dialog-close aria-label="关闭 MDBX2 设置" :disabled="Boolean(busy)" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <form class="provider-form mdbx2-form" @submit.prevent="isExisting ? saveSettings() : connectNewSource()">
        <div class="mdbx2-host-row field-wide" :class="hostStateClass(hostStatus)" role="status" aria-live="polite">
          <m3e-icon :name="hostReady ? 'check_circle' : 'computer'" />
          <div><strong>{{ hostStateLabel(hostStatus) }}</strong><small>{{ hostStatus?.message || '正在检查 com.monica_pass.mdbx2。' }}</small></div>
          <small v-if="hostStatus?.capabilities">Host {{ hostStatus.capabilities.hostVersion }} · Core {{ hostStatus.capabilities.mdbxCoreRevision.slice(0, 8) }}</small>
        </div>

        <template v-if="!isExisting">
          <fieldset class="mdbx2-mode-picker field-wide">
            <legend>加入方式</legend>
            <div>
              <button type="button" :aria-pressed="form.mode === 'local'" :class="{ active: form.mode === 'local' }" :disabled="Boolean(busy)" @click="setMode('local')"><m3e-icon name="folder_open" />本地 .mdbx 文件</button>
              <button type="button" :aria-pressed="form.mode === 'remote'" :class="{ active: form.mode === 'remote' }" :disabled="Boolean(busy)" @click="setMode('remote')"><m3e-icon name="cloud_download" />从 WebDAV 加入</button>
            </div>
          </fieldset>
          <label class="field"><span>显示名称</span><input v-model="form.name" autocomplete="off" autofocus placeholder="Monica MDBX2" /></label>
          <label class="favorite-row"><input v-model="form.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
        </template>

        <template v-if="!isExisting && form.mode === 'local'">
          <div class="field field-wide"><span>MDBX2 可移植备份 *</span><label class="file-action provider-file-action"><m3e-icon name="folder_open" /><span>{{ vaultFile?.name || '选择 .mdbx 文件' }}</span><input type="file" accept=".mdbx,application/octet-stream" aria-label="MDBX2 可移植备份" @change="selectVaultFile" /></label><small>扩展从 MDBX2 开始支持；MDBX1 和 MDBX1-DRAFT 会在只读检查阶段拒绝。</small></div>
        </template>

        <template v-if="form.mode === 'remote' || isExisting">
          <label v-if="isExisting" class="field"><span>显示名称</span><input v-model="form.name" autocomplete="off" /></label>
          <label v-if="isExisting" class="favorite-row"><input v-model="form.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
          <label class="field field-wide"><span>WebDAV 地址 *</span><input v-model="form.baseUrl" type="url" autocomplete="url" placeholder="https://cloud.example.com/remote.php/dav/files/user" required /><small>必须使用 HTTPS；开发环境仅允许回环 HTTP。地址中不能包含用户名、密码、查询参数或片段。</small></label>
          <label class="field"><span>用户名</span><input v-model="form.username" autocomplete="username" /></label>
          <label class="field"><span>WebDAV 密码</span><input v-model="form.webDavPassword" type="password" autocomplete="current-password" :placeholder="form.webDavPasswordConfigured ? '已加密保存；留空保持不变' : ''" /></label>
          <label class="field field-wide"><span>Android 兼容远端位置 *</span><input v-model="form.remotePath" autocomplete="off" placeholder="Monica/MDBX2/main.mdbx" required /><small>此路径就是可移植 .mdbx 文件；日常同步对象自动写入同名 <code>.sync</code> 目录。</small></label>
        </template>

        <template v-if="!isExisting || !vaultOpen">
          <label class="field"><span>解锁方式</span><select v-model="form.unlockMethod"><option value="password">密码</option><option value="security-key">安全密钥</option><option value="password-security-key">密码 + 安全密钥</option></select></label>
          <label v-if="form.unlockMethod !== 'security-key'" class="field"><span>保险库密码（可留空）</span><div class="password-field"><input v-model="form.vaultPassword" :type="revealVaultPassword ? 'text' : 'password'" autocomplete="current-password" /><button type="button" @click="revealVaultPassword = !revealVaultPassword">{{ revealVaultPassword ? '隐藏' : '显示' }}</button></div></label>
          <div v-if="needsSecurityKey" class="field field-wide"><span>安全密钥文件 *</span><label class="file-action provider-file-action secondary"><m3e-icon name="key" /><span>{{ securityKeyFile?.name || '选择最大 64 KiB 的安全密钥文件' }}</span><input type="file" aria-label="MDBX2 安全密钥文件" @change="selectSecurityKey" /></label><small>密码和安全密钥只进入 Native Host 的本次解锁调用，不会保存到插件密码库。</small></div>
        </template>

        <div v-if="inspection" class="mdbx2-inspection field-wide" role="status">
          <span><strong>{{ inspection.formatVersion }}</strong><small>格式</small></span>
          <span><strong>{{ inspection.schemaVersion ?? '—' }}</strong><small>Schema</small></span>
          <span><strong>{{ inspection.requiresUpgrade ? '需要迁移' : '当前版本' }}</strong><small>打开前检查</small></span>
        </div>

        <div v-if="isExisting" class="mdbx2-runtime-summary field-wide" aria-label="MDBX2 运行状态">
          <span><strong>{{ runtimeStatus?.available ? '本机副本可用' : '本机副本缺失' }}</strong><small>{{ vaultOpen ? '当前已解锁' : '当前已锁定' }}</small></span>
          <span><strong>{{ syncStatus?.initialized ? '增量同步已注册' : syncStatus?.configured ? 'WebDAV 已配置' : '仅本机模式' }}</strong><small>{{ syncStatus?.hasLocalChanges ? '存在待发布修改' : 'checkpoint 已保存' }}</small></span>
          <span><strong>{{ syncStatus?.blockedStreamCount || 0 }} 个受阻 stream</strong><small>{{ syncStatus?.remoteStreamCount || 0 }} 个远端 stream</small></span>
        </div>

        <div class="provider-boundaries field-wide" aria-label="MDBX2 浏览器能力边界">
          <div class="boundary-row"><m3e-icon name="database" /><span>单个 .mdbx 用于首次加入和完整备份；多设备日常修改通过 Commit DAG、state delta、Tombstone 和 Blob 增量交换。</span></div>
          <div class="boundary-row"><m3e-icon name="encrypted" /><span>Native Host 负责解锁、迁移、健康检查和核心写入；管理页只接收状态摘要与受限句柄。</span></div>
        </div>

        <div v-if="busy" class="mdbx2-progress field-wide" role="status" aria-live="polite"><progress v-if="busy === 'upload'" :value="uploadProgress" max="100" /><span>{{ busyLabel }}</span></div>
        <p v-if="error" class="form-error field-wide" role="alert">{{ error }}</p>

        <footer class="provider-actions field-wide">
          <m3e-button variant="text" type="button" :disabled="Boolean(busy)" @click="closeDialog">取消</m3e-button>
          <template v-if="isExisting">
            <m3e-button v-if="!vaultOpen" variant="tonal" type="button" :disabled="Boolean(busy) || !hostReady" @click="unlockExisting">解锁本机副本</m3e-button>
            <m3e-button variant="tonal" type="button" :disabled="Boolean(busy) || !remoteFieldsComplete" @click="saveSettings">保存设置</m3e-button>
            <m3e-button v-if="canPublish" variant="filled" type="button" :disabled="Boolean(busy) || !hostReady" @click="publishBootstrap">保存并发布本机保险库</m3e-button>
          </template>
          <m3e-button v-else variant="filled" type="submit" :disabled="Boolean(busy) || !hostReady">{{ form.mode === 'remote' ? '下载并加入' : '验证、解锁并导入' }}</m3e-button>
        </footer>
      </form>
    </section>
  </div>
</template>

<style scoped>
.mdbx2-form { gap: 16px; }
.mdbx2-host-row { min-height: 64px; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px; background: var(--md-sys-color-surface-container-highest, var(--app-surface-high)); }
.mdbx2-host-row > m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-host-row > div { min-width: 0; display: grid; gap: 2px; }
.mdbx2-host-row small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-host-row.ready { color: var(--md-sys-color-on-surface, var(--app-text)); }
.mdbx2-host-row.attention { border-color: var(--md-sys-color-error, #ba1a1a); color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-mode-picker { border: 0; display: grid; gap: 8px; padding: 0; }
.mdbx2-mode-picker legend { margin-bottom: 8px; font-weight: 700; }
.mdbx2-mode-picker > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mdbx2-mode-picker button { min-height: 48px; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; color: var(--app-text); background: var(--md-sys-color-surface-container-highest, var(--app-surface-high)); cursor: pointer; font: inherit; font-weight: 600; }
.mdbx2-mode-picker button.active { border-color: var(--app-primary); color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-mode-picker button:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: 2px; }
.mdbx2-mode-picker m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-inspection,
.mdbx2-runtime-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; }
.mdbx2-inspection span,
.mdbx2-runtime-summary span { min-width: 0; display: grid; gap: 2px; padding: 12px 16px; }
.mdbx2-inspection span + span,
.mdbx2-runtime-summary span + span { border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-inspection small,
.mdbx2-runtime-summary small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-progress { display: flex; align-items: center; gap: 12px; min-height: 44px; color: var(--app-muted); }
.mdbx2-progress progress { width: min(220px, 40%); accent-color: var(--app-primary); }
code { overflow-wrap: anywhere; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
@media (max-width: 700px) {
  .mdbx2-host-row { grid-template-columns: 24px minmax(0, 1fr); }
  .mdbx2-host-row > small { grid-column: 2; }
  .mdbx2-mode-picker > div,
  .mdbx2-inspection,
  .mdbx2-runtime-summary { grid-template-columns: 1fr; }
  .mdbx2-inspection span + span,
  .mdbx2-runtime-summary span + span { border-left: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
  .mdbx2-progress { align-items: stretch; flex-direction: column; }
  .mdbx2-progress progress { width: 100%; }
}
</style>
