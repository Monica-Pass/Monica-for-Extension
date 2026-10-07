<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { ProviderAccount } from "../core/model";
import type { Mdbx2VaultRuntimeStatus } from "../providers/mdbx2/native-contract";
import type { Mdbx2PendingMove } from "../runtime/messages";
import { vaultClient } from "../runtime/client";
import { locale, tr } from "../i18n";

const props = defineProps<{ providers: ProviderAccount[]; runtimeStatuses: Record<string, Mdbx2VaultRuntimeStatus> }>();
const emit = defineEmits<{ completed: []; unlock: [provider: ProviderAccount] }>();
const moves = ref<Mdbx2PendingMove[]>([]), selected = ref<string>(), confirmed = ref(false);
const busy = ref(false), loading = ref(false), error = ref(""), notice = ref("");
const root = ref<HTMLElement>();
let disposed = false, loadToken = 0;
onBeforeUnmount(() => { disposed = true; loadToken++; });
const connectionState = computed(() => JSON.stringify(props.providers.map(p => [p.id, p.enabled, props.runtimeStatuses[p.id]?.open])));
watch(connectionState, () => { if (!busy.value) void refresh(); }, { immediate: true });
function name(id: string) { return id === "local" ? tr("Monica 本地库") : props.providers.find(p => p.id === id)?.name || tr("密码源不可用"); }
function locked(move: Mdbx2PendingMove) {
  return [...new Set([...move.sourceProviderIds, move.targetProviderId])].filter(id => id !== "local").filter(id => {
    const provider = props.providers.find(p => p.id === id), runtime = props.runtimeStatuses[id];
    return !provider?.enabled || !runtime?.open || !runtime.available;
  });
}
function unlock(move: Mdbx2PendingMove) {
  const provider = props.providers.find(p => p.id === locked(move)[0]);
  if (provider) emit("unlock", provider);
}
async function refresh() {
  const token = ++loadToken; loading.value = true;
  try {
    const result = await vaultClient.listMdbx2PendingMoves();
    if (!disposed && token === loadToken) { moves.value = result; if (!busy.value) error.value = ""; }
  } catch (cause) { if (!disposed && token === loadToken) error.value = cause instanceof Error ? tr(cause.message) : tr("无法读取未完成的移动。"); }
  finally { if (!disposed && token === loadToken) loading.value = false; }
}
async function focusOperation(operationId: string, selector: string) {
  await nextTick();
  const row = [...(root.value?.querySelectorAll<HTMLElement>("[data-move-operation]") || [])]
    .find(element => element.dataset.moveOperation === operationId);
  row?.querySelector<HTMLElement>(selector)?.focus();
}
function select(move: Mdbx2PendingMove) {
  selected.value = move.operationId; confirmed.value = false; error.value = ""; notice.value = "";
  void focusOperation(move.operationId, "m3e-checkbox");
}
function cancel(move: Mdbx2PendingMove) {
  if (busy.value) return;
  selected.value = undefined; confirmed.value = false;
  void focusOperation(move.operationId, "[data-move-open]");
}
async function resume(move: Mdbx2PendingMove) {
  if (busy.value || !confirmed.value || !move.request || locked(move).length) return;
  busy.value = true; error.value = ""; notice.value = "";
  try {
    const result = await vaultClient.executeMdbx2BatchTransfer(move.request, true);
    if (disposed) return;
    const failures = result.items.filter(item => item.status !== "completed");
    if (failures.length) error.value = failures.map(item => `${item.title}: ${tr(item.error || "操作失败")}`).join("\n");
    else { selected.value = undefined; confirmed.value = false; notice.value = tr("移动已恢复。"); }
    emit("completed");
    await refresh();
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? tr(cause.message) : tr("操作失败"); }
  finally {
    if (!disposed) {
      busy.value = false;
      await nextTick();
      if (notice.value) root.value?.querySelector<HTMLElement>("[data-move-refresh]")?.focus();
    }
  }
}
</script>

