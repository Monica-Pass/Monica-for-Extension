<script setup lang="ts">
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { locale, tr } from '../i18n';

import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { ProviderAccount, VaultItem } from "../core/model";
import { itemIcon, itemKindLabel, itemSafeSummary, itemSearchText } from "../manager/item-metadata";
import { presentMdbx2Collections, type Mdbx2CollectionPresentation } from "../providers/mdbx2/mdbx2-collections";
import type { Mdbx2CollectionSummary, Mdbx2VaultRuntimeStatus } from "../providers/mdbx2/native-contract";
import { vaultClient } from "../runtime/client";
import type {
  Mdbx2BatchTransferExecuteResult,
  Mdbx2BatchTransferPlanResult,
  Mdbx2BatchTransferRequest,
  Mdbx2BatchTransferStatus
} from "../runtime/messages";

const MAX_SELECTION = 200;

const props = defineProps<{
  items: VaultItem[];
  providers: ProviderAccount[];
  runtimeStatuses: Record<string, Mdbx2VaultRuntimeStatus>;
  initialTargetProviderId?: string;
  initialSelectedIds?: string[];
  scopeItemIds?: string[];
  scopeLabel?: string;
}>();

const emit = defineEmits<{
  close: [];
  completed: [result: Mdbx2BatchTransferExecuteResult];
  notice: [message: string];
}>();

const selectedIds = ref(new Set((props.initialSelectedIds || []).filter(id => props.items.some(item => item.id === id && !item.deletedAt && (!props.scopeItemIds || props.scopeItemIds.includes(id)))).slice(0, MAX_SELECTION)));
const query = ref("");
const targetProviderId = ref("");
const targetCollectionId = ref("");
const preserveCategories = ref(true);
const action = ref<Mdbx2BatchTransferRequest["action"]>("copy");
const collections = ref<Mdbx2CollectionSummary[]>([]);
const localFolders = ref<Array<{ key: string; categoryName: string }>>([]);
const remoteReady = ref(false);
type PendingTransfer = { request: Mdbx2BatchTransferRequest; plan: Mdbx2BatchTransferPlanResult; canKeepBoth?: boolean; keptBoth?: boolean };
const pendingTransfers = ref<PendingTransfer[]>([]);
const keepBothOperation = ref('');
const keepBothConfirmed = ref(false);
const collectionsLoading = ref(false);
const collectionsError = ref("");
const selectionNotice = ref("");
const planning = ref(false);
const executing = ref(false);
const error = ref("");
const planResult = ref<Mdbx2BatchTransferPlanResult | null>(null);
const executeResult = ref<Mdbx2BatchTransferExecuteResult | null>(null);
const preparedRequest = ref<Mdbx2BatchTransferRequest | null>(null);
const moveConfirmed = ref(false);
const progress = ref<Mdbx2BatchTransferStatus | null>(null);

let collectionRequestToken = 0;
let progressTimer: ReturnType<typeof setTimeout> | undefined;

const targetProviders = computed(() => props.providers.filter((provider) => ['local', 'mdbx2', 'keepass', 'bitwarden'].includes(provider.kind) && provider.enabled));
const targetProvider = computed(() => targetProviders.value.find((provider) => provider.id === targetProviderId.value));
const targetRuntime = computed(() => targetProviderId.value ? props.runtimeStatuses[targetProviderId.value] : undefined);
const targetReady = computed(() => targetProvider.value?.kind === 'local' || (['keepass', 'bitwarden'].includes(targetProvider.value?.kind || '') ? remoteReady.value : Boolean(targetRuntime.value?.open && targetRuntime.value.available)));
const activeItems = computed(() => {
  const scope = props.scopeItemIds ? new Set(props.scopeItemIds) : undefined;
  return props.items.filter(item => !item.deletedAt && (!scope || scope.has(item.id)));
});
const filteredItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return activeItems.value
    .filter((item) => !needle || itemSearchText(item).toLocaleLowerCase().includes(needle))
    .sort((left, right) => left.title.localeCompare(right.title, locale.value, { sensitivity: "base" }) || left.id.localeCompare(right.id));
});
const selectedCount = computed(() => selectedIds.value.size);
const selectedSignature = computed(() => [...selectedIds.value].sort().join("\u001f"));
const allFilteredSelected = computed(() => filteredItems.value.length > 0 && filteredItems.value.every((item) => selectedIds.value.has(item.id)));
const collectionRows = computed<Mdbx2CollectionPresentation[]>(() => presentMdbx2Collections(collections.value, collections.value));
const hasPlan = computed(() => Boolean(planResult.value && preparedRequest.value));
const planCanExecute = computed(() => Boolean(
  planResult.value
  && !keepBothOperation.value
  && preparedRequest.value
  && planResult.value.transferableCount > 0
  && (!planResult.value.requiresMoveConfirmation || moveConfirmed.value)
));
const retryableCount = computed(() => executeResult.value?.items.filter((item) => item.status === "failed" && item.retryable).length || 0);
const progressPercent = computed(() => {
  const current = progress.value;
  if (!current || current.total <= 0) return 0;
  return Math.min(100, Math.round((current.processed / current.total) * 100));
});

watch(
  [selectedSignature, targetProviderId, targetCollectionId, preserveCategories, action],
  () => {
    if (planning.value || executing.value) return;
    planResult.value = null;
    executeResult.value = null;
    preparedRequest.value = null;
    progress.value = null;
    moveConfirmed.value = false;
    keepBothOperation.value = ''; keepBothConfirmed.value = false;
    error.value = "";
  }
);

watch(targetProviderId, () => {
  targetCollectionId.value = "";
  void loadCollections();
});

watch(() => props.initialTargetProviderId, (value) => {
  if (value && targetProviders.value.some((provider) => provider.id === value)) targetProviderId.value = value;
}, { immediate: true });

