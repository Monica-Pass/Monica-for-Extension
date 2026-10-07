<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ProviderAccount } from '../core/model';
import type { Mdbx2VaultRuntimeStatus } from '../providers/mdbx2/native-contract';
import type { PasswordProjectRestoreStatus } from '../background/password-project-restore';
import { vaultClient } from '../runtime/client';
import { tr } from '../i18n';
const props = defineProps<{ providers: ProviderAccount[]; runtimeStatuses: Record<string, Mdbx2VaultRuntimeStatus>; revision: number }>();
const emit = defineEmits<{ completed: []; unlock: [provider: ProviderAccount] }>();
const operations = ref<PasswordProjectRestoreStatus[]>([]), busy = ref(''), error = ref(''), notice = ref(''), root = ref<HTMLElement>();
let disposed = false, token = 0;
onBeforeUnmount(() => { disposed = true; token++; });
const connection = computed(() => JSON.stringify([props.revision, props.providers.map(p => [p.id, p.enabled, props.runtimeStatuses[p.id]?.open])]));
watch(connection, () => { void refresh(); }, { immediate: true });
function source(row: PasswordProjectRestoreStatus) { return props.providers.find(p => p.id === row.providerId); }
function locked(row: PasswordProjectRestoreStatus) { return !source(row)?.enabled || !props.runtimeStatuses[row.providerId]?.open || !props.runtimeStatuses[row.providerId]?.available; }
async function refresh() {
  const current = ++token;
  try { const rows = await vaultClient.listPasswordProjectRestores(); if (!disposed && current === token) operations.value = rows; }
  catch (cause) { if (!disposed && current === token) error.value = cause instanceof Error ? tr(cause.message) : tr('操作失败'); }
}
async function run(row: PasswordProjectRestoreStatus) {
  if (busy.value || locked(row)) return;
  busy.value = row.operationId; error.value = ''; notice.value = '';
  try {
    const result = await vaultClient.resumePasswordProjectRestore(row.operationId);
    if (!disposed) notice.value = result.status === 'completed' ? tr('密码项目已恢复。') : tr('操作尚未完成，可以继续重试。');
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? tr(cause.message) : tr('操作失败'); }
  finally { if (!disposed) { busy.value = ''; emit('completed'); await refresh(); await nextTick(); root.value?.querySelector<HTMLElement>('[data-restores-refresh]')?.focus(); } }
}
</script>
<template>
  <section v-if="operations.length || error || notice" ref="root" class="pending-restores" data-pending-restores aria-labelledby="pending-restores-title" :aria-busy="Boolean(busy)">
    <header><h2 id="pending-restores-title">{{ tr('未完成的密码恢复') }}</h2><m3e-icon-button data-restores-refresh :aria-label="tr('刷新')" :disabled="Boolean(busy)" @click="error = ''; refresh()"><m3e-icon name="refresh" /></m3e-icon-button></header>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p><p v-if="notice || busy" role="status">{{ busy ? tr('正在核对操作结果…') : notice }}</p>
    <article v-for="row in operations" :key="row.operationId" :data-restore-operation="row.operationId">
      <div class="joined"><div class="pending-row"><m3e-icon name="key" /><div><strong>{{ row.title || tr('未命名项目') }}</strong><small>{{ source(row)?.name || tr('密码源不可用') }} · {{ tr('{0} 个密码', {0: row.memberIds.length}) }}</small></div></div><div class="pending-row"><m3e-icon :name="locked(row) ? 'lock' : 'pending_actions'" /><span>{{ locked(row) ? tr('请先解锁密码库以继续。') : tr('等待恢复完成') }}</span></div></div>
      <m3e-button v-if="locked(row)" variant="tonal" :disabled="Boolean(busy) || !source(row)" @click="emit('unlock', source(row)!)"><m3e-icon slot="icon" name="lock_open" />{{ tr('解锁并设置') }}</m3e-button>
      <m3e-button v-else variant="tonal" :disabled="Boolean(busy)" data-restore-resume @click="run(row)"><m3e-icon slot="icon" name="restore" />{{ tr('核对并继续') }}</m3e-button>
    </article>
  </section>
</template>
<style scoped>
.pending-restores { display: grid; gap: 20px; min-width: 0; margin: 8px 12px 24px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
article { display: grid; gap: 16px; min-width: 0; }
.joined { display: grid; gap: 4px; }
.pending-row { display: flex; gap: 16px; align-items: center; padding: 16px; min-height: 64px; box-sizing: border-box; background: var(--md-sys-color-surface-container-low); border-radius: 4px; }
.pending-row:first-child { border-radius: 24px 24px 4px 4px; }.pending-row:last-child { border-radius: 4px 4px 24px 24px; }
.pending-row > div { display: grid; gap: 4px; min-width: 0; }.pending-row m3e-icon { color: var(--md-sys-color-primary); flex-shrink: 0; }
p, strong, small, span { overflow-wrap: anywhere; }small { color: var(--md-sys-color-on-surface-variant); }.form-error { white-space: pre-wrap; }
.pending-restores m3e-button, .pending-restores m3e-icon-button { min-height: 48px; }
@media (max-width: 600px) { m3e-button { width: 100%; } }
</style>
