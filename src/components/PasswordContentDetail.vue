<script setup lang="ts">
import { computed, markRaw, ref, shallowRef, watch } from "vue";
import type { LoginItem, VaultItem, ProviderAccount } from "../core/model";
import { BASE_CONTENT_ORDER, contentRank, orderedContentTokens, readContentBlocks, readWalletContents, renderQrTemplate, type ContentBlock, type StoredContent, type WalletContent } from "../core/password-content";
import { monicaItemDataToVaultItem } from "../providers/monica-item-data";
import { createQrDataUrl } from "../core/otp-qr";
import VaultItemDetail from "./VaultItemDetail.vue";
import ProtectedValue from "./ProtectedValue.vue";
import AttachmentPreview from "./AttachmentPreview.vue";
const props=defineProps<{item:LoginItem;providers:ProviderAccount[];items:VaultItem[]}>();
const blocks=shallowRef<StoredContent<ContentBlock>[]>([]), selectedWallet=shallowRef<VaultItem>(), error=ref(""), qr=ref("");
const wallets=computed(()=>readWalletContents(props.item.customFields));let generation=0;
watch(()=>props.item,async item=>{const current=++generation;const result=await readContentBlocks(item.customFields);if(current===generation)blocks.value=markRaw(result);},{immediate:true});
const unknownTokens=computed(()=>orderedContentTokens(props.item.customFields).filter(token=>!BASE_CONTENT_ORDER.includes(token)&&!token.startsWith("BLOCK:")));
const labels:Record<string,string>={API_KEY:"API Key",API_TOKEN:"API Token",SSH_KEY:"SSH 密钥",GPG_KEY:"GPG 密钥",QR_CODE:"二维码",BANK_CARD:"银行卡副本",DOCUMENT:"证件副本",ADDRESS:"地址副本",NOTE:"完整笔记副本",key:"Key",token:"Token",provider:"服务商",api_base:"API 地址",url:"服务地址",notes:"备注",publicKey:"公钥",privateKey:"私钥",publicKeyOpenSsh:"OpenSSH 公钥",privateKeyOpenSsh:"OpenSSH 私钥",fingerprint:"指纹",userId:"用户身份",content:"二维码内容"};
function openWallet(wallet:WalletContent){try{selectedWallet.value=monicaItemDataToVaultItem(({BANK_CARD:"BANK_CARD",DOCUMENT:"DOCUMENT",ADDRESS:"BILLING_ADDRESS",NOTE:"NOTE"}as const)[wallet.kind],wallet.data,{id:wallet.id,title:wallet.title,notes:wallet.notes,favorite:wallet.favorite,createdAt:props.item.createdAt,updatedAt:props.item.updatedAt,providerRefs:props.item.providerRefs});}catch(cause){error.value=String(cause);}}
async function showQr(block:ContentBlock){try{const content=String(block.data.content||"");qr.value=await createQrDataUrl(block.data.mode==="template"?renderQrTemplate(content,props.item):content);}catch(cause){error.value=String(cause);}}
</script>
<template>
  <section v-for="block in blocks" :key="block.token" class="detail-section" :style="{order:contentRank(item.customFields,block.token)}"><h3>{{block.value?.title||labels[block.value?.kind||'']||'不可编辑内容'}}</h3><p v-if="!block.value">{{block.reason}}</p><template v-else><ProtectedValue v-for="(value,key) in block.value.data" :key="key" :label="labels[key]||String(key)" :value="typeof value==='string'?value:JSON.stringify(value)" :secret="!['publicKey','publicKeyOpenSsh','fingerprint','fingerprintSha256','provider','api_base','url','algorithm','keySize','format','mode','templateVersion'].includes(String(key))"/><m3e-button v-if="block.value.kind==='QR_CODE'" type="button" variant="tonal" @click="showQr(block.value)">查看二维码</m3e-button></template><m3e-expansion-panel><span slot="header">完整原始内容</span><ProtectedValue label="原始内容" :value="block.value?JSON.stringify(block.value.raw,null,2):JSON.stringify(block.originalFields,null,2)" secret /></m3e-expansion-panel></section>
  <section v-for="wallet in wallets" :key="wallet.token" class="detail-section" :style="{order:Math.max(0,contentRank(item.customFields,wallet.token))}"><h3>{{wallet.value?.title||labels[wallet.value?.kind||'']||'不可读取副本'}}</h3><template v-if="wallet.value"><p>{{labels[wallet.value.kind]}} · {{wallet.value.assets.length}} 个附件</p><m3e-button type="button" variant="tonal" @click="openWallet(wallet.value)">查看完整副本</m3e-button><AttachmentPreview v-for="asset in wallet.value.assets" :key="asset.name" :owner="item" :name="asset.name" :label="asset.displayName" :expected="asset"/></template><p v-else>{{wallet.reason}}</p><m3e-expansion-panel><span slot="header">完整原始副本</span><ProtectedValue label="原始副本" :value="wallet.originalFields.map(field=>field.value).join('\n')" secret /></m3e-expansion-panel></section>
  <section v-for="token in unknownTokens" :key="token" class="detail-section" :style="{order:contentRank(item.customFields,token)}"><h3>未知内容 {{token}}</h3><p>顺序标记完整保留。</p></section>
  <p v-if="error" role="alert">{{error}}</p>
  <div v-if="qr" class="modal-backdrop content-qr"><section class="editor-dialog" data-nested-dialog role="dialog" aria-label="二维码"><img :src="qr" alt="项目内容二维码"/><m3e-button type="button" data-dialog-close variant="text" @click="qr=''">关闭二维码</m3e-button></section></div>
  <VaultItemDetail v-if="selectedWallet" :item="selectedWallet" :items="items" :providers="providers" :consume-otp="async()=>{}" :attachment-owner="item" read-only @close="selectedWallet=undefined"/>
</template>
<style scoped>.content-qr{z-index:1500}.content-qr section{padding:24px;display:grid;justify-items:center;gap:16px}.content-qr img{max-width:100%}</style>
