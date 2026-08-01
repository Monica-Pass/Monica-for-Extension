import { createEmptyVaultState, type PasskeyItem, type PendingMutation, type ProviderAccount, type ProviderConflict, type ProviderConflictInput, type ProviderConflictResolution, type ProviderDiagnostic, type ProviderDiagnosticExport, type ProviderReference, type ProviderSourceRecord, type VaultItem, type VaultState } from "../core/model";
import { providerSourceRecordsFor, replaceProviderSourceRecords } from "../core/migrations";
import { sourceRecordsBudgetError } from "../core/source-records";
import { redactProviderDiagnostic, redactProviderMessage } from "../providers/provider-diagnostics";
import { createDeviceVaultKey, decryptVaultState, deriveVaultKey, encryptVaultState, exportVaultKey, importVaultKey, vaultKdfNeedsUpgrade, type DeviceVaultKdfParameters, type VaultEnvelope, type VaultKdfParameters } from "./vault-crypto";
import { validateMasterPassword } from "./master-password-policy";
import type { VaultSessionStore } from "./vault-session";
import type { VaultEnvelopeStorage } from "./vault-storage";
import { MemoryVaultDeviceKeyStore, type VaultDeviceKeyStore } from "./vault-device-key";

export type VaultLifecycleStatus = "uninitialized" | "locked" | "unlocked";

export interface EncryptedVaultBackup {
  magic: "MONICA_EXTENSION_BACKUP";
  version: 1;
  exportedAt: string;
  envelope: VaultEnvelope;
}

export interface RestoreEncryptedVaultOptions {
  replaceExisting?: boolean;
  currentPassword?: string;
}

export class VaultLockedError extends Error {
  constructor(message = "Vault is locked") {
    super(message);
    this.name = "VaultLockedError";
  }
}

export class VaultUnlockError extends Error {
  constructor() {
    super("主密码错误或密码库数据已损坏。");
    this.name = "VaultUnlockError";
  }
}

