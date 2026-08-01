<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type { ProviderAccount } from "../core/model";
import {
  MDBX2_MAX_INBOUND_FILE_BYTES,
  MDBX2_MAX_SNAPSHOT_NAME_BYTES,
  type Mdbx2CommitDiffItem,
  type Mdbx2CommitHistoryItem,
  type Mdbx2ConflictResolutionChoice,
  type Mdbx2ConflictSummary,
  type Mdbx2HostStatus,
  type Mdbx2ManagedSnapshotSummary,
  type Mdbx2SnapshotStructureNode,
  type Mdbx2SnapshotStructureSide,
  type Mdbx2UnlockMethod,
  type Mdbx2VaultCredential,
  type Mdbx2VaultInspection,
  type Mdbx2VaultRuntimeStatus,
  type Mdbx2VaultSource
} from "../providers/mdbx2/native-contract";
import { formatMdbx2HistoryTime, presentMdbx2Diff, presentMdbx2History } from "../providers/mdbx2/mdbx2-history";
import { mdbx2ConflictChoiceDescription, mdbx2ConflictChoiceLabel, presentMdbx2Conflict } from "../providers/mdbx2/mdbx2-conflicts";
import { presentMdbx2Snapshot, presentMdbx2SnapshotNode } from "../providers/mdbx2/mdbx2-snapshots";
import { vaultClient } from "../runtime/client";
import type { Mdbx2ManagerSyncStatus, Mdbx2WebDavSettingsInput } from "../runtime/messages";

type NewSourceMode = "local" | "remote";
type BusyState = "" | "probe" | "upload" | "download" | "open" | "save" | "publish";
type SnapshotBusyState = "" | "list" | "structure" | "create" | "delete" | "restore";
type SnapshotStructureMode = "snapshot" | "compare";
type SnapshotMutationAction = "delete" | "restore";
interface PendingConflictResolution { item: Mdbx2ConflictSummary; choice: Mdbx2ConflictResolutionChoice; operationId: string }
interface PendingSnapshotCreate { operationId: string; name: string }
interface PendingSnapshotMutation { item: Mdbx2ManagedSnapshotSummary; action: SnapshotMutationAction; operationId: string; attempted: boolean }
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
const busy = ref<BusyState>("");
const error = ref("");
const uploadProgress = ref(0);
const vaultFile = ref<File | null>(null);
const securityKeyFile = ref<File | null>(null);
const pendingSource = ref<Mdbx2VaultSource | undefined>();
const pendingOriginKey = ref("");
const inspection = ref<Mdbx2VaultInspection | undefined>();
const revealVaultPassword = ref(false);
const historyItems = ref<Mdbx2CommitHistoryItem[]>([]);
const historyCursor = ref<string | undefined>();
const historyLoaded = ref(false);
const historyBusy = ref<"" | "list" | "diff">("");
const historyError = ref("");
const selectedCommitId = ref("");
const commitDiffItems = ref<Mdbx2CommitDiffItem[]>([]);
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
const snapshotRequiresRefresh = ref(false);
const confirmSnapshotButton = ref<HTMLElement | null>(null);

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
const remoteFieldsComplete = computed(() => Boolean(form.baseUrl.trim() && form.remotePath.trim()));
const needsSecurityKey = computed(() => form.unlockMethod !== "password");
const canPublish = computed(() => isExisting.value && vaultOpen.value && remoteFieldsComplete.value && !syncStatus.value?.initialized);
const selectedHistoryItem = computed(() => historyItems.value.find((item) => item.commitId === selectedCommitId.value));
const selectedConflict = computed(() => conflictItems.value.find((item) => item.conflictId === selectedConflictId.value));
const selectedSnapshot = computed(() => snapshotItems.value.find((item) => item.snapshotId === selectedSnapshotId.value));
const snapshotNameBytes = computed(() => new TextEncoder().encode(snapshotName.value.trim()).byteLength);
const snapshotNameTooLong = computed(() => snapshotNameBytes.value > MDBX2_MAX_SNAPSHOT_NAME_BYTES);
const snapshotMutating = computed(() => snapshotBusy.value === "create" || snapshotBusy.value === "delete" || snapshotBusy.value === "restore");
const managerMutationLocked = computed(() => conflictBusy.value === "resolve" || snapshotMutating.value);
const dialogLocked = computed(() => Boolean(busy.value) || managerMutationLocked.value);
const dialogTitle = computed(() => {
  if (isExisting.value) return `管理 ${activeProvider.value?.name || form.name}`;
  return form.mode === "remote" ? "从 WebDAV 加入 MDBX2" : "打开 MDBX2 保险库";
});
const busyLabel = computed(() => ({
  probe: "正在检查 Native Host…",
  upload: `正在传输本地文件… ${uploadProgress.value}%`,
  download: "正在下载并校验可移植备份…",
  open: "正在验证、解锁并检查保险库…",
  save: "正在加密保存设置…",
  publish: "正在生成并发布可移植备份…"
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
    if (nextRuntime?.open) await Promise.all([loadSnapshots(true), loadConflicts(true)]);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
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
  if (!hostReady.value) return void (error.value = hostStatus.value?.message || "MDBX2 Native Host 尚未就绪。");
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
    emit("notice", syncNotice(result, form.mode === "remote" ? "MDBX2 WebDAV 已加入并同步。" : "MDBX2 本机保险库已打开并导入。"));
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
  if (!providerId.value || !vaultHandle) return void (error.value = "MDBX2 本机工作副本不存在。");
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
    emit("changed");
    clearSecrets();
    await Promise.all([loadSnapshots(true), loadHistory(true), loadConflicts(true)]);
    emit("notice", `${opened.account.name} 已解锁；现在可以查看提交历史或执行增量同步。`);
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
    emit("notice", "MDBX2 WebDAV 设置已保存到加密密码库。远端位置变化时旧 checkpoint 已解除绑定。");
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
    emit("notice", "MDBX2 可移植备份已发布；后续多设备同步使用不可变增量段和加密 Blob。");
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function loadHistory(reset = false) {
  if (!providerId.value || !vaultOpen.value || historyBusy.value) return;
  historyBusy.value = "list";
  historyError.value = "";
  if (reset) {
    historyItems.value = [];
    historyCursor.value = undefined;
    selectedCommitId.value = "";
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
  } catch (cause) {
    historyError.value = historyErrorMessage(cause);
  } finally {
    historyBusy.value = "";
  }
}

async function selectHistory(item: Mdbx2CommitHistoryItem) {
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
    emit("changed");
    emit("notice", `${mdbx2ConflictChoiceLabel(pending.choice)}；此决定将在下次增量同步时发布。`);
  } catch (cause) {
    conflictError.value = conflictErrorMessage(cause);
  } finally {
    conflictBusy.value = "";
  }
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
      snapshotRequiresRefresh.value = false;
    }
  } catch (cause) {
    snapshotError.value = snapshotErrorMessage(cause);
  } finally {
    snapshotBusy.value = "";
  }
}

