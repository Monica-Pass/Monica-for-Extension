<script setup lang="ts">
import { ref, watch } from "vue";
import { writeSecretClipboard } from '../lib/secret-clipboard';
import { tr } from "../i18n";
const props = defineProps<{ value: string; label: string; secret?: boolean }>();
const revealed = ref(false); const status = ref("");
watch(() => props.value, () => { revealed.value = false; status.value = ""; });
async function copy() { try { await writeSecretClipboard(props.value); status.value = tr("已复制"); } catch { status.value = tr("复制失败"); } }
</script>
<template><div class="protected-value"><div class="protected-actions"><span>{{ label }}</span><m3e-button v-if="secret" type="button" variant="text" @click="revealed=!revealed">{{ revealed ? tr('隐藏{0}', { 0: label }) : tr('显示{0}', { 0: label }) }}</m3e-button><m3e-button type="button" variant="text" @click="copy">{{ tr('复制{0}', { 0: label }) }}</m3e-button></div><pre v-if="!secret || revealed">{{value}}</pre><p v-else :aria-label="tr('内容已隐藏')">••••••••</p><small aria-live="polite">{{status}}</small></div></template>
<style scoped>.protected-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.protected-actions>span{flex:1}.protected-value pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto;user-select:text}.protected-value{min-width:0;padding:8px 0}</style>
