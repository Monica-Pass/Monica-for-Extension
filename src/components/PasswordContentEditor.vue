<script setup lang="ts">
import { computed, markRaw, reactive, ref, shallowRef, watch } from "vue";
import type { SecureCustomField, VaultItem, ProviderAccount } from "../core/model";
import { BLOCK_EDITABLE_KEYS, BASE_CONTENT_ORDER, contentRank, createContentBlock, createWalletContent, editContentBlock, editWalletContent, orderedContentTokens, putContentBlock, putWalletContent, readContentBlocks, readWalletContents, removeContentBlock, moveContentToken, withContentOrder, type ContentBlock, type ContentBlockKind, type StoredContent, type WalletContent, type WalletKind } from "../core/password-content";
import { monicaItemDataToVaultItem, vaultItemToMonicaItemData } from "../providers/monica-item-data";
import { parseLosslessJson } from "../core/lossless-json";
import VaultItemEditor from "./VaultItemEditor.vue";
import WalletAssetEditor from "./WalletAssetEditor.vue";
import AttachmentPreview from "./AttachmentPreview.vue";
import ContentOrderList from "./ContentOrderList.vue";
import type { WalletAsset } from "../core/password-content";
import { readVerifiedAttachment } from "../manager/attachment-reader";
import { vaultClient } from "../runtime/client";
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";

