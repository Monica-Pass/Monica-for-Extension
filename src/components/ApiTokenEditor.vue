<script setup lang="ts">
import EditorContentSection from "./EditorContentSection.vue";
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { computed, reactive, ref, toRaw } from "vue";
import CredentialTypeSelect from './CredentialTypeSelect.vue';
import type { ApiTokenDraft, CredentialCreateType } from '../manager/editor-types';
import { tr } from "../i18n";
import type { ApiTokenItem, ProviderAccount, VaultItem } from "../core/model";
import { apiTokenValidationError, serializeApiTokenMetadata, serializeApiTokenPayload } from "../core/api-token";

const props = defineProps<{ item?: ApiTokenItem; initialDraft?: ApiTokenDraft; providers: ProviderAccount[]; saveItem: (item: VaultItem) => Promise<void> }>();
const emit = defineEmits<{ cancel: []; switchType: [type: CredentialCreateType, draft: ApiTokenDraft] }>();
const providers = computed(() => props.providers.filter(provider => provider.enabled && ["local", "mdbx2"].includes(provider.kind)));
const defaultProvider = providers.value.find(provider => provider.isDefaultSaveTarget) || providers.value.find(provider => provider.kind === "local") || providers.value[0];
const fields = reactive<ApiTokenDraft>({
  title: props.item?.title || "", provider: props.item?.provider || "", apiBase: props.item?.apiBase || "", token: props.item?.token || "",
  notes: props.item?.notes || "", favorite: props.item?.favorite || false,
  customFields: (props.item?.customFields || []).map(field => ({ ...field })) as ApiTokenItem["customFields"],
  providerId: props.item?.providerRefs[0]?.providerId || defaultProvider?.id || ""
});
if (!props.item && props.initialDraft) {
  Object.assign(fields, structuredClone(toRaw(props.initialDraft)));
  if (!providers.value.some(provider => provider.id === fields.providerId)) fields.providerId = defaultProvider?.id || '';
}
function switchType(type: CredentialCreateType) {
  if (!props.item && !saving.value && type !== 'api-token') emit('switchType', type, structuredClone(toRaw(fields)));
}
const reveal = ref(false);
const error = ref("");
const saving = ref(false);
function addField() {
  // New fields take the next unused negative ID, as serializeApiTokenMetadata does. Existing IDs
  // may be 64-bit strings, so compare them as text instead of with Math.min.
  const used = new Set(fields.customFields.map(field => String(field.id)));
  let id = -1;
  while (used.has(String(id))) id--;
  fields.customFields.push({ id, name: "", value: "", protected: true });
}
async function submit() {
  if (saving.value) return;
  error.value = "";
  const now = new Date().toISOString();
  const item: ApiTokenItem = {
    ...props.item, id: props.item?.id || crypto.randomUUID(), kind: "api-token", title: fields.title.trim(), provider: fields.provider.trim(), apiBase: fields.apiBase.trim(), token: fields.token,
    notes: fields.notes, favorite: fields.favorite, customFields: fields.customFields.map(field => ({ ...field, name: field.name.trim() })).filter(field => field.name || field.value),
    createdAt: props.item?.createdAt || now, updatedAt: now,
    providerRefs: props.item?.providerRefs || (providers.value.find(provider => provider.id === fields.providerId)?.kind === "mdbx2" ? [{ providerId: fields.providerId }] : [])
  };
  const invalid = apiTokenValidationError(item);
  if (invalid) { error.value = tr(invalid); return; }
  if (!props.item && !providers.value.some(provider => provider.id === fields.providerId)) { error.value = tr('请选择可用的密码源。'); return; }
  saving.value = true;
  try {
    item.apiTokenPayload = serializeApiTokenPayload(item);
    item.apiTokenMetadata = serializeApiTokenMetadata(item);
    await props.saveItem(item);
  } catch (failure) { error.value = failure instanceof Error ? tr(failure.message) : tr('保存失败，请重试。'); }
  finally { saving.value = false; }
}
</script>

<template>
  <m3e-dialog v-material-dialog open class="material-dialog material-editor-dialog" :disableClose.prop="saving" :dismissible="!saving" :close-label="tr('关闭')" @closed.self="emit('cancel')">