export class SecureVaultService {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: VaultEnvelopeStorage,
    private readonly sessions: VaultSessionStore,
    private readonly now: () => number = () => Date.now(),
    private readonly deviceKeys: VaultDeviceKeyStore = new MemoryVaultDeviceKeyStore()
  ) {}

  async status(): Promise<VaultLifecycleStatus> {
    return this.runExclusive(async () => {
    const envelope = await this.storage.read();
    if (!envelope) return "uninitialized";
    const session = await this.sessions.read();
    if (!session) {
      if (envelope.kdf.name !== "DEVICE-KEY" || await this.deviceKeys.isAutoUnlockSuspended()) return "locked";
      try {
        const key = await this.deviceKey(envelope.kdf);
        const state = await decryptVaultState(envelope, key);
        await this.startSession(key, state.settings.autoLockMinutes);
        return "unlocked";
      } catch {
        return "locked";
      }
    }
    if (session.expiresAt <= this.now()) {
      await this.sessions.clear();
      return "locked";
    }
    return "unlocked";
    });
  }

  async setup(masterPassword: string, initialItems: VaultItem[] = []): Promise<VaultState> {
    return this.runExclusive(async () => {
    if ((await this.storage.read()) !== null) throw new Error("Vault has already been initialized");
    const state = createEmptyVaultState();
    state.items = initialItems;
    state.updatedAt = new Date(this.now()).toISOString();
    let key: CryptoKey;
    let kdf: VaultKdfParameters;
    if (masterPassword) {
      validateMasterPassword(masterPassword);
      ({ key, kdf } = await deriveVaultKey(masterPassword));
      state.settings.protectionMode = "master-password";
    } else {
      const device = await createDeviceVaultKey();
      key = device.key;
      kdf = device.kdf;
      state.settings.protectionMode = "device-key";
      await this.deviceKeys.write(device.kdf.keyId, device.rawKey);
      await this.deviceKeys.setAutoUnlockSuspended(false);
    }
    const envelope = await encryptVaultState(state, key, kdf);
    await this.storage.write(envelope);
    await this.startSession(key, state.settings.autoLockMinutes);
    return state;
    });
  }

  async unlock(masterPassword: string): Promise<VaultState> {
    return this.runExclusive(async () => {
    const envelope = await this.requireEnvelope();
    let key: CryptoKey;
    let state: VaultState;
    try {
      key = envelope.kdf.name === "DEVICE-KEY" ? await this.deviceKey(envelope.kdf) : (await deriveVaultKey(masterPassword, envelope.kdf)).key;
      state = await decryptVaultState(envelope, key);
    } catch {
      await this.sessions.clear();
      throw new VaultUnlockError();
    }
    if (envelope.kdf.name !== "DEVICE-KEY" && vaultKdfNeedsUpgrade(envelope.kdf)) {
      try {
        const upgraded = await deriveVaultKey(masterPassword);
        await this.storage.write(await encryptVaultState(state, upgraded.key, upgraded.kdf));
        key = upgraded.key;
      } catch {
        // A failed best-effort migration must not make a valid legacy vault unreadable.
      }
    }
    await this.startSession(key, state.settings.autoLockMinutes);
    await this.deviceKeys.setAutoUnlockSuspended(false);
    return state;
    });
  }

  async lock(): Promise<void> {
    return this.runExclusive(async () => {
      const envelope = await this.storage.read();
      if (envelope?.kdf.name === "DEVICE-KEY") await this.deviceKeys.setAutoUnlockSuspended(true);
      await this.sessions.clear();
    });
  }

  async changeMasterPassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.runExclusive(async () => {
      const envelope = await this.requireEnvelope();
      let state: VaultState;
      try {
        const currentKey = envelope.kdf.name === "DEVICE-KEY" ? await this.deviceKey(envelope.kdf) : (await deriveVaultKey(currentPassword, envelope.kdf)).key;
        state = await decryptVaultState(envelope, currentKey);
      } catch {
        throw new VaultUnlockError();
      }
      let newKey: CryptoKey;
      let newKdf: VaultKdfParameters;
      if (newPassword) {
        validateMasterPassword(newPassword);
        ({ key: newKey, kdf: newKdf } = await deriveVaultKey(newPassword));
        state.settings.protectionMode = "master-password";
      } else {
        const device = await createDeviceVaultKey();
        newKey = device.key;
        newKdf = device.kdf;
        state.settings.protectionMode = "device-key";
        await this.deviceKeys.write(device.kdf.keyId, device.rawKey);
      }
      state.updatedAt = new Date(this.now()).toISOString();
      await this.storage.write(await encryptVaultState(state, newKey, newKdf));
      if (envelope.kdf.name === "DEVICE-KEY" && envelope.kdf.keyId !== (newKdf.name === "DEVICE-KEY" ? newKdf.keyId : "")) await this.deviceKeys.remove(envelope.kdf.keyId);
      await this.deviceKeys.setAutoUnlockSuspended(false);
      try {
        await this.startSession(newKey, state.settings.autoLockMinutes);
      } catch {
        await this.sessions.clear();
        throw new Error("主密码已更改，但无法继续当前会话；请使用新主密码重新解锁。");
      }
    });
  }

  async exportEncryptedBackup(backupPassword: string): Promise<EncryptedVaultBackup> {
    return this.runExclusive(async () => {
      const { envelope, key } = await this.unlockedContext();
      const state = await decryptVaultState(envelope, key);
      validateMasterPassword(backupPassword);
      // A vault envelope can be tied to a device-local key.  Backups always get
      // their own password-derived envelope so they can be restored elsewhere.
      const backup = await deriveVaultKey(backupPassword);
      await this.touchSession(state.settings.autoLockMinutes);
      return {
        magic: "MONICA_EXTENSION_BACKUP",
        version: 1,
        exportedAt: new Date(this.now()).toISOString(),
        envelope: await encryptVaultState(state, backup.key, backup.kdf)
      };
    });
  }

  async restoreEncryptedBackup(
    input: EncryptedVaultBackup,
    backupPassword: string,
    options: RestoreEncryptedVaultOptions = {}
  ): Promise<VaultState> {
    return this.runExclusive(async () => {
      const backup = validateEncryptedBackup(input);
      const existing = await this.storage.read();
      if (existing && !options.replaceExisting) throw new Error("当前已存在密码库；替换恢复需要明确确认。");

      let restoredState: VaultState;
      let backupKey: CryptoKey;
      try {
        backupKey = backup.envelope.kdf.name === "DEVICE-KEY" ? await this.deviceKey(backup.envelope.kdf) : (await deriveVaultKey(backupPassword, backup.envelope.kdf)).key;
        restoredState = await decryptVaultState(backup.envelope, backupKey);
      } catch {
        throw new VaultUnlockError();
      }

      // New exports are always password-derived. A restored device-key vault
      // must therefore become a password-protected local vault rather than
      // advertising a device key that does not exist on this installation.
      if (backup.envelope.kdf.name !== "DEVICE-KEY") restoredState.settings.protectionMode = "master-password";

      if (existing) {
        try {
          const currentKey = existing.kdf.name === "DEVICE-KEY" ? await this.deviceKey(existing.kdf) : (await deriveVaultKey(options.currentPassword || "", existing.kdf)).key;
          await decryptVaultState(existing, currentKey);
        } catch {
          throw new VaultUnlockError();
        }
      }

      let restoredEnvelope = structuredClone(backup.envelope);
      if (backup.envelope.kdf.name !== "DEVICE-KEY") {
        restoredEnvelope = await encryptVaultState(restoredState, backupKey, restoredEnvelope.kdf);
      }
      if (restoredEnvelope.kdf.name !== "DEVICE-KEY" && vaultKdfNeedsUpgrade(restoredEnvelope.kdf)) {
        try {
          const upgraded = await deriveVaultKey(backupPassword);
          restoredEnvelope = await encryptVaultState(restoredState, upgraded.key, upgraded.kdf);
          backupKey = upgraded.key;
        } catch {
          // Preserve compatibility if the runtime cannot complete the optional KDF upgrade.
        }
      }
      await this.storage.write(restoredEnvelope);
      try {
        await this.startSession(backupKey, restoredState.settings.autoLockMinutes);
      } catch {
        await this.sessions.clear();
        throw new Error("加密备份已恢复，但无法继续当前会话；请使用备份密码重新解锁。");
      }
      return restoredState;
    });
  }

  async readState(): Promise<VaultState> {
    return this.runExclusive(async () => {
    const { envelope, key } = await this.unlockedContext();
    const state = await decryptVaultState(envelope, key);
    await this.touchSession(state.settings.autoLockMinutes);
    return state;
    });
  }

  async listItems(): Promise<VaultItem[]> {
    return (await this.readState()).items.filter((item) => !item.deletedAt);
  }

  async getItem(itemId: string): Promise<VaultItem | undefined> {
    return (await this.readState()).items.find((item) => item.id === itemId && !item.deletedAt);
  }

  async listProviders(): Promise<ProviderAccount[]> {
    return (await this.readState()).providers.map(publicProviderAccount);
  }

  async getProvider(providerId: string): Promise<ProviderAccount | undefined> {
    const provider = (await this.readState()).providers.find((candidate) => candidate.id === providerId);
    return provider ? safeProviderAccount(provider) : undefined;
  }

  async upsertProvider(provider: ProviderAccount): Promise<ProviderAccount> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    const exists = state.providers.some((candidate) => candidate.id === provider.id);
    state.providers = exists ? state.providers.map((candidate) => (candidate.id === provider.id ? provider : candidate)) : [...state.providers, provider];
    if (provider.isDefaultSaveTarget) {
      state.providers = state.providers.map((candidate) => ({ ...candidate, isDefaultSaveTarget: candidate.id === provider.id }));
      state.settings.defaultProviderId = provider.id;
    } else if (state.settings.defaultProviderId === provider.id) {
      const local = state.providers.find((candidate) => candidate.kind === "local");
      if (!local) throw new Error("本地密码源不存在。");
      state.providers = state.providers.map((candidate) => ({ ...candidate, isDefaultSaveTarget: candidate.id === local.id }));
      state.settings.defaultProviderId = local.id;
    }
    state.updatedAt = new Date(this.now()).toISOString();
    await this.persist(state, key, envelope.kdf);
    return publicProviderAccount(provider);
    });
  }

  async removeProvider(providerId: string): Promise<void> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    const provider = state.providers.find((candidate) => candidate.id === providerId);
    if (!provider || provider.kind === "local") throw new Error("本地密码源不能删除。");
    state.providers = state.providers.filter((candidate) => candidate.id !== providerId);
    state.sourceRecords = state.sourceRecords.filter((record) => record.providerId !== providerId);
    state.providerConflicts = state.providerConflicts.filter((conflict) => conflict.providerId !== providerId);
    state.items = state.items.flatMap((item): VaultItem[] => {
      if (!item.providerRefs.some((reference) => reference.providerId === providerId)) return [item];
      const providerRefs = item.providerRefs.filter((reference) => reference.providerId !== providerId);
      return providerRefs.length ? [{ ...item, providerRefs } as VaultItem] : [];
    });
    if (state.settings.defaultProviderId === providerId) {
      const local = state.providers.find((candidate) => candidate.kind === "local");
      if (!local) throw new Error("本地密码源不存在。");
      state.providers = state.providers.map((candidate) => ({ ...candidate, isDefaultSaveTarget: candidate.id === local.id }));
      state.settings.defaultProviderId = local.id;
    }
    state.updatedAt = new Date(this.now()).toISOString();
    await this.persist(state, key, envelope.kdf);
    });
  }

  async applyProviderSync(providerId: string, items: VaultItem[], accountPatch?: Partial<ProviderAccount>, conflicts: ProviderConflictInput[] = [], sourceRecords?: ProviderSourceRecord[], syncSnapshot?: VaultItem[]): Promise<{ conflicts: number }> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    const provider = state.providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error("密码源不存在。");
    const detectedAt = new Date(this.now()).toISOString();
    const merge = syncSnapshot ? mergeProviderSyncItems(providerId, syncSnapshot, state.items, items) : { items, conflicts: [] as ProviderConflictInput[], locallyChangedIds: new Set<string>(), confirmedMutationIds: new Set<string>() };
    const persistedConflicts: ProviderConflict[] = [...conflicts, ...merge.conflicts].slice(0, 500).map((conflict) => ({
      ...structuredClone(conflict),
      id: crypto.randomUUID(),
      providerId,
      detectedAt
    }));
    const globalConflict = persistedConflicts.find((conflict) => conflict.itemId === providerId || !conflict.local && !conflict.remote);
    state.items = merge.items;
    state.mutationQueue = state.mutationQueue.flatMap((mutation): PendingMutation[] => {
      if (mutation.providerId !== providerId) return [mutation];
      if (merge.confirmedMutationIds.has(mutation.itemId)) return [];
      const conflict = globalConflict || persistedConflicts.find((candidate) => candidate.itemId === mutation.itemId);
      // A mutation made after the adapter took its snapshot was not acknowledged
      // by this sync, even if the remote response otherwise looks successful.
      if (conflict) return [{ ...mutation, lastError: conflict.reason }];
      if (!merge.locallyChangedIds.has(mutation.itemId)) return [];
      const mergedItem = merge.items.find((item) => item.id === mutation.itemId);
      const reference = mergedItem?.providerRefs.find((candidate) => candidate.providerId === providerId);
      // Create-in-flight + local delete must become a remote delete once the
      // adapter has issued a remoteId; never promote a deleted item to update.
      if (mergedItem?.deletedAt && reference?.remoteId) {
        return [{ ...mutation, operation: "delete" }];
      }
      return [{ ...mutation, operation: mutation.operation === "create" && reference?.remoteId ? "update" : mutation.operation }];
    });
    // Local delete during create cancels the create mutation before a remoteId
    // exists. Once acknowledgement attaches that remoteId, re-queue delete so
    // the remote copy is removed instead of being left orphaned.
    for (const item of merge.items) {
      if (!item.deletedAt || !merge.locallyChangedIds.has(item.id)) continue;
      const reference = item.providerRefs.find((candidate) => candidate.providerId === providerId);
      if (!reference?.remoteId) continue;
      if (state.mutationQueue.some((mutation) => mutation.providerId === providerId && mutation.itemId === item.id)) continue;
      state.mutationQueue = [...state.mutationQueue, {
        id: crypto.randomUUID(),
        providerId,
        itemId: item.id,
        operation: "delete",
        createdAt: detectedAt,
        attempts: 0
      }];
    }
    state.providerConflicts = [...state.providerConflicts.filter((conflict) => conflict.providerId !== providerId), ...persistedConflicts];
    state.providers = state.providers.map((candidate) => candidate.id === providerId ? {
      ...candidate,
      ...accountPatch,
      id: candidate.id,
      kind: candidate.kind,
      lastError: persistedConflicts.length ? `发现 ${persistedConflicts.length} 个同步冲突。` : accountPatch?.lastError
    } : candidate);
    if (sourceRecords) {
      replaceProviderSourceRecords(state, providerId, sourceRecords);
      const budgetError = sourceRecordsBudgetError(state.sourceRecords);
      if (budgetError) throw new Error(budgetError);
    }
    state.updatedAt = new Date(this.now()).toISOString();
    await this.persist(state, key, envelope.kdf);
    return { conflicts: persistedConflicts.length };
    });
  }

  async getProviderSourceRecords(providerId: string): Promise<ProviderSourceRecord[]> {
    return providerSourceRecordsFor(await this.readState(), providerId);
  }

  async listProviderConflicts(providerId?: string): Promise<ProviderConflict[]> {
    const state = await this.readState();
    return state.providerConflicts.filter((conflict) => !providerId || conflict.providerId === providerId).map((conflict) => {
      const current = state.items.find((item) => item.id === conflict.itemId);
      return structuredClone({ ...conflict, local: current || conflict.local });
    });
  }

  async recordProviderDiagnostic(diagnostic: ProviderDiagnostic): Promise<void> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const safe = redactProviderDiagnostic(structuredClone(diagnostic));
      state.providerDiagnostics = [...state.providerDiagnostics, safe].slice(-100);
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
    });
  }

  async exportProviderDiagnostics(): Promise<ProviderDiagnosticExport> {
    const state = await this.readState();
    const diagnostics = redactProviderDiagnostic(structuredClone(state.providerDiagnostics));
    return {
      magic: "MONICA_PROVIDER_DIAGNOSTICS",
      version: 1,
      generatedAt: new Date(this.now()).toISOString(),
      summary: {
        total: diagnostics.length,
        successes: diagnostics.filter((entry) => entry.outcome === "success").length,
        conflicts: diagnostics.filter((entry) => entry.outcome === "conflict").length,
        failures: diagnostics.filter((entry) => entry.outcome === "failure").length,
        cancellations: diagnostics.filter((entry) => entry.outcome === "cancelled").length
      },
      diagnostics
    };
  }

  async resolveProviderConflict(conflictId: string, resolution: ProviderConflictResolution): Promise<void> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const conflict = state.providerConflicts.find((candidate) => candidate.id === conflictId);
      if (!conflict) throw new Error("同步冲突不存在或已经解决。");
      const provider = state.providers.find((candidate) => candidate.id === conflict.providerId);
      if (!provider) throw new Error("冲突对应的密码源不存在。");
      const now = new Date(this.now()).toISOString();

      if (resolution === "keep-local") {
        const current = state.items.find((item) => item.id === conflict.itemId) || conflict.local;
        if (!current) throw new Error("此冲突没有可保留的本地版本。");
        const reference = current.providerRefs.find((candidate) => candidate.providerId === conflict.providerId);
        const remoteReference = conflict.remote?.providerRefs.find((candidate) => candidate.providerId === conflict.providerId);
        const resolvedReference: ProviderReference = conflict.remote
          ? {
              ...reference,
              ...remoteReference,
              providerId: conflict.providerId,
              remoteId: remoteReference?.remoteId || reference?.remoteId,
              revision: conflict.remote.updatedAt,
              etag: remoteReference?.etag
            }
          : { providerId: conflict.providerId };
        const resolved = {
          ...current,
          providerRefs: [...current.providerRefs.filter((candidate) => candidate.providerId !== conflict.providerId), resolvedReference]
        } as VaultItem;
        state.items = state.items.some((item) => item.id === resolved.id)
          ? state.items.map((item) => item.id === resolved.id ? resolved : item)
          : [resolved, ...state.items];
        queueProviderMutations(state, resolved, conflict.remote ? "update" : "create", now);
        state.mutationQueue = state.mutationQueue.map((mutation) => mutation.providerId === conflict.providerId && mutation.itemId === conflict.itemId
          ? { ...mutation, attempts: 0, lastError: undefined }
          : mutation);
      } else if (resolution === "use-remote") {
        state.items = conflict.remote
          ? state.items.some((item) => item.id === conflict.itemId)
            ? state.items.map((item) => item.id === conflict.itemId ? structuredClone(conflict.remote!) : item)
            : [structuredClone(conflict.remote), ...state.items]
          : state.items.filter((item) => item.id !== conflict.itemId);
        state.mutationQueue = state.mutationQueue.filter((mutation) => mutation.providerId !== conflict.providerId || mutation.itemId !== conflict.itemId);
      } else {
        throw new Error("不支持的同步冲突解决方式。");
      }

      state.providerConflicts = state.providerConflicts.filter((candidate) => candidate.id !== conflict.id);
      const remaining = state.providerConflicts.filter((candidate) => candidate.providerId === conflict.providerId).length;
      state.providers = state.providers.map((candidate) => candidate.id === conflict.providerId
        ? { ...candidate, lastError: remaining ? `仍有 ${remaining} 个同步冲突待处理。` : undefined }
        : candidate);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
    });
  }

  async upsertItem(item: VaultItem): Promise<VaultItem> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    const now = new Date(this.now()).toISOString();
    const existing = state.items.find((candidate) => candidate.id === item.id);
    const normalized: VaultItem = {
      ...item,
      createdAt: existing?.createdAt || item.createdAt || now,
      updatedAt: now,
      providerRefs: item.providerRefs || []
    } as VaultItem;
    state.items = existing ? state.items.map((candidate) => (candidate.id === item.id ? normalized : candidate)) : [normalized, ...state.items];
    queueProviderMutations(state, normalized, existing ? "update" : "create", now);
    state.updatedAt = now;
    await this.persist(state, key, envelope.kdf);
    return normalized;
    });
  }

  async recordPasskeyUse(itemId: string, signCount: number, usedAt: string): Promise<PasskeyItem> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const item = state.items.find((candidate): candidate is PasskeyItem => candidate.id === itemId && candidate.kind === "passkey" && !candidate.deletedAt);
      if (!item) throw new Error("Passkey 不存在或已被删除。");
      const updated: PasskeyItem = { ...item, signCount, lastUsedAt: usedAt, useCount: (item.useCount || 0) + 1, updatedAt: usedAt };
      state.items = state.items.map((candidate) => candidate.id === itemId ? updated : candidate);
      queueProviderMutations(state, updated, "update", usedAt);
      state.updatedAt = usedAt;
      await this.persist(state, key, envelope.kdf);
      return updated;
    });
  }

  async importItems(items: VaultItem[]): Promise<VaultItem[]> {
    return this.runExclusive(async () => {
      const imported = validateImportedItems(items);
      const { state, envelope, key } = await this.mutableContext();
      const providerIds = new Set(state.providers.map((provider) => provider.id));
      if (imported.some((item) => item.providerRefs.some((reference) => !providerIds.has(reference.providerId)))) {
        throw new Error("导入项目引用了当前密码库中不存在的密码源。");
      }
      const now = new Date(this.now()).toISOString();
      const existingById = new Map(state.items.map((item) => [item.id, item]));
      const replacements = new Map<string, VaultItem>();
      const additions: VaultItem[] = [];
      const committed: VaultItem[] = [];
      const providersById = new Map(state.providers.map((provider) => [provider.id, provider]));
      const queuedByProviderItem = new Map(state.mutationQueue.map((mutation) => [`${mutation.providerId}\u0000${mutation.itemId}`, mutation]));
      for (const item of imported) {
        const existing = existingById.get(item.id);
        const normalized = {
          ...item,
          createdAt: existing?.createdAt || item.createdAt || now,
          updatedAt: now,
          providerRefs: item.providerRefs || []
        } as VaultItem;
        if (existing) replacements.set(item.id, normalized);
        else additions.push(normalized);
        queueImportedProviderMutations(normalized, providersById, queuedByProviderItem, now);
        committed.push(normalized);
      }

      // Preserve the previous per-item prepend semantics for new imports while
      // replacing existing records in place without repeated array rebuilds.
      state.items = [...additions.reverse(), ...state.items.map((item) => replacements.get(item.id) || item)];
      state.mutationQueue = [...queuedByProviderItem.values()];
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return committed;
    });
  }

  async deleteItem(itemId: string): Promise<void> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    const now = new Date(this.now()).toISOString();
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    state.items = state.items.map((candidate) => (candidate.id === itemId ? { ...candidate, deletedAt: now, updatedAt: now } : candidate)) as VaultItem[];
    queueProviderMutations(state, item, "delete", now);
    state.updatedAt = now;
    await this.persist(state, key, envelope.kdf);
    });
  }

  async markProviderSyncFailure(providerId: string, message: string): Promise<void> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    state.mutationQueue = state.mutationQueue.map((mutation) => mutation.providerId === providerId ? { ...mutation, attempts: Math.min(5, mutation.attempts + 1), lastError: message } : mutation);
    await this.persist(state, key, envelope.kdf);
    });
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async mutableContext(): Promise<{ state: VaultState; envelope: VaultEnvelope; key: CryptoKey }> {
    const { envelope, key } = await this.unlockedContext();
    return { state: await decryptVaultState(envelope, key), envelope, key };
  }

  private async persist(state: VaultState, key: CryptoKey, kdf: VaultKdfParameters): Promise<void> {
    await this.storage.write(await encryptVaultState(state, key, kdf));
    try {
      await this.touchSession(state.settings.autoLockMinutes);
    } catch {
      // The encrypted IndexedDB write is already durable. Failing the caller here
      // would make a committed mutation look rolled back and invite duplicate writes.
      // Keeping the previous expiry is fail-secure: the vault may lock sooner.
    }
  }

  private async requireEnvelope(): Promise<VaultEnvelope> {
    const envelope = await this.storage.read();
    if (!envelope) throw new Error("Vault is not initialized");
    return envelope;
  }

  private async deviceKey(kdf: DeviceVaultKdfParameters): Promise<CryptoKey> {
    const rawKey = await this.deviceKeys.read(kdf.keyId);
    if (!rawKey) throw new Error("此免主密码密码库的设备密钥不可用。");
    return importVaultKey(rawKey);
  }

  private async unlockedContext(): Promise<{ envelope: VaultEnvelope; key: CryptoKey }> {
    const envelope = await this.requireEnvelope();
    const session = await this.sessions.read();
    if (!session || session.expiresAt <= this.now()) {
      await this.sessions.clear();
      throw new VaultLockedError();
    }
    return { envelope, key: await importVaultKey(session.rawKey) };
  }

  private async startSession(key: CryptoKey, autoLockMinutes: number): Promise<void> {
    const now = this.now();
    await this.sessions.write({
      rawKey: await exportVaultKey(key),
      lastActivityAt: now,
      expiresAt: now + autoLockMinutes * 60_000
    });
  }

  private async touchSession(autoLockMinutes: number): Promise<void> {
    const session = await this.sessions.read();
    if (!session) throw new VaultLockedError();
    const now = this.now();
    await this.sessions.write({ ...session, lastActivityAt: now, expiresAt: now + autoLockMinutes * 60_000 });
  }
}