const props = defineProps<{ fields: SecureCustomField[]; providers: ProviderAccount[]; providerId: string; owner?: VaultItem; projectTokens?: string[]; credentialLabels?: Record<string, string> }>();
const emit = defineEmits<{ update: [fields: SecureCustomField[]] }>();
const blocks = shallowRef<StoredContent<ContentBlock>[]>([]);
const wallets = computed(() => readWalletContents(props.fields));
const error = ref(""); const busy = ref(false); const selectedKind = ref<ContentBlockKind>("API_KEY");
const activeBlock = shallowRef<ContentBlock>(); const activeWallet = shallowRef<WalletContent>(); const walletItem = shallowRef<VaultItem>();
const blockTitle = ref(""); const blockFields = reactive<Record<string, string>>({}); const showSecrets = ref(false);
const labels: Record<string, string> = { AUTHENTICATOR: "验证码与 Passkey", PAYMENT: "银行卡与支付", CONTACT: "证件与个人信息", ADDRESS: "地址", NOTES: "笔记与恢复备注", CUSTOM_FIELDS: "自定义字段", ATTACHMENTS: "附件", API_KEY: "API Key", API_TOKEN: "API Token", SSH_KEY: "SSH 密钥", GPG_KEY: "GPG 密钥", QR_CODE: "二维码", key: "Key", url: "服务地址", provider: "服务商", api_base: "API 地址", token: "Token", notes: "备注", algorithm: "算法", keySize: "密钥位数", format: "格式", publicKeyOpenSsh: "OpenSSH 公钥", privateKeyOpenSsh: "OpenSSH 私钥", fingerprintSha256: "SHA-256 指纹", comment: "注释", publicKey: "公钥", privateKey: "私钥", fingerprint: "指纹", userId: "用户身份", content: "二维码内容", mode: "二维码模式", templateVersion: "模板版本" };
const tokens = computed(() => props.projectTokens ?? orderedContentTokens(props.fields));
const walletKinds: WalletKind[] = ["BANK_CARD", "DOCUMENT", "ADDRESS", "NOTE"];
const walletLabels = { BANK_CARD: "银行卡副本", DOCUMENT: "证件副本", ADDRESS: "地址副本", NOTE: "完整笔记副本" };
let generation = 0;
watch(() => props.fields, async fields => { const current = ++generation; const result = await readContentBlocks(fields); if (generation === current) blocks.value = markRaw(result); }, { deep: true, immediate: true });
function tokenLabel(token: string) { return props.credentialLabels?.[token] || labels[token] || blocks.value.find(block => block.token === token)?.value?.title || labels[blocks.value.find(block => block.token === token)?.value?.kind || ""] || token; }
function reorder(token: string, target: string, after: boolean) { try {
  if (token === target || !tokens.value.includes(token) || !tokens.value.includes(target)) return;
  const source = props.projectTokens ? withContentOrder(props.fields, tokens.value) : props.fields;
  const fields = moveContentToken(source, token, target, after); if (fields !== source) emit("update", fields);
} catch (cause) { error.value = String(cause); } }
function openBlock(block = createContentBlock(selectedKind.value)) { activeBlock.value = markRaw(block); blockTitle.value = block.title; for (const key of Object.keys(blockFields)) delete blockFields[key]; for (const key of BLOCK_EDITABLE_KEYS[block.kind]) blockFields[key] = typeof block.data[key] === "string" ? block.data[key] as string : ""; if (block.kind === "QR_CODE") { blockFields.mode = String(block.data.mode || "literal"); blockFields.templateVersion = String(block.data.templateVersion || "1"); } showSecrets.value = false; error.value = ""; }
async function saveBlock() { if (!activeBlock.value || busy.value) return; busy.value = true; try { const patch = Object.fromEntries(Object.entries(blockFields).filter(([key, value]) => value !== (activeBlock.value!.data[key] ?? ""))); emit("update", await putContentBlock(props.fields, editContentBlock(activeBlock.value, blockTitle.value, patch))); activeBlock.value = undefined; } catch (cause) { error.value = String(cause); } finally { busy.value = false; } }
async function removeBlock(token: string) { if (!window.confirm("删除这个内容块？只有保存整个项目后才会写入数据库。")) return; try { emit("update", await removeContentBlock(props.fields, token)); } catch (cause) { error.value = String(cause); } }
function openWallet(wallet: WalletContent) {
  try { const type = ({ BANK_CARD: "BANK_CARD", DOCUMENT: "DOCUMENT", ADDRESS: "BILLING_ADDRESS", NOTE: "NOTE" } as const)[wallet.kind];
    const now = new Date().toISOString(); const item = monicaItemDataToVaultItem(type, wallet.data, { id: wallet.id, title: wallet.title, notes: wallet.notes, favorite: wallet.favorite, createdAt: now, updatedAt: now, providerRefs: props.providerId ? [{ providerId: props.providerId }] : [] });
    if (!item) throw new Error("副本字段暂不能编辑。"); activeWallet.value = markRaw(wallet); walletItem.value = item; error.value = "";
  } catch (cause) { error.value = String(cause); }
}
function newWallet(kind: WalletKind) { const existing = wallets.value.find(wallet => wallet.value?.kind === kind); if (existing?.value) return openWallet(existing.value); if (wallets.value.some(wallet => wallet.originalFields.some(field => field.name.endsWith("." + kind.toLowerCase())))) { error.value = "已有未知或损坏副本，不能覆盖。"; return; } openWallet(createWalletContent(kind, "", {})); }
async function saveWallet(item: VaultItem) {
  if (!activeWallet.value) return;
  if ('cardFace' in item && item.cardFace?.imageAttachmentName && item.cardFace.imageAttachmentName !== (walletItem.value && 'cardFace' in walletItem.value ? walletItem.value.cardFace?.imageAttachmentName : undefined)) {
    const asset = activeWallet.value.assets.find(asset => asset.name === item.cardFace!.imageAttachmentName);
    const providerId = props.owner?.providerRefs[0]?.providerId;
    if (!asset || !props.owner || !providerId) throw new Error("请先为此副本上传卡面附件，再选择其名称。原副本未修改。");
    const checked = await readVerifiedAttachment(vaultClient, providerId, props.owner.id, asset.name, asset); checked.bytes.fill(0);
  }
  const raw = vaultItemToMonicaItemData(item, JSON.stringify(activeWallet.value.data), walletItem.value); if (!raw) throw new Error("不支持的副本类型。");
  const wallet = editWalletContent(activeWallet.value, { title: item.title, notes: item.notes, favorite: item.favorite, data: parseLosslessJson(raw) as Record<string, unknown> }); emit("update", putWalletContent(props.fields, wallet)); activeWallet.value = undefined; walletItem.value = undefined;
}
function addAsset(wallet: WalletContent, asset: WalletAsset) {
  try {
    const current = readWalletContents(props.fields).find(entry => entry.value?.id === wallet.id)?.value;
    if (!current) throw(new Error("副本已变化；附件仍在附件管理中，未覆盖草稿。"));
    const data = asset.role === 'CARD_FACE' ? { ...current.data, cardFace: { ...(current.data.cardFace as object || {}), imageAttachmentName: asset.name, displayMode: 'ALL', showBrandIcon: true } } : current.data;
    emit('update', putWalletContent(props.fields, editWalletContent(current, { data, assets: [...current.raw.assets as WalletAsset[], asset] })));
  } catch (cause) { error.value = String(cause); }
}
</script>