watch(targetProviders, (providers) => {
  if (!providers.some((provider) => provider.id === targetProviderId.value)) {
    targetProviderId.value = providers.find((provider) => readyFor(provider.id))?.id || providers[0]?.id || "";
  }
}, { immediate: true });

watch(activeItems, items => {
  if (executing.value) return;
  const available = new Set(items.map(item => item.id));
  selectedIds.value = new Set([...selectedIds.value].filter(id => available.has(id)));
});

onBeforeUnmount(() => stopProgressPolling());

function readyFor(providerId: string): boolean {
  if (['local', 'keepass', 'bitwarden'].includes(targetProviders.value.find(provider => provider.id === providerId)?.kind || '')) return true;
  const status = props.runtimeStatuses[providerId];
  return Boolean(status?.open && status.available);
}

function sourceProviderLabel(item: VaultItem): string {
  const references = item.providerRefs.filter((reference) => reference.providerId !== "local");
  if (!references.length) return tr('Monica 本地库');
  const names = references.map((reference) => props.providers.find((provider) => provider.id === reference.providerId)?.name || tr('未知密码源'));
  return names.length > 1 ? tr('多个密码源（{0}）', { 0: names.join("、") }) : names[0];
}

function safeSummary(item: VaultItem): string {
  try {
    return itemSafeSummary(item);
  } catch {
    return tr('仅显示安全摘要');
  }
}

function toggleItem(itemId: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(itemId)) next.delete(itemId);
  else if (next.size < MAX_SELECTION) next.add(itemId);
  else selectionNotice.value = tr('一次最多选择 {0} 个项目。', { 0: MAX_SELECTION });
  selectedIds.value = next;
  if (next.size < MAX_SELECTION) selectionNotice.value = "";
}

function toggleFiltered(): void {
  const next = new Set(selectedIds.value);
  if (allFilteredSelected.value) {
    filteredItems.value.forEach((item) => next.delete(item.id));
  } else {
    for (const item of filteredItems.value) {
      if (next.size >= MAX_SELECTION) break;
      next.add(item.id);
    }
    if (next.size >= MAX_SELECTION && filteredItems.value.some((item) => !selectedIds.value.has(item.id))) {
      selectionNotice.value = tr('已选择 {0} 个项目；其余项目未加入。', { 0: MAX_SELECTION });
    }
  }
  selectedIds.value = next;
}

function clearSelection(): void {
  selectedIds.value = new Set();
  selectionNotice.value = "";
}

async function loadCollections(): Promise<void> {
  const providerId = targetProviderId.value;
  const token = ++collectionRequestToken;
  collections.value = [];
  localFolders.value = [];
  remoteReady.value = false;
  pendingTransfers.value = [];
  collectionsError.value = "";
  if (!providerId || !readyFor(providerId)) return;
  collectionsLoading.value = true;
  try {
    if (targetProvider.value?.kind === 'keepass' || targetProvider.value?.kind === 'bitwarden') {
      const bitwarden = targetProvider.value.kind === 'bitwarden';
      const pending = await (bitwarden ? vaultClient.pendingBitwardenTransfers(providerId) : vaultClient.pendingKeePassTransfers(providerId));
      if (token !== collectionRequestToken) return;
      pendingTransfers.value = pending;
      const folders: Array<{ key: string; categoryName: string }> = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let n = 0; n < 100; n++) {
        const page = bitwarden
          ? await vaultClient.listBitwardenFolders(providerId, { pageSize: 100, cursor }).then(page => ({ ...page, items: page.items.map(row => ({ inRecycleBin: !row.readable, groupId: row.folderId, displayPath: row.name })) }))
          : await vaultClient.listKeePassGroups(providerId, { includeRecycleBin: false, pageSize: 100, cursor });
        if (token !== collectionRequestToken) return;
        folders.push(...page.items.filter(row => !row.inRecycleBin).map(row => ({ key: row.groupId, categoryName: row.displayPath })));
        cursor = page.nextCursor;
        if (!cursor) break;
        if (seen.has(cursor) || n === 99) throw new Error(tr('文件夹分页未完成，请减少目录数量后重试。'));
        seen.add(cursor);
      }
      localFolders.value = folders; remoteReady.value = true;
      return;
    }
    if (targetProvider.value?.kind === 'local') {
      const folders = await vaultClient.localTransferFolders();
      if (token === collectionRequestToken) localFolders.value = folders;
      return;
    }
    const loaded: Mdbx2CollectionSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = await vaultClient.listMdbx2Collections(providerId, { deleted: false, excludeRoot: true, pageSize: 200, cursor });
      if (token !== collectionRequestToken) return;
      loaded.push(...page.items);
      if (!page.nextCursor) break;
      if (!page.items.length || seenCursors.has(page.nextCursor)) throw new Error(tr('MDBX2 文件夹分页游标没有前进。'));
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    collections.value = [...new Map(loaded.map((item) => [item.collectionId, item])).values()];
  } catch (cause) {
    if (token === collectionRequestToken) collectionsError.value = errorMessage(cause);
  } finally {
    if (token === collectionRequestToken) collectionsLoading.value = false;
  }
}

function pendingForTarget() {
  return targetProvider.value?.kind === 'bitwarden' ? vaultClient.pendingBitwardenTransfers(targetProviderId.value) : vaultClient.pendingKeePassTransfers(targetProviderId.value);
}

async function resumeTransfer(row: PendingTransfer) {
  if (planning.value || executing.value) return;
  planning.value = true;
  selectedIds.value = new Set(row.request.itemIds);
  action.value = row.plan.action; preserveCategories.value = row.request.preserveCategories;
  targetCollectionId.value = row.request.targetCollectionId || '';
  preparedRequest.value = row.request; planResult.value = row.plan; moveConfirmed.value = true;
  await nextTick(); planning.value = false;
  await executePlan();
}

function showKeepBoth(row: PendingTransfer) {
  keepBothOperation.value = row.request.operationId || '';
  keepBothConfirmed.value = false;
}

