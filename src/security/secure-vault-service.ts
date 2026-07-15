import { createEmptyVaultState, type PendingMutation, type ProviderAccount, type ProviderConflict, type ProviderConflictInput, type ProviderConflictResolution, type ProviderDiagnostic, type ProviderDiagnosticExport, type ProviderReference, type VaultItem, type VaultState } from "../core/model";
import { redactProviderDiagnostic, redactProviderMessage } from "../providers/provider-diagnostics";
import { decryptVaultState, deriveVaultKey, encryptVaultState, exportVaultKey, importVaultKey, vaultKdfNeedsUpgrade, type VaultEnvelope, type VaultKdfParameters } from "./vault-crypto";
import type { VaultSessionStore } from "./vault-session";
import type { VaultEnvelopeStorage } from "./vault-storage";

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
    private readonly now: () => number = () => Date.now()
  ) {}

  async status(): Promise<VaultLifecycleStatus> {
    return this.runExclusive(async () => {
    const envelope = await this.storage.read();
    if (!envelope) return "uninitialized";
    const session = await this.sessions.read();
    if (!session) return "locked";
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
    validateMasterPassword(masterPassword);
    const state = createEmptyVaultState();
    state.items = initialItems;
    state.updatedAt = new Date(this.now()).toISOString();
    const { key, kdf } = await deriveVaultKey(masterPassword);
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
      ({ key } = await deriveVaultKey(masterPassword, envelope.kdf));
      state = await decryptVaultState(envelope, key);
    } catch {
      await this.sessions.clear();
      throw new VaultUnlockError();
    }
    if (vaultKdfNeedsUpgrade(envelope.kdf)) {
      try {
        const upgraded = await deriveVaultKey(masterPassword);
        await this.storage.write(await encryptVaultState(state, upgraded.key, upgraded.kdf));
        key = upgraded.key;
      } catch {
        // A failed best-effort migration must not make a valid legacy vault unreadable.
      }
    }
    await this.startSession(key, state.settings.autoLockMinutes);
    return state;
    });
  }

  async lock(): Promise<void> {
    return this.runExclusive(() => this.sessions.clear());
  }

  async changeMasterPassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.runExclusive(async () => {
      validateMasterPassword(newPassword);
      const envelope = await this.requireEnvelope();
      let state: VaultState;
      try {
        const { key: currentKey } = await deriveVaultKey(currentPassword, envelope.kdf);
        state = await decryptVaultState(envelope, currentKey);
      } catch {
        throw new VaultUnlockError();
      }
      const { key: newKey, kdf: newKdf } = await deriveVaultKey(newPassword);
      state.updatedAt = new Date(this.now()).toISOString();
      await this.storage.write(await encryptVaultState(state, newKey, newKdf));
      try {
        await this.startSession(newKey, state.settings.autoLockMinutes);
      } catch {
        await this.sessions.clear();
        throw new Error("主密码已更改，但无法继续当前会话；请使用新主密码重新解锁。");
      }
    });
  }

  async exportEncryptedBackup(): Promise<EncryptedVaultBackup> {
    return this.runExclusive(async () => {
      const { envelope, key } = await this.unlockedContext();
      const state = await decryptVaultState(envelope, key);
      await this.touchSession(state.settings.autoLockMinutes);
      return {
        magic: "MONICA_EXTENSION_BACKUP",
        version: 1,
        exportedAt: new Date(this.now()).toISOString(),
        envelope: structuredClone(envelope)
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
        ({ key: backupKey } = await deriveVaultKey(backupPassword, backup.envelope.kdf));
        restoredState = await decryptVaultState(backup.envelope, backupKey);
      } catch {
        throw new VaultUnlockError();
      }

      if (existing) {
        try {
          const { key: currentKey } = await deriveVaultKey(options.currentPassword || "", existing.kdf);
          await decryptVaultState(existing, currentKey);
        } catch {
          throw new VaultUnlockError();
        }
      }

      let restoredEnvelope = structuredClone(backup.envelope);
      if (vaultKdfNeedsUpgrade(restoredEnvelope.kdf)) {
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
        throw new Error("加密备份已恢复，但无法继续当前会话；请使用备份主密码重新解锁。");
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

  async applyProviderSync(providerId: string, items: VaultItem[], accountPatch?: Partial<ProviderAccount>, conflicts: ProviderConflictInput[] = []): Promise<void> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    const provider = state.providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error("密码源不存在。");
    const detectedAt = new Date(this.now()).toISOString();
    const persistedConflicts: ProviderConflict[] = conflicts.slice(0, 500).map((conflict) => ({
      ...structuredClone(conflict),
      id: crypto.randomUUID(),
      providerId,
      detectedAt
    }));
    const globalConflict = persistedConflicts.find((conflict) => conflict.itemId === providerId || !conflict.local && !conflict.remote);
    state.items = items;
    state.mutationQueue = state.mutationQueue.flatMap((mutation): PendingMutation[] => {
      if (mutation.providerId !== providerId) return [mutation];
      const conflict = globalConflict || persistedConflicts.find((candidate) => candidate.itemId === mutation.itemId);
      return conflict ? [{ ...mutation, lastError: conflict.reason }] : [];
    });
    state.providerConflicts = [...state.providerConflicts.filter((conflict) => conflict.providerId !== providerId), ...persistedConflicts];
    state.providers = state.providers.map((candidate) => (candidate.id === providerId ? { ...candidate, ...accountPatch, id: candidate.id, kind: candidate.kind } : candidate));
    state.updatedAt = new Date(this.now()).toISOString();
    await this.persist(state, key, envelope.kdf);
    });
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

  async importItems(items: VaultItem[]): Promise<VaultItem[]> {
    return this.runExclusive(async () => {
      const imported = validateImportedItems(items);
      const { state, envelope, key } = await this.mutableContext();
      const providerIds = new Set(state.providers.map((provider) => provider.id));
      if (imported.some((item) => item.providerRefs.some((reference) => !providerIds.has(reference.providerId)))) {
        throw new Error("导入项目引用了当前密码库中不存在的密码源。");
      }
      const now = new Date(this.now()).toISOString();
      const committed: VaultItem[] = [];
      for (const item of imported) {
        const existing = state.items.find((candidate) => candidate.id === item.id);
        const normalized = {
          ...item,
          createdAt: existing?.createdAt || item.createdAt || now,
          updatedAt: now,
          providerRefs: item.providerRefs || []
        } as VaultItem;
        state.items = existing ? state.items.map((candidate) => candidate.id === item.id ? normalized : candidate) : [normalized, ...state.items];
        queueProviderMutations(state, normalized, existing ? "update" : "create", now);
        committed.push(normalized);
      }
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
    await this.touchSession(state.settings.autoLockMinutes);
  }

  private async requireEnvelope(): Promise<VaultEnvelope> {
    const envelope = await this.storage.read();
    if (!envelope) throw new Error("Vault is not initialized");
    return envelope;
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

function validateMasterPassword(value: string): void {
  if (value.length < 15) throw new Error("主密码至少需要 15 个字符。");
  if (value.length > 1_024) throw new Error("主密码不能超过 1024 个字符。");
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
