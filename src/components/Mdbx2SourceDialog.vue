<script setup lang="ts">
import { tr, locale } from '../i18n';

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type { ProviderAccount } from "../core/model";
import {
  MDBX2_MAX_COLLECTION_TITLE_BYTES,
  MDBX2_MAX_INBOUND_FILE_BYTES,
  MDBX2_MAX_SNAPSHOT_NAME_BYTES,
  type Mdbx2CommitDiffItem,
  type Mdbx2CommitHistoryItem,
  type Mdbx2CollectionSummary,
  type Mdbx2ConflictResolutionChoice,
  type Mdbx2ConflictSummary,
  type Mdbx2HealthRepairChoice,
  type Mdbx2HealthRepairDecision,
  type Mdbx2HealthRepairPlan,
  type Mdbx2HostStatus,
  type Mdbx2ManagedSnapshotSummary,
  type Mdbx2SnapshotPrunePlan,
  type Mdbx2SnapshotStructureNode,
  type Mdbx2SnapshotStructureSide,
  type Mdbx2UnlockMethod,
  type Mdbx2VaultCredential,
  type Mdbx2VaultDiagnosticsReport,
  type Mdbx2VaultInspection,
  type Mdbx2VaultRuntimeStatus,
  type Mdbx2VaultSource,
  type Mdbx2VaultTigaPosture
} from "../providers/mdbx2/native-contract";
import { formatMdbx2HistoryTime, presentMdbx2Diff, presentMdbx2History } from "../providers/mdbx2/mdbx2-history";
import { mdbx2ConflictChoiceDescription, mdbx2ConflictChoiceLabel, presentMdbx2Conflict } from "../providers/mdbx2/mdbx2-conflicts";
import { formatMdbx2SnapshotBytes, presentMdbx2Snapshot, presentMdbx2SnapshotNode } from "../providers/mdbx2/mdbx2-snapshots";
import { mdbx2CollectionDescendantIds, presentMdbx2Collections } from "../providers/mdbx2/mdbx2-collections";
import {
  formatMdbx2DiagnosticCount,
  formatMdbx2DiagnosticTime,
  mdbx2HealthCategoryLabel,
  mdbx2HealthSeverityIcon,
  mdbx2HealthSeverityLabel,
  presentMdbx2Health,
  presentMdbx2HealthGuidance,
  type Mdbx2HealthGuidanceAction,
  summarizeMdbx2HealthCounts
} from "../providers/mdbx2/mdbx2-diagnostics";
import {
  presentMdbx2HealthRepairAutomatic,
  presentMdbx2HealthRepairConflict
} from "../providers/mdbx2/mdbx2-health-repair";
import {
  formatMdbx2TigaDuration,
  mdbx2TigaAuditLevelLabel,
  mdbx2TigaBooleanLabel,
  mdbx2TigaBrowserLimitation,
  mdbx2TigaComplianceLabel,
  mdbx2TigaDeviceAssuranceLabel,
  mdbx2TigaProfileLabel,
  mdbx2TigaUnlockMethodLabel,
  presentMdbx2Tiga
} from "../providers/mdbx2/mdbx2-tiga";
import { vaultClient } from "../runtime/client";
import type { Mdbx2ManagerSyncStatus, Mdbx2WebDavSettingsInput } from "../runtime/messages";

type NewSourceMode = "local" | "remote";
type BusyState = "" | "probe" | "upload" | "download" | "open" | "save" | "publish";
type SnapshotBusyState = "" | "list" | "structure" | "prune-plan" | "prune" | "create" | "delete" | "restore";
type SnapshotStructureMode = "snapshot" | "compare";
type SnapshotMutationAction = "delete" | "restore";
type HealthRepairBusyState = "" | "plan" | "apply" | "refresh";
type HealthRepairRecoveryState = "" | "stale" | "unknown";
type CollectionView = "active" | "deleted";
type CollectionMutationKind = "create" | "rename" | "move" | "delete" | "restore";
interface PendingCollectionMutation {
  kind: CollectionMutationKind;
  operationId: string;
  collectionId: string;
  title: string;
  parentCollectionId?: string;
  attempted: boolean;
  uncertain: boolean;
}
interface PendingConflictResolution { item: Mdbx2ConflictSummary; choice: Mdbx2ConflictResolutionChoice; operationId: string }
interface PendingHistoryRevert { item: Mdbx2CommitHistoryItem; operationId: string; attempted: boolean }
interface PendingSnapshotCreate { operationId: string; name: string }
interface PendingSnapshotMutation { item: Mdbx2ManagedSnapshotSummary; action: SnapshotMutationAction; operationId: string; attempted: boolean }
interface PendingSnapshotPrune { plan: Mdbx2SnapshotPrunePlan; attempted: boolean; uncertain: boolean; stale: boolean }
interface SnapshotStructureState {
  items: Mdbx2SnapshotStructureNode[];
  cursor?: string;
  loaded: boolean;
  totalNodes: number;
  currentItemCount: number;
  snapshotItemCount: number;
}

const props = defineProps<{
  provider?: ProviderAccount;
  initialMode?: NewSourceMode;
  hostStatus?: Mdbx2HostStatus | null;
  runtimeStatus?: Mdbx2VaultRuntimeStatus;
  syncStatus?: Mdbx2ManagerSyncStatus;
}>();

const emit = defineEmits<{
  close: [];
  changed: [];
  notice: [message: string];
  hostStatus: [status: Mdbx2HostStatus];
}>();

const activeProvider = ref<ProviderAccount | undefined>(props.provider);
const providerId = ref(props.provider?.id || "");
const hostStatus = ref<Mdbx2HostStatus | null>(props.hostStatus || null);
const runtimeStatus = ref<Mdbx2VaultRuntimeStatus | undefined>(props.runtimeStatus);
const syncStatus = ref<Mdbx2ManagerSyncStatus | undefined>(props.syncStatus);
const vaultDiagnostics = ref<Mdbx2VaultDiagnosticsReport | undefined>();
const diagnosticsBusy = ref(false);
const diagnosticsError = ref("");
const diagnosticsDetails = ref<HTMLDetailsElement | null>(null);
const diagnosticsAttachmentTarget = ref<HTMLElement | null>(null);
const healthRepairPanel = ref<HTMLElement | null>(null);
const confirmHealthRepairDeleteButton = ref<HTMLElement | null>(null);
const applyHealthRepairButton = ref<HTMLElement | null>(null);
const healthRepairPlan = ref<Mdbx2HealthRepairPlan | undefined>();
const healthRepairBusy = ref<HealthRepairBusyState>("");
const healthRepairError = ref("");
const healthRepairDecisions = ref<Mdbx2HealthRepairDecision[]>([]);
const healthRepairConflictIndex = ref(0);
const healthRepairDeleteConfirmation = ref("");
const healthRepairOperationId = ref("");
const healthRepairAttempted = ref(false);
const healthRepairRecovery = ref<HealthRepairRecoveryState>("");
const collectionPanel = ref<HTMLElement | null>(null);
const snapshotPanel = ref<HTMLElement | null>(null);
const historyPanel = ref<HTMLElement | null>(null);
const vaultTiga = ref<Mdbx2VaultTigaPosture | undefined>();
const tigaBusy = ref(false);
const tigaError = ref("");
const busy = ref<BusyState>("");
const error = ref("");
const uploadProgress = ref(0);
const vaultFile = ref<File | null>(null);
const securityKeyFile = ref<File | null>(null);
const pendingSource = ref<Mdbx2VaultSource | undefined>();
const pendingOriginKey = ref("");
const inspection = ref<Mdbx2VaultInspection | undefined>();
const revealVaultPassword = ref(false);
const activeCollections = ref<Mdbx2CollectionSummary[]>([]);
const deletedCollections = ref<Mdbx2CollectionSummary[]>([]);
const activeCollectionCursor = ref<string | undefined>();
const deletedCollectionCursor = ref<string | undefined>();
const activeCollectionsLoaded = ref(false);
const deletedCollectionsLoaded = ref(false);
const collectionView = ref<CollectionView>("active");
const collectionBusy = ref<"" | "list" | "mutate">("");
const collectionLoadCount = ref(0);
const collectionError = ref("");
const pendingCollectionMutation = ref<PendingCollectionMutation | undefined>();
const collectionConfirmButton = ref<HTMLElement | null>(null);
const historyItems = ref<Mdbx2CommitHistoryItem[]>([]);
const historyCursor = ref<string | undefined>();
const historyLoaded = ref(false);
const historyBusy = ref<"" | "list" | "diff" | "revert">("");
const historyError = ref("");
const selectedCommitId = ref("");
const commitDiffItems = ref<Mdbx2CommitDiffItem[]>([]);
const pendingHistoryRevert = ref<PendingHistoryRevert | undefined>();
const confirmHistoryRevertButton = ref<HTMLElement | null>(null);
const conflictItems = ref<Mdbx2ConflictSummary[]>([]);
const conflictCursor = ref<string | undefined>();
const conflictLoaded = ref(false);
const conflictBusy = ref<"" | "list" | "resolve">("");
const conflictError = ref("");
const selectedConflictId = ref("");
const pendingConflictResolution = ref<PendingConflictResolution | undefined>();
const confirmConflictButton = ref<HTMLElement | null>(null);
const snapshotItems = ref<Mdbx2ManagedSnapshotSummary[]>([]);
const snapshotCursor = ref<string | undefined>();
const snapshotLoaded = ref(false);
const snapshotBusy = ref<SnapshotBusyState>("");
const snapshotError = ref("");
const snapshotName = ref("");
const selectedSnapshotId = ref("");
const snapshotStructureMode = ref<SnapshotStructureMode>("snapshot");
const currentSnapshotStructure = ref<SnapshotStructureState>(emptySnapshotStructure());
const savedSnapshotStructure = ref<SnapshotStructureState>(emptySnapshotStructure());
const pendingSnapshotCreate = ref<PendingSnapshotCreate | undefined>();
const pendingSnapshotMutation = ref<PendingSnapshotMutation | undefined>();
const pendingSnapshotPrune = ref<PendingSnapshotPrune | undefined>();
const snapshotRequiresRefresh = ref(false);
const confirmSnapshotButton = ref<HTMLElement | null>(null);
const confirmSnapshotPruneButton = ref<HTMLElement | null>(null);

const config = props.provider?.config || {};
const form = reactive({
  mode: (props.provider ? "local" : props.initialMode || "local") as NewSourceMode,
  name: props.provider?.name || "Monica MDBX2",
  baseUrl: typeof config.webDavBaseUrl === "string" ? config.webDavBaseUrl : "",
  username: typeof config.webDavUsername === "string" ? config.webDavUsername : "",
  webDavPassword: "",
  webDavPasswordConfigured: config.webDavPasswordConfigured === true,
  remotePath: typeof config.remotePath === "string" ? config.remotePath : "",
  unlockMethod: "password" as Mdbx2UnlockMethod,
  vaultPassword: "",
  isDefaultSaveTarget: props.provider?.isDefaultSaveTarget || false
});

const isExisting = computed(() => Boolean(providerId.value));
const hostReady = computed(() => hostStatus.value?.availability === "ready");
const vaultOpen = computed(() => runtimeStatus.value?.open === true);
const diagnosticHealth = computed(() => vaultDiagnostics.value ? presentMdbx2Health(vaultDiagnostics.value.health) : undefined);
const diagnosticGuidance = computed(() => vaultDiagnostics.value ? presentMdbx2HealthGuidance(vaultDiagnostics.value.health) : []);
const tigaPresentation = computed(() => vaultTiga.value ? presentMdbx2Tiga(vaultTiga.value) : undefined);
const remoteFieldsComplete = computed(() => Boolean(form.baseUrl.trim() && form.remotePath.trim()));
const needsSecurityKey = computed(() => form.unlockMethod !== "password");
const canPublish = computed(() => isExisting.value && vaultOpen.value && remoteFieldsComplete.value && !syncStatus.value?.initialized);
const selectedHistoryItem = computed(() => historyItems.value.find((item) => item.commitId === selectedCommitId.value));
const selectedConflict = computed(() => conflictItems.value.find((item) => item.conflictId === selectedConflictId.value));
const selectedSnapshot = computed(() => snapshotItems.value.find((item) => item.snapshotId === selectedSnapshotId.value));
const currentHealthRepairConflict = computed(() => healthRepairPlan.value?.conflicts[healthRepairConflictIndex.value]);
const healthRepairReviewReady = computed(() => Boolean(
  healthRepairPlan.value?.canApply
  && healthRepairConflictIndex.value >= healthRepairPlan.value.conflicts.length
));
const healthRepairKeepCount = computed(() => healthRepairDecisions.value.filter((item) => item.choice === "keep-content").length);
const healthRepairDeleteCount = computed(() => healthRepairDecisions.value.filter((item) => item.choice === "delete-object").length);
const healthRepairPlanActive = computed(() => Boolean(healthRepairPlan.value?.canApply));
const snapshotNameBytes = computed(() => new TextEncoder().encode(snapshotName.value.trim()).byteLength);
const snapshotNameTooLong = computed(() => snapshotNameBytes.value > MDBX2_MAX_SNAPSHOT_NAME_BYTES);
const collectionTitleBytes = computed(() => new TextEncoder().encode(pendingCollectionMutation.value?.title.trim() || "").byteLength);
const collectionTitleInvalid = computed(() => {
  const pending = pendingCollectionMutation.value;
  return Boolean(pending && (pending.kind === "create" || pending.kind === "rename")
    && (!pending.title.trim() || collectionTitleBytes.value > MDBX2_MAX_COLLECTION_TITLE_BYTES));
});
const collectionRows = computed(() => presentMdbx2Collections(
  collectionView.value === "active" ? activeCollections.value : deletedCollections.value,
  [...activeCollections.value, ...deletedCollections.value]
));
const collectionMoveBlockedIds = computed(() => {
  const pending = pendingCollectionMutation.value;
  if (!pending || pending.kind !== "move") return new Set<string>();
  return mdbx2CollectionDescendantIds(activeCollections.value, pending.collectionId).add(pending.collectionId);
});
const collectionParentOptions = computed(() => presentMdbx2Collections(
  activeCollections.value.filter((item) => !collectionMoveBlockedIds.value.has(item.collectionId)),
  activeCollections.value
));
const snapshotMutating = computed(() => snapshotBusy.value === "prune" || snapshotBusy.value === "create" || snapshotBusy.value === "delete" || snapshotBusy.value === "restore");
const historyMutating = computed(() => historyBusy.value === "revert");
const otherManagerMutationLocked = computed(() => conflictBusy.value === "resolve" || snapshotMutating.value || historyMutating.value || collectionBusy.value === "mutate");
const managerMutationLocked = computed(() => otherManagerMutationLocked.value || Boolean(healthRepairBusy.value) || healthRepairPlanActive.value);
const dialogLocked = computed(() => Boolean(busy.value) || otherManagerMutationLocked.value || Boolean(healthRepairBusy.value));
const dialogTitle = computed(() => {
  if (isExisting.value) return tr('管理 {0}', { 0: activeProvider.value?.name || form.name });
  return form.mode === "remote" ? tr('从 WebDAV 加入 MDBX2') : tr('打开 MDBX2 保险库');
});
const busyLabel = computed(() => ({
  probe: tr('正在检查 Native Host…'),
  upload: tr('正在传输本地文件… {0}%', { 0: uploadProgress.value }),
  download: tr('正在下载并校验可移植备份…'),
  open: tr('正在验证、解锁并检查保险库…'),
  save: tr('正在加密保存设置…'),
  publish: tr('正在生成并发布可移植备份…')
} as Record<Exclude<BusyState, "">, string>)[busy.value as Exclude<BusyState, "">] || "");

onMounted(refreshStatus);
onBeforeUnmount(() => { void releasePendingSource(); });

async function refreshStatus() {
  busy.value = "probe";
  error.value = "";
  try {
    const nextHost = await vaultClient.mdbx2HostStatus();
    hostStatus.value = nextHost;
    emit("hostStatus", nextHost);
    if (!providerId.value || nextHost.availability !== "ready") return;
    const [nextRuntime, nextSync] = await Promise.all([
      vaultClient.mdbx2VaultStatus(providerId.value).catch(() => undefined),
      vaultClient.mdbx2SyncStatus(providerId.value).catch(() => undefined)
    ]);
    runtimeStatus.value = nextRuntime;
    syncStatus.value = nextSync;
    if (nextRuntime?.open) await Promise.all([
      loadVaultDiagnostics(),
      loadVaultTiga(),
      loadCollections("active", true),
      loadCollections("deleted", true),
      loadSnapshots(true),
      loadConflicts(true)
    ]);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function loadVaultDiagnostics() {
  if (!providerId.value || !vaultOpen.value || diagnosticsBusy.value) return;
  diagnosticsBusy.value = true;
  diagnosticsError.value = "";
  try {
    vaultDiagnostics.value = await vaultClient.mdbx2VaultDiagnostics(providerId.value);
  } catch (cause) {
    diagnosticsError.value = diagnosticsErrorMessage(cause);
  } finally {
    diagnosticsBusy.value = false;
  }
}

async function requestHealthRepairPlan() {
  if (!providerId.value || !vaultOpen.value || healthRepairBusy.value || otherManagerMutationLocked.value || healthRepairPlan.value) return;
  clearHealthRepairReview();
  healthRepairBusy.value = "plan";
  healthRepairError.value = "";
  let planned = false;
  try {
    const plan = await vaultClient.planMdbx2HealthRepair(providerId.value);
    if (!plan.itemCount && !plan.blockerCount) {
      emit("notice", tr('当前没有 Native Host 可安全处理的删除标记问题；保险库内容未修改。'));
      return;
    }
    healthRepairPlan.value = plan;
    healthRepairOperationId.value = plan.canApply ? crypto.randomUUID() : "";
    planned = true;
  } catch (cause) {
    healthRepairError.value = healthRepairErrorMessage(cause);
  } finally {
    healthRepairBusy.value = "";
  }
  if (planned) await focusHealthRepairStep();
}

function cancelHealthRepairFlow() {
  if (healthRepairBusy.value || healthRepairAttempted.value) return;
  clearHealthRepairReview();
}

function chooseHealthRepairKeep() {
  recordHealthRepairDecision("keep-content");
}

async function requestHealthRepairDelete() {
  const conflict = currentHealthRepairConflict.value;
  if (!conflict || healthRepairBusy.value || healthRepairAttempted.value || healthRepairRecovery.value) return;
  healthRepairDeleteConfirmation.value = conflict.itemHandle;
  await nextTick();
  confirmHealthRepairDeleteButton.value?.focus();
}

function cancelHealthRepairDelete() {
  if (healthRepairBusy.value || healthRepairAttempted.value) return;
  healthRepairDeleteConfirmation.value = "";
  void focusHealthRepairStep();
}

function confirmHealthRepairDelete() {
  if (healthRepairDeleteConfirmation.value !== currentHealthRepairConflict.value?.itemHandle) return;
  recordHealthRepairDecision("delete-object");
}

function recordHealthRepairDecision(choice: Mdbx2HealthRepairChoice) {
  const conflict = currentHealthRepairConflict.value;
  if (!conflict || healthRepairBusy.value || healthRepairAttempted.value || healthRepairRecovery.value) return;
  const next = healthRepairDecisions.value.slice(0, healthRepairConflictIndex.value);
  next.push({ itemHandle: conflict.itemHandle, choice });
  healthRepairDecisions.value = next;
  healthRepairConflictIndex.value += 1;
  healthRepairDeleteConfirmation.value = "";
  void focusHealthRepairStep();
}

function previousHealthRepairConflict() {
  if (healthRepairBusy.value || healthRepairAttempted.value || healthRepairRecovery.value || healthRepairConflictIndex.value < 1) return;
  healthRepairConflictIndex.value -= 1;
  healthRepairDecisions.value = healthRepairDecisions.value.slice(0, healthRepairConflictIndex.value);
  healthRepairDeleteConfirmation.value = "";
  healthRepairError.value = "";
  void focusHealthRepairStep();
}

async function applyHealthRepair() {
  const plan = healthRepairPlan.value;
  if (!providerId.value
      || !plan?.canApply
      || !plan.planHandle
      || !healthRepairReviewReady.value
      || healthRepairDecisions.value.length !== plan.conflictCount
      || !healthRepairOperationId.value
      || healthRepairBusy.value
      || healthRepairRecovery.value) return;
  healthRepairBusy.value = "apply";
  healthRepairError.value = "";
  healthRepairAttempted.value = true;
  let completed = false;
  let repairedCount = 0;
  let alreadyApplied = false;
  try {
    const result = await vaultClient.applyMdbx2HealthRepair(
      providerId.value,
      plan.planHandle,
      healthRepairOperationId.value,
      healthRepairDecisions.value,
      healthRepairDeleteCount.value > 0
    );
    completed = true;
    repairedCount = result.repairedCount;
    alreadyApplied = result.alreadyApplied;
    clearHealthRepairReview();
  } catch (cause) {
    const code = errorCode(cause);
    healthRepairError.value = healthRepairErrorMessage(cause);
    if ([
      "health-repair-plan-stale",
      "health-repair-plan-unknown",
      "health-repair-blocked",
      "health-repair-intent-mismatch",
      "health-repair-decisions-incomplete",
      "native-host-incompatible"
    ].includes(code)) healthRepairRecovery.value = "stale";
    if (code === "health-repair-outcome-unknown") healthRepairRecovery.value = "unknown";
  } finally {
    healthRepairBusy.value = "";
  }
  if (!completed) return;
  emit("notice", tr('{0}，共处理 {1} 项；修复前恢复快照已经保留。', { 0: alreadyApplied ? tr('健康修复结果已确认') : tr('健康修复已完成'), 1: repairedCount.toLocaleString(locale.value) }));
  await refreshAfterHealthRepair();
}

function reviewHealthRepairOutcomeInstead() {
  if (!healthRepairAttempted.value || healthRepairBusy.value || !healthRepairError.value) return;
  healthRepairRecovery.value = "unknown";
  healthRepairError.value = tr('已停止直接重试。请刷新诊断、快照和提交历史核对最终状态，再生成新的处理计划。');
  void focusHealthRepairStep();
}

async function reconcileHealthRepairState() {
  if (!providerId.value || healthRepairBusy.value) return;
  healthRepairBusy.value = "refresh";
  healthRepairError.value = "";
  try {
    await Promise.all([
      loadVaultDiagnostics(),
      loadCollections("active", true),
      loadCollections("deleted", true),
      loadSnapshots(true),
      loadConflicts(true),
      loadHistory(true),
      vaultClient.mdbx2SyncStatus(providerId.value).then((status) => { syncStatus.value = status; }).catch(() => undefined)
    ]);
    clearHealthRepairReview();
    emit("changed");
    emit("notice", tr('已刷新诊断、文件夹、快照、冲突、提交历史和同步状态。请根据当前结果重新检查可处理问题。'));
  } finally {
    healthRepairBusy.value = "";
  }
}

async function refreshAfterHealthRepair() {
  await Promise.all([
    loadVaultDiagnostics(),
    loadCollections("active", true),
    loadCollections("deleted", true),
    loadSnapshots(true),
    loadConflicts(true),
    loadHistory(true),
    vaultClient.mdbx2SyncStatus(providerId.value).then((status) => { syncStatus.value = status; }).catch(() => undefined)
  ]);
  emit("changed");
}

function clearHealthRepairReview() {
  healthRepairPlan.value = undefined;
  healthRepairError.value = "";
  healthRepairDecisions.value = [];
  healthRepairConflictIndex.value = 0;
  healthRepairDeleteConfirmation.value = "";
  healthRepairOperationId.value = "";
  healthRepairAttempted.value = false;
  healthRepairRecovery.value = "";
}

async function focusHealthRepairStep() {
  await nextTick();
  const target = healthRepairReviewReady.value ? applyHealthRepairButton.value : healthRepairPanel.value;
  if (!target) return;
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  target.scrollIntoView({ behavior, block: "nearest" });
  target.focus({ preventScroll: true });
}

async function activateHealthGuidance(action: Mdbx2HealthGuidanceAction) {
  if (action === "recheck") {
    await loadVaultDiagnostics();
    return;
  }

  if (action === "attachments") {
    if (diagnosticsDetails.value) diagnosticsDetails.value.open = true;
    await nextTick();
    focusGuidanceTarget(diagnosticsAttachmentTarget.value);
    return;
  }

  const target = action === "collections"
    ? collectionPanel.value
    : action === "snapshots"
      ? snapshotPanel.value
      : historyPanel.value;
  focusGuidanceTarget(target);

  if (managerMutationLocked.value) return;
  if (action === "collections" && !activeCollectionsLoaded.value) await loadCollections("active", true);
  if (action === "snapshots" && !snapshotLoaded.value) await loadSnapshots(true);
  if (action === "history" && !historyLoaded.value) await loadHistory(true);
}

function focusGuidanceTarget(target: HTMLElement | null) {
  if (!target) return;
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  target.scrollIntoView({ behavior, block: "start" });
  target.focus({ preventScroll: true });
}

async function loadVaultTiga() {
  if (!providerId.value || !vaultOpen.value || tigaBusy.value) return;
  tigaBusy.value = true;
  tigaError.value = "";
  try {
    vaultTiga.value = await vaultClient.mdbx2VaultTiga(providerId.value);
  } catch (cause) {
    tigaError.value = tigaErrorMessage(cause);
  } finally {
    tigaBusy.value = false;
  }
}

function setMode(mode: NewSourceMode) {
  if (busy.value || form.mode === mode) return;
  form.mode = mode;
  error.value = "";
  inspection.value = undefined;
  void releasePendingSource();
}

function selectVaultFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0] || null;
  vaultFile.value = file;
  inspection.value = undefined;
  error.value = "";
  void releasePendingSource();
  if (file && form.name === "Monica MDBX2") form.name = file.name.replace(/\.mdbx$/i, "") || "Monica MDBX2";
}

