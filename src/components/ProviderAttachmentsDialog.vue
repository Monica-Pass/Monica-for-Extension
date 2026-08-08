<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { ProviderAccount, VaultItem } from "../core/model";
import {
  BITWARDEN_ATTACHMENT_MAX_BYTES,
  KEEPASS_ATTACHMENT_MAX_BYTES,
  MDBX2_ATTACHMENT_MAX_BYTES,
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  type ProviderAttachmentSummary
} from "../providers/attachments/attachment-contract";
import type { ProviderAttachmentTransferMode } from "../providers/attachments/attachment-transfer";
import {
  keepassManagedPhotoSlotForFileName,
  keepassManagedPhotoSlots,
  type KeePassManagedPhotoSlot
} from "../providers/keepass/keepass-managed-photos";
import { base64ToBytes } from "../security/encoding";
import { ExtensionRuntimeError, vaultClient } from "../runtime/client";
import type { ProviderAttachmentRecoveryStatus } from "../runtime/messages";

interface PendingUpload {
  providerId: string;
  file: File;
  operationId: string;
  attachmentId: string;
  fileName: string;
  mediaType?: string;
  replaceExisting: boolean;
  displayName: string;
  transferId?: string;
}

interface PendingFileSelection {
  attachment?: ProviderAttachmentSummary;
  managedPhoto?: KeePassManagedPhotoSlot;
}

interface PendingTransfer {
  attachment: ProviderAttachmentSummary;
  targetProviderId: string;
  mode: ProviderAttachmentTransferMode;
  operationId: string;
  attempted: boolean;
}

const props = defineProps<{
  item: VaultItem;
  providers: ProviderAccount[];
}>();

const emit = defineEmits<{
  close: [];
  notice: [message: string];
}>();

const selectedProviderId = ref(props.providers[0]?.id || "");
const attachments = ref<ProviderAttachmentSummary[]>([]);
const knownPlaintextSizes = ref(new Map<string, number>());
const nextCursor = ref<string | undefined>();
const loaded = ref(false);
const listBusy = ref(false);
const downloadingAttachmentId = ref("");
const deletingAttachmentId = ref("");
const pendingDelete = ref<ProviderAttachmentSummary | undefined>();
const pendingUpload = ref<PendingUpload | undefined>();
const pendingFileSelection = ref<PendingFileSelection | undefined>();
const pendingTransfer = ref<PendingTransfer | undefined>();
const uploadBusy = ref(false);
const transferBusy = ref(false);
const uploadProgress = ref(0);
const recovery = ref<ProviderAttachmentRecoveryStatus | undefined>();
const recoveryBusy = ref(false);
const error = ref("");
const status = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const fileInputAccept = ref("");
const dialogRoot = ref<HTMLElement | null>(null);
let activeRead: { providerId: string; readHandle: string } | undefined;
let listGeneration = 0;
const deleteOperationIds = new Map<string, string>();

const selectedProvider = computed(() => props.providers.find((provider) => provider.id === selectedProviderId.value));
const transferTargets = computed(() => props.providers.filter((provider) => provider.id !== selectedProviderId.value));
const pendingTransferTarget = computed(() => transferTargets.value.find((provider) => provider.id === pendingTransfer.value?.targetProviderId));
const interactionLocked = computed(() => listBusy.value || uploadBusy.value || transferBusy.value || recoveryBusy.value || Boolean(downloadingAttachmentId.value) || Boolean(deletingAttachmentId.value));
const providerLimit = computed(() => attachmentLimit(selectedProvider.value));
const managedPhotoSlots = computed(() => {
  if (selectedProvider.value?.kind !== "keepass") return [];
  return keepassManagedPhotoSlots(props.item.kind);
});
const regularAttachments = computed(() => {
  const managedNames = new Set(managedPhotoSlots.value.map((slot) => slot.fileName));
  return attachments.value.filter((attachment) => !managedNames.has(attachment.fileName));
});
const providerDescription = computed(() => {
  if (selectedProvider.value?.kind === "mdbx2") return "MDBX2 外部附件会写入加密 Blob，并随现有增量同步发布。";
  if (selectedProvider.value?.kind === "bitwarden") return "Bitwarden 附件使用独立密钥加密；后台会先完成认证校验，再把明文交给管理页下载。";
  if (selectedProvider.value?.config.sourceMode === "webdav") return "KeePass 附件写入本机加密工作副本，并通过精确 ETag 发布到 WebDAV。";
  return "KeePass 附件保存在当前已解锁的 KDBX 会话中，完成后需要导出数据库文件。";
});

watch(selectedProviderId, () => {
  deleteOperationIds.clear();
  pendingDelete.value = undefined;
  pendingTransfer.value = undefined;
  error.value = "";
  status.value = "";
  recovery.value = undefined;
  void discardPendingUpload().finally(async () => {
    await Promise.all([loadAttachments(true), loadRecoveryStatus()]);
  });
}, { immediate: true });

onBeforeUnmount(() => {
  deleteOperationIds.clear();
  if (activeRead) void vaultClient.releaseProviderAttachmentRead(activeRead.providerId, activeRead.readHandle).catch(() => undefined);
  if (pendingUpload.value?.transferId) void vaultClient.abortProviderAttachmentUpload(pendingUpload.value.providerId, pendingUpload.value.transferId).catch(() => undefined);
});

