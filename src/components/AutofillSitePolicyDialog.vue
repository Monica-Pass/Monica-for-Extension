<script setup lang="ts">
import { ref, watch } from "vue";
import { vaultClient } from "../runtime/client";
import { normalizeSitePolicyHost, type AutofillSitePolicy } from "../autofill/site-policy";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const policy = ref<AutofillSitePolicy>({ blockedHosts: [], saveBlockedHosts: [] });
const input = ref("");
const target = ref<"blockedHosts" | "saveBlockedHosts">("blockedHosts");
const busy = ref(false);
const error = ref("");

watch(() => props.open, async (open) => {
  if (!open) return;
  error.value = "";
  input.value = "";
  try { policy.value = await vaultClient.getAutofillSitePolicy(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "无法读取排除项。"; }
});

function addHost() {
  error.value = "";
  try {
    const host = normalizeSitePolicyHost(input.value);
    if (!policy.value[target.value].includes(host)) policy.value[target.value] = [...policy.value[target.value], host].sort();
    input.value = "";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "网站域名无效。"; }
}

function removeHost(key: "blockedHosts" | "saveBlockedHosts", host: string) {
  policy.value[key] = policy.value[key].filter((item) => item !== host);
}

async function save() {
  busy.value = true; error.value = "";
  try { policy.value = await vaultClient.setAutofillSitePolicy(policy.value); emit("saved"); emit("close"); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "保存排除项失败。"; }
  finally { busy.value = false; }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="site-policy-backdrop" role="presentation" @click.self="emit('close')">
      <section class="site-policy-dialog" role="dialog" aria-modal="true" aria-labelledby="site-policy-title">
        <header><div><h2 id="site-policy-title">自动填充排除项</h2><p>只保存网站域名，不保存路径或浏览记录。</p></div><m3e-icon-button aria-label="关闭" @click="emit('close')"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header>
        <div class="site-policy-form">
          <select v-model="target" aria-label="排除类型"><option value="blockedHosts">禁止自动填充</option><option value="saveBlockedHosts">禁止保存提示</option></select>
          <input v-model="input" placeholder="example.com" autocomplete="off" @keydown.enter.prevent="addHost" />
          <m3e-button variant="tonal" type="button" @click="addHost"><m3e-icon slot="icon" name="add"></m3e-icon>添加</m3e-button>
        </div>
        <div class="site-policy-lists">
          <div><strong>禁止自动填充</strong><span v-if="!policy.blockedHosts.length" class="empty">暂无</span><ul><li v-for="host in policy.blockedHosts" :key="'a-' + host"><span>{{ host }}</span><m3e-icon-button aria-label="删除网站" @click="removeHost('blockedHosts', host)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></li></ul></div>
          <div><strong>禁止保存提示</strong><span v-if="!policy.saveBlockedHosts.length" class="empty">暂无</span><ul><li v-for="host in policy.saveBlockedHosts" :key="'s-' + host"><span>{{ host }}</span><m3e-icon-button aria-label="删除网站" @click="removeHost('saveBlockedHosts', host)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button></li></ul></div>
        </div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <footer><m3e-button variant="text" type="button" @click="emit('close')">取消</m3e-button><m3e-button variant="filled" type="button" :disabled="busy" @click="save">{{ busy ? "保存中…" : "保存" }}</m3e-button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.site-policy-backdrop { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 16px; background: rgb(0 0 0 / 48%); }
.site-policy-dialog { width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 16px; padding: 20px; color: var(--md-sys-color-on-surface, var(--app-text)); background: var(--md-sys-color-surface-container, var(--app-surface)); }
.site-policy-dialog header, .site-policy-dialog footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.site-policy-dialog h2, .site-policy-dialog p { margin: 0; }.site-policy-dialog header p { margin-top: 4px; color: var(--app-muted); font-size: .85rem; }
.site-policy-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) auto; gap: 8px; margin: 20px 0 12px; }
.site-policy-form select, .site-policy-form input { min-width: 0; min-height: 44px; border: 1px solid var(--app-outline); border-radius: 8px; padding: 0 10px; color: inherit; background: transparent; }
.site-policy-lists { display: grid; gap: 12px; max-height: 300px; overflow: auto; }.site-policy-lists > div { border: 1px solid var(--app-outline); border-radius: 8px; padding: 10px; }.site-policy-lists ul { display: grid; gap: 2px; margin: 6px 0 0; padding: 0; list-style: none; }.site-policy-lists li { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }.site-policy-lists li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.empty { display: block; margin-top: 8px; color: var(--app-muted); font-size: .85rem; }
.site-policy-dialog footer { justify-content: flex-end; margin-top: 16px; }.form-error { color: var(--app-error); }
@media (max-width: 560px) { .site-policy-form { grid-template-columns: 1fr 1fr; }.site-policy-form m3e-button { grid-column: 1 / -1; } }
</style>
