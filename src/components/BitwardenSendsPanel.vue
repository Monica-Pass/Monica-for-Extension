<script setup lang="ts">
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { tr, locale } from '../i18n';

import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import type { ProviderAccount } from "../core/model";
import { vaultClient } from "../runtime/client";
import type { BitwardenSendDetail, BitwardenSendFileUploadInput, BitwardenSendSummary } from "../runtime/messages";

const props = defineProps<{
  providers: ProviderAccount[];
  query?: string;
}>();

type EditorMode = "create-text" | "create-file" | "edit";

interface SendFormState {
  name: string;
  text: string;
  notes: string;
  password: string;
  maxAccessCount: string;
  hideEmail: boolean;
  hiddenText: boolean;
  disabled: boolean;
  deletionDate: string;
  expirationDate: string;
}

const selectedProviderId = ref("");
const sends = ref<BitwardenSendSummary[]>([]);
const total = ref(0);
const nextCursor = ref<string | undefined>();
const selectedSendId = ref("");
const selectedSend = ref<BitwardenSendDetail | undefined>();
const loading = ref(false);
const loadingMore = ref(false);
const detailLoading = ref(false);
const mutationBusy = ref(false);
const error = ref("");
const notice = ref("");
const editorOpen = ref(false);
const editorMode = ref<EditorMode>("create-text");
const editorError = ref("");
const revealPassword = ref(false);
const selectedFile = ref<File | null>(null);
const activeTransferId = ref("");
const uploadProgress = ref(0);
const uploadCancelRequested = ref(false);
const editorDialog = ref<HTMLElement | null>(null);
let editorTrigger: HTMLElement | null = null;

const form = reactive<SendFormState>(emptyForm());

const bitwardenProviders = computed(() => props.providers.filter((provider) => provider.kind === "bitwarden"));
const selectedProvider = computed(() => bitwardenProviders.value.find((provider) => provider.id === selectedProviderId.value));
const filteredSends = computed(() => {
  const needle = (props.query || "").trim().toLocaleLowerCase();
  if (!needle) return sends.value;
  return sends.value.filter((send) => `${send.name} ${send.notes} ${send.fileName || ""} ${send.type}`.toLocaleLowerCase().includes(needle));
});
const editingExisting = computed(() => editorMode.value === "edit" ? selectedSend.value : undefined);
const editorTitle = computed(() => editorMode.value === "edit" ? tr('编辑安全发送') : editorMode.value === "create-file" ? tr('新建文件发送') : tr('新建文本发送'));
const editorDescription = computed(() => editorMode.value === "edit"
  ? tr('只更新可表达的字段；未知远端字段和文件内容保持原样。')
  : tr('内容在后台使用独立 Send 密钥加密后上传，页面不会接触 Bitwarden Vault key。'));
const uploadPercent = computed(() => selectedFile.value?.size ? Math.min(100, Math.round(uploadProgress.value / selectedFile.value.size * 100)) : uploadProgress.value ? 100 : 0);
const minimumDate = computed(() => toLocalDateTime(new Date(Date.now() + 2 * 60_000)));
const maximumDeletionDate = computed(() => toLocalDateTime(new Date(Date.now() + 31 * 24 * 60 * 60_000)));

watch(selectedProviderId, async (next, previous) => {
  if (next !== previous) await loadSends(true);
});

watch(bitwardenProviders, (available) => {
  const nextProviderId = available.some((provider) => provider.id === selectedProviderId.value) ? selectedProviderId.value : available[0]?.id || "";
  if (nextProviderId !== selectedProviderId.value) selectedProviderId.value = nextProviderId;
  else void loadSends(true);
}, { immediate: true });

watch(editorOpen, async (open) => {
  if (open) {
    document.addEventListener("keydown", handleEditorKeydown, true);
    await nextTick();
    const target = editorDialog.value?.querySelector<HTMLElement>("[autofocus]") || editorFocusableElements()[0];
    target?.focus();
    return;
  }
  document.removeEventListener("keydown", handleEditorKeydown, true);
  await nextTick();
  editorTrigger?.focus();
  editorTrigger = null;
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleEditorKeydown, true);
  if (activeTransferId.value && selectedProviderId.value) {
    void vaultClient.abortBitwardenSendFileUpload(selectedProviderId.value, activeTransferId.value).catch(() => undefined);
  }
});

async function loadSends(reset: boolean) {
  if (!selectedProviderId.value) {
    sends.value = [];
    selectedSend.value = undefined;
    selectedSendId.value = "";
    total.value = 0;
    nextCursor.value = undefined;
    return;
  }
  const busy = reset ? loading : loadingMore;
  busy.value = true;
  error.value = "";
  const retainedId = reset ? selectedSendId.value : "";
  try {
    const page = await vaultClient.listBitwardenSends(selectedProviderId.value, { pageSize: 100, cursor: reset ? undefined : nextCursor.value });
    sends.value = reset ? page.items : [...sends.value, ...page.items];
    total.value = page.total;
    nextCursor.value = page.nextCursor;
    if (reset) {
      const nextSelected = sends.value.find((send) => send.sendId === retainedId) || sends.value[0];
      if (nextSelected) await selectSend(nextSelected);
      else {
        selectedSendId.value = "";
        selectedSend.value = undefined;
      }
    }
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    busy.value = false;
  }
}