function safeProviderAccount(provider: ProviderAccount): ProviderAccount {
  return provider.lastError ? { ...provider, lastError: redactProviderMessage(provider.lastError) } : provider;
}

function publicProviderAccount(provider: ProviderAccount): ProviderAccount {
  const safe = safeProviderAccount(provider);
  if (provider.kind === "monica-webdav") {
    return {
      ...safe,
      config: {
        baseUrl: stringConfig(provider, "baseUrl"),
        username: stringConfig(provider, "username"),
        lastFileName: stringConfig(provider, "lastFileName") || undefined,
        lastEtag: stringConfig(provider, "lastEtag") || undefined,
        passwordConfigured: Boolean(stringConfig(provider, "password")),
        backupPasswordConfigured: Boolean(stringConfig(provider, "backupPassword"))
      }
    };
  }
  if (provider.kind === "bitwarden") {
    return {
      ...safe,
      config: {
        vaultUrl: stringConfig(provider, "vaultUrl"),
        email: stringConfig(provider, "email"),
        authenticated: Boolean(stringConfig(provider, "accessToken"))
      }
    };
  }
  if (provider.kind === "keepass") {
    const protectionMode = stringConfig(provider, "protectionMode");
    return {
      ...safe,
      config: {
        fileName: stringConfig(provider, "fileName") || undefined,
        protectionMode: ["password", "key-file", "password-and-key-file", "empty"].includes(protectionMode)
          ? protectionMode
          : undefined
      }
    };
  }
  if (provider.kind === "mdbx-legacy") {
    return {
      ...safe,
      config: {
        fileName: stringConfig(provider, "fileName") || undefined,
        formatVersion: "MDBX-1",
        supportState: "unsupported"
      }
    };
  }
  if (provider.kind === "mdbx2") {
    return {
      ...safe,
      config: {
        formatVersion: "MDBX-2",
        vaultHandle: stringConfig(provider, "vaultHandle") || undefined,
        schemaVersion: typeof provider.config.schemaVersion === "number" ? provider.config.schemaVersion : undefined,
        webDavBaseUrl: stringConfig(provider, "webDavBaseUrl") || undefined,
        webDavUsername: stringConfig(provider, "webDavUsername") || undefined,
        webDavPasswordConfigured: Boolean(stringConfig(provider, "webDavPassword")),
        remotePath: stringConfig(provider, "remotePath") || undefined,
        syncConfigured: Boolean(stringConfig(provider, "syncStateHandle")),
        hostVerifiedAt: stringConfig(provider, "hostVerifiedAt") || undefined
      }
    };
  }
  return { ...safe, config: {} };
}