async function keepBothTransfer(row: PendingTransfer) {
  if (planning.value || executing.value || !row.request.operationId || !keepBothConfirmed.value || !row.canKeepBoth) return;
  planning.value = true; error.value = '';
  let saved: PendingTransfer | undefined;
  try {
    saved = await vaultClient.keepBothBitwardenTransfer(row.request.targetProviderId, row.request.operationId, true);
  } catch (cause) { error.value = errorMessage(cause); }
  finally {
    // A reply may be lost after the decision was saved. Discard the displayed
    // move plan and reload the durable summary before offering another action.
    planResult.value = null; preparedRequest.value = null; progress.value = null;
    pendingTransfers.value = await pendingForTarget().catch(() => pendingTransfers.value);
    keepBothOperation.value = ''; keepBothConfirmed.value = false; planning.value = false;
  }
  if (saved && targetReady.value) await resumeTransfer(saved);
}

async function cancelTransfer(row: { request: Mdbx2BatchTransferRequest }) {
  if (planning.value || executing.value || !row.request.operationId) return;
  planning.value = true; error.value = '';
  try {
    if (targetProvider.value?.kind === 'bitwarden') await vaultClient.cancelUnwrittenBitwardenTransfer(row.request.targetProviderId, row.request.operationId);
    else await vaultClient.cancelUnwrittenKeePassTransfer(row.request.targetProviderId, row.request.operationId);
    pendingTransfers.value = await pendingForTarget();
    planResult.value = null; preparedRequest.value = null; progress.value = null;
  } catch (cause) { error.value = errorMessage(cause); }
  finally { planning.value = false; }
}

async function createPlan(): Promise<void> {
  if (!selectedCount.value) {
    error.value = tr('请至少选择一个项目。');
    return;
  }
  if (!targetProviderId.value || !targetReady.value) {
    error.value = tr('请先选择可用的目标密码库。');
    return;
  }
  planning.value = true;
  const input: Mdbx2BatchTransferRequest = { itemIds: [...selectedIds.value], targetProviderId: targetProviderId.value,
    targetCollectionId: targetCollectionId.value || undefined, preserveCategories: preserveCategories.value, action: action.value };
  const signature = () => JSON.stringify([selectedSignature.value, targetProviderId.value, targetCollectionId.value, preserveCategories.value, action.value]);
  const selection = signature();
  error.value = "";
  executeResult.value = null;
  moveConfirmed.value = false;
  try {
    const result = await vaultClient.planMdbx2BatchTransfer(input);
    if (selection !== signature()) return;
    planResult.value = result;
    preparedRequest.value = {
      ...input,
      operationId: result.operationId,
      operationCreatedAt: result.operationCreatedAt
    };
    progress.value = null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    planning.value = false;
  }
}

async function executePlan(): Promise<void> {
  const plan = planResult.value;
  const input = preparedRequest.value;
  if (!plan || !input || !planCanExecute.value || executing.value) return;
  executing.value = true;
  error.value = "";
  executeResult.value = null;
  progress.value = {
    operationId: plan.operationId,
    phase: "preparing",
    processed: 0,
    total: plan.items.length,
    completedCount: 0,
    blockedCount: plan.blockedCount,
    failedCount: 0,
    finished: false,
    updatedAt: new Date().toISOString()
  };
  startProgressPolling(plan.operationId);
  try {
    const result = await vaultClient.executeMdbx2BatchTransfer(input, plan.requiresMoveConfirmation);
    executeResult.value = result;
    progress.value = {
      operationId: result.operationId,
      phase: "completed",
      processed: result.items.length,
      total: result.items.length,
      completedCount: result.completedCount,
      blockedCount: result.blockedCount,
      failedCount: result.failedCount,
      finished: true,
      updatedAt: new Date().toISOString()
    };
    emit("completed", result);
    emit("notice", result.failedCount ? tr('批量传输完成：{0} 个成功，{1} 个失败。', { 0: result.completedCount, 1: result.failedCount }) : tr('批量传输完成：{0} 个项目。', { 0: result.completedCount }));
  } catch (cause) {
    error.value = errorMessage(cause);
    const status = await vaultClient.mdbx2BatchTransferStatus(plan.operationId).catch(() => undefined);
    if (status) progress.value = status;
  } finally {
    stopProgressPolling();
    if (['keepass', 'bitwarden'].includes(targetProvider.value?.kind || '')) pendingTransfers.value = await pendingForTarget().catch(() => pendingTransfers.value);
    executing.value = false;
  }
}

async function retryFailed(): Promise<void> {
  if (!executeResult.value || retryableCount.value === 0 || !planResult.value || executing.value) return;
  // Replay the complete deterministic operation. Already committed objects are
  // resolved by the provider, so completed rows are not duplicated.
  await executePlan();
}

function startProgressPolling(operationId: string): void {
  stopProgressPolling();
  const poll = async () => {
    if (!executing.value) return;
    const status = await vaultClient.mdbx2BatchTransferStatus(operationId).catch(() => undefined);
    if (status) progress.value = status;
    if (executing.value) progressTimer = setTimeout(() => void poll(), 300);
  };
  progressTimer = setTimeout(() => void poll(), 120);
}

function stopProgressPolling(): void {
  if (progressTimer !== undefined) clearTimeout(progressTimer);
  progressTimer = undefined;
}

function closeDialog(): void {
  if (executing.value) return;
  emit("close");
}

function folderLabel(row: Mdbx2CollectionPresentation): string {
  return row.path || row.item.title;
}

function pathLabel(path: string[]): string {
  return path.length ? path.join(" / ") : tr('根目录（未分类）');
}

function phaseLabel(phase: Mdbx2BatchTransferStatus["phase"]): string {
  return ({ preparing: tr('准备数据'), writing: tr('保存到目标密码库'), attachments: tr('传输附件'), finalizing: tr('更新本地索引'), completed: tr('已完成'), failed: tr('需要重试') } as const)[phase];
}