function selectSecurityKey(event: Event) {
  securityKeyFile.value = (event.currentTarget as HTMLInputElement).files?.[0] || null;
  error.value = "";
}

async function connectNewSource() {
  if (!hostReady.value) return void (error.value = hostStatus.value?.message || tr('MDBX2 Native Host 尚未就绪。'));
  error.value = "";
  try {
    const source = form.mode === "local" ? await stageLocalFile() : await stageRemoteBootstrap();
    busy.value = "open";
    const opened = await vaultClient.openMdbx2Vault({
      name: form.name,
      source,
      credential: await buildCredential(),
      isDefaultSaveTarget: form.isDefaultSaveTarget
    });
    pendingSource.value = undefined;
    pendingOriginKey.value = "";
    activeProvider.value = opened.account;
    providerId.value = opened.account.id;
    runtimeStatus.value = { vaultHandle: opened.session.vaultHandle, open: true, available: true };
    vaultDiagnostics.value = opened.session;
    diagnosticsError.value = "";

    if (form.mode === "remote") {
      activeProvider.value = await vaultClient.saveMdbx2WebDav(
        opened.account.id,
        form.name,
        webDavSettings(),
        form.isDefaultSaveTarget
      );
      syncStatus.value = await vaultClient.registerMdbx2Bootstrap(opened.account.id);
    }

    const result = await vaultClient.syncProvider(opened.account.id);
    emit("changed");
    emit("notice", syncNotice(result, form.mode === "remote" ? tr('MDBX2 WebDAV 已加入并同步。') : tr('MDBX2 本机保险库已打开并导入。')));
    clearSecrets();
    emit("close");
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
    uploadProgress.value = 0;
  }
}