async function loadAttachments(reset: boolean) {
  const provider = selectedProvider.value;
  if (!provider) return;
  const generation = ++listGeneration;
  listBusy.value = true;
  if (reset) {
    attachments.value = [];
    nextCursor.value = undefined;
    loaded.value = false;
  }
  try {
    const page = await vaultClient.listProviderAttachments(provider.id, props.item.id, {
      pageSize: 50,
      cursor: reset ? undefined : nextCursor.value
    });
    if (generation !== listGeneration || provider.id !== selectedProviderId.value) return;
    const incoming = page.items.map((attachment) => withKnownPlaintextSize(provider.id, attachment));
    attachments.value = reset ? incoming : appendUniqueAttachments(attachments.value, incoming);
    nextCursor.value = page.nextCursor;
    loaded.value = true;
    error.value = "";
  } catch (cause) {
    if (generation === listGeneration) error.value = errorMessage(cause);
  } finally {
    if (generation === listGeneration) listBusy.value = false;
  }
}

function chooseAttachmentFile(attachment?: ProviderAttachmentSummary, managedPhoto?: KeePassManagedPhotoSlot) {
  if (interactionLocked.value) return;
  pendingFileSelection.value = { attachment, managedPhoto };
  fileInputAccept.value = managedPhoto ? "image/*" : "";
  if (fileInput.value) {
    fileInput.value.value = "";
    fileInput.value.click();
  }
}

async function handleFileSelection(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  const selection = pendingFileSelection.value;
  pendingFileSelection.value = undefined;
  input.value = "";
  if (!file || !selection) return;
  if (selection.managedPhoto && file.type && !file.type.toLocaleLowerCase().startsWith("image/")) {
    error.value = "正面或背面照片必须是图像文件。";
    return;
  }
  if (!selection.managedPhoto && keepassManagedPhotoSlotForFileName(props.item.kind, file.name)) {
    error.value = "此文件名由 Android 正面或背面照片保留，请使用照片入口。";
    return;
  }
  if (file.size > providerLimit.value) {
    error.value = `附件超过 ${formatBytes(providerLimit.value)} 上限。`;
    return;
  }
  await discardPendingUpload();
  const operationId = crypto.randomUUID();
  pendingUpload.value = {
    providerId: selectedProviderId.value,
    file,
    operationId,
    attachmentId: selection.attachment?.attachmentId || crypto.randomUUID(),
    fileName: selection.managedPhoto?.fileName || selection.attachment?.fileName || file.name,
    mediaType: selection.managedPhoto?.mediaType || (selection.attachment ? selection.attachment.mediaType : file.type || undefined),
    replaceExisting: Boolean(selection.attachment),
    displayName: selection.managedPhoto?.label || selection.attachment?.fileName || file.name
  };
  uploadProgress.value = 0;
  await runPendingUpload();
}

async function runPendingUpload() {
  const upload = pendingUpload.value;
  if (!upload || upload.providerId !== selectedProviderId.value) return;
  uploadBusy.value = true;
  error.value = "";
  status.value = upload.replaceExisting ? `正在替换 ${upload.displayName}。` : `正在添加 ${upload.displayName}。`;
  try {
    const begun = await vaultClient.beginProviderAttachmentUpload(upload.providerId, props.item.id, {
      fileName: upload.fileName,
      mediaType: upload.mediaType,
      sizeBytes: upload.file.size,
      replaceExisting: upload.replaceExisting,
      operationId: upload.operationId,
      attachmentId: upload.attachmentId
    });
    upload.transferId = begun.transferId;
    let offset = begun.nextOffset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > upload.file.size) throw new Error("附件上传恢复位置无效，请取消后重新选择文件。");
    uploadProgress.value = percentage(offset, upload.file.size);
    while (offset < upload.file.size) {
      const end = Math.min(offset + begun.maxChunkBytes, upload.file.size);
      const bytes = new Uint8Array(await upload.file.slice(offset, end).arrayBuffer());
      if (!bytes.length || bytes.length > PROVIDER_ATTACHMENT_CHUNK_BYTES) throw new Error("附件上传分块无效，请重新选择文件。");
      const chunk = await vaultClient.sendProviderAttachmentChunk(upload.providerId, begun.transferId, offset, bytes);
      if (chunk.nextOffset <= offset || chunk.nextOffset > upload.file.size) throw new Error("附件上传进度无效，请取消后重试。");
      offset = chunk.nextOffset;
      uploadProgress.value = percentage(offset, upload.file.size);
    }
    const completed = await vaultClient.finishProviderAttachmentUpload(upload.providerId, props.item.id, begun.transferId, upload.operationId);
    if (completed.attachment) rememberPlaintextSize(upload.providerId, completed.attachment.attachmentId, completed.attachment.sizeBytes);
    await vaultClient.abortProviderAttachmentUpload(upload.providerId, begun.transferId).catch(() => false);
    const completedLabel = upload.replaceExisting ? `${upload.displayName} 已替换。` : `${upload.displayName} 已添加。`;
    pendingUpload.value = undefined;
    uploadProgress.value = 100;
    status.value = completedLabel;
    emit("notice", completedLabel);
    await loadAttachments(true);
    await loadRecoveryStatus();
  } catch (cause) {
    error.value = `${errorMessage(cause)} 可使用原文件和原操作标识重试，或取消此次上传。`;
    status.value = "";
  } finally {
    uploadBusy.value = false;
  }
}

async function discardPendingUpload() {
  const upload = pendingUpload.value;
  pendingUpload.value = undefined;
  uploadProgress.value = 0;
  fileInputAccept.value = "";
  if (upload?.transferId) await vaultClient.abortProviderAttachmentUpload(upload.providerId, upload.transferId).catch(() => false);
}

async function cancelPendingUpload() {
  if (uploadBusy.value) return;
  await discardPendingUpload();
  error.value = "";
  status.value = "附件上传已取消。";
  await loadAttachments(true);
}

