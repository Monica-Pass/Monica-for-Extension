<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { VaultItem } from "../core/model";
import type { WalletAsset } from "../core/password-content";
import { vaultClient } from "../runtime/client";
import { attachmentSha256, PREVIEW_MAX_BYTES, readVerifiedAttachment } from "../manager/attachment-reader";
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
const props = defineProps<{ owner?: VaultItem }>();
const emit = defineEmits<{ added: [asset: WalletAsset] }>();
const role = ref<WalletAsset["role"]>("ATTACHMENT"), busy = ref(false), error = ref(""), notice = ref("");
const file = ref<File>(); const fileInput = ref<HTMLInputElement>();
let controller: AbortController | undefined;
onBeforeUnmount(() => controller?.abort());
async function upload() {
  const selected = file.value, providerId = props.owner?.providerRefs[0]?.providerId;
  if (!selected || !props.owner || !providerId || busy.value) return;
  if (selected.size > PREVIEW_MAX_BYTES) { error.value = "附件最大为 64 MiB。"; return; }
  if (role.value === "CARD_FACE" && !/^image\/(png|jpeg|webp|gif)$/.test(selected.type)) { error.value = "卡面请选择 PNG、JPEG、WebP 或 GIF 图片。"; return; }
  if (!window.confirm("文件将立即添加为当前项目的独立附件。取消后续编辑不会删除它，可在附件管理中移除。继续上传？")) return;
  const request = controller = new AbortController(); const check = () => { if (request.signal.aborted) throw new DOMException("上传已取消。", "AbortError"); };
  busy.value = true; error.value = ""; notice.value = ""; let transferId: string | undefined; let committed = false; let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(await selected.arrayBuffer()); check();
    const asset: WalletAsset = { name: `wallet-${crypto.randomUUID()}`, displayName: selected.name, mimeType: selected.type || "application/octet-stream", role: role.value, size: bytes.length, sha256: await attachmentSha256(bytes) }; check();
    const operationId = crypto.randomUUID();
    const start = await vaultClient.beginProviderAttachmentUpload(providerId, props.owner.id, { fileName: asset.name, mediaType: asset.mimeType, sizeBytes: asset.size, sha256: asset.sha256, replaceExisting: false, operationId }); transferId = start.transferId; check();
    if (start.nextOffset !== 0 || !Number.isSafeInteger(start.maxChunkBytes) || start.maxChunkBytes < 1 || start.maxChunkBytes > 256 * 1024) throw new Error("上传会话无效，未修改副本。");
    for (let offset = 0; offset < bytes.length;) {
      const chunk = bytes.slice(offset, offset + start.maxChunkBytes);
      const result = await vaultClient.sendProviderAttachmentChunk(providerId, transferId, offset, chunk); chunk.fill(0); check();
      if (result.nextOffset <= offset || result.nextOffset !== Math.min(offset + start.maxChunkBytes, bytes.length)) throw new Error("上传分段校验失败。");
      offset = result.nextOffset;
    }
    await vaultClient.finishProviderAttachmentUpload(providerId, props.owner.id, transferId, operationId); committed = true; check();
    const verified = await readVerifiedAttachment(vaultClient, providerId, props.owner.id, asset.name, asset, request.signal); verified.bytes.fill(0); check();
    emit("added", asset); file.value = undefined; if (fileInput.value) fileInput.value.value = "";
    notice.value = "附件已上传并校验。请保存整个项目以提交副本引用。";
  } catch (cause) { if (!request.signal.aborted) error.value = `${cause instanceof Error ? cause.message : "附件上传失败。"}${committed ? " 文件已上传但未加入副本，请在附件管理核对。" : " 副本未改变。"}`; }
  finally { bytes?.fill(0); if (transferId && !committed) await vaultClient.abortProviderAttachmentUpload(providerId, transferId).catch(() => undefined); busy.value = false; }
}
</script>
<template><div class="wallet-asset-editor"><p v-if="!owner?.providerRefs.length">先保存项目到支持附件的密码源，再重新编辑以添加副本附件。文件和副本引用不会凭空创建。</p><template v-else><m3e-form-field v-field-label variant="filled"><label slot="label">副本附件用途</label><component :is="materialSelectTag" :disabled="busy" @input="role=($event.target as any).value"><component :is="materialOptionTag" v-for="(label,value) in {ATTACHMENT:'普通附件',CARD_FACE:'卡面',FRONT:'正面',BACK:'背面',INLINE_IMAGE:'笔记图片'}" :key="value" :value="value" :selected.prop="role===value">{{label}}</component></component></m3e-form-field><label>选择副本附件<input ref="fileInput" type="file" :disabled="busy" @change="file=($event.target as HTMLInputElement).files?.[0]" /></label><m3e-button type="button" variant="tonal" :disabled="busy||!file" @click="upload">{{busy?'正在上传并校验…':'上传副本附件'}}</m3e-button><m3e-button v-if="busy" type="button" variant="text" @click="controller?.abort()">取消上传</m3e-button></template><p v-if="notice" role="status">{{notice}}</p><p v-if="error" role="alert">{{error}}</p></div></template>
<style scoped>.wallet-asset-editor{display:grid;gap:12px;min-width:0}.wallet-asset-editor label{display:grid;gap:8px}.wallet-asset-editor input{max-width:100%;min-width:0}.wallet-asset-editor p{overflow-wrap:anywhere}</style>
