<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { vaultClient } from '../runtime/client';
import { assembleKeePassRecoveryDownload } from '../manager/keepass-recovery-download';
import type { RecoveryDownloadDescriptor } from '../background/keepass-recovery-download';
import { tr } from '../i18n';
type Copy = Awaited<ReturnType<typeof vaultClient.listKeePassProjectRecoveryCopies>>[number];
const props = defineProps<{ providerId: string; revision: number; disabled?: boolean }>();
const root = ref<HTMLElement>(), opened = ref(false), copies = ref<Copy[]>([]), selected = ref<Copy>();
const mode = ref<'export' | 'delete'>(), password = ref(''), repeated = ref(''), busy = ref(false), error = ref(''), notice = ref('');
const received = ref(0);
const loading = ref(false), loaded = ref(false);
let disposed = false, version = 0, sourceVersion = 0;
const active = shallowRef<{ providerId: string; requestId: string; controller: AbortController }>();
const message = (cause: unknown) => cause instanceof Error ? tr(cause.message) : tr('操作失败');
const date = (copy: Copy) => new Date(copy.createdAt).toLocaleString();
async function refresh() {
  const current = ++version;
  loading.value = true;
  try { const rows = await vaultClient.listKeePassProjectRecoveryCopies(props.providerId); if (!disposed && current === version) { copies.value = rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); loaded.value = true; } }
  catch (cause) { if (!disposed && current === version) error.value = message(cause); }
  finally { if (!disposed && current === version) loading.value = false; }
}
watch(() => props.revision, () => { if (opened.value && !props.disabled) void refresh(); });
watch(() => props.providerId, () => {
  sourceVersion++; version++;
  copies.value = []; loaded.value = false; loading.value = false;
  selected.value = undefined; mode.value = undefined; error.value = ''; notice.value = '';
  void cancel();
  if (opened.value && !props.disabled) void refresh();
});
watch(() => props.disabled, disabled => { if (disabled) void cancel(); });
onBeforeUnmount(() => { disposed = true; version++; void cancel(); });
async function choose(copy: Copy, target: 'export' | 'delete') {
  if (busy.value || active.value) return;
  selected.value = { ...copy }; mode.value = target; password.value = ''; repeated.value = ''; error.value = ''; notice.value = '';
  await nextTick(); root.value?.querySelector<HTMLElement>('[data-recovery-form-focus]')?.focus();
}
async function close() {
  selected.value = undefined; mode.value = undefined; password.value = ''; repeated.value = '';
  await nextTick(); root.value?.querySelector<HTMLElement>('[data-recovery-open]')?.focus();
}
async function cancel() {
  const scope = sourceVersion;
  const operation = active.value; operation?.controller.abort();
  password.value = ''; repeated.value = '';
  if (operation) {
    try { await vaultClient.cancelKeePassRecoveryExport(operation.providerId, operation.requestId); }
    catch (cause) { if (!disposed && scope === sourceVersion) error.value = message(cause); return; }
    if (active.value === operation) active.value = undefined;
  }
  if (!disposed && scope === sourceVersion && !active.value) { busy.value = false; await close(); }
}
async function save(descriptor: RecoveryDownloadDescriptor, operation: NonNullable<typeof active.value>) {
  const bytes = await assembleKeePassRecoveryDownload(descriptor, {
    read: (handle, offset) => vaultClient.readKeePassRecoveryExport(operation.providerId, handle, offset),
    release: handle => vaultClient.releaseKeePassRecoveryExport(operation.providerId, handle),
  }, operation.controller.signal, (count, total) => { if (!disposed && active.value === operation && props.providerId === operation.providerId) received.value = Math.round(count / total * 100); });
  try {
    operation.controller.signal.throwIfAborted();
    if (disposed || active.value !== operation || props.disabled || props.providerId !== operation.providerId) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'monica-recovery.kdbx'; anchor.click(); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    notice.value = tr('已交给浏览器下载，请确认文件已保存。'); active.value = undefined; await close();
  } finally { bytes.fill(0); }
}
async function exportCopy() {
  if (busy.value || props.disabled || !selected.value || selected.value.providerId !== props.providerId) return;
  if (!active.value && (password.value.length < 8 || password.value.length > 4096 || password.value !== repeated.value)) { error.value = tr('请输入至少 8 个字符的相同密码。'); return; }
  busy.value = true; error.value = ''; received.value = 0;
  const existing = active.value;
  const operation = active.value ||= { providerId: props.providerId, requestId: crypto.randomUUID(), controller: new AbortController() };
  try {
    let descriptor: RecoveryDownloadDescriptor | undefined;
    if (!existing) {
      const secret = password.value; password.value = ''; repeated.value = '';
      try { descriptor = await vaultClient.beginKeePassRecoveryExport(operation.providerId, selected.value.operationId, selected.value.intentTag, secret, operation.requestId); }
      catch (cause) { if (!disposed && !operation.controller.signal.aborted && active.value === operation && props.providerId === operation.providerId) error.value = message(cause); }
    }
    operation.controller.signal.throwIfAborted();
    if (!descriptor) {
      const status = await vaultClient.statusKeePassRecoveryExport(operation.providerId, operation.requestId);
      operation.controller.signal.throwIfAborted();
      if (status.state === 'ready') descriptor = status.descriptor;
      else if (status.state === 'pending') { notice.value = tr('文件仍在生成，请稍后核对或取消。'); return; }
      else { await vaultClient.cancelKeePassRecoveryExport(operation.providerId, operation.requestId); active.value = undefined; throw new Error('导出未完成，请重新输入密码后重试。'); }
    }
    error.value = ''; await save(descriptor, operation);
  } catch (cause) { if (!disposed && !operation.controller.signal.aborted) error.value = message(cause); }
  finally { if (!disposed && (!active.value || active.value === operation)) busy.value = false; }
}
async function remove() {
  const copy = selected.value;
  if (!copy?.canDelete || busy.value || props.disabled || copy.providerId !== props.providerId) return;
  const providerId = props.providerId, scope = sourceVersion;
  const current = () => !disposed && scope === sourceVersion && props.providerId === providerId;
  busy.value = true; error.value = '';
  try {
    try { await vaultClient.deleteKeePassProjectRecoveryCopy(providerId, copy.operationId, copy.intentTag, true); }
    catch (cause) {
      // An absent row from a successful authenticated read proves deletion.
      // Failure to read or a remaining row keeps the original confirmation.
      const remaining = await vaultClient.listKeePassProjectRecoveryCopies(providerId);
      if (remaining.some(row => row.operationId === copy.operationId)) throw cause;
    }
    if (current()) { notice.value = tr('恢复副本已删除。'); await close(); if (current()) await refresh(); }
  } catch (cause) { if (current()) error.value = message(cause); }
  finally { if (current()) busy.value = false; }
}
</script>

