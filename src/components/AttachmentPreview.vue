<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { VaultItem } from "../core/model";
import type { WalletAsset } from "../core/password-content";
import { vaultClient } from "../runtime/client";
import { readVerifiedAttachment } from "../manager/attachment-reader";
import { cardFaceImageType } from "../manager/card-face-images";
import { tr } from "../i18n";
import { translateRuntimeError } from "../i18n/runtime";
const props = defineProps<{ owner: VaultItem; name: string; label?: string; expected?: WalletAsset }>();
const busy=ref(false), error=ref(""), url=ref(""), text=ref(""), visible=ref(false), mime=ref("");
let generation=0; let controller: AbortController | undefined;
function close(){generation++; controller?.abort(); visible.value=false; if(url.value) URL.revokeObjectURL(url.value); url.value="";text.value="";}
onBeforeUnmount(close);
async function open(){ if(busy.value)return;close();busy.value=true;error.value=""; const current=++generation; const request=controller=new AbortController(); let providerId:string|undefined;
  try { providerId=props.owner.providerRefs[0]?.providerId || 'local';
    const result=await readVerifiedAttachment(vaultClient,providerId,props.owner.id,props.name,props.expected,request.signal); const bytes=result.bytes;
    if(current!==generation)return;
    const rasterType=cardFaceImageType(bytes);
    mime.value=rasterType || result.mediaType;
    // Never embed HTML, SVG, scripts or unknown active media in the extension origin.
    const safeImage=Boolean(rasterType);
    if(!safeImage && /^image\//i.test(mime.value))mime.value='application/octet-stream';
    if(/^text\/plain(?:;|$)/.test(mime.value))text.value=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    url.value=URL.createObjectURL(new Blob([bytes],{type:safeImage?mime.value:"application/octet-stream"}));visible.value=true;
  }catch(cause){if(!request.signal.aborted)error.value=cause instanceof Error?translateRuntimeError(cause.message):tr("无法读取附件。");}finally{busy.value=false;}}
</script>
<template><div class="attachment-preview"><m3e-button type="button" variant="tonal" :disabled="busy" @click="open"><m3e-icon slot="icon" name="attach_file" />{{busy?tr('正在校验…'):label||name}}</m3e-button><m3e-button v-if="busy" type="button" variant="text" @click="close">{{tr('取消读取')}}</m3e-button><p v-if="error" role="alert">{{error}}</p><div v-if="visible" class="modal-backdrop attachment-viewer" @mousedown.self="close"><section class="editor-dialog" data-nested-dialog role="dialog" aria-modal="true" :aria-label="tr('附件预览')"><header><h3>{{label||name}}</h3><m3e-button type="button" data-dialog-close variant="text" @click="close">{{tr('关闭附件')}}</m3e-button></header><div class="attachment-body"><img v-if="/^image\/(png|jpeg|webp|gif)$/.test(mime)" :src="url" :alt="label||name"/><pre v-else-if="text">{{text}}</pre><p v-else>{{tr('此类型仅提供下载，不在拓展页面执行。')}}</p></div><footer><a :href="url" :download="expected?.displayName||name">{{tr('下载已校验附件')}}</a></footer></section></div></div></template>
<style scoped>.attachment-viewer{z-index:1600}.attachment-viewer section{display:flex;flex-direction:column;max-height:90dvh;width:min(820px,calc(100vw - 24px))}.attachment-viewer header,.attachment-viewer footer{padding:16px;display:flex;justify-content:space-between;align-items:center;gap:12px}.attachment-body{padding:12px;overflow:auto}.attachment-body img{max-width:100%;height:auto}.attachment-body pre{white-space:pre-wrap;overflow-wrap:anywhere}.attachment-preview{min-width:0}.attachment-preview p{overflow-wrap:anywhere}</style>