async function selectSend(summary: BitwardenSendSummary) {
  selectedSendId.value = summary.sendId;
  selectedSend.value = { ...summary };
  detailLoading.value = true;
  error.value = "";
  try {
    selectedSend.value = await vaultClient.getBitwardenSend(summary.providerId, summary.sendId);
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    detailLoading.value = false;
  }
}

function selectSendFromList(event: Event) {
  const id = (event.currentTarget as HTMLElement & { value: string }).value;
  const summary = filteredSends.value.find(send => send.sendId === id);
  if (summary) void selectSend(summary);
}

function openCreateText() {
  rememberEditorTrigger();
  editorMode.value = "create-text";
  resetForm();
  editorOpen.value = true;
}

function openCreateFile() {
  rememberEditorTrigger();
  editorMode.value = "create-file";
  resetForm();
  editorOpen.value = true;
}

function openEdit() {
  const send = selectedSend.value;
  if (!send?.editable) return;
  rememberEditorTrigger();
  editorMode.value = "edit";
  Object.assign(form, {
    name: send.name,
    text: send.textContent || "",
    notes: send.notes,
    password: "",
    maxAccessCount: send.maxAccessCount ? String(send.maxAccessCount) : "",
    hideEmail: send.hideEmail,
    hiddenText: Boolean(send.textHidden),
    disabled: send.disabled,
    deletionDate: send.deletionDate ? toLocalDateTime(new Date(send.deletionDate)) : defaultDeletionDate(),
    expirationDate: send.expirationDate ? toLocalDateTime(new Date(send.expirationDate)) : ""
  });
  selectedFile.value = null;
  editorError.value = "";
  revealPassword.value = false;
  editorOpen.value = true;
}

function closeEditor() {
  if (mutationBusy.value) return;
  editorOpen.value = false;
  selectedFile.value = null;
  editorError.value = "";
  form.password = "";
}

function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  selectedFile.value = input.files?.[0] || null;
  input.value = "";
  editorError.value = "";
  if (selectedFile.value && !form.name.trim()) form.name = selectedFile.value.name;
}

async function submitEditor() {
  editorError.value = "";
  if (!selectedProviderId.value) return void (editorError.value = tr('请先连接并选择 Bitwarden 密码源。'));
  if (!form.name.trim()) return void (editorError.value = tr('请输入 Send 标题。'));
  if (!form.deletionDate) return void (editorError.value = tr('请选择自动删除时间。'));
  if (form.expirationDate && Date.parse(form.expirationDate) > Date.parse(form.deletionDate)) return void (editorError.value = tr('到期时间必须早于自动删除时间。'));
  const maxAccessCount = parseOptionalPositiveInteger(form.maxAccessCount);
  if (maxAccessCount === null) return void (editorError.value = tr('访问次数上限必须是正整数。'));
  mutationBusy.value = true;
  uploadCancelRequested.value = false;
  try {
    if (editorMode.value === "edit") await updateSend(maxAccessCount);
    else if (editorMode.value === "create-text") await createTextSend(maxAccessCount);
    else await createFileSend(maxAccessCount);
    editorOpen.value = false;
    form.password = "";
    selectedFile.value = null;
    showNotice(editorMode.value === "edit" ? tr('安全发送已更新。') : tr('安全发送已创建并加密上传。'));
    await loadSends(true);
  } catch (cause) {
    editorError.value = uploadCancelRequested.value ? tr('文件上传已取消，请重新选择文件。') : messageOf(cause);
  } finally {
    if (activeTransferId.value && selectedProviderId.value) {
      await vaultClient.abortBitwardenSendFileUpload(selectedProviderId.value, activeTransferId.value).catch(() => undefined);
    }
    mutationBusy.value = false;
    activeTransferId.value = "";
    uploadProgress.value = 0;
    uploadCancelRequested.value = false;
  }
}

async function createTextSend(maxAccessCount: number | undefined) {
  if (!form.text.trim()) throw new Error(tr('请输入要安全发送的文本内容。'));
  await vaultClient.createBitwardenTextSend(selectedProviderId.value, {
    name: form.name,
    text: form.text,
    notes: form.notes || undefined,
    password: form.password || undefined,
    maxAccessCount,
    hideEmail: form.hideEmail,
    hiddenText: form.hiddenText,
    disabled: form.disabled,
    deletionDate: toIso(form.deletionDate),
    expirationDate: form.expirationDate ? toIso(form.expirationDate) : undefined
  });
}

