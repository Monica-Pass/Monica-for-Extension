import type { ProviderAccount, VaultItem } from "../../core/model";
import { MDBX3_RUNTIME_NAME, Mdbx2NativeHostError, type Mdbx2VaultCredential, type Mdbx2VaultInspection, type Mdbx2VaultSessionSummary, type Mdbx2VaultSource } from "./native-contract";
import { handshakeUnlock, mergeMdbxImportInspection, type MdbxImportKind, type MdbxImportSniff } from "./mdbx-import-detect";

export const MDBX_IMPORT_STORAGE_KEY = "monica.mdbx-import.operations";
export type MdbxImportStage =
  | "detecting"
  | "prepared"
  | "committing"
  | "registered"
  | "syncing"
  | "completed"
  | "cancelled"
  | "failed";

export interface MdbxImportError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface MdbxImportOperation {
  operationId: string;
  stage: MdbxImportStage;
  kind: Extract<MdbxImportKind, "mdbx-vault" | "mdbx-complete-backup-zip">;
  source: Mdbx2VaultSource;
  name: string;
  vaultHandle?: string;
  vaultId?: string;
  sourceFormatVersion?: string;
  formatVersion?: string;
  schemaVersion?: number;
  requiresUpgrade?: boolean;
  objectCount?: number;
  providerId?: string;
  pluginSetupCompleted?: boolean;
  lastError?: MdbxImportError;
  createdAt: number;
  updatedAt: number;
}

export interface MdbxImportDetectResult {
  sniff: MdbxImportSniff;
  inspection?: Mdbx2VaultInspection;
}

export interface MdbxImportPrepareResult {
  operation: MdbxImportOperation;
  inspection: Mdbx2VaultInspection;
  session: Mdbx2VaultSessionSummary;
}

export interface MdbxImportCommitResult {
  operation: MdbxImportOperation;
  account?: ProviderAccount;
  session?: Mdbx2VaultSessionSummary;
  items?: VaultItem[];
  pluginSetupCompleted?: boolean;
}

export interface MdbxImportStore {
  read(): Promise<MdbxImportOperation[]>;
  write(operations: MdbxImportOperation[]): Promise<void>;
}

export interface MdbxImportNative {
  inspectVault(source: Mdbx2VaultSource): Promise<Mdbx2VaultInspection>;
  openVault(source: Mdbx2VaultSource, credential: Mdbx2VaultCredential): Promise<Mdbx2VaultSessionSummary>;
  vaultStatus(vaultHandle: string): Promise<{ open: boolean; available: boolean }>;
  listCollections(vaultHandle: string): Promise<{ items: Array<{ collectionId: string }> }>;
  listObjects(vaultHandle: string, collectionId: string, input?: { cursor?: string }): Promise<{ items: unknown[]; nextCursor?: string }>;
  discardVault(vaultHandle: string): Promise<boolean>;
  lockVault(vaultHandle: string): Promise<unknown>;
  backendForVault(vaultHandle: string): Promise<"native" | "browser">;
  releaseFile(fileHandle: string): Promise<boolean>;
}

export interface MdbxImportVault {
  status(): Promise<"uninitialized" | "locked" | "unlocked">;
  passkeySessionId(): Promise<string | undefined>;
  setup(masterPassword: string): Promise<{ items: VaultItem[] }>;
  listProviders(): Promise<ProviderAccount[]>;
  getProvider(providerId: string): Promise<ProviderAccount | undefined>;
  upsertProvider(account: ProviderAccount, activity: boolean, expected: ProviderAccount | undefined, guard: { sessionId: string }): Promise<ProviderAccount>;
}

export interface MdbxImportSync {
  (providerId: string): Promise<unknown>;
}

const commitLocks = new Map<string, Promise<unknown>>();
const inFlightCommits = new Map<string, number>();

function beginCommit(operationId: string): void {
  inFlightCommits.set(operationId, (inFlightCommits.get(operationId) || 0) + 1);
}

function endCommit(operationId: string): void {
  const remaining = (inFlightCommits.get(operationId) || 1) - 1;
  if (remaining <= 0) inFlightCommits.delete(operationId);
  else inFlightCommits.set(operationId, remaining);
}