async function downloadAttachment(attachment: ProviderAttachmentSummary) {
  if (interactionLocked.value) return;
  const providerId = selectedProviderId.value;
  downloadingAttachmentId.value = attachment.attachmentId;
  error.value = "";
  status.value = `正在读取 ${attachment.fileName}。`;
  try {
    const begun = await vaultClient.beginProviderAttachmentRead(providerId, props.item.id, attachment.attachmentId);
    activeRead = { providerId, readHandle: begun.readHandle };
    rememberPlaintextSize(providerId, begun.attachmentId, begun.sizeBytes);
    const parts: BlobPart[] = [];
    let offset = 0;
    while (offset < begun.sizeBytes) {
      const chunk = await vaultClient.readProviderAttachmentChunk(providerId, begun.readHandle, offset, begun.maxChunkBytes);
      if (chunk.readHandle !== begun.readHandle || chunk.attachmentId !== begun.attachmentId || chunk.offset !== offset || chunk.nextOffset <= offset || chunk.nextOffset > begun.sizeBytes) {
        throw new Error("附件下载分块与当前读取会话不一致。");
      }
      const bytes = base64ToBytes(chunk.dataBase64);
      if (bytes.byteLength !== chunk.nextOffset - chunk.offset) throw new Error("附件下载分块长度无效。");
      parts.push(bytes.slice().buffer);
      offset = chunk.nextOffset;
      if (chunk.eof !== (offset === begun.sizeBytes)) throw new Error("附件下载结束标记无效。");
    }
    const blobUrl = URL.createObjectURL(new Blob(parts, { type: begun.mediaType || "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = begun.fileName;
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    status.value = `${begun.fileName} 已交给浏览器下载。`;
  } catch (cause) {
    error.value = errorMessage(cause);
    status.value = "";
  } finally {
    if (activeRead) await vaultClient.releaseProviderAttachmentRead(activeRead.providerId, activeRead.readHandle).catch(() => false);
    activeRead = undefined;
    downloadingAttachmentId.value = "";
  }
}

async function requestDelete(attachment: ProviderAttachmentSummary) {
  if (interactionLocked.value) return;
  pendingDelete.value = attachment;
  error.value = "";
  await nextTick();
  dialogRoot.value?.querySelector<HTMLElement>("[data-confirm-delete]")?.focus();
}

async function confirmDelete() {
  const attachment = pendingDelete.value;
  if (!attachment) return;
  const managedPhotoSlot = managedPhotoSlotForAttachment(attachment);
  const providerId = selectedProviderId.value;
  const operationKey = `${providerId}\n${props.item.id}\n${attachment.attachmentId}`;
  deletingAttachmentId.value = attachment.attachmentId;
  error.value = "";
  let deleted = false;
  try {
    const operationId = deleteOperationIds.get(operationKey) || crypto.randomUUID();
    deleteOperationIds.set(operationKey, operationId);
    await vaultClient.deleteProviderAttachment(providerId, props.item.id, attachment.attachmentId, operationId);
    deleteOperationIds.delete(operationKey);
    knownPlaintextSizes.value.delete(attachmentKey(providerId, attachment.attachmentId));
    pendingDelete.value = undefined;
    status.value = `${attachment.fileName} 已删除。`;
    emit("notice", `${attachment.fileName} 已删除。`);
    await loadAttachments(true);
    await loadRecoveryStatus();
    deleted = true;
  } catch (cause) {
    error.value = errorMessage(cause);
    if (selectedProvider.value?.kind === "bitwarden") await loadRecoveryStatus();
  } finally {
    deletingAttachmentId.value = "";
  }
  if (deleted) {
    await nextTick();
    const focusTarget = managedPhotoSlot
      ? dialogRoot.value?.querySelector<HTMLElement>(`[data-managed-photo-action="${managedPhotoSlot.id}"]`)
      : dialogRoot.value?.querySelector<HTMLElement>('[aria-label="刷新附件列表"]');
    focusTarget?.focus();
  }
}

async function requestTransfer(attachment: ProviderAttachmentSummary) {
  if (interactionLocked.value || !transferTargets.value.length) return;
  pendingDelete.value = undefined;
  pendingTransfer.value = {
    attachment,
    targetProviderId: transferTargets.value[0].id,
    mode: "copy",
    operationId: crypto.randomUUID(),
    attempted: false
  };
  error.value = "";
  status.value = "";
  await nextTick();
  dialogRoot.value?.querySelector<HTMLElement>("[data-confirm-transfer]")?.focus();
}

function cancelTransfer() {
  if (transferBusy.value) return;
  pendingTransfer.value = undefined;
  error.value = "";
}

async function confirmTransfer() {
  const transfer = pendingTransfer.value;
  const sourceProvider = selectedProvider.value;
  const targetProvider = pendingTransferTarget.value;
  if (!transfer || !sourceProvider || !targetProvider) return;
  const sourceSize = knownAttachmentSize(transfer.attachment);
  if (sourceSize !== undefined && sourceSize > attachmentLimit(targetProvider)) {
    error.value = `目标密码源单个附件上限为 ${formatBytes(attachmentLimit(targetProvider))}。`;
    return;
  }
  transferBusy.value = true;
  transfer.attempted = true;
  error.value = "";
  status.value = transfer.mode === "move"
    ? `正在把 ${transfer.attachment.fileName} 移动到 ${targetProvider.name}；来源会在目标逐字节验证后删除。`
    : `正在把 ${transfer.attachment.fileName} 复制到 ${targetProvider.name}。`;
  try {
    const result = await vaultClient.transferProviderAttachment({
      operationId: transfer.operationId,
      sourceProviderId: sourceProvider.id,
      sourceItemId: props.item.id,
      sourceAttachmentId: transfer.attachment.attachmentId,
      targetProviderId: targetProvider.id,
      targetItemId: props.item.id,
      mode: transfer.mode,
      confirmedMove: transfer.mode === "move"
    });
    const message = result.mode === "move"
      ? `${transfer.attachment.fileName} 已完整写入 ${targetProvider.name} 并从 ${sourceProvider.name} 删除。`
      : `${transfer.attachment.fileName} 已完整复制到 ${targetProvider.name}。`;
    pendingTransfer.value = undefined;
    status.value = message;
    emit("notice", message);
    await loadAttachments(true);
  } catch (cause) {
    error.value = transferErrorMessage(cause);
    status.value = "";
  } finally {
    transferBusy.value = false;
  }
}

async function closeDialog() {
  if (interactionLocked.value) return;
  await discardPendingUpload();
  deleteOperationIds.clear();
  pendingTransfer.value = undefined;
  emit("close");
}

function appendUniqueAttachments(current: ProviderAttachmentSummary[], incoming: ProviderAttachmentSummary[]) {
  const next = new Map(current.map((attachment) => [attachment.attachmentId, attachment]));
  for (const attachment of incoming) next.set(attachment.attachmentId, attachment);
  return [...next.values()];
}

function attachmentKey(providerId: string, attachmentId: string): string {
  return `${providerId}\n${attachmentId}`;
}

function withKnownPlaintextSize(providerId: string, attachment: ProviderAttachmentSummary): ProviderAttachmentSummary {
  const sizeBytes = knownPlaintextSizes.value.get(attachmentKey(providerId, attachment.attachmentId));
  return sizeBytes === undefined ? attachment : { ...attachment, sizeBytes };
}

function rememberPlaintextSize(providerId: string, attachmentId: string, sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return;
  knownPlaintextSizes.value.set(attachmentKey(providerId, attachmentId), sizeBytes);
  attachments.value = attachments.value.map((attachment) => attachment.attachmentId === attachmentId
    ? { ...attachment, sizeBytes }
    : attachment);
}

function percentage(received: number, total: number): number {
  return total === 0 ? 100 : Math.min(100, Math.round(received / total * 100));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

function attachmentSizeLabel(attachment: ProviderAttachmentSummary): string {
  const provider = selectedProvider.value;
  if (provider?.kind !== "bitwarden") return formatBytes(attachment.sizeBytes);
  const known = knownAttachmentSize(attachment);
  if (known !== undefined) return `${formatBytes(known)} 明文`;
  return `${formatBytes(attachment.sizeBytes)} 加密存储`;
}

function knownAttachmentSize(attachment: ProviderAttachmentSummary): number | undefined {
  const provider = selectedProvider.value;
  if (provider?.kind !== "bitwarden") return attachment.sizeBytes;
  return knownPlaintextSizes.value.get(attachmentKey(provider.id, attachment.attachmentId));
}

function attachmentLimit(provider: ProviderAccount | undefined): number {
  if (provider?.kind === "mdbx2") return MDBX2_ATTACHMENT_MAX_BYTES;
  if (provider?.kind === "bitwarden") return BITWARDEN_ATTACHMENT_MAX_BYTES;
  return KEEPASS_ATTACHMENT_MAX_BYTES;
}

function managedPhotoAttachment(slot: KeePassManagedPhotoSlot): ProviderAttachmentSummary | undefined {
  return attachments.value.find((attachment) => attachment.fileName === slot.fileName);
}

function managedPhotoStatus(slot: KeePassManagedPhotoSlot): string {
  const attachment = managedPhotoAttachment(slot);
  return attachment ? `已保存 · ${attachmentSizeLabel(attachment)}` : "未添加";
}

function downloadManagedPhoto(slot: KeePassManagedPhotoSlot): void {
  const attachment = managedPhotoAttachment(slot);
  if (attachment) void downloadAttachment(attachment);
}

function requestDeleteManagedPhoto(slot: KeePassManagedPhotoSlot): void {
  const attachment = managedPhotoAttachment(slot);
  if (attachment) void requestDelete(attachment);
}

function managedPhotoSlotForAttachment(attachment: ProviderAttachmentSummary): KeePassManagedPhotoSlot | undefined {
  if (selectedProvider.value?.kind !== "keepass") return undefined;
  return keepassManagedPhotoSlotForFileName(props.item.kind, attachment.fileName);
}

async function loadRecoveryStatus() {
  const provider = selectedProvider.value;
  if (!provider || provider.kind !== "bitwarden") {
    recovery.value = undefined;
    return;
  }
  recoveryBusy.value = true;
  try {
    recovery.value = await vaultClient.providerAttachmentRecoveryStatus(provider.id);
  } catch (cause) {
    recovery.value = undefined;
    if (!error.value) error.value = errorMessage(cause);
  } finally {
    recoveryBusy.value = false;
  }
}

function recoveryStageLabel(stage: string): string {
  return ({
    intent: "等待准备",
    preparing: "准备加密材料",
    prepared: "等待上传",
    uploading: "正在上传",
    verifying: "正在验证",
    verified: "等待完成",
    "deleting-old": "正在删除旧附件",
    deleting: "正在删除",
    "rolling-back": "正在回滚"
  } as Record<string, string>)[stage] || "等待恢复";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function transferErrorMessage(cause: unknown): string {
  const message = errorMessage(cause);
  const code = cause instanceof ExtensionRuntimeError ? cause.code : undefined;
  if (code === "attachment-name-conflict" || code === "attachment-size-invalid" || code === "attachment-transfer-size-invalid") {
    return `${message} 取消本次操作后可选择其他目标；来源附件保持不变。`;
  }
  if (code === "attachment-transfer-verification-failed" || code === "attachment-transfer-target-mismatch") {
    return `${message} 请检查目标密码源后重新开始；来源附件保持不变。`;
  }
  if (code === "attachment-transfer-source-delete-failed" || code === "attachment-transfer-source-delete-unconfirmed") {
    return `${message} 可保留当前操作标识重试来源删除；目标副本会继续保留。`;
  }
  return `${message} 可使用同一操作标识重试；来源附件不会被提前删除。`;
}
</script>

<template>
  <div class="modal-backdrop attachment-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section ref="dialogRoot" class="editor-dialog provider-attachments-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-attachments-title">
      <header>
        <div>
          <h2 id="provider-attachments-title">附件 · {{ item.title }}</h2>
          <p>附件内容只在管理页按需读取。Popup 与网页内容脚本无法调用此接口。</p>
        </div>
        <m3e-icon-button data-dialog-close aria-label="关闭附件管理" :disabled="interactionLocked" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <div class="attachment-toolbar">
        <label v-if="providers.length > 1" class="attachment-provider-field">
          <span>密码源</span>
          <select v-model="selectedProviderId" :disabled="interactionLocked">
            <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
        </label>
        <div v-else class="attachment-provider-summary">
          <m3e-icon :name="selectedProvider?.kind === 'mdbx2' ? 'database' : selectedProvider?.kind === 'bitwarden' ? 'shield_lock' : 'key'"></m3e-icon>
          <span><strong>{{ selectedProvider?.name }}</strong><small>{{ selectedProvider?.kind === 'mdbx2' ? 'MDBX2' : selectedProvider?.kind === 'bitwarden' ? 'Bitwarden' : 'KeePass' }}</small></span>
        </div>
        <m3e-button variant="filled" type="button" :disabled="interactionLocked" @click="chooseAttachmentFile()"><m3e-icon slot="icon" name="attach_file_add"></m3e-icon>添加附件</m3e-button>
        <input ref="fileInput" class="attachment-file-input" type="file" :accept="fileInputAccept || undefined" aria-label="选择附件文件" @change="handleFileSelection" />
      </div>

      <p class="attachment-provider-help">{{ providerDescription }} 单个附件上限 {{ formatBytes(providerLimit) }}。</p>

      <section v-if="managedPhotoSlots.length" class="keepass-managed-photos" aria-labelledby="keepass-managed-photos-title">
        <header>
          <div>
            <strong id="keepass-managed-photos-title">{{ item.kind === 'card' ? '银行卡照片' : '证件照片' }}</strong>
            <small>使用 Monica Android 保留的 KDBX 文件名；其他普通附件保持原样。</small>
          </div>
          <m3e-icon name="image"></m3e-icon>
        </header>
        <div v-for="slot in managedPhotoSlots" :key="slot.id" class="keepass-managed-photo-row" :data-managed-photo-slot="slot.id">
          <span class="managed-photo-icon"><m3e-icon name="image"></m3e-icon></span>
          <div class="managed-photo-copy">
            <strong>{{ slot.label }}</strong>
            <small>{{ managedPhotoStatus(slot) }}</small>
          </div>
          <div class="managed-photo-actions">
            <m3e-button
              :data-managed-photo-action="slot.id"
              variant="tonal"
              type="button"
              :disabled="interactionLocked"
              @click="chooseAttachmentFile(managedPhotoAttachment(slot), slot)"
            >
              <m3e-icon slot="icon" name="upload_file"></m3e-icon>{{ managedPhotoAttachment(slot) ? '替换' : '添加' }}
            </m3e-button>
            <m3e-icon-button
              v-if="managedPhotoAttachment(slot)"
              :aria-label="`下载${slot.label}`"
              :disabled="interactionLocked"
              @click="downloadManagedPhoto(slot)"
            ><m3e-icon name="download"></m3e-icon></m3e-icon-button>
            <m3e-icon-button
              v-if="managedPhotoAttachment(slot)"
              class="attachment-delete-button"
              :aria-label="`删除${slot.label}`"
              :disabled="interactionLocked"
              @click="requestDeleteManagedPhoto(slot)"
            ><m3e-icon name="delete"></m3e-icon></m3e-icon-button>
          </div>
          <div v-if="pendingDelete?.attachmentId === managedPhotoAttachment(slot)?.attachmentId" class="attachment-delete-confirmation keepass-managed-photo-delete">
            <m3e-icon name="warning"></m3e-icon>
            <span><strong>删除{{ slot.label }}？</strong><small>删除会移除 Android 保留的 KDBX Binary；其他普通附件不会受到影响。</small></span>
            <span class="attachment-confirm-actions">
              <m3e-button variant="text" type="button" :disabled="Boolean(deletingAttachmentId)" @click="pendingDelete = undefined">取消</m3e-button>
              <m3e-button data-confirm-delete class="attachment-confirm-delete" variant="tonal" type="button" :disabled="Boolean(deletingAttachmentId)" @click="confirmDelete">{{ deletingAttachmentId ? '删除中…' : '确认删除' }}</m3e-button>
            </span>
          </div>
        </div>
      </section>

      <section v-if="recovery?.pending.length" class="attachment-recovery-panel" role="status" aria-labelledby="attachment-recovery-title">
        <m3e-icon name="sync_problem"></m3e-icon>
        <div>
          <strong id="attachment-recovery-title">Bitwarden 有 {{ recovery.pending.length }} 个附件操作待恢复</strong>
          <small>后台不会重复创建附件。请使用原文件重试；完成前不要清除浏览器站点数据。</small>
          <ul>
            <li v-for="record in recovery.pending" :key="record.operationId">{{ record.kind === 'delete' ? '删除' : record.kind === 'replace' ? '替换' : '添加' }} · {{ recoveryStageLabel(record.stage) }} · {{ new Date(record.updatedAt).toLocaleString() }}</li>
          </ul>
        </div>
        <m3e-icon-button aria-label="刷新 Bitwarden 恢复状态" :disabled="interactionLocked" @click="loadRecoveryStatus"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button>
      </section>

      <div v-if="pendingUpload" class="attachment-upload-panel" aria-labelledby="attachment-upload-title">
        <span class="attachment-file-icon"><m3e-icon name="upload_file"></m3e-icon></span>
        <div>
          <strong id="attachment-upload-title">{{ pendingUpload.replaceExisting ? `替换 ${pendingUpload.fileName}` : pendingUpload.fileName }}</strong>
          <small>{{ formatBytes(pendingUpload.file.size) }}<template v-if="pendingUpload.replaceExisting"> · 保留现有文件名与媒体类型</template></small>
          <progress :value="uploadProgress" max="100" aria-label="附件上传进度"></progress>
        </div>
        <span class="attachment-progress-value">{{ uploadProgress }}%</span>
        <div v-if="!uploadBusy" class="attachment-upload-actions">
          <m3e-button variant="tonal" type="button" @click="runPendingUpload"><m3e-icon slot="icon" name="refresh"></m3e-icon>重试</m3e-button>
          <m3e-button variant="text" type="button" @click="cancelPendingUpload">取消上传</m3e-button>
        </div>
      </div>

      <div v-if="error" class="attachment-message attachment-error" role="alert"><m3e-icon name="error"></m3e-icon><span>{{ error }}</span></div>
      <p class="attachment-status" aria-live="polite">{{ status }}</p>

      <section class="attachment-list-shell" aria-labelledby="attachment-list-title">
        <div class="attachment-list-heading">
          <div><strong id="attachment-list-title">普通附件</strong><small>{{ regularAttachments.length }} 个已加载</small></div>
          <m3e-icon-button aria-label="刷新附件列表" :disabled="interactionLocked" @click="loadAttachments(true)"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button>
        </div>

        <div v-if="listBusy && !loaded" class="attachment-empty" role="status"><m3e-icon name="progress_activity"></m3e-icon><span>正在读取附件摘要…</span></div>
        <div v-else-if="loaded && !regularAttachments.length" class="attachment-empty"><m3e-icon name="attach_file_off"></m3e-icon><span>此项目还没有普通附件。</span></div>
        <ul v-else class="attachment-list">
          <li v-for="attachment in regularAttachments" :key="attachment.attachmentId" class="provider-attachment-row">
            <div class="attachment-row-main">
              <span class="attachment-file-icon"><m3e-icon name="draft"></m3e-icon></span>
              <span class="attachment-copy"><strong>{{ attachment.fileName }}</strong><small>{{ attachmentSizeLabel(attachment) }} · {{ attachment.mediaType || '未知媒体类型' }} · 随密码源加密</small></span>
              <span class="attachment-row-actions">
                <m3e-icon-button :aria-label="`下载 ${attachment.fileName}`" :disabled="interactionLocked" @click="downloadAttachment(attachment)"><m3e-icon :name="downloadingAttachmentId === attachment.attachmentId ? 'progress_activity' : 'download'"></m3e-icon></m3e-icon-button>
                <m3e-icon-button :aria-label="`替换 ${attachment.fileName} 的内容`" :disabled="interactionLocked" @click="chooseAttachmentFile(attachment)"><m3e-icon name="upload_file"></m3e-icon></m3e-icon-button>
                <m3e-icon-button v-if="transferTargets.length" :aria-label="`复制或移动 ${attachment.fileName} 到其他密码源`" :disabled="interactionLocked" @click="requestTransfer(attachment)"><m3e-icon name="drive_file_move"></m3e-icon></m3e-icon-button>
                <m3e-icon-button class="attachment-delete-button" :aria-label="`删除 ${attachment.fileName}`" :disabled="interactionLocked" @click="requestDelete(attachment)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button>
              </span>
            </div>
            <div v-if="pendingTransfer?.attachment.attachmentId === attachment.attachmentId" class="attachment-transfer-panel">
              <m3e-icon name="drive_file_move"></m3e-icon>
              <div class="attachment-transfer-content">
                <div><strong>跨密码源传输</strong><small>文件名和字节保持不变；同名目标不会被静默替换。</small></div>
                <label class="attachment-transfer-target"><span>目标密码源</span><select v-model="pendingTransfer.targetProviderId" :aria-label="`目标密码源 · ${attachment.fileName}`" :disabled="transferBusy || pendingTransfer.attempted"><option v-for="provider in transferTargets" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select></label>
                <fieldset class="attachment-transfer-mode" :disabled="transferBusy || pendingTransfer.attempted"><legend>操作</legend><label><input v-model="pendingTransfer.mode" type="radio" value="copy" /><span>复制</span></label><label><input v-model="pendingTransfer.mode" type="radio" value="move" /><span>移动</span></label></fieldset>
                <p><m3e-icon :name="pendingTransfer.mode === 'move' ? 'verified_user' : 'content_copy'"></m3e-icon><span>{{ pendingTransfer.mode === 'move' ? '目标写入并重新读取校验成功后才删除来源；删除失败时保留两个副本。' : '来源保持不变；目标写入后会重新读取并逐字节校验。' }}</span></p>
                <small v-if="pendingTransferTarget">目标上限 {{ formatBytes(attachmentLimit(pendingTransferTarget)) }} · 原始字节仅在后台传输</small>
              </div>
              <span class="attachment-transfer-actions"><m3e-button variant="text" type="button" :disabled="transferBusy" @click="cancelTransfer">取消</m3e-button><m3e-button data-confirm-transfer variant="tonal" type="button" :disabled="transferBusy" @click="confirmTransfer">{{ transferBusy ? '传输中…' : pendingTransfer.attempted ? '重试传输' : pendingTransfer.mode === 'move' ? '确认移动' : '确认复制' }}</m3e-button></span>
            </div>
            <div v-if="pendingDelete?.attachmentId === attachment.attachmentId" class="attachment-delete-confirmation">
              <m3e-icon name="warning"></m3e-icon>
               <span><strong>永久删除此附件？</strong><small>{{ selectedProvider?.kind === 'mdbx2' ? '删除会写入 MDBX2，并在下次同步时传播 Tombstone。' : selectedProvider?.kind === 'bitwarden' ? '删除会先确认远端状态；响应中断时可使用同一操作标识重试。' : '删除会写入当前 KeePass 会话；请导出 KDBX 文件保存修改。' }}</small></span>
              <span class="attachment-confirm-actions">
                <m3e-button variant="text" type="button" :disabled="Boolean(deletingAttachmentId)" @click="pendingDelete = undefined">取消</m3e-button>
                <m3e-button data-confirm-delete class="attachment-confirm-delete" variant="tonal" type="button" :disabled="Boolean(deletingAttachmentId)" @click="confirmDelete">{{ deletingAttachmentId ? '删除中…' : '确认删除' }}</m3e-button>
              </span>
            </div>
          </li>
        </ul>
        <div v-if="nextCursor" class="attachment-more"><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="loadAttachments(false)">加载更多</m3e-button></div>
      </section>

      <footer><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="closeDialog">关闭</m3e-button></footer>
    </section>
  </div>
</template>

<style scoped>
.provider-attachments-dialog {
  width: min(100%, 720px);
  overflow-x: hidden;
}

.provider-attachments-dialog :deep(m3e-icon) {
  --m3e-icon-size: 20px;
}

.provider-attachments-dialog :deep(m3e-icon-button) {
  --m3e-icon-button-icon-size: 20px;
}

.provider-attachments-dialog :deep(m3e-button) {
  --m3e-button-icon-size: 20px;
}

.provider-attachments-dialog > header {
  min-width: 0;
  overflow-x: clip;
}

.provider-attachments-dialog > header > div {
  min-width: 0;
}

.attachment-toolbar {
  min-width: 0;
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  overflow-x: clip;
}

.attachment-provider-field,
.attachment-provider-summary {
  min-width: 0;
  flex: 1 1 260px;
}

.attachment-provider-field {
  display: grid;
  gap: 6px;
  font-weight: 600;
}

.attachment-provider-field select {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--md-sys-color-outline, var(--app-outline));
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--app-text);
  background: var(--md-sys-color-surface-container-lowest, var(--app-surface));
  font: inherit;
}

.attachment-provider-summary {
  min-height: 48px;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.attachment-provider-summary > m3e-icon {
  --m3e-icon-size: 20px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--app-primary);
  background: var(--md-sys-color-secondary-container, var(--app-selected));
}

.attachment-provider-summary span,
.attachment-copy,
.attachment-upload-panel > div,
.attachment-transfer-content,
.attachment-delete-confirmation > span:nth-child(2),
.attachment-list-heading > div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.attachment-provider-summary small,
.attachment-copy small,
.attachment-upload-panel small,
.attachment-transfer-panel small,
.attachment-delete-confirmation small,
.attachment-list-heading small {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  overflow-wrap: anywhere;
}

.attachment-provider-help {
  margin: 8px 0 16px;
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  line-height: 1.5;
}

.keepass-managed-photos {
  min-width: 0;
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
  overflow: hidden;
  margin: 0 0 12px;
  background: var(--md-sys-color-surface-container-lowest, var(--app-surface));
}

.keepass-managed-photos > header {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.keepass-managed-photos > header > div,
.managed-photo-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.keepass-managed-photos > header small,
.managed-photo-copy small {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  overflow-wrap: anywhere;
  line-height: 1.45;
}

.keepass-managed-photos > header > m3e-icon {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  color: var(--app-primary);
  background: var(--md-sys-color-secondary-container, var(--app-selected));
  border-radius: 8px;
  --m3e-icon-size: 20px;
}

.keepass-managed-photo-row {
  min-width: 0;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

.keepass-managed-photo-row + .keepass-managed-photo-row {
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.managed-photo-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--app-primary);
  background: var(--md-sys-color-surface-container-high, var(--app-surface-high));
}

.managed-photo-icon m3e-icon {
  --m3e-icon-size: 20px;
}

.managed-photo-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.managed-photo-actions :deep(m3e-button) {
  min-height: 44px;
}

.keepass-managed-photo-delete {
  grid-column: 1 / -1;
  width: 100%;
  margin-top: 2px;
}

.attachment-recovery-panel {
  min-width: 0;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) 44px;
  align-items: start;
  gap: 12px;
  border: 1px solid var(--md-sys-color-tertiary, var(--app-primary));
  border-radius: 8px;
  padding: 12px 12px 12px 16px;
  margin: 0 0 12px;
  color: var(--md-sys-color-on-tertiary-container, var(--app-text));
  background: var(--md-sys-color-tertiary-container, var(--app-surface-high));
}

.attachment-recovery-panel > m3e-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  --m3e-icon-size: 20px;
}

.attachment-recovery-panel > div {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.attachment-recovery-panel small,
.attachment-recovery-panel li {
  overflow-wrap: anywhere;
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  line-height: 1.45;
}

.attachment-recovery-panel ul {
  margin: 2px 0 0;
  padding-left: 18px;
}

.attachment-file-input {
  display: none;
}

.attachment-upload-panel {
  min-height: 80px;
  border: 1px solid var(--md-sys-color-primary, var(--app-primary));
  border-radius: 8px;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
  margin-bottom: 12px;
  color: var(--md-sys-color-on-primary-container, var(--app-text));
  background: var(--md-sys-color-primary-container, var(--app-selected));
}

.attachment-upload-panel progress {
  width: 100%;
  height: 6px;
  margin-top: 8px;
  accent-color: var(--md-sys-color-primary, var(--app-primary));
}

.attachment-progress-value {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.attachment-upload-actions {
  grid-column: 2 / -1;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.attachment-message {
  min-height: 48px;
  border-radius: 8px;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.attachment-message m3e-icon {
  --m3e-icon-size: 20px;
}

.attachment-error {
  border: 1px solid var(--md-sys-color-error, #ba1a1a);
  color: var(--md-sys-color-on-error-container, var(--app-text));
  background: var(--md-sys-color-error-container, var(--app-surface-high));
}

.attachment-status {
  min-height: 24px;
  margin: 0 0 8px;
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
}

.attachment-list-shell {
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-lowest, var(--app-surface));
}

.attachment-list-heading {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px 10px 16px;
  overflow-x: clip;
}

.attachment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.provider-attachment-row + .provider-attachment-row {
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.attachment-row-main {
  min-height: 72px;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 16px;
  overflow-x: clip;
}

.attachment-file-icon {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--app-primary);
  background: var(--md-sys-color-surface-container-high, var(--app-surface-high));
}

.attachment-file-icon m3e-icon {
  --m3e-icon-size: 20px;
}

.attachment-copy strong {
  overflow-wrap: anywhere;
}

.attachment-row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.attachment-row-actions m3e-icon {
  --m3e-icon-size: 20px;
}

.attachment-delete-button,
.attachment-confirm-delete {
  color: var(--md-sys-color-error, #ba1a1a);
}

.attachment-transfer-panel {
  border-top: 1px solid var(--md-sys-color-primary, var(--app-primary));
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  padding: 12px 16px;
  color: var(--md-sys-color-on-primary-container, var(--app-text));
  background: var(--md-sys-color-primary-container, var(--app-selected));
}

.attachment-transfer-panel > m3e-icon {
  --m3e-icon-size: 20px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
}

.attachment-transfer-content {
  display: grid;
  gap: 10px;
}

.attachment-transfer-content > div {
  display: grid;
  gap: 2px;
}

.attachment-transfer-target {
  display: grid;
  gap: 6px;
}

.attachment-transfer-target select {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--md-sys-color-outline, var(--app-outline));
  border-radius: 8px;
  padding: 0 12px;
  font: inherit;
  color: var(--app-text);
  background: var(--app-surface);
}

.attachment-transfer-target select:disabled,
.attachment-transfer-mode:disabled {
  opacity: 0.72;
}

.attachment-transfer-mode {
  min-width: 0;
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attachment-transfer-mode legend {
  width: 100%;
  margin-bottom: 2px;
}

.attachment-transfer-mode label {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
  padding: 8px 12px;
  background: var(--app-surface);
}

.attachment-transfer-content > p {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  line-height: 1.5;
}

.attachment-transfer-content > p m3e-icon {
  --m3e-icon-size: 20px;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
}

.attachment-transfer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.attachment-delete-confirmation {
  border-top: 1px solid var(--md-sys-color-error, #ba1a1a);
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  color: var(--md-sys-color-on-error-container, var(--app-text));
  background: var(--md-sys-color-error-container, var(--app-surface-high));
}

.attachment-delete-confirmation > m3e-icon {
  --m3e-icon-size: 20px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
}

.attachment-confirm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.attachment-empty {
  min-height: 104px;
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  text-align: center;
}

.attachment-empty m3e-icon {
  --m3e-icon-size: 20px;
}

.attachment-more {
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  display: flex;
  justify-content: center;
  padding: 4px 12px;
}

.provider-attachments-dialog > footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

@media (max-width: 700px) {
  .attachment-backdrop {
    align-items: center;
    padding: 8px;
  }

  .provider-attachments-dialog {
    max-height: calc(100dvh - 16px);
    border-radius: 16px;
    padding: 16px;
  }

  .attachment-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .attachment-provider-field,
  .attachment-provider-summary {
    flex-basis: auto;
  }

  .attachment-toolbar > m3e-button {
    width: 100%;
  }

  .attachment-upload-panel,
  .attachment-recovery-panel,
  .attachment-row-main,
  .keepass-managed-photo-row,
  .attachment-transfer-panel,
  .attachment-delete-confirmation {
    grid-template-columns: 40px minmax(0, 1fr);
  }

  .attachment-progress-value,
  .attachment-recovery-panel > m3e-icon-button,
  .attachment-row-actions,
  .managed-photo-actions,
  .attachment-transfer-actions,
  .attachment-confirm-actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }

  .attachment-upload-actions {
    grid-column: 1 / -1;
    align-items: stretch;
    flex-direction: column;
  }
}

@media (max-width: 420px) {
  .provider-attachments-dialog {
    padding: 12px;
  }

  .attachment-list-heading,
  .keepass-managed-photos > header,
  .keepass-managed-photo-row,
  .attachment-row-main,
  .attachment-transfer-panel,
  .attachment-delete-confirmation {
    padding-inline: 12px;
  }
}
</style>
