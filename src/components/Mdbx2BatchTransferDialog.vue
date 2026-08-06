<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
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
}>();

const emit = defineEmits<{
  close: [];
  completed: [result: Mdbx2BatchTransferExecuteResult];
  notice: [message: string];
}>();

const selectedIds = ref(new Set<string>());
const query = ref("");
const targetProviderId = ref("");
const targetCollectionId = ref("");
const preserveCategories = ref(true);
const action = ref<Mdbx2BatchTransferRequest["action"]>("copy");
const collections = ref<Mdbx2CollectionSummary[]>([]);
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

const targetProviders = computed(() => props.providers.filter((provider) => provider.kind === "mdbx2" && provider.enabled));
const targetProvider = computed(() => targetProviders.value.find((provider) => provider.id === targetProviderId.value));
const targetRuntime = computed(() => targetProviderId.value ? props.runtimeStatuses[targetProviderId.value] : undefined);
const targetReady = computed(() => Boolean(targetRuntime.value?.open && targetRuntime.value.available));
const activeItems = computed(() => props.items.filter((item) => !item.deletedAt));
const filteredItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return activeItems.value
    .filter((item) => !needle || itemSearchText(item).toLocaleLowerCase().includes(needle))
    .sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { sensitivity: "base" }) || left.id.localeCompare(right.id));
});
const selectedCount = computed(() => selectedIds.value.size);
const selectedSignature = computed(() => [...selectedIds.value].sort().join("\u001f"));
const allFilteredSelected = computed(() => filteredItems.value.length > 0 && filteredItems.value.every((item) => selectedIds.value.has(item.id)));
const collectionRows = computed<Mdbx2CollectionPresentation[]>(() => presentMdbx2Collections(collections.value, collections.value));
const hasPlan = computed(() => Boolean(planResult.value && preparedRequest.value));
const planCanExecute = computed(() => Boolean(
  planResult.value
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
    error.value = "";
  }
);

watch(targetProviderId, () => {
  targetCollectionId.value = "";
  void loadCollections();
});

watch(() => props.initialTargetProviderId, (value) => {
  if (value && targetProviders.value.some((provider) => provider.id === value)) targetProviderId.value = value;
});

watch(targetProviders, (providers) => {
  if (!providers.some((provider) => provider.id === targetProviderId.value)) {
    targetProviderId.value = providers.find((provider) => readyFor(provider.id))?.id || providers[0]?.id || "";
  }
}, { immediate: true });

onBeforeUnmount(() => stopProgressPolling());

function readyFor(providerId: string): boolean {
  const status = props.runtimeStatuses[providerId];
  return Boolean(status?.open && status.available);
}

function sourceProviderLabel(item: VaultItem): string {
  const references = item.providerRefs.filter((reference) => reference.providerId !== "local");
  if (!references.length) return "Monica 本地库";
  const names = references.map((reference) => props.providers.find((provider) => provider.id === reference.providerId)?.name || "未知密码源");
  return names.length > 1 ? `多个密码源（${names.join("、")}）` : names[0];
}

function safeSummary(item: VaultItem): string {
  try {
    return itemSafeSummary(item);
  } catch {
    return "仅显示安全摘要";
  }
}