function stringConfig(provider: ProviderAccount, key: string): string {
  return typeof provider.config[key] === "string" ? provider.config[key] as string : "";
}

function queueProviderMutations(state: VaultState, item: VaultItem, operation: PendingMutation["operation"], now: string): void {
  for (const reference of item.providerRefs) {
    const provider = state.providers.find((candidate) => candidate.id === reference.providerId);
    if (!provider || provider.kind === "local") continue;
    const existing = state.mutationQueue.find((mutation) => mutation.providerId === provider.id && mutation.itemId === item.id);
    if (operation === "delete" && existing?.operation === "create") { state.mutationQueue = state.mutationQueue.filter((mutation) => mutation !== existing); continue; }
    const nextOperation = operation === "delete" ? "delete" : reference.remoteId ? "update" : "create";
    const queued: PendingMutation = { id: existing?.id || crypto.randomUUID(), providerId: provider.id, itemId: item.id, operation: nextOperation, createdAt: existing?.createdAt || now, attempts: existing?.attempts || 0 };
    state.mutationQueue = existing ? state.mutationQueue.map((mutation) => mutation === existing ? queued : mutation) : [...state.mutationQueue, queued];
  }
}

function queueImportedProviderMutations(
  item: VaultItem,
  providersById: Map<string, ProviderAccount>,
  queuedByProviderItem: Map<string, PendingMutation>,
  now: string
): void {
  for (const reference of item.providerRefs) {
    const provider = providersById.get(reference.providerId);
    if (!provider || provider.kind === "local") continue;
    const key = `${provider.id}\u0000${item.id}`;
    const existing = queuedByProviderItem.get(key);
    queuedByProviderItem.set(key, {
      id: existing?.id || crypto.randomUUID(),
      providerId: provider.id,
      itemId: item.id,
      operation: reference.remoteId ? "update" : "create",
      createdAt: existing?.createdAt || now,
      attempts: existing?.attempts || 0
    });
  }
}