function resultIcon(status: "completed" | "blocked" | "failed"): string {
  return status === "completed" ? "check_circle" : status === "blocked" ? "block" : "error";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : tr('批量传输失败，请重试。');
}
</script>

<template>
  <div class="modal-backdrop mdbx2-batch-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section class="editor-dialog mdbx2-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="mdbx2-batch-title">
      <header class="mdbx2-batch-header">
        <div>
          <span class="dialog-eyebrow"><m3e-icon name="database"></m3e-icon>{{ scopeLabel ? `${scopeLabel} · ` : '' }}{{ tr('批量传输') }}</span>
          <h2 id="mdbx2-batch-title">{{ tr('复制或移动项目') }}</h2>

        </div>
        <m3e-icon-button data-dialog-close :aria-label="tr('关闭批量传输')" :disabled="executing" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <div class="mdbx2-batch-scroll">
        <div class="mdbx2-batch-body">
        <section class="batch-panel batch-selection-panel" aria-labelledby="batch-selection-title">
          <div class="batch-panel-heading">
            <div><h3 id="batch-selection-title">{{ tr('选择项目') }}</h3><p>{{ tr('{0} / {1} 已选择', { 0: selectedCount, 1: MAX_SELECTION }) }}</p></div>
            <m3e-button variant="text" type="button" :disabled="!selectedCount || planning || executing" @click="clearSelection">{{ tr('清除') }}</m3e-button>
          </div>
          <m3e-form-field v-field-label variant="filled" hide-required-marker class="batch-search"><m3e-icon slot="prefix" name="search"></m3e-icon><label slot="label">{{ tr('筛选项目') }}</label><input v-model="query" autofocus type="search" :placeholder="tr('按名称、类型或密码源筛选')" /></m3e-form-field>
          <div class="batch-selection-toolbar">
            <label v-choice-label class="batch-check batch-check-all"><m3e-checkbox  :checked="allFilteredSelected" :disabled="!filteredItems.length || planning || executing" @change="toggleFiltered" /><span>{{ allFilteredSelected ? tr('取消选择当前结果') : tr('选择当前结果') }}</span></label>
            <span class="batch-result-count">{{ tr('{0} 个结果', { 0: filteredItems.length }) }}</span>
          </div>
          <p v-if="selectionNotice" class="batch-inline-note" role="status">{{ selectionNotice }}</p>
          <div v-if="filteredItems.length" class="batch-item-list" role="list" :aria-label="tr('可传输项目')">
            <label v-choice-label v-for="item in filteredItems" :key="item.id" class="batch-item-row" :class="{ selected: selectedIds.has(item.id) }" role="listitem">
              <m3e-checkbox  :checked="selectedIds.has(item.id)" :disabled="executing || (!selectedIds.has(item.id) && selectedCount >= MAX_SELECTION)" @change="toggleItem(item.id)" />
              <span class="batch-item-icon"><m3e-icon :name="item.favorite ? 'star' : itemIcon(item.kind)"></m3e-icon></span>
              <span class="batch-item-copy"><strong>{{ item.title || tr('未命名项目') }}</strong><small>{{ itemKindLabel(item.kind) }} · {{ sourceProviderLabel(item) }}</small><small class="batch-safe-summary">{{ safeSummary(item) }}</small></span>
            </label>
          </div>
          <div v-else class="batch-empty"><m3e-icon name="search_off"></m3e-icon><p>{{ query ? tr('没有匹配的项目。') : tr('密码库中没有可传输项目。') }}</p></div>
        </section>

        <section class="batch-panel batch-target-panel" aria-labelledby="batch-target-title">
          <div class="batch-panel-heading"><div><h3 id="batch-target-title">{{ tr('传输到') }}</h3></div></div>
          <m3e-form-field v-field-label variant="filled" hide-required-marker class="batch-field"><label slot="label">{{ tr('目标密码源') }}</label><component :is="materialSelectTag" @input="targetProviderId = ($event.target as HTMLElement &amp; { value: string }).value"  :disabled="planning || executing"><component :is="materialOptionTag" :selected.prop="String(targetProviderId ?? '') === String('')" value="" disabled>{{ tr('选择目标密码库') }}</component><component :is="materialOptionTag" :selected.prop="String(targetProviderId ?? '') === String(provider.id)" v-for="provider in targetProviders" :key="provider.id" :value="provider.id">{{ provider.name }}{{ readyFor(provider.id) ? '' : tr('（已锁定）') }}</component></component></m3e-form-field>
          <p v-if="targetProvider && !targetReady" class="batch-warning" role="status"><m3e-icon name="lock"></m3e-icon><span>{{ tr('请先在密码源页面解锁 {0}。', { 0: targetProvider.name }) }}</span></p>

          <div v-if="pendingTransfers.length" class="batch-pending-keepass" aria-live="polite">
            <div v-for="pending in pendingTransfers" :key="pending.request.operationId" class="batch-panel">
              <strong>{{ tr('未完成的传输') }}</strong>
              <p>{{ pending.plan.items.map(row => row.title).join('、') }}</p>
              <p v-if="pending.keptBoth" class="batch-inline-note">{{ tr('已选择保留来源；继续完成预览版本的复制。') }}</p>
              <div v-if="keepBothOperation !== pending.request.operationId" class="batch-recovery-actions">
                <m3e-button variant="tonal" :disabled="planning || executing || !targetReady" @click="resumeTransfer(pending)"><m3e-icon slot="icon" name="refresh" />{{ pending.keptBoth ? tr('继续复制') : tr('恢复传输') }}</m3e-button>
                <m3e-button v-if="pending.canKeepBoth && keepBothOperation !== pending.request.operationId" variant="text" :disabled="planning || executing" @click="showKeepBoth(pending)">{{ tr('保留两端，完成复制') }}</m3e-button>
                <m3e-button variant="text" :disabled="planning || executing" @click="cancelTransfer(pending)">{{ tr('取消未写入操作') }}</m3e-button>
              </div>
              <div v-if="pending.canKeepBoth && keepBothOperation === pending.request.operationId" class="batch-keep-both-confirm">
                <p>{{ tr('目标继续使用预览时的版本，保留来源当前内容；不会恢复你已删除的来源项目。确认后会先保存这个决定，再继续复制。') }}</p>
                <label v-choice-label class="batch-check"><m3e-checkbox :checked.prop="keepBothConfirmed" :disabled="planning || executing" @input="keepBothConfirmed = ($event.target as HTMLElement &amp; { checked: boolean }).checked" /><span>{{ tr('我确认保留来源并按复制完成') }}</span></label>
                <div class="batch-recovery-actions">
                  <m3e-button variant="filled" :disabled="!keepBothConfirmed || planning || executing" @click="keepBothTransfer(pending)">{{ tr('确认保留并继续') }}</m3e-button>
                  <m3e-button variant="text" :disabled="planning || executing" @click="keepBothOperation = ''; keepBothConfirmed = false">{{ tr('取消') }}</m3e-button>
                </div>
              </div>
            </div>
          </div>

          <fieldset class="batch-action-picker"><legend>{{ tr('操作') }}</legend><m3e-radio-group class="batch-action-segments" :aria-label="tr('操作')"><label v-choice-label><m3e-radio :checked.prop="action === 'copy'" @input="action = 'copy'"   value="copy" :disabled="planning || executing" /><span><m3e-icon name="content_copy"></m3e-icon><strong>{{ tr('复制') }}</strong><small>{{ tr('创建独立项目') }}</small></span></label><label v-choice-label><m3e-radio :checked.prop="action === 'move'" @input="action = 'move'"   value="move" :disabled="planning || executing" /><span><m3e-icon name="drive_file_move"></m3e-icon><strong>{{ tr('移动') }}</strong><small>{{ targetProvider?.kind === 'keepass' ? tr('在同一数据库中移动') : tr('完成后移除来源绑定') }}</small></span></label></m3e-radio-group></fieldset>

          <p v-if="targetProvider?.kind === 'bitwarden'" class="batch-inline-note">{{ tr('本地、MDBX 及 KeePass 项目可移入 Bitwarden；其他来源请使用复制。目标和附件完整校验后才会移除来源，中断后可恢复。') }}</p>

          <div class="batch-folder-section">
            <div class="batch-subheading"><div><strong>{{ tr('目标文件夹') }}</strong></div><m3e-button variant="text" type="button" :disabled="collectionsLoading || planning || executing || !targetReady" @click="loadCollections"><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ tr('刷新') }}</m3e-button></div>
            <div v-if="collectionsLoading" class="batch-folder-state" role="status"><m3e-icon name="progress_activity"></m3e-icon><span>{{ tr('正在读取文件夹…') }}</span></div>
            <p v-else-if="collectionsError" class="batch-error" role="alert">{{ collectionsError }}</p>
            <m3e-radio-group v-else class="batch-folder-tree" :aria-label="tr('目标文件夹')">
              <label v-choice-label class="batch-folder-row" :class="{ selected: !targetCollectionId }"><m3e-radio :checked.prop="targetCollectionId === ''" @input="targetCollectionId = ''"   value="" :disabled="planning || executing" /><span class="batch-folder-icon"><m3e-icon name="folder_open"></m3e-icon></span><span><strong>{{ tr('根目录') }}</strong><small>{{ tr('未分类项目') }}</small></span></label>
              <label v-choice-label v-for="row in collectionRows" :key="row.item.collectionId" class="batch-folder-row" :class="{ selected: targetCollectionId === row.item.collectionId, incomplete: row.hierarchyState !== 'ready' }" :style="{ '--folder-depth': row.depth }"><m3e-radio :checked.prop="targetCollectionId === row.item.collectionId" @input="targetCollectionId = row.item.collectionId"   :value="row.item.collectionId" :disabled="planning || executing" /><span class="batch-folder-icon"><m3e-icon name="folder"></m3e-icon></span><span><strong>{{ folderLabel(row) }}</strong><small>{{ row.hierarchyState === 'ready' ? tr('{0} 个附件', { 0: row.item.attachmentCount }) : row.parentPath }}</small></span></label>
              <label v-choice-label v-for="folder in localFolders" :key="folder.key" class="batch-folder-row" :class="{ selected: targetCollectionId === folder.key }"><m3e-radio :checked.prop="targetCollectionId === folder.key" @input="targetCollectionId = folder.key" :value="folder.key" :disabled="planning || executing" /><span class="batch-folder-icon"><m3e-icon name="folder"></m3e-icon></span><span><strong>{{ folder.categoryName || tr('未命名文件夹') }}</strong><small>{{ targetProvider?.kind !== 'local' ? targetProvider?.name : tr('Monica 本地库') }}</small></span></label>
              <p v-if="!collectionRows.length && !localFolders.length && targetReady" class="batch-folder-state"><m3e-icon name="folder_off"></m3e-icon><span>{{ tr('还没有自定义文件夹；项目会写入根目录。') }}</span></p>
            </m3e-radio-group>
          </div>

          <label v-choice-label class="batch-check batch-preserve"><m3e-checkbox :checked.prop="preserveCategories" @input="preserveCategories = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   :disabled="planning || executing" /><span><strong>{{ tr('保留原分类层级') }}</strong></span></label>
          <p v-if="action === 'move' && targetProvider?.kind !== 'keepass'" class="batch-warning"><m3e-icon name="warning"></m3e-icon><span>{{ tr('移动只会在目标项目与附件验证成功后删除来源；失败时来源保留。') }}</span></p>
        </section>
        </div>

        <section v-if="planResult" class="batch-panel batch-plan-panel" aria-labelledby="batch-plan-title">
        <div class="batch-panel-heading"><div><h3 id="batch-plan-title">{{ tr('传输预览') }}</h3><p>{{ tr('{0} 个可传输，{1} 个被阻断', { 0: planResult.transferableCount, 1: planResult.blockedCount }) }}</p></div></div>
        <div v-if="planResult.warnings.length" class="batch-warning-list" role="status"><p v-for="warning in planResult.warnings" :key="warning"><m3e-icon name="info"></m3e-icon><span>{{ warning }}</span></p></div>
        <div class="batch-plan-list" role="list" :aria-label="tr('传输计划项目')">
          <div v-for="item in planResult.items" :key="item.sourceItemId" class="batch-plan-row" :class="{ blocked: item.blockedReason }" role="listitem"><m3e-icon :name="item.blockedReason ? 'block' : item.effectiveAction === 'move' ? 'drive_file_move' : 'content_copy'"></m3e-icon><span><strong>{{ item.title }}</strong><small>{{ itemKindLabel(item.kind) }} · {{ pathLabel(item.sourcePath) }} <m3e-icon name="arrow_forward"></m3e-icon> {{ pathLabel(item.targetPath) }}</small><small v-if="!selectedIds.has(item.sourceItemId)" class="batch-dependency">{{ tr('关联项目 · 自动包含') }}</small><small v-if="item.blockedReason" class="batch-error">{{ item.blockedReason }}</small><small v-else-if="item.pathIncomplete" class="batch-inline-note">{{ tr('原分类路径不完整，已保留可解析部分。') }}</small></span></div>
        </div>
        <label v-choice-label v-if="planResult.requiresMoveConfirmation" class="batch-move-confirm"><m3e-checkbox :checked.prop="moveConfirmed" @input="moveConfirmed = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span><strong>{{ tr('我确认执行移动') }}</strong><small>{{ targetProvider?.kind === 'keepass' ? tr('在同一数据库中移动') : tr('目标写入、附件校验和来源删除会按顺序执行；已完成操作可安全重试。') }}</small></span></label>
        </section>

        <section v-if="executing || progress" class="batch-panel batch-progress-panel" aria-live="polite" aria-labelledby="batch-progress-title">
        <div class="batch-progress-heading"><div><h3 id="batch-progress-title">{{ executing ? tr('正在传输') : progress?.phase === 'failed' ? tr('传输未完成') : tr('传输结果') }}</h3><p>{{ progress ? phaseLabel(progress.phase) : tr('准备中') }} · {{ progress?.processed || 0 }} / {{ progress?.total || planResult?.items.length || 0 }}</p></div><strong>{{ progressPercent }}%</strong></div>
        <progress max="100" :value="progressPercent" :aria-label="tr('批量传输进度')"></progress>
        </section>

        <section v-if="executeResult" class="batch-panel batch-result-panel" aria-labelledby="batch-result-title">
        <div class="batch-panel-heading"><div><h3 id="batch-result-title">{{ tr('处理结果') }}</h3><p>{{ tr('{0} 个成功 · {1} 个阻断 · {2} 个失败', { 0: executeResult.completedCount, 1: executeResult.blockedCount, 2: executeResult.failedCount }) }}</p></div><m3e-icon :name="executeResult.failedCount ? 'error' : 'check_circle'" :class="executeResult.failedCount ? 'result-danger' : 'result-success'"></m3e-icon></div>
        <div class="batch-result-list" role="list" :aria-label="tr('批量传输结果')">
          <div v-for="item in executeResult.items" :key="item.sourceItemId" class="batch-result-row" :class="`result-${item.status}`" role="listitem"><m3e-icon :name="resultIcon(item.status)"></m3e-icon><span><strong>{{ item.title }}</strong><small>{{ itemKindLabel(item.kind) }} · {{ item.status === 'completed' ? tr('已写入目标') : item.error || tr('未执行') }}</small></span></div>
        </div>
        <p v-if="retryableCount" class="batch-inline-note"><m3e-icon name="info"></m3e-icon>{{ tr('重试会重放同一个确定性操作；已完成项目不会重复创建。') }}</p>
        <p v-if="executeResult.completedCount && targetProvider?.kind === 'keepass' && targetProvider.config.sourceMode === 'local-file'" class="batch-inline-note"><m3e-icon name="info"></m3e-icon>{{ tr('已保存的修改会在本机加密保留。解锁仍需数据库密码或密钥文件，完成后请导出并保存 KDBX。') }}</p>
        </section>

        <p v-if="error" class="batch-error batch-dialog-error" role="alert">{{ error }}</p>
      </div>
      <footer class="mdbx2-batch-footer">
        <m3e-button variant="text" type="button" :disabled="executing" @click="closeDialog">{{ hasPlan && !executeResult ? tr('取消') : tr('关闭') }}</m3e-button>
        <template v-if="!keepBothOperation">
        <m3e-button v-if="retryableCount" variant="tonal" type="button" :disabled="executing" @click="retryFailed"><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ tr('重试失败项目') }}</m3e-button>
        <m3e-button v-if="!hasPlan" variant="filled" type="button" :disabled="planning || executing || !selectedCount || !targetReady" @click="createPlan"><m3e-icon slot="icon" name="rule"></m3e-icon>{{ planning ? tr('检查兼容性…') : tr('检查并生成计划') }}</m3e-button>
        <m3e-button v-else variant="filled" type="button" :disabled="planning || executing || !planCanExecute" @click="executePlan"><m3e-icon slot="icon" :name="executing ? 'progress_activity' : action === 'move' ? 'drive_file_move' : 'content_copy'"></m3e-icon>{{ executing ? tr('正在提交…') : planResult?.blockedCount ? tr('跳过受限项并继续') : planResult?.requiresMoveConfirmation ? tr('确认并移动') : tr('执行复制') }}</m3e-button>
        </template>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.batch-recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.batch-pending-keepass { display: grid; gap: 8px; overflow-wrap: anywhere; }
