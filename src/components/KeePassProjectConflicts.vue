<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ProviderAccount, VaultItem } from '../core/model';
import type { KeePassProjectConflictReview } from '../providers/keepass/keepass-remote-session';
import type { KeePassProjectConflictSide } from '../providers/keepass/keepass-remote-rebase';
import type { KeePassProjectResolutionRequest } from '../providers/keepass/keepass-project-resolution';
import type { KeePassProjectResolutionStatus } from '../background/keepass-project-resolution';
import { vaultClient } from '../runtime/client';
import { tr } from '../i18n';
import KeePassRecoveryCopies from './KeePassRecoveryCopies.vue';

const props = defineProps<{ provider: ProviderAccount; items: VaultItem[]; revision: number; disabled?: boolean }>();
const emit = defineEmits<{ completed: [] }>();
const root = ref<HTMLElement>(), review = ref<KeePassProjectConflictReview>(), choices = ref<Record<string, 'local' | 'remote'>>({});
const pending = ref<KeePassProjectResolutionStatus[]>([]), request = ref<KeePassProjectResolutionRequest>();
const busy = ref(false), error = ref(''), notice = ref('');
let disposed = false, loadVersion = 0;
onBeforeUnmount(() => { disposed = true; loadVersion++; });
const canSave = computed(() => !!review.value?.projects.length && review.value.projects.every(row => choices.value[row.projectId]));
watch(() => [props.provider.id, props.revision], () => { void refresh(); }, { immediate: true });
async function refresh() {
  const version = ++loadVersion;
  try {
    const rows = await vaultClient.listKeePassProjectResolutions();
    if (!disposed && version === loadVersion) pending.value = rows.filter(row => row.providerId === props.provider.id);
  } catch (cause) { if (!disposed && version === loadVersion) error.value = message(cause); }
}
const message = (cause: unknown) => cause instanceof Error ? tr(cause.message) : tr('操作失败');
function title(projectId: string, index: number) {
  return props.items.find(item => item.kind === 'login' && item.passwordGroupId === projectId && item.providerRefs.some(ref => ref.providerId === props.provider.id))?.title
    || tr('密码项目 {0}', { 0: index + 1 });
}
function summary(side: KeePassProjectConflictSide) {
  return tr('有效 {0} · 回收站 {1} · 新增 {2} · 修改 {3} · 移除 {4}', { 0: side.activeCount, 1: side.trashCount,
    2: side.addedEntryUuids.length, 3: side.modifiedEntryUuids.length, 4: side.removedEntryUuids.length });
}
async function focusStart() { await nextTick(); root.value?.querySelector<HTMLElement>('[data-conflict-review]')?.focus(); }
async function openReview() {
  if (busy.value || request.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await vaultClient.reviewKeePassProjectConflicts(props.provider.id);
    if (!disposed) { review.value = result; choices.value = {}; if (!result.projects.length) notice.value = tr('当前没有需要选择版本的项目冲突。'); }
  } catch (cause) { if (!disposed) error.value = message(cause); }
  finally { if (!disposed) busy.value = false; }
}
async function run(operation?: KeePassProjectResolutionStatus, cancel = false) {
  if (busy.value || !operation && !request.value && !canSave.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  if (!operation && !request.value) request.value = { operationId: crypto.randomUUID(), reviewToken: review.value!.reviewToken,
    choices: review.value!.projects.map(row => ({ projectId: row.projectId, choice: choices.value[row.projectId] })) };
  const operationId = operation?.operationId || request.value!.operationId;
  try {
    let result: KeePassProjectResolutionStatus;
    if (operation) result = cancel ? await vaultClient.cancelKeePassProjectResolution(operationId) : await vaultClient.resumeKeePassProjectResolution(operationId);
    else {
      const existing = (await vaultClient.listKeePassProjectResolutions(operationId))[0];
      result = existing ? existing.status === 'completed' || existing.status === 'cancelled' ? existing : await vaultClient.resumeKeePassProjectResolution(operationId)
        : await vaultClient.resolveKeePassProjectConflicts(props.provider.id, request.value!, true);
    }
    if (disposed) return;
    notice.value = result.status === 'completed' ? tr('所选版本已保存到本机，请同步到其他设备。') : tr('已取消冲突处理，当前内容与恢复副本已保留。');
    request.value = undefined; review.value = undefined; choices.value = {};
  } catch (cause) {
    if (disposed) return;
    error.value = message(cause);
    // Only a successful journal lookup can release an ambiguous frozen request.
    try {
      const rows = await vaultClient.listKeePassProjectResolutions(operationId);
      if (disposed) return;
      if (rows[0]?.status === 'completed') { notice.value = tr('所选版本已保存到本机，请同步到其他设备。'); error.value = ''; }
      if (!rows.length || rows[0].status === 'completed' || rows[0].status === 'cancelled') { request.value = undefined; review.value = undefined; }
    } catch { /* Keep the original request for an explicit retry. */ }
  } finally {
    if (!disposed) { busy.value = false; await refresh(); emit('completed'); await focusStart(); }
  }
}
</script>

<template>
  <section ref="root" class="project-conflicts" data-keepass-project-conflicts :aria-busy="busy">
    <m3e-button variant="tonal" data-conflict-review :disabled="busy || disabled || Boolean(request) || pending.length > 0" @click="openReview"><m3e-icon slot="icon" name="sync_problem" />{{ tr('处理项目冲突') }}</m3e-button>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="notice || busy" role="status">{{ busy ? tr('正在核对操作结果…') : notice }}</p>
    <article v-for="row in pending" :key="row.operationId" :data-resolution-operation="row.operationId" class="joined">
      <div class="joined-row"><strong>{{ tr('未完成的冲突处理') }}</strong><span>{{ tr('需要核对文件保存结果') }}</span></div>
      <div class="joined-row"><span>{{ tr('只有文件尚未提交时才能取消，当前内容与恢复副本均保留。') }}</span><div class="actions">
        <m3e-button variant="tonal" data-resolution-resume :disabled="busy || disabled" @click="run(row)">{{ tr('核对并继续') }}</m3e-button>
        <m3e-button v-if="row.canCancel" variant="text" data-resolution-cancel :disabled="busy || disabled" @click="run(row, true)">{{ tr('检查并取消') }}</m3e-button>
      </div></div>
    </article>
    <div v-if="review?.projects.length" data-conflict-choices>
      <p>{{ tr('选择每个项目要保留的完整版本，密码、共享字段和附件一起处理。') }}</p>
      <fieldset v-for="(project, index) in review.projects" :key="project.projectId" :disabled="busy || Boolean(request)" class="joined">
        <legend>{{ title(project.projectId, index) }}</legend>
        <div class="joined-row"><strong>{{ tr('本机版本') }}</strong><span>{{ summary(project.local) }}</span></div>
        <div class="joined-row"><strong>{{ tr('远端版本') }}</strong><span>{{ summary(project.remote) }}</span></div>
        <label class="joined-row"><span>{{ tr('保留的版本') }}</span><select v-model="choices[project.projectId]" :aria-label="tr('保留的版本')" :data-conflict-project="project.projectId"><option disabled :value="undefined">{{ tr('请选择') }}</option><option value="local">{{ tr('保留本机版本') }}</option><option value="remote">{{ tr('保留远端版本') }}</option></select></label>
      </fieldset>
      <p>{{ tr('原始版本会保留为加密恢复副本。完成后仍需同步到其他设备。') }}</p>
      <div class="actions"><m3e-button data-conflict-confirm :disabled="busy || disabled || !canSave" @click="run()">{{ request ? tr('核对并继续') : tr('确认选择并保存') }}</m3e-button><m3e-button variant="text" :disabled="busy || Boolean(request)" @click="review = undefined; focusStart()">{{ tr('返回') }}</m3e-button></div>
    </div>
    <m3e-button v-else-if="request && !pending.length" :disabled="busy" @click="run()">{{ tr('核对并继续') }}</m3e-button>
    <KeePassRecoveryCopies :provider-id="provider.id" :revision="revision" :disabled="disabled || busy" />
  </section>
</template>

<style scoped>
.project-conflicts { display: grid; gap: 12px; min-width: 0; }
.project-conflicts p { margin: 0; overflow-wrap: anywhere; }
.joined { border: 0; padding: 0; margin: 0 0 16px; display: grid; gap: 4px; min-width: 0; }
legend { font-weight: 600; padding: 12px 0; overflow-wrap: anywhere; }
.joined-row { display: grid; gap: 8px; padding: 16px; border-radius: 4px; background: var(--md-sys-color-surface-container-high, var(--app-surface-2)); overflow-wrap: anywhere; }
.joined-row:first-of-type { border-start-start-radius: 24px; border-start-end-radius: 24px; }
.joined-row:last-child { border-end-start-radius: 24px; border-end-end-radius: 24px; }
select { min-width: 0; width: 100%; min-height: 48px; padding: 10px; font: inherit; color: inherit; background: var(--app-surface); border: 1px solid var(--app-muted); border-radius: 12px; }
select:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 580px) { .actions > m3e-button { width: 100%; min-height: 48px; } }
</style>
