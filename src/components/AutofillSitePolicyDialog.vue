<script setup lang="ts">
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { tr } from '../i18n';

import { ref, watch } from "vue";
import { vaultClient } from "../runtime/client";
import { normalizeSitePolicyHost, type AutofillSitePolicy } from "../autofill/site-policy";
import type { BlockedFieldSignatureRecord } from "../autofill/field-policy";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const policy = ref<AutofillSitePolicy>({ blockedHosts: [], saveBlockedHosts: [] });
const input = ref("");
const target = ref<"blockedHosts" | "saveBlockedHosts">("blockedHosts");
const busy = ref(false);
const error = ref("");
const blockedFields = ref<BlockedFieldSignatureRecord[]>([]);

watch(() => props.open, async (open) => {
  if (!open) return;
  error.value = "";
  input.value = "";
  try { [policy.value, blockedFields.value] = await Promise.all([vaultClient.getAutofillSitePolicy(), vaultClient.listAutofillBlockedFields()]); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : tr('无法读取排除项。'); }
});

function addHost() {
  error.value = "";
  try {
    const host = normalizeSitePolicyHost(input.value);
    if (!policy.value[target.value].includes(host)) policy.value[target.value] = [...policy.value[target.value], host].sort();
    input.value = "";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : tr('网站域名无效。'); }
}

function removeHost(key: "blockedHosts" | "saveBlockedHosts", host: string) {
  policy.value[key] = policy.value[key].filter((item) => item !== host);
}

async function removeField(signature: string) {
  busy.value = true; error.value = "";
  try { await vaultClient.removeAutofillBlockedField(signature); blockedFields.value = blockedFields.value.filter((item) => item.signature !== signature); emit("saved"); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : tr('恢复字段失败。'); }
  finally { busy.value = false; }
}

function roleLabel(role: BlockedFieldSignatureRecord["role"]) {
  return ({ username: tr('用户名'), "current-password": tr('密码'), "new-password": tr('新密码'), totp: tr('验证码'), wallet: tr('证件或支付') } as const)[role];
}

async function save() {
  busy.value = true; error.value = "";
  try { policy.value = await vaultClient.setAutofillSitePolicy(policy.value); emit("saved"); emit("close"); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : tr('保存排除项失败。'); }
  finally { busy.value = false; }
}
</script>

<template>
  <m3e-dialog v-material-dialog v-if="open" open class="material-dialog" :disableClose.prop="busy" :dismissible="!busy" :close-label="tr('关闭')" @closed.self="emit('close')">
        <h2 slot="header">{{ tr('自动填充排除项') }}</h2>
        <p>{{ tr('只保存网站域名，不保存路径或浏览记录。') }}</p>
        <div class="site-policy-form">
          <m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('排除类型') }}</label><component :is="materialSelectTag" @input="target = ($event.target as HTMLElement &amp; { value: string }).value"  :aria-label="tr('排除类型')"><component :is="materialOptionTag" :selected.prop="String(target ?? '') === String('blockedHosts')" value="blockedHosts">{{ tr('禁止自动填充') }}</component><component :is="materialOptionTag" :selected.prop="String(target ?? '') === String('saveBlockedHosts')" value="saveBlockedHosts">{{ tr('禁止保存提示') }}</component></component></m3e-form-field>
          <m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('网站域名') }}</label><input v-model="input" placeholder="example.com" autocomplete="off" @keydown.enter.prevent="addHost" /></m3e-form-field>
          <m3e-button variant="tonal" type="button" @click="addHost"><m3e-icon slot="icon" name="add"></m3e-icon>{{ tr('添加') }}</m3e-button>
        </div>
        <div class="site-policy-lists">
          <div><strong>{{ tr('禁止自动填充') }}</strong><span v-if="!policy.blockedHosts.length" class="empty">{{ tr('暂无') }}</span><ul><li v-for="host in policy.blockedHosts" :key="'a-' + host"><span>{{ host }}</span><m3e-icon-button :aria-label="tr('删除网站')" @click="removeHost('blockedHosts', host)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></li></ul></div>
          <div><strong>{{ tr('禁止保存提示') }}</strong><span v-if="!policy.saveBlockedHosts.length" class="empty">{{ tr('暂无') }}</span><ul><li v-for="host in policy.saveBlockedHosts" :key="'s-' + host"><span>{{ host }}</span><m3e-icon-button :aria-label="tr('删除网站')" @click="removeHost('saveBlockedHosts', host)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></li></ul></div>
          <div><strong>{{ tr('字段级排除') }}</strong><span v-if="!blockedFields.length" class="empty">{{ tr('暂无') }}</span><ul><li v-for="field in blockedFields" :key="field.signature"><span><b>{{ field.hostname }}</b><small>{{ roleLabel(field.role) }} · {{ field.frameScope === 'frame' ? tr('嵌入框') : tr('主页面') }}</small></span><m3e-icon-button :aria-label="tr('恢复 {0} 的{1}字段', { 0: field.hostname, 1: roleLabel(field.role) })" :disabled="busy" @click="removeField(field.signature)"><m3e-icon name="restart_alt"></m3e-icon></m3e-icon-button></li></ul></div>
        </div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <footer slot="actions" end><m3e-button variant="text" type="button" :disabled="busy" @click="emit('close')">{{ tr('取消') }}</m3e-button><m3e-button variant="filled" type="button" :disabled="busy" @click="save">{{ busy ? tr('保存中…') : tr('保存') }}</m3e-button></footer>
  </m3e-dialog>
</template>

<style scoped>
.site-policy-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) auto; gap: 8px; margin: 20px 0 12px; }
.site-policy-lists { display: grid; gap: 12px; }.site-policy-lists > div { border-radius: 16px; padding: 16px; background: var(--md-sys-color-surface-container-highest); }.site-policy-lists ul { display: grid; gap: 2px; margin: 6px 0 0; padding: 0; list-style: none; }.site-policy-lists li { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }.site-policy-lists li > span { min-width: 0; overflow-wrap: anywhere; }.site-policy-lists li b, .site-policy-lists li small { display: block; }.site-policy-lists li small { margin-top: 2px; color: var(--app-muted); font-size: .75rem; }.empty { display: block; margin-top: 8px; color: var(--app-muted); font-size: .85rem; }
.form-error { color: var(--app-error); }
@media (max-width: 560px) { .site-policy-form { grid-template-columns: 1fr 1fr; }.site-policy-form m3e-button { grid-column: 1 / -1; } }
</style>