<template>
  <section ref="root" class="recovery-copies" data-recovery-copies>
    <m3e-button variant="text" data-recovery-open :disabled="disabled || busy" @click="opened = !opened; opened && refresh()">{{ tr('恢复副本') }}</m3e-button>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="opened">
      <template v-if="!selected">
        <p v-if="loading" role="status">{{ tr('正在加载…') }}</p>
        <p v-else-if="loaded && !copies.length">{{ tr('暂无恢复副本。') }}</p>
        <article v-for="copy in copies" :key="copy.operationId" class="joined" :data-recovery-copy="copy.operationId">
          <div class="row"><strong>{{ date(copy) }}</strong><span>{{ copy.canDelete ? tr('可导出或删除') : tr('此副本仍受保护，暂不能删除。') }}</span></div>
          <div class="row actions"><m3e-button variant="tonal" :disabled="disabled" data-recovery-export @click="choose(copy, 'export')">{{ tr('导出加密副本') }}</m3e-button><m3e-button variant="text" data-recovery-delete :disabled="disabled || !copy.canDelete" @click="choose(copy, 'delete')">{{ tr('删除此副本') }}</m3e-button></div>
        </article>
      </template>
      <div v-else class="joined" @keydown.esc.stop.prevent="mode === 'export' ? cancel() : !busy && close()">
        <div class="row"><strong>{{ mode === 'export' ? tr('导出加密副本') : tr('删除此恢复副本？') }}</strong><span>{{ date(selected) }}</span></div>
        <template v-if="mode === 'export'">
          <div class="row"><p>{{ tr('包含原始、编辑、远端和处理后的版本。使用 KeePass 打开导出的文件。') }}</p>
            <label>{{ tr('导出密码') }}<input v-model="password" data-recovery-form-focus data-recovery-password type="password" autocomplete="new-password" maxlength="4096" :disabled="busy || Boolean(active)" /></label>
            <label>{{ tr('再次输入密码') }}<input v-model="repeated" data-recovery-repeat type="password" autocomplete="new-password" maxlength="4096" :disabled="busy || Boolean(active)" /></label>
            <p role="status" v-if="busy">{{ tr('正在生成或下载…') }} {{ received }}%</p>
          </div>
          <div class="row actions"><m3e-button data-recovery-download :disabled="busy || disabled" @click="exportCopy()">{{ active ? tr('核对并继续') : tr('生成并下载') }}</m3e-button><m3e-button variant="text" data-recovery-cancel @click="cancel()">{{ tr('取消') }}</m3e-button></div>
        </template>
        <template v-else>
          <div class="row"><p>{{ tr('只删除这一份恢复副本，当前密码库和其他副本保持不变。建议先导出需要保留的版本。') }}</p></div>
          <div class="row actions"><m3e-button data-recovery-form-focus variant="tonal" :disabled="busy" @click="close()">{{ tr('保留副本') }}</m3e-button><m3e-button data-recovery-delete-confirm variant="text" :disabled="busy || disabled" @click="remove()">{{ tr('确认删除') }}</m3e-button></div>
        </template>
      </div>
    </template>
  </section>
</template>
<style scoped>
.recovery-copies,.joined { display:grid; gap:4px; min-width:0; }
.recovery-copies { gap:12px; }
p { margin:0; overflow-wrap:anywhere; }
.row { display:grid; gap:12px; padding:16px; background:var(--md-sys-color-surface-container-high,var(--app-surface-2)); border-radius:4px; min-width:0; }
.row:first-child { border-start-start-radius:24px; border-start-end-radius:24px; }
.row:last-child { border-end-start-radius:24px; border-end-end-radius:24px; }
label { display:grid; gap:8px; }
input { box-sizing:border-box; width:100%; min-width:0; min-height:48px; padding:12px; font:inherit; color:inherit; background:var(--app-surface); border:1px solid var(--app-muted); border-radius:12px; }
.actions { display:flex; flex-wrap:wrap; gap:8px; }
@media(max-width:580px) { .actions > m3e-button { width:100%; min-height:48px; } }
</style>