.batch-keep-both-confirm { margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--md-sys-color-outline-variant); }
.batch-keep-both-confirm > p { margin: 0 0 8px; font-size: 13px; line-height: 1.5; }
.mdbx2-batch-backdrop {
  padding: 16px;
}

.mdbx2-batch-dialog {
  width: min(100%, 1120px);
  max-height: calc(100dvh - 32px);
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  border-radius: 28px;
  background: var(--md-sys-color-surface-container, var(--app-surface));
}

.mdbx2-batch-scroll {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
}

.mdbx2-batch-header {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin: 0;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.dialog-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--md-sys-color-primary, var(--app-primary));
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.dialog-eyebrow m3e-icon {
  --m3e-icon-size: 20px;
}

.mdbx2-batch-header h2,
.batch-panel h3 {
  margin: 0;
}

.mdbx2-batch-header p,
.batch-panel-heading p,
.batch-subheading small,
.batch-check small,
.batch-item-copy small,
.batch-folder-row small,
.batch-plan-row small,
.batch-result-row small,
.batch-move-confirm small {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  line-height: 1.45;
}

.mdbx2-batch-header p {
  max-width: 720px;
  margin: 6px 0 0;
  overflow-wrap: anywhere;
}

.mdbx2-batch-header > div {
  min-width: 0;
}