async function updateSend(maxAccessCount: number | undefined) {
  const send = editingExisting.value;
  if (!send) throw new Error(tr('当前 Send 已失效，请刷新后重试。'));
  if (send.hasPassword && form.password) throw new Error(tr('现有 Send 已有密码，请先使用详情页的“移除密码”，再设置新密码。'));
  await vaultClient.updateBitwardenSend(selectedProviderId.value, {
    sendId: send.sendId,
    expectedRevision: send.revisionDate,
    name: form.name,
    notes: form.notes,
    ...(send.type === "text" ? { text: form.text, hiddenText: form.hiddenText } : {}),
    passwordAction: form.password ? "set" : "preserve",
    password: form.password || undefined,
    maxAccessCount,
    hideEmail: form.hideEmail,
    disabled: form.disabled,
    deletionDate: toIso(form.deletionDate),
    expirationDate: form.expirationDate ? toIso(form.expirationDate) : undefined
  });
}

async function createFileSend(maxAccessCount: number | undefined) {
  const file = selectedFile.value;
  if (!file) throw new Error(tr('请选择要发送的文件。'));
  if (file.size > 100 * 1024 * 1024) throw new Error(tr('文件超过 100 MiB 安全上限。'));
  const input: BitwardenSendFileUploadInput = {
    name: form.name,
    fileName: file.name,
    sizeBytes: file.size,
    notes: form.notes || undefined,
    password: form.password || undefined,
    maxAccessCount,
    hideEmail: form.hideEmail,
    disabled: form.disabled,
    deletionDate: toIso(form.deletionDate),
    expirationDate: form.expirationDate ? toIso(form.expirationDate) : undefined
  };
  const begun = await vaultClient.beginBitwardenSendFileUpload(selectedProviderId.value, input);
  activeTransferId.value = begun.transferId;
  let offset = 0;
  while (offset < file.size) {
    if (uploadCancelRequested.value) throw new Error("upload cancelled");
    const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + begun.maxChunkBytes)).arrayBuffer());
    try {
      const written = await vaultClient.writeBitwardenSendFileChunk(selectedProviderId.value, begun.transferId, offset, bytes);
      offset = written.nextOffset;
      uploadProgress.value = offset;
    } finally {
      bytes.fill(0);
    }
  }
  if (uploadCancelRequested.value) throw new Error("upload cancelled");
  await vaultClient.finishBitwardenSendFileUpload(selectedProviderId.value, begun.transferId);
  uploadProgress.value = file.size || 1;
}

async function cancelUpload() {
  uploadCancelRequested.value = true;
  const transferId = activeTransferId.value;
  if (!transferId || !selectedProviderId.value) return;
  await vaultClient.abortBitwardenSendFileUpload(selectedProviderId.value, transferId).catch(() => undefined);
}

async function removePassword() {
  const send = selectedSend.value;
  if (!send?.hasPassword || !window.confirm(tr('移除“{0}”的访问密码？分享链接仍会保持有效。', { 0: send.name }))) return;
  mutationBusy.value = true;
  error.value = "";
  try {
    selectedSend.value = await vaultClient.removeBitwardenSendPassword(send.providerId, send.sendId, send.revisionDate);
    showNotice(tr('Send 访问密码已移除。'));
    await loadSends(true);
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    mutationBusy.value = false;
  }
}

async function deleteSend() {
  const send = selectedSend.value;
  if (!send || !window.confirm(tr('永久删除安全发送“{0}”？此操作无法撤销。', { 0: send.name }))) return;
  mutationBusy.value = true;
  error.value = "";
  try {
    await vaultClient.deleteBitwardenSend(send.providerId, send.sendId, send.revisionDate);
    selectedSend.value = undefined;
    selectedSendId.value = "";
    showNotice(tr('安全发送已删除。'));
    await loadSends(true);
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    mutationBusy.value = false;
  }
}

async function copyShareUrl() {
  const url = selectedSend.value?.shareUrl;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    showNotice(tr('分享链接已复制。'));
  } catch {
    error.value = tr('浏览器拒绝写入剪贴板，请手动选择并复制链接。');
  }
}

function resetForm() {
  Object.assign(form, emptyForm());
  selectedFile.value = null;
  editorError.value = "";
  revealPassword.value = false;
  uploadProgress.value = 0;
}

