<script setup lang="ts">
import { computed, markRaw, nextTick, reactive, ref, shallowRef, watch } from "vue";
import type { SecureCustomField, VaultItem, ProviderAccount } from "../core/model";
import { BLOCK_EDITABLE_KEYS, BASE_CONTENT_ORDER, contentRank, createContentBlock, createWalletContent, editContentBlock, editWalletContent, orderedContentTokens, putContentBlock, putWalletContent, readContentBlocks, readWalletContents, removeContentBlock, moveContentToken, withContentOrder, type ContentBlock, type ContentBlockKind, type StoredContent, type WalletContent, type WalletKind } from "../core/password-content";
import { monicaItemDataToVaultItem, vaultItemToMonicaItemData } from "../providers/monica-item-data";
import { parseLosslessJson } from "../core/lossless-json";
import VaultItemEditor from "./VaultItemEditor.vue";
import WalletAssetEditor from "./WalletAssetEditor.vue";
import AttachmentPreview from "./AttachmentPreview.vue";
import ContentOrderList from "./ContentOrderList.vue";
import EditorContentSection from "./EditorContentSection.vue";
import { tr } from "../i18n";
import { translateRuntimeError } from "../i18n/runtime";
import type { WalletAsset } from "../core/password-content";
import { readVerifiedAttachment } from "../manager/attachment-reader";
import { vaultClient } from "../runtime/client";