async function unlockExisting() {
  const provider = activeProvider.value;
  const vaultHandle = typeof provider?.config.vaultHandle === "string" ? provider.config.vaultHandle : "";
  if (!providerId.value || !vaultHandle) return void (error.value = tr('MDBX2 本机工作副本不存在。'));
  busy.value = "open";
  error.value = "";
  try {
    const opened = await vaultClient.openMdbx2Vault({
      providerId: providerId.value,
      name: form.name,
      source: { kind: "vault", handle: vaultHandle },
      credential: await buildCredential(),
      isDefaultSaveTarget: form.isDefaultSaveTarget
    });
    activeProvider.value = opened.account;
    runtimeStatus.value = { vaultHandle: opened.session.vaultHandle, open: true, available: true };
    vaultDiagnostics.value = opened.session;
    diagnosticsError.value = "";
    emit("changed");
    clearSecrets();
    await Promise.all([loadVaultTiga(), loadCollections("active", true), loadCollections("deleted", true), loadSnapshots(true), loadHistory(true), loadConflicts(true)]);
    emit("notice", tr('{0} 已解锁；现在可以查看提交历史或执行增量同步。', { 0: opened.account.name }));
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function saveSettings() {
  if (!providerId.value) return;
  busy.value = "save";
  error.value = "";
  try {
    activeProvider.value = await vaultClient.saveMdbx2WebDav(
      providerId.value,
      form.name,
      webDavSettings(),
      form.isDefaultSaveTarget
    );
    form.webDavPassword = "";
    form.webDavPasswordConfigured = activeProvider.value.config.webDavPasswordConfigured === true;
    syncStatus.value = await vaultClient.mdbx2SyncStatus(providerId.value).catch(() => undefined);
    emit("changed");
    emit("notice", tr('MDBX2 WebDAV 设置已保存到加密密码库。远端位置变化时旧 checkpoint 已解除绑定。'));
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function publishBootstrap() {
  if (!providerId.value) return;
  busy.value = "publish";
  error.value = "";
  try {
    activeProvider.value = await vaultClient.saveMdbx2WebDav(
      providerId.value,
      form.name,
      webDavSettings(),
      form.isDefaultSaveTarget
    );
    syncStatus.value = await vaultClient.publishMdbx2Bootstrap(providerId.value);
    form.webDavPassword = "";
    form.webDavPasswordConfigured = activeProvider.value.config.webDavPasswordConfigured === true;
    emit("changed");
    emit("notice", tr('MDBX2 可移植备份已发布；后续多设备同步使用不可变增量段和加密 Blob。'));
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function loadCollections(view: CollectionView, reset = false) {
  if (!providerId.value || !vaultOpen.value || collectionBusy.value === "mutate") return;
  collectionLoadCount.value += 1;
  collectionBusy.value = "list";
  collectionError.value = "";
  try {
    const deleted = view === "deleted";
    const cursor = reset
      ? undefined
      : deleted ? deletedCollectionCursor.value : activeCollectionCursor.value;
    const page = await vaultClient.listMdbx2Collections(providerId.value, {
      deleted,
      excludeRoot: true,
      pageSize: 200,
      cursor
    });
    const current = reset
      ? []
      : deleted ? deletedCollections.value : activeCollections.value;
    const merged = [...new Map([...current, ...page.items].map((item) => [item.collectionId, item])).values()];
    if (deleted) {
      deletedCollections.value = merged;
      deletedCollectionCursor.value = page.nextCursor;
      deletedCollectionsLoaded.value = true;
    } else {
      activeCollections.value = merged;
      activeCollectionCursor.value = page.nextCursor;
      activeCollectionsLoaded.value = true;
    }
  } catch (cause) {
    collectionError.value = collectionErrorMessage(cause);
  } finally {
    collectionLoadCount.value = Math.max(0, collectionLoadCount.value - 1);
    if (!collectionLoadCount.value) collectionBusy.value = "";
  }
}

async function changeCollectionView(view: CollectionView) {
  if (collectionBusy.value === "mutate" || pendingCollectionMutation.value) return;
  collectionView.value = view;
  const loaded = view === "active" ? activeCollectionsLoaded.value : deletedCollectionsLoaded.value;
  if (!loaded) await loadCollections(view, true);
}

async function beginCollectionMutation(kind: CollectionMutationKind, item?: Mdbx2CollectionSummary) {
  if (collectionBusy.value || pendingCollectionMutation.value || managerMutationLocked.value) return;
  const isCreate = kind === "create";
  const collectionId = isCreate ? crypto.randomUUID() : item?.collectionId;
  if (!collectionId) return;
  const activeParent = item?.groupId && activeCollections.value.some((candidate) => candidate.collectionId === item.groupId)
    ? item.groupId
    : undefined;
  pendingCollectionMutation.value = {
    kind,
    operationId: crypto.randomUUID(),
    collectionId,
    title: isCreate ? "" : item?.title || "",
    parentCollectionId: kind === "rename" || kind === "delete" ? undefined : activeParent,
    attempted: false,
    uncertain: false
  };
  collectionError.value = "";
  await nextTick();
  if (kind === "create" || kind === "rename") {
    document.querySelector<HTMLInputElement>("#mdbx2-collection-title-input")?.focus();
  } else {
    collectionConfirmButton.value?.focus();
  }
}

function cancelCollectionMutation() {
  if (!pendingCollectionMutation.value || pendingCollectionMutation.value.uncertain || collectionBusy.value) return;
  pendingCollectionMutation.value = undefined;
  collectionError.value = "";
}

async function submitCollectionMutation() {
  const pending = pendingCollectionMutation.value;
  if (!pending || !providerId.value || collectionBusy.value || collectionTitleInvalid.value) return;
  pending.attempted = true;
  collectionBusy.value = "mutate";
  collectionError.value = "";
  let completed = false;
  try {
    const result = pending.kind === "create"
      ? await vaultClient.createMdbx2Collection(providerId.value, pending.operationId, pending.collectionId, pending.title, pending.parentCollectionId)
      : pending.kind === "rename"
        ? await vaultClient.renameMdbx2Collection(providerId.value, pending.operationId, pending.collectionId, pending.title)
        : pending.kind === "move"
          ? await vaultClient.moveMdbx2Collection(providerId.value, pending.operationId, pending.collectionId, pending.parentCollectionId)
          : pending.kind === "delete"
            ? await vaultClient.deleteMdbx2Collection(providerId.value, pending.operationId, pending.collectionId)
            : await vaultClient.restoreMdbx2Collection(providerId.value, pending.operationId, pending.collectionId, pending.parentCollectionId);
    emit("notice", collectionMutationNotice(pending.kind, result.alreadyCommitted));
    pendingCollectionMutation.value = undefined;
    completed = true;
  } catch (cause) {
    collectionError.value = collectionErrorMessage(cause);
    if (errorCode(cause) === "native-host-disconnected") {
      pending.uncertain = true;
    } else {
      pending.attempted = false;
      pending.uncertain = false;
      pending.operationId = crypto.randomUUID();
    }
  } finally {
    collectionBusy.value = "";
  }
  if (completed) await refreshAfterCollectionMutation();
}

async function refreshAfterCollectionMutation() {
  await Promise.all([
    loadVaultDiagnostics(),
    loadCollections("active", true),
    loadCollections("deleted", true),
    loadHistory(true),
    loadSnapshots(true),
    vaultClient.mdbx2SyncStatus(providerId.value).then((status) => { syncStatus.value = status; }).catch(() => undefined)
  ]);
  emit("changed");
}

function collectionMutationHeading(pending: PendingCollectionMutation): string {
  return ({
    create: tr('新建文件夹'),
    rename: tr('重命名文件夹'),
    move: tr('移动“{0}”', { 0: pending.title }),
    delete: tr('删除“{0}”？', { 0: pending.title }),
    restore: tr('恢复“{0}”', { 0: pending.title })
  } as const)[pending.kind];
}

function collectionMutationDescription(pending: PendingCollectionMutation): string {
  if (pending.uncertain) return tr('Native Host 响应中断，原操作标识已保留。安全重试会确认原结果，不会产生第二次文件夹操作。');
  if (pending.kind === "delete") return tr('文件夹会进入回收站，并生成新的同步提交。MDBX2 只允许删除空文件夹；其中仍有条目或子文件夹时，Core 会拒绝操作。');
  if (pending.kind === "restore") return tr('恢复后可以选择顶层或当前活动文件夹作为父级，并生成新的同步提交。');
  if (pending.kind === "move") return tr('选择新的父级；当前文件夹及其下级已从候选中排除。');
  return tr('文件夹名称和层级会写入 MDBX2，并通过增量同步发送到其他设备。');
}

function collectionMutationButtonLabel(pending: PendingCollectionMutation): string {
  if (collectionBusy.value === "mutate") return tr('正在保存…');
  if (pending.uncertain) return tr('安全重试');
  return ({ create: tr('创建'), rename: tr('保存名称'), move: tr('确认移动'), delete: tr('确认删除'), restore: tr('确认恢复') } as const)[pending.kind];
}

function collectionMutationNotice(kind: CollectionMutationKind, replayed: boolean): string {
  const action = ({ create: tr('文件夹已创建'), rename: tr('文件夹名称已更新'), move: tr('文件夹层级已更新'), delete: tr('文件夹已移至回收站'), restore: tr('文件夹已恢复') } as const)[kind];
  return replayed ? tr('{0}，原操作结果已确认。', { 0: action }) : `${action}。`;
}

async function loadHistory(reset = false) {
  if (!providerId.value || !vaultOpen.value || historyBusy.value) return;
  historyBusy.value = "list";
  historyError.value = "";
  if (reset) {
    historyItems.value = [];
    historyCursor.value = undefined;
    selectedCommitId.value = pendingHistoryRevert.value?.item.commitId || "";
    commitDiffItems.value = [];
  }
  try {
    const page = await vaultClient.listMdbx2History(providerId.value, {
      pageSize: 20,
      cursor: reset ? undefined : historyCursor.value
    });
    const merged = reset ? page.items : [...historyItems.value, ...page.items];
    historyItems.value = [...new Map(merged.map((item) => [item.commitId, item])).values()];
    historyCursor.value = page.nextCursor;
    historyLoaded.value = true;
    const pending = pendingHistoryRevert.value;
    if (reset && pending?.attempted && historyItems.value.some((item) => item.operationId === pending.operationId)) {
      pendingHistoryRevert.value = undefined;
      selectedCommitId.value = "";
      historyError.value = "";
      emit("notice", tr('提交恢复结果已从历史记录中确认。'));
    }
  } catch (cause) {
    historyError.value = historyErrorMessage(cause);
  } finally {
    historyBusy.value = "";
  }
}

async function selectHistory(item: Mdbx2CommitHistoryItem) {
  if (pendingHistoryRevert.value) return;
  const presentation = presentMdbx2History(item);
  selectedCommitId.value = selectedCommitId.value === item.commitId ? "" : item.commitId;
  commitDiffItems.value = [];
  historyError.value = "";
  if (!selectedCommitId.value || !presentation.canInspect || !providerId.value) return;
  historyBusy.value = "diff";
  try {
    commitDiffItems.value = (await vaultClient.listMdbx2CommitDiff(providerId.value, item.commitId)).items;
  } catch (cause) {
    historyError.value = historyErrorMessage(cause);
  } finally {
    historyBusy.value = "";
  }
}

async function requestHistoryRevert(item: Mdbx2CommitHistoryItem) {
  if (!providerId.value || historyBusy.value || managerMutationLocked.value || pendingHistoryRevert.value || !presentMdbx2History(item).canRevert) return;
  selectedCommitId.value = item.commitId;
  pendingHistoryRevert.value = { item, operationId: crypto.randomUUID(), attempted: false };
  historyError.value = "";
  await nextTick();
  confirmHistoryRevertButton.value?.focus();
}

function cancelHistoryRevert() {
  if (!pendingHistoryRevert.value || pendingHistoryRevert.value.attempted || historyBusy.value) return;
  pendingHistoryRevert.value = undefined;
  historyError.value = "";
}

async function confirmHistoryRevert() {
  const pending = pendingHistoryRevert.value;
  if (!pending || !providerId.value || historyBusy.value || conflictBusy.value === "resolve" || snapshotMutating.value) return;
  pending.attempted = true;
  historyBusy.value = "revert";
  historyError.value = "";
  let completed = false;
  try {
    const result = await vaultClient.revertMdbx2Commit(providerId.value, pending.operationId, pending.item.commitId);
    pendingHistoryRevert.value = undefined;
    completed = true;
    emit("notice", tr('历史版本已恢复，共处理 {0} 个条目；原提交记录仍然保留。', { 0: result.revertedObjectCount }));
  } catch (cause) {
    historyError.value = historyErrorMessage(cause);
  } finally {
    historyBusy.value = "";
  }
  if (completed) await refreshAfterHistoryRevert();
}

async function refreshAfterHistoryRevert() {
  await Promise.all([
    loadVaultDiagnostics(),
    loadHistory(true),
    loadSnapshots(true),
    vaultClient.mdbx2SyncStatus(providerId.value).then((status) => { syncStatus.value = status; }).catch(() => undefined)
  ]);
  emit("changed");
}

async function loadConflicts(reset = false) {
  if (!providerId.value || !vaultOpen.value || conflictBusy.value || snapshotMutating.value) return;
  conflictBusy.value = "list";
  conflictError.value = "";
  if (reset) {
    conflictItems.value = [];
    conflictCursor.value = undefined;
    conflictLoaded.value = false;
    selectedConflictId.value = "";
    pendingConflictResolution.value = undefined;
  }
  try {
    const page = await vaultClient.listMdbx2Conflicts(providerId.value, {
      pageSize: 20,
      cursor: reset ? undefined : conflictCursor.value
    });
    const merged = reset ? page.items : [...conflictItems.value, ...page.items];
    conflictItems.value = [...new Map(merged.map((item) => [item.conflictId, item])).values()];
    conflictCursor.value = page.nextCursor;
    conflictLoaded.value = true;
  } catch (cause) {
    conflictError.value = conflictErrorMessage(cause);
  } finally {
    conflictBusy.value = "";
  }
}

function selectConflict(item: Mdbx2ConflictSummary) {
  selectedConflictId.value = selectedConflictId.value === item.conflictId ? "" : item.conflictId;
  pendingConflictResolution.value = undefined;
  conflictError.value = "";
}

async function requestConflictResolution(item: Mdbx2ConflictSummary, choice: Mdbx2ConflictResolutionChoice) {
  if (snapshotMutating.value) return;
  pendingConflictResolution.value = { item, choice, operationId: crypto.randomUUID() };
  conflictError.value = "";
  await nextTick();
  confirmConflictButton.value?.focus();
}

function cancelConflictResolution() {
  pendingConflictResolution.value = undefined;
  conflictError.value = "";
}

async function confirmConflictResolution() {
  const pending = pendingConflictResolution.value;
  if (!pending || !providerId.value || conflictBusy.value || snapshotMutating.value) return;
  conflictBusy.value = "resolve";
  conflictError.value = "";
  let completed = false;
  try {
    await vaultClient.resolveMdbx2Conflict(
      providerId.value,
      pending.operationId,
      pending.item.conflictId,
      pending.choice
    );
    conflictItems.value = conflictItems.value.filter((item) => item.conflictId !== pending.item.conflictId);
    selectedConflictId.value = "";
    pendingConflictResolution.value = undefined;
    syncStatus.value = await vaultClient.mdbx2SyncStatus(providerId.value).catch(() => syncStatus.value);
    completed = true;
    emit("changed");
    emit("notice", tr('{0}；此决定将在下次增量同步时发布。', { 0: mdbx2ConflictChoiceLabel(pending.choice) }));
  } catch (cause) {
    conflictError.value = conflictErrorMessage(cause);
  } finally {
    conflictBusy.value = "";
  }
  if (completed) await loadVaultDiagnostics();
}

async function loadSnapshots(reset = false) {
  if (!providerId.value || !vaultOpen.value || snapshotBusy.value || conflictBusy.value === "resolve") return;
  snapshotBusy.value = "list";
  snapshotError.value = "";
  if (reset) {
    snapshotItems.value = [];
    snapshotCursor.value = undefined;
    snapshotLoaded.value = false;
    selectedSnapshotId.value = "";
    resetSnapshotStructures();
  }
  try {
    const page = await vaultClient.listMdbx2Snapshots(providerId.value, {
      pageSize: 20,
      cursor: reset ? undefined : snapshotCursor.value
    });
    const merged = reset ? page.items : [...snapshotItems.value, ...page.items];
    snapshotItems.value = [...new Map(merged.map((item) => [item.snapshotId, item])).values()];
    snapshotCursor.value = page.nextCursor;
    snapshotLoaded.value = true;
    if (reset) {
      pendingSnapshotCreate.value = undefined;
      pendingSnapshotMutation.value = undefined;
      if (!pendingSnapshotPrune.value?.uncertain) pendingSnapshotPrune.value = undefined;
      snapshotRequiresRefresh.value = false;
    }
  } catch (cause) {
    snapshotError.value = snapshotErrorMessage(cause);
  } finally {
    snapshotBusy.value = "";
  }
}

async function requestAutomaticSnapshotPrune() {
  if (!providerId.value
      || snapshotBusy.value
      || snapshotRequiresRefresh.value
      || conflictBusy.value === "resolve"
      || pendingSnapshotCreate.value
      || pendingSnapshotMutation.value
      || pendingSnapshotPrune.value?.uncertain) return;
  snapshotBusy.value = "prune-plan";
  snapshotError.value = "";
  pendingSnapshotPrune.value = undefined;
  let planned = false;
  try {
    const plan = await vaultClient.planMdbx2AutomaticSnapshotPrune(providerId.value, 0);
    if (!plan.candidateCount) {
      emit("notice", tr('当前没有已到保留期限的自动快照；手动快照和未到期自动快照均未更改。'));
      return;
    }
    pendingSnapshotPrune.value = { plan, attempted: false, uncertain: false, stale: false };
    planned = true;
  } catch (cause) {
    snapshotError.value = snapshotErrorMessage(cause);
  } finally {
    snapshotBusy.value = "";
  }
  if (planned) {
    await nextTick();
    confirmSnapshotPruneButton.value?.focus();
  }
}

function cancelAutomaticSnapshotPrune() {
  if (!pendingSnapshotPrune.value || pendingSnapshotPrune.value.uncertain || snapshotBusy.value) return;
  pendingSnapshotPrune.value = undefined;
  snapshotError.value = "";
}

async function confirmAutomaticSnapshotPrune() {
  const pending = pendingSnapshotPrune.value;
  if (!pending || !providerId.value || snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve") return;
  if (pending.stale) {
    await requestAutomaticSnapshotPrune();
    return;
  }
  pending.attempted = true;
  pending.uncertain = false;
  snapshotBusy.value = "prune";
  snapshotError.value = "";
  let completed = false;
  try {
    const result = await vaultClient.pruneMdbx2AutomaticSnapshots(providerId.value, pending.plan.planToken, pending.plan.keepLatest);
    if (result.deletedSnapshotCount !== pending.plan.candidateCount) {
      throw new Error(tr('Native Host 返回的自动快照清理数量与确认计划不一致。'));
    }
    pendingSnapshotPrune.value = undefined;
    completed = true;
    emit(
      "notice",
      tr('已清理 {0} 个到期自动快照。手动快照和未到期自动快照保持不变。{1}', { 0: result.deletedSnapshotCount, 1: pending.plan.hasMore ? tr(' 仍有更多到期项，可再次检查。') : "" })
    );
  } catch (cause) {
    const code = errorCode(cause);
    snapshotError.value = snapshotErrorMessage(cause);
    if (code === "snapshot-prune-plan-stale") {
      pending.stale = true;
      pending.uncertain = false;
    } else if (code === "native-host-disconnected") {
      pending.uncertain = true;
    } else if (code === "snapshot-prune-plan-empty") {
      pendingSnapshotPrune.value = undefined;
      emit("notice", tr('自动快照候选已经变化，当前没有可清理项。请刷新快照后再检查。'));
    } else {
      pending.attempted = false;
      pending.uncertain = false;
    }
  } finally {
    snapshotBusy.value = "";
  }
  if (completed) await refreshAfterSnapshotMutation();
}

async function selectSnapshot(item: Mdbx2ManagedSnapshotSummary) {
  if (snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve" || pendingSnapshotPrune.value) return;
  selectedSnapshotId.value = selectedSnapshotId.value === item.snapshotId ? "" : item.snapshotId;
  pendingSnapshotMutation.value = undefined;
  snapshotError.value = "";
  snapshotStructureMode.value = "snapshot";
  resetSnapshotStructures();
  if (selectedSnapshotId.value && item.integrityOk) await loadSnapshotStructure("snapshot", true);
}

async function changeSnapshotStructureMode(mode: SnapshotStructureMode) {
  if (!selectedSnapshot.value || snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve" || pendingSnapshotPrune.value) return;
  snapshotStructureMode.value = mode;
  snapshotError.value = "";
  if (!selectedSnapshot.value.integrityOk) return;
  if (mode === "snapshot") {
    if (!savedSnapshotStructure.value.loaded) await loadSnapshotStructure("snapshot", true);
    return;
  }
  if (!currentSnapshotStructure.value.loaded) await loadSnapshotStructure("current", true);
  if (!savedSnapshotStructure.value.loaded) await loadSnapshotStructure("snapshot", true);
}

async function loadSnapshotStructure(side: Mdbx2SnapshotStructureSide, reset = false) {
  const item = selectedSnapshot.value;
  if (!providerId.value || !item || !item.integrityOk || snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve" || pendingSnapshotPrune.value) return;
  const state = side === "current" ? currentSnapshotStructure : savedSnapshotStructure;
  snapshotBusy.value = "structure";
  snapshotError.value = "";
  if (reset) state.value = emptySnapshotStructure();
  try {
    const page = await vaultClient.listMdbx2SnapshotStructure(providerId.value, item.snapshotId, side, {
      pageSize: 100,
      cursor: reset ? undefined : state.value.cursor
    });
    if (selectedSnapshotId.value !== item.snapshotId) return;
    const merged = reset ? page.items : [...state.value.items, ...page.items];
    state.value = {
      items: [...new Map(merged.map((node) => [node.nodeId, node])).values()],
      cursor: page.nextCursor,
      loaded: true,
      totalNodes: page.totalNodes,
      currentItemCount: page.currentItemCount,
      snapshotItemCount: page.snapshotItemCount
    };
  } catch (cause) {
    if (errorCode(cause) === "snapshot-structure-stale") state.value = emptySnapshotStructure();
    snapshotError.value = snapshotErrorMessage(cause);
  } finally {
    snapshotBusy.value = "";
  }
}

async function createSnapshot() {
  if (!providerId.value || snapshotBusy.value || snapshotNameTooLong.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve" || pendingSnapshotMutation.value || pendingSnapshotPrune.value) return;
  const pending = pendingSnapshotCreate.value || {
    operationId: crypto.randomUUID(),
    name: snapshotName.value.trim()
  };
  pendingSnapshotCreate.value = pending;
  snapshotName.value = pending.name;
  snapshotBusy.value = "create";
  snapshotError.value = "";
  let completed = false;
  try {
    const result = await vaultClient.createMdbx2Snapshot(providerId.value, pending.operationId, pending.name);
    pendingSnapshotCreate.value = undefined;
    snapshotName.value = "";
    completed = true;
    emit("notice", result.alreadyCompleted ? tr('手动完整快照已确认创建。') : tr('手动完整快照已创建。'));
  } catch (cause) {
    snapshotError.value = snapshotErrorMessage(cause);
    if (errorCode(cause) === "snapshot-operation-state-unknown") snapshotRequiresRefresh.value = true;
  } finally {
    snapshotBusy.value = "";
  }
  if (completed) await refreshAfterSnapshotMutation();
}

async function requestSnapshotMutation(item: Mdbx2ManagedSnapshotSummary, action: SnapshotMutationAction) {
  if (snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve" || pendingSnapshotCreate.value || pendingSnapshotPrune.value || (action === "restore" && !item.integrityOk)) return;
  selectedSnapshotId.value = item.snapshotId;
  pendingSnapshotMutation.value = { item, action, operationId: crypto.randomUUID(), attempted: false };
  snapshotError.value = "";
  await nextTick();
  confirmSnapshotButton.value?.focus();
}

function cancelSnapshotMutation() {
  if (pendingSnapshotMutation.value?.attempted || snapshotBusy.value) return;
  pendingSnapshotMutation.value = undefined;
  snapshotError.value = "";
}

async function confirmSnapshotMutation() {
  const pending = pendingSnapshotMutation.value;
  if (!pending || !providerId.value || snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve") return;
  pending.attempted = true;
  snapshotBusy.value = pending.action;
  snapshotError.value = "";
  let completed = false;
  try {
    if (pending.action === "delete") {
      const result = await vaultClient.deleteMdbx2Snapshot(providerId.value, pending.operationId, pending.item.snapshotId);
      emit("notice", result.alreadyCompleted ? tr('快照删除结果已确认。') : tr('快照已永久删除。'));
    } else {
      const result = await vaultClient.restoreMdbx2Snapshot(providerId.value, pending.operationId, pending.item.snapshotId);
      emit("notice", tr('{0}，共处理 {1} 个对象。', { 0: result.alreadyCompleted ? tr('快照恢复结果已确认') : tr('快照已恢复'), 1: result.affectedObjectCount }));
    }
    pendingSnapshotMutation.value = undefined;
    completed = true;
  } catch (cause) {
    snapshotError.value = snapshotErrorMessage(cause);
    if (errorCode(cause) === "snapshot-operation-state-unknown") snapshotRequiresRefresh.value = true;
  } finally {
    snapshotBusy.value = "";
  }
  if (completed) await refreshAfterSnapshotMutation();
}

async function refreshAfterSnapshotMutation() {
  await Promise.all([
    loadVaultDiagnostics(),
    loadSnapshots(true),
    loadHistory(true),
    vaultClient.mdbx2SyncStatus(providerId.value).then((status) => { syncStatus.value = status; }).catch(() => undefined)
  ]);
  emit("changed");
}

function snapshotMutationLabel(action: SnapshotMutationAction): string {
  return action === "restore" ? tr('恢复此快照') : tr('永久删除快照');
}

function snapshotMutationButtonLabel(action: SnapshotMutationAction, retry: boolean): string {
  if (action === "restore") return retry ? tr('重试恢复') : tr('确认恢复');
  return retry ? tr('重试删除') : tr('确认删除');
}

function snapshotMutationDescription(action: SnapshotMutationAction): string {
  return action === "restore"
    ? tr('当前保险库将恢复到此快照记录的完整状态。快照之后创建的对象会按 MDBX2 规则写入删除历史，此操作会生成新的同步提交。')
    : tr('此快照及其加密内容将从本地保险库永久删除。当前密码、笔记和附件内容保持不变，删除结果会作为新的同步提交发布。');
}

function emptySnapshotStructure(): SnapshotStructureState {
  return { items: [], loaded: false, totalNodes: 0, currentItemCount: 0, snapshotItemCount: 0 };
}

function resetSnapshotStructures() {
  currentSnapshotStructure.value = emptySnapshotStructure();
  savedSnapshotStructure.value = emptySnapshotStructure();
}

async function stageLocalFile(): Promise<Mdbx2VaultSource> {
  const file = vaultFile.value;
  if (!file) throw new Error(tr('请选择 MDBX2 .mdbx 文件。'));
  if (!file.name.toLocaleLowerCase().endsWith(".mdbx")) throw new Error(tr('MDBX2 可移植备份必须使用 .mdbx 扩展名。'));
  if (!file.size || file.size > MDBX2_MAX_INBOUND_FILE_BYTES) throw new Error(tr('MDBX2 文件为空或超过 2 GiB 安全上限。'));
  const originKey = `local:${file.name}:${file.size}:${file.lastModified}`;
  if (pendingSource.value && pendingOriginKey.value === originKey) return pendingSource.value;
  await releasePendingSource();
  busy.value = "upload";
  const transfer = await vaultClient.beginMdbx2Transfer(file.size);
  try {
    let offset = transfer.nextOffset;
    while (offset < file.size) {
      const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + transfer.maxChunkBytes)).arrayBuffer());
      const accepted = await vaultClient.sendMdbx2Chunk(transfer.transferId, offset, bytes);
      offset = accepted.nextOffset;
      uploadProgress.value = Math.min(100, Math.round((offset / file.size) * 100));
    }
    const finished = await vaultClient.finishMdbx2Transfer(transfer.transferId);
    return await acceptPendingSource({ kind: "file", handle: finished.fileHandle }, originKey);
  } catch (cause) {
    await vaultClient.abortMdbx2Transfer(transfer.transferId).catch(() => undefined);
    throw cause;
  }
}

async function stageRemoteBootstrap(): Promise<Mdbx2VaultSource> {
  if (!remoteFieldsComplete.value) throw new Error(tr('请填写 WebDAV 地址和 Android 兼容远端位置。'));
  const settings = webDavSettings();
  const originKey = `remote:${settings.baseUrl}\n${settings.username}\n${settings.password}\n${settings.remotePath}`;
  if (pendingSource.value && pendingOriginKey.value === originKey) return pendingSource.value;
  await releasePendingSource();
  busy.value = "download";
  const finished = await vaultClient.downloadMdbx2Bootstrap(settings);
  return acceptPendingSource({ kind: "file", handle: finished.fileHandle }, originKey);
}

async function acceptPendingSource(source: Mdbx2VaultSource, originKey: string): Promise<Mdbx2VaultSource> {
  pendingSource.value = source;
  pendingOriginKey.value = originKey;
  try {
    inspection.value = await vaultClient.inspectMdbx2Vault(source);
    return source;
  } catch (cause) {
    await releasePendingSource();
    throw cause;
  }
}

async function releasePendingSource() {
  const source = pendingSource.value;
  pendingSource.value = undefined;
  pendingOriginKey.value = "";
  inspection.value = undefined;
  if (source?.kind === "file") await vaultClient.releaseMdbx2File(source.handle).catch(() => undefined);
}

async function buildCredential(): Promise<Mdbx2VaultCredential> {
  if (form.unlockMethod === "password") return { method: "password", password: form.vaultPassword };
  const file = securityKeyFile.value;
  if (!file) throw new Error(tr('所选解锁方式需要安全密钥文件。'));
  if (!file.size || file.size > 64 * 1024) throw new Error(tr('MDBX2 安全密钥文件为空或超过 64 KiB 上限。'));
  const keyMaterialBase64 = await fileAsBase64(file);
  return form.unlockMethod === "security-key"
    ? { method: "security-key", keyMaterialBase64 }
    : { method: "password-security-key", password: form.vaultPassword, keyMaterialBase64 };
}

function webDavSettings(): Mdbx2WebDavSettingsInput {
  return {
    baseUrl: form.baseUrl.trim(),
    username: form.username.trim(),
    password: form.webDavPassword,
    remotePath: form.remotePath.trim()
  };
}

function closeDialog() {
  if (dialogLocked.value) return;
  if (healthRepairAttempted.value && healthRepairError.value && !healthRepairRecovery.value) {
    healthRepairError.value = tr('这次处理已经发送到 Native Host。请使用同一按钮重试，或选择“改为核对状态”后再关闭，避免丢失可恢复的操作标识。');
    void focusHealthRepairStep();
    return;
  }
  void releasePendingSource();
  clearSecrets();
  clearHealthRepairReview();
  clearCollections();
  clearSnapshots();
  clearHistory();
  clearConflicts();
  emit("close");
}

function clearSecrets() {
  form.vaultPassword = "";
  form.webDavPassword = "";
  securityKeyFile.value = null;
  revealVaultPassword.value = false;
}

function clearHistory() {
  historyItems.value = [];
  historyCursor.value = undefined;
  historyLoaded.value = false;
  historyBusy.value = "";
  historyError.value = "";
  selectedCommitId.value = "";
  commitDiffItems.value = [];
  pendingHistoryRevert.value = undefined;
}

function clearCollections() {
  activeCollections.value = [];
  deletedCollections.value = [];
  activeCollectionCursor.value = undefined;
  deletedCollectionCursor.value = undefined;
  activeCollectionsLoaded.value = false;
  deletedCollectionsLoaded.value = false;
  collectionView.value = "active";
  collectionBusy.value = "";
  collectionLoadCount.value = 0;
  collectionError.value = "";
  pendingCollectionMutation.value = undefined;
}

function clearSnapshots() {
  snapshotItems.value = [];
  snapshotCursor.value = undefined;
  snapshotLoaded.value = false;
  snapshotBusy.value = "";
  snapshotError.value = "";
  snapshotName.value = "";
  selectedSnapshotId.value = "";
  snapshotStructureMode.value = "snapshot";
  resetSnapshotStructures();
  pendingSnapshotCreate.value = undefined;
  pendingSnapshotMutation.value = undefined;
  pendingSnapshotPrune.value = undefined;
  snapshotRequiresRefresh.value = false;
}

function clearConflicts() {
  conflictItems.value = [];
  conflictCursor.value = undefined;
  conflictLoaded.value = false;
  conflictBusy.value = "";
  conflictError.value = "";
  selectedConflictId.value = "";
  pendingConflictResolution.value = undefined;
}

function hostStateLabel(status: Mdbx2HostStatus | null): string {
  if (!status) return tr('检查中');
  return ({ ready: tr('Host 已就绪'), "not-installed": tr('Host 未安装'), incompatible: tr('Host 版本不兼容'), unavailable: tr('Host 暂不可用') } as const)[status.availability];
}

function hostStateClass(status: Mdbx2HostStatus | null): string {
  return status?.availability === "ready" ? "ready" : status ? "attention" : "neutral";
}

function syncNotice(result: { warnings: string[]; conflicts: number }, fallback: string): string {
  if (result.conflicts) return tr('{0} 检测到 {1} 个需要人工处理的冲突。', { 0: fallback, 1: result.conflicts });
  return result.warnings[0] || fallback;
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error(tr('无法读取文件：{0}', { 0: file.name })));
    reader.onload = () => {
      if (typeof reader.result !== "string") return void reject(new Error(tr('无法读取文件：{0}', { 0: file.name })));
      const separator = reader.result.indexOf(",");
      if (separator < 0) return void reject(new Error(tr('文件编码无效：{0}', { 0: file.name })));
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : tr('MDBX2 操作失败。');
}

function errorCode(cause: unknown): string {
  return cause && typeof cause === "object" && "code" in cause ? String((cause as { code?: unknown }).code || "") : "";
}

function diagnosticsErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "vault-diagnostics-result-too-large") return tr('诊断摘要超过 Native Messaging 安全上限，保险库内容没有被修改。');
  if (code === "vault-diagnostics-failed" || code === "vault-health-check-failed") return tr('Native Host 无法完成只读健康检查。请保留本机副本并重试；此操作不会尝试修复数据。');
  if (code === "vault-locked") return tr('保险库已经锁定，请重新解锁后刷新诊断。');
  if (code === "native-host-incompatible") return tr('Native Host 返回了不兼容的诊断摘要。请更新 Host 后再试。');
  if (code === "native-host-disconnected") return tr('Native Host 在健康检查期间断开。上次诊断结果仍可查看，可以安全重试。');
  return errorMessage(cause);
}

function healthRepairErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "health-repair-plan-too-large" || code === "health-repair-result-too-large") return tr('可处理问题超过浏览器审核的 500 项或 64 KiB 响应上限。没有执行部分修复，请先在桌面端处理或缩小问题范围。');
  if (code === "health-repair-plan-stale") return tr('保险库在计划生成后已经变化，旧计划已安全失效且没有重复写入。请刷新状态并重新检查。');
  if (code === "health-repair-plan-unknown") return tr('Native Host 已不再保留这份处理计划。没有执行写入，请重新检查可处理问题。');
  if (code === "health-repair-outcome-unknown") return tr('Native Host 无法证明这次处理是否已经提交。不要选择相反结果；请刷新诊断、快照与提交历史进行核对。');
  if (code === "health-repair-intent-mismatch") return tr('重试使用了不同的操作标识或选择，Native Host 已拒绝写入。请刷新状态后生成新计划。');
  if (code === "health-repair-decisions-incomplete") return tr('每个内容与删除状态冲突都必须选择一次。请返回检查遗漏项。');
  if (code === "health-repair-blocked") return tr('仍存在不能自动处理的严重完整性问题。没有执行修复，请先按诊断建议处理阻断项。');
  if (code === "health-repair-authorization-required") return tr('MDBX2 安全策略要求重新验证后再处理。请重新解锁本机副本，并使用同一确认按钮重试。');
  if (code === "health-repair-delete-confirmation-required") return tr('删除选择缺少独立危险确认，后台已在 Native Messaging 前拒绝操作。');
  if (code === "native-host-disconnected" || code === "native-request-timeout") return tr('Native Host 在处理期间断开，原操作标识和选择仍保留。请使用同一“重试处理”按钮恢复，或改为刷新状态核对结果。');
  if (code === "vault-locked") return tr('保险库已经锁定。请重新解锁后刷新状态，再生成新的处理计划。');
  if (code === "native-host-incompatible") return tr('Native Host 返回了不兼容的健康修复数据。请更新 Host，刷新状态后重新检查。');
  return errorMessage(cause);
}

function tigaErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "vault-tiga-result-too-large") return tr('Tiga 安全态势超过 Native Messaging 安全上限，保险库内容没有被修改。');
  if (code === "vault-tiga-failed" || code === "vault-tiga-inconsistent") return tr('Native Host 无法生成一致的只读 Tiga 安全态势。请更新 Host 或重新解锁后重试。');
  if (code === "vault-locked") return tr('保险库已经锁定，请重新解锁后刷新 Tiga 安全态势。');
  if (code === "native-host-incompatible") return tr('Native Host 返回了不兼容的 Tiga 安全态势。请更新 Host 后再试。');
  if (code === "native-host-disconnected") return tr('Native Host 在读取安全态势期间断开。上次有效结果仍可查看，可以安全重试。');
  return errorMessage(cause);
}

function snapshotErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "snapshot-result-too-large") return tr('快照记录超过单次安全上限，请缩小分页后重试。');
  if (code === "snapshot-structure-too-large") return tr('快照结构超过浏览器可安全展示的节点上限；快照本身仍保留在保险库中。');
  if (code === "snapshot-structure-stale") return tr('保险库内容在结构分页期间发生变化，请重新打开此快照预览。');
  if (code === "snapshot-integrity-failed") return tr('快照完整性校验失败，结构预览和恢复均已停止；可以保留记录用于诊断或确认后删除。');
  if (code === "snapshot-operation-state-unknown") return tr('Native Host 无法证明快照操作的最终结果。请刷新快照和提交历史，确认当前状态后再继续；不要立即重复恢复或删除。');
  if (code === "snapshot-operation-pending") return tr('此保险库已有一项快照操作等待确认，请重试原操作或刷新快照状态。');
  if (code === "snapshot-operation-mismatch") return tr('快照重试内容与先前操作不一致，请刷新状态后重新选择。');
  if (code === "snapshot-not-found") return tr('此快照已被其他操作删除，请刷新快照列表。');
  if (code === "snapshot-name-invalid") return tr('快照名称超过 96 个 UTF-8 字节，请缩短后重试。');
  if (code === "snapshot-prune-plan-stale") return tr('自动快照集合或保留状态已经变化，旧计划已安全失效。请重新检查可清理项。');
  if (code === "snapshot-prune-plan-empty") return tr('此清理计划已没有符合条件的自动快照，请刷新后重新检查。');
  if (code === "snapshot-prune-authorization-required") return tr('MDBX2 安全策略要求重新解锁保险库后再清理自动快照。');
  if (code === "snapshot-prune-inspection-failed") return tr('Native Host 无法安全验证自动快照保留状态；没有执行删除。');
  if (code === "native-host-disconnected") return tr('Native Host 在清理期间断开。原计划令牌已经保留，请使用同一确认按钮安全重试。');
  return errorMessage(cause);
}

function collectionErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "collection-result-too-large") return tr('文件夹列表超过单次安全响应上限，请减少每页数量后重试。');
  if (code === "collection-title-invalid" || code === "params-invalid") return tr('文件夹名称不能为空，且最多为 4096 个 UTF-8 字节。');
  if (code === "collection-root-protected" || code === "collection-parent-invalid") return tr('MDBX2 根目录受保护；顶层文件夹应选择“顶层”，文件夹也不能成为自己的父级。');
  if (code === "collection-state-conflict") return tr('当前文件夹状态不允许此操作。请确认名称未重复、父级有效，并在删除前移走条目和子文件夹。');
  if (code === "collection-operation-mismatch") return tr('此操作标识已用于另一项文件夹修改，已生成新的操作标识；核对当前状态后可以重试。');
  if (code === "collection-authorization-required") return tr('MDBX2 安全策略要求重新解锁保险库后再修改文件夹。');
  if (code === "native-host-disconnected") return tr('Native Host 在文件夹写入期间断开。原操作标识已保留，请使用同一按钮安全重试。');
  return errorMessage(cause);
}

function historyErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "history-diff-too-large") return tr('这次提交包含的对象过多，当前版本无法一次展开全部详情；提交记录本身仍然有效。');
  if (code === "history-result-too-large") return tr('历史记录内容超过单次安全上限，请缩小分页后重试。');
  if (code === "history-revert-not-allowed") return tr('这次提交包含数据库级事件、非条目对象或超过 500 个项目，无法从浏览器管理页恢复。');
  if (code === "history-revert-not-found") return tr('这次提交已不存在，请刷新历史记录。');
  if (code === "history-revert-too-large") return tr('这次提交超过 500 个可恢复对象，Core 已停止恢复操作。');
  if (code === "history-revert-operation-mismatch") return tr('恢复操作标识已用于另一项历史操作，请刷新记录后重新选择。');
  if (code === "history-revert-authorization-required") return tr('MDBX2 安全策略要求重新解锁保险库后再恢复历史版本。');
  if (code === "native-host-disconnected") return tr('Native Host 连接在恢复期间中断。原操作标识已经保留，可以使用同一确认按钮安全重试，或刷新历史确认结果。');
  return errorMessage(cause);
}

function conflictErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "conflict-result-too-large") return tr('冲突记录超过单次安全上限，请缩小分页后重试。');
  if (code === "conflict-resolution-state-unknown") return tr('Native Host 在写入冲突决定时异常中断，无法确认最终采用了哪个版本。请先刷新数据库，不要立即选择相反版本。');
  if (code === "conflict-not-found") return tr('这个冲突已被其他操作处理，请刷新冲突列表。');
  return errorMessage(cause);
}
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section class="editor-dialog provider-dialog mdbx2-dialog" :class="{ 'new-source-dialog': !isExisting }" role="dialog" aria-modal="true" aria-labelledby="mdbx2-dialog-title">
      <header>
        <div>
          <h2 id="mdbx2-dialog-title">{{ dialogTitle }}</h2>
          <p>{{ tr('浏览器保存本机加密工作副本，网盘只交换可移植备份、增量段和加密 Blob。') }}</p>
        </div>
        <m3e-icon-button data-dialog-close :aria-label="tr('关闭 MDBX2 设置')" :disabled="dialogLocked" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <form class="provider-form mdbx2-form" @submit.prevent="isExisting ? saveSettings() : connectNewSource()">
        <div class="mdbx2-host-row field-wide" :class="hostStateClass(hostStatus)" role="status" aria-live="polite">
          <m3e-icon :name="hostReady ? 'check_circle' : 'computer'" />
          <div><strong>{{ hostStateLabel(hostStatus) }}</strong><small>{{ hostStatus?.message || tr('正在检查本地连接服务。') }}</small></div>
          <small v-if="hostStatus?.capabilities">Host {{ hostStatus.capabilities.hostVersion }} · Core {{ hostStatus.capabilities.mdbxCoreRevision.slice(0, 8) }}</small>
        </div>

        <template v-if="!isExisting">
          <fieldset class="mdbx2-mode-picker field-wide">
            <legend>{{ tr('加入方式') }}</legend>
            <div>
              <button type="button" :aria-pressed="form.mode === 'local'" :class="{ active: form.mode === 'local' }" :disabled="Boolean(busy)" @click="setMode('local')"><m3e-icon name="folder_open" />{{ tr('本地 .mdbx 文件') }}</button>
              <button type="button" :aria-pressed="form.mode === 'remote'" :class="{ active: form.mode === 'remote' }" :disabled="Boolean(busy)" @click="setMode('remote')"><m3e-icon name="cloud_download" />{{ tr('从 WebDAV 加入') }}</button>
            </div>
          </fieldset>
          <label class="field"><span>{{ tr('显示名称') }}</span><input v-model="form.name" autocomplete="off" autofocus placeholder="Monica MDBX2" /></label>
          <label class="favorite-row"><input v-model="form.isDefaultSaveTarget" type="checkbox" /><span>{{ tr('设为新项目的默认保存目标') }}</span></label>
        </template>

        <template v-if="!isExisting && form.mode === 'local'">
          <div class="field field-wide"><span>{{ tr('MDBX2 可移植备份 *') }}</span><label class="file-action provider-file-action"><m3e-icon name="folder_open" /><span>{{ vaultFile?.name || tr('选择 .mdbx 文件') }}</span><input type="file" accept=".mdbx,application/octet-stream" :aria-label="tr('MDBX2 可移植备份')" @change="selectVaultFile" /></label><small>{{ tr('扩展从 MDBX2 开始支持；MDBX1 和 MDBX1-DRAFT 会在只读检查阶段拒绝。') }}</small></div>
        </template>

        <template v-if="form.mode === 'remote' || isExisting">
          <label v-if="isExisting" class="field"><span>{{ tr('显示名称') }}</span><input v-model="form.name" autocomplete="off" /></label>
          <label v-if="isExisting" class="favorite-row"><input v-model="form.isDefaultSaveTarget" type="checkbox" /><span>{{ tr('设为新项目的默认保存目标') }}</span></label>
          <label class="field field-wide"><span>{{ tr('WebDAV 地址 *') }}</span><input v-model="form.baseUrl" type="url" autocomplete="url" placeholder="https://cloud.example.com/remote.php/dav/files/user" required /><small>{{ tr('必须使用 HTTPS；开发环境仅允许回环 HTTP。地址中不能包含用户名、密码、查询参数或片段。') }}</small></label>
          <label class="field"><span>{{ tr('用户名') }}</span><input v-model="form.username" autocomplete="username" /></label>
          <label class="field"><span>{{ tr('WebDAV 密码') }}</span><input v-model="form.webDavPassword" type="password" autocomplete="current-password" :placeholder="form.webDavPasswordConfigured ? tr('已加密保存；留空保持不变') : ''" /></label>
          <label class="field field-wide"><span>{{ tr('Android 兼容远端位置 *') }}</span><input v-model="form.remotePath" autocomplete="off" placeholder="Monica/MDBX2/main.mdbx" required /><small>{{ tr('此路径就是可移植 .mdbx 文件；日常同步对象自动写入同名') }}<code>.sync</code>{{ tr('目录。') }}</small></label>
        </template>

        <template v-if="!isExisting || !vaultOpen">
          <label class="field"><span>{{ tr('解锁方式') }}</span><select v-model="form.unlockMethod"><option value="password">{{ tr('密码') }}</option><option value="security-key">{{ tr('安全密钥') }}</option><option value="password-security-key">{{ tr('密码 + 安全密钥') }}</option></select></label>
          <label v-if="form.unlockMethod !== 'security-key'" class="field"><span>{{ tr('保险库密码（可留空）') }}</span><div class="password-field"><input v-model="form.vaultPassword" :type="revealVaultPassword ? 'text' : 'password'" autocomplete="current-password" /><button type="button" @click="revealVaultPassword = !revealVaultPassword">{{ revealVaultPassword ? tr('隐藏') : tr('显示') }}</button></div></label>
          <div v-if="needsSecurityKey" class="field field-wide"><span>{{ tr('安全密钥文件 *') }}</span><label class="file-action provider-file-action secondary"><m3e-icon name="key" /><span>{{ securityKeyFile?.name || tr('选择最大 64 KiB 的安全密钥文件') }}</span><input type="file" :aria-label="tr('MDBX2 安全密钥文件')" @change="selectSecurityKey" /></label><small>{{ tr('密码和安全密钥只进入 Native Host 的本次解锁调用，不会保存到插件密码库。') }}</small></div>
        </template>

        <div v-if="inspection" class="mdbx2-inspection field-wide" role="status">
          <span><strong>{{ inspection.formatVersion }}</strong><small>{{ tr('格式') }}</small></span>
          <span><strong>{{ inspection.schemaVersion ?? '—' }}</strong><small>Schema</small></span>
          <span><strong>{{ inspection.requiresUpgrade ? tr('需要迁移') : tr('当前版本') }}</strong><small>{{ tr('打开前检查') }}</small></span>
        </div>

        <div v-if="isExisting" class="mdbx2-runtime-summary field-wide" :aria-label="tr('MDBX2 运行状态')">
          <span><strong>{{ runtimeStatus?.available ? tr('本机副本可用') : tr('本机副本缺失') }}</strong><small>{{ vaultOpen ? tr('当前已解锁') : tr('当前已锁定') }}</small></span>
          <span><strong>{{ syncStatus?.initialized ? tr('增量同步已注册') : syncStatus?.configured ? tr('WebDAV 已配置') : tr('仅本机模式') }}</strong><small>{{ syncStatus?.hasLocalChanges ? tr('存在待发布修改') : tr('checkpoint 已保存') }}</small></span>
          <span><strong>{{ tr('{0} 个受阻 stream', { 0: syncStatus?.blockedStreamCount || 0 }) }}</strong><small>{{ tr('{0} 个远端 stream', { 0: syncStatus?.remoteStreamCount || 0 }) }}</small></span>
        </div>

        <section
          v-if="isExisting && vaultOpen"
          class="mdbx2-diagnostics-panel field-wide"
          :aria-busy="diagnosticsBusy"
          aria-labelledby="mdbx2-diagnostics-title"
        >
          <div class="mdbx2-diagnostics-header">
            <div>
              <strong id="mdbx2-diagnostics-title">{{ tr('保险库诊断') }}</strong>
              <small>{{ tr('只显示健康类别和聚合数量；本机路径、Vault／Device ID、原始描述与对象标识不会进入管理页。') }}</small>
            </div>
            <div class="mdbx2-diagnostics-actions">
              <m3e-button
                v-if="vaultDiagnostics?.health.issueCount && !healthRepairPlan"
                variant="tonal"
                type="button"
                :aria-label="tr('检查 Native Host 可安全处理的问题')"
                :disabled="diagnosticsBusy || managerMutationLocked"
                @click="requestHealthRepairPlan"
              ><m3e-icon slot="icon" name="healing"></m3e-icon>{{ healthRepairBusy === 'plan' ? tr('正在分析…') : tr('检查可处理问题') }}</m3e-button>
              <m3e-button
                variant="tonal"
                type="button"
                :aria-label="tr('刷新保险库诊断')"
                :disabled="diagnosticsBusy || managerMutationLocked || Boolean(healthRepairPlan)"
                @click="loadVaultDiagnostics"
              ><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ diagnosticsBusy ? tr('正在检查…') : tr('刷新诊断') }}</m3e-button>
            </div>
          </div>

          <p v-if="diagnosticsError" class="form-error mdbx2-diagnostics-error" role="alert">{{ diagnosticsError }}</p>
          <p v-if="healthRepairError && !healthRepairPlan" class="form-error mdbx2-health-repair-error" role="alert">{{ healthRepairError }}</p>
          <div v-if="diagnosticsBusy && !vaultDiagnostics" class="mdbx2-diagnostics-empty" role="status" aria-live="polite">
            <m3e-icon name="progress_activity" />
            <span>{{ tr('正在执行只读健康检查…') }}</span>
          </div>

          <template v-if="vaultDiagnostics && diagnosticHealth">
            <div class="mdbx2-diagnostics-health" :data-tone="diagnosticHealth.tone" aria-live="polite">
              <span class="mdbx2-diagnostics-health-icon"><m3e-icon :name="diagnosticHealth.icon" /></span>
              <div class="mdbx2-diagnostics-health-copy">
                <strong>{{ diagnosticHealth.headline }}</strong>
                <small>{{ diagnosticHealth.supporting }}</small>
                <small class="mdbx2-diagnostics-health-meta">
                  <time :datetime="new Date(vaultDiagnostics.checkedAtUnixSeconds * 1000).toISOString()">{{ formatMdbx2DiagnosticTime(vaultDiagnostics.checkedAtUnixSeconds) }}</time>
                  · {{ vaultDiagnostics.formatVersion }} · Schema {{ vaultDiagnostics.schemaVersion }}
                </small>
              </div>
              <span class="mdbx2-diagnostics-severity-summary">{{ summarizeMdbx2HealthCounts(vaultDiagnostics.health) }}</span>
            </div>

            <section
              v-if="healthRepairPlan"
              ref="healthRepairPanel"
              class="mdbx2-health-repair"
              :data-recovery="healthRepairRecovery || undefined"
              tabindex="-1"
              aria-labelledby="mdbx2-health-repair-title"
              :aria-busy="Boolean(healthRepairBusy)"
            >
              <div class="mdbx2-health-repair-heading">
                <span class="mdbx2-health-repair-heading-icon"><m3e-icon :name="healthRepairRecovery ? 'sync_problem' : healthRepairPlan.canApply ? 'healing' : 'shield_lock'" /></span>
                <div>
                  <strong id="mdbx2-health-repair-title">{{ healthRepairRecovery === 'unknown' ? tr('需要核对处理结果') : healthRepairRecovery === 'stale' ? tr('处理计划需要更新') : healthRepairPlan.canApply ? tr('健康修复计划') : tr('当前不能自动处理') }}</strong>
                  <small v-if="!healthRepairRecovery">{{ healthRepairPlan.canApply ? tr('将处理 {0} 项；写入前会创建恢复快照，并在一个事务内完成。', { 0: formatMdbx2DiagnosticCount(healthRepairPlan.itemCount) }) : tr('发现 {0} 个阻断问题；当前计划不会写入保险库。', { 0: formatMdbx2DiagnosticCount(healthRepairPlan.blockerCount) }) }}</small>
                  <small v-else>{{ healthRepairRecovery === 'unknown' ? tr('不要立即选择相反结果；先刷新诊断、快照、历史与同步状态。') : tr('旧计划已经安全停止，刷新状态后再生成新计划。') }}</small>
                </div>
                <span v-if="healthRepairPlan.canApply && !healthRepairRecovery" class="mdbx2-health-repair-count">{{ tr('{0} 自动 · {1} 待选择', { 0: formatMdbx2DiagnosticCount(healthRepairPlan.automaticCount), 1: formatMdbx2DiagnosticCount(healthRepairPlan.conflictCount) }) }}</span>
              </div>

              <p v-if="healthRepairError" class="form-error mdbx2-health-repair-error" role="alert">{{ healthRepairError }}</p>

              <div v-if="healthRepairRecovery" class="mdbx2-health-repair-recovery" role="status" aria-live="polite">
                <div class="mdbx2-health-repair-safety-note">
                  <m3e-icon name="manage_search" />
                  <span>{{ tr('刷新只读取聚合状态，不会重复执行修复。完成核对后，需要重新点击“检查可处理问题”。') }}</span>
                </div>
                <div class="mdbx2-health-repair-actions">
                  <m3e-button variant="text" type="button" :disabled="Boolean(healthRepairBusy)" @click="clearHealthRepairReview">{{ tr('关闭计划') }}</m3e-button>
                  <m3e-button variant="filled" type="button" :disabled="Boolean(healthRepairBusy)" @click="reconcileHealthRepairState"><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ healthRepairBusy === 'refresh' ? tr('正在刷新…') : tr('刷新并核对状态') }}</m3e-button>
                </div>
              </div>

              <template v-else>
                <div v-if="healthRepairPlan.automatic.length" class="mdbx2-health-repair-automatic" aria-labelledby="mdbx2-health-repair-automatic-title">
                  <div class="mdbx2-health-repair-section-title">
                    <strong id="mdbx2-health-repair-automatic-title">{{ tr('自动处理') }}</strong>
                    <small>{{ tr('这些项目没有歧义，不需要逐项选择。') }}</small>
                  </div>
                  <div class="mdbx2-health-repair-list" role="list">
                    <div v-for="item in healthRepairPlan.automatic" :key="`${item.kind}:${item.objectType}`" class="mdbx2-health-repair-row" role="listitem">
                      <span class="mdbx2-health-repair-row-icon"><m3e-icon :name="presentMdbx2HealthRepairAutomatic(item).icon" /></span>
                      <span><strong>{{ presentMdbx2HealthRepairAutomatic(item).title }}</strong><small>{{ presentMdbx2HealthRepairAutomatic(item).supporting }}</small></span>
                      <strong>{{ tr('{0} 项', { 0: formatMdbx2DiagnosticCount(item.itemCount) }) }}</strong>
                    </div>
                  </div>
                </div>

                <div v-if="!healthRepairPlan.canApply" class="mdbx2-health-repair-blockers" aria-labelledby="mdbx2-health-repair-blockers-title">
                  <div class="mdbx2-health-repair-section-title">
                    <strong id="mdbx2-health-repair-blockers-title">{{ tr('必须先处理的阻断项') }}</strong>
                    <small>{{ tr('只显示受控健康类别和数量；底层描述、路径和对象标识仍留在 Native Host。') }}</small>
                  </div>
                  <div class="mdbx2-health-repair-list" role="list">
                    <div v-for="blocker in healthRepairPlan.blockers" :key="blocker.category" class="mdbx2-health-repair-row danger" role="listitem">
                      <span class="mdbx2-health-repair-row-icon"><m3e-icon name="error" /></span>
                      <span><strong>{{ mdbx2HealthCategoryLabel(blocker.category) }}</strong><small>{{ tr('此类别包含不能由删除标记修复流程自动解决的严重问题。') }}</small></span>
                      <strong>{{ tr('{0} 项', { 0: formatMdbx2DiagnosticCount(blocker.count) }) }}</strong>
                    </div>
                  </div>
                  <div class="mdbx2-health-repair-actions">
                    <m3e-button variant="text" type="button" :disabled="Boolean(healthRepairBusy)" @click="cancelHealthRepairFlow">{{ tr('关闭计划') }}</m3e-button>
                    <m3e-button variant="tonal" type="button" :disabled="Boolean(healthRepairBusy)" @click="reconcileHealthRepairState"><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ tr('刷新全部状态') }}</m3e-button>
                  </div>
                </div>

                <div v-else-if="currentHealthRepairConflict" class="mdbx2-health-repair-conflict" aria-labelledby="mdbx2-health-repair-conflict-title">
                  <div class="mdbx2-health-repair-progress" role="status" aria-live="polite">
                    <span>{{ tr('选择 {0} / {1}', { 0: healthRepairConflictIndex + 1, 1: healthRepairPlan.conflictCount }) }}</span>
                    <progress :value="healthRepairConflictIndex + 1" :max="healthRepairPlan.conflictCount" />
                  </div>
                  <div class="mdbx2-health-repair-conflict-copy">
                    <span class="mdbx2-health-repair-conflict-icon"><m3e-icon :name="presentMdbx2HealthRepairConflict(currentHealthRepairConflict).icon" /></span>
                    <div>
                      <strong id="mdbx2-health-repair-conflict-title">{{ presentMdbx2HealthRepairConflict(currentHealthRepairConflict).title }}</strong>
                      <small>{{ presentMdbx2HealthRepairConflict(currentHealthRepairConflict).supporting }}</small>
                    </div>
                  </div>
                  <div v-if="healthRepairDeleteConfirmation !== currentHealthRepairConflict.itemHandle" class="mdbx2-health-repair-choice-copy">
                    <div><strong>{{ tr('保留内容') }}</strong><small>{{ tr('移除异常删除标记，保留当前内容和后续编辑能力。') }}</small></div>
                    <div><strong>{{ tr('删除项目') }}</strong><small>{{ tr('软删除当前项目，并归一为一个可同步的删除标记。') }}</small></div>
                  </div>
                  <div v-if="healthRepairDeleteConfirmation !== currentHealthRepairConflict.itemHandle" class="mdbx2-health-repair-actions">
                    <m3e-button variant="text" type="button" :disabled="Boolean(healthRepairBusy)" @click="cancelHealthRepairFlow">{{ tr('取消全部') }}</m3e-button>
                    <m3e-button v-if="healthRepairConflictIndex" variant="text" type="button" :disabled="Boolean(healthRepairBusy)" @click="previousHealthRepairConflict">{{ tr('上一步') }}</m3e-button>
                    <m3e-button variant="tonal" type="button" :disabled="Boolean(healthRepairBusy)" @click="chooseHealthRepairKeep"><m3e-icon slot="icon" name="check_circle"></m3e-icon>{{ tr('保留内容') }}</m3e-button>
                    <m3e-button class="mdbx2-health-repair-delete" variant="tonal" type="button" :disabled="Boolean(healthRepairBusy)" @click="requestHealthRepairDelete"><m3e-icon slot="icon" name="delete"></m3e-icon>{{ tr('删除项目') }}</m3e-button>
                  </div>
                  <div v-else class="mdbx2-health-repair-delete-confirmation" role="group" aria-labelledby="mdbx2-health-repair-delete-title" aria-live="assertive">
                    <span class="mdbx2-health-repair-delete-icon"><m3e-icon name="warning" /></span>
                    <div><strong id="mdbx2-health-repair-delete-title">{{ tr('确认删除这个项目？') }}</strong><small>{{ tr('项目内容会被软删除并保留一个规范的同步删除标记；修复前仍会创建恢复快照。此选择不会默认勾选。') }}</small></div>
                    <div class="mdbx2-health-repair-actions">
                      <m3e-button variant="text" type="button" :disabled="Boolean(healthRepairBusy)" @click="cancelHealthRepairDelete">{{ tr('返回选择') }}</m3e-button>
                      <m3e-button ref="confirmHealthRepairDeleteButton" class="mdbx2-health-repair-delete" variant="filled" type="button" :aria-label="tr('确认删除项目并继续')" :disabled="Boolean(healthRepairBusy)" @click="confirmHealthRepairDelete">{{ tr('确认删除并继续') }}</m3e-button>
                    </div>
                  </div>
                </div>

                <div v-else-if="healthRepairReviewReady" class="mdbx2-health-repair-review" aria-labelledby="mdbx2-health-repair-review-title">
                  <div class="mdbx2-health-repair-section-title">
                    <strong id="mdbx2-health-repair-review-title">{{ tr('复核处理计划') }}</strong>
                    <small>{{ tr('提交后会先创建恢复快照，再在一个事务中应用全部选择。取消不会写入。') }}</small>
                  </div>
                  <dl class="mdbx2-health-repair-review-counts">
                    <div><dt>{{ tr('自动处理') }}</dt><dd>{{ formatMdbx2DiagnosticCount(healthRepairPlan.automaticCount) }}</dd></div>
                    <div><dt>{{ tr('保留内容') }}</dt><dd>{{ formatMdbx2DiagnosticCount(healthRepairKeepCount) }}</dd></div>
                    <div><dt>{{ tr('删除项目') }}</dt><dd>{{ formatMdbx2DiagnosticCount(healthRepairDeleteCount) }}</dd></div>
                  </dl>
                  <div class="mdbx2-health-repair-safety-note">
                    <m3e-icon name="backup" />
                    <span>{{ tr('底层计划令牌和数据库技术标识不会进入页面；这里只保留本次安全重试所需的不透明句柄和选择。') }}</span>
                  </div>
                  <div class="mdbx2-health-repair-actions">
                    <m3e-button v-if="!healthRepairAttempted" variant="text" type="button" :disabled="Boolean(healthRepairBusy)" @click="cancelHealthRepairFlow">{{ tr('取消全部') }}</m3e-button>
                    <m3e-button v-if="healthRepairPlan.conflictCount && !healthRepairAttempted" variant="text" type="button" :disabled="Boolean(healthRepairBusy)" @click="previousHealthRepairConflict">{{ tr('返回上一项') }}</m3e-button>
                    <m3e-button v-if="healthRepairAttempted && healthRepairError" variant="text" type="button" :disabled="Boolean(healthRepairBusy)" @click="reviewHealthRepairOutcomeInstead">{{ tr('改为核对状态') }}</m3e-button>
                    <m3e-button
                      ref="applyHealthRepairButton"
                      variant="filled"
                      type="button"
                      :aria-label="healthRepairAttempted ? tr('重试健康修复处理') : tr('创建恢复快照并处理健康修复计划')"
                      :disabled="Boolean(healthRepairBusy)"
                      @click="applyHealthRepair"
                    ><m3e-icon slot="icon" name="build_circle"></m3e-icon>{{ healthRepairBusy === 'apply' ? tr('正在处理…') : healthRepairAttempted ? tr('重试处理') : tr('确认处理') }}</m3e-button>
                  </div>
                </div>
              </template>
            </section>

            <div v-if="diagnosticGuidance.length" class="mdbx2-health-guidance-list" aria-labelledby="mdbx2-health-guidance-title">
              <div class="mdbx2-health-guidance-heading">
                <strong id="mdbx2-health-guidance-title">{{ tr('建议处理') }}</strong>
                <small>{{ tr('按影响优先显示恢复步骤；只使用 Native Host 返回的脱敏原因码，不显示底层描述或标识。') }}</small>
              </div>
              <details
                v-for="guidance in diagnosticGuidance"
                :key="guidance.kind"
                class="mdbx2-health-guidance-row"
                :data-severity="guidance.severity"
              >
                <summary>
                  <span class="mdbx2-health-guidance-icon"><m3e-icon :name="guidance.icon" /></span>
                  <span class="mdbx2-health-guidance-copy">
                    <strong>{{ guidance.title }}</strong>
                    <small>{{ guidance.summary }}</small>
                  </span>
                  <span class="mdbx2-health-guidance-severity">{{ tr('{0} · {1} 项', { 0: mdbx2HealthSeverityLabel(guidance.severity), 1: formatMdbx2DiagnosticCount(guidance.count) }) }}</span>
                  <m3e-icon class="mdbx2-health-guidance-chevron" name="expand_more" />
                </summary>
                <div class="mdbx2-health-guidance-body">
                  <div>
                    <strong>{{ tr('可能影响') }}</strong>
                    <p>{{ guidance.impact }}</p>
                  </div>
                  <div>
                    <strong>{{ tr('建议步骤') }}</strong>
                    <ol><li v-for="step in guidance.steps" :key="step">{{ step }}</li></ol>
                  </div>
                  <m3e-button
                    variant="tonal"
                    type="button"
                    :disabled="guidance.action === 'recheck' && (diagnosticsBusy || managerMutationLocked)"
                    @click="activateHealthGuidance(guidance.action)"
                  ><m3e-icon slot="icon" :name="guidance.actionIcon"></m3e-icon>{{ guidance.actionLabel }}</m3e-button>
                </div>
              </details>
            </div>

            <dl class="mdbx2-diagnostics-key-facts" :aria-label="tr('MDBX2 诊断概览')">
              <div><dt>{{ tr('主文件') }}</dt><dd>{{ formatMdbx2SnapshotBytes(vaultDiagnostics.fileSizeBytes) }}</dd></div>
              <div><dt>{{ tr('未解决冲突') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.unresolvedConflictCount) }}</dd></div>
              <div><dt>{{ tr('文件夹') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.folderCount) }}</dd></div>
              <div><dt>{{ tr('有效条目') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.entryCount) }}</dd></div>
            </dl>

            <div v-if="vaultDiagnostics.health.categories.length" class="mdbx2-diagnostics-category-list" role="list" :aria-label="tr('MDBX2 健康类别')">
              <div
                v-for="category in vaultDiagnostics.health.categories"
                :key="category.category"
                class="mdbx2-diagnostics-category-row"
                :data-severity="category.highestSeverity"
                role="listitem"
              >
                <span class="mdbx2-diagnostics-category-icon"><m3e-icon :name="mdbx2HealthSeverityIcon(category.highestSeverity)" /></span>
                <span class="mdbx2-diagnostics-category-copy">
                  <strong>{{ mdbx2HealthCategoryLabel(category.category) }}</strong>
                  <small>{{ tr('最高级别：{0}', { 0: mdbx2HealthSeverityLabel(category.highestSeverity) }) }}</small>
                </span>
                <span class="mdbx2-diagnostics-category-count">{{ tr('{0} 项', { 0: formatMdbx2DiagnosticCount(category.count) }) }}</span>
              </div>
            </div>

            <details ref="diagnosticsDetails" class="mdbx2-diagnostics-details">
              <summary>
                <m3e-icon name="monitoring" />
                <span><strong>{{ tr('查看聚合统计') }}</strong><small>{{ tr('展开数据库、同步历史与附件规模；不会读取条目标题或内容。') }}</small></span>
                <m3e-icon class="mdbx2-diagnostics-details-chevron" name="expand_more" />
              </summary>
              <div class="mdbx2-diagnostics-stat-groups">
                <section aria-labelledby="mdbx2-diagnostics-data-title">
                  <h3 id="mdbx2-diagnostics-data-title">{{ tr('数据库规模') }}</h3>
                  <dl>
                    <div><dt>{{ tr('有效条目') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.entryCount) }}</dd></div>
                    <div><dt>{{ tr('已删除条目') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.deletedEntryCount) }}</dd></div>
                    <div><dt>{{ tr('文件夹（不含根目录）') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.folderCount) }}</dd></div>
                    <div><dt>{{ tr('目录记录（含系统根）') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.projectCount) }}</dd></div>
                    <div><dt>{{ tr('已删除目录') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.deletedProjectCount) }}</dd></div>
                    <div><dt>{{ tr('数据库快照') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.snapshotCount) }}</dd></div>
                  </dl>
                </section>
                <section aria-labelledby="mdbx2-diagnostics-sync-title">
                  <h3 id="mdbx2-diagnostics-sync-title">{{ tr('同步历史') }}</h3>
                  <dl>
                    <div><dt>{{ tr('提交') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.commitCount) }}</dd></div>
                    <div><dt>{{ tr('分支') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.branchCount) }}</dd></div>
                    <div><dt>{{ tr('设备') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.deviceCount) }}</dd></div>
                    <div><dt>{{ tr('删除标记') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.tombstoneCount) }}</dd></div>
                    <div><dt>{{ tr('未解决冲突') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.unresolvedConflictCount) }}</dd></div>
                  </dl>
                </section>
                <section ref="diagnosticsAttachmentTarget" class="mdbx2-guidance-target" tabindex="-1" aria-labelledby="mdbx2-diagnostics-attachment-title">
                  <h3 id="mdbx2-diagnostics-attachment-title">{{ tr('附件') }}</h3>
                  <dl>
                    <div><dt>{{ tr('有效附件') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.attachmentCount) }}</dd></div>
                    <div><dt>{{ tr('已删除附件') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.deletedAttachmentCount) }}</dd></div>
                    <div><dt>{{ tr('外置加密附件') }}</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.externalAttachmentCount) }}</dd></div>
                    <div><dt>{{ tr('原始体积') }}</dt><dd>{{ formatMdbx2SnapshotBytes(vaultDiagnostics.diagnostics.originalAttachmentBytes) }}</dd></div>
                    <div><dt>{{ tr('加密存储体积') }}</dt><dd>{{ formatMdbx2SnapshotBytes(vaultDiagnostics.diagnostics.storedAttachmentBytes) }}</dd></div>
                  </dl>
                </section>
              </div>
            </details>
          </template>
        </section>

        <section
          v-if="isExisting && vaultOpen"
          class="mdbx2-tiga-panel field-wide"
          :aria-busy="tigaBusy"
          aria-labelledby="mdbx2-tiga-title"
        >
          <div class="mdbx2-tiga-header">
            <div>
              <strong id="mdbx2-tiga-title">{{ tr('Tiga 安全态势') }}</strong>
              <small>{{ tr('只读显示 Sky／Multi／Power、解锁合规与浏览器能力差异；不提供策略修改、例外编辑或审计操作。') }}</small>
            </div>
            <m3e-button
              variant="tonal"
              type="button"
              :aria-label="tr('刷新 Tiga 安全态势')"
              :disabled="tigaBusy || managerMutationLocked"
              @click="loadVaultTiga"
            ><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ tigaBusy ? tr('正在检查…') : tr('刷新态势') }}</m3e-button>
          </div>

          <p v-if="tigaError" class="form-error mdbx2-tiga-error" role="alert">{{ tigaError }}</p>
          <div v-if="tigaBusy && !vaultTiga" class="mdbx2-tiga-empty" role="status" aria-live="polite">
            <m3e-icon name="progress_activity" />
            <span>{{ tr('正在读取只读 Tiga 策略与解锁态势…') }}</span>
          </div>

          <template v-if="vaultTiga && tigaPresentation">
            <div class="mdbx2-tiga-overview" :data-tone="tigaPresentation.tone" aria-live="polite">
              <span class="mdbx2-tiga-overview-icon"><m3e-icon :name="tigaPresentation.icon" /></span>
              <div class="mdbx2-tiga-overview-copy">
                <strong>{{ tigaPresentation.headline }}</strong>
                <small>{{ tigaPresentation.supporting }}</small>
                <small class="mdbx2-tiga-overview-meta">
                  <time :datetime="new Date(vaultTiga.checkedAtUnixSeconds * 1000).toISOString()">{{ formatMdbx2DiagnosticTime(vaultTiga.checkedAtUnixSeconds) }}</time>{{ tr('· 策略版本') }}{{ vaultTiga.policy.policyVersion }}
                </small>
              </div>
              <span class="mdbx2-tiga-profile-badge">{{ mdbx2TigaProfileLabel(vaultTiga.profile) }}</span>
            </div>

            <dl class="mdbx2-tiga-key-facts" :aria-label="tr('MDBX2 Tiga 安全态势概览')">
              <div><dt>{{ tr('策略状态') }}</dt><dd>{{ mdbx2TigaComplianceLabel(vaultTiga.compliance) }}</dd></div>
              <div><dt>{{ tr('解锁配置') }}</dt><dd>{{ vaultTiga.unlock.satisfiesPolicy ? tr('满足当前模式') : tr('需要调整') }}</dd></div>
              <div><dt>{{ tr('已配置方式') }}</dt><dd>{{ vaultTiga.unlock.configuredMethods.map(mdbx2TigaUnlockMethodLabel).join('、') || tr('未配置') }}</dd></div>
              <div><dt>{{ tr('浏览器限制') }}</dt><dd>{{ vaultTiga.browser.limitations.length ? tr('{0} 项', { 0: vaultTiga.browser.limitations.length }) : tr('无额外限制') }}</dd></div>
            </dl>

            <div v-if="vaultTiga.browser.limitations.length" class="mdbx2-tiga-limitations" role="list" :aria-label="tr('浏览器环境限制')">
              <div v-for="limitation in vaultTiga.browser.limitations" :key="limitation" class="mdbx2-tiga-limitation-row" role="listitem">
                <span class="mdbx2-tiga-limitation-icon"><m3e-icon :name="mdbx2TigaBrowserLimitation(limitation).icon" /></span>
                <span class="mdbx2-tiga-limitation-copy">
                  <strong>{{ mdbx2TigaBrowserLimitation(limitation).label }}</strong>
                  <small>{{ mdbx2TigaBrowserLimitation(limitation).description }}</small>
                </span>
              </div>
            </div>

            <details class="mdbx2-tiga-details">
              <summary>
                <m3e-icon name="policy" />
                <span><strong>{{ tr('查看只读策略详情') }}</strong><small>{{ tr('展开解锁、会话、敏感操作、恢复和审计要求；不会显示原始警告或技术标识。') }}</small></span>
                <m3e-icon class="mdbx2-tiga-details-chevron" name="expand_more" />
              </summary>
              <div class="mdbx2-tiga-policy-groups">
                <section aria-labelledby="mdbx2-tiga-unlock-title">
                  <h3 id="mdbx2-tiga-unlock-title">{{ tr('解锁与会话') }}</h3>
                  <dl>
                    <div><dt>{{ tr('最低认证因子') }}</dt><dd>{{ vaultTiga.policy.minimumAuthFactors }}</dd></div>
                    <div><dt>{{ tr('安全密钥') }}</dt><dd>{{ vaultTiga.policy.securityKeyRequired ? tr('必须') : vaultTiga.policy.securityKeyRecommended ? tr('建议') : tr('不要求') }}</dd></div>
                    <div><dt>{{ tr('可移植解锁') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.portableUnlockAllowed, tr('允许'), tr('不允许')) }}</dd></div>
                    <div><dt>{{ tr('空闲锁定') }}</dt><dd>{{ formatMdbx2TigaDuration(vaultTiga.policy.idleTimeoutSeconds) }}</dd></div>
                    <div><dt>{{ tr('最长会话') }}</dt><dd>{{ formatMdbx2TigaDuration(vaultTiga.policy.maxLifetimeSeconds) }}</dd></div>
                    <div><dt>{{ tr('进入后台') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.lockOnBackground, tr('立即锁定'), tr('保持当前会话')) }}</dd></div>
                    <div><dt>{{ tr('新鲜认证窗口') }}</dt><dd>{{ formatMdbx2TigaDuration(vaultTiga.policy.freshAuthWindowSeconds) }}</dd></div>
                    <div><dt>{{ tr('解锁警告') }}</dt><dd>{{ tr('{0} 项', { 0: formatMdbx2DiagnosticCount(vaultTiga.unlock.warningCount) }) }}</dd></div>
                  </dl>
                </section>
                <section aria-labelledby="mdbx2-tiga-disclosure-title">
                  <h3 id="mdbx2-tiga-disclosure-title">{{ tr('敏感操作') }}</h3>
                  <dl>
                    <div><dt>{{ tr('查看敏感值') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.revealRequiresFreshAuth, tr('需要重新认证'), tr('沿用当前会话')) }}</dd></div>
                    <div><dt>{{ tr('复制敏感值') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.copyRequiresFreshAuth, tr('需要重新认证'), tr('沿用当前会话')) }}</dd></div>
                    <div><dt>{{ tr('剪贴板') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.clipboardAllowed, tr('允许，{0} 清除', { 0: formatMdbx2TigaDuration(vaultTiga.policy.clipboardTtlSeconds) }), tr('不允许')) }}</dd></div>
                    <div><dt>{{ tr('安全剪贴板') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.secureClipboardRequired, tr('必须'), tr('不要求')) }}</dd></div>
                    <div><dt>{{ tr('截屏防护') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.screenCaptureProtectionRequired, tr('必须'), tr('不要求')) }}</dd></div>
                    <div><dt>{{ tr('设备保障') }}</dt><dd>{{ mdbx2TigaDeviceAssuranceLabel(vaultTiga.policy.minimumDeviceAssurance) }}</dd></div>
                    <div><dt>{{ tr('策略警告') }}</dt><dd>{{ tr('{0} 项', { 0: formatMdbx2DiagnosticCount(vaultTiga.warningCount) }) }}</dd></div>
                  </dl>
                </section>
                <section aria-labelledby="mdbx2-tiga-egress-title">
                  <h3 id="mdbx2-tiga-egress-title">{{ tr('导出、数据与恢复') }}</h3>
                  <dl>
                    <div><dt>{{ tr('导出') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.exportAllowed, tr('允许'), tr('不允许')) }}</dd></div>
                    <div><dt>{{ tr('打印') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.printAllowed, tr('允许'), tr('不允许')) }}</dd></div>
                    <div><dt>{{ tr('导出认证因子') }}</dt><dd>{{ vaultTiga.policy.egressMinimumAuthFactors }}</dd></div>
                    <div><dt>{{ tr('持久明文缓存') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.persistentPlaintextCacheAllowed, tr('允许'), tr('不允许')) }}</dd></div>
                    <div><dt>{{ tr('附件临时文件') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.attachmentTemporaryFilesAllowed, tr('允许'), tr('不允许')) }}</dd></div>
                    <div><dt>{{ tr('锁定时密文同步') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.lockedCiphertextSyncAllowed, tr('允许'), tr('不允许')) }}</dd></div>
                    <div><dt>{{ tr('最低恢复方式') }}</dt><dd>{{ vaultTiga.policy.minimumRecoveryMethods }}</dd></div>
                    <div><dt>{{ tr('可移植恢复') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.portableRecoveryRequired, tr('必须'), tr('不要求')) }}</dd></div>
                    <div><dt>{{ tr('管理认证因子') }}</dt><dd>{{ vaultTiga.policy.administrationMinimumAuthFactors }}</dd></div>
                    <div><dt>{{ tr('审计范围') }}</dt><dd>{{ mdbx2TigaAuditLevelLabel(vaultTiga.policy.auditLevel) }}</dd></div>
                    <div><dt>{{ tr('删除审计') }}</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.auditDeletionAllowed, tr('策略允许'), tr('策略禁止')) }}</dd></div>
                  </dl>
                </section>
                <p class="mdbx2-tiga-readonly-note"><m3e-icon name="info" /><span>{{ tr('此页面只解释当前策略。修改模式、例外、恢复策略、密钥轮换或审计记录必须在支持这些管理能力的客户端完成。') }}</span></p>
              </div>
            </details>
          </template>
        </section>

        <section ref="collectionPanel" v-if="isExisting && vaultOpen" class="mdbx2-collection-panel mdbx2-guidance-target field-wide" tabindex="-1" aria-labelledby="mdbx2-collection-title">
          <div class="mdbx2-collection-header">
            <div>
              <strong id="mdbx2-collection-title">{{ tr('文件夹') }}</strong>
              <small>{{ tr('与 Monica Android 共用 MDBX2 Collection 层级；根目录和技术标识保持隐藏。') }}</small>
            </div>
            <div class="mdbx2-collection-header-actions">
              <m3e-button variant="text" type="button" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation)" @click="loadCollections(collectionView, true)"><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ tr('刷新') }}</m3e-button>
              <m3e-button v-if="collectionView === 'active'" variant="tonal" type="button" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('create')"><m3e-icon slot="icon" name="create_new_folder"></m3e-icon>{{ tr('新建文件夹') }}</m3e-button>
            </div>
          </div>

          <div class="mdbx2-collection-tabs" role="group" :aria-label="tr('文件夹状态')">
            <button type="button" :aria-pressed="collectionView === 'active'" :class="{ active: collectionView === 'active' }" :disabled="collectionBusy === 'mutate' || Boolean(pendingCollectionMutation)" @click="changeCollectionView('active')"><m3e-icon name="folder" />{{ tr('当前文件夹') }}<span>{{ activeCollections.length }}</span></button>
            <button type="button" :aria-pressed="collectionView === 'deleted'" :class="{ active: collectionView === 'deleted' }" :disabled="collectionBusy === 'mutate' || Boolean(pendingCollectionMutation)" @click="changeCollectionView('deleted')"><m3e-icon name="delete" />{{ tr('回收站') }}<span>{{ deletedCollections.length }}</span></button>
          </div>

          <div v-if="pendingCollectionMutation" class="mdbx2-collection-editor" :class="{ danger: pendingCollectionMutation.kind === 'delete' }" role="group" aria-labelledby="mdbx2-collection-editor-title" aria-live="polite">
            <span class="mdbx2-collection-editor-icon"><m3e-icon :name="pendingCollectionMutation.kind === 'delete' ? 'warning' : pendingCollectionMutation.kind === 'restore' ? 'restore_from_trash' : 'drive_file_move'" /></span>
            <div class="mdbx2-collection-editor-copy">
              <strong id="mdbx2-collection-editor-title">{{ collectionMutationHeading(pendingCollectionMutation) }}</strong>
              <small>{{ collectionMutationDescription(pendingCollectionMutation) }}</small>
            </div>

            <label v-if="pendingCollectionMutation.kind === 'create' || pendingCollectionMutation.kind === 'rename'" class="mdbx2-collection-editor-field" for="mdbx2-collection-title-input">
              <span>{{ tr('文件夹名称') }}</span>
              <input id="mdbx2-collection-title-input" v-model="pendingCollectionMutation.title" autocomplete="off" :aria-invalid="collectionTitleInvalid" aria-describedby="mdbx2-collection-title-help" :disabled="pendingCollectionMutation.uncertain || collectionBusy === 'mutate'" @keydown.enter.prevent="submitCollectionMutation" />
              <small id="mdbx2-collection-title-help" :class="{ error: collectionTitleInvalid }">{{ tr('{0} / {1} UTF-8 字节', { 0: collectionTitleBytes, 1: MDBX2_MAX_COLLECTION_TITLE_BYTES }) }}</small>
            </label>

            <label v-if="pendingCollectionMutation.kind === 'create' || pendingCollectionMutation.kind === 'move' || pendingCollectionMutation.kind === 'restore'" class="mdbx2-collection-editor-field" for="mdbx2-collection-parent">
              <span>{{ tr('父级') }}</span>
              <select id="mdbx2-collection-parent" v-model="pendingCollectionMutation.parentCollectionId" :disabled="pendingCollectionMutation.uncertain || collectionBusy === 'mutate'">
                <option :value="undefined">{{ tr('顶层') }}</option>
                <option v-for="row in collectionParentOptions" :key="row.item.collectionId" :value="row.item.collectionId">{{ row.path }}</option>
              </select>
              <small>{{ tr('顶层文件夹使用空父级，与 Android 的 MDBX2 目录规则一致。') }}</small>
            </label>

            <div class="mdbx2-collection-editor-actions">
              <m3e-button variant="text" type="button" :disabled="pendingCollectionMutation.uncertain || collectionBusy === 'mutate'" @click="cancelCollectionMutation">{{ tr('取消') }}</m3e-button>
              <m3e-button ref="collectionConfirmButton" variant="filled" type="button" :class="{ 'mdbx2-collection-delete': pendingCollectionMutation.kind === 'delete' }" :disabled="collectionBusy === 'mutate' || collectionTitleInvalid" @click="submitCollectionMutation">{{ collectionMutationButtonLabel(pendingCollectionMutation) }}</m3e-button>
            </div>
          </div>

          <p v-if="collectionError" class="form-error mdbx2-collection-error" role="alert">{{ collectionError }}</p>
          <div v-if="collectionBusy === 'list' && !collectionRows.length" class="mdbx2-collection-empty" role="status"><m3e-icon name="progress_activity" /><span>{{ tr('正在读取文件夹…') }}</span></div>
          <div v-else-if="(collectionView === 'active' ? activeCollectionsLoaded : deletedCollectionsLoaded) && !collectionRows.length" class="mdbx2-collection-empty"><m3e-icon :name="collectionView === 'active' ? 'folder_open' : 'delete_sweep'" /><span>{{ collectionView === 'active' ? tr('尚未创建自定义文件夹。未分类项目仍保存在受保护的根目录。') : tr('回收站中没有文件夹。') }}</span></div>

          <div v-if="collectionRows.length" class="mdbx2-collection-list" role="list" :aria-label="collectionView === 'active' ? tr('当前 MDBX2 文件夹') : tr('MDBX2 文件夹回收站')">
            <article v-for="row in collectionRows" :key="row.item.collectionId" class="mdbx2-collection-row" role="listitem">
              <span class="mdbx2-collection-icon"><m3e-icon :name="collectionView === 'active' ? 'folder' : 'folder_delete'" /></span>
              <span class="mdbx2-collection-copy">
                <strong>{{ row.item.title }}</strong>
                <small>{{ row.depth ? row.path : tr('顶层') }}<template v-if="row.hierarchyState !== 'ready'"> · {{ row.parentPath }}</template></small>
              </span>
              <div v-if="collectionView === 'active'" class="mdbx2-collection-row-actions" :aria-label="tr('文件夹操作')">
                <m3e-icon-button type="button" :aria-label="tr('重命名 {0}', { 0: row.item.title })" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('rename', row.item)"><m3e-icon name="edit" /></m3e-icon-button>
                <m3e-icon-button type="button" :aria-label="tr('移动 {0}', { 0: row.item.title })" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('move', row.item)"><m3e-icon name="drive_file_move" /></m3e-icon-button>
                <m3e-icon-button type="button" :aria-label="tr('删除 {0}', { 0: row.item.title })" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('delete', row.item)"><m3e-icon name="delete" /></m3e-icon-button>
              </div>
              <m3e-button v-else variant="tonal" type="button" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('restore', row.item)"><m3e-icon slot="icon" name="restore_from_trash"></m3e-icon>{{ tr('恢复') }}</m3e-button>
            </article>
          </div>

          <div v-if="collectionView === 'active' ? activeCollectionCursor : deletedCollectionCursor" class="mdbx2-collection-more">
            <m3e-button variant="text" type="button" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation)" @click="loadCollections(collectionView, false)">{{ tr('加载更多文件夹') }}</m3e-button>
          </div>
        </section>

        <section ref="snapshotPanel" v-if="isExisting && vaultOpen" class="mdbx2-snapshot-panel mdbx2-guidance-target field-wide" tabindex="-1" aria-labelledby="mdbx2-snapshot-title">
          <div class="mdbx2-snapshot-header">
            <div>
              <strong id="mdbx2-snapshot-title">{{ tr('数据库快照') }}</strong>
              <small>{{ tr('用于恢复完整保险库状态；列表和结构预览不会显示 Snapshot、Object、Commit ID、metadata 或 payload。') }}</small>
            </div>
            <m3e-button variant="tonal" type="button" :disabled="Boolean(snapshotBusy) || conflictBusy === 'resolve'" @click="loadSnapshots(true)"><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ snapshotLoaded ? tr('刷新') : tr('加载快照') }}</m3e-button>
          </div>

          <div class="mdbx2-snapshot-create">
            <label class="mdbx2-snapshot-name" for="mdbx2-snapshot-name">
              <span>{{ tr('快照名称（可留空）') }}</span>
              <input
                id="mdbx2-snapshot-name"
                v-model="snapshotName"
                autocomplete="off"
                :aria-invalid="snapshotNameTooLong"
                aria-describedby="mdbx2-snapshot-name-help"
                :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotCreate) || Boolean(pendingSnapshotMutation) || Boolean(pendingSnapshotPrune) || snapshotRequiresRefresh || conflictBusy === 'resolve'"
                :placeholder="tr('例如：升级前')"
                @keydown.enter.prevent="createSnapshot"
              />
            </label>
            <div id="mdbx2-snapshot-name-help" class="mdbx2-snapshot-create-copy">
              <small>{{ tr('MDBX2 手动快照始终保存完整且经过认证的保险库状态；留空时由 Core 生成名称。') }}</small>
              <small :class="{ error: snapshotNameTooLong }">{{ tr('{0} / {1} UTF-8 字节', { 0: snapshotNameBytes, 1: MDBX2_MAX_SNAPSHOT_NAME_BYTES }) }}</small>
            </div>
            <m3e-button variant="filled" type="button" :disabled="Boolean(snapshotBusy) || snapshotNameTooLong || Boolean(pendingSnapshotMutation) || Boolean(pendingSnapshotPrune) || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="createSnapshot"><m3e-icon slot="icon" name="add"></m3e-icon>{{ snapshotBusy === 'create' ? tr('正在创建…') : pendingSnapshotCreate ? tr('重试创建') : tr('创建完整快照') }}</m3e-button>
          </div>

          <div v-if="!pendingSnapshotPrune" class="mdbx2-snapshot-retention">
            <span class="mdbx2-snapshot-retention-icon"><m3e-icon name="history" /></span>
            <div class="mdbx2-snapshot-retention-copy">
              <strong>{{ tr('自动快照保留') }}</strong>
              <small>{{ tr('先由 Core 检查已到保留期限的候选；手动快照和未到期自动快照不会进入清理计划。') }}</small>
            </div>
            <m3e-button class="mdbx2-snapshot-prune-action" variant="tonal" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotCreate) || Boolean(pendingSnapshotMutation) || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="requestAutomaticSnapshotPrune"><m3e-icon slot="icon" name="delete_sweep"></m3e-icon>{{ snapshotBusy === 'prune-plan' ? tr('正在检查…') : tr('检查可清理项') }}</m3e-button>
          </div>

          <div v-else class="mdbx2-snapshot-prune-confirmation" role="group" aria-labelledby="mdbx2-snapshot-prune-title" aria-live="assertive">
            <span class="mdbx2-snapshot-prune-icon"><m3e-icon name="warning" /></span>
            <div class="mdbx2-snapshot-prune-copy">
              <strong id="mdbx2-snapshot-prune-title">{{ tr('清理 {0} 个到期自动快照？', { 0: pendingSnapshotPrune.plan.candidateCount }) }}</strong>
              <small>{{ tr('本次计划约 {0}。手动快照和未到期自动快照保持不变；成功后会生成新的同步提交。', { 0: formatMdbx2SnapshotBytes(pendingSnapshotPrune.plan.totalCiphertextBytes) }) }}</small>
              <small v-if="pendingSnapshotPrune.plan.hasMore">{{ tr('Core 已达到单次 200 项安全上限；完成本次后可以再次检查剩余到期项。') }}</small>
              <small v-if="pendingSnapshotPrune.uncertain">{{ tr('Host 响应中断，计划令牌仍保留。安全重试会返回原清理结果，不会重复删除。') }}</small>
              <small v-else-if="pendingSnapshotPrune.stale">{{ tr('旧计划没有执行删除。请重新检查当前候选后再确认。') }}</small>
            </div>
            <div class="mdbx2-snapshot-prune-actions">
              <m3e-button variant="text" type="button" :disabled="pendingSnapshotPrune.uncertain || Boolean(snapshotBusy)" @click="cancelAutomaticSnapshotPrune">{{ tr('取消') }}</m3e-button>
              <m3e-button ref="confirmSnapshotPruneButton" variant="filled" type="button" :aria-label="tr('确认清理到期自动快照')" :disabled="Boolean(snapshotBusy) || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="confirmAutomaticSnapshotPrune">{{ snapshotBusy === 'prune' ? tr('正在清理…') : pendingSnapshotPrune.stale ? tr('重新检查') : pendingSnapshotPrune.uncertain ? tr('安全重试') : tr('确认清理') }}</m3e-button>
            </div>
          </div>

          <p v-if="snapshotError" class="form-error mdbx2-snapshot-error" role="alert">{{ snapshotError }}</p>
          <div v-if="snapshotRequiresRefresh" class="mdbx2-snapshot-refresh-required" role="status">
            <m3e-icon name="sync" />
            <span>{{ tr('快照操作结果需要人工核对。请先使用上方“刷新”，查看快照和随后更新的提交历史。') }}</span>
          </div>
          <div v-if="snapshotBusy === 'list' && !snapshotItems.length" class="mdbx2-snapshot-empty" role="status"><m3e-icon name="progress_activity" /><span>{{ tr('正在读取快照记录…') }}</span></div>
          <div v-else-if="snapshotLoaded && !snapshotItems.length" class="mdbx2-snapshot-empty"><m3e-icon name="backup_table" /><span>{{ tr('暂无数据库快照。') }}</span></div>

          <div v-if="snapshotItems.length" class="mdbx2-snapshot-list" :aria-label="tr('MDBX2 数据库快照列表')">
            <button
              v-for="item in snapshotItems"
              :key="item.snapshotId"
              type="button"
              class="mdbx2-snapshot-row"
              :class="{ selected: selectedSnapshotId === item.snapshotId, 'integrity-failed': !item.integrityOk }"
              :aria-expanded="selectedSnapshotId === item.snapshotId"
              :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || snapshotRequiresRefresh || conflictBusy === 'resolve'"
              @click="selectSnapshot(item)"
            >
              <span class="mdbx2-snapshot-icon"><m3e-icon :name="presentMdbx2Snapshot(item).icon" /></span>
              <span class="mdbx2-snapshot-copy"><strong>{{ presentMdbx2Snapshot(item).title }}</strong><small>{{ presentMdbx2Snapshot(item).supportingText }}</small></span>
              <time :datetime="item.createdAt">{{ presentMdbx2Snapshot(item).timeLabel }}</time>
              <m3e-icon :name="selectedSnapshotId === item.snapshotId ? 'expand_less' : 'chevron_right'" />
            </button>
          </div>

          <div v-if="selectedSnapshot" class="mdbx2-snapshot-detail" aria-live="polite">
            <div class="mdbx2-snapshot-detail-heading">
              <strong>{{ presentMdbx2Snapshot(selectedSnapshot).title }}</strong>
              <small>{{ presentMdbx2Snapshot(selectedSnapshot).timeLabel }} · {{ presentMdbx2Snapshot(selectedSnapshot).supportingText }}</small>
            </div>

            <div class="mdbx2-snapshot-facts" :aria-label="tr('快照属性')">
              <span><m3e-icon name="person" />{{ presentMdbx2Snapshot(selectedSnapshot).kindLabel }}</span>
              <span><m3e-icon name="database" />{{ presentMdbx2Snapshot(selectedSnapshot).completenessLabel }}</span>
              <span><m3e-icon name="data_usage" />{{ presentMdbx2Snapshot(selectedSnapshot).sizeLabel }}</span>
              <span :class="{ error: !selectedSnapshot.integrityOk }"><m3e-icon :name="selectedSnapshot.integrityOk ? 'verified_user' : 'gpp_bad'" />{{ presentMdbx2Snapshot(selectedSnapshot).integrityLabel }}</span>
            </div>

            <div v-if="selectedSnapshot.integrityOk" class="mdbx2-snapshot-structure">
              <div class="mdbx2-snapshot-structure-toolbar">
                <div role="group" :aria-label="tr('快照结构查看方式')">
                  <button type="button" :aria-pressed="snapshotStructureMode === 'snapshot'" :class="{ active: snapshotStructureMode === 'snapshot' }" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="changeSnapshotStructureMode('snapshot')">{{ tr('仅快照') }}</button>
                  <button type="button" :aria-pressed="snapshotStructureMode === 'compare'" :class="{ active: snapshotStructureMode === 'compare' }" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="changeSnapshotStructureMode('compare')">{{ tr('与现版本比较') }}</button>
                </div>
                <small>{{ tr('结构只包含可读名称、路径、类型和变化状态；附件内容与自定义 metadata 留在 Native Host。') }}</small>
              </div>

              <div class="mdbx2-snapshot-structure-grid" :class="{ compare: snapshotStructureMode === 'compare' }">
                <section v-if="snapshotStructureMode === 'compare'" class="mdbx2-snapshot-structure-side" aria-labelledby="mdbx2-current-structure-title">
                  <header><strong id="mdbx2-current-structure-title">{{ tr('当前版本') }}</strong><small>{{ currentSnapshotStructure.loaded ? tr('{0} / {1} 个节点 · {2} 项', { 0: currentSnapshotStructure.items.length, 1: currentSnapshotStructure.totalNodes, 2: currentSnapshotStructure.currentItemCount }) : tr('等待加载') }}</small></header>
                  <div v-if="snapshotBusy === 'structure' && !currentSnapshotStructure.loaded" class="mdbx2-snapshot-structure-empty" role="status"><m3e-icon name="progress_activity" />{{ tr('正在读取当前结构…') }}</div>
                  <div v-else-if="currentSnapshotStructure.loaded && !currentSnapshotStructure.items.length" class="mdbx2-snapshot-structure-empty">{{ tr('当前版本没有可显示的项目。') }}</div>
                  <div v-if="currentSnapshotStructure.items.length" class="mdbx2-snapshot-node-list" :aria-label="tr('当前版本结构')">
                    <div v-for="node in currentSnapshotStructure.items" :key="node.nodeId" class="mdbx2-snapshot-node" :data-status="node.status">
                      <span class="mdbx2-snapshot-node-icon"><m3e-icon :name="presentMdbx2SnapshotNode(node).statusIcon" /></span>
                      <span><strong>{{ presentMdbx2SnapshotNode(node).title }}</strong><small>{{ presentMdbx2SnapshotNode(node).supportingText }}</small></span>
                      <small class="mdbx2-snapshot-node-status">{{ presentMdbx2SnapshotNode(node).statusLabel }}</small>
                    </div>
                  </div>
                  <m3e-button v-if="currentSnapshotStructure.cursor" variant="text" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="loadSnapshotStructure('current', false)">{{ tr('加载更多当前项目') }}</m3e-button>
                </section>

                <section class="mdbx2-snapshot-structure-side" aria-labelledby="mdbx2-saved-structure-title">
                  <header><strong id="mdbx2-saved-structure-title">{{ tr('快照版本') }}</strong><small>{{ savedSnapshotStructure.loaded ? tr('{0} / {1} 个节点 · {2} 项', { 0: savedSnapshotStructure.items.length, 1: savedSnapshotStructure.totalNodes, 2: savedSnapshotStructure.snapshotItemCount }) : tr('等待加载') }}</small></header>
                  <div v-if="snapshotBusy === 'structure' && !savedSnapshotStructure.loaded" class="mdbx2-snapshot-structure-empty" role="status"><m3e-icon name="progress_activity" />{{ tr('正在读取快照结构…') }}</div>
                  <div v-else-if="savedSnapshotStructure.loaded && !savedSnapshotStructure.items.length" class="mdbx2-snapshot-structure-empty">{{ tr('此快照没有可显示的项目。') }}</div>
                  <div v-if="savedSnapshotStructure.items.length" class="mdbx2-snapshot-node-list" :aria-label="tr('快照版本结构')">
                    <div v-for="node in savedSnapshotStructure.items" :key="node.nodeId" class="mdbx2-snapshot-node" :data-status="node.status">
                      <span class="mdbx2-snapshot-node-icon"><m3e-icon :name="presentMdbx2SnapshotNode(node).statusIcon" /></span>
                      <span><strong>{{ presentMdbx2SnapshotNode(node).title }}</strong><small>{{ presentMdbx2SnapshotNode(node).supportingText }}</small></span>
                      <small class="mdbx2-snapshot-node-status">{{ presentMdbx2SnapshotNode(node).statusLabel }}</small>
                    </div>
                  </div>
                  <m3e-button v-if="savedSnapshotStructure.cursor" variant="text" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="loadSnapshotStructure('snapshot', false)">{{ tr('加载更多快照项目') }}</m3e-button>
                </section>
              </div>
            </div>

            <div v-else class="mdbx2-snapshot-integrity-warning" role="alert">
              <m3e-icon name="gpp_bad" />
              <span><strong>{{ tr('完整性校验失败') }}</strong><small>{{ tr('Native Host 已停止解密结构和恢复操作。此记录仍可保留用于诊断，也可以在确认后永久删除。') }}</small></span>
            </div>

            <div v-if="!pendingSnapshotMutation" class="mdbx2-snapshot-actions">
              <m3e-button class="mdbx2-snapshot-delete" variant="tonal" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="requestSnapshotMutation(selectedSnapshot, 'delete')"><m3e-icon slot="icon" name="delete_forever"></m3e-icon>{{ tr('删除快照') }}</m3e-button>
              <m3e-button class="mdbx2-snapshot-restore" variant="filled" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || snapshotRequiresRefresh || conflictBusy === 'resolve' || !presentMdbx2Snapshot(selectedSnapshot).canRestore" @click="requestSnapshotMutation(selectedSnapshot, 'restore')"><m3e-icon slot="icon" name="restore"></m3e-icon>{{ tr('恢复此快照') }}</m3e-button>
            </div>

            <div v-else class="mdbx2-snapshot-confirmation" role="group" aria-labelledby="mdbx2-snapshot-confirm-title" aria-live="assertive">
              <span class="mdbx2-snapshot-confirm-icon"><m3e-icon name="warning" /></span>
              <div>
                <strong id="mdbx2-snapshot-confirm-title">{{ tr('确认{0}？', { 0: snapshotMutationLabel(pendingSnapshotMutation.action) }) }}</strong>
                <small>{{ snapshotMutationDescription(pendingSnapshotMutation.action) }}</small>
                <small v-if="pendingSnapshotMutation.attempted">{{ tr('原操作意图和标识已保留。可以使用同一确认按钮重试，或先刷新状态进行核对。') }}</small>
              </div>
              <div class="mdbx2-snapshot-confirm-actions">
                <m3e-button variant="text" type="button" :disabled="pendingSnapshotMutation.attempted || Boolean(snapshotBusy) || conflictBusy === 'resolve'" @click="cancelSnapshotMutation">{{ tr('返回预览') }}</m3e-button>
                <m3e-button
                  ref="confirmSnapshotButton"
                  variant="filled"
                  type="button"
                  :aria-label="tr('确认{0}', { 0: snapshotMutationLabel(pendingSnapshotMutation.action) })"
                  :disabled="Boolean(snapshotBusy) || snapshotRequiresRefresh || conflictBusy === 'resolve'"
                  @click="confirmSnapshotMutation"
                >{{ snapshotRequiresRefresh ? tr('请先刷新状态') : snapshotBusy === pendingSnapshotMutation.action ? tr('正在处理…') : snapshotMutationButtonLabel(pendingSnapshotMutation.action, pendingSnapshotMutation.attempted) }}</m3e-button>
              </div>
            </div>
          </div>

          <div v-if="snapshotCursor" class="mdbx2-snapshot-more"><m3e-button variant="text" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="loadSnapshots(false)">{{ tr('加载更多快照') }}</m3e-button></div>
        </section>

        <section v-if="isExisting && vaultOpen" class="mdbx2-conflict-panel field-wide" aria-labelledby="mdbx2-conflict-title">
          <div class="mdbx2-conflict-header">
            <div>
              <strong id="mdbx2-conflict-title">{{ tr('同步冲突') }}</strong>
              <small>{{ tr('{0}；这里只显示字段名称和本机标题，不显示 payload 或 Commit ID。', { 0: conflictLoaded ? tr('{0}{1} 项待处理', { 0: conflictItems.length, 1: conflictCursor ? '+' : '' }) : tr('检查多个设备同时修改的项目') }) }}</small>
            </div>
            <m3e-button variant="tonal" type="button" :disabled="Boolean(conflictBusy) || snapshotMutating" @click="loadConflicts(true)"><m3e-icon slot="icon" name="sync_problem"></m3e-icon>{{ conflictLoaded ? tr('刷新') : tr('检查冲突') }}</m3e-button>
          </div>
          <p v-if="conflictError" class="form-error mdbx2-conflict-error" role="alert">{{ conflictError }}</p>
          <div v-if="conflictBusy === 'list' && !conflictItems.length" class="mdbx2-conflict-empty" role="status"><m3e-icon name="progress_activity" /><span>{{ tr('正在读取冲突队列…') }}</span></div>
          <div v-else-if="conflictLoaded && !conflictItems.length" class="mdbx2-conflict-empty"><m3e-icon name="check_circle" /><span>{{ tr('没有待处理的同步冲突。') }}</span></div>
          <div v-if="conflictItems.length" class="mdbx2-conflict-list" :aria-label="tr('MDBX2 同步冲突列表')">
            <button
              v-for="item in conflictItems"
              :key="item.conflictId"
              type="button"
              class="mdbx2-conflict-row"
              :class="{ selected: selectedConflictId === item.conflictId }"
              :aria-expanded="selectedConflictId === item.conflictId"
              :disabled="Boolean(conflictBusy) || snapshotMutating"
              @click="selectConflict(item)"
            >
              <span class="mdbx2-conflict-icon"><m3e-icon :name="presentMdbx2Conflict(item).icon" /></span>
              <span class="mdbx2-conflict-copy"><strong>{{ presentMdbx2Conflict(item).title }}</strong><small>{{ presentMdbx2Conflict(item).supportingText }}</small></span>
              <time :datetime="item.createdAt">{{ presentMdbx2Conflict(item).timeLabel }}</time>
              <m3e-icon :name="selectedConflictId === item.conflictId ? 'expand_less' : 'chevron_right'" />
            </button>
          </div>
          <div v-if="selectedConflict" class="mdbx2-conflict-detail" aria-live="polite">
            <div class="mdbx2-conflict-detail-heading">
              <strong>{{ presentMdbx2Conflict(selectedConflict).title }}</strong>
              <small>{{ tr('{0}在本机和另一台设备上被同时修改。请选择最终版本；选择本身会生成新的 MDBX2 同步变更。', { 0: presentMdbx2Conflict(selectedConflict).objectLabel }) }}</small>
            </div>
            <ul v-if="presentMdbx2Conflict(selectedConflict).fieldLabels.length" class="mdbx2-conflict-fields" :aria-label="tr('发生冲突的字段')">
              <li v-for="field in presentMdbx2Conflict(selectedConflict).fieldLabels" :key="field">{{ field }}</li>
            </ul>
            <div v-if="!pendingConflictResolution" class="mdbx2-conflict-actions">
              <m3e-button variant="tonal" type="button" :disabled="Boolean(conflictBusy) || snapshotMutating" @click="requestConflictResolution(selectedConflict, 'local-wins')">{{ tr('保留本机版本') }}</m3e-button>
              <m3e-button variant="filled" type="button" :disabled="Boolean(conflictBusy) || snapshotMutating" @click="requestConflictResolution(selectedConflict, 'incoming-wins')">{{ tr('采用传入版本') }}</m3e-button>
            </div>
            <div v-else class="mdbx2-conflict-confirmation" role="group" aria-labelledby="mdbx2-conflict-confirm-title" aria-live="assertive">
              <span class="mdbx2-conflict-confirm-icon"><m3e-icon name="warning" /></span>
              <div>
                <strong id="mdbx2-conflict-confirm-title">{{ tr('确认{0}？', { 0: mdbx2ConflictChoiceLabel(pendingConflictResolution.choice) }) }}</strong>
                <small>{{ mdbx2ConflictChoiceDescription(pendingConflictResolution.choice) }}</small>
              </div>
              <div class="mdbx2-conflict-confirm-actions">
                <m3e-button variant="text" type="button" :disabled="conflictBusy === 'resolve' || snapshotMutating" @click="cancelConflictResolution">{{ tr('返回比较') }}</m3e-button>
                <m3e-button
                  ref="confirmConflictButton"
                  variant="filled"
                  type="button"
                  :aria-label="tr('确认{0}', { 0: mdbx2ConflictChoiceLabel(pendingConflictResolution.choice) })"
                  :disabled="conflictBusy === 'resolve' || snapshotMutating"
                  @click="confirmConflictResolution"
                >{{ conflictBusy === 'resolve' ? tr('正在保存…') : pendingConflictResolution.choice === 'local-wins' ? tr('确认保留') : tr('确认采用') }}</m3e-button>
              </div>
            </div>
          </div>
          <div v-if="conflictCursor" class="mdbx2-conflict-more"><m3e-button variant="text" type="button" :disabled="Boolean(conflictBusy) || snapshotMutating" @click="loadConflicts(false)">{{ tr('加载更多冲突') }}</m3e-button></div>
        </section>

        <section ref="historyPanel" v-if="isExisting && vaultOpen" class="mdbx2-history-panel mdbx2-guidance-target field-wide" tabindex="-1" aria-labelledby="mdbx2-history-title">
          <div class="mdbx2-history-header">
            <div><strong id="mdbx2-history-title">{{ tr('提交历史') }}</strong><small>{{ tr('只显示可读操作摘要；密码和原始 payload 不会进入此页面。') }}</small></div>
            <m3e-button variant="tonal" type="button" :disabled="Boolean(historyBusy) || managerMutationLocked" @click="loadHistory(true)"><m3e-icon slot="icon" name="history"></m3e-icon>{{ historyLoaded ? tr('刷新') : tr('加载历史') }}</m3e-button>
          </div>
          <p v-if="historyError" class="form-error mdbx2-history-error" role="alert">{{ historyError }}</p>
          <div v-if="historyBusy === 'list' && !historyItems.length" class="mdbx2-history-empty" role="status"><m3e-icon name="progress_activity" /><span>{{ tr('正在读取提交历史…') }}</span></div>
          <div v-else-if="historyLoaded && !historyItems.length" class="mdbx2-history-empty"><m3e-icon name="history_toggle_off" /><span>{{ tr('暂无可显示的提交记录。') }}</span></div>
          <div v-if="historyItems.length" class="mdbx2-history-list" :aria-label="tr('MDBX2 提交历史')">
            <button
              v-for="item in historyItems"
              :key="item.commitId"
              type="button"
              class="mdbx2-history-row"
              :class="{ selected: selectedCommitId === item.commitId }"
              :aria-expanded="selectedCommitId === item.commitId"
              :disabled="Boolean(historyBusy) || managerMutationLocked || Boolean(pendingHistoryRevert)"
              @click="selectHistory(item)"
            >
              <span class="mdbx2-history-icon"><m3e-icon :name="presentMdbx2History(item).icon" /></span>
              <span class="mdbx2-history-copy"><strong>{{ presentMdbx2History(item).title }}</strong><small>{{ presentMdbx2History(item).supportingText }}</small></span>
              <time :datetime="item.createdAt">{{ formatMdbx2HistoryTime(item.createdAt) }}</time>
              <m3e-icon :name="selectedCommitId === item.commitId ? 'expand_less' : 'chevron_right'" />
            </button>
          </div>
          <div v-if="selectedHistoryItem" class="mdbx2-history-detail" aria-live="polite">
            <div class="mdbx2-history-detail-heading"><strong>{{ presentMdbx2History(selectedHistoryItem).title }}</strong><small>{{ presentMdbx2History(selectedHistoryItem).supportingText }}</small></div>
            <div v-if="historyBusy === 'diff'" class="mdbx2-history-empty"><m3e-icon name="progress_activity" /><span>{{ tr('正在读取变更详情…') }}</span></div>
            <div v-else-if="commitDiffItems.length" class="mdbx2-diff-list">
              <div v-for="diff in commitDiffItems" :key="`${diff.objectType}:${diff.objectId}`" class="mdbx2-diff-row">
                <span class="mdbx2-history-icon"><m3e-icon :name="presentMdbx2Diff(diff).icon" /></span>
                <span><strong>{{ presentMdbx2Diff(diff).title }} · {{ presentMdbx2Diff(diff).displayTitle }}</strong><small>{{ presentMdbx2Diff(diff).supportingText }}</small></span>
              </div>
            </div>
            <p v-else-if="!historyBusy && presentMdbx2History(selectedHistoryItem).canInspect" class="mdbx2-history-empty">{{ tr('此提交没有可展开的普通条目差异。') }}</p>
            <p v-else-if="!presentMdbx2History(selectedHistoryItem).canInspect" class="mdbx2-history-empty">{{ tr('这是数据库级系统记录，不包含普通条目差异。') }}</p>
            <div v-if="presentMdbx2History(selectedHistoryItem).canRevert && !pendingHistoryRevert" class="mdbx2-history-actions">
              <span>{{ tr('恢复操作会新增一条历史记录，原提交和后续同步依据保持可审计。') }}</span>
              <m3e-button variant="filled" type="button" :disabled="Boolean(historyBusy) || managerMutationLocked" @click="requestHistoryRevert(selectedHistoryItem)"><m3e-icon slot="icon" name="undo"></m3e-icon>{{ tr('撤销这次更改') }}</m3e-button>
            </div>
          </div>
          <div v-if="pendingHistoryRevert" class="mdbx2-history-confirmation" role="group" aria-labelledby="mdbx2-history-revert-title" aria-live="assertive">
            <span class="mdbx2-history-confirm-icon"><m3e-icon name="warning" /></span>
            <div>
              <strong id="mdbx2-history-revert-title">{{ tr('撤销这次更改？') }}</strong>
              <small>{{ tr('将恢复或移除这次提交涉及的 {0} 个条目。此操作会生成新的恢复记录，原有历史保持不变。', { 0: presentMdbx2History(pendingHistoryRevert.item).objectCount }) }}</small>
              <small v-if="pendingHistoryRevert.attempted">{{ tr('原操作标识已经保留。可以使用同一确认按钮重试，或刷新提交历史确认结果。') }}</small>
            </div>
            <div class="mdbx2-history-confirm-actions">
              <m3e-button variant="text" type="button" :disabled="pendingHistoryRevert.attempted || Boolean(historyBusy)" @click="cancelHistoryRevert">{{ tr('返回详情') }}</m3e-button>
              <m3e-button ref="confirmHistoryRevertButton" variant="filled" type="button" :aria-label="tr('确认撤销这次更改')" :disabled="Boolean(historyBusy) || conflictBusy === 'resolve' || snapshotMutating" @click="confirmHistoryRevert">{{ historyBusy === 'revert' ? tr('正在恢复…') : pendingHistoryRevert.attempted ? tr('重试恢复') : tr('确认撤销') }}</m3e-button>
            </div>
          </div>
          <div v-if="historyCursor" class="mdbx2-history-more"><m3e-button variant="text" type="button" :disabled="Boolean(historyBusy) || managerMutationLocked || Boolean(pendingHistoryRevert)" @click="loadHistory(false)">{{ tr('加载更早记录') }}</m3e-button></div>
        </section>

        <div class="provider-boundaries field-wide" :aria-label="tr('MDBX2 浏览器能力边界')">
          <div class="boundary-row"><m3e-icon name="database" /><span>{{ tr('单个 .mdbx 用于首次加入和完整备份；多设备日常修改通过 Commit DAG、state delta、Tombstone 和 Blob 增量交换。') }}</span></div>
          <div class="boundary-row"><m3e-icon name="encrypted" /><span>{{ tr('Native Host 负责解锁、迁移、健康检查和核心写入；管理页只接收状态摘要与受限句柄。') }}</span></div>
        </div>

        <div v-if="busy" class="mdbx2-progress field-wide" role="status" aria-live="polite"><progress v-if="busy === 'upload'" :value="uploadProgress" max="100" /><span>{{ busyLabel }}</span></div>
        <p v-if="error" class="form-error field-wide" role="alert">{{ error }}</p>

        <footer class="provider-actions field-wide">
          <m3e-button variant="text" type="button" :disabled="dialogLocked" @click="closeDialog">{{ tr('取消') }}</m3e-button>
          <template v-if="isExisting">
            <m3e-button v-if="!vaultOpen" variant="tonal" type="button" :disabled="dialogLocked || !hostReady" @click="unlockExisting">{{ tr('解锁本机副本') }}</m3e-button>
            <m3e-button variant="tonal" type="button" :disabled="dialogLocked || !remoteFieldsComplete" @click="saveSettings">{{ tr('保存设置') }}</m3e-button>
            <m3e-button v-if="canPublish" variant="filled" type="button" :disabled="dialogLocked || !hostReady" @click="publishBootstrap">{{ tr('保存并发布本机保险库') }}</m3e-button>
          </template>
          <m3e-button v-else variant="filled" type="submit" :disabled="dialogLocked || !hostReady">{{ form.mode === 'remote' ? tr('下载并加入') : tr('验证、解锁并导入') }}</m3e-button>
        </footer>
      </form>
    </section>
  </div>