function rememberEditorTrigger() {
  editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function handleEditorKeydown(event: KeyboardEvent) {
  if (!editorOpen.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeEditor();
    return;
  }
  if (event.key !== "Tab") return;
  const elements = editorFocusableElements();
  if (!elements.length) return;
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function editorFocusableElements(): HTMLElement[] {
  return Array.from(editorDialog.value?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") || [])
    .filter((element) => element.getClientRects().length > 0);
}

function emptyForm(): SendFormState {
  return {
    name: "",
    text: "",
    notes: "",
    password: "",
    maxAccessCount: "",
    hideEmail: false,
    hiddenText: false,
    disabled: false,
    deletionDate: defaultDeletionDate(),
    expirationDate: ""
  };
}

function defaultDeletionDate(): string {
  return toLocalDateTime(new Date(Date.now() + 7 * 24 * 60 * 60_000));
}

function toLocalDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toIso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(tr('Send 日期格式无效。'));
  return date.toISOString();
}

function parseOptionalPositiveInteger(value: string): number | undefined | null {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function typeLabel(type: BitwardenSendSummary["type"]): string {
  return type === "text" ? tr('文本') : type === "file" ? tr('文件') : tr('未来类型');
}

function authLabel(send: BitwardenSendSummary): string {
  return send.authMode === "password" ? tr('密码验证') : send.authMode === "email" ? tr('邮箱验证') : send.authMode === "none" ? tr('无需验证') : tr('未知验证');
}

function formatDate(value?: string): string {
  return value ? new Date(value).toLocaleString(locale.value) : tr('未设置');
}

function formatBytes(value?: number): string {
  if (value === undefined) return tr('未知大小');
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function showNotice(message: string) {
  notice.value = message;
  window.setTimeout(() => {
    if (notice.value === message) notice.value = "";
  }, 3500);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : tr('Bitwarden Send 操作失败，请重试。');
}
</script>

<template>
  <section class="send-panel" aria-labelledby="bitwarden-send-heading">
    <div class="send-toolbar">
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="provider-select">
        <label slot="label">{{ tr('Bitwarden 密码源') }}</label>
        <component :is="materialSelectTag" @input="selectedProviderId = ($event.target as HTMLElement &amp; { value: string }).value"  :disabled="!bitwardenProviders.length || loading || mutationBusy">
          <component :is="materialOptionTag" :selected.prop="String(selectedProviderId ?? '') === String(provider.id)" v-for="provider in bitwardenProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</component>
        </component>
      </m3e-form-field>
      <div class="toolbar-actions">
        <m3e-button variant="text" :disabled="!selectedProviderId || loading" @click="loadSends(true)"><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ loading ? tr('刷新中…') : tr('刷新') }}</m3e-button>
        <m3e-button variant="tonal" :disabled="!selectedProviderId" @click="openCreateFile"><m3e-icon slot="icon" name="upload_file"></m3e-icon>{{ tr('发送文件') }}</m3e-button>
        <m3e-button variant="filled" :disabled="!selectedProviderId" @click="openCreateText"><m3e-icon slot="icon" name="add"></m3e-icon>{{ tr('发送文本') }}</m3e-button>
      </div>
    </div>

    <p class="send-live-status" aria-live="polite">{{ notice }}</p>
    <div v-if="error" class="send-error" role="alert"><m3e-icon name="error"></m3e-icon><span>{{ error }}</span><m3e-button variant="text" type="button" @click="loadSends(true)">{{ tr('重试') }}</m3e-button></div>

    <div v-if="!bitwardenProviders.length" class="send-empty standalone">
      <m3e-icon name="send"></m3e-icon>
      <h2 id="bitwarden-send-heading">{{ tr('尚未连接 Bitwarden') }}</h2>
      <p>{{ tr('安全发送使用 Bitwarden 或 Vaultwarden 的 Send API。请先在“密码源”中完成连接。') }}</p>
    </div>

    <div v-else class="send-workspace" :aria-busy="loading">
      <aside class="send-list-pane" :aria-label="tr('安全发送列表')">
        <header>
          <div><h2 id="bitwarden-send-heading">{{ tr('安全发送') }}</h2><p>{{ tr('{0} / {1} 项', { 0: filteredSends.length, 1: total }) }}</p></div>
          <span v-if="selectedProvider" class="provider-origin">{{ selectedProvider.name }}</span>
        </header>
        <div v-if="loading && !sends.length" class="send-list-loading" role="status">{{ tr('正在读取并解密 Send 摘要…') }}</div>
        <template v-else-if="filteredSends.length">
        <m3e-selection-list class="send-list" hide-selection-indicator :aria-label="tr('选择安全发送')" @change="selectSendFromList">
          <m3e-list-option
            v-for="send in filteredSends"
            :key="send.sendId"
            class="send-list-item"
            :value="send.sendId"
            :selected.prop="send.sendId === selectedSendId"
          >
            <span slot="leading" class="send-type-icon"><m3e-icon :name="send.type === 'file' ? 'draft' : send.type === 'text' ? 'text_snippet' : 'help'"></m3e-icon></span>
            <strong>{{ send.name }}</strong><small slot="supporting-text">{{ send.fileName || typeLabel(send.type) }} · {{ authLabel(send) }}</small>
            <span v-if="send.disabled" slot="supporting-text" class="send-state-chip">{{ tr('已停用') }}</span>
            <m3e-icon slot="trailing" class="send-row-arrow" name="chevron_right"></m3e-icon>
          </m3e-list-option>
        </m3e-selection-list>
          <m3e-button v-if="nextCursor" class="load-more" variant="text" :disabled="loadingMore" @click="loadSends(false)">{{ loadingMore ? tr('加载中…') : tr('加载更多') }}</m3e-button>
        </template>
        <div v-else class="send-empty compact">
          <m3e-icon name="outbox"></m3e-icon>
          <h3>{{ props.query ? tr('没有匹配的安全发送') : tr('还没有安全发送') }}</h3>
          <p>{{ props.query ? tr('换一个关键词试试。') : tr('新建文本或文件 Send 后，分享链接会显示在右侧详情。') }}</p>
        </div>
      </aside>

      <article v-if="selectedSend" class="send-detail" :aria-busy="detailLoading">
        <header class="detail-heading">
          <div class="detail-title">
            <span class="send-type-icon large"><m3e-icon :name="selectedSend.type === 'file' ? 'draft' : selectedSend.type === 'text' ? 'text_snippet' : 'help'"></m3e-icon></span>
            <div><p>{{ typeLabel(selectedSend.type) }} Send</p><h2>{{ selectedSend.name }}</h2></div>
          </div>
          <div class="detail-chips"><span>{{ authLabel(selectedSend) }}</span><span v-if="selectedSend.disabled">{{ tr('分享已停用') }}</span><span v-if="selectedSend.textHidden">{{ tr('打开后默认隐藏') }}</span></div>
        </header>

        <div v-if="selectedSend.warning" class="compat-warning" role="status"><m3e-icon name="info"></m3e-icon><span>{{ selectedSend.warning }}</span></div>

        <section class="detail-section" aria-labelledby="send-share-title">
          <div class="section-heading"><div><h3 id="send-share-title">{{ tr('分享链接') }}</h3><p>{{ tr('链接包含访问此 Send 所需的 URL 密钥，请只发给可信收件人。') }}</p></div></div>
          <div class="share-row"><m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('Send 分享链接') }}</label><input :value="selectedSend.shareUrl" readonly :aria-label="tr('Send 分享链接')" @focus="($event.target as HTMLInputElement).select()" /></m3e-form-field><m3e-button variant="tonal" :disabled="!selectedSend.shareUrl" @click="copyShareUrl"><m3e-icon slot="icon" name="content_copy"></m3e-icon>{{ tr('复制链接') }}</m3e-button></div>
        </section>

        <section v-if="selectedSend.type === 'text'" class="detail-section" aria-labelledby="send-content-title">
          <div class="section-heading"><div><h3 id="send-content-title">{{ tr('文本内容') }}</h3><p>{{ tr('仅在选择此项目后由后台解密。') }}</p></div></div>
          <pre class="send-text-content">{{ selectedSend.textContent || tr('（空内容）') }}</pre>
        </section>

        <section v-else-if="selectedSend.type === 'file'" class="detail-section file-summary" aria-labelledby="send-file-title">
          <span class="file-icon"><m3e-icon name="draft"></m3e-icon></span>
          <div><h3 id="send-file-title">{{ selectedSend.fileName || tr('未命名文件') }}</h3><p>{{ formatBytes(selectedSend.fileSizeBytes) }}</p><small>{{ tr('当前版本支持所有者上传与策略管理；文件内容下载仍由 Bitwarden 分享页完成。') }}</small></div>
        </section>

        <section v-if="selectedSend.notes" class="detail-section" aria-labelledby="send-notes-title"><h3 id="send-notes-title">{{ tr('备注') }}</h3><p class="send-notes">{{ selectedSend.notes }}</p></section>

        <dl class="send-policy-grid" :aria-label="tr('Send 访问策略')">
          <div><dt>{{ tr('访问次数') }}</dt><dd>{{ selectedSend.accessCount }}{{ selectedSend.maxAccessCount ? ` / ${selectedSend.maxAccessCount}` : tr(' / 不限') }}</dd></div>
          <div><dt>{{ tr('到期时间') }}</dt><dd>{{ formatDate(selectedSend.expirationDate) }}</dd></div>
          <div><dt>{{ tr('自动删除') }}</dt><dd>{{ formatDate(selectedSend.deletionDate) }}</dd></div>
          <div><dt>{{ tr('最近修订') }}</dt><dd>{{ formatDate(selectedSend.revisionDate) }}</dd></div>
        </dl>

        <footer class="detail-actions">
          <m3e-button variant="tonal" :disabled="!selectedSend.editable || mutationBusy" @click="openEdit"><m3e-icon slot="icon" name="edit"></m3e-icon>{{ tr('编辑') }}</m3e-button>
          <m3e-button v-if="selectedSend.hasPassword" variant="text" :disabled="mutationBusy" @click="removePassword"><m3e-icon slot="icon" name="password"></m3e-icon>{{ tr('移除密码') }}</m3e-button>
          <m3e-button class="danger-action" variant="text" :disabled="mutationBusy" @click="deleteSend"><m3e-icon slot="icon" name="delete"></m3e-icon>{{ tr('删除') }}</m3e-button>
        </footer>
      </article>

      <div v-else class="send-empty detail-placeholder"><m3e-icon name="send"></m3e-icon><h2>{{ tr('选择一个安全发送') }}</h2><p>{{ tr('查看分享链接、加密内容和访问策略。') }}</p></div>
    </div>

    <div v-if="editorOpen" class="send-modal-backdrop" role="presentation" @mousedown.self="closeEditor">
      <section ref="editorDialog" class="send-editor" role="dialog" aria-modal="true" aria-labelledby="send-editor-title">
        <header><div><h2 id="send-editor-title">{{ editorTitle }}</h2><p>{{ editorDescription }}</p></div><m3e-icon-button data-dialog-close :aria-label="tr('关闭安全发送编辑器')" :disabled="mutationBusy" @click="closeEditor"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header>
        <form novalidate @submit.prevent="submitEditor">
          <m3e-form-field v-field-label variant="filled" hide-required-marker class="send-field"><label slot="label">{{ tr('标题 *') }}</label><input v-model="form.name" autofocus autocomplete="off" /></m3e-form-field>

          <label v-if="editorMode === 'create-file'" class="send-field field-wide"><span>{{ tr('文件 *') }}</span><span class="send-file-picker"><m3e-icon name="upload_file"></m3e-icon><span>{{ selectedFile ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}` : tr('选择不超过 100 MiB 的文件') }}</span><input type="file" :aria-label="tr('选择安全发送文件')" @change="selectFile" /></span></label>
          <m3e-form-field v-field-label variant="filled" hide-required-marker v-else-if="editorMode === 'create-text' || editingExisting?.type === 'text'" class="send-field field-wide"><label slot="label">{{ tr('文本内容 *') }}</label><textarea v-model="form.text" rows="7"></textarea></m3e-form-field>

          <m3e-form-field v-field-label variant="filled" hide-required-marker class="send-field field-wide"><label slot="label">{{ tr('备注') }}</label><textarea v-model="form.notes" rows="3"></textarea></m3e-form-field>

          <fieldset class="send-fieldset field-wide"><legend>{{ tr('访问策略') }}</legend>
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="send-field"><label slot="label">{{ tr('自动删除 *') }}</label><input v-model="form.deletionDate" type="datetime-local" :min="editorMode === 'edit' ? undefined : minimumDate" :max="maximumDeletionDate" /></m3e-form-field>
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="send-field"><label slot="label">{{ tr('提前到期') }}</label><input v-model="form.expirationDate" type="datetime-local" :min="editorMode === 'edit' ? undefined : minimumDate" :max="form.deletionDate || maximumDeletionDate" /></m3e-form-field>
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="send-field"><label slot="label">{{ tr('访问次数上限') }}</label><input v-model="form.maxAccessCount" type="number" min="1" step="1" inputmode="numeric" :placeholder="tr('不限制')" /></m3e-form-field>
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="send-field"><label slot="label">{{ editingExisting?.hasPassword ? tr('访问密码') : tr('访问密码（可选）') }}</label><span class="password-input"><input v-model="form.password" :type="revealPassword ? 'text' : 'password'" autocomplete="new-password" :disabled="Boolean(editingExisting?.hasPassword)" :placeholder="editingExisting?.hasPassword ? tr('已设置；请先在详情页移除') : ''" /><m3e-button variant="text" type="button" :disabled="Boolean(editingExisting?.hasPassword)" @click="revealPassword = !revealPassword">{{ revealPassword ? tr('隐藏') : tr('显示') }}</m3e-button></span></m3e-form-field>
          </fieldset>

          <fieldset class="send-options field-wide"><legend>{{ tr('显示与可用性') }}</legend>
            <label v-choice-label><m3e-checkbox :checked.prop="form.hideEmail" @input="form.hideEmail = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span>{{ tr('向访问者隐藏所有者邮箱') }}</span></label>
            <label v-choice-label v-if="editorMode !== 'create-file' && editingExisting?.type !== 'file'"><m3e-checkbox :checked.prop="form.hiddenText" @input="form.hiddenText = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span>{{ tr('访问页面默认隐藏文本') }}</span></label>
            <label v-choice-label><m3e-checkbox :checked.prop="form.disabled" @input="form.disabled = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span>{{ tr('暂时停用分享链接') }}</span></label>
          </fieldset>

          <div v-if="activeTransferId" class="upload-status field-wide" role="status" aria-live="polite"><div><strong>{{ tr('正在加密上传文件') }}</strong><span>{{ uploadPercent }}%</span></div><progress :value="uploadProgress" :max="selectedFile?.size || 1"></progress><m3e-button variant="text" type="button" @click="cancelUpload">{{ tr('取消上传') }}</m3e-button></div>
          <p v-if="editorError" class="editor-error field-wide" role="alert">{{ editorError }}</p>
          <footer class="field-wide"><m3e-button variant="text" type="button" :disabled="mutationBusy" @click="closeEditor">{{ tr('取消') }}</m3e-button><m3e-button variant="filled" type="submit" :disabled="mutationBusy">{{ mutationBusy ? activeTransferId ? tr('上传中 {0}%', { 0: uploadPercent }) : tr('保存中…') : editorMode === 'edit' ? tr('保存修改') : tr('加密并创建') }}</m3e-button></footer>
        </form>
      </section>
    </div>
  </section>
</template>

<style scoped>
.send-panel {
  min-width: 0;
  display: grid;
  gap: 8px;
}

.send-toolbar,
.toolbar-actions,
.detail-heading,
.detail-title,
.detail-chips,
.detail-actions,
.send-error,
.send-editor > header,
.upload-status > div {
  display: flex;
  align-items: center;
}

.send-toolbar {
  min-width: 0;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.toolbar-actions {
  gap: 8px;
  flex-wrap: wrap;
}

.provider-select,
.send-field {
  min-width: 0;
}

label.send-field {
  display: grid;
  gap: 6px;
  color: var(--md-sys-color-on-surface, var(--app-text));
  font-weight: 500;
}

.provider-select {
  width: min(320px, 100%);
}

.provider-select > span,
.send-field > span:first-child {
  font-size: 0.82rem;
}

select,
input,
textarea {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--md-sys-color-outline, var(--app-outline));
  border-radius: 8px;
  color: var(--md-sys-color-on-surface, var(--app-text));
  background: var(--md-sys-color-surface-container-highest, var(--app-surface-high));
  font: inherit;
}

select,
input {
  min-height: 44px;
  padding: 0 12px;
}

textarea {
  resize: vertical;
  padding: 12px;
  line-height: 1.55;
}

select:focus-visible,
input:focus-visible,
textarea:focus-visible,
button:focus-visible,
.send-file-picker:focus-within {
  outline: 3px solid var(--md-sys-color-primary, var(--app-primary));
  outline-offset: 2px;
}

.send-live-status {
  min-height: 24px;
  margin: 0;
  color: var(--md-sys-color-primary, var(--app-primary));
  font-weight: 600;
}

.send-error {
  min-height: 48px;
  gap: 10px;
  border: 1px solid var(--md-sys-color-error, #ba1a1a);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--md-sys-color-on-error-container, #410002);
  background: var(--md-sys-color-error-container, #ffdad6);
}

.send-error m3e-icon {
  --m3e-icon-size: 20px;
  flex: 0 0 auto;
}

.send-error span {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}

.send-error button {
  min-width: 56px;
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}

.send-workspace {
  min-width: 0;
  min-height: 560px;
  display: grid;
  grid-template-columns: minmax(260px, 336px) minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
  background: var(--md-sys-color-surface-container, var(--app-surface));
}

.send-list-pane {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.send-list-pane > header {
  min-height: 76px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  padding: 16px;
}

.send-list-pane h2,
.send-list-pane h3,
.send-detail h2,
.send-detail h3,
.send-editor h2,
.send-list-pane p,
.send-detail p,
.send-editor p {
  margin: 0;
}

.send-list-pane h2,
.send-detail h2 {
  overflow-wrap: anywhere;
}

.send-list-pane header p,
.provider-origin,
.detail-title p,
.section-heading p,
.file-summary p,
.file-summary small,
.send-list-copy small,
.send-empty p,
.send-editor header p {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  line-height: 1.5;
}

.send-list-pane header p,
.provider-origin {
  font-size: 0.8rem;
}

.provider-origin {
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.send-list {
  min-width: 0;
  display: grid;
  align-content: start;
}

.send-list-item {
  min-width: 0;
  min-height: 72px;
}

.send-list-item > strong { font-weight: 500; overflow-wrap: anywhere; }
.send-list-item > small { overflow-wrap: anywhere; }

.send-type-icon,
.file-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 8px;
  color: var(--md-sys-color-on-primary-container, var(--app-text));
  background: var(--md-sys-color-primary-container, var(--app-selected));
}

.send-type-icon {
  width: 44px;
  height: 44px;
}

.send-type-icon.large,
.file-icon {
  width: 48px;
  height: 48px;
}

.send-type-icon m3e-icon,
.file-icon m3e-icon,
.send-row-arrow {
  --m3e-icon-size: 20px;
}

.send-list-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.send-list-copy strong,
.send-list-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.send-state-chip,
.detail-chips span {
  border-radius: 999px;
  padding: 4px 8px;
  background: var(--md-sys-color-tertiary-container, var(--app-selected));
  color: var(--md-sys-color-on-tertiary-container, var(--app-text));
  font-size: 0.75rem;
  font-weight: 700;
}

.send-row-arrow {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
}

.load-more {
  justify-self: center;
  margin: 8px;
}

.send-list-loading {
  padding: 24px 16px;
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
}

.send-detail {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 24px;
  padding: 24px;
}

.detail-heading {
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.detail-title {
  min-width: 0;
  align-items: flex-start;
  gap: 12px;
}

.detail-title > div {
  min-width: 0;
}

.detail-title p {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.detail-chips {
  max-width: 42%;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.compat-warning {
  min-height: 48px;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
  padding: 10px 12px;
  color: var(--md-sys-color-on-secondary-container, var(--app-text));
  background: var(--md-sys-color-secondary-container, var(--app-selected));
}

.compat-warning m3e-icon {
  --m3e-icon-size: 20px;
}

.detail-section {
  min-width: 0;
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  padding-top: 20px;
}

.section-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.section-heading p {
  margin-top: 4px;
}

.share-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.send-text-content {
  max-height: 320px;
  overflow: auto;
  margin: 0;
  border-radius: 8px;
  padding: 16px;
  background: var(--md-sys-color-surface-container-highest, var(--app-surface-high));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.6;
}

.file-summary {
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
}

.file-summary small,
.send-notes {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.send-policy-grid {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  overflow: hidden;
  margin: 0;
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
}

.send-policy-grid > div {
  min-width: 0;
  display: grid;
  gap: 4px;
  padding: 12px 14px;
}

.send-policy-grid > div:nth-child(even) {
  border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.send-policy-grid > div:nth-child(n + 3) {
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.send-policy-grid dt {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  font-size: 0.78rem;
}

.send-policy-grid dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.detail-actions {
  min-width: 0;
  gap: 8px;
  flex-wrap: wrap;
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  padding-top: 16px;
}

.danger-action {
  margin-left: auto;
  color: var(--md-sys-color-error, #ba1a1a);
}

.send-empty {
  min-width: 0;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  padding: 32px 20px;
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  text-align: center;
}

.send-empty.standalone {
  min-height: 380px;
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
  background: var(--md-sys-color-surface-container, var(--app-surface));
}

.send-empty.compact {
  min-height: 280px;
}

.send-empty.detail-placeholder {
  min-height: 420px;
}

.send-empty > m3e-icon {
  --m3e-icon-size: 24px;
  color: var(--md-sys-color-primary, var(--app-primary));
}

.send-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  overflow: auto;
  padding: 24px;
  background: rgb(0 0 0 / 52%);
}

.send-editor {
  width: min(760px, 100%);
  max-height: calc(100dvh - 48px);
  overflow: auto;
  border-radius: 16px;
  color: var(--md-sys-color-on-surface, var(--app-text));
  background: var(--md-sys-color-surface-container-high, var(--app-surface));
}

.send-editor > header {
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  padding: 20px 24px;
}

.send-editor > header > div {
  min-width: 0;
}

.send-editor header p {
  margin-top: 4px;
}

.send-editor form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  padding: 24px;
}

.field-wide {
  grid-column: 1 / -1;
}

.send-fieldset,
.send-options {
  min-width: 0;
  margin: 0;
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
  padding: 16px;
}

.send-fieldset {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.send-fieldset legend,
.send-options legend {
  padding: 0 6px;
  font-weight: 700;
}

.send-options {
  display: flex;
  gap: 12px 24px;
  flex-wrap: wrap;
}

.send-options label {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.send-options input {
  width: 20px;
  min-height: 20px;
  accent-color: var(--md-sys-color-primary, var(--app-primary));
}

.password-input {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
}

.password-input input {
  border-radius: 8px 0 0 8px;
}

.password-input button {
  min-width: 64px;
  min-height: 44px;
  border: 1px solid var(--md-sys-color-outline, var(--app-outline));
  border-left: 0;
  border-radius: 0 8px 8px 0;
  color: var(--md-sys-color-on-secondary-container, var(--app-text));
  background: var(--md-sys-color-secondary-container, var(--app-selected));
  cursor: pointer;
  font: inherit;
  font-weight: 650;
}

.password-input button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.send-file-picker {
  min-width: 0;
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 8px;
  padding: 0 14px;
  color: var(--md-sys-color-on-secondary-container, var(--app-text));
  background: var(--md-sys-color-secondary-container, var(--app-selected));
  cursor: pointer;
  overflow-wrap: anywhere;
}

.send-file-picker m3e-icon {
  --m3e-icon-size: 20px;
  flex: 0 0 auto;
}

.send-file-picker input {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  opacity: 0;
}

.upload-status {
  display: grid;
  gap: 8px;
  border-radius: 8px;
  padding: 12px;
  background: var(--md-sys-color-secondary-container, var(--app-selected));
}

.upload-status > div {
  justify-content: space-between;
  gap: 12px;
}

.upload-status progress {
  width: 100%;
  height: 8px;
  accent-color: var(--md-sys-color-primary, var(--app-primary));
}

.upload-status m3e-button {
  justify-self: start;
}

.editor-error {
  margin: 0;
  color: var(--md-sys-color-error, #ba1a1a);
  font-weight: 650;
}

.send-editor footer {
  min-width: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  padding-top: 16px;
}

@media (max-width: 900px) {
  .send-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .send-list-pane {
    max-height: 360px;
    overflow: auto;
    border-right: 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  }
}

@media (max-width: 600px) {
  .send-toolbar,
  .toolbar-actions,
  .detail-heading {
    align-items: stretch;
  }

  .provider-select,
  .toolbar-actions,
  .toolbar-actions m3e-button {
    width: 100%;
  }

  .toolbar-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  .toolbar-actions m3e-button:first-child {
    grid-column: auto;
  }

  .send-detail {
    padding: 16px;
  }

  .detail-heading {
    display: grid;
  }

  .detail-chips {
    max-width: none;
    justify-content: flex-start;
  }

  .share-row,
  .send-policy-grid,
  .send-editor form,
  .send-fieldset {
    grid-template-columns: minmax(0, 1fr);
  }

  .send-policy-grid > div:nth-child(even) {
    border-left: 0;
  }

  .send-policy-grid > div + div {
    border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  }

  .danger-action {
    width: 100%;
    margin-left: 0;
  }

  .send-modal-backdrop {
    align-items: end;
    padding: 8px;
  }

  .send-editor {
    width: 100%;
    max-height: 94dvh;
    border-radius: 16px;
  }

  .send-editor > header,
  .send-editor form {
    padding: 16px;
  }

  .field-wide {
    grid-column: auto;
  }

  .send-options {
    display: grid;
  }
}

@media (prefers-reduced-motion: reduce) {
  .send-list-item {
    transition: none;
  }
}
</style>