function toggleItem(itemId: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(itemId)) next.delete(itemId);
  else if (next.size < MAX_SELECTION) next.add(itemId);
  else selectionNotice.value = `一次最多选择 ${MAX_SELECTION} 个项目。`;
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
      selectionNotice.value = `已选择 ${MAX_SELECTION} 个项目；其余项目未加入。`;
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
  collectionsError.value = "";
  if (!providerId || !readyFor(providerId)) return;
  collectionsLoading.value = true;
  try {
    const loaded: Mdbx2CollectionSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = await vaultClient.listMdbx2Collections(providerId, { deleted: false, excludeRoot: true, pageSize: 200, cursor });
      if (token !== collectionRequestToken) return;
      loaded.push(...page.items);
      if (!page.nextCursor) break;
      if (!page.items.length || seenCursors.has(page.nextCursor)) throw new Error("MDBX2 文件夹分页游标没有前进。");
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

async function createPlan(): Promise<void> {
  if (!selectedCount.value) {
    error.value = "请至少选择一个项目。";
    return;
  }
  if (!targetProviderId.value || !targetReady.value) {
    error.value = "请先解锁一个 MDBX2 目标密码源。";
    return;
  }
  planning.value = true;
  error.value = "";
  executeResult.value = null;
  moveConfirmed.value = false;
  try {
    const result = await vaultClient.planMdbx2BatchTransfer({
      itemIds: [...selectedIds.value],
      targetProviderId: targetProviderId.value,
      targetCollectionId: targetCollectionId.value || undefined,
      preserveCategories: preserveCategories.value,
      action: action.value
    });
    planResult.value = result;
    preparedRequest.value = {
      itemIds: [...selectedIds.value],
      targetProviderId: targetProviderId.value,
      targetCollectionId: targetCollectionId.value || undefined,
      preserveCategories: preserveCategories.value,
      action: action.value,
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
    emit("notice", result.failedCount ? `批量传输完成：${result.completedCount} 个成功，${result.failedCount} 个失败。` : `批量传输完成：${result.completedCount} 个项目。`);
  } catch (cause) {
    error.value = errorMessage(cause);
    const status = await vaultClient.mdbx2BatchTransferStatus(plan.operationId).catch(() => undefined);
    if (status) progress.value = status;
  } finally {
    stopProgressPolling();
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

function invalidatePlan(): void {
  if (planning.value || executing.value) return;
  planResult.value = null;
  preparedRequest.value = null;
  executeResult.value = null;
  progress.value = null;
  moveConfirmed.value = false;
}

function closeDialog(): void {
  if (executing.value) return;
  emit("close");
}

function folderLabel(row: Mdbx2CollectionPresentation): string {
  return row.path || row.item.title;
}

function pathLabel(path: string[]): string {
  return path.length ? path.join(" / ") : "根目录（未分类）";
}

function phaseLabel(phase: Mdbx2BatchTransferStatus["phase"]): string {
  return ({ preparing: "准备数据", writing: "写入 MDBX2", attachments: "传输附件", finalizing: "更新本地索引", completed: "已完成", failed: "需要重试" } as const)[phase];
}

function resultIcon(status: "completed" | "blocked" | "failed"): string {
  return status === "completed" ? "check_circle" : status === "blocked" ? "block" : "error";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "MDBX2 批量传输失败，请重试。";
}
</script>

<template>
  <div class="modal-backdrop mdbx2-batch-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section class="editor-dialog mdbx2-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="mdbx2-batch-title">
      <header class="mdbx2-batch-header">
        <div>
          <span class="dialog-eyebrow"><m3e-icon name="database"></m3e-icon>MDBX2 批量传输</span>
          <h2 id="mdbx2-batch-title">复制或移动项目</h2>
          <p>只显示标题、类型和安全摘要。原始字段、附件字节和密码源凭据留在后台。</p>
        </div>
        <m3e-icon-button data-dialog-close aria-label="关闭批量传输" :disabled="executing" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <div class="mdbx2-batch-scroll">
        <div class="mdbx2-batch-body">
        <section class="batch-panel batch-selection-panel" aria-labelledby="batch-selection-title">
          <div class="batch-panel-heading">
            <div><h3 id="batch-selection-title">选择项目</h3><p>{{ selectedCount }} / {{ MAX_SELECTION }} 已选择</p></div>
            <m3e-button variant="text" type="button" :disabled="!selectedCount || planning || executing" @click="clearSelection">清除</m3e-button>
          </div>
          <label class="batch-search"><m3e-icon name="search"></m3e-icon><span class="visually-hidden">筛选项目</span><input v-model="query" autofocus type="search" placeholder="按名称、类型或密码源筛选" /></label>
          <div class="batch-selection-toolbar">
            <label class="batch-check batch-check-all"><input type="checkbox" :checked="allFilteredSelected" :disabled="!filteredItems.length || planning || executing" @change="toggleFiltered" /><span>{{ allFilteredSelected ? '取消选择当前结果' : '选择当前结果' }}</span></label>
            <span class="batch-result-count">{{ filteredItems.length }} 个结果</span>
          </div>
          <p v-if="selectionNotice" class="batch-inline-note" role="status">{{ selectionNotice }}</p>
          <div v-if="filteredItems.length" class="batch-item-list" role="list" aria-label="可传输项目">
            <label v-for="item in filteredItems" :key="item.id" class="batch-item-row" :class="{ selected: selectedIds.has(item.id) }" role="listitem">
              <input type="checkbox" :checked="selectedIds.has(item.id)" :disabled="executing || (!selectedIds.has(item.id) && selectedCount >= MAX_SELECTION)" @change="toggleItem(item.id)" />
              <span class="batch-item-icon"><m3e-icon :name="item.favorite ? 'star' : itemIcon(item.kind)"></m3e-icon></span>
              <span class="batch-item-copy"><strong>{{ item.title || '未命名项目' }}</strong><small>{{ itemKindLabel(item.kind) }} · {{ sourceProviderLabel(item) }}</small><small class="batch-safe-summary">{{ safeSummary(item) }}</small></span>
            </label>
          </div>
          <div v-else class="batch-empty"><m3e-icon name="search_off"></m3e-icon><p>{{ query ? '没有匹配的项目。' : '密码库中没有可传输项目。' }}</p></div>
        </section>

        <section class="batch-panel batch-target-panel" aria-labelledby="batch-target-title">
          <div class="batch-panel-heading"><div><h3 id="batch-target-title">传输到</h3><p>目标必须是已解锁的 MDBX2 本机工作副本。</p></div></div>
          <label class="batch-field"><span>目标密码源</span><select v-model="targetProviderId" :disabled="planning || executing"><option value="" disabled>选择 MDBX2 密码源</option><option v-for="provider in targetProviders" :key="provider.id" :value="provider.id">{{ provider.name }}{{ readyFor(provider.id) ? '' : '（已锁定）' }}</option></select></label>
          <p v-if="targetProvider && !targetReady" class="batch-warning" role="status"><m3e-icon name="lock"></m3e-icon><span>请先在密码源页面解锁 {{ targetProvider.name }}。</span></p>

          <fieldset class="batch-action-picker"><legend>操作</legend><div class="batch-action-segments"><label><input v-model="action" type="radio" value="copy" :disabled="planning || executing" /><span><m3e-icon name="content_copy"></m3e-icon><strong>复制</strong><small>创建独立项目</small></span></label><label><input v-model="action" type="radio" value="move" :disabled="planning || executing" /><span><m3e-icon name="drive_file_move"></m3e-icon><strong>移动</strong><small>完成后移除来源绑定</small></span></label></div></fieldset>

          <div class="batch-folder-section">
            <div class="batch-subheading"><div><strong>目标文件夹</strong><small>选择根目录或 Android 兼容的 Collection。</small></div><m3e-button variant="text" type="button" :disabled="collectionsLoading || planning || executing || !targetReady" @click="loadCollections"><m3e-icon slot="icon" name="refresh"></m3e-icon>刷新</m3e-button></div>
            <div v-if="collectionsLoading" class="batch-folder-state" role="status"><m3e-icon name="progress_activity"></m3e-icon><span>正在读取文件夹…</span></div>
            <p v-else-if="collectionsError" class="batch-error" role="alert">{{ collectionsError }}</p>
            <div v-else class="batch-folder-tree" role="radiogroup" aria-label="目标 MDBX2 文件夹">
              <label class="batch-folder-row" :class="{ selected: !targetCollectionId }"><input v-model="targetCollectionId" type="radio" value="" :disabled="planning || executing" /><span class="batch-folder-icon"><m3e-icon name="folder_open"></m3e-icon></span><span><strong>根目录</strong><small>未分类项目</small></span></label>
              <label v-for="row in collectionRows" :key="row.item.collectionId" class="batch-folder-row" :class="{ selected: targetCollectionId === row.item.collectionId, incomplete: row.hierarchyState !== 'ready' }" :style="{ '--folder-depth': row.depth }"><input v-model="targetCollectionId" type="radio" :value="row.item.collectionId" :disabled="planning || executing" /><span class="batch-folder-icon"><m3e-icon name="folder"></m3e-icon></span><span><strong>{{ folderLabel(row) }}</strong><small>{{ row.hierarchyState === 'ready' ? `${row.item.attachmentCount} 个附件` : row.parentPath }}</small></span></label>
              <p v-if="!collectionRows.length && targetReady" class="batch-folder-state"><m3e-icon name="folder_off"></m3e-icon><span>还没有自定义文件夹；项目会写入根目录。</span></p>
            </div>
          </div>

          <label class="batch-check batch-preserve"><input v-model="preserveCategories" type="checkbox" :disabled="planning || executing" /><span><strong>保留原分类层级</strong><small>按 Android 的文件夹路径创建或复用目标 Collection。</small></span></label>
          <p v-if="action === 'move'" class="batch-warning"><m3e-icon name="warning"></m3e-icon><span>移动只会在目标项目与附件验证成功后删除来源；失败时来源保留。</span></p>
        </section>
        </div>

        <section v-if="planResult" class="batch-panel batch-plan-panel" aria-labelledby="batch-plan-title">
        <div class="batch-panel-heading"><div><h3 id="batch-plan-title">兼容性计划</h3><p>{{ planResult.transferableCount }} 个可传输，{{ planResult.blockedCount }} 个被阻断</p></div><span class="operation-chip">操作 {{ planResult.operationId.slice(0, 8) }}</span></div>
        <div v-if="planResult.warnings.length" class="batch-warning-list" role="status"><p v-for="warning in planResult.warnings" :key="warning"><m3e-icon name="info"></m3e-icon><span>{{ warning }}</span></p></div>
        <div class="batch-plan-list" role="list" aria-label="传输计划项目">
          <div v-for="item in planResult.items" :key="item.sourceItemId" class="batch-plan-row" :class="{ blocked: item.blockedReason }" role="listitem"><m3e-icon :name="item.blockedReason ? 'block' : item.effectiveAction === 'move' ? 'drive_file_move' : 'content_copy'"></m3e-icon><span><strong>{{ item.title }}</strong><small>{{ itemKindLabel(item.kind) }} · {{ pathLabel(item.sourcePath) }} <m3e-icon name="arrow_forward"></m3e-icon> {{ pathLabel(item.targetPath) }}</small><small v-if="item.blockedReason" class="batch-error">{{ item.blockedReason }}</small><small v-else-if="item.pathIncomplete" class="batch-inline-note">原分类路径不完整，已保留可解析部分。</small></span></div>
        </div>
        <label v-if="planResult.requiresMoveConfirmation" class="batch-move-confirm"><input v-model="moveConfirmed" type="checkbox" /><span><strong>我确认执行移动</strong><small>目标写入、附件校验和来源删除会按顺序执行；已完成操作可安全重试。</small></span></label>
        </section>

        <section v-if="executing || progress" class="batch-panel batch-progress-panel" aria-live="polite" aria-labelledby="batch-progress-title">
        <div class="batch-progress-heading"><div><h3 id="batch-progress-title">{{ executing ? '正在传输' : progress?.phase === 'failed' ? '传输未完成' : '传输结果' }}</h3><p>{{ progress ? phaseLabel(progress.phase) : '准备中' }} · {{ progress?.processed || 0 }} / {{ progress?.total || planResult?.items.length || 0 }}</p></div><strong>{{ progressPercent }}%</strong></div>
        <progress max="100" :value="progressPercent" aria-label="批量传输进度"></progress>
        </section>

        <section v-if="executeResult" class="batch-panel batch-result-panel" aria-labelledby="batch-result-title">
        <div class="batch-panel-heading"><div><h3 id="batch-result-title">处理结果</h3><p>{{ executeResult.completedCount }} 个成功 · {{ executeResult.blockedCount }} 个阻断 · {{ executeResult.failedCount }} 个失败</p></div><m3e-icon :name="executeResult.failedCount ? 'error' : 'check_circle'" :class="executeResult.failedCount ? 'result-danger' : 'result-success'"></m3e-icon></div>
        <div class="batch-result-list" role="list" aria-label="批量传输结果">
          <div v-for="item in executeResult.items" :key="item.sourceItemId" class="batch-result-row" :class="`result-${item.status}`" role="listitem"><m3e-icon :name="resultIcon(item.status)"></m3e-icon><span><strong>{{ item.title }}</strong><small>{{ itemKindLabel(item.kind) }} · {{ item.status === 'completed' ? '已写入目标' : item.error || '未执行' }}</small></span></div>
        </div>
        <p v-if="retryableCount" class="batch-inline-note"><m3e-icon name="info"></m3e-icon>重试会重放同一个确定性操作；已完成项目不会重复创建。</p>
        </section>

        <p v-if="error" class="batch-error batch-dialog-error" role="alert">{{ error }}</p>
      </div>
      <footer class="mdbx2-batch-footer">
        <m3e-button variant="text" type="button" :disabled="executing" @click="closeDialog">关闭</m3e-button>
        <m3e-button v-if="retryableCount" variant="tonal" type="button" :disabled="executing" @click="retryFailed"><m3e-icon slot="icon" name="refresh"></m3e-icon>重试失败项目</m3e-button>
        <m3e-button v-if="!hasPlan" variant="filled" type="button" :disabled="planning || executing || !selectedCount || !targetReady" @click="createPlan"><m3e-icon slot="icon" name="rule"></m3e-icon>{{ planning ? '检查兼容性…' : '检查并生成计划' }}</m3e-button>
        <m3e-button v-else variant="filled" type="button" :disabled="planning || executing || !planCanExecute" @click="executePlan"><m3e-icon slot="icon" :name="executing ? 'progress_activity' : action === 'move' ? 'drive_file_move' : 'content_copy'"></m3e-icon>{{ executing ? '正在提交…' : planResult?.requiresMoveConfirmation ? '确认并移动' : '执行复制' }}</m3e-button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
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
  border-radius: 16px;
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
  padding: 16px 24px;
}

.batch-panel {
  min-width: 0;
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
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
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  border: 1px solid var(--md-sys-color-outline, var(--app-outline));
  border-radius: 8px;
  padding: 0 12px;
  background: var(--md-sys-color-surface-container-lowest, var(--app-surface));
}

.batch-search:focus-within {
  outline: 3px solid color-mix(in srgb, var(--app-primary) 38%, transparent);
  outline-offset: 1px;
}

.batch-search m3e-icon {
  --m3e-icon-size: 20px;
  color: var(--app-muted);
}

.batch-search input {
  min-width: 0;
  flex: 1;
  min-height: 42px;
  border: 0;
  outline: 0;
  color: var(--app-text);
  background: transparent;
  font: inherit;
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
  border-radius: 8px;
  padding: 8px;
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
  display: grid;
  gap: 6px;
  margin-top: 16px;
  font-weight: 600;
}

.batch-field select {
  box-sizing: border-box;
  inline-size: 100%;
  min-height: 44px;
  border: 1px solid var(--md-sys-color-outline, var(--app-outline));
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--app-text);
  background: var(--md-sys-color-surface-container-lowest, var(--app-surface));
  font: inherit;
}

.batch-field select:focus-visible,
.batch-check input:focus-visible,
.batch-item-row input:focus-visible,
.batch-folder-row input:focus-visible,
.batch-move-confirm input:focus-visible,
.batch-action-segments input:focus-visible + span {
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
  color: var(--md-sys-color-on-tertiary-container, var(--app-text));
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.batch-action-segments label {
  position: relative;
  min-width: 0;
  cursor: pointer;
}

.batch-action-segments input {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  opacity: 0;
}

.batch-action-segments span {
  min-height: 72px;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-content: center;
  column-gap: 8px;
  border: 1px solid var(--md-sys-color-outline, var(--app-outline));
  border-radius: 8px;
  padding: 8px 10px;
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

.batch-action-segments input:checked + span {
  border-color: var(--md-sys-color-primary, var(--app-primary));
  color: var(--md-sys-color-on-secondary-container, var(--app-text));
  background: var(--md-sys-color-secondary-container, var(--app-selected));
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
  margin-top: 8px;
  border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  border-radius: 8px;
  padding: 4px;
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
  margin: 0 24px 12px;
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
  border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
}

.batch-plan-row,
.batch-result-row {
  min-width: 0;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline));
  padding: 10px 0;
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
  margin: 0 24px 12px;
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

@media (prefers-reduced-motion: reduce) {
  .mdbx2-batch-dialog,
  .mdbx2-batch-backdrop {
    animation: none;
  }
}
</style>