async function withCommitLock<T>(operationId: string, work: () => Promise<T>): Promise<T> {
  const previous = commitLocks.get(operationId) || Promise.resolve();
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => held);
  commitLocks.set(operationId, chain);
  beginCommit(operationId);
  try {
    await previous.catch(() => undefined);
    return await work();
  } finally {
    endCommit(operationId);
    release();
    if (commitLocks.get(operationId) === chain) commitLocks.delete(operationId);
  }
}

function ownerAmong(providers: ProviderAccount[], vaultHandle: string): ProviderAccount | undefined {
  return providers.find((provider) => provider.kind === "mdbx2" && provider.config.vaultHandle === vaultHandle);
}

async function providersSnapshot(vault: MdbxImportVault): Promise<ProviderAccount[] | undefined> {
  try {
    return await vault.listProviders();
  } catch {
    return undefined;
  }
}

async function registeredOwner(
  vault: MdbxImportVault,
  operation: Pick<MdbxImportOperation, "providerId" | "vaultHandle">
): Promise<ProviderAccount | undefined> {
  if (operation.providerId) {
    const known = await vault.getProvider(operation.providerId).catch(() => undefined);
    if (known) return known;
  }
  if (!operation.vaultHandle) return undefined;
  const providers = await providersSnapshot(vault);
  return providers ? ownerAmong(providers, operation.vaultHandle) : undefined;
}

async function shouldDiscardWorkingCopy(vault: MdbxImportVault, operation: MdbxImportOperation): Promise<boolean> {
  if (!operation.vaultHandle || operation.providerId || (inFlightCommits.get(operation.operationId) || 0) > 1) return false;
  const providers = await providersSnapshot(vault);
  if (providers === undefined) {
    return operation.stage === "prepared" || operation.stage === "detecting" || operation.stage === "failed";
  }
  return !ownerAmong(providers, operation.vaultHandle);
}

export function chromeMdbxImportStore(): MdbxImportStore {
  return {
    async read() {
      const result = await chrome.storage.local.get(MDBX_IMPORT_STORAGE_KEY);
      const value = result[MDBX_IMPORT_STORAGE_KEY];
      return Array.isArray(value) ? value.filter(isStoredOperation) : [];
    },
    async write(operations) {
      if (!operations.length) await chrome.storage.local.remove(MDBX_IMPORT_STORAGE_KEY);
      else await chrome.storage.local.set({ [MDBX_IMPORT_STORAGE_KEY]: operations });
    }
  };
}

function sniffFromInspection(inspection: Mdbx2VaultInspection, kind?: MdbxImportOperation["kind"]): MdbxImportSniff {
  return mergeMdbxImportInspection({
    kind: kind || "mdbx-vault",
    runtimeName: MDBX3_RUNTIME_NAME,
    requiresMigration: inspection.requiresUpgrade,
    unlockMethods: inspection.unlockMethods,
    portableUnlockAvailable: inspection.portableUnlockAvailable,
    needsPasswordPrompt: false,
    needsSecurityKey: false,
    pinOnly: false
  }, inspection);
}

export async function detectMdbxImport(
  native: MdbxImportNative,
  source: Mdbx2VaultSource,
  kind?: MdbxImportOperation["kind"]
): Promise<MdbxImportDetectResult> {
  const inspection = await native.inspectVault(source);
  return { sniff: sniffFromInspection(inspection, kind), inspection };
}