<template>
  <section class="editor-section content-tools" style="order:-1" aria-label="添加和排列内容">
    <m3e-expansion-panel><span slot="header">内容顺序</span><ContentOrderList :tokens="tokens" :label="tokenLabel" @move="reorder" /></m3e-expansion-panel>
    <div class="content-add-row"><m3e-form-field variant="filled" v-field-label><label slot="label">添加内容类型</label><component :is="materialSelectTag" @input="selectedKind = ($event.target as HTMLSelectElement).value as ContentBlockKind"><component :is="materialOptionTag" v-for="kind in Object.keys(BLOCK_EDITABLE_KEYS)" :key="kind" :value="kind" :selected.prop="kind === selectedKind">{{ labels[kind] }}</component></component></m3e-form-field><m3e-button type="button" variant="tonal" @click="openBlock()">添加内容</m3e-button></div>
    <m3e-expansion-panel><span slot="header">添加完整副本</span><div class="content-copy-options"><m3e-button v-for="kind in walletKinds" :key="kind" variant="text" type="button" @click="newWallet(kind)">{{ walletLabels[kind] }}</m3e-button></div><p class="editor-hint">副本独立保存，不会修改原银行卡、证件或笔记。已有卡面与附件引用会完整保留。</p></m3e-expansion-panel>
    <p v-if="error && !activeBlock" role="alert" class="form-error">{{ error }}</p>
  </section>
  <section v-for="block in blocks" :key="block.token" class="editor-section content-entry" :style="{order:contentRank(fields,block.token)}">
    <h3>{{ block.value ? block.value.title || labels[block.value.kind] : '不可编辑内容' }}</h3><p v-if="!block.value" role="status">{{ block.reason }} 原始分段保持不变。</p><template v-else><p class="editor-hint">{{ labels[block.value.kind] }} · 内容默认隐藏</p><div class="content-add-row"><m3e-button variant="tonal" type="button" @click="openBlock(block.value)">编辑内容</m3e-button><m3e-button variant="text" type="button" @click="removeBlock(block.token)">删除内容</m3e-button></div></template>
  </section>
  <section v-for="wallet in wallets" :key="wallet.token" class="editor-section content-entry" :style="{order:Math.max(0,contentRank(fields,wallet.token))}"><h3>{{ wallet.value ? wallet.value.title || walletLabels[wallet.value.kind] : '不可编辑副本' }}</h3><p v-if="!wallet.value">{{ wallet.reason }} 原始数据保持不变。</p><template v-else><p class="editor-hint">{{ walletLabels[wallet.value.kind] }} · {{ wallet.value.assets.length }} 个附件</p><m3e-button variant="tonal" type="button" @click="openWallet(wallet.value)">编辑完整副本</m3e-button><AttachmentPreview v-for="asset in wallet.value.assets" v-if="owner" :key="asset.name" :owner="owner!" :name="asset.name" :expected="asset" :label="asset.displayName"/><m3e-expansion-panel><span slot="header">添加副本附件或卡面</span><WalletAssetEditor :owner="owner" @added="addAsset(wallet.value!, $event)"/></m3e-expansion-panel></template></section>
  <section v-for="token in tokens.filter(token => !BASE_CONTENT_ORDER.includes(token) && !token.startsWith('BLOCK:') && !credentialLabels?.[token])" :key="token" class="editor-section" :style="{order:contentRank(fields,token)}"><h3>未知内容 {{ token }}</h3><p>排序标记完整保留，不使用空表单覆盖。</p></section>
  <div v-if="activeBlock" class="modal-backdrop content-sheet-backdrop" @mousedown.self="activeBlock = undefined"><section class="editor-dialog content-sheet" data-nested-dialog role="dialog" aria-modal="true" aria-labelledby="content-sheet-title"><header><h2 id="content-sheet-title">{{ labels[activeBlock.kind] }}</h2><m3e-icon-button type="button" data-dialog-close aria-label="取消内容编辑" @click="activeBlock=undefined"><m3e-icon name="close" /></m3e-icon-button></header><div class="editor-fields"><m3e-form-field v-field-label variant="filled"><label slot="label">内容名称</label><input v-model="blockTitle" autocomplete="off" /></m3e-form-field><m3e-button type="button" variant="text" @click="showSecrets=!showSecrets">{{ showSecrets ? '隐藏敏感内容' : '显示敏感内容' }}</m3e-button><m3e-form-field v-for="key in Object.keys(blockFields)" :key="key" v-field-label variant="filled"><label slot="label">{{ labels[key] || key }}</label><textarea v-model="blockFields[key]" :class="{'concealed-secret': !showSecrets && /^(key|token|privateKey|privateKeyOpenSsh|content)$/.test(key)}" :aria-label="labels[key] || key" rows="3" autocomplete="off" spellcheck="false" /></m3e-form-field><p v-if="activeBlock.kind==='QR_CODE'" class="editor-hint">literal 为普通内容；template 与版本 1 使用 %ACCOUNT%、%PASSWORD% 等字段占位符，查看时临时展开。</p><p v-if="error" role="alert" class="form-error">{{ error }}</p></div><footer><m3e-button type="button" variant="text" @click="activeBlock=undefined">取消</m3e-button><m3e-button type="button" variant="filled" :disabled="busy" @click="saveBlock">保存内容草稿</m3e-button></footer></section></div>
  <VaultItemEditor v-if="activeWallet && walletItem" :key="activeWallet.id" nested :item="walletItem" :initial-kind="walletItem.kind as any" :providers="providers" :save-item="saveWallet" @cancel="activeWallet=undefined;walletItem=undefined" />
</template>

<style scoped>
.content-add-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.content-add-row>m3e-form-field{flex:1;min-width:180px}.content-copy-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.content-sheet-backdrop{z-index:1200}.content-sheet{max-height:90dvh;width:min(640px,calc(100vw - 24px));display:flex;flex-direction:column}.content-sheet header,.content-sheet footer{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:16px}.content-sheet .editor-fields{overflow:auto;display:grid;gap:16px;padding:16px}.content-sheet h2{margin:0}.content-entry h3{overflow-wrap:anywhere}
</style>