function mergeProviderSyncItems(
  providerId: string,
  snapshot: VaultItem[],
  current: VaultItem[],
  remote: VaultItem[]
): { items: VaultItem[]; conflicts: ProviderConflictInput[]; locallyChangedIds: Set<string>; confirmedMutationIds: Set<string> } {
  const snapshotById = new Map(snapshot.map((item) => [item.id, item]));
  const currentById = new Map(current.map((item) => [item.id, item]));
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const ids = new Set([...snapshotById.keys(), ...currentById.keys(), ...remoteById.keys()]);
  const replacementById = new Map<string, VaultItem | undefined>();
  const conflicts: ProviderConflictInput[] = [];
  const locallyChangedIds = new Set<string>();
  const confirmedMutationIds = new Set<string>();

  for (const id of ids) {
    const before = snapshotById.get(id);
    const local = currentById.get(id);
    const incoming = remoteById.get(id);
    const localChanged = !sameVaultItem(local, before);
    const remoteChanged = !sameVaultItem(incoming, before);
    if (localChanged) locallyChangedIds.add(id);

    if (!before) {
      if (!local && incoming) replacementById.set(id, incoming);
      else if (local && incoming && !sameVaultItem(local, incoming) && referencesProvider(providerId, local, incoming)) {
        conflicts.push({ itemId: id, reason: "同步期间本地和远端同时新增了同一项目。", local, remote: incoming });
      }
      continue;
    }
    // The adapter has observed our delete: neither side needs to retain a
    // tombstone or a pending delete mutation.
    if (local?.deletedAt && !incoming) {
      replacementById.set(id, undefined);
      locallyChangedIds.delete(id);
      confirmedMutationIds.add(id);
      continue;
    }
    // Local delete during create: attach the newly issued remote ID so the
    // remaining mutation becomes a remote delete, never an update that revives it.
    if (local?.deletedAt && incoming && isRemoteReferenceAcknowledgement(providerId, before, incoming)) {
      replacementById.set(id, withProviderReference(local, incoming, providerId));
      continue;
    }
    // A create acknowledgement may add a remote ID/revision while the user is
    // editing the local item. Keep the Monica ID and local payload stable, but
    // attach the remote reference so the remaining mutation becomes an update.
    if (local && !local.deletedAt && incoming && isRemoteReferenceAcknowledgement(providerId, before, incoming)) {
      replacementById.set(id, withProviderReference(local, incoming, providerId));
      continue;
    }
    if (local && !local.deletedAt && !incoming) {
      conflicts.push({ itemId: id, reason: "此项目已在远端删除，但浏览器中仍保留本地版本。", local });
      continue;
    }
    if (!localChanged) {
      if (remoteChanged) replacementById.set(id, incoming);
      continue;
    }
    if (remoteChanged && !sameVaultItem(local, incoming) && referencesProvider(providerId, before, local, incoming)) {
      conflicts.push({ itemId: id, reason: "同步期间本地和远端同时修改了同一项目。", local, remote: incoming });
    }
  }

  const merged = current.flatMap((item): VaultItem[] => {
    if (!replacementById.has(item.id)) return [item];
    const replacement = replacementById.get(item.id);
    return replacement ? [replacement] : [];
  });
  for (const item of remote) if (!currentById.has(item.id) && replacementById.get(item.id) === item) merged.push(item);
  return { items: merged, conflicts, locallyChangedIds, confirmedMutationIds };
}