const props = defineProps<{ fields: SecureCustomField[]; providers: ProviderAccount[]; providerId: string; owner?: VaultItem; projectTokens?: string[]; credentialLabels?: Record<string, string> }>();
const emit = defineEmits<{ update: [fields: SecureCustomField[]] }>();
const blocks = shallowRef<StoredContent<ContentBlock>[]>([]);
const wallets = computed(() => readWalletContents(props.fields));
const error = ref(""); const busy = ref(false); const selectedKind = ref<ContentBlockKind>("API_KEY");
const activeBlock = shallowRef<ContentBlock>(); const activeWallet = shallowRef<WalletContent>(); const walletItem = shallowRef<VaultItem>();
const blockTitle = ref(""); const blockFields = reactive<Record<string, string>>({}); const showSecrets = ref(false);
// Labels follow the interface language; content titles and values are user data.
const labels = computed<Record<string, string>>(() => ({ AUTHENTICATOR: tr("验证码与 Passkey"), PAYMENT: tr("银行卡与支付"), CONTACT: tr("证件与个人信息"), ADDRESS: tr("地址"), NOTES: tr("笔记与恢复备注"), CUSTOM_FIELDS: tr("自定义字段"), ATTACHMENTS: tr("附件"), API_KEY: "API Key", API_TOKEN: "API Token", SSH_KEY: tr("SSH 密钥"), GPG_KEY: tr("GPG 密钥"), QR_CODE: tr("二维码"), key: "Key", url: tr("服务地址"), provider: tr("服务商"), api_base: tr("API 地址"), token: "Token", notes: tr("备注"), algorithm: tr("算法"), keySize: tr("密钥位数"), format: tr("格式"), publicKeyOpenSsh: tr("OpenSSH 公钥"), privateKeyOpenSsh: tr("OpenSSH 私钥"), fingerprintSha256: tr("SHA-256 指纹"), comment: tr("注释"), publicKey: tr("公钥"), privateKey: tr("私钥"), fingerprint: tr("指纹"), userId: tr("用户身份"), content: tr("二维码内容"), mode: tr("二维码模式"), templateVersion: tr("模板版本") }));
const failure = (cause: unknown) => translateRuntimeError(cause instanceof Error ? cause.message : String(cause));
const tokens = computed(() => props.projectTokens ?? orderedContentTokens(props.fields));
const walletKinds: WalletKind[] = ["BANK_CARD", "DOCUMENT", "ADDRESS", "NOTE"];
const walletLabels = computed<Record<WalletKind, string>>(() => ({ BANK_CARD: tr("银行卡副本"), DOCUMENT: tr("证件副本"), ADDRESS: tr("地址副本"), NOTE: tr("完整笔记副本") }));
let generation = 0;
watch(() => props.fields, async fields => { const current = ++generation; const result = await readContentBlocks(fields); if (generation === current) blocks.value = markRaw(result); }, { deep: true, immediate: true });
function tokenLabel(token: string) { return props.credentialLabels?.[token] || labels.value[token] || blocks.value.find(block => block.token === token)?.value?.title || labels.value[blocks.value.find(block => block.token === token)?.value?.kind || ""] || token; }
function reorder(token: string, target: string, after: boolean) { try {
  if (token === target || !tokens.value.includes(token) || !tokens.value.includes(target)) return;
  const source = props.projectTokens ? withContentOrder(props.fields, tokens.value) : props.fields;
  const fields = moveContentToken(source, token, target, after); if (fields !== source) emit("update", fields);
} catch (cause) { error.value = failure(cause); } }
function openBlock(block = createContentBlock(selectedKind.value)) { activeBlock.value = markRaw(block); blockTitle.value = block.title; for (const key of Object.keys(blockFields)) delete blockFields[key]; for (const key of BLOCK_EDITABLE_KEYS[block.kind]) blockFields[key] = typeof block.data[key] === "string" ? block.data[key] as string : ""; if (block.kind === "QR_CODE") { blockFields.mode = String(block.data.mode || "literal"); blockFields.templateVersion = String(block.data.templateVersion || "1"); } showSecrets.value = false; error.value = ""; }
async function saveBlock() { if (!activeBlock.value || busy.value) return; busy.value = true; try { const patch = Object.fromEntries(Object.entries(blockFields).filter(([key, value]) => value !== (activeBlock.value!.data[key] ?? ""))); emit("update", await putContentBlock(props.fields, editContentBlock(activeBlock.value, blockTitle.value, patch))); activeBlock.value = undefined; } catch (cause) { error.value = failure(cause); } finally { busy.value = false; } }
async function removeBlock(token: string) { if (!window.confirm(tr("删除这个内容块？只有保存整个项目后才会写入数据库。"))) return; try { emit("update", await removeContentBlock(props.fields, token)); } catch (cause) { error.value = failure(cause); } }
function openWallet(wallet: WalletContent) {
  try { const type = ({ BANK_CARD: "BANK_CARD", DOCUMENT: "DOCUMENT", ADDRESS: "BILLING_ADDRESS", NOTE: "NOTE" } as const)[wallet.kind];
    const now = new Date().toISOString(); const item = monicaItemDataToVaultItem(type, wallet.data, { id: wallet.id, title: wallet.title, notes: wallet.notes, favorite: wallet.favorite, createdAt: now, updatedAt: now, providerRefs: props.providerId ? [{ providerId: props.providerId }] : [] });
    if (!item) throw new Error(tr("副本字段暂不能编辑。")); activeWallet.value = markRaw(wallet); walletItem.value = item; error.value = "";
  } catch (cause) { error.value = failure(cause); }
}
function newWallet(kind: WalletKind) { const existing = wallets.value.find(wallet => wallet.value?.kind === kind); if (existing?.value) return openWallet(existing.value); if (wallets.value.some(wallet => wallet.originalFields.some(field => field.name.endsWith("." + kind.toLowerCase())))) { error.value = tr("已有未知或损坏副本，不能覆盖。"); return; } openWallet(createWalletContent(kind, "", {})); }
async function saveWallet(item: VaultItem) {
  if (!activeWallet.value) return;
  if ('cardFace' in item && item.cardFace?.imageAttachmentName && item.cardFace.imageAttachmentName !== (walletItem.value && 'cardFace' in walletItem.value ? walletItem.value.cardFace?.imageAttachmentName : undefined)) {
    const asset = activeWallet.value.assets.find(asset => asset.name === item.cardFace!.imageAttachmentName);
    const providerId = props.owner?.providerRefs[0]?.providerId;
    if (!asset || !props.owner || !providerId) throw new Error(tr("请先为此副本上传卡面附件，再选择其名称。原副本未修改。"));
    const checked = await readVerifiedAttachment(vaultClient, providerId, props.owner.id, asset.name, asset); checked.bytes.fill(0);
  }
  const raw = vaultItemToMonicaItemData(item, JSON.stringify(activeWallet.value.data), walletItem.value); if (!raw) throw new Error(tr("不支持的副本类型。"));
  const wallet = editWalletContent(activeWallet.value, { title: item.title, notes: item.notes, favorite: item.favorite, data: parseLosslessJson(raw) as Record<string, unknown> }); emit("update", putWalletContent(props.fields, wallet)); activeWallet.value = undefined; walletItem.value = undefined;
}
function addAsset(wallet: WalletContent, asset: WalletAsset) {
  try {
    const current = readWalletContents(props.fields).find(entry => entry.value?.id === wallet.id)?.value;
    if (!current) throw(new Error(tr("副本已变化；附件仍在附件管理中，未覆盖草稿。")));
    const data = asset.role === 'CARD_FACE' ? { ...current.data, cardFace: { ...(current.data.cardFace as object || {}), imageAttachmentName: asset.name, displayMode: 'ALL', showBrandIcon: true } } : current.data;
    emit('update', putWalletContent(props.fields, editWalletContent(current, { data, assets: [...current.raw.assets as WalletAsset[], asset] })));
  } catch (cause) { error.value = failure(cause); }
}
const addOpen = ref(false);
const icons: Record<string,string> = { API_KEY: 'key', API_TOKEN: 'token', SSH_KEY: 'terminal', GPG_KEY: 'key', QR_CODE: 'qr_code_2', BANK_CARD: 'credit_card', DOCUMENT: 'badge', ADDRESS: 'location_on', NOTE: 'note' };
async function chooseBlock(kind: string) { addOpen.value = false; await nextTick(); selectedKind.value = kind as ContentBlockKind; openBlock(); }
async function chooseWallet(kind: WalletKind) { addOpen.value = false; await nextTick(); newWallet(kind); }
function containKey(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !event.isComposing) event.preventDefault();
}
</script>