.mdbx2-batch-header > m3e-icon-button {
  inline-size: 44px;
  min-inline-size: 44px;
  max-inline-size: 44px;
  block-size: 44px;
  flex: 0 0 44px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: clip;
  --m3e-icon-button-container-height: 44px;
  --m3e-icon-button-icon-size: 20px;
  --m3e-icon-button-default-leading-space: 0px;
  --m3e-icon-button-default-trailing-space: 0px;
}

.mdbx2-batch-body {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
  gap: 12px;
  padding: 12px;
}

.batch-panel {
  min-width: 0;
  border: 0;
  border-radius: 24px;
  padding: 16px;
  background: var(--md-sys-color-surface-container-lowest, var(--app-surface));
}

.batch-panel-heading,
.batch-progress-heading,
.batch-subheading,
.batch-selection-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.batch-panel-heading p,
.batch-subheading small,
.batch-selection-toolbar,
.batch-panel-heading .operation-chip {
  margin: 4px 0 0;
  font-size: 0.82rem;
}

.batch-search {
  min-width: 0;
  margin-top: 16px;
}

.batch-search m3e-icon {
  --m3e-icon-size: 20px;
  color: var(--app-muted);
}

.batch-selection-toolbar {
  min-height: 48px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.batch-check,
.batch-item-row,
.batch-folder-row,
.batch-move-confirm {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.batch-check input,
.batch-item-row > input,
.batch-folder-row > input,
.batch-move-confirm > input {
  inline-size: 20px;
  block-size: 20px;
  flex: 0 0 20px;
  accent-color: var(--md-sys-color-primary, var(--app-primary));
}

.batch-check-all {
  font-weight: 600;
}

.batch-result-count,
.operation-chip {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  font-variant-numeric: tabular-nums;
}

.operation-chip {
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 999px;
  padding: 4px 8px;
  white-space: nowrap;
}

.batch-inline-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 0 0;
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  font-size: 0.82rem;
  line-height: 1.45;
}

.batch-inline-note m3e-icon {
  --m3e-icon-size: 18px;
  flex: 0 0 18px;
}

.batch-item-list,
.batch-folder-tree,
.batch-plan-list,
.batch-result-list {
  min-width: 0;
  max-height: 360px;
  overflow: auto;
}

.batch-item-list {
  margin-top: 8px;
}

.batch-item-row {
  min-width: 0;
  border-radius: 16px;
  padding: 12px;
}

.batch-item-row:hover,
.batch-item-row:focus-within,
.batch-item-row.selected,
.batch-folder-row:hover,
.batch-folder-row:focus-within,
.batch-folder-row.selected {
  background: var(--md-sys-color-secondary-container, var(--app-selected));
}

.batch-item-icon,
.batch-folder-icon {
  inline-size: 32px;
  block-size: 32px;
  flex: 0 0 32px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--md-sys-color-primary, var(--app-primary));
  background: var(--md-sys-color-surface-container-high, var(--app-surface-high));
}