<h2 slot="header" id="api-token-editor-title">{{ item ? tr('编辑 API 令牌') : tr('添加 API 令牌') }}</h2>
<form id="api-token-form" class="material-editor-form editor-form editor-with-actions" @submit.prevent="submit">
        <div class="editor-fields structured-editor">
          <section class="editor-section editor-basics" :aria-label="tr('基本信息')">
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="field editor-title-field"><label slot="label">{{ tr('名称 *') }}</label><input v-model="fields.title" autofocus autocomplete="off" :placeholder="tr('例如：GitHub 工作密钥')" maxlength="256" /></m3e-form-field>
            <div class="editor-meta-grid"><CredentialTypeSelect v-if="!item" value="api-token" :disabled="saving" @select="switchType" /><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('保存到') }}</label><component :is="materialSelectTag" @input="fields.providerId = ($event.target as HTMLElement &amp; { value: string }).value"  :disabled="Boolean(item) || saving"><component :is="materialOptionTag" :selected.prop="String(fields.providerId ?? '') === String(provider.id)" v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.kind === 'local' ? tr('Monica 本地库') : provider.name }}</component></component></m3e-form-field></div>
          </section>
          <section class="editor-section" :aria-label="tr('密钥信息')"><h3>{{ tr('密钥信息') }}</h3>
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('服务商 *') }}</label><input v-model="fields.provider" list="api-token-providers" autocomplete="off" placeholder="GitHub, GitLab, OpenAI…" maxlength="128" /><datalist id="api-token-providers"><option value="github" /><option value="gitlab" /><option value="openai" /><option value="anthropic" /><option value="cloudflare" /></datalist></m3e-form-field>
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('API 密钥 *') }}</label><input v-model="fields.token" :aria-label="tr('API 密钥 *')" :type="reveal ? 'text' : 'password'" autocomplete="new-password" spellcheck="false" /><m3e-button slot="suffix" variant="text" type="button" toggle :selected.prop="reveal" @beforeinput.prevent @click="reveal = !reveal">{{ reveal ? tr('隐藏') : tr('显示') }}</m3e-button></m3e-form-field>
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('API 地址（可选）') }}</label><input v-model="fields.apiBase" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/" maxlength="2048" /></m3e-form-field>
          </section>
          <section class="editor-section editor-extras editor-content-list" :aria-label="tr('补充信息')"><h3>{{ tr('补充信息') }}</h3>
            <EditorContentSection  :title="tr('自定义字段')" icon="edit_note" :summary="fields.customFields.length ? String(fields.customFields.length) : tr('可选')"><div class="editor-disclosure-body"><div v-for="(field, index) in fields.customFields" :key="field.id" class="custom-field-row"><m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('自定义字段 {0} 名称', { 0: index + 1 }) }}</label><input v-model="field.name" :aria-label="tr('自定义字段 {0} 名称', { 0: index + 1 })" :placeholder="tr('字段名称')" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('自定义字段 {0} 值', { 0: index + 1 }) }}</label><input v-model="field.value" :type="field.protected ? 'password' : 'text'" :aria-label="tr('自定义字段 {0} 值', { 0: index + 1 })" :placeholder="tr('字段值')" autocomplete="off" /></m3e-form-field><label v-choice-label class="compact-check"><m3e-checkbox :checked.prop="field.protected" @input="field.protected = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span>{{ tr('隐藏') }}</span></label><m3e-icon-button type="button" :aria-label="tr('删除自定义字段 {0}', { 0: index + 1 })" @click="fields.customFields.splice(index, 1)"><m3e-icon name="close" /></m3e-icon-button></div><m3e-button variant="text" class="editor-text-action" type="button" :disabled="fields.customFields.length >= 128" @click="addField"><m3e-icon slot="icon" name="add" />{{ tr('添加字段') }}</m3e-button></div></EditorContentSection>
            <EditorContentSection :title="tr('备注')" icon="note" :summary="fields.notes ? tr('已配置') : tr('可选')"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('备注') }}</label><textarea v-model="fields.notes" rows="3" :placeholder="tr('记录用途、权限范围或到期提醒')" /></m3e-form-field></EditorContentSection>
            <EditorContentSection :title="tr('更多选项')" icon="tune" :summary="fields.favorite ? tr('收藏并优先显示') : tr('可选')"><label v-choice-label class="favorite-row"><m3e-checkbox :checked.prop="fields.favorite" @input="fields.favorite = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span>{{ tr('收藏并优先显示') }}</span></label></EditorContentSection>
            <p class="editor-hint">{{ tr('与 Android 同步请选择 MDBX2 密码源。API 密钥不会参与网站自动填充。') }}</p>
          </section>
        </div>

      </form>
<footer slot="actions" end><p v-if="error" class="form-error editor-footer-status" role="alert">{{ error }}</p><m3e-button variant="text" type="button" :disabled="saving" @click="emit('cancel')">{{ tr('取消') }}</m3e-button><m3e-button form="api-token-form" variant="filled" type="submit" :disabled="saving">{{ saving ? tr('正在保存…') : tr('加密保存') }}</m3e-button></footer>
</m3e-dialog>
</template>
