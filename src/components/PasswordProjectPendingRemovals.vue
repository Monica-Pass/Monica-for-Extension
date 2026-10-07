<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ProviderAccount } from '../core/model';
import type { Mdbx2VaultRuntimeStatus } from '../providers/mdbx2/native-contract';
import type { PasswordProjectRemovalStatus } from '../background/password-project-removal';
import { vaultClient } from '../runtime/client';
import { tr } from '../i18n';

const props = defineProps<{ providers: ProviderAccount[]; runtimeStatuses: Record<string, Mdbx2VaultRuntimeStatus>; revision: number }>();
const emit = defineEmits<{ completed: []; unlock: [provider: ProviderAccount] }>();
type RemovalRow = PasswordProjectRemovalStatus & { backend?: 'keepass' };
const operations = ref<RemovalRow[]>([]), busy = ref(''), loading = ref(false), error = ref(''), notice = ref('');
const root = ref<HTMLElement>();
let disposed = false, loadToken = 0;
onBeforeUnmount(() => { disposed = true; loadToken++; });
const connectionState = computed(() => JSON.stringify([props.revision, props.providers.map(p => [p.id, p.enabled, props.runtimeStatuses[p.id]?.open])]));
watch(connectionState, () => { void refresh(); }, { immediate: true });
function source(row: RemovalRow) { return props.providers.find(p => p.id === row.providerId); }
function locked(row: RemovalRow) {
  if (row.backend === 'keepass') return !source(row)?.enabled;
  return !!row.providerId && (!source(row)?.enabled || !props.runtimeStatuses[row.providerId]?.open || !props.runtimeStatuses[row.providerId]?.available);
}
function status(row: RemovalRow) {
  if (row.backend === 'keepass') return tr('正在核对操作结果…');
  return row.status === 'preparing' ? tr('正在保留共享内容与附件') : row.status === 'restoring' ? tr('正在恢复密码与附件') : tr('正在完成移除');
}
async function refresh() {
  const token = ++loadToken; loading.value = true;
  try {
    const [rows, keepass] = await Promise.all([vaultClient.listPasswordProjectRemovals(), vaultClient.listKeePassProjectRemovals()]);
    if (!disposed && token === loadToken) operations.value = [...rows, ...keepass.map(row => ({
      operationId: row.operationId, providerId: row.providerId, title: row.title, backend: 'keepass' as const,
      status: row.status === 'staged' ? 'preparing' as const : row.status === 'writing' ? 'deleting' as const : row.status,
      removedItemIds: row.removedItemIds, retainedItemIds: [], pendingRestoreItemIds: [], canCancel: row.canCancel, supported: true
    }))];
  }
  catch (cause) { if (!disposed && token === loadToken) error.value = cause instanceof Error ? tr(cause.message) : tr('操作失败'); }
  finally { if (!disposed && token === loadToken) loading.value = false; }
}
async function run(row: RemovalRow, cancel: boolean) {
  if (busy.value || !row.supported || cancel && !row.canCancel || !cancel && locked(row)) return;
  busy.value = row.operationId; error.value = ''; notice.value = '';
  try {
    const result = row.backend === 'keepass'
      ? cancel ? await vaultClient.cancelKeePassProjectRemoval(row.operationId) : await vaultClient.resumeKeePassProjectRemoval(row.operationId)
      : cancel ? await vaultClient.cancelPasswordProjectRemoval(row.operationId) : await vaultClient.resumePasswordProjectRemoval(row.operationId);
    if (disposed) return;
    notice.value = result.status === 'cancelled' ? tr('已取消这次移除，其他编辑已保留。') : result.status === 'completed' ? tr('密码移除已完成。') : tr('操作尚未完成，可以继续重试。');
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? tr(cause.message) : tr('操作失败'); }
  finally {
    if (!disposed) {
      busy.value = ''; emit('completed'); await refresh(); await nextTick();
      root.value?.querySelector<HTMLElement>('[data-removal-refresh]')?.focus();
    }
  }
}
</script>
<template>
  <section v-if="operations.length || error || notice" ref="root" class="pending-removals" data-pending-removals aria-labelledby="pending-removals-title" :aria-busy="Boolean(busy) || loading">
    <header><h2 id="pending-removals-title">{{ tr('未完成的密码移除') }}</h2><m3e-icon-button data-removal-refresh :aria-label="tr('刷新')" :disabled="Boolean(busy) || loading" @click="error = ''; refresh()"><m3e-icon name="refresh" /></m3e-icon-button></header>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="notice || busy" role="status">{{ busy ? tr('正在核对操作结果…') : notice }}</p>
    <article v-for="row in operations" :key="row.operationId" :data-removal-operation="row.operationId">
      <div class="joined">
        <div class="pending-row"><m3e-icon name="key" /><div><strong>{{ row.title || tr('未命名项目') }}</strong><small>{{ row.providerId ? source(row)?.name || tr('密码源不可用') : tr('Monica 本地库') }} · {{ tr('移除 {0} 个密码', {0: row.removedItemIds.length}) }}</small></div></div>
        <div class="pending-row"><m3e-icon :name="locked(row) ? 'lock' : 'pending_actions'" /><div><span>{{ status(row) }}</span><small v-if="locked(row)">{{ tr('请先解锁密码库以继续。') }}</small></div></div>
      </div>
      <p v-if="!row.supported">{{ tr('此来源的移除操作暂不受支持，原始内容已保留。') }}</p>
      <div class="actions">
        <m3e-button v-if="locked(row)" variant="tonal" :disabled="Boolean(busy) || !source(row) || !row.supported" @click="emit('unlock', source(row)!)"><m3e-icon slot="icon" name="lock_open" />{{ tr('解锁并设置') }}</m3e-button>
        <m3e-button v-else variant="tonal" :disabled="Boolean(busy) || !row.supported" data-removal-resume @click="run(row, false)"><m3e-icon slot="icon" name="restore" />{{ tr('核对并继续') }}</m3e-button>
        <m3e-button v-if="row.canCancel" variant="text" :disabled="Boolean(busy)" data-removal-cancel @click="run(row, true)"><m3e-icon slot="icon" name="undo" />{{ tr('取消这次移除') }}</m3e-button>
      </div>
    </article>
  </section>
</template>
<style scoped>
.pending-removals { display: grid; gap: 20px; min-width: 0; margin: 8px 12px 24px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
article { display: grid; gap: 16px; min-width: 0; }
.joined { display: grid; gap: 4px; }
.pending-row { display: flex; gap: 16px; align-items: center; padding: 16px; min-height: 64px; box-sizing: border-box; background: var(--md-sys-color-surface-container-low); border-radius: 4px; }
.pending-row:first-child { border-radius: 24px 24px 4px 4px; }
.pending-row:last-child { border-radius: 4px 4px 24px 24px; }
.pending-row > div { display: grid; gap: 4px; min-width: 0; }
.pending-row m3e-icon { color: var(--md-sys-color-primary); flex: 0 0 auto; }
p, strong, small, span { overflow-wrap: anywhere; }
small { color: var(--md-sys-color-on-surface-variant); }
.form-error { white-space: pre-wrap; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; }
@media (max-width: 600px) { .actions { display: grid; } .actions m3e-button { width: 100%; } }
</style>