async function selectSnapshot(item: Mdbx2ManagedSnapshotSummary) {
  if (snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve") return;
  selectedSnapshotId.value = selectedSnapshotId.value === item.snapshotId ? "" : item.snapshotId;
  pendingSnapshotMutation.value = undefined;
  snapshotError.value = "";
  snapshotStructureMode.value = "snapshot";
  resetSnapshotStructures();
  if (selectedSnapshotId.value && item.integrityOk) await loadSnapshotStructure("snapshot", true);
}

async function changeSnapshotStructureMode(mode: SnapshotStructureMode) {
  if (!selectedSnapshot.value || snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve") return;
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
  if (!providerId.value || !item || !item.integrityOk || snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve") return;
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
  if (!providerId.value || snapshotBusy.value || snapshotNameTooLong.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve") return;
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
    emit("notice", result.alreadyCompleted ? "手动完整快照已确认创建。" : "手动完整快照已创建。");
  } catch (cause) {
    snapshotError.value = snapshotErrorMessage(cause);
    if (errorCode(cause) === "snapshot-operation-state-unknown") snapshotRequiresRefresh.value = true;
  } finally {
    snapshotBusy.value = "";
  }
  if (completed) await refreshAfterSnapshotMutation();
}

async function requestSnapshotMutation(item: Mdbx2ManagedSnapshotSummary, action: SnapshotMutationAction) {
  if (snapshotBusy.value || snapshotRequiresRefresh.value || conflictBusy.value === "resolve" || (action === "restore" && !item.integrityOk)) return;
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
      emit("notice", result.alreadyCompleted ? "快照删除结果已确认。" : "快照已永久删除。");
    } else {
      const result = await vaultClient.restoreMdbx2Snapshot(providerId.value, pending.operationId, pending.item.snapshotId);
      emit("notice", `${result.alreadyCompleted ? "快照恢复结果已确认" : "快照已恢复"}，共处理 ${result.affectedObjectCount} 个对象。`);
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
    loadSnapshots(true),
    loadHistory(true),
    vaultClient.mdbx2SyncStatus(providerId.value).then((status) => { syncStatus.value = status; }).catch(() => undefined)
  ]);
  emit("changed");
}

function snapshotMutationLabel(action: SnapshotMutationAction): string {
  return action === "restore" ? "恢复此快照" : "永久删除快照";
}

function snapshotMutationButtonLabel(action: SnapshotMutationAction, retry: boolean): string {
  if (action === "restore") return retry ? "重试恢复" : "确认恢复";
  return retry ? "重试删除" : "确认删除";
}

function snapshotMutationDescription(action: SnapshotMutationAction): string {
  return action === "restore"
    ? "当前保险库将恢复到此快照记录的完整状态。快照之后创建的对象会按 MDBX2 规则写入删除历史，此操作会生成新的同步提交。"
    : "此快照及其加密内容将从本地保险库永久删除。当前密码、笔记和附件内容保持不变，删除结果会作为新的同步提交发布。";
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
  if (!file) throw new Error("请选择 MDBX2 .mdbx 文件。");
  if (!file.name.toLocaleLowerCase().endsWith(".mdbx")) throw new Error("MDBX2 可移植备份必须使用 .mdbx 扩展名。");
  if (!file.size || file.size > MDBX2_MAX_INBOUND_FILE_BYTES) throw new Error("MDBX2 文件为空或超过 2 GiB 安全上限。");
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
  if (!remoteFieldsComplete.value) throw new Error("请填写 WebDAV 地址和 Android 兼容远端位置。");
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
  if (!file) throw new Error("所选解锁方式需要安全密钥文件。");
  if (!file.size || file.size > 64 * 1024) throw new Error("MDBX2 安全密钥文件为空或超过 64 KiB 上限。");
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
  void releasePendingSource();
  clearSecrets();
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
  if (!status) return "检查中";
  return ({ ready: "Host 已就绪", "not-installed": "Host 未安装", incompatible: "Host 版本不兼容", unavailable: "Host 暂不可用" } as const)[status.availability];
}

function hostStateClass(status: Mdbx2HostStatus | null): string {
  return status?.availability === "ready" ? "ready" : status ? "attention" : "neutral";
}

function syncNotice(result: { warnings: string[]; conflicts: number }, fallback: string): string {
  if (result.conflicts) return `${fallback} 检测到 ${result.conflicts} 个需要人工处理的冲突。`;
  return result.warnings[0] || fallback;
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error(`无法读取文件：${file.name}`));
    reader.onload = () => {
      if (typeof reader.result !== "string") return void reject(new Error(`无法读取文件：${file.name}`));
      const separator = reader.result.indexOf(",");
      if (separator < 0) return void reject(new Error(`文件编码无效：${file.name}`));
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "MDBX2 操作失败。";
}

function errorCode(cause: unknown): string {
  return cause && typeof cause === "object" && "code" in cause ? String((cause as { code?: unknown }).code || "") : "";
}

function snapshotErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "snapshot-result-too-large") return "快照记录超过单次安全上限，请缩小分页后重试。";
  if (code === "snapshot-structure-too-large") return "快照结构超过浏览器可安全展示的节点上限；快照本身仍保留在保险库中。";
  if (code === "snapshot-structure-stale") return "保险库内容在结构分页期间发生变化，请重新打开此快照预览。";
  if (code === "snapshot-integrity-failed") return "快照完整性校验失败，结构预览和恢复均已停止；可以保留记录用于诊断或确认后删除。";
  if (code === "snapshot-operation-state-unknown") return "Native Host 无法证明快照操作的最终结果。请刷新快照和提交历史，确认当前状态后再继续；不要立即重复恢复或删除。";
  if (code === "snapshot-operation-pending") return "此保险库已有一项快照操作等待确认，请重试原操作或刷新快照状态。";
  if (code === "snapshot-operation-mismatch") return "快照重试内容与先前操作不一致，请刷新状态后重新选择。";
  if (code === "snapshot-not-found") return "此快照已被其他操作删除，请刷新快照列表。";
  if (code === "snapshot-name-invalid") return "快照名称超过 96 个 UTF-8 字节，请缩短后重试。";
  return errorMessage(cause);
}

function historyErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "history-diff-too-large") return "这次提交包含的对象过多，当前版本无法一次展开全部详情；提交记录本身仍然有效。";
  if (code === "history-result-too-large") return "历史记录内容超过单次安全上限，请缩小分页后重试。";
  return errorMessage(cause);
}

function conflictErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "conflict-result-too-large") return "冲突记录超过单次安全上限，请缩小分页后重试。";
  if (code === "conflict-resolution-state-unknown") return "Native Host 在写入冲突决定时异常中断，无法确认最终采用了哪个版本。请先刷新数据库，不要立即选择相反版本。";
  if (code === "conflict-not-found") return "这个冲突已被其他操作处理，请刷新冲突列表。";
  return errorMessage(cause);
}
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section class="editor-dialog provider-dialog mdbx2-dialog" role="dialog" aria-modal="true" aria-labelledby="mdbx2-dialog-title">
      <header>
        <div>
          <h2 id="mdbx2-dialog-title">{{ dialogTitle }}</h2>
          <p>浏览器保存本机加密工作副本，网盘只交换可移植备份、增量段和加密 Blob。</p>
        </div>
        <m3e-icon-button data-dialog-close aria-label="关闭 MDBX2 设置" :disabled="dialogLocked" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <form class="provider-form mdbx2-form" @submit.prevent="isExisting ? saveSettings() : connectNewSource()">
        <div class="mdbx2-host-row field-wide" :class="hostStateClass(hostStatus)" role="status" aria-live="polite">
          <m3e-icon :name="hostReady ? 'check_circle' : 'computer'" />
          <div><strong>{{ hostStateLabel(hostStatus) }}</strong><small>{{ hostStatus?.message || '正在检查 com.monica_pass.mdbx2。' }}</small></div>
          <small v-if="hostStatus?.capabilities">Host {{ hostStatus.capabilities.hostVersion }} · Core {{ hostStatus.capabilities.mdbxCoreRevision.slice(0, 8) }}</small>
        </div>

        <template v-if="!isExisting">
          <fieldset class="mdbx2-mode-picker field-wide">
            <legend>加入方式</legend>
            <div>
              <button type="button" :aria-pressed="form.mode === 'local'" :class="{ active: form.mode === 'local' }" :disabled="Boolean(busy)" @click="setMode('local')"><m3e-icon name="folder_open" />本地 .mdbx 文件</button>
              <button type="button" :aria-pressed="form.mode === 'remote'" :class="{ active: form.mode === 'remote' }" :disabled="Boolean(busy)" @click="setMode('remote')"><m3e-icon name="cloud_download" />从 WebDAV 加入</button>
            </div>
          </fieldset>
          <label class="field"><span>显示名称</span><input v-model="form.name" autocomplete="off" autofocus placeholder="Monica MDBX2" /></label>
          <label class="favorite-row"><input v-model="form.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
        </template>

        <template v-if="!isExisting && form.mode === 'local'">
          <div class="field field-wide"><span>MDBX2 可移植备份 *</span><label class="file-action provider-file-action"><m3e-icon name="folder_open" /><span>{{ vaultFile?.name || '选择 .mdbx 文件' }}</span><input type="file" accept=".mdbx,application/octet-stream" aria-label="MDBX2 可移植备份" @change="selectVaultFile" /></label><small>扩展从 MDBX2 开始支持；MDBX1 和 MDBX1-DRAFT 会在只读检查阶段拒绝。</small></div>
        </template>

        <template v-if="form.mode === 'remote' || isExisting">
          <label v-if="isExisting" class="field"><span>显示名称</span><input v-model="form.name" autocomplete="off" /></label>
          <label v-if="isExisting" class="favorite-row"><input v-model="form.isDefaultSaveTarget" type="checkbox" /><span>设为新项目的默认保存目标</span></label>
          <label class="field field-wide"><span>WebDAV 地址 *</span><input v-model="form.baseUrl" type="url" autocomplete="url" placeholder="https://cloud.example.com/remote.php/dav/files/user" required /><small>必须使用 HTTPS；开发环境仅允许回环 HTTP。地址中不能包含用户名、密码、查询参数或片段。</small></label>
          <label class="field"><span>用户名</span><input v-model="form.username" autocomplete="username" /></label>
          <label class="field"><span>WebDAV 密码</span><input v-model="form.webDavPassword" type="password" autocomplete="current-password" :placeholder="form.webDavPasswordConfigured ? '已加密保存；留空保持不变' : ''" /></label>
          <label class="field field-wide"><span>Android 兼容远端位置 *</span><input v-model="form.remotePath" autocomplete="off" placeholder="Monica/MDBX2/main.mdbx" required /><small>此路径就是可移植 .mdbx 文件；日常同步对象自动写入同名 <code>.sync</code> 目录。</small></label>
        </template>

        <template v-if="!isExisting || !vaultOpen">
          <label class="field"><span>解锁方式</span><select v-model="form.unlockMethod"><option value="password">密码</option><option value="security-key">安全密钥</option><option value="password-security-key">密码 + 安全密钥</option></select></label>
          <label v-if="form.unlockMethod !== 'security-key'" class="field"><span>保险库密码（可留空）</span><div class="password-field"><input v-model="form.vaultPassword" :type="revealVaultPassword ? 'text' : 'password'" autocomplete="current-password" /><button type="button" @click="revealVaultPassword = !revealVaultPassword">{{ revealVaultPassword ? '隐藏' : '显示' }}</button></div></label>
          <div v-if="needsSecurityKey" class="field field-wide"><span>安全密钥文件 *</span><label class="file-action provider-file-action secondary"><m3e-icon name="key" /><span>{{ securityKeyFile?.name || '选择最大 64 KiB 的安全密钥文件' }}</span><input type="file" aria-label="MDBX2 安全密钥文件" @change="selectSecurityKey" /></label><small>密码和安全密钥只进入 Native Host 的本次解锁调用，不会保存到插件密码库。</small></div>
        </template>

        <div v-if="inspection" class="mdbx2-inspection field-wide" role="status">
          <span><strong>{{ inspection.formatVersion }}</strong><small>格式</small></span>
          <span><strong>{{ inspection.schemaVersion ?? '—' }}</strong><small>Schema</small></span>
          <span><strong>{{ inspection.requiresUpgrade ? '需要迁移' : '当前版本' }}</strong><small>打开前检查</small></span>
        </div>

        <div v-if="isExisting" class="mdbx2-runtime-summary field-wide" aria-label="MDBX2 运行状态">
          <span><strong>{{ runtimeStatus?.available ? '本机副本可用' : '本机副本缺失' }}</strong><small>{{ vaultOpen ? '当前已解锁' : '当前已锁定' }}</small></span>
          <span><strong>{{ syncStatus?.initialized ? '增量同步已注册' : syncStatus?.configured ? 'WebDAV 已配置' : '仅本机模式' }}</strong><small>{{ syncStatus?.hasLocalChanges ? '存在待发布修改' : 'checkpoint 已保存' }}</small></span>
          <span><strong>{{ syncStatus?.blockedStreamCount || 0 }} 个受阻 stream</strong><small>{{ syncStatus?.remoteStreamCount || 0 }} 个远端 stream</small></span>
        </div>

        <section v-if="isExisting && vaultOpen" class="mdbx2-snapshot-panel field-wide" aria-labelledby="mdbx2-snapshot-title">
          <div class="mdbx2-snapshot-header">
            <div>
              <strong id="mdbx2-snapshot-title">数据库快照</strong>
              <small>用于恢复完整保险库状态；列表和结构预览不会显示 Snapshot、Object、Commit ID、metadata 或 payload。</small>
            </div>
            <m3e-button variant="tonal" type="button" :disabled="Boolean(snapshotBusy) || conflictBusy === 'resolve'" @click="loadSnapshots(true)"><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ snapshotLoaded ? '刷新' : '加载快照' }}</m3e-button>
          </div>

          <div class="mdbx2-snapshot-create">
            <label class="mdbx2-snapshot-name" for="mdbx2-snapshot-name">
              <span>快照名称（可留空）</span>
              <input
                id="mdbx2-snapshot-name"
                v-model="snapshotName"
                autocomplete="off"
                :aria-invalid="snapshotNameTooLong"
                aria-describedby="mdbx2-snapshot-name-help"
                :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotCreate) || snapshotRequiresRefresh || conflictBusy === 'resolve'"
                placeholder="例如：升级前"
                @keydown.enter.prevent="createSnapshot"
              />
            </label>
            <div id="mdbx2-snapshot-name-help" class="mdbx2-snapshot-create-copy">
              <small>MDBX2 手动快照始终保存完整且经过认证的保险库状态；留空时由 Core 生成名称。</small>
              <small :class="{ error: snapshotNameTooLong }">{{ snapshotNameBytes }} / {{ MDBX2_MAX_SNAPSHOT_NAME_BYTES }} UTF-8 字节</small>
            </div>
            <m3e-button variant="filled" type="button" :disabled="Boolean(snapshotBusy) || snapshotNameTooLong || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="createSnapshot"><m3e-icon slot="icon" name="add"></m3e-icon>{{ snapshotBusy === 'create' ? '正在创建…' : pendingSnapshotCreate ? '重试创建' : '创建完整快照' }}</m3e-button>
          </div>

          <p v-if="snapshotError" class="form-error mdbx2-snapshot-error" role="alert">{{ snapshotError }}</p>
          <div v-if="snapshotRequiresRefresh" class="mdbx2-snapshot-refresh-required" role="status">
            <m3e-icon name="sync" />
            <span>快照操作结果需要人工核对。请先使用上方“刷新”，查看快照和随后更新的提交历史。</span>
          </div>
          <div v-if="snapshotBusy === 'list' && !snapshotItems.length" class="mdbx2-snapshot-empty" role="status"><m3e-icon name="progress_activity" /><span>正在读取快照记录…</span></div>
          <div v-else-if="snapshotLoaded && !snapshotItems.length" class="mdbx2-snapshot-empty"><m3e-icon name="backup_table" /><span>暂无数据库快照。</span></div>

          <div v-if="snapshotItems.length" class="mdbx2-snapshot-list" aria-label="MDBX2 数据库快照列表">
            <button
              v-for="item in snapshotItems"
              :key="item.snapshotId"
              type="button"
              class="mdbx2-snapshot-row"
              :class="{ selected: selectedSnapshotId === item.snapshotId, 'integrity-failed': !item.integrityOk }"
              :aria-expanded="selectedSnapshotId === item.snapshotId"
              :disabled="Boolean(snapshotBusy) || snapshotRequiresRefresh || conflictBusy === 'resolve'"
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

            <div class="mdbx2-snapshot-facts" aria-label="快照属性">
              <span><m3e-icon name="person" />{{ presentMdbx2Snapshot(selectedSnapshot).kindLabel }}</span>
              <span><m3e-icon name="database" />{{ presentMdbx2Snapshot(selectedSnapshot).completenessLabel }}</span>
              <span><m3e-icon name="data_usage" />{{ presentMdbx2Snapshot(selectedSnapshot).sizeLabel }}</span>
              <span :class="{ error: !selectedSnapshot.integrityOk }"><m3e-icon :name="selectedSnapshot.integrityOk ? 'verified_user' : 'gpp_bad'" />{{ presentMdbx2Snapshot(selectedSnapshot).integrityLabel }}</span>
            </div>

            <div v-if="selectedSnapshot.integrityOk" class="mdbx2-snapshot-structure">
              <div class="mdbx2-snapshot-structure-toolbar">
                <div role="group" aria-label="快照结构查看方式">
                  <button type="button" :aria-pressed="snapshotStructureMode === 'snapshot'" :class="{ active: snapshotStructureMode === 'snapshot' }" :disabled="Boolean(snapshotBusy) || conflictBusy === 'resolve'" @click="changeSnapshotStructureMode('snapshot')">仅快照</button>
                  <button type="button" :aria-pressed="snapshotStructureMode === 'compare'" :class="{ active: snapshotStructureMode === 'compare' }" :disabled="Boolean(snapshotBusy) || conflictBusy === 'resolve'" @click="changeSnapshotStructureMode('compare')">与现版本比较</button>
                </div>
                <small>结构只包含可读名称、路径、类型和变化状态；附件内容与自定义 metadata 留在 Native Host。</small>
              </div>

              <div class="mdbx2-snapshot-structure-grid" :class="{ compare: snapshotStructureMode === 'compare' }">
                <section v-if="snapshotStructureMode === 'compare'" class="mdbx2-snapshot-structure-side" aria-labelledby="mdbx2-current-structure-title">
                  <header><strong id="mdbx2-current-structure-title">当前版本</strong><small>{{ currentSnapshotStructure.loaded ? `${currentSnapshotStructure.items.length} / ${currentSnapshotStructure.totalNodes} 个节点 · ${currentSnapshotStructure.currentItemCount} 项` : '等待加载' }}</small></header>
                  <div v-if="snapshotBusy === 'structure' && !currentSnapshotStructure.loaded" class="mdbx2-snapshot-structure-empty" role="status"><m3e-icon name="progress_activity" />正在读取当前结构…</div>
                  <div v-else-if="currentSnapshotStructure.loaded && !currentSnapshotStructure.items.length" class="mdbx2-snapshot-structure-empty">当前版本没有可显示的项目。</div>
                  <div v-if="currentSnapshotStructure.items.length" class="mdbx2-snapshot-node-list" aria-label="当前版本结构">
                    <div v-for="node in currentSnapshotStructure.items" :key="node.nodeId" class="mdbx2-snapshot-node" :data-status="node.status">
                      <span class="mdbx2-snapshot-node-icon"><m3e-icon :name="presentMdbx2SnapshotNode(node).statusIcon" /></span>
                      <span><strong>{{ presentMdbx2SnapshotNode(node).title }}</strong><small>{{ presentMdbx2SnapshotNode(node).supportingText }}</small></span>
                      <small class="mdbx2-snapshot-node-status">{{ presentMdbx2SnapshotNode(node).statusLabel }}</small>
                    </div>
                  </div>
                  <m3e-button v-if="currentSnapshotStructure.cursor" variant="text" type="button" :disabled="Boolean(snapshotBusy) || conflictBusy === 'resolve'" @click="loadSnapshotStructure('current', false)">加载更多当前项目</m3e-button>
                </section>

                <section class="mdbx2-snapshot-structure-side" aria-labelledby="mdbx2-saved-structure-title">
                  <header><strong id="mdbx2-saved-structure-title">快照版本</strong><small>{{ savedSnapshotStructure.loaded ? `${savedSnapshotStructure.items.length} / ${savedSnapshotStructure.totalNodes} 个节点 · ${savedSnapshotStructure.snapshotItemCount} 项` : '等待加载' }}</small></header>
                  <div v-if="snapshotBusy === 'structure' && !savedSnapshotStructure.loaded" class="mdbx2-snapshot-structure-empty" role="status"><m3e-icon name="progress_activity" />正在读取快照结构…</div>
                  <div v-else-if="savedSnapshotStructure.loaded && !savedSnapshotStructure.items.length" class="mdbx2-snapshot-structure-empty">此快照没有可显示的项目。</div>
                  <div v-if="savedSnapshotStructure.items.length" class="mdbx2-snapshot-node-list" aria-label="快照版本结构">
                    <div v-for="node in savedSnapshotStructure.items" :key="node.nodeId" class="mdbx2-snapshot-node" :data-status="node.status">
                      <span class="mdbx2-snapshot-node-icon"><m3e-icon :name="presentMdbx2SnapshotNode(node).statusIcon" /></span>
                      <span><strong>{{ presentMdbx2SnapshotNode(node).title }}</strong><small>{{ presentMdbx2SnapshotNode(node).supportingText }}</small></span>
                      <small class="mdbx2-snapshot-node-status">{{ presentMdbx2SnapshotNode(node).statusLabel }}</small>
                    </div>
                  </div>
                  <m3e-button v-if="savedSnapshotStructure.cursor" variant="text" type="button" :disabled="Boolean(snapshotBusy) || conflictBusy === 'resolve'" @click="loadSnapshotStructure('snapshot', false)">加载更多快照项目</m3e-button>
                </section>
              </div>
            </div>

            <div v-else class="mdbx2-snapshot-integrity-warning" role="alert">
              <m3e-icon name="gpp_bad" />
              <span><strong>完整性校验失败</strong><small>Native Host 已停止解密结构和恢复操作。此记录仍可保留用于诊断，也可以在确认后永久删除。</small></span>
            </div>

            <div v-if="!pendingSnapshotMutation" class="mdbx2-snapshot-actions">
              <m3e-button class="mdbx2-snapshot-delete" variant="tonal" type="button" :disabled="Boolean(snapshotBusy) || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="requestSnapshotMutation(selectedSnapshot, 'delete')"><m3e-icon slot="icon" name="delete_forever"></m3e-icon>删除快照</m3e-button>
              <m3e-button class="mdbx2-snapshot-restore" variant="filled" type="button" :disabled="Boolean(snapshotBusy) || snapshotRequiresRefresh || conflictBusy === 'resolve' || !presentMdbx2Snapshot(selectedSnapshot).canRestore" @click="requestSnapshotMutation(selectedSnapshot, 'restore')"><m3e-icon slot="icon" name="restore"></m3e-icon>恢复此快照</m3e-button>
            </div>

            <div v-else class="mdbx2-snapshot-confirmation" role="group" aria-labelledby="mdbx2-snapshot-confirm-title" aria-live="assertive">
              <span class="mdbx2-snapshot-confirm-icon"><m3e-icon name="warning" /></span>
              <div>
                <strong id="mdbx2-snapshot-confirm-title">确认{{ snapshotMutationLabel(pendingSnapshotMutation.action) }}？</strong>
                <small>{{ snapshotMutationDescription(pendingSnapshotMutation.action) }}</small>
                <small v-if="pendingSnapshotMutation.attempted">原操作意图和标识已保留。可以使用同一确认按钮重试，或先刷新状态进行核对。</small>
              </div>
              <div class="mdbx2-snapshot-confirm-actions">
                <m3e-button variant="text" type="button" :disabled="pendingSnapshotMutation.attempted || Boolean(snapshotBusy) || conflictBusy === 'resolve'" @click="cancelSnapshotMutation">返回预览</m3e-button>
                <m3e-button
                  ref="confirmSnapshotButton"
                  variant="filled"
                  type="button"
                  :aria-label="`确认${snapshotMutationLabel(pendingSnapshotMutation.action)}`"
                  :disabled="Boolean(snapshotBusy) || snapshotRequiresRefresh || conflictBusy === 'resolve'"
                  @click="confirmSnapshotMutation"
                >{{ snapshotRequiresRefresh ? '请先刷新状态' : snapshotBusy === pendingSnapshotMutation.action ? '正在处理…' : snapshotMutationButtonLabel(pendingSnapshotMutation.action, pendingSnapshotMutation.attempted) }}</m3e-button>
              </div>
            </div>
          </div>

          <div v-if="snapshotCursor" class="mdbx2-snapshot-more"><m3e-button variant="text" type="button" :disabled="Boolean(snapshotBusy) || conflictBusy === 'resolve'" @click="loadSnapshots(false)">加载更多快照</m3e-button></div>
        </section>

        <section v-if="isExisting && vaultOpen" class="mdbx2-conflict-panel field-wide" aria-labelledby="mdbx2-conflict-title">
          <div class="mdbx2-conflict-header">
            <div>
              <strong id="mdbx2-conflict-title">同步冲突</strong>
              <small>{{ conflictLoaded ? `${conflictItems.length}${conflictCursor ? '+' : ''} 项待处理` : '检查多个设备同时修改的项目' }}；这里只显示字段名称和本机标题，不显示 payload 或 Commit ID。</small>
            </div>
            <m3e-button variant="tonal" type="button" :disabled="Boolean(conflictBusy) || snapshotMutating" @click="loadConflicts(true)"><m3e-icon slot="icon" name="sync_problem"></m3e-icon>{{ conflictLoaded ? '刷新' : '检查冲突' }}</m3e-button>
          </div>
          <p v-if="conflictError" class="form-error mdbx2-conflict-error" role="alert">{{ conflictError }}</p>
          <div v-if="conflictBusy === 'list' && !conflictItems.length" class="mdbx2-conflict-empty" role="status"><m3e-icon name="progress_activity" /><span>正在读取冲突队列…</span></div>
          <div v-else-if="conflictLoaded && !conflictItems.length" class="mdbx2-conflict-empty"><m3e-icon name="check_circle" /><span>没有待处理的同步冲突。</span></div>
          <div v-if="conflictItems.length" class="mdbx2-conflict-list" aria-label="MDBX2 同步冲突列表">
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
              <small>{{ presentMdbx2Conflict(selectedConflict).objectLabel }}在本机和另一台设备上被同时修改。请选择最终版本；选择本身会生成新的 MDBX2 同步变更。</small>
            </div>
            <ul v-if="presentMdbx2Conflict(selectedConflict).fieldLabels.length" class="mdbx2-conflict-fields" aria-label="发生冲突的字段">
              <li v-for="field in presentMdbx2Conflict(selectedConflict).fieldLabels" :key="field">{{ field }}</li>
            </ul>
            <div v-if="!pendingConflictResolution" class="mdbx2-conflict-actions">
              <m3e-button variant="tonal" type="button" :disabled="Boolean(conflictBusy) || snapshotMutating" @click="requestConflictResolution(selectedConflict, 'local-wins')">保留本机版本</m3e-button>
              <m3e-button variant="filled" type="button" :disabled="Boolean(conflictBusy) || snapshotMutating" @click="requestConflictResolution(selectedConflict, 'incoming-wins')">采用传入版本</m3e-button>
            </div>
            <div v-else class="mdbx2-conflict-confirmation" role="group" aria-labelledby="mdbx2-conflict-confirm-title" aria-live="assertive">
              <span class="mdbx2-conflict-confirm-icon"><m3e-icon name="warning" /></span>
              <div>
                <strong id="mdbx2-conflict-confirm-title">确认{{ mdbx2ConflictChoiceLabel(pendingConflictResolution.choice) }}？</strong>
                <small>{{ mdbx2ConflictChoiceDescription(pendingConflictResolution.choice) }}</small>
              </div>
              <div class="mdbx2-conflict-confirm-actions">
                <m3e-button variant="text" type="button" :disabled="conflictBusy === 'resolve' || snapshotMutating" @click="cancelConflictResolution">返回比较</m3e-button>
                <m3e-button
                  ref="confirmConflictButton"
                  variant="filled"
                  type="button"
                  :aria-label="`确认${mdbx2ConflictChoiceLabel(pendingConflictResolution.choice)}`"
                  :disabled="conflictBusy === 'resolve' || snapshotMutating"
                  @click="confirmConflictResolution"
                >{{ conflictBusy === 'resolve' ? '正在保存…' : pendingConflictResolution.choice === 'local-wins' ? '确认保留' : '确认采用' }}</m3e-button>
              </div>
            </div>
          </div>
          <div v-if="conflictCursor" class="mdbx2-conflict-more"><m3e-button variant="text" type="button" :disabled="Boolean(conflictBusy) || snapshotMutating" @click="loadConflicts(false)">加载更多冲突</m3e-button></div>
        </section>

        <section v-if="isExisting && vaultOpen" class="mdbx2-history-panel field-wide" aria-labelledby="mdbx2-history-title">
          <div class="mdbx2-history-header">
            <div><strong id="mdbx2-history-title">提交历史</strong><small>只显示可读操作摘要；密码和原始 payload 不会进入此页面。</small></div>
            <m3e-button variant="tonal" type="button" :disabled="Boolean(historyBusy) || managerMutationLocked" @click="loadHistory(true)"><m3e-icon slot="icon" name="history"></m3e-icon>{{ historyLoaded ? '刷新' : '加载历史' }}</m3e-button>
          </div>
          <p v-if="historyError" class="form-error mdbx2-history-error" role="alert">{{ historyError }}</p>
          <div v-if="historyBusy === 'list' && !historyItems.length" class="mdbx2-history-empty" role="status"><m3e-icon name="progress_activity" /><span>正在读取提交历史…</span></div>
          <div v-else-if="historyLoaded && !historyItems.length" class="mdbx2-history-empty"><m3e-icon name="history_toggle_off" /><span>暂无可显示的提交记录。</span></div>
          <div v-if="historyItems.length" class="mdbx2-history-list" aria-label="MDBX2 提交历史">
            <button
              v-for="item in historyItems"
              :key="item.commitId"
              type="button"
              class="mdbx2-history-row"
              :class="{ selected: selectedCommitId === item.commitId }"
              :aria-expanded="selectedCommitId === item.commitId"
              :disabled="Boolean(historyBusy) || managerMutationLocked"
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
            <div v-if="historyBusy === 'diff'" class="mdbx2-history-empty"><m3e-icon name="progress_activity" /><span>正在读取变更详情…</span></div>
            <div v-else-if="commitDiffItems.length" class="mdbx2-diff-list">
              <div v-for="diff in commitDiffItems" :key="`${diff.objectType}:${diff.objectId}`" class="mdbx2-diff-row">
                <span class="mdbx2-history-icon"><m3e-icon :name="presentMdbx2Diff(diff).icon" /></span>
                <span><strong>{{ presentMdbx2Diff(diff).title }} · {{ presentMdbx2Diff(diff).displayTitle }}</strong><small>{{ presentMdbx2Diff(diff).supportingText }}</small></span>
              </div>
            </div>
            <p v-else-if="!historyBusy && presentMdbx2History(selectedHistoryItem).canInspect" class="mdbx2-history-empty">此提交没有可展开的普通条目差异。</p>
            <p v-else-if="!presentMdbx2History(selectedHistoryItem).canInspect" class="mdbx2-history-empty">这是数据库级系统记录，不包含普通条目差异。</p>
          </div>
          <div v-if="historyCursor" class="mdbx2-history-more"><m3e-button variant="text" type="button" :disabled="Boolean(historyBusy) || managerMutationLocked" @click="loadHistory(false)">加载更早记录</m3e-button></div>
        </section>

        <div class="provider-boundaries field-wide" aria-label="MDBX2 浏览器能力边界">
          <div class="boundary-row"><m3e-icon name="database" /><span>单个 .mdbx 用于首次加入和完整备份；多设备日常修改通过 Commit DAG、state delta、Tombstone 和 Blob 增量交换。</span></div>
          <div class="boundary-row"><m3e-icon name="encrypted" /><span>Native Host 负责解锁、迁移、健康检查和核心写入；管理页只接收状态摘要与受限句柄。</span></div>
        </div>

        <div v-if="busy" class="mdbx2-progress field-wide" role="status" aria-live="polite"><progress v-if="busy === 'upload'" :value="uploadProgress" max="100" /><span>{{ busyLabel }}</span></div>
        <p v-if="error" class="form-error field-wide" role="alert">{{ error }}</p>

        <footer class="provider-actions field-wide">
          <m3e-button variant="text" type="button" :disabled="dialogLocked" @click="closeDialog">取消</m3e-button>
          <template v-if="isExisting">
            <m3e-button v-if="!vaultOpen" variant="tonal" type="button" :disabled="dialogLocked || !hostReady" @click="unlockExisting">解锁本机副本</m3e-button>
            <m3e-button variant="tonal" type="button" :disabled="dialogLocked || !remoteFieldsComplete" @click="saveSettings">保存设置</m3e-button>
            <m3e-button v-if="canPublish" variant="filled" type="button" :disabled="dialogLocked || !hostReady" @click="publishBootstrap">保存并发布本机保险库</m3e-button>
          </template>
          <m3e-button v-else variant="filled" type="submit" :disabled="dialogLocked || !hostReady">{{ form.mode === 'remote' ? '下载并加入' : '验证、解锁并导入' }}</m3e-button>
        </footer>
      </form>
    </section>
  </div>
</template>

<style scoped>
.mdbx2-form { gap: 16px; }
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
.mdbx2-mode-picker > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
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
.mdbx2-history-empty { min-height: 56px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 16px; color: var(--app-muted); text-align: center; }
.mdbx2-history-empty m3e-icon { --m3e-icon-size: 20px; }
.mdbx2-history-more { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; justify-content: center; padding: 4px 12px; }
.mdbx2-history-error { margin: 0 16px 12px; }
code { overflow-wrap: anywhere; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
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
  .mdbx2-snapshot-header { align-items: stretch; flex-direction: column; }
  .mdbx2-snapshot-create { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
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
}
</style>