export async function prepareMdbxImport(
  store: MdbxImportStore,
  native: MdbxImportNative,
  input: { operationId: string; source: Mdbx2VaultSource; credential: Mdbx2VaultCredential; name: string; kind?: MdbxImportOperation["kind"] }
): Promise<MdbxImportPrepareResult> {
  const operationId = requireOperationId(input.operationId);
  const existing = await readOperation(store, operationId);
  if (existing?.stage === "prepared" && existing.vaultHandle) {
    const status = await native.vaultStatus(existing.vaultHandle).catch(() => ({ open: false, available: false }));
    if (!status.open) {
      await failOperation(store, existing, importError("vault-locked", "MDBX 会话已关闭，请重新解锁后重试导入。", true), native);
      throw new Mdbx2NativeHostError("vault-locked", "MDBX 会话已关闭，请重新解锁后重试导入。", true);
    }
    const inspection = await native.inspectVault({ kind: "vault", handle: existing.vaultHandle });
    return {
      operation: existing,
      inspection,
      session: {
        vaultHandle: existing.vaultHandle,
        vaultId: existing.vaultId || existing.vaultHandle,
        deviceId: existing.vaultHandle,
        migrated: Boolean(existing.requiresUpgrade),
        preUpgradeBackupCreated: Boolean(existing.requiresUpgrade),
        checkedAtUnixSeconds: 0,
        fileSizeBytes: 0,
        formatVersion: "MDBX-2",
        schemaVersion: 17,
        health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
        diagnostics: {
          commitCount: 0, tombstoneCount: 0, branchCount: 0, deviceCount: 0, snapshotCount: 0, unresolvedConflictCount: 0,
          projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: existing.objectCount || 0, deletedEntryCount: 0,
          attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0
        }
      }
    };
  }
  if (existing && ["registered", "syncing", "completed"].includes(existing.stage)) {
    throw new Mdbx2NativeHostError("params-invalid", "该导入操作已经注册，不能重复准备。", false);
  }
  const inspection = await native.inspectVault(input.source);
  const sniff = sniffFromInspection(inspection, input.kind);
  assertUnlockAllowed(sniff, input.credential);
  let session: Mdbx2VaultSessionSummary | undefined;
  try {
    session = await native.openVault(input.source, input.credential);
    const collections = await native.listCollections(session.vaultHandle);
    let objectCount = 0;
    for (const collection of collections.items) {
      let cursor: string | undefined;
      do {
        const page = await native.listObjects(session.vaultHandle, collection.collectionId, cursor ? { cursor } : undefined);
        objectCount += page.items.length;
        cursor = page.nextCursor;
      } while (cursor);
    }
    const operation: MdbxImportOperation = {
      operationId,
      stage: "prepared",
      kind: sniff.kind === "mdbx-complete-backup-zip" ? "mdbx-complete-backup-zip" : "mdbx-vault",
      source: { kind: "vault", handle: session.vaultHandle },
      name: input.name.trim() || "Monica MDBX",
      vaultHandle: session.vaultHandle,
      vaultId: session.vaultId,
      sourceFormatVersion: inspection.formatVersion,
      formatVersion: session.formatVersion,
      schemaVersion: session.schemaVersion,
      requiresUpgrade: inspection.requiresUpgrade,
      objectCount,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    await upsertOperation(store, operation);
    return { operation, inspection, session };
  } catch (error) {
    if (session?.vaultHandle) await native.discardVault(session.vaultHandle).catch(() => undefined);
    const mapped = mapImportError(error);
    await upsertOperation(store, {
      operationId,
      stage: "failed",
      kind: input.kind || "mdbx-vault",
      source: input.source,
      name: input.name.trim() || "Monica MDBX",
      lastError: mapped,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now()
    });
    throw toHostError(mapped);
  }
}

export async function commitMdbxImport(
  store: MdbxImportStore,
  native: MdbxImportNative,
  vault: MdbxImportVault,
  sync: MdbxImportSync,
  input: { operationId: string; name: string; isDefaultSaveTarget?: boolean; pluginMasterPassword?: string }
): Promise<MdbxImportCommitResult> {
  const operationId = requireOperationId(input.operationId);
  return withCommitLock(operationId, async () => {
    const operation = await readOperation(store, operationId);
    if (!operation) throw new Mdbx2NativeHostError("params-invalid", "找不到这次 MDBX 导入操作。", false);
    if (operation.stage === "completed" && operation.providerId) {
      const account = await vault.getProvider(operation.providerId);
      return { operation, account, pluginSetupCompleted: operation.pluginSetupCompleted };
    }
    if (operation.stage === "registered" || operation.stage === "syncing") {
      return finishRegistered(store, vault, sync, operation);
    }
    const existingOwner = await registeredOwner(vault, operation);
    if (existingOwner && operation.vaultHandle) {
      const registered: MdbxImportOperation = {
        ...operation,
        stage: "registered",
        providerId: existingOwner.id,
        name: existingOwner.name || operation.name,
        pluginSetupCompleted: operation.pluginSetupCompleted,
        updatedAt: Date.now()
      };
      try {
        await saveOperation(store, registered);
      } catch {
        return { operation: registered, account: existingOwner, pluginSetupCompleted: registered.pluginSetupCompleted };
      }
      return finishRegistered(store, vault, sync, registered, existingOwner);
    }
    if ((operation.stage !== "prepared" && operation.stage !== "committing") || !operation.vaultHandle) {
      throw new Mdbx2NativeHostError(operation.lastError?.code || "params-invalid", operation.lastError?.message || "请先完成 MDBX 解锁校验。", Boolean(operation.lastError?.retryable));
    }
    const status = await native.vaultStatus(operation.vaultHandle).catch(() => ({ open: false, available: false }));
    if (!status.open) {
      await failOperation(store, operation, importError("vault-locked", "MDBX 会话已关闭，请重新解锁后重试导入。", true), native, vault);
      throw new Mdbx2NativeHostError("vault-locked", "MDBX 会话已关闭，请重新解锁后重试导入。", true);
    }
    if (operation.stage !== "committing") await saveOperation(store, { ...operation, stage: "committing", updatedAt: Date.now() });
    const lifecycle = await vault.status();
    let pluginSetupCompleted = Boolean(operation.pluginSetupCompleted);
    let items: VaultItem[] | undefined;
    let sessionId = await vault.passkeySessionId();
    if (lifecycle === "uninitialized") {
      const setup = await vault.setup(input.pluginMasterPassword ?? "");
      pluginSetupCompleted = true;
      items = setup.items.filter((item) => !item.deletedAt && !item.archivedAt);
      sessionId = await vault.passkeySessionId();
    } else if (!sessionId) {
      await saveOperation(store, { ...operation, stage: "prepared", pluginSetupCompleted, updatedAt: Date.now() });
      throw new Mdbx2NativeHostError("VAULT_LOCKED", "请先解锁插件密码库后再接入 MDBX。", false);
    }
    if (!sessionId) {
      await cleanupUnregistered(store, native, { ...operation, pluginSetupCompleted }, vault);
      throw new Mdbx2NativeHostError("VAULT_LOCKED", "插件密码库会话无效。", false);
    }
    const account: ProviderAccount = {
      id: crypto.randomUUID(),
      kind: "mdbx2",
      name: input.name.trim() || operation.name || "Monica MDBX",
      enabled: true,
      isDefaultSaveTarget: Boolean(input.isDefaultSaveTarget),
      config: {
        runtimeBackend: await native.backendForVault(operation.vaultHandle),
        mdbxGeneration: 2,
        formatVersion: "MDBX-2",
        vaultHandle: operation.vaultHandle,
        nativeVaultId: operation.vaultId,
        schemaVersion: operation.schemaVersion,
        hostVerifiedAt: new Date().toISOString()
      }
    };
    let saved: ProviderAccount;
    try {
      saved = await vault.upsertProvider(account, true, undefined, { sessionId });
    } catch (error) {
      const snapshot = await providersSnapshot(vault);
      const mapped = mapImportError(error);
      if (snapshot === undefined) {
        // Persistence can succeed before its caller sees a lock/storage error.
        // Keep the handle and committing stage until ownership can be checked.
        await saveOperation(store, {
          ...operation, stage: "committing", pluginSetupCompleted,
          lastError: { ...mapped, retryable: true }, updatedAt: Date.now()
        });
        throw toHostError(mapped);
      }
      const owned = ownerAmong(snapshot, operation.vaultHandle);
      if (!owned) await native.discardVault(operation.vaultHandle).catch(() => undefined);
      await saveOperation(store, {
        ...operation,
        stage: owned ? "registered" : "failed",
        providerId: owned?.id,
        pluginSetupCompleted,
        lastError: owned
          ? undefined
          : pluginSetupCompleted
            ? importError("mdbx-import-setup-orphan", "插件密码库已创建，MDBX 尚未接入。可在导入与导出中重试。", true)
            : mapped,
        vaultHandle: owned ? operation.vaultHandle : undefined,
        updatedAt: Date.now()
      });
      if (owned) return finishRegistered(store, vault, sync, { ...operation, stage: "registered", providerId: owned.id, pluginSetupCompleted }, owned, items);
      throw pluginSetupCompleted
        ? new Mdbx2NativeHostError("mdbx-import-setup-orphan", "插件密码库已创建，MDBX 尚未接入。可在导入与导出中重试。", true)
        : toHostError(mapped);
    }
    const registered: MdbxImportOperation = {
      ...operation,
      stage: "registered",
      providerId: saved.id,
      name: saved.name,
      pluginSetupCompleted,
      updatedAt: Date.now()
    };
    try {
      await saveOperation(store, registered);
    } catch {
      return { operation: registered, account: saved, items, pluginSetupCompleted };
    }
    return finishRegistered(store, vault, sync, registered, saved, items);
  });
}

export async function cancelMdbxImport(store: MdbxImportStore, native: MdbxImportNative, operationId: string, vault: MdbxImportVault): Promise<{ cancelled: true }> {
  const id = requireOperationId(operationId);
  return withCommitLock(id, async () => {
    const operation = await readOperation(store, id);
    if (!operation) return { cancelled: true };
    const owner = await registeredOwner(vault, operation);
    if (owner || !(await shouldDiscardWorkingCopy(vault, operation))) {
      return { cancelled: true };
    }
    if (operation.vaultHandle) await native.discardVault(operation.vaultHandle).catch(() => undefined);
    if (operation.source.kind === "file") await native.releaseFile(operation.source.handle).catch(() => undefined);
    await saveOperation(store, { ...operation, stage: "cancelled", vaultHandle: undefined, updatedAt: Date.now() });
    return { cancelled: true };
  });
}

const MDBX_IMPORT_STALE_MS = 15 * 60 * 1000;

export async function recoverMdbxImports(store: MdbxImportStore, native: MdbxImportNative, vault: MdbxImportVault): Promise<MdbxImportOperation[]> {
  const snapshot = await store.read();
  const recovered: MdbxImportOperation[] = [];
  for (const operation of snapshot) {
    recovered.push(await withCommitLock(operation.operationId, async () => recoverOneImport(store, native, vault, operation)));
  }
  const latest = await store.read();
  const byId = new Map(latest.map((row) => [row.operationId, row]));
  for (const row of recovered) {
    const current = byId.get(row.operationId);
    if (!current || current.updatedAt <= row.updatedAt) byId.set(row.operationId, row);
  }
  const merged = [...byId.values()];
  await store.write(merged.filter((operation) => operation.stage !== "cancelled" || Date.now() - operation.updatedAt < 86_400_000));
  return merged;
}

async function recoverOneImport(
  store: MdbxImportStore,
  native: MdbxImportNative,
  vault: MdbxImportVault,
  seed: MdbxImportOperation
): Promise<MdbxImportOperation> {
  const operation = await readOperation(store, seed.operationId) || seed;
  if (operation.stage === "completed" || operation.stage === "cancelled") return operation;
  const owner = await registeredOwner(vault, operation);
  if (owner) {
    return {
      ...operation,
      stage: "syncing",
      providerId: owner.id,
      name: owner.name || operation.name,
      lastError: importError("mdbx-import-sync-retry", "MDBX 已接入，首次同步未完成，可稍后重试。", true),
      updatedAt: Date.now()
    };
  }
  if (operation.providerId && (operation.stage === "registered" || operation.stage === "syncing")) {
    return { ...operation, stage: "syncing", lastError: importError("mdbx-import-sync-retry", "MDBX 已接入，首次同步未完成，可稍后重试。", true), updatedAt: Date.now() };
  }
  const inFlight = operation.stage === "prepared" || operation.stage === "committing" || operation.stage === "detecting";
  if (inFlight && Date.now() - operation.updatedAt < MDBX_IMPORT_STALE_MS) return operation;
  if (!(await shouldDiscardWorkingCopy(vault, operation))) return operation;
  if (operation.vaultHandle) await native.discardVault(operation.vaultHandle).catch(() => undefined);
  if (operation.source.kind === "file") await native.releaseFile(operation.source.handle).catch(() => undefined);
  return {
    ...operation,
    stage: "cancelled",
    vaultHandle: undefined,
    lastError: importError("mdbx-import-abandoned", "未完成的 MDBX 导入已清理。", false),
    updatedAt: Date.now()
  };
}

export function mdbxImportUserMessage(code: string): string {
  switch (code) {
    case "vault-unlock-incorrect-credential":
      return "密码或安全密钥不正确。";
    case "vault-unlock-method-missing":
      return "此库未配置密码解锁。";
    case "vault-unlock-security-key-missing":
      return "此库未配置安全密钥。";
    case "vault-unlock-not-portable":
      return "此库的密钥无法在当前浏览器取得。请在安卓端生成带主密码或可携带安全密钥的可移植副本后再导入。";
    case "vault-invalid":
      return "文件损坏或不是可读的 MDBX。";
    case "mdbx-format-unsupported":
      return "不支持的 MDBX 格式版本。";
    case "mdbx-critical-extension-unsupported":
      return "此 MDBX 需要尚不支持的关键扩展。";
    case "android-project-zip":
      return "这是安卓项目备份，不是 MDBX 密码库。";
    case "kdb-legacy":
      return "检测到旧版 .kdb（KeePass 1.x）数据库，当前仅支持 .kdbx。请先在 KeePassDX/KeePassXC 中另存为 .kdbx 后再导入。";
    case "unknown":
      return "无法识别此文件。";
    case "mdbx-import-setup-orphan":
      return "插件密码库已创建，MDBX 尚未接入。可在导入与导出中重试。";
    case "mdbx-import-sync-retry":
      return "MDBX 已接入，首次同步未完成，可稍后重试。";
    case "vault-locked":
      return "MDBX 会话已关闭，请重新解锁后重试导入。";
    case "vault-source-not-found":
      return "未找到这次导入的 MDBX 文件，请重新选择后再打开。";
    default:
      return "";
  }
}

function assertUnlockAllowed(sniff: MdbxImportSniff, credential: Mdbx2VaultCredential): void {
  if (sniff.pinOnly) throw new Mdbx2NativeHostError("vault-unlock-not-portable", mdbxImportUserMessage("vault-unlock-not-portable"), false);
  if (sniff.incompatibilityReason === "vault-invalid") throw new Mdbx2NativeHostError("vault-invalid", "不是受支持的加密 MDBX。", false);
  const handshake = handshakeUnlock(sniff.unlockMethods);
  const methodsUnknown = sniff.unlockMethods.length === 0;
  if (credential.method === "password-security-key" && !methodsUnknown && !sniff.unlockMethods.includes("password-security-key")) {
    throw new Mdbx2NativeHostError("vault-unlock-method-missing", mdbxImportUserMessage("vault-unlock-method-missing"), false);
  }
  if (credential.method === "password" && !handshake.password && !methodsUnknown) {
    throw new Mdbx2NativeHostError(handshake.securityKey ? "vault-unlock-method-missing" : "vault-unlock-not-portable", handshake.securityKey ? mdbxImportUserMessage("vault-unlock-method-missing") : mdbxImportUserMessage("vault-unlock-not-portable"), false);
  }
  if ((credential.method === "security-key" || credential.method === "password-security-key") && !handshake.securityKey) {
    throw new Mdbx2NativeHostError("vault-unlock-security-key-missing", mdbxImportUserMessage("vault-unlock-security-key-missing"), false);
  }
}

async function finishRegistered(
  store: MdbxImportStore,
  vault: MdbxImportVault,
  sync: MdbxImportSync,
  operation: MdbxImportOperation,
  account?: ProviderAccount,
  items?: VaultItem[]
): Promise<MdbxImportCommitResult> {
  const providerId = operation.providerId;
  if (!providerId) throw new Mdbx2NativeHostError("params-invalid", "MDBX 导入尚未注册密码源。", false);
  const saved = account || await vault.getProvider(providerId);
  await saveOperation(store, { ...operation, stage: "syncing", updatedAt: Date.now() });
  try {
    await sync(providerId);
    const completed = { ...operation, stage: "completed" as const, lastError: undefined, updatedAt: Date.now() };
    await saveOperation(store, completed);
    return { operation: completed, account: saved, items, pluginSetupCompleted: operation.pluginSetupCompleted };
  } catch (error) {
    const mapped = mapImportError(error);
    const syncing = { ...operation, stage: "syncing" as const, lastError: { ...mapped, retryable: true }, updatedAt: Date.now() };
    await saveOperation(store, syncing);
    return { operation: syncing, account: saved, items, pluginSetupCompleted: operation.pluginSetupCompleted };
  }
}

async function cleanupUnregistered(store: MdbxImportStore, native: MdbxImportNative, operation: MdbxImportOperation, vault: MdbxImportVault): Promise<void> {
  if (await shouldDiscardWorkingCopy(vault, operation)) {
    if (operation.vaultHandle) await native.discardVault(operation.vaultHandle).catch(() => undefined);
  }
  const owned = await registeredOwner(vault, operation);
  await saveOperation(store, {
    ...operation,
    stage: owned ? "registered" : "failed",
    providerId: owned?.id || operation.providerId,
    vaultHandle: owned ? operation.vaultHandle : undefined,
    updatedAt: Date.now()
  });
}

async function failOperation(store: MdbxImportStore, operation: MdbxImportOperation, error: MdbxImportError, native: MdbxImportNative, vault?: MdbxImportVault): Promise<void> {
  const owned = vault ? await registeredOwner(vault, operation) : undefined;
  const discard = vault ? await shouldDiscardWorkingCopy(vault, operation) : Boolean(operation.vaultHandle && !operation.providerId && !owned);
  if (discard && operation.vaultHandle) await native.discardVault(operation.vaultHandle).catch(() => undefined);
  await saveOperation(store, {
    ...operation,
    stage: owned ? "registered" : !discard && operation.vaultHandle ? operation.stage : "failed",
    providerId: owned?.id || operation.providerId,
    lastError: owned ? undefined : error,
    vaultHandle: !discard ? operation.vaultHandle : undefined,
    updatedAt: Date.now()
  });
}

async function readOperation(store: MdbxImportStore, operationId: string): Promise<MdbxImportOperation | undefined> {
  return (await store.read()).find((operation) => operation.operationId === operationId);
}

async function upsertOperation(store: MdbxImportStore, operation: MdbxImportOperation): Promise<void> {
  const operations = await store.read();
  const index = operations.findIndex((row) => row.operationId === operation.operationId);
  if (index < 0) operations.push(operation);
  else operations[index] = operation;
  await store.write(operations);
}

async function saveOperation(store: MdbxImportStore, operation: MdbxImportOperation): Promise<void> {
  await upsertOperation(store, operation);
}

function requireOperationId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Mdbx2NativeHostError("params-invalid", "MDBX 导入操作标识无效。", false);
  }
  return value.toLowerCase();
}

function isStoredOperation(value: unknown): value is MdbxImportOperation {
  if (!value || typeof value !== "object") return false;
  const row = value as MdbxImportOperation;
  return typeof row.operationId === "string" && typeof row.stage === "string" && typeof row.kind === "string";
}

function importError(code: string, message: string, retryable: boolean): MdbxImportError {
  return { code, message, retryable };
}

function mapImportError(error: unknown): MdbxImportError {
  if (error instanceof Mdbx2NativeHostError) {
    const message = mdbxImportUserMessage(error.code) || error.message;
    return { code: error.code, message, retryable: error.retryable };
  }
  if (error instanceof Error) return { code: "mdbx-import-failed", message: error.message, retryable: false };
  return { code: "mdbx-import-failed", message: "MDBX 导入失败。", retryable: false };
}

function toHostError(error: MdbxImportError): Mdbx2NativeHostError {
  return new Mdbx2NativeHostError(error.code, error.message, error.retryable);
}