function isRemoteReferenceAcknowledgement(providerId: string, before: VaultItem, incoming: VaultItem): boolean {
  const previous = before.providerRefs.find((reference) => reference.providerId === providerId);
  const acknowledged = incoming.providerRefs.find((reference) => reference.providerId === providerId);
  return Boolean(!previous?.remoteId && acknowledged?.remoteId);
}

function withProviderReference(local: VaultItem, incoming: VaultItem, providerId: string): VaultItem {
  const reference = incoming.providerRefs.find((candidate) => candidate.providerId === providerId);
  if (!reference) return local;
  return {
    ...local,
    providerRefs: [...local.providerRefs.filter((candidate) => candidate.providerId !== providerId), structuredClone(reference)]
  } as VaultItem;
}

function sameVaultItem(left: VaultItem | undefined, right: VaultItem | undefined): boolean {
  return left === right || Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
}

function referencesProvider(providerId: string, ...items: Array<VaultItem | undefined>): boolean {
  return items.some((item) => item?.providerRefs.some((reference) => reference.providerId === providerId));
}

function validateEncryptedBackup(input: unknown): EncryptedVaultBackup {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("加密备份格式无效。");
  const backup = input as Partial<EncryptedVaultBackup>;
  if (backup.magic !== "MONICA_EXTENSION_BACKUP" || backup.version !== 1 || typeof backup.exportedAt !== "string" || !backup.envelope || typeof backup.envelope !== "object") {
    throw new Error("加密备份格式无效或版本不受支持。");
  }
  return structuredClone(backup as EncryptedVaultBackup);
}

function validateImportedItems(input: unknown): VaultItem[] {
  if (!Array.isArray(input) || !input.length || input.length > 10_000) throw new Error("导入项目列表为空或过大。");
  const kinds = new Set(["login", "secure-note", "totp", "card", "identity", "billing-address", "payment-account", "passkey"]);
  const ids = new Set<string>();
  const items = input.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("导入项目格式无效。");
    const item = candidate as Partial<VaultItem>;
    if (typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.kind !== "string" || !kinds.has(item.kind) || typeof item.title !== "string" || !Array.isArray(item.providerRefs)) {
      throw new Error("导入项目缺少有效的 ID、类型、标题或密码源引用。");
    }
    ids.add(item.id);
    if (item.providerRefs.some((reference) => !reference || typeof reference.providerId !== "string" || !reference.providerId)) throw new Error("导入项目包含无效的密码源引用。");
    return structuredClone(candidate as VaultItem);
  });
  return items;
}