</template>

<style scoped>
.mdbx2-dialog { container-type: inline-size; }
.mdbx2-form { grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr)); grid-auto-rows: max-content; align-content: start; gap: 16px; }
.mdbx2-form > * { min-block-size: max-content; }
.mdbx2-dialog > header { min-width: 0; }
.mdbx2-dialog > header > div { min-width: 0; flex: 1 1 auto; }
.mdbx2-dialog > header > m3e-icon-button {
  flex: 0 0 44px;
  inline-size: 44px;
  block-size: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: clip;
  --m3e-icon-button-container-height: 44px;
  --m3e-icon-button-icon-size: 20px;
  --m3e-icon-button-default-leading-space: 0px;
  --m3e-icon-button-default-trailing-space: 0px;
}
.mdbx2-host-row { min-height: 64px; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px; background: var(--md-sys-color-surface-container-highest, var(--app-surface-high)); }
.mdbx2-host-row > m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-host-row > div { min-width: 0; display: grid; gap: 2px; }
.mdbx2-host-row small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-host-row.ready { color: var(--md-sys-color-on-surface, var(--app-text)); }
.mdbx2-host-row.attention { border-color: var(--md-sys-color-error, #ba1a1a); color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-mode-picker { border: 0; display: grid; gap: 8px; padding: 0; }
.mdbx2-mode-picker legend { margin-bottom: 8px; font-weight: 700; }
.mdbx2-mode-picker > div { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: 8px; }
.mdbx2-mode-picker button { min-height: 48px; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; color: var(--app-text); background: var(--md-sys-color-surface-container-highest, var(--app-surface-high)); cursor: pointer; font: inherit; font-weight: 600; }
.mdbx2-mode-picker button.active { border-color: var(--app-primary); color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-mode-picker button:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: 2px; }
.mdbx2-mode-picker m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-inspection,
.mdbx2-runtime-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; }
.mdbx2-inspection span,
.mdbx2-runtime-summary span { min-width: 0; display: grid; gap: 2px; padding: 12px 16px; }
.mdbx2-inspection span + span,
.mdbx2-runtime-summary span + span { border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-inspection small,
.mdbx2-runtime-summary small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-progress { display: flex; align-items: center; gap: 12px; min-height: 44px; color: var(--app-muted); }
.mdbx2-progress progress { width: min(220px, 40%); accent-color: var(--app-primary); }
.mdbx2-diagnostics-panel { border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.mdbx2-diagnostics-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; }
.mdbx2-diagnostics-header > div,
.mdbx2-diagnostics-health-copy,
.mdbx2-diagnostics-category-copy,
.mdbx2-diagnostics-details summary > span { min-width: 0; display: grid; gap: 2px; }
.mdbx2-diagnostics-header small,
.mdbx2-diagnostics-health-copy small,
.mdbx2-diagnostics-category-copy small,
.mdbx2-diagnostics-details small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-diagnostics-actions { display: flex !important; align-items: center; justify-content: flex-end; gap: 8px !important; }
.mdbx2-diagnostics-actions > m3e-button { min-height: 44px; flex: 0 0 auto; }
.mdbx2-diagnostics-error { margin: 0 16px 12px; }
.mdbx2-diagnostics-empty { min-height: 64px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 16px; color: var(--app-muted); text-align: center; }
.mdbx2-diagnostics-empty m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-diagnostics-health { min-height: 80px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px; }
.mdbx2-diagnostics-health[data-tone="healthy"] { color: var(--md-sys-color-on-tertiary-container, var(--app-text)); background: var(--md-sys-color-tertiary-container, var(--app-surface-high)); }
.mdbx2-diagnostics-health[data-tone="attention"] { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-diagnostics-health[data-tone="danger"] { color: var(--app-text); background: color-mix(in srgb, var(--md-sys-color-error-container, var(--app-surface-high)) 42%, var(--app-surface)); box-shadow: inset 4px 0 0 var(--md-sys-color-error, #ba1a1a); }
.mdbx2-diagnostics-health[data-tone="danger"] .mdbx2-diagnostics-health-icon,
.mdbx2-diagnostics-health[data-tone="danger"] .mdbx2-diagnostics-severity-summary { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-diagnostics-health[data-tone] .mdbx2-diagnostics-health-copy small { color: inherit; opacity: .82; }
.mdbx2-diagnostics-health-icon { inline-size: 44px; block-size: 44px; border-radius: 8px; display: grid; place-items: center; background: color-mix(in srgb, currentColor 10%, transparent); }
.mdbx2-diagnostics-health-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-diagnostics-health-meta { font-variant-numeric: tabular-nums; }
.mdbx2-diagnostics-severity-summary { max-width: 18rem; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
.mdbx2-health-repair { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); background: var(--md-sys-color-surface-container-low, var(--app-surface)); scroll-margin-top: 16px; }
.mdbx2-health-repair:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.mdbx2-health-repair-heading { min-height: 72px; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px; }
.mdbx2-health-repair-heading > div,
.mdbx2-health-repair-row > span:nth-child(2),
.mdbx2-health-repair-conflict-copy > div,
.mdbx2-health-repair-delete-confirmation > div:nth-child(2) { min-width: 0; display: grid; gap: 3px; }
.mdbx2-health-repair-heading small,
.mdbx2-health-repair-row small,
.mdbx2-health-repair-conflict-copy small,
.mdbx2-health-repair-choice-copy small,
.mdbx2-health-repair-delete-confirmation small,
.mdbx2-health-repair-section-title small { color: var(--app-muted); line-height: 1.5; overflow-wrap: anywhere; }
.mdbx2-health-repair-heading-icon { inline-size: 44px; block-size: 44px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-health-repair-heading-icon m3e-icon,
.mdbx2-health-repair-row-icon m3e-icon,
.mdbx2-health-repair-conflict-icon m3e-icon,
.mdbx2-health-repair-delete-icon m3e-icon,
.mdbx2-health-repair-safety-note m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-health-repair-count { max-width: 15rem; color: var(--app-muted); font-size: .82rem; font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.mdbx2-health-repair-error { margin: 0 16px 12px; }
.mdbx2-health-repair[data-recovery="stale"] .mdbx2-health-repair-heading-icon,
.mdbx2-health-repair[data-recovery="unknown"] .mdbx2-health-repair-heading-icon { color: var(--md-sys-color-error, #ba1a1a); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-health-repair-automatic,
.mdbx2-health-repair-blockers,
.mdbx2-health-repair-conflict,
.mdbx2-health-repair-review,
.mdbx2-health-repair-recovery { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-health-repair-section-title { min-height: 56px; display: grid; align-content: center; gap: 2px; padding: 10px 16px; }
.mdbx2-health-repair-list { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-health-repair-row { min-height: 64px; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 16px; }
.mdbx2-health-repair-row + .mdbx2-health-repair-row { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-health-repair-row > strong { font-variant-numeric: tabular-nums; white-space: nowrap; }
.mdbx2-health-repair-row-icon,
.mdbx2-health-repair-conflict-icon,
.mdbx2-health-repair-delete-icon { inline-size: 40px; block-size: 40px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.mdbx2-health-repair-row.danger { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-health-repair-row.danger small { color: inherit; opacity: .84; }
.mdbx2-health-repair-progress { display: grid; gap: 8px; padding: 12px 16px 8px; color: var(--app-muted); font-weight: 600; font-variant-numeric: tabular-nums; }
.mdbx2-health-repair-progress progress { inline-size: 100%; block-size: 4px; accent-color: var(--app-primary); }
.mdbx2-health-repair-conflict-copy { display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: center; gap: 12px; padding: 12px 16px; }
.mdbx2-health-repair-choice-copy { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.mdbx2-health-repair-choice-copy > div { min-width: 0; display: grid; gap: 3px; padding: 12px 16px; }
.mdbx2-health-repair-choice-copy > div + div { border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-health-repair-actions { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 12px 16px; }
.mdbx2-health-repair-actions > m3e-button { min-height: 44px; }
.mdbx2-health-repair-delete { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-health-repair-delete-confirmation { border-top: 1px solid var(--md-sys-color-error, #ba1a1a); display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: center; gap: 12px; padding: 12px 16px 0; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-health-repair-delete-confirmation > .mdbx2-health-repair-actions { grid-column: 1 / -1; margin-inline: -16px; color: inherit; border-color: color-mix(in srgb, currentColor 20%, transparent); background: color-mix(in srgb, currentColor 4%, transparent); }
.mdbx2-health-repair-delete-icon { color: var(--md-sys-color-on-error-container, var(--app-text)); background: color-mix(in srgb, currentColor 10%, transparent); }
.mdbx2-health-repair-review-counts { margin: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.mdbx2-health-repair-review-counts > div { min-width: 0; display: grid; gap: 2px; padding: 12px 16px; }
.mdbx2-health-repair-review-counts > div + div { border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-health-repair-review-counts dt { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-health-repair-review-counts dd { margin: 0; font-size: 1.08rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.mdbx2-health-repair-safety-note { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); min-height: 56px; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 12px; padding: 10px 16px; color: var(--app-muted); line-height: 1.5; }
.mdbx2-health-repair-recovery > .mdbx2-health-repair-safety-note { border-top: 0; }
.mdbx2-health-guidance-list { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-health-guidance-heading { min-height: 56px; display: grid; align-content: center; gap: 2px; padding: 10px 16px; }
.mdbx2-health-guidance-heading small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-health-guidance-row { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-health-guidance-row summary { min-height: 72px; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto 24px; align-items: center; gap: 12px; padding: 12px 16px; cursor: pointer; list-style: none; }
.mdbx2-health-guidance-row summary::-webkit-details-marker { display: none; }
.mdbx2-health-guidance-row summary:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.mdbx2-health-guidance-icon { inline-size: 40px; block-size: 40px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.mdbx2-health-guidance-icon m3e-icon,
.mdbx2-health-guidance-chevron { --m3e-icon-size: 20px; }
.mdbx2-health-guidance-copy { min-width: 0; display: grid; gap: 3px; }
.mdbx2-health-guidance-copy small { color: var(--app-muted); line-height: 1.5; overflow-wrap: anywhere; }
.mdbx2-health-guidance-severity { color: var(--app-muted); font-size: .78rem; font-weight: 600; white-space: nowrap; }
.mdbx2-health-guidance-row[data-severity="error"] .mdbx2-health-guidance-icon,
.mdbx2-health-guidance-row[data-severity="critical"] .mdbx2-health-guidance-icon,
.mdbx2-health-guidance-row[data-severity="error"] .mdbx2-health-guidance-severity,
.mdbx2-health-guidance-row[data-severity="critical"] .mdbx2-health-guidance-severity { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-health-guidance-row[open] .mdbx2-health-guidance-chevron { transform: rotate(180deg); }
.mdbx2-health-guidance-body { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; gap: 12px; padding: 12px 16px 16px 68px; background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.mdbx2-health-guidance-body > div { display: grid; gap: 4px; }
.mdbx2-health-guidance-body p { margin: 0; color: var(--app-muted); line-height: 1.5; overflow-wrap: anywhere; }
.mdbx2-health-guidance-body ol { margin: 0; padding-inline-start: 1.25rem; color: var(--app-muted); line-height: 1.55; }
.mdbx2-health-guidance-body li + li { margin-top: 4px; }
.mdbx2-health-guidance-body > m3e-button { min-height: 44px; justify-self: start; }
.mdbx2-guidance-target { scroll-margin-top: 16px; }
.mdbx2-guidance-target:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: 3px; }
.mdbx2-diagnostics-key-facts { margin: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.mdbx2-diagnostics-key-facts > div { min-width: 0; display: grid; align-content: center; gap: 2px; padding: 12px 16px; }
.mdbx2-diagnostics-key-facts > div + div { border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-diagnostics-key-facts dt { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-diagnostics-key-facts dd { margin: 0; font-size: 1.08rem; font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.mdbx2-diagnostics-category-list { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-diagnostics-category-row { min-height: 56px; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 8px 16px; }
.mdbx2-diagnostics-category-row + .mdbx2-diagnostics-category-row { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-diagnostics-category-row[data-severity="error"],
.mdbx2-diagnostics-category-row[data-severity="critical"] { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-diagnostics-category-icon { inline-size: 32px; block-size: 32px; display: grid; place-items: center; }
.mdbx2-diagnostics-category-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-diagnostics-category-count { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mdbx2-diagnostics-details { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-diagnostics-details summary { min-height: 56px; display: grid; grid-template-columns: 24px minmax(0, 1fr) 24px; align-items: center; gap: 12px; padding: 8px 16px; cursor: pointer; list-style: none; }
.mdbx2-diagnostics-details summary::-webkit-details-marker { display: none; }
.mdbx2-diagnostics-details summary:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.mdbx2-diagnostics-details summary > m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-diagnostics-details[open] .mdbx2-diagnostics-details-chevron { transform: rotate(180deg); }
.mdbx2-diagnostics-stat-groups { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-diagnostics-stat-groups > section { padding: 12px 16px; }
.mdbx2-diagnostics-stat-groups > section + section { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-diagnostics-stat-groups h3 { margin: 0 0 8px; font-size: 1rem; }
.mdbx2-diagnostics-stat-groups dl { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; }
.mdbx2-diagnostics-stat-groups dl > div { min-width: 0; display: grid; gap: 2px; padding: 8px 12px; }
.mdbx2-diagnostics-stat-groups dt { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-diagnostics-stat-groups dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.mdbx2-tiga-panel { border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.mdbx2-tiga-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; }
.mdbx2-tiga-header > div,
.mdbx2-tiga-overview-copy,
.mdbx2-tiga-limitation-copy,
.mdbx2-tiga-details summary > span { min-width: 0; display: grid; gap: 2px; }
.mdbx2-tiga-header small,
.mdbx2-tiga-overview-copy small,
.mdbx2-tiga-limitation-copy small,
.mdbx2-tiga-details small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-tiga-header > m3e-button { min-height: 44px; flex: 0 0 auto; }
.mdbx2-tiga-error { margin: 0 16px 12px; }
.mdbx2-tiga-empty { min-height: 64px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 16px; color: var(--app-muted); text-align: center; }
.mdbx2-tiga-empty m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-tiga-overview { min-height: 80px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px; }
.mdbx2-tiga-overview[data-tone="healthy"] { color: var(--md-sys-color-on-tertiary-container, var(--app-text)); background: var(--md-sys-color-tertiary-container, var(--app-surface-high)); }
.mdbx2-tiga-overview[data-tone="attention"] { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-tiga-overview[data-tone="danger"] { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-tiga-overview[data-tone] .mdbx2-tiga-overview-copy small { color: inherit; opacity: .82; }
.mdbx2-tiga-overview-icon { inline-size: 44px; block-size: 44px; border-radius: 8px; display: grid; place-items: center; background: color-mix(in srgb, currentColor 10%, transparent); }
.mdbx2-tiga-overview-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-tiga-overview-meta { font-variant-numeric: tabular-nums; }
.mdbx2-tiga-profile-badge { min-height: 32px; border: 1px solid color-mix(in srgb, currentColor 32%, transparent); border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; font-weight: 700; letter-spacing: .02em; }
.mdbx2-tiga-key-facts { margin: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.mdbx2-tiga-key-facts > div { min-width: 0; display: grid; align-content: center; gap: 2px; padding: 12px 16px; }
.mdbx2-tiga-key-facts > div + div { border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-tiga-key-facts dt { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-tiga-key-facts dd { margin: 0; font-weight: 700; overflow-wrap: anywhere; }
.mdbx2-tiga-limitations { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-tiga-limitation-row { min-height: 64px; display: grid; grid-template-columns: 44px minmax(0, 1fr); align-items: center; gap: 12px; padding: 10px 16px; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-tiga-limitation-row + .mdbx2-tiga-limitation-row { border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
.mdbx2-tiga-limitation-icon { inline-size: 44px; block-size: 44px; border-radius: 8px; display: grid; place-items: center; background: color-mix(in srgb, currentColor 10%, transparent); }
.mdbx2-tiga-limitation-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-tiga-limitation-copy small { color: inherit; opacity: .82; }
.mdbx2-tiga-details { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-tiga-details summary { min-height: 56px; display: grid; grid-template-columns: 24px minmax(0, 1fr) 24px; align-items: center; gap: 12px; padding: 8px 16px; cursor: pointer; list-style: none; }
.mdbx2-tiga-details summary::-webkit-details-marker { display: none; }
.mdbx2-tiga-details summary:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.mdbx2-tiga-details summary > m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-tiga-details[open] .mdbx2-tiga-details-chevron { transform: rotate(180deg); }
.mdbx2-tiga-policy-groups { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-tiga-policy-groups > section { padding: 12px 16px; }
.mdbx2-tiga-policy-groups > section + section { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-tiga-policy-groups h3 { margin: 0 0 8px; font-size: 1rem; }
.mdbx2-tiga-policy-groups dl { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.mdbx2-tiga-policy-groups dl > div { min-width: 0; display: grid; gap: 2px; padding: 8px 12px; }
.mdbx2-tiga-policy-groups dt { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-tiga-policy-groups dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.mdbx2-tiga-readonly-note { margin: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: center; gap: 12px; padding: 12px 16px; color: var(--app-muted); background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.mdbx2-tiga-readonly-note m3e-icon { --m3e-icon-size: 20px; justify-self: center; }
.mdbx2-collection-panel { border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.mdbx2-collection-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; }
.mdbx2-collection-header > div:first-child,
.mdbx2-collection-copy,
.mdbx2-collection-editor-copy { min-width: 0; display: grid; gap: 2px; }
.mdbx2-collection-header small,
.mdbx2-collection-copy small,
.mdbx2-collection-editor-copy small,
.mdbx2-collection-editor-field small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-collection-header-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.mdbx2-collection-header-actions m3e-button,
.mdbx2-collection-more m3e-button { min-height: 44px; }
.mdbx2-collection-tabs { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.mdbx2-collection-tabs button { min-width: 0; min-height: 44px; border: 0; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 12px; color: var(--app-text); background: transparent; cursor: pointer; font: inherit; font-weight: 600; }
.mdbx2-collection-tabs button + button { border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-collection-tabs button.active { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-collection-tabs button:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.mdbx2-collection-tabs button:disabled { cursor: progress; opacity: .56; }
.mdbx2-collection-tabs m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-collection-tabs span { color: var(--app-muted); font-variant-numeric: tabular-nums; }
.mdbx2-collection-editor { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px; background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.mdbx2-collection-editor.danger { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-collection-editor.danger small { color: inherit; opacity: .84; }
.mdbx2-collection-editor-icon { width: 32px; height: 32px; display: grid; place-items: center; color: var(--app-primary); }
.mdbx2-collection-editor.danger .mdbx2-collection-editor-icon { color: inherit; }
.mdbx2-collection-editor-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-collection-editor-field { grid-column: 2 / -1; min-width: 0; display: grid; gap: 6px; font-weight: 600; }
.mdbx2-collection-editor-field input,
.mdbx2-collection-editor-field select { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; padding: 9px 12px; color: var(--app-text); background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); font: inherit; }
.mdbx2-collection-editor-field input:focus-visible,
.mdbx2-collection-editor-field select:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: 2px; }
.mdbx2-collection-editor-field input[aria-invalid="true"] { border-color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-collection-editor-field small.error { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-collection-editor-actions { grid-column: 2 / -1; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.mdbx2-collection-editor-actions m3e-button { min-height: 44px; }
.mdbx2-collection-delete { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-collection-error { margin: 0; padding: 0 16px 12px; }
.mdbx2-collection-list { background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.mdbx2-collection-row { min-width: 0; min-height: 64px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 16px; }
.mdbx2-collection-icon { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.mdbx2-collection-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-collection-copy strong,
.mdbx2-collection-copy small { overflow-wrap: anywhere; }
.mdbx2-collection-row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.mdbx2-collection-row-actions m3e-icon-button { flex: 0 0 44px; inline-size: 44px; block-size: 44px; min-inline-size: 44px; max-inline-size: 44px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; overflow: clip; --m3e-icon-button-container-height: 44px; --m3e-icon-button-icon-size: 20px; --m3e-icon-button-default-leading-space: 0px; --m3e-icon-button-default-trailing-space: 0px; }
.mdbx2-collection-row-actions m3e-icon-button:last-child { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-collection-row > m3e-button { min-height: 44px; }
.mdbx2-collection-empty { min-height: 64px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 16px; color: var(--app-muted); text-align: center; }
.mdbx2-collection-empty m3e-icon { flex: 0 0 24px; --m3e-icon-size: 20px; }
.mdbx2-collection-more { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; justify-content: center; padding: 4px 12px; }
.mdbx2-snapshot-panel { border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.mdbx2-snapshot-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; }
.mdbx2-snapshot-header > div,
.mdbx2-snapshot-copy,
.mdbx2-snapshot-detail-heading,
.mdbx2-snapshot-confirmation > div:first-of-type,
.mdbx2-snapshot-node > span:nth-child(2),
.mdbx2-snapshot-integrity-warning > span { min-width: 0; display: grid; gap: 2px; }
.mdbx2-snapshot-header small,
.mdbx2-snapshot-copy small,
.mdbx2-snapshot-detail small,
.mdbx2-snapshot-confirmation small,
.mdbx2-snapshot-node small,
.mdbx2-snapshot-integrity-warning small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-snapshot-create { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: minmax(180px, .8fr) minmax(220px, 1.2fr) auto; align-items: end; gap: 12px; padding: 12px 16px; background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.mdbx2-snapshot-name { min-width: 0; display: grid; gap: 6px; font-weight: 600; }
.mdbx2-snapshot-name input { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; padding: 9px 12px; color: var(--app-text); background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); font: inherit; }
.mdbx2-snapshot-name input:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: 2px; }
.mdbx2-snapshot-name input[aria-invalid="true"] { border-color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-snapshot-create-copy { min-width: 0; display: grid; align-content: end; gap: 2px; color: var(--app-muted); }
.mdbx2-snapshot-create-copy .error { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-snapshot-create > m3e-button { min-height: 44px; }
.mdbx2-snapshot-retention,
.mdbx2-snapshot-prune-confirmation { min-height: 64px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px; }
.mdbx2-snapshot-retention { background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.mdbx2-snapshot-retention-icon,
.mdbx2-snapshot-prune-icon { width: 32px; height: 32px; display: grid; place-items: center; }
.mdbx2-snapshot-retention-icon { color: var(--app-muted); }
.mdbx2-snapshot-prune-icon { color: var(--md-sys-color-on-error-container, var(--app-text)); }
.mdbx2-snapshot-retention-icon m3e-icon,
.mdbx2-snapshot-prune-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-snapshot-retention-copy,
.mdbx2-snapshot-prune-copy { min-width: 0; display: grid; gap: 2px; }
.mdbx2-snapshot-retention-copy small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-snapshot-prune-action { min-height: 44px; color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-snapshot-prune-confirmation { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-snapshot-prune-copy small { color: inherit; opacity: .84; overflow-wrap: anywhere; }
.mdbx2-snapshot-prune-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.mdbx2-snapshot-prune-actions m3e-button { min-height: 44px; }
.mdbx2-snapshot-error { margin: 0 16px 12px; }
.mdbx2-snapshot-refresh-required { min-height: 56px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; gap: 8px; padding: 12px 16px; color: var(--md-sys-color-on-tertiary-container, var(--app-text)); background: var(--md-sys-color-tertiary-container, var(--app-surface-high)); }
.mdbx2-snapshot-refresh-required m3e-icon { flex: 0 0 24px; --m3e-icon-size: 20px; }
.mdbx2-snapshot-list { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-snapshot-row { width: 100%; min-height: 64px; border: 0; border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 32px minmax(0, 1fr) auto 24px; align-items: center; gap: 12px; padding: 10px 16px; color: var(--app-text); background: transparent; text-align: left; cursor: pointer; font: inherit; }
.mdbx2-snapshot-row:last-child { border-bottom: 0; }
.mdbx2-snapshot-row:hover,
.mdbx2-snapshot-row.selected { background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-snapshot-row:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.mdbx2-snapshot-row:disabled { cursor: progress; opacity: .72; }
.mdbx2-snapshot-row time { color: var(--app-muted); font-size: .78rem; white-space: nowrap; }
.mdbx2-snapshot-icon,
.mdbx2-snapshot-confirm-icon { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.mdbx2-snapshot-row.integrity-failed .mdbx2-snapshot-icon,
.mdbx2-snapshot-confirm-icon { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-snapshot-icon m3e-icon,
.mdbx2-snapshot-confirm-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-snapshot-detail { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; gap: 12px; padding: 12px 16px; background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.mdbx2-snapshot-facts { display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--app-muted); }
.mdbx2-snapshot-facts span { min-height: 32px; display: inline-flex; align-items: center; gap: 6px; overflow-wrap: anywhere; }
.mdbx2-snapshot-facts span.error { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-snapshot-facts m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-snapshot-structure { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); margin-inline: -16px; }
.mdbx2-snapshot-structure-toolbar { display: grid; gap: 8px; padding: 12px 16px; }
.mdbx2-snapshot-structure-toolbar > div { width: fit-content; max-width: 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; overflow: hidden; }
.mdbx2-snapshot-structure-toolbar button { min-height: 44px; border: 0; padding: 0 14px; color: var(--app-text); background: transparent; cursor: pointer; font: inherit; font-weight: 600; }
.mdbx2-snapshot-structure-toolbar button + button { border-left: 1px solid var(--md-sys-color-outline, var(--app-outline)); }
.mdbx2-snapshot-structure-toolbar button.active { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-snapshot-structure-toolbar button:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.mdbx2-snapshot-structure-grid { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: minmax(0, 1fr); }
.mdbx2-snapshot-structure-grid.compare { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.mdbx2-snapshot-structure-side { min-width: 0; }
.mdbx2-snapshot-structure-side + .mdbx2-snapshot-structure-side { border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-snapshot-structure-side > header { min-height: 56px; display: grid; align-content: center; gap: 2px; padding: 8px 12px; background: var(--md-sys-color-surface-container, var(--app-surface-high)); }
.mdbx2-snapshot-node-list { max-height: 320px; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.mdbx2-snapshot-node { min-height: 56px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 12px; }
.mdbx2-snapshot-node-icon { width: 24px; height: 24px; display: grid; place-items: center; color: var(--app-muted); }
.mdbx2-snapshot-node-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-snapshot-node[data-status="added"] .mdbx2-snapshot-node-icon,
.mdbx2-snapshot-node[data-status="added"] .mdbx2-snapshot-node-status { color: var(--md-sys-color-primary, var(--app-primary)); }
.mdbx2-snapshot-node[data-status="removed"] .mdbx2-snapshot-node-icon,
.mdbx2-snapshot-node[data-status="removed"] .mdbx2-snapshot-node-status { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-snapshot-node[data-status="modified"] .mdbx2-snapshot-node-icon,
.mdbx2-snapshot-node[data-status="modified"] .mdbx2-snapshot-node-status { color: var(--md-sys-color-tertiary, var(--app-primary)); }
.mdbx2-snapshot-node-status { white-space: nowrap; font-weight: 600; }
.mdbx2-snapshot-structure-empty { min-height: 56px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; color: var(--app-muted); text-align: center; }
.mdbx2-snapshot-structure-empty m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-snapshot-structure-side > m3e-button { width: 100%; min-height: 44px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-snapshot-integrity-warning { border: 1px solid var(--md-sys-color-error, #ba1a1a); border-radius: 8px; display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: center; gap: 12px; padding: 12px; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-snapshot-integrity-warning > m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-snapshot-integrity-warning small { color: inherit; opacity: .82; }
.mdbx2-snapshot-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mdbx2-snapshot-actions m3e-button,
.mdbx2-snapshot-confirm-actions m3e-button { min-height: 44px; }
.mdbx2-snapshot-delete { color: var(--md-sys-color-error, #ba1a1a); }
.mdbx2-snapshot-confirmation { border: 1px solid var(--md-sys-color-error, var(--app-outline)); border-radius: 8px; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-snapshot-confirmation small { color: inherit; opacity: .82; }
.mdbx2-snapshot-confirm-actions { display: flex; align-items: center; gap: 8px; }
.mdbx2-snapshot-empty { min-height: 56px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 16px; color: var(--app-muted); text-align: center; }
.mdbx2-snapshot-empty m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-snapshot-more { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; justify-content: center; padding: 4px 12px; }
.mdbx2-conflict-panel { border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.mdbx2-conflict-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; }
.mdbx2-conflict-header > div,
.mdbx2-conflict-copy,
.mdbx2-conflict-detail-heading,
.mdbx2-conflict-confirmation > div:first-of-type { min-width: 0; display: grid; gap: 2px; }
.mdbx2-conflict-header small,
.mdbx2-conflict-copy small,
.mdbx2-conflict-detail small,
.mdbx2-conflict-confirmation small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-conflict-list { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-conflict-row { width: 100%; min-height: 64px; border: 0; border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 32px minmax(0, 1fr) auto 24px; align-items: center; gap: 12px; padding: 10px 16px; color: var(--app-text); background: transparent; text-align: left; cursor: pointer; font: inherit; }
.mdbx2-conflict-row:last-child { border-bottom: 0; }
.mdbx2-conflict-row:hover,
.mdbx2-conflict-row.selected { background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-conflict-row:focus-visible { outline: 3px solid color-mix(in srgb, var(--md-sys-color-error, var(--app-primary)) 45%, transparent); outline-offset: -3px; }
.mdbx2-conflict-row:disabled { cursor: progress; opacity: .72; }
.mdbx2-conflict-row time { color: var(--app-muted); font-size: .78rem; white-space: nowrap; }
.mdbx2-conflict-icon,
.mdbx2-conflict-confirm-icon { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-conflict-icon m3e-icon,
.mdbx2-conflict-confirm-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-conflict-detail { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); padding: 12px 16px; display: grid; gap: 12px; background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.mdbx2-conflict-fields { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; }
.mdbx2-conflict-fields li { max-width: 100%; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; padding: 6px 10px; overflow-wrap: anywhere; background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.mdbx2-conflict-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mdbx2-conflict-actions m3e-button,
.mdbx2-conflict-confirm-actions m3e-button { min-height: 44px; }
.mdbx2-conflict-confirmation { border: 1px solid var(--md-sys-color-error, var(--app-outline)); border-radius: 8px; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.mdbx2-conflict-confirmation small { color: inherit; opacity: .82; }
.mdbx2-conflict-confirm-actions { display: flex; align-items: center; gap: 8px; }
.mdbx2-conflict-empty { min-height: 56px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 16px; color: var(--app-muted); text-align: center; }
.mdbx2-conflict-empty m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-conflict-more { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; justify-content: center; padding: 4px 12px; }
.mdbx2-conflict-error { margin: 0 16px 12px; }
.mdbx2-history-panel { border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.mdbx2-history-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; }
.mdbx2-history-header > div,
.mdbx2-history-copy,
.mdbx2-history-detail-heading,
.mdbx2-diff-row > span:last-child { min-width: 0; display: grid; gap: 2px; }
.mdbx2-history-header small,
.mdbx2-history-copy small,
.mdbx2-history-detail small,
.mdbx2-diff-row small { color: var(--app-muted); overflow-wrap: anywhere; }
.mdbx2-history-list { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.mdbx2-history-row { width: 100%; min-height: 64px; border: 0; border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 32px minmax(0, 1fr) auto 24px; align-items: center; gap: 12px; padding: 10px 16px; color: var(--app-text); background: transparent; text-align: left; cursor: pointer; font: inherit; }
.mdbx2-history-row:last-child { border-bottom: 0; }
.mdbx2-history-row:hover,
.mdbx2-history-row.selected { background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.mdbx2-history-row:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.mdbx2-history-row:disabled { cursor: progress; opacity: .72; }
.mdbx2-history-row time { color: var(--app-muted); font-size: .78rem; white-space: nowrap; }
.mdbx2-history-icon { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.mdbx2-history-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-history-detail { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); padding: 12px 16px; display: grid; gap: 12px; background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.mdbx2-diff-list { display: grid; gap: 8px; }
.mdbx2-diff-row { min-height: 56px; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: center; gap: 12px; padding: 10px 12px; }
.mdbx2-history-actions { min-height: 56px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 12px; color: var(--app-muted); }
.mdbx2-history-confirmation { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px; background: var(--md-sys-color-error-container, var(--app-surface-high)); color: var(--md-sys-color-on-error-container, var(--app-text)); }
.mdbx2-history-confirmation > div:nth-child(2) { min-width: 0; display: grid; gap: 4px; }
.mdbx2-history-confirmation small { overflow-wrap: anywhere; }
.mdbx2-history-confirm-icon { width: 32px; height: 32px; display: grid; place-items: center; color: var(--md-sys-color-on-error-container, var(--app-text)); }
.mdbx2-history-confirm-icon m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-history-confirm-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.mdbx2-history-empty { min-height: 56px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 16px; color: var(--app-muted); text-align: center; }
.mdbx2-history-empty m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-history-more { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; justify-content: center; padding: 4px 12px; }
.mdbx2-history-error { margin: 0 16px 12px; }
code { overflow-wrap: anywhere; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
@container (max-width: 44rem) {
  .mdbx2-dialog.new-source-dialog .provider-actions { position: static; }
}
@media (max-width: 700px) {
  .mdbx2-form { display: flex; align-items: stretch; flex-direction: column; }
  .mdbx2-host-row { grid-template-columns: 24px minmax(0, 1fr); }
  .mdbx2-host-row > small { grid-column: 2; }
  .mdbx2-mode-picker > div,
  .mdbx2-inspection,
  .mdbx2-runtime-summary { grid-template-columns: 1fr; }
  .mdbx2-inspection span + span,
  .mdbx2-runtime-summary span + span { border-left: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
  .mdbx2-progress { align-items: stretch; flex-direction: column; }
  .mdbx2-progress progress { width: 100%; }
  .mdbx2-diagnostics-header { align-items: stretch; flex-direction: column; }
  .mdbx2-diagnostics-actions { align-items: stretch; flex-direction: column; }
  .mdbx2-diagnostics-health { grid-template-columns: 44px minmax(0, 1fr); }
  .mdbx2-diagnostics-severity-summary { grid-column: 2; max-width: none; text-align: left; }
  .mdbx2-health-repair-heading { grid-template-columns: 44px minmax(0, 1fr); }
  .mdbx2-health-repair-count { grid-column: 2; max-width: none; text-align: left; }
  .mdbx2-health-repair-row { grid-template-columns: 40px minmax(0, 1fr); }
  .mdbx2-health-repair-row > strong { grid-column: 2; white-space: normal; }
  .mdbx2-health-repair-choice-copy { grid-template-columns: minmax(0, 1fr); }
  .mdbx2-health-repair-choice-copy > div + div { border-left: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
  .mdbx2-health-repair-actions { align-items: stretch; flex-direction: column; }
  .mdbx2-health-repair-actions > m3e-button { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; }
  .mdbx2-health-repair-review-counts { grid-template-columns: minmax(0, 1fr); }
  .mdbx2-health-repair-review-counts > div + div { border-left: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
  .mdbx2-health-guidance-row summary { grid-template-columns: 40px minmax(0, 1fr) 24px; align-items: start; }
  .mdbx2-health-guidance-icon { grid-row: 1 / 3; }
  .mdbx2-health-guidance-severity { grid-column: 2; justify-self: start; white-space: normal; }
  .mdbx2-health-guidance-chevron { grid-column: 3; grid-row: 1 / 3; align-self: center; }
  .mdbx2-health-guidance-body { padding-left: 16px; }
  .mdbx2-health-guidance-body > m3e-button { justify-self: stretch; }
  .mdbx2-diagnostics-key-facts { grid-template-columns: minmax(0, 1fr); }
  .mdbx2-diagnostics-key-facts > div + div { border-left: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
  .mdbx2-diagnostics-category-row { grid-template-columns: 32px minmax(0, 1fr); }
  .mdbx2-diagnostics-category-count { grid-column: 2; white-space: normal; }
  .mdbx2-diagnostics-stat-groups dl { grid-template-columns: minmax(0, 1fr); }
  .mdbx2-tiga-header { align-items: stretch; flex-direction: column; }
  .mdbx2-tiga-overview { grid-template-columns: 44px minmax(0, 1fr); }
  .mdbx2-tiga-profile-badge { grid-column: 2; justify-self: start; }
  .mdbx2-tiga-key-facts { grid-template-columns: minmax(0, 1fr); }
  .mdbx2-tiga-key-facts > div + div { border-left: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
  .mdbx2-tiga-policy-groups dl { grid-template-columns: minmax(0, 1fr); }
  .mdbx2-collection-header { align-items: stretch; flex-direction: column; }
  .mdbx2-collection-header-actions { align-items: stretch; flex-direction: column; }
  .mdbx2-collection-tabs { grid-template-columns: minmax(0, 1fr); }
  .mdbx2-collection-tabs button + button { border-left: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
  .mdbx2-collection-editor { grid-template-columns: 32px minmax(0, 1fr); }
  .mdbx2-collection-editor-field,
  .mdbx2-collection-editor-actions { grid-column: 1 / -1; }
  .mdbx2-collection-editor-actions { align-items: stretch; flex-direction: column; }
  .mdbx2-collection-row { grid-template-columns: 32px minmax(0, 1fr); }
  .mdbx2-collection-row-actions,
  .mdbx2-collection-row > m3e-button { grid-column: 2; justify-self: stretch; }
  .mdbx2-collection-row-actions { justify-content: flex-start; }
  .mdbx2-snapshot-header { align-items: stretch; flex-direction: column; }
  .mdbx2-snapshot-create { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
  .mdbx2-snapshot-retention,
  .mdbx2-snapshot-prune-confirmation { grid-template-columns: 32px minmax(0, 1fr); }
  .mdbx2-snapshot-retention > m3e-button,
  .mdbx2-snapshot-prune-actions { grid-column: 1 / -1; }
  .mdbx2-snapshot-prune-actions { align-items: stretch; flex-direction: column; }
  .mdbx2-snapshot-row { grid-template-columns: 32px minmax(0, 1fr) 24px; }
  .mdbx2-snapshot-row time { grid-column: 2; white-space: normal; }
  .mdbx2-snapshot-structure-toolbar > div { width: 100%; }
  .mdbx2-snapshot-structure-grid.compare { grid-template-columns: minmax(0, 1fr); }
  .mdbx2-snapshot-structure-side + .mdbx2-snapshot-structure-side { border-left: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
  .mdbx2-snapshot-node { grid-template-columns: 24px minmax(0, 1fr); }
  .mdbx2-snapshot-node-status { grid-column: 2; white-space: normal; }
  .mdbx2-snapshot-actions { grid-template-columns: minmax(0, 1fr); }
  .mdbx2-snapshot-confirmation { grid-template-columns: 32px minmax(0, 1fr); }
  .mdbx2-snapshot-confirm-actions { grid-column: 1 / -1; align-items: stretch; flex-direction: column; }
  .mdbx2-conflict-header { align-items: stretch; flex-direction: column; }
  .mdbx2-conflict-row { grid-template-columns: 32px minmax(0, 1fr) 24px; }
  .mdbx2-conflict-row time { grid-column: 2; white-space: normal; }
  .mdbx2-conflict-actions { grid-template-columns: 1fr; }
  .mdbx2-conflict-confirmation { grid-template-columns: 32px minmax(0, 1fr); }
  .mdbx2-conflict-confirm-actions { grid-column: 1 / -1; align-items: stretch; flex-direction: column; }
  .mdbx2-history-header { align-items: stretch; flex-direction: column; }
  .mdbx2-history-row { grid-template-columns: 32px minmax(0, 1fr) 24px; }
  .mdbx2-history-row time { grid-column: 2; white-space: normal; }
  .mdbx2-history-actions { align-items: stretch; flex-direction: column; }
  .mdbx2-history-confirmation { grid-template-columns: 32px minmax(0, 1fr); }
  .mdbx2-history-confirm-actions { grid-column: 1 / -1; align-items: stretch; flex-direction: column; }
}
</style>