<template>
  <section v-if="moves.length || error || notice" ref="root" class="pending-moves" aria-labelledby="pending-moves-title" :aria-busy="busy || loading">
    <header><h2 id="pending-moves-title"><m3e-icon name="restore" />{{ tr('未完成的移动') }}</h2>
      <m3e-icon-button data-move-refresh :aria-label="tr('刷新')" :disabled="busy || loading" @click="refresh"><m3e-icon name="refresh" /></m3e-icon-button></header>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="notice || busy" role="status">{{ busy ? tr('正在核对并继续移动…') : notice }}</p>
    <article v-for="move in moves" :key="move.operationId" class="pending-operation" :data-move-operation="move.operationId">
      <div class="joined">
        <div class="pending-row"><m3e-icon name="drive_file_move" /><div><strong>{{ move.sourceProviderIds.map(name).join('、') }} → {{ name(move.targetProviderId) }}</strong>
          <small>{{ tr('{0} 个项目 · {1} 个附件', { 0: move.itemCount, 1: move.attachmentCount }) }}</small></div></div>
        <div class="pending-row"><m3e-icon :name="locked(move).length ? 'lock' : 'pending_actions'" /><div>
          <span>{{ locked(move).length ? tr('请先解锁来源和目标密码库。') : tr('继续时会核对目标内容与附件。') }}</span>
          <small><time :datetime="move.createdAt">{{ new Date(move.createdAt).toLocaleString(locale) }}</time></small></div></div>
      </div>
      <p v-if="!move.request" class="supporting">{{ tr('恢复记录不完整，请保留现有密码库并重新检查。') }}</p>
      <m3e-button v-if="locked(move).length" variant="tonal" :disabled="busy || !providers.some(p => p.id === locked(move)[0])" @click="unlock(move)"><m3e-icon slot="icon" name="lock_open" />{{ tr('解锁并设置') }}</m3e-button>
      <m3e-button v-else-if="selected !== move.operationId" data-move-open variant="tonal" :disabled="busy || !move.request" @click="select(move)"><m3e-icon slot="icon" name="arrow_forward" />{{ tr('查看并继续') }}</m3e-button>
      <div v-if="selected === move.operationId" class="pending-confirm" @keydown.esc.stop.prevent="cancel(move)">
        <ul class="joined"><li v-for="(title, index) in move.titles" :key="index" class="pending-row"><m3e-icon name="key" /><span>{{ title || tr('未命名项目') }}</span></li></ul>
        <label v-choice-label class="pending-check"><m3e-checkbox :checked="confirmed" :disabled="busy" @change="confirmed = ($event.target as HTMLElement & { checked: boolean }).checked" /><span>{{ tr('确认继续这次移动') }}</span></label>
        <div class="pending-actions"><m3e-button variant="filled" :disabled="busy || !confirmed || !move.request || Boolean(locked(move).length)" @click="resume(move)"><m3e-icon slot="icon" name="restore" />{{ tr('核对并继续') }}</m3e-button>
          <m3e-button variant="text" :disabled="busy" @click="cancel(move)">{{ tr('稍后处理') }}</m3e-button></div>
      </div>
    </article>
  </section>
</template>

<style scoped>
.pending-moves { display: grid; gap: 20px; min-width: 0; margin: 8px 12px 24px; }
header, h2 { display: flex; align-items: center; gap: 12px; margin: 0; }
header { justify-content: space-between; }
h2 { font-size: 1.2rem; }
.pending-operation, .pending-confirm { display: grid; gap: 16px; min-width: 0; }
.pending-operation + .pending-operation { margin-top: 8px; }
.joined { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; min-width: 0; }
.pending-row { display: flex; align-items: center; gap: 16px; padding: 16px; min-height: 64px; box-sizing: border-box; border-radius: 4px; background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.pending-row:first-child { border-start-start-radius: 24px; border-start-end-radius: 24px; }
.pending-row:last-child { border-end-start-radius: 24px; border-end-end-radius: 24px; }
.pending-row > div { display: grid; gap: 4px; min-width: 0; }
.pending-row m3e-icon { color: var(--md-sys-color-primary, var(--app-primary)); flex: 0 0 auto; }
.pending-row span, .pending-row strong, small, p { overflow-wrap: anywhere; }
small { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.pending-check { display: flex; align-items: center; gap: 12px; padding: 8px 4px; }
.pending-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.form-error { white-space: pre-wrap; }
@media (max-width: 600px) { .pending-actions { display: grid; } .pending-operation > m3e-button, .pending-actions m3e-button { width: 100%; } }
</style>