.batch-item-icon m3e-icon,
.batch-folder-icon m3e-icon {
  --m3e-icon-size: 20px;
}

.batch-item-copy,
.batch-folder-row > span:last-child,
.batch-plan-row > span,
.batch-result-row > span {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.batch-item-copy strong,
.batch-item-copy small,
.batch-folder-row strong,
.batch-folder-row small,
.batch-plan-row strong,
.batch-plan-row small,
.batch-result-row strong,
.batch-result-row small {
  overflow-wrap: anywhere;
}

.batch-safe-summary {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
}

.batch-empty,
.batch-folder-state {
  min-height: 120px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  text-align: center;
}

.batch-empty m3e-icon,
.batch-folder-state m3e-icon {
  --m3e-icon-size: 28px;
}

.batch-field {
  margin-top: 16px;
}

.batch-check input:focus-visible,
.batch-item-row input:focus-visible,
.batch-folder-row input:focus-visible,
.batch-move-confirm input:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--app-primary) 42%, transparent);
  outline-offset: 2px;
}

.batch-warning,
.batch-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 10px 0 0;
  line-height: 1.45;
}

.batch-warning {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
}

.batch-warning m3e-icon,
.batch-error m3e-icon {
  --m3e-icon-size: 20px;
  flex: 0 0 20px;
}