<template>
  <EditorContentSection v-model:open="addOpen" :title="tr('添加内容')" icon="add" :summary="tr('添加内容类型')" :style="{order:10000}">
    <div class="editor-content-list">
      <EditorContentSection v-for="kind in Object.keys(BLOCK_EDITABLE_KEYS)" :key="kind" :title="labels[kind]" :icon="icons[kind]" :summary="tr('添加内容')" @activate="chooseBlock(kind)" />
      <EditorContentSection v-for="kind in walletKinds" :key="kind" :title="walletLabels[kind]" :icon="icons[kind]" :summary="tr('添加完整副本')" @activate="chooseWallet(kind)" />
    </div>
    <p class="editor-hint">{{ tr('副本独立保存，不会修改原银行卡、证件或笔记。已有卡面与附件引用会完整保留。') }}</p>
  </EditorContentSection>
  <EditorContentSection :title="tr('内容顺序')" icon="swap_vert" :summary="tr('拖动手柄调整顺序，也可使用上下方向键。')" :style="{order:10001}">
    <ContentOrderList :tokens="tokens" :label="tokenLabel" @move="reorder" />
  </EditorContentSection>
  <p v-if="error && !activeBlock" role="alert" class="form-error" style="order:10002">{{ error }}</p>
  <EditorContentSection v-for="block in blocks" :key="block.token" :style="{order:contentRank(fields,block.token)}"
    :title="block.value ? block.value.title || labels[block.value.kind] : tr('不可编辑内容')" :icon="icons[block.value?.kind || ''] || 'info'"
    :summary="block.value ? labels[block.value.kind] + ' · ' + tr('内容默认隐藏') : translateRuntimeError(block.reason ?? '')" :disabled="!block.value" @activate="block.value && openBlock(block.value)">
    <template v-if="block.value" #actions><m3e-icon-button type="button" :aria-label="tr('删除内容')" @click="removeBlock(block.token)"><m3e-icon name="delete" /></m3e-icon-button></template>
  </EditorContentSection>
  <EditorContentSection v-for="wallet in wallets" :key="wallet.token" :style="{order:Math.max(0,contentRank(fields,wallet.token))}"
    :title="wallet.value ? wallet.value.title || walletLabels[wallet.value.kind] : tr('不可编辑副本')" :icon="icons[wallet.value?.kind || ''] || 'info'"
    :summary="wallet.value ? walletLabels[wallet.value.kind] : translateRuntimeError(wallet.reason ?? '')" :disabled="!wallet.value">
    <template v-if="wallet.value">
      <m3e-button variant="tonal" type="button" @click="openWallet(wallet.value)">{{ tr('编辑完整副本') }}</m3e-button>
      <template v-if="owner"><AttachmentPreview v-for="asset in wallet.value.assets" :key="asset.name" :owner="owner" :name="asset.name" :expected="asset" :label="asset.displayName"/></template>
      <h3>{{ tr('添加副本附件或卡面') }}</h3><WalletAssetEditor :owner="owner" @added="addAsset(wallet.value!, $event)"/>
    </template>
  </EditorContentSection>
  <EditorContentSection v-for="token in tokens.filter(token => !BASE_CONTENT_ORDER.includes(token) && !token.startsWith('BLOCK:') && !credentialLabels?.[token])" :key="token" :style="{order:contentRank(fields,token)}" :title="tr('未知内容')" icon="info" :summary="token" disabled />
  <m3e-dialog v-if="activeBlock" v-material-dialog open dismissible class="material-dialog material-editor-dialog editor-content-dialog" :close-label="tr('取消内容编辑')" @keydown="containKey" @closed.self="activeBlock=undefined"><h2 slot="header">{{ labels[activeBlock.kind] }}</h2><div class="editor-fields structured-editor editor-content-fields"><m3e-form-field v-field-label variant="filled"><label slot="label">{{ tr('内容名称') }}</label><input v-model="blockTitle" autocomplete="off" /></m3e-form-field><m3e-button type="button" variant="text" @click="showSecrets=!showSecrets">{{ showSecrets ? tr('隐藏敏感内容') : tr('显示敏感内容') }}</m3e-button><m3e-form-field v-for="key in Object.keys(blockFields)" :key="key" v-field-label variant="filled"><label slot="label">{{ labels[key] || key }}</label><textarea v-model="blockFields[key]" :class="{'concealed-secret': !showSecrets && /^(key|token|privateKey|privateKeyOpenSsh|content)$/.test(key)}" :aria-label="labels[key] || key" rows="3" autocomplete="off" spellcheck="false" /></m3e-form-field><p v-if="activeBlock.kind==='QR_CODE'" class="editor-hint">{{ tr('literal 为普通内容；template 与版本 1 使用 %ACCOUNT%、%PASSWORD% 等字段占位符，查看时临时展开。') }}</p><p v-if="error" role="alert" class="form-error">{{ error }}</p></div><footer slot="actions" end><m3e-button type="button" variant="text" @click="activeBlock=undefined">{{ tr('取消') }}</m3e-button><m3e-button type="button" variant="filled" :disabled="busy" @click="saveBlock">{{ tr('保存内容草稿') }}</m3e-button></footer></m3e-dialog>
  <VaultItemEditor v-if="activeWallet && walletItem" :key="activeWallet.id" nested :item="walletItem" :initial-kind="walletItem.kind as any" :providers="providers" :save-item="saveWallet" @cancel="activeWallet=undefined;walletItem=undefined" />
</template>
