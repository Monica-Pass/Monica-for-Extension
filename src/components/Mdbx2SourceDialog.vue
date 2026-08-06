<script setup lang="ts">
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
const managerMutationLocked = computed(() => conflictBusy.value === "resolve" || snapshotMutating.value || historyMutating.value || collectionBusy.value === "mutate");
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
    vaultDiagnostics.value = opened.session;
    diagnosticsError.value = "";
    emit("changed");
    clearSecrets();
    await Promise.all([loadVaultTiga(), loadCollections("active", true), loadCollections("deleted", true), loadSnapshots(true), loadHistory(true), loadConflicts(true)]);
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
    create: "新建文件夹",
    rename: "重命名文件夹",
    move: `移动“${pending.title}”`,
    delete: `删除“${pending.title}”？`,
    restore: `恢复“${pending.title}”`
  } as const)[pending.kind];
}

function collectionMutationDescription(pending: PendingCollectionMutation): string {
  if (pending.uncertain) return "Native Host 响应中断，原操作标识已保留。安全重试会确认原结果，不会产生第二次文件夹操作。";
  if (pending.kind === "delete") return "文件夹会进入回收站，并生成新的同步提交。MDBX2 只允许删除空文件夹；其中仍有条目或子文件夹时，Core 会拒绝操作。";
  if (pending.kind === "restore") return "恢复后可以选择顶层或当前活动文件夹作为父级，并生成新的同步提交。";
  if (pending.kind === "move") return "选择新的父级；当前文件夹及其下级已从候选中排除。";
  return "文件夹名称和层级会写入 MDBX2，并通过增量同步发送到其他设备。";
}

function collectionMutationButtonLabel(pending: PendingCollectionMutation): string {
  if (collectionBusy.value === "mutate") return "正在保存…";
  if (pending.uncertain) return "安全重试";
  return ({ create: "创建", rename: "保存名称", move: "确认移动", delete: "确认删除", restore: "确认恢复" } as const)[pending.kind];
}

function collectionMutationNotice(kind: CollectionMutationKind, replayed: boolean): string {
  const action = ({ create: "文件夹已创建", rename: "文件夹名称已更新", move: "文件夹层级已更新", delete: "文件夹已移至回收站", restore: "文件夹已恢复" } as const)[kind];
  return replayed ? `${action}，原操作结果已确认。` : `${action}。`;
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
      emit("notice", "提交恢复结果已从历史记录中确认。");
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
    emit("notice", `历史版本已恢复，共处理 ${result.revertedObjectCount} 个条目；原提交记录仍然保留。`);
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
    emit("notice", `${mdbx2ConflictChoiceLabel(pending.choice)}；此决定将在下次增量同步时发布。`);
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
      emit("notice", "当前没有已到保留期限的自动快照；手动快照和未到期自动快照均未更改。");
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
      throw new Error("Native Host 返回的自动快照清理数量与确认计划不一致。");
    }
    pendingSnapshotPrune.value = undefined;
    completed = true;
    emit(
      "notice",
      `已清理 ${result.deletedSnapshotCount} 个到期自动快照。手动快照和未到期自动快照保持不变。${pending.plan.hasMore ? " 仍有更多到期项，可再次检查。" : ""}`
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
      emit("notice", "自动快照候选已经变化，当前没有可清理项。请刷新快照后再检查。");
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
    loadVaultDiagnostics(),
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

function diagnosticsErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "vault-diagnostics-result-too-large") return "诊断摘要超过 Native Messaging 安全上限，保险库内容没有被修改。";
  if (code === "vault-diagnostics-failed" || code === "vault-health-check-failed") return "Native Host 无法完成只读健康检查。请保留本机副本并重试；此操作不会尝试修复数据。";
  if (code === "vault-locked") return "保险库已经锁定，请重新解锁后刷新诊断。";
  if (code === "native-host-incompatible") return "Native Host 返回了不兼容的诊断摘要。请更新 Host 后再试。";
  if (code === "native-host-disconnected") return "Native Host 在健康检查期间断开。上次诊断结果仍可查看，可以安全重试。";
  return errorMessage(cause);
}

function tigaErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "vault-tiga-result-too-large") return "Tiga 安全态势超过 Native Messaging 安全上限，保险库内容没有被修改。";
  if (code === "vault-tiga-failed" || code === "vault-tiga-inconsistent") return "Native Host 无法生成一致的只读 Tiga 安全态势。请更新 Host 或重新解锁后重试。";
  if (code === "vault-locked") return "保险库已经锁定，请重新解锁后刷新 Tiga 安全态势。";
  if (code === "native-host-incompatible") return "Native Host 返回了不兼容的 Tiga 安全态势。请更新 Host 后再试。";
  if (code === "native-host-disconnected") return "Native Host 在读取安全态势期间断开。上次有效结果仍可查看，可以安全重试。";
  return errorMessage(cause);
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
  if (code === "snapshot-prune-plan-stale") return "自动快照集合或保留状态已经变化，旧计划已安全失效。请重新检查可清理项。";
  if (code === "snapshot-prune-plan-empty") return "此清理计划已没有符合条件的自动快照，请刷新后重新检查。";
  if (code === "snapshot-prune-authorization-required") return "MDBX2 安全策略要求重新解锁保险库后再清理自动快照。";
  if (code === "snapshot-prune-inspection-failed") return "Native Host 无法安全验证自动快照保留状态；没有执行删除。";
  if (code === "native-host-disconnected") return "Native Host 在清理期间断开。原计划令牌已经保留，请使用同一确认按钮安全重试。";
  return errorMessage(cause);
}

function collectionErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "collection-result-too-large") return "文件夹列表超过单次安全响应上限，请减少每页数量后重试。";
  if (code === "collection-title-invalid" || code === "params-invalid") return "文件夹名称不能为空，且最多为 4096 个 UTF-8 字节。";
  if (code === "collection-root-protected" || code === "collection-parent-invalid") return "MDBX2 根目录受保护；顶层文件夹应选择“顶层”，文件夹也不能成为自己的父级。";
  if (code === "collection-state-conflict") return "当前文件夹状态不允许此操作。请确认名称未重复、父级有效，并在删除前移走条目和子文件夹。";
  if (code === "collection-operation-mismatch") return "此操作标识已用于另一项文件夹修改，已生成新的操作标识；核对当前状态后可以重试。";
  if (code === "collection-authorization-required") return "MDBX2 安全策略要求重新解锁保险库后再修改文件夹。";
  if (code === "native-host-disconnected") return "Native Host 在文件夹写入期间断开。原操作标识已保留，请使用同一按钮安全重试。";
  return errorMessage(cause);
}

function historyErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "history-diff-too-large") return "这次提交包含的对象过多，当前版本无法一次展开全部详情；提交记录本身仍然有效。";
  if (code === "history-result-too-large") return "历史记录内容超过单次安全上限，请缩小分页后重试。";
  if (code === "history-revert-not-allowed") return "这次提交包含数据库级事件、非条目对象或超过 500 个项目，无法从浏览器管理页恢复。";
  if (code === "history-revert-not-found") return "这次提交已不存在，请刷新历史记录。";
  if (code === "history-revert-too-large") return "这次提交超过 500 个可恢复对象，Core 已停止恢复操作。";
  if (code === "history-revert-operation-mismatch") return "恢复操作标识已用于另一项历史操作，请刷新记录后重新选择。";
  if (code === "history-revert-authorization-required") return "MDBX2 安全策略要求重新解锁保险库后再恢复历史版本。";
  if (code === "native-host-disconnected") return "Native Host 连接在恢复期间中断。原操作标识已经保留，可以使用同一确认按钮安全重试，或刷新历史确认结果。";
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

        <section
          v-if="isExisting && vaultOpen"
          class="mdbx2-diagnostics-panel field-wide"
          :aria-busy="diagnosticsBusy"
          aria-labelledby="mdbx2-diagnostics-title"
        >
          <div class="mdbx2-diagnostics-header">
            <div>
              <strong id="mdbx2-diagnostics-title">保险库诊断</strong>
              <small>只显示健康类别和聚合数量；本机路径、Vault／Device ID、原始描述与对象标识不会进入管理页。</small>
            </div>
            <m3e-button
              variant="tonal"
              type="button"
              aria-label="刷新保险库诊断"
              :disabled="diagnosticsBusy || managerMutationLocked"
              @click="loadVaultDiagnostics"
            ><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ diagnosticsBusy ? '正在检查…' : '刷新诊断' }}</m3e-button>
          </div>

          <p v-if="diagnosticsError" class="form-error mdbx2-diagnostics-error" role="alert">{{ diagnosticsError }}</p>
          <div v-if="diagnosticsBusy && !vaultDiagnostics" class="mdbx2-diagnostics-empty" role="status" aria-live="polite">
            <m3e-icon name="progress_activity" />
            <span>正在执行只读健康检查…</span>
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

            <div v-if="diagnosticGuidance.length" class="mdbx2-health-guidance-list" aria-labelledby="mdbx2-health-guidance-title">
              <div class="mdbx2-health-guidance-heading">
                <strong id="mdbx2-health-guidance-title">建议处理</strong>
                <small>按影响优先显示恢复步骤；只使用 Native Host 返回的脱敏原因码，不显示底层描述或标识。</small>
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
                  <span class="mdbx2-health-guidance-severity">{{ mdbx2HealthSeverityLabel(guidance.severity) }} · {{ formatMdbx2DiagnosticCount(guidance.count) }} 项</span>
                  <m3e-icon class="mdbx2-health-guidance-chevron" name="expand_more" />
                </summary>
                <div class="mdbx2-health-guidance-body">
                  <div>
                    <strong>可能影响</strong>
                    <p>{{ guidance.impact }}</p>
                  </div>
                  <div>
                    <strong>建议步骤</strong>
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

            <dl class="mdbx2-diagnostics-key-facts" aria-label="MDBX2 诊断概览">
              <div><dt>主文件</dt><dd>{{ formatMdbx2SnapshotBytes(vaultDiagnostics.fileSizeBytes) }}</dd></div>
              <div><dt>未解决冲突</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.unresolvedConflictCount) }}</dd></div>
              <div><dt>文件夹</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.folderCount) }}</dd></div>
              <div><dt>有效条目</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.entryCount) }}</dd></div>
            </dl>

            <div v-if="vaultDiagnostics.health.categories.length" class="mdbx2-diagnostics-category-list" role="list" aria-label="MDBX2 健康类别">
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
                  <small>最高级别：{{ mdbx2HealthSeverityLabel(category.highestSeverity) }}</small>
                </span>
                <span class="mdbx2-diagnostics-category-count">{{ formatMdbx2DiagnosticCount(category.count) }} 项</span>
              </div>
            </div>

            <details ref="diagnosticsDetails" class="mdbx2-diagnostics-details">
              <summary>
                <m3e-icon name="monitoring" />
                <span><strong>查看聚合统计</strong><small>展开数据库、同步历史与附件规模；不会读取条目标题或内容。</small></span>
                <m3e-icon class="mdbx2-diagnostics-details-chevron" name="expand_more" />
              </summary>
              <div class="mdbx2-diagnostics-stat-groups">
                <section aria-labelledby="mdbx2-diagnostics-data-title">
                  <h3 id="mdbx2-diagnostics-data-title">数据库规模</h3>
                  <dl>
                    <div><dt>有效条目</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.entryCount) }}</dd></div>
                    <div><dt>已删除条目</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.deletedEntryCount) }}</dd></div>
                    <div><dt>文件夹（不含根目录）</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.folderCount) }}</dd></div>
                    <div><dt>目录记录（含系统根）</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.projectCount) }}</dd></div>
                    <div><dt>已删除目录</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.deletedProjectCount) }}</dd></div>
                    <div><dt>数据库快照</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.snapshotCount) }}</dd></div>
                  </dl>
                </section>
                <section aria-labelledby="mdbx2-diagnostics-sync-title">
                  <h3 id="mdbx2-diagnostics-sync-title">同步历史</h3>
                  <dl>
                    <div><dt>提交</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.commitCount) }}</dd></div>
                    <div><dt>分支</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.branchCount) }}</dd></div>
                    <div><dt>设备</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.deviceCount) }}</dd></div>
                    <div><dt>删除标记</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.tombstoneCount) }}</dd></div>
                    <div><dt>未解决冲突</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.unresolvedConflictCount) }}</dd></div>
                  </dl>
                </section>
                <section ref="diagnosticsAttachmentTarget" class="mdbx2-guidance-target" tabindex="-1" aria-labelledby="mdbx2-diagnostics-attachment-title">
                  <h3 id="mdbx2-diagnostics-attachment-title">附件</h3>
                  <dl>
                    <div><dt>有效附件</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.attachmentCount) }}</dd></div>
                    <div><dt>已删除附件</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.deletedAttachmentCount) }}</dd></div>
                    <div><dt>外置加密附件</dt><dd>{{ formatMdbx2DiagnosticCount(vaultDiagnostics.diagnostics.externalAttachmentCount) }}</dd></div>
                    <div><dt>原始体积</dt><dd>{{ formatMdbx2SnapshotBytes(vaultDiagnostics.diagnostics.originalAttachmentBytes) }}</dd></div>
                    <div><dt>加密存储体积</dt><dd>{{ formatMdbx2SnapshotBytes(vaultDiagnostics.diagnostics.storedAttachmentBytes) }}</dd></div>
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
              <strong id="mdbx2-tiga-title">Tiga 安全态势</strong>
              <small>只读显示 Sky／Multi／Power、解锁合规与浏览器能力差异；不提供策略修改、例外编辑或审计操作。</small>
            </div>
            <m3e-button
              variant="tonal"
              type="button"
              aria-label="刷新 Tiga 安全态势"
              :disabled="tigaBusy || managerMutationLocked"
              @click="loadVaultTiga"
            ><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ tigaBusy ? '正在检查…' : '刷新态势' }}</m3e-button>
          </div>

          <p v-if="tigaError" class="form-error mdbx2-tiga-error" role="alert">{{ tigaError }}</p>
          <div v-if="tigaBusy && !vaultTiga" class="mdbx2-tiga-empty" role="status" aria-live="polite">
            <m3e-icon name="progress_activity" />
            <span>正在读取只读 Tiga 策略与解锁态势…</span>
          </div>

          <template v-if="vaultTiga && tigaPresentation">
            <div class="mdbx2-tiga-overview" :data-tone="tigaPresentation.tone" aria-live="polite">
              <span class="mdbx2-tiga-overview-icon"><m3e-icon :name="tigaPresentation.icon" /></span>
              <div class="mdbx2-tiga-overview-copy">
                <strong>{{ tigaPresentation.headline }}</strong>
                <small>{{ tigaPresentation.supporting }}</small>
                <small class="mdbx2-tiga-overview-meta">
                  <time :datetime="new Date(vaultTiga.checkedAtUnixSeconds * 1000).toISOString()">{{ formatMdbx2DiagnosticTime(vaultTiga.checkedAtUnixSeconds) }}</time>
                  · 策略版本 {{ vaultTiga.policy.policyVersion }}
                </small>
              </div>
              <span class="mdbx2-tiga-profile-badge">{{ mdbx2TigaProfileLabel(vaultTiga.profile) }}</span>
            </div>

            <dl class="mdbx2-tiga-key-facts" aria-label="MDBX2 Tiga 安全态势概览">
              <div><dt>策略状态</dt><dd>{{ mdbx2TigaComplianceLabel(vaultTiga.compliance) }}</dd></div>
              <div><dt>解锁配置</dt><dd>{{ vaultTiga.unlock.satisfiesPolicy ? '满足当前模式' : '需要调整' }}</dd></div>
              <div><dt>已配置方式</dt><dd>{{ vaultTiga.unlock.configuredMethods.map(mdbx2TigaUnlockMethodLabel).join('、') || '未配置' }}</dd></div>
              <div><dt>浏览器限制</dt><dd>{{ vaultTiga.browser.limitations.length ? `${vaultTiga.browser.limitations.length} 项` : '无额外限制' }}</dd></div>
            </dl>

            <div v-if="vaultTiga.browser.limitations.length" class="mdbx2-tiga-limitations" role="list" aria-label="浏览器环境限制">
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
                <span><strong>查看只读策略详情</strong><small>展开解锁、会话、敏感操作、恢复和审计要求；不会显示原始警告或技术标识。</small></span>
                <m3e-icon class="mdbx2-tiga-details-chevron" name="expand_more" />
              </summary>
              <div class="mdbx2-tiga-policy-groups">
                <section aria-labelledby="mdbx2-tiga-unlock-title">
                  <h3 id="mdbx2-tiga-unlock-title">解锁与会话</h3>
                  <dl>
                    <div><dt>最低认证因子</dt><dd>{{ vaultTiga.policy.minimumAuthFactors }}</dd></div>
                    <div><dt>安全密钥</dt><dd>{{ vaultTiga.policy.securityKeyRequired ? '必须' : vaultTiga.policy.securityKeyRecommended ? '建议' : '不要求' }}</dd></div>
                    <div><dt>可移植解锁</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.portableUnlockAllowed, '允许', '不允许') }}</dd></div>
                    <div><dt>空闲锁定</dt><dd>{{ formatMdbx2TigaDuration(vaultTiga.policy.idleTimeoutSeconds) }}</dd></div>
                    <div><dt>最长会话</dt><dd>{{ formatMdbx2TigaDuration(vaultTiga.policy.maxLifetimeSeconds) }}</dd></div>
                    <div><dt>进入后台</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.lockOnBackground, '立即锁定', '保持当前会话') }}</dd></div>
                    <div><dt>新鲜认证窗口</dt><dd>{{ formatMdbx2TigaDuration(vaultTiga.policy.freshAuthWindowSeconds) }}</dd></div>
                    <div><dt>解锁警告</dt><dd>{{ formatMdbx2DiagnosticCount(vaultTiga.unlock.warningCount) }} 项</dd></div>
                  </dl>
                </section>
                <section aria-labelledby="mdbx2-tiga-disclosure-title">
                  <h3 id="mdbx2-tiga-disclosure-title">敏感操作</h3>
                  <dl>
                    <div><dt>查看敏感值</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.revealRequiresFreshAuth, '需要重新认证', '沿用当前会话') }}</dd></div>
                    <div><dt>复制敏感值</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.copyRequiresFreshAuth, '需要重新认证', '沿用当前会话') }}</dd></div>
                    <div><dt>剪贴板</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.clipboardAllowed, `允许，${formatMdbx2TigaDuration(vaultTiga.policy.clipboardTtlSeconds)} 清除`, '不允许') }}</dd></div>
                    <div><dt>安全剪贴板</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.secureClipboardRequired, '必须', '不要求') }}</dd></div>
                    <div><dt>截屏防护</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.screenCaptureProtectionRequired, '必须', '不要求') }}</dd></div>
                    <div><dt>设备保障</dt><dd>{{ mdbx2TigaDeviceAssuranceLabel(vaultTiga.policy.minimumDeviceAssurance) }}</dd></div>
                    <div><dt>策略警告</dt><dd>{{ formatMdbx2DiagnosticCount(vaultTiga.warningCount) }} 项</dd></div>
                  </dl>
                </section>
                <section aria-labelledby="mdbx2-tiga-egress-title">
                  <h3 id="mdbx2-tiga-egress-title">导出、数据与恢复</h3>
                  <dl>
                    <div><dt>导出</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.exportAllowed, '允许', '不允许') }}</dd></div>
                    <div><dt>打印</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.printAllowed, '允许', '不允许') }}</dd></div>
                    <div><dt>导出认证因子</dt><dd>{{ vaultTiga.policy.egressMinimumAuthFactors }}</dd></div>
                    <div><dt>持久明文缓存</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.persistentPlaintextCacheAllowed, '允许', '不允许') }}</dd></div>
                    <div><dt>附件临时文件</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.attachmentTemporaryFilesAllowed, '允许', '不允许') }}</dd></div>
                    <div><dt>锁定时密文同步</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.lockedCiphertextSyncAllowed, '允许', '不允许') }}</dd></div>
                    <div><dt>最低恢复方式</dt><dd>{{ vaultTiga.policy.minimumRecoveryMethods }}</dd></div>
                    <div><dt>可移植恢复</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.portableRecoveryRequired, '必须', '不要求') }}</dd></div>
                    <div><dt>管理认证因子</dt><dd>{{ vaultTiga.policy.administrationMinimumAuthFactors }}</dd></div>
                    <div><dt>审计范围</dt><dd>{{ mdbx2TigaAuditLevelLabel(vaultTiga.policy.auditLevel) }}</dd></div>
                    <div><dt>删除审计</dt><dd>{{ mdbx2TigaBooleanLabel(vaultTiga.policy.auditDeletionAllowed, '策略允许', '策略禁止') }}</dd></div>
                  </dl>
                </section>
                <p class="mdbx2-tiga-readonly-note"><m3e-icon name="info" /><span>此页面只解释当前策略。修改模式、例外、恢复策略、密钥轮换或审计记录必须在支持这些管理能力的客户端完成。</span></p>
              </div>
            </details>
          </template>
        </section>

        <section ref="collectionPanel" v-if="isExisting && vaultOpen" class="mdbx2-collection-panel mdbx2-guidance-target field-wide" tabindex="-1" aria-labelledby="mdbx2-collection-title">
          <div class="mdbx2-collection-header">
            <div>
              <strong id="mdbx2-collection-title">文件夹</strong>
              <small>与 Monica Android 共用 MDBX2 Collection 层级；根目录和技术标识保持隐藏。</small>
            </div>
            <div class="mdbx2-collection-header-actions">
              <m3e-button variant="text" type="button" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation)" @click="loadCollections(collectionView, true)"><m3e-icon slot="icon" name="refresh"></m3e-icon>刷新</m3e-button>
              <m3e-button v-if="collectionView === 'active'" variant="tonal" type="button" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('create')"><m3e-icon slot="icon" name="create_new_folder"></m3e-icon>新建文件夹</m3e-button>
            </div>
          </div>

          <div class="mdbx2-collection-tabs" role="group" aria-label="文件夹状态">
            <button type="button" :aria-pressed="collectionView === 'active'" :class="{ active: collectionView === 'active' }" :disabled="collectionBusy === 'mutate' || Boolean(pendingCollectionMutation)" @click="changeCollectionView('active')"><m3e-icon name="folder" />当前文件夹 <span>{{ activeCollections.length }}</span></button>
            <button type="button" :aria-pressed="collectionView === 'deleted'" :class="{ active: collectionView === 'deleted' }" :disabled="collectionBusy === 'mutate' || Boolean(pendingCollectionMutation)" @click="changeCollectionView('deleted')"><m3e-icon name="delete" />回收站 <span>{{ deletedCollections.length }}</span></button>
          </div>

          <div v-if="pendingCollectionMutation" class="mdbx2-collection-editor" :class="{ danger: pendingCollectionMutation.kind === 'delete' }" role="group" aria-labelledby="mdbx2-collection-editor-title" aria-live="polite">
            <span class="mdbx2-collection-editor-icon"><m3e-icon :name="pendingCollectionMutation.kind === 'delete' ? 'warning' : pendingCollectionMutation.kind === 'restore' ? 'restore_from_trash' : 'drive_file_move'" /></span>
            <div class="mdbx2-collection-editor-copy">
              <strong id="mdbx2-collection-editor-title">{{ collectionMutationHeading(pendingCollectionMutation) }}</strong>
              <small>{{ collectionMutationDescription(pendingCollectionMutation) }}</small>
            </div>

            <label v-if="pendingCollectionMutation.kind === 'create' || pendingCollectionMutation.kind === 'rename'" class="mdbx2-collection-editor-field" for="mdbx2-collection-title-input">
              <span>文件夹名称</span>
              <input id="mdbx2-collection-title-input" v-model="pendingCollectionMutation.title" autocomplete="off" :aria-invalid="collectionTitleInvalid" aria-describedby="mdbx2-collection-title-help" :disabled="pendingCollectionMutation.uncertain || collectionBusy === 'mutate'" @keydown.enter.prevent="submitCollectionMutation" />
              <small id="mdbx2-collection-title-help" :class="{ error: collectionTitleInvalid }">{{ collectionTitleBytes }} / {{ MDBX2_MAX_COLLECTION_TITLE_BYTES }} UTF-8 字节</small>
            </label>

            <label v-if="pendingCollectionMutation.kind === 'create' || pendingCollectionMutation.kind === 'move' || pendingCollectionMutation.kind === 'restore'" class="mdbx2-collection-editor-field" for="mdbx2-collection-parent">
              <span>父级</span>
              <select id="mdbx2-collection-parent" v-model="pendingCollectionMutation.parentCollectionId" :disabled="pendingCollectionMutation.uncertain || collectionBusy === 'mutate'">
                <option :value="undefined">顶层</option>
                <option v-for="row in collectionParentOptions" :key="row.item.collectionId" :value="row.item.collectionId">{{ row.path }}</option>
              </select>
              <small>顶层文件夹使用空父级，与 Android 的 MDBX2 目录规则一致。</small>
            </label>

            <div class="mdbx2-collection-editor-actions">
              <m3e-button variant="text" type="button" :disabled="pendingCollectionMutation.uncertain || collectionBusy === 'mutate'" @click="cancelCollectionMutation">取消</m3e-button>
              <m3e-button ref="collectionConfirmButton" variant="filled" type="button" :class="{ 'mdbx2-collection-delete': pendingCollectionMutation.kind === 'delete' }" :disabled="collectionBusy === 'mutate' || collectionTitleInvalid" @click="submitCollectionMutation">{{ collectionMutationButtonLabel(pendingCollectionMutation) }}</m3e-button>
            </div>
          </div>

          <p v-if="collectionError" class="form-error mdbx2-collection-error" role="alert">{{ collectionError }}</p>
          <div v-if="collectionBusy === 'list' && !collectionRows.length" class="mdbx2-collection-empty" role="status"><m3e-icon name="progress_activity" /><span>正在读取文件夹…</span></div>
          <div v-else-if="(collectionView === 'active' ? activeCollectionsLoaded : deletedCollectionsLoaded) && !collectionRows.length" class="mdbx2-collection-empty"><m3e-icon :name="collectionView === 'active' ? 'folder_open' : 'delete_sweep'" /><span>{{ collectionView === 'active' ? '尚未创建自定义文件夹。未分类项目仍保存在受保护的根目录。' : '回收站中没有文件夹。' }}</span></div>

          <div v-if="collectionRows.length" class="mdbx2-collection-list" role="list" :aria-label="collectionView === 'active' ? '当前 MDBX2 文件夹' : 'MDBX2 文件夹回收站'">
            <article v-for="row in collectionRows" :key="row.item.collectionId" class="mdbx2-collection-row" role="listitem">
              <span class="mdbx2-collection-icon"><m3e-icon :name="collectionView === 'active' ? 'folder' : 'folder_delete'" /></span>
              <span class="mdbx2-collection-copy">
                <strong>{{ row.item.title }}</strong>
                <small>{{ row.depth ? row.path : '顶层' }}<template v-if="row.hierarchyState !== 'ready'"> · {{ row.parentPath }}</template></small>
              </span>
              <div v-if="collectionView === 'active'" class="mdbx2-collection-row-actions" aria-label="文件夹操作">
                <m3e-icon-button type="button" :aria-label="`重命名 ${row.item.title}`" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('rename', row.item)"><m3e-icon name="edit" /></m3e-icon-button>
                <m3e-icon-button type="button" :aria-label="`移动 ${row.item.title}`" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('move', row.item)"><m3e-icon name="drive_file_move" /></m3e-icon-button>
                <m3e-icon-button type="button" :aria-label="`删除 ${row.item.title}`" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('delete', row.item)"><m3e-icon name="delete" /></m3e-icon-button>
              </div>
              <m3e-button v-else variant="tonal" type="button" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation) || managerMutationLocked" @click="beginCollectionMutation('restore', row.item)"><m3e-icon slot="icon" name="restore_from_trash"></m3e-icon>恢复</m3e-button>
            </article>
          </div>

          <div v-if="collectionView === 'active' ? activeCollectionCursor : deletedCollectionCursor" class="mdbx2-collection-more">
            <m3e-button variant="text" type="button" :disabled="Boolean(collectionBusy) || Boolean(pendingCollectionMutation)" @click="loadCollections(collectionView, false)">加载更多文件夹</m3e-button>
          </div>
        </section>

        <section ref="snapshotPanel" v-if="isExisting && vaultOpen" class="mdbx2-snapshot-panel mdbx2-guidance-target field-wide" tabindex="-1" aria-labelledby="mdbx2-snapshot-title">
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
                :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotCreate) || Boolean(pendingSnapshotMutation) || Boolean(pendingSnapshotPrune) || snapshotRequiresRefresh || conflictBusy === 'resolve'"
                placeholder="例如：升级前"
                @keydown.enter.prevent="createSnapshot"
              />
            </label>
            <div id="mdbx2-snapshot-name-help" class="mdbx2-snapshot-create-copy">
              <small>MDBX2 手动快照始终保存完整且经过认证的保险库状态；留空时由 Core 生成名称。</small>
              <small :class="{ error: snapshotNameTooLong }">{{ snapshotNameBytes }} / {{ MDBX2_MAX_SNAPSHOT_NAME_BYTES }} UTF-8 字节</small>
            </div>
            <m3e-button variant="filled" type="button" :disabled="Boolean(snapshotBusy) || snapshotNameTooLong || Boolean(pendingSnapshotMutation) || Boolean(pendingSnapshotPrune) || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="createSnapshot"><m3e-icon slot="icon" name="add"></m3e-icon>{{ snapshotBusy === 'create' ? '正在创建…' : pendingSnapshotCreate ? '重试创建' : '创建完整快照' }}</m3e-button>
          </div>

          <div v-if="!pendingSnapshotPrune" class="mdbx2-snapshot-retention">
            <span class="mdbx2-snapshot-retention-icon"><m3e-icon name="history" /></span>
            <div class="mdbx2-snapshot-retention-copy">
              <strong>自动快照保留</strong>
              <small>先由 Core 检查已到保留期限的候选；手动快照和未到期自动快照不会进入清理计划。</small>
            </div>
            <m3e-button class="mdbx2-snapshot-prune-action" variant="tonal" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotCreate) || Boolean(pendingSnapshotMutation) || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="requestAutomaticSnapshotPrune"><m3e-icon slot="icon" name="delete_sweep"></m3e-icon>{{ snapshotBusy === 'prune-plan' ? '正在检查…' : '检查可清理项' }}</m3e-button>
          </div>

          <div v-else class="mdbx2-snapshot-prune-confirmation" role="group" aria-labelledby="mdbx2-snapshot-prune-title" aria-live="assertive">
            <span class="mdbx2-snapshot-prune-icon"><m3e-icon name="warning" /></span>
            <div class="mdbx2-snapshot-prune-copy">
              <strong id="mdbx2-snapshot-prune-title">清理 {{ pendingSnapshotPrune.plan.candidateCount }} 个到期自动快照？</strong>
              <small>本次计划约 {{ formatMdbx2SnapshotBytes(pendingSnapshotPrune.plan.totalCiphertextBytes) }}。手动快照和未到期自动快照保持不变；成功后会生成新的同步提交。</small>
              <small v-if="pendingSnapshotPrune.plan.hasMore">Core 已达到单次 200 项安全上限；完成本次后可以再次检查剩余到期项。</small>
              <small v-if="pendingSnapshotPrune.uncertain">Host 响应中断，计划令牌仍保留。安全重试会返回原清理结果，不会重复删除。</small>
              <small v-else-if="pendingSnapshotPrune.stale">旧计划没有执行删除。请重新检查当前候选后再确认。</small>
            </div>
            <div class="mdbx2-snapshot-prune-actions">
              <m3e-button variant="text" type="button" :disabled="pendingSnapshotPrune.uncertain || Boolean(snapshotBusy)" @click="cancelAutomaticSnapshotPrune">取消</m3e-button>
              <m3e-button ref="confirmSnapshotPruneButton" variant="filled" type="button" aria-label="确认清理到期自动快照" :disabled="Boolean(snapshotBusy) || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="confirmAutomaticSnapshotPrune">{{ snapshotBusy === 'prune' ? '正在清理…' : pendingSnapshotPrune.stale ? '重新检查' : pendingSnapshotPrune.uncertain ? '安全重试' : '确认清理' }}</m3e-button>
            </div>
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

            <div class="mdbx2-snapshot-facts" aria-label="快照属性">
              <span><m3e-icon name="person" />{{ presentMdbx2Snapshot(selectedSnapshot).kindLabel }}</span>
              <span><m3e-icon name="database" />{{ presentMdbx2Snapshot(selectedSnapshot).completenessLabel }}</span>
              <span><m3e-icon name="data_usage" />{{ presentMdbx2Snapshot(selectedSnapshot).sizeLabel }}</span>
              <span :class="{ error: !selectedSnapshot.integrityOk }"><m3e-icon :name="selectedSnapshot.integrityOk ? 'verified_user' : 'gpp_bad'" />{{ presentMdbx2Snapshot(selectedSnapshot).integrityLabel }}</span>
            </div>

            <div v-if="selectedSnapshot.integrityOk" class="mdbx2-snapshot-structure">
              <div class="mdbx2-snapshot-structure-toolbar">
                <div role="group" aria-label="快照结构查看方式">
                  <button type="button" :aria-pressed="snapshotStructureMode === 'snapshot'" :class="{ active: snapshotStructureMode === 'snapshot' }" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="changeSnapshotStructureMode('snapshot')">仅快照</button>
                  <button type="button" :aria-pressed="snapshotStructureMode === 'compare'" :class="{ active: snapshotStructureMode === 'compare' }" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="changeSnapshotStructureMode('compare')">与现版本比较</button>
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
                  <m3e-button v-if="currentSnapshotStructure.cursor" variant="text" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="loadSnapshotStructure('current', false)">加载更多当前项目</m3e-button>
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
                  <m3e-button v-if="savedSnapshotStructure.cursor" variant="text" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="loadSnapshotStructure('snapshot', false)">加载更多快照项目</m3e-button>
                </section>
              </div>
            </div>

            <div v-else class="mdbx2-snapshot-integrity-warning" role="alert">
              <m3e-icon name="gpp_bad" />
              <span><strong>完整性校验失败</strong><small>Native Host 已停止解密结构和恢复操作。此记录仍可保留用于诊断，也可以在确认后永久删除。</small></span>
            </div>

            <div v-if="!pendingSnapshotMutation" class="mdbx2-snapshot-actions">
              <m3e-button class="mdbx2-snapshot-delete" variant="tonal" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || snapshotRequiresRefresh || conflictBusy === 'resolve'" @click="requestSnapshotMutation(selectedSnapshot, 'delete')"><m3e-icon slot="icon" name="delete_forever"></m3e-icon>删除快照</m3e-button>
              <m3e-button class="mdbx2-snapshot-restore" variant="filled" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || snapshotRequiresRefresh || conflictBusy === 'resolve' || !presentMdbx2Snapshot(selectedSnapshot).canRestore" @click="requestSnapshotMutation(selectedSnapshot, 'restore')"><m3e-icon slot="icon" name="restore"></m3e-icon>恢复此快照</m3e-button>
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

          <div v-if="snapshotCursor" class="mdbx2-snapshot-more"><m3e-button variant="text" type="button" :disabled="Boolean(snapshotBusy) || Boolean(pendingSnapshotPrune) || conflictBusy === 'resolve'" @click="loadSnapshots(false)">加载更多快照</m3e-button></div>
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

        <section ref="historyPanel" v-if="isExisting && vaultOpen" class="mdbx2-history-panel mdbx2-guidance-target field-wide" tabindex="-1" aria-labelledby="mdbx2-history-title">
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
            <div v-if="historyBusy === 'diff'" class="mdbx2-history-empty"><m3e-icon name="progress_activity" /><span>正在读取变更详情…</span></div>
            <div v-else-if="commitDiffItems.length" class="mdbx2-diff-list">
              <div v-for="diff in commitDiffItems" :key="`${diff.objectType}:${diff.objectId}`" class="mdbx2-diff-row">
                <span class="mdbx2-history-icon"><m3e-icon :name="presentMdbx2Diff(diff).icon" /></span>
                <span><strong>{{ presentMdbx2Diff(diff).title }} · {{ presentMdbx2Diff(diff).displayTitle }}</strong><small>{{ presentMdbx2Diff(diff).supportingText }}</small></span>
              </div>
            </div>
            <p v-else-if="!historyBusy && presentMdbx2History(selectedHistoryItem).canInspect" class="mdbx2-history-empty">此提交没有可展开的普通条目差异。</p>
            <p v-else-if="!presentMdbx2History(selectedHistoryItem).canInspect" class="mdbx2-history-empty">这是数据库级系统记录，不包含普通条目差异。</p>
            <div v-if="presentMdbx2History(selectedHistoryItem).canRevert && !pendingHistoryRevert" class="mdbx2-history-actions">
              <span>恢复操作会新增一条历史记录，原提交和后续同步依据保持可审计。</span>
              <m3e-button variant="filled" type="button" :disabled="Boolean(historyBusy) || managerMutationLocked" @click="requestHistoryRevert(selectedHistoryItem)"><m3e-icon slot="icon" name="undo"></m3e-icon>撤销这次更改</m3e-button>
            </div>
          </div>
          <div v-if="pendingHistoryRevert" class="mdbx2-history-confirmation" role="group" aria-labelledby="mdbx2-history-revert-title" aria-live="assertive">
            <span class="mdbx2-history-confirm-icon"><m3e-icon name="warning" /></span>
            <div>
              <strong id="mdbx2-history-revert-title">撤销这次更改？</strong>
              <small>将恢复或移除这次提交涉及的 {{ presentMdbx2History(pendingHistoryRevert.item).objectCount }} 个条目。此操作会生成新的恢复记录，原有历史保持不变。</small>
              <small v-if="pendingHistoryRevert.attempted">原操作标识已经保留。可以使用同一确认按钮重试，或刷新提交历史确认结果。</small>
            </div>
            <div class="mdbx2-history-confirm-actions">
              <m3e-button variant="text" type="button" :disabled="pendingHistoryRevert.attempted || Boolean(historyBusy)" @click="cancelHistoryRevert">返回详情</m3e-button>
              <m3e-button ref="confirmHistoryRevertButton" variant="filled" type="button" aria-label="确认撤销这次更改" :disabled="Boolean(historyBusy) || conflictBusy === 'resolve' || snapshotMutating" @click="confirmHistoryRevert">{{ historyBusy === 'revert' ? '正在恢复…' : pendingHistoryRevert.attempted ? '重试恢复' : '确认撤销' }}</m3e-button>
            </div>
          </div>
          <div v-if="historyCursor" class="mdbx2-history-more"><m3e-button variant="text" type="button" :disabled="Boolean(historyBusy) || managerMutationLocked || Boolean(pendingHistoryRevert)" @click="loadHistory(false)">加载更早记录</m3e-button></div>
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
.mdbx2-diagnostics-header > m3e-button { min-height: 44px; flex: 0 0 auto; }
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
  .mdbx2-diagnostics-health { grid-template-columns: 44px minmax(0, 1fr); }
  .mdbx2-diagnostics-severity-summary { grid-column: 2; max-width: none; text-align: left; }
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