.batch-error {
  color: var(--md-sys-color-error, #ba1a1a);
}

.batch-action-picker {
  min-width: 0;
  margin: 16px 0 0;
  border: 0;
  padding: 0;
}

.batch-action-picker legend {
  margin-bottom: 6px;
  font-weight: 600;
}

.batch-action-segments {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
  gap: 8px;
}

.batch-action-segments label {
  position: relative;
  min-width: 0;
  cursor: pointer;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.batch-action-segments span {
  min-width: 0;
  min-height: 48px;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-content: center;
  column-gap: 8px;
  border-radius: 8px;
  padding: 0;
  overflow-wrap: anywhere;
}

.batch-action-segments span m3e-icon {
  grid-row: 1 / span 2;
  align-self: center;
  --m3e-icon-size: 20px;
}

.batch-action-segments span small {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
  line-height: 1.3;
}

.batch-folder-section {
  min-width: 0;
  margin-top: 16px;
}

.batch-subheading {
  align-items: flex-start;
}

.batch-subheading > div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.batch-folder-tree {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
  width: 100%;
  box-sizing: border-box;
  margin-top: 8px;
  border: 0;
  border-radius: 24px;
  padding: 0;
}

.batch-folder-row {
  min-width: 0;
  padding: 6px 8px;
  padding-inline-start: calc(8px + (var(--folder-depth, 0) * 18px));
  border-radius: 8px;
}

.batch-folder-row.incomplete {
  color: var(--md-sys-color-on-surface-variant, var(--app-muted));
}

.batch-preserve {
  align-items: flex-start;
  margin-top: 16px;
  padding: 8px 0;
}

.batch-preserve > span,
.batch-move-confirm > span {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.batch-plan-panel,
.batch-progress-panel,
.batch-result-panel {
  margin: 0 12px 12px;
}

.batch-warning-list {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}

.batch-warning-list p {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  line-height: 1.45;
}

.batch-warning-list m3e-icon {
  --m3e-icon-size: 20px;
  flex: 0 0 20px;
}

.batch-plan-list,
.batch-result-list {
  margin-top: 12px;
  display: grid;
  gap: 4px;
}

.batch-plan-row,
.batch-result-row {
  min-width: 0;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  border-radius: 4px;
  background: var(--app-surface-low, var(--app-surface-high));
  padding: 12px 16px;
}

.batch-plan-row > m3e-icon,
.batch-result-row > m3e-icon {
  --m3e-icon-size: 20px;
  margin-top: 2px;
}

.batch-plan-row.blocked,
.batch-result-row.result-blocked,
.batch-result-row.result-failed {
  color: var(--md-sys-color-error, #ba1a1a);
}

.batch-plan-row small m3e-icon {
  --m3e-icon-size: 16px;
  vertical-align: text-bottom;
}

.batch-move-confirm {
  align-items: flex-start;
  margin-top: 12px;
  border: 1px solid var(--md-sys-color-error, #ba1a1a);
  border-radius: 8px;
  padding: 10px;
  color: var(--md-sys-color-error, #ba1a1a);
}

.batch-progress-heading > strong {
  color: var(--md-sys-color-primary, var(--app-primary));
  font-variant-numeric: tabular-nums;
}

.batch-progress-panel progress {
  box-sizing: border-box;
  inline-size: 100%;
  block-size: 10px;
  margin-top: 12px;
  accent-color: var(--md-sys-color-primary, var(--app-primary));
}

.batch-progress-panel progress::-webkit-progress-bar {
  border-radius: 999px;
  background: var(--md-sys-color-surface-container-high, var(--app-surface-high));
}

.batch-progress-panel progress::-webkit-progress-value {
  border-radius: 999px;
  background: var(--md-sys-color-primary, var(--app-primary));
}

.result-success {
  color: var(--md-sys-color-primary, var(--app-primary));
}

.result-danger {
  color: var(--md-sys-color-error, #ba1a1a);
}

.mdbx2-batch-footer {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  padding: 12px 24px 16px;
  background: var(--md-sys-color-surface-container, var(--app-surface));
}

.mdbx2-batch-footer m3e-button {
  min-height: 44px;
}

.batch-dialog-error {
  margin: 0 12px 12px;
}

@media (max-width: 900px) {
  .mdbx2-batch-body {
    grid-template-columns: 1fr;
  }

  .batch-item-list,
  .batch-folder-tree,
  .batch-plan-list,
  .batch-result-list {
    max-height: 280px;
  }
}

@media (max-width: 700px) {
  .mdbx2-batch-backdrop {
    align-items: center;
    padding: 8px;
  }

  .mdbx2-batch-dialog {
    width: 100%;
    max-height: calc(100dvh - 16px);
    border-radius: 16px;
  }

  .mdbx2-batch-header,
  .mdbx2-batch-body,
  .mdbx2-batch-footer {
    padding-inline: 16px;
  }

  .batch-plan-panel,
  .batch-progress-panel,
  .batch-result-panel,
  .batch-dialog-error {
    margin-inline: 16px;
  }

  .mdbx2-batch-footer {
    justify-content: stretch;
  }

  .mdbx2-batch-footer m3e-button {
    flex: 1 1 140px;
  }
}

@media (max-width: 420px) {
  .mdbx2-batch-body { padding-inline: 8px; }
  .batch-panel { padding: 12px; }
  .batch-item-row { padding: 8px; gap: 8px; }
}

@media (prefers-reduced-motion: reduce) {
  .mdbx2-batch-dialog,
  .mdbx2-batch-backdrop {
    animation: none;
  }
}
.batch-plan-row:first-child,.batch-result-row:first-child,.batch-folder-row:first-child{border-start-start-radius:24px;border-start-end-radius:24px}
.batch-plan-row:last-child,.batch-result-row:last-child,.batch-folder-row:last-of-type{border-end-start-radius:24px;border-end-end-radius:24px}
.batch-folder-row{border-radius:4px;min-height:64px;box-sizing:border-box}
.batch-folder-state{min-height:64px;font-size:.875rem;padding:12px;box-sizing:border-box}
.batch-folder-state p{margin:0}
.batch-plan-row .batch-dependency{color:var(--app-primary)}
.batch-action-segments label{border-radius:20px;background:var(--app-surface-high)}
.batch-action-segments label:has(m3e-radio[checked]){background:var(--app-selected)}
.batch-action-segments label:focus-within,.batch-folder-row:focus-within{outline:2px solid var(--app-primary);outline-offset:2px}
</style>
