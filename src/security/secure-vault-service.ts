import { createEmptyVaultState, type PasskeyItem, type PendingMutation, type ProviderAccount, type ProviderConflict, type ProviderConflictInput, type ProviderConflictResolution, type ProviderDiagnostic, type ProviderDiagnosticExport, type ProviderMutationReceipt, type ProviderReference, type ProviderSourceRecord, type VaultItem, type VaultState, type WindowsHelloBinding } from "../core/model";
import type { ProviderAcknowledgedMutation, ProviderRequestedMutation } from "../core/provider";
import { providerSourceRecordsFor, replaceProviderSourceRecords, validProviderMutationReceipt } from "../core/migrations";
import { sourceRecordsBudgetError } from "../core/source-records";
import { redactProviderDiagnostic, redactProviderMessage } from "../providers/provider-diagnostics";
import { createDeviceVaultKey, decryptVaultState, deriveVaultKey, encryptVaultState, exportVaultKey, importVaultKey, vaultKdfNeedsUpgrade, type DeviceVaultKdfParameters, type VaultEnvelope, type VaultKdfParameters } from "./vault-crypto";
import { validateMasterPassword } from "./master-password-policy";
import { bytesToBase64, randomBytes } from "./encoding";
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

export interface CompletedMdbx2TransferEntry {
  expected: VaultItem;
  result: VaultItem;
  action: "copy" | "move";
}

const MAX_PROVIDER_MUTATION_RECEIPTS = 500;

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
      if (envelope.kdf.windowsHelloBindingId) return "locked";
      try {
        const key = await this.deviceKey(envelope.kdf);
        const state = await decryptVaultState(envelope, key);
        if (state.settings.windowsHello) {
          await this.storage.write(await encryptVaultState(state, key, withWindowsHelloBindingId(envelope.kdf, state.settings.windowsHello.bindingId)));
          return "locked";
        }
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
    if (envelope.kdf.name === "DEVICE-KEY" && envelope.kdf.windowsHelloBindingId) throw new VaultHelloRequiredError();
    let key: CryptoKey;
    let state: VaultState;
    try {
      key = envelope.kdf.name === "DEVICE-KEY" ? await this.deviceKey(envelope.kdf) : (await deriveVaultKey(masterPassword, envelope.kdf)).key;
      state = await decryptVaultState(envelope, key);
    } catch {
      await this.sessions.clear();
      throw new VaultUnlockError();
    }
    if (envelope.kdf.name === "DEVICE-KEY" && state.settings.windowsHello) {
      await this.storage.write(await encryptVaultState(state, key, withWindowsHelloBindingId(envelope.kdf, state.settings.windowsHello.bindingId)));
      throw new VaultHelloRequiredError();
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

  async unlockWithWindowsHello(
    verify: (bindingId: string, challengeBase64Url: string) => Promise<unknown>
  ): Promise<VaultState> {
    return this.runExclusive(async () => {
      let envelope = await this.requireEnvelope();
      if (envelope.kdf.name !== "DEVICE-KEY") {
        throw new VaultHelloRequiredError("当前密码库使用主密码保护，请输入主密码；Windows Hello 只用于本机设备密钥密码库。");
      }
      const deviceKdf = envelope.kdf;
      let bindingId = deviceKdf.windowsHelloBindingId;
      let key: CryptoKey | undefined;
      let state: VaultState | undefined;
      if (!bindingId) {
        try {
          key = await this.deviceKey(deviceKdf);
          state = await decryptVaultState(envelope, key);
        } catch {
          await this.sessions.clear();
          throw new VaultUnlockError();
        }
        const legacyBinding = state.settings.windowsHello;
        if (!legacyBinding) throw new VaultHelloRequiredError("当前密码库没有有效的 Windows Hello 绑定。");
        bindingId = legacyBinding.bindingId;
        envelope = await encryptVaultState(state, key, withWindowsHelloBindingId(deviceKdf, bindingId));
        await this.storage.write(envelope);
      }
      const challengeBase64Url = bytesToBase64(randomBytes(32))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
      await verify(bindingId, challengeBase64Url);
      try {
        key ||= await this.deviceKey(deviceKdf);
        state ||= await decryptVaultState(envelope, key);
      } catch {
        await this.sessions.clear();
        throw new VaultUnlockError();
      }
      const binding = state.settings.windowsHello;
      if (!binding || binding.bindingId !== bindingId || binding.rpId !== "monica-extension.local") {
        await this.sessions.clear();
        throw new VaultHelloRequiredError("Windows Hello 本机绑定与加密密码库不一致，密码库保持锁定。");
      }
      await this.startSession(key, state.settings.autoLockMinutes);
      await this.deviceKeys.setAutoUnlockSuspended(false);
      return state;
    });
  }

  async windowsHelloBinding(): Promise<WindowsHelloBinding | undefined> {
    return this.runExclusive(async () => {
      const { envelope, key } = await this.unlockedContext();
      const state = await decryptVaultState(envelope, key);
      await this.touchSession(state.settings.autoLockMinutes);
      return structuredClone(state.settings.windowsHello);
    });
  }

  async windowsHelloBindingIdForRuntime(): Promise<string | undefined> {
    return this.runExclusive(async () => {
      const envelope = await this.storage.read();
      if (!envelope) return undefined;
      if (envelope.kdf.name === "DEVICE-KEY" && envelope.kdf.windowsHelloBindingId) return envelope.kdf.windowsHelloBindingId;
      try {
        const session = await this.sessions.read();
        let key: CryptoKey;
        if (session && session.expiresAt > this.now()) key = await importVaultKey(session.rawKey);
        else if (envelope.kdf.name === "DEVICE-KEY") key = await this.deviceKey(envelope.kdf);
        else return undefined;
        const state = await decryptVaultState(envelope, key);
        const bindingId = state.settings.windowsHello?.bindingId;
        if (bindingId && envelope.kdf.name === "DEVICE-KEY") {
          await this.storage.write(await encryptVaultState(state, key, withWindowsHelloBindingId(envelope.kdf, bindingId)));
        }
        return bindingId;
      } catch {
        return undefined;
      }
    });
  }

  async protectionModeForRuntime(): Promise<"master-password" | "device-key" | "unknown"> {
    return this.runExclusive(async () => {
      const envelope = await this.storage.read();
      if (!envelope) return "unknown";
      if (envelope.kdf.name === "DEVICE-KEY") return "device-key";
      return "master-password";
    });
  }

  async enrollWindowsHello(
    enroll: (bindingId: string) => Promise<WindowsHelloNativeEnrollment>,
    revoke?: (bindingId: string) => Promise<void>
  ): Promise<WindowsHelloBinding> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      if (state.settings.protectionMode !== "device-key") throw new VaultHelloRequiredError("Windows Hello 解锁验证当前只适用于本机设备密钥保护方式；主密码保护请继续使用主密码。");
      if (state.settings.windowsHello) throw new Error("当前密码库已经注册 Windows Hello。先撤销现有绑定再重新注册。");
      const bindingId = crypto.randomUUID();
      let nativeEnrolled = false;
      try {
        const native = await enroll(bindingId);
        nativeEnrolled = true;
        if (native.version !== 1 || native.bindingId !== bindingId || native.rpId !== "monica-extension.local" || native.verified !== true || !Number.isSafeInteger(native.enrolledAtUnixSeconds) || native.enrolledAtUnixSeconds < 1) {
          throw new Error("Windows Hello 注册响应无效。");
        }
        const binding: WindowsHelloBinding = {
          version: 1,
          bindingId,
          rpId: "monica-extension.local",
          enrolledAt: new Date(native.enrolledAtUnixSeconds * 1000).toISOString()
        };
        state.settings.windowsHello = binding;
        state.updatedAt = new Date(this.now()).toISOString();
        if (envelope.kdf.name !== "DEVICE-KEY") throw new VaultHelloRequiredError();
        await this.persist(state, key, withWindowsHelloBindingId(envelope.kdf, bindingId));
        return binding;
      } catch (error) {
        if (nativeEnrolled && revoke) {
          try { await revoke(bindingId); } catch { /* Preserve the locked state if native cleanup is unavailable. */ }
        }
        throw error;
      }
    });
  }

  async revokeWindowsHello(revoke: (bindingId: string) => Promise<void>): Promise<void> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const binding = state.settings.windowsHello;
      if (!binding) throw new Error("当前密码库尚未注册 Windows Hello。");
      await revoke(binding.bindingId);
      delete state.settings.windowsHello;
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, withoutWindowsHelloBindingId(envelope.kdf));
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
      if (state.settings.windowsHello) throw new VaultHelloRequiredError("更改保护方式前需要先撤销当前 Windows Hello 本机绑定。");
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
      const replacedDeviceKeyId = existing?.kdf.name === "DEVICE-KEY" ? existing.kdf.keyId : undefined;

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
      // Windows Hello is bound to the current Windows profile and vault
      // envelope; portable backups must never advertise a foreign binding.
      delete restoredState.settings.windowsHello;

      if (existing) {
        try {
          const currentKey = existing.kdf.name === "DEVICE-KEY" ? await this.deviceKey(existing.kdf) : (await deriveVaultKey(options.currentPassword || "", existing.kdf)).key;
          await decryptVaultState(existing, currentKey);
        } catch {
          throw new VaultUnlockError();
        }
      }

      let restoredEnvelope = await encryptVaultState(restoredState, backupKey, withoutWindowsHelloBindingId(backup.envelope.kdf));
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
        await this.deviceKeys.setAutoUnlockSuspended(false);
      } catch {
        await this.sessions.clear();
        throw new Error("加密备份已恢复，但无法继续当前会话；请使用备份密码重新解锁。");
      }
      if (replacedDeviceKeyId && (restoredEnvelope.kdf.name !== "DEVICE-KEY" || restoredEnvelope.kdf.keyId !== replacedDeviceKeyId)) {
        try { await this.deviceKeys.remove(replacedDeviceKeyId); } catch { /* The replaced vault is already durable; stale key cleanup is best effort. */ }
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

  async prepareProviderMutationReceipts(receipts: ProviderMutationReceipt[]): Promise<void> {
    return this.runExclusive(async () => {
      if (!Array.isArray(receipts) || !receipts.length) return;
      if (receipts.length > 100 || receipts.some((receipt) => !validProviderMutationReceipt(receipt))) {
        throw new Error("密码源持久同步回执无效或超过单批上限。");
      }
      const { state, envelope, key } = await this.mutableContext();
      const providers = new Set(state.providers.map((provider) => provider.id));
      const byKey = new Map(state.providerMutationReceipts.map((receipt) => [providerMutationReceiptKey(receipt), receipt]));
      for (const receipt of receipts) {
        if (!providers.has(receipt.providerId)) throw new Error("持久同步回执引用了不存在的密码源。");
        const keyValue = providerMutationReceiptKey(receipt);
        const existing = byKey.get(keyValue);
        if (existing) {
          if (!sameProviderMutationIntent(existing, receipt)) throw new Error("密码源操作标识已用于不同的持久同步意图。");
          continue;
        }
        byKey.set(keyValue, structuredClone(receipt));
      }
      if (byKey.size > MAX_PROVIDER_MUTATION_RECEIPTS) throw new Error("密码源持久同步回执数量超过安全上限。");
      state.providerMutationReceipts = [...byKey.values()];
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
    });
  }

  async markProviderMutationReceiptsAttempted(providerId: string, mutationIds: string[]): Promise<void> {
    return this.runExclusive(async () => {
      const ids = boundedMutationIds(mutationIds);
      if (!ids.size) return;
      const { state, envelope, key } = await this.mutableContext();
      const now = new Date(this.now()).toISOString();
      const found = new Set<string>();
      state.providerMutationReceipts = state.providerMutationReceipts.map((receipt) => {
        if (receipt.providerId !== providerId || !ids.has(receipt.mutationId)) return receipt;
        found.add(receipt.mutationId);
        if (receipt.stage === "committed") return receipt;
        return {
          ...receipt,
          stage: "attempted",
          attemptCount: Math.min(16, receipt.attemptCount + 1),
          attemptedAt: now,
          committedAt: undefined,
          updatedAt: now
        };
      });
      if (found.size !== ids.size) throw new Error("准备中的密码源持久同步回执不存在。");
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
    });
  }

  async commitProviderMutationReceipts(providerId: string, acknowledgements: ProviderAcknowledgedMutation[]): Promise<void> {
    return this.runExclusive(async () => {
      if (!Array.isArray(acknowledgements) || !acknowledgements.length) return;
      if (acknowledgements.length > 100) throw new Error("密码源持久同步确认超过单批上限。");
      const byId = new Map<string, ProviderAcknowledgedMutation>();
      for (const acknowledgement of acknowledgements) {
        if (!acknowledgement?.mutationId || !acknowledgement.itemId || !acknowledgement.remoteId || byId.has(acknowledgement.mutationId)) {
          throw new Error("密码源持久同步确认无效或重复。");
        }
        byId.set(acknowledgement.mutationId, acknowledgement);
      }
      const { state, envelope, key } = await this.mutableContext();
      const now = new Date(this.now()).toISOString();
      const found = new Set<string>();
      state.providerMutationReceipts = state.providerMutationReceipts.map((receipt) => {
        if (receipt.providerId !== providerId || !byId.has(receipt.mutationId)) return receipt;
        const acknowledgement = byId.get(receipt.mutationId)!;
        if (receipt.itemId !== acknowledgement.itemId || receipt.operation !== acknowledgement.operation) {
          throw new Error("密码源持久同步确认与原始意图不一致。");
        }
        found.add(receipt.mutationId);
        return {
          ...receipt,
          stage: "committed",
          remoteId: acknowledgement.remoteId,
          attemptedAt: receipt.attemptedAt || now,
          committedAt: now,
          updatedAt: now
        };
      });
      if (found.size !== byId.size) throw new Error("密码源持久同步确认缺少准备回执。");
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
    });
  }

  async clearProviderMutationReceipts(providerId: string, mutationIds: string[]): Promise<void> {
    return this.runExclusive(async () => {
      const ids = boundedMutationIds(mutationIds);
      if (!ids.size) return;
      const { state, envelope, key } = await this.mutableContext();
      const before = state.providerMutationReceipts.length;
      state.providerMutationReceipts = state.providerMutationReceipts.filter((receipt) => receipt.providerId !== providerId || !ids.has(receipt.mutationId));
      if (state.providerMutationReceipts.length === before) return;
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
    });
  }

  async listItems(): Promise<VaultItem[]> {
    return (await this.readState()).items.filter((item) => !item.deletedAt && !item.archivedAt);
  }

  async listArchivedItems(): Promise<VaultItem[]> {
    return (await this.readState()).items.filter((item) => !item.deletedAt && Boolean(item.archivedAt));
  }

  async listDeletedItems(): Promise<VaultItem[]> {
    return (await this.readState()).items.filter((item) => Boolean(item.deletedAt));
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
    state.mutationQueue = state.mutationQueue.filter((mutation) => mutation.providerId !== providerId);
    state.providerMutationReceipts = state.providerMutationReceipts.filter((receipt) => receipt.providerId !== providerId);
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

  async applyProviderSync(
    providerId: string,
    items: VaultItem[],
    accountPatch?: Partial<ProviderAccount>,
    conflicts: ProviderConflictInput[] = [],
    sourceRecords?: ProviderSourceRecord[],
    syncSnapshot?: VaultItem[],
    acknowledgedMutations: ProviderAcknowledgedMutation[] = [],
    requestedMutations: ProviderRequestedMutation[] = [],
    adoptRemoteRemovals = false
  ): Promise<{ conflicts: number }> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    const provider = state.providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error("密码源不存在。");
    const detectedAt = new Date(this.now()).toISOString();
    const acknowledgementsById = new Map<string, ProviderAcknowledgedMutation>();
    for (const acknowledgement of acknowledgedMutations) {
      if (!acknowledgement?.mutationId || !acknowledgement.itemId || !acknowledgement.remoteId || acknowledgementsById.has(acknowledgement.mutationId)) {
        throw new Error("密码源同步确认无效或重复。");
      }
      acknowledgementsById.set(acknowledgement.mutationId, acknowledgement);
    }
    if (!Array.isArray(requestedMutations) || requestedMutations.length > 100) {
      throw new Error("密码源请求排队的操作超过单批上限。");
    }
    const requestedByItemId = new Map<string, ProviderRequestedMutation>();
    for (const request of requestedMutations) {
      if (!request?.itemId || (request.operation !== "create" && request.operation !== "update" && request.operation !== "delete") || requestedByItemId.has(request.itemId)) {
        throw new Error("密码源请求排队的操作无效或重复。");
      }
      requestedByItemId.set(request.itemId, structuredClone(request));
    }
    const acknowledgementsByItemId = new Map([...acknowledgementsById.values()].map((acknowledgement) => [acknowledgement.itemId, acknowledgement]));
    if (acknowledgementsByItemId.size !== acknowledgementsById.size) throw new Error("密码源同步确认包含重复项目。");
    const merge = syncSnapshot
      ? mergeProviderSyncItems(providerId, syncSnapshot, state.items, items, acknowledgementsByItemId, adoptRemoteRemovals)
      : { items, conflicts: [] as ProviderConflictInput[], locallyChangedIds: new Set<string>(), confirmedMutationIds: new Set<string>() };
    const persistedConflicts: ProviderConflict[] = [...conflicts, ...merge.conflicts].slice(0, 500).map((conflict) => ({
      ...structuredClone(conflict),
      id: crypto.randomUUID(),
      providerId,
      detectedAt
    }));
    const globalConflict = persistedConflicts.find((conflict) => conflict.itemId === providerId || !conflict.local && !conflict.remote);
    state.items = merge.items;
    const consumedAcknowledgements = new Set<string>();
    state.mutationQueue = state.mutationQueue.flatMap((mutation): PendingMutation[] => {
      if (mutation.providerId !== providerId) return [mutation];
      const conflict = globalConflict || persistedConflicts.find((candidate) => candidate.itemId === mutation.itemId);
      // A mutation made after the adapter took its snapshot was not acknowledged
      // by this sync, even if the remote response otherwise looks successful.
      if (conflict) return [{ ...mutation, lastError: conflict.reason }];
      const acknowledgement = acknowledgementsById.get(mutation.id);
      if (acknowledgement) {
        if (acknowledgement.itemId !== mutation.itemId || acknowledgement.operation !== mutation.operation) {
          throw new Error("密码源同步确认与排队操作不一致。");
        }
        consumedAcknowledgements.add(mutation.id);
        if (!acknowledgement.followUp && !merge.locallyChangedIds.has(mutation.itemId)) return [];
        const mergedItem = merge.items.find((item) => item.id === mutation.itemId);
        const reference = mergedItem?.providerRefs.find((candidate) => candidate.providerId === providerId);
        if (!mergedItem || !reference?.remoteId || baseProviderRemoteId(reference.remoteId) !== baseProviderRemoteId(acknowledgement.remoteId)) {
          throw new Error("密码源同步确认缺少对应的远端引用。");
        }
        return [{
          ...mutation,
          operation: mergedItem.deletedAt ? "delete" : "update",
          attempts: 0,
          lastError: undefined
        }];
      }
      if (merge.confirmedMutationIds.has(mutation.itemId)) return [];
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
    if (consumedAcknowledgements.size !== acknowledgementsById.size) {
      throw new Error("密码源同步确认没有对应的排队操作。");
    }
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
    for (const request of requestedByItemId.values()) {
      const item = state.items.find((candidate) => candidate.id === request.itemId);
      const reference = item?.providerRefs.find((candidate) => candidate.providerId === providerId);
      if (!item || !reference) throw new Error("密码源请求排队的项目不存在或不属于此密码源。");
      if (globalConflict || persistedConflicts.some((conflict) => conflict.itemId === item.id)) {
        throw new Error("密码源不能为存在同步冲突的项目自动排队写入。");
      }
      const expectedOperation: PendingMutation["operation"] = item.deletedAt ? "delete" : reference.remoteId ? "update" : "create";
      if (request.operation !== expectedOperation) throw new Error("密码源请求排队的操作与项目状态不一致。");
      queueProviderMutation(state, item, providerId, request.operation, detectedAt);
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

      // An explicit conflict decision authorizes a fresh attempt. Retaining an
      // ambiguous create receipt here could either replay an old intent or
      // suppress the newly selected local version.
      state.providerMutationReceipts = state.providerMutationReceipts.filter((receipt) =>
        receipt.providerId !== conflict.providerId || receipt.itemId !== conflict.itemId
      );

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

  /**
   * Adopts Objects already committed by the MDBX2 Core. Keeping this separate from `importItems`
   * prevents a successful Native Host write from being queued a second time as a local mutation.
   */
  async applyCompletedMdbx2Transfer(entries: CompletedMdbx2TransferEntry[], targetProviderId?: string): Promise<VaultItem[]> {
    return this.runExclusive(async () => {
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 200) throw new Error("MDBX2 批量传输结果数量无效。");
      const { state, envelope, key } = await this.mutableContext();
      const currentById = new Map(state.items.map((item) => [item.id, item]));
      const resultIds = new Set<string>();
      const existingById = new Map(state.items.map((item) => [item.id, item]));
      for (const entry of entries) {
        if (!entry || !entry.expected || !entry.result || (entry.action !== "copy" && entry.action !== "move")) throw new Error("MDBX2 批量传输结果格式无效。");
        const current = currentById.get(entry.expected.id);
        const sameMoveIdentity = entry.action === "move" && entry.result.id === entry.expected.id;
        const existingResult = sameMoveIdentity ? undefined : existingById.get(entry.result.id);
        if (existingResult && JSON.stringify(existingResult) !== JSON.stringify(entry.result)) throw new Error(`目标项目「${entry.result.title || entry.result.id}」已存在不同内容。`);
        if (sameMoveIdentity && current && JSON.stringify(current) === JSON.stringify(entry.result)) {
          // A response-loss retry has already adopted this move.
        } else if (!existingResult && (!current || JSON.stringify(current) !== JSON.stringify(entry.expected))) {
          throw new Error(`项目「${entry.expected.title || entry.expected.id}」在传输期间发生变化，请重新读取后重试。`);
        }
        if (resultIds.has(entry.result.id)) throw new Error("MDBX2 批量传输结果包含重复项目 ID。");
        resultIds.add(entry.result.id);
        if (entry.action === "copy" && entry.result.id === entry.expected.id && !existingResult) throw new Error("MDBX2 复制结果不能复用来源项目 ID。");
        const targetReference = entry.result.providerRefs.find((reference) => targetProviderId ? reference.providerId === targetProviderId : Boolean(reference.remoteId));
        if (!targetReference) throw new Error("MDBX2 批量传输结果缺少已提交的远端 Object 标识。");
      }
      const replaceById = new Map(entries.filter((entry) => entry.action === "move").map((entry) => [entry.expected.id, entry.result]));
      const copies = entries.filter((entry) => entry.action === "copy" && !existingById.has(entry.result.id)).map((entry) => entry.result);
      state.items = [
        ...copies.slice().reverse(),
        ...state.items.map((item) => replaceById.get(item.id) || item)
      ];
      const affectedIds = new Set(entries.flatMap((entry) => [entry.expected.id, entry.result.id]));
      state.mutationQueue = state.mutationQueue.filter((mutation) => !affectedIds.has(mutation.itemId));
      state.providerConflicts = state.providerConflicts.filter((conflict) => !affectedIds.has(conflict.itemId));
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
      return entries.map((entry) => structuredClone(entry.result));
    });
  }

  /**
   * Deletes a foreign source and adopts a committed MDBX2 result while holding the vault mutation
   * lock. If persistence fails after the provider deletion, retrying the same entry is idempotent:
   * the already-adopted result is returned or the source deletion callback is invoked again.
   */
  async finalizeCompletedMdbx2Transfer(
    entry: CompletedMdbx2TransferEntry,
    targetProviderId: string,
    deleteSource?: () => Promise<void>
  ): Promise<VaultItem> {
    return this.runExclusive(async () => {
      if (!entry || !entry.expected || !entry.result || (entry.action !== "copy" && entry.action !== "move")) throw new Error("MDBX2 批量传输结果格式无效。");
      const { state, envelope, key } = await this.mutableContext();
      const sameMoveIdentity = entry.action === "move" && entry.result.id === entry.expected.id;
      const existingResult = sameMoveIdentity ? undefined : state.items.find((item) => item.id === entry.result.id);
      if (existingResult) {
        if (JSON.stringify(existingResult) !== JSON.stringify(entry.result)) throw new Error(`目标项目「${entry.result.title || entry.result.id}」已存在不同内容。`);
        return structuredClone(existingResult);
      }
      const current = state.items.find((item) => item.id === entry.expected.id);
      if (sameMoveIdentity && current && JSON.stringify(current) === JSON.stringify(entry.result)) return structuredClone(current);
      if (!current || JSON.stringify(current) !== JSON.stringify(entry.expected)) throw new Error(`项目「${entry.expected.title || entry.expected.id}」在传输期间发生变化，请重新读取后重试。`);
      const targetReference = entry.result.providerRefs.find((reference) => reference.providerId === targetProviderId && Boolean(reference.remoteId));
      if (!targetReference) throw new Error("MDBX2 批量传输结果缺少目标密码源引用。");
      if (entry.action === "copy" && entry.expected.id === entry.result.id) throw new Error("MDBX2 复制结果不能复用来源项目 ID。");
      if (entry.action === "move" && deleteSource) await deleteSource();

      if (entry.action === "copy") {
        state.items = [structuredClone(entry.result), ...state.items];
      } else {
        state.items = state.items.map((item) => item.id === entry.expected.id ? structuredClone(entry.result) : item);
      }
      const affectedIds = new Set([entry.expected.id, entry.result.id]);
      state.mutationQueue = state.mutationQueue.filter((mutation) => !affectedIds.has(mutation.itemId));
      state.providerConflicts = state.providerConflicts.filter((conflict) => !affectedIds.has(conflict.itemId));
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
      return structuredClone(entry.result);
    });
  }

  async restoreItem(itemId: string): Promise<VaultItem> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error("回收站项目不存在。");
      if (!item.deletedAt) return structuredClone(item);

      const now = new Date(this.now()).toISOString();
      const sharedBitwardenCiphers = new Set(item.providerRefs.flatMap((reference) => {
        const provider = state.providers.find((candidate) => candidate.id === reference.providerId);
        return provider?.kind === "bitwarden" && reference.remoteId
          ? [`${reference.providerId}\u0000${baseProviderRemoteId(reference.remoteId)}`]
          : [];
      }));
      const targets = state.items.filter((candidate) => candidate.deletedAt && (
        candidate.id === itemId || candidate.providerRefs.some((reference) => reference.remoteId && sharedBitwardenCiphers.has(`${reference.providerId}\u0000${baseProviderRemoteId(reference.remoteId)}`))
      ));
      const restoredById = new Map(targets.map((candidate) => [candidate.id, { ...candidate, deletedAt: undefined, updatedAt: now } as VaultItem]));
      state.items = state.items.map((candidate) => restoredById.get(candidate.id) || candidate);

      for (const restored of restoredById.values()) {
        for (const reference of restored.providerRefs) {
          const provider = state.providers.find((candidate) => candidate.id === reference.providerId);
          if (!provider || provider.kind === "local") continue;
          const pendingDelete = state.mutationQueue.find((mutation) => mutation.providerId === provider.id && mutation.itemId === restored.id && mutation.operation === "delete");
          if (pendingDelete) {
            const receipt = state.providerMutationReceipts.find((candidate) => candidate.providerId === provider.id && candidate.mutationId === pendingDelete.id);
            if (!receipt || receipt.stage === "prepared") {
              state.mutationQueue = state.mutationQueue.filter((mutation) => mutation !== pendingDelete);
              state.providerMutationReceipts = state.providerMutationReceipts.filter((candidate) => candidate !== receipt);
            }
            continue;
          }
          queueProviderMutation(state, restored, provider.id, "update", now);
        }
      }

      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return structuredClone(restoredById.get(itemId)!);
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
    const state = provider.config.accountState;
    const accountState = state && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : undefined;
    const safeList = (value: unknown) => Array.isArray(value)
      ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
        .map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => ["id", "name", "type", "role", "collections", "enabled"].includes(key))))
      : [];
    return {
      ...safe,
      config: {
        vaultUrl: stringConfig(provider, "vaultUrl"),
        email: stringConfig(provider, "email"),
        authenticated: Boolean(stringConfig(provider, "accessToken")),
        accountState: accountState ? {
          userId: typeof accountState.userId === "string" ? accountState.userId : undefined,
          organizations: safeList(accountState.organizations),
          policies: safeList(accountState.policies),
          serverRevision: typeof accountState.serverRevision === "string" ? accountState.serverRevision : undefined,
          syncedAt: typeof accountState.syncedAt === "string" ? accountState.syncedAt : undefined
        } : undefined
      }
    };
  }
  if (provider.kind === "keepass") {
    const protectionMode = stringConfig(provider, "protectionMode");
    const sourceMode = stringConfig(provider, "sourceMode");
    return {
      ...safe,
      config: {
        fileName: stringConfig(provider, "fileName") || undefined,
        protectionMode: ["password", "key-file", "password-and-key-file", "empty"].includes(protectionMode)
          ? protectionMode
          : undefined,
        ...(sourceMode === "webdav" ? {
          sourceMode: "webdav",
          webDavBaseUrl: stringConfig(provider, "webDavBaseUrl") || undefined,
          webDavUsername: stringConfig(provider, "webDavUsername") || undefined,
          remotePath: stringConfig(provider, "remotePath") || undefined,
          webDavPasswordConfigured: "webDavPassword" in provider.config,
          databaseCredentialStored: "databasePassword" in provider.config,
          keyFileConfigured: Boolean(stringConfig(provider, "keyFile")),
          workingCopyAvailable: Number.isSafeInteger(provider.config.workingCopyRevision) && Number(provider.config.workingCopyRevision) > 0,
          remoteEtagAvailable: Boolean(stringConfig(provider, "remoteEtag")),
          ...publicKeePassRemoteFailure(provider)
        } : sourceMode === "local-file" ? { sourceMode: "local-file" } : {})
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

export class VaultHelloRequiredError extends Error {
  constructor(message = "此设备密钥密码库需要 Windows Hello 验证；本机绑定不可用时请使用加密整库备份恢复。") {
    super(message);
    this.name = "VaultHelloRequiredError";
  }
}

function withWindowsHelloBindingId(kdf: DeviceVaultKdfParameters, bindingId: string): DeviceVaultKdfParameters {
  return { name: "DEVICE-KEY", keyId: kdf.keyId, windowsHelloBindingId: bindingId };
}

function withoutWindowsHelloBindingId(kdf: VaultKdfParameters): VaultKdfParameters {
  return kdf.name === "DEVICE-KEY" ? { name: "DEVICE-KEY", keyId: kdf.keyId } : kdf;
}

export interface WindowsHelloNativeEnrollment {
  version: 1;
  bindingId: string;
  rpId: "monica-extension.local";
  enrolledAtUnixSeconds: number;
  verified: true;
}

function stringConfig(provider: ProviderAccount, key: string): string {
  return typeof provider.config[key] === "string" ? provider.config[key] as string : "";
}

const PUBLIC_KEEPASS_REMOTE_ERROR_CODES = new Set([
  "remote-provider-invalid", "remote-working-copy-missing", "remote-credential-missing", "remote-key-file-invalid",
  "remote-operation-reused", "remote-cache-key-missing", "remote-receipt-invalid", "remote-rebase-conflict",
  "remote-path-invalid", "remote-file-missing", "remote-metadata-invalid", "remote-etag-required",
  "remote-download-too-large", "remote-upload-too-large", "remote-write-verification-failed",
  "record-invalid", "revision-stale", "operation-reused", "cancelled", "timeout", "network", "rate-limited",
  "server", "authentication", "permission", "not-found", "conflict", "client", "unknown"
]);

function publicKeePassRemoteFailure(provider: ProviderAccount): Record<string, unknown> {
  const code = stringConfig(provider, "remoteLastErrorCode");
  const at = stringConfig(provider, "remoteLastErrorAt");
  if (!PUBLIC_KEEPASS_REMOTE_ERROR_CODES.has(code) || !Number.isFinite(Date.parse(at))) return {};
  return {
    remoteLastErrorCode: code,
    remoteLastErrorRetryable: provider.config.remoteLastErrorRetryable === true,
    remoteLastErrorAt: at
  };
}

function queueProviderMutations(state: VaultState, item: VaultItem, operation: PendingMutation["operation"], now: string): void {
  for (const reference of item.providerRefs) {
    const provider = state.providers.find((candidate) => candidate.id === reference.providerId);
    if (!provider || provider.kind === "local") continue;
    queueProviderMutation(state, item, provider.id, operation, now);
  }
}

function queueProviderMutation(
  state: VaultState,
  item: VaultItem,
  providerId: string,
  operation: PendingMutation["operation"],
  now: string
): void {
  const reference = item.providerRefs.find((candidate) => candidate.providerId === providerId);
  if (!reference) throw new Error("排队项目缺少对应的密码源引用。");
  const existing = state.mutationQueue.find((mutation) => mutation.providerId === providerId && mutation.itemId === item.id);
  if (operation === "delete" && existing?.operation === "create" && !reference.remoteId) {
    state.mutationQueue = state.mutationQueue.filter((mutation) => mutation !== existing);
    return;
  }
  const nextOperation = operation === "delete" ? "delete" : reference.remoteId ? "update" : "create";
  const queued: PendingMutation = {
    id: existing?.id || crypto.randomUUID(),
    providerId,
    itemId: item.id,
    operation: nextOperation,
    createdAt: existing?.createdAt || now,
    attempts: existing?.attempts || 0
  };
  state.mutationQueue = existing
    ? state.mutationQueue.map((mutation) => mutation === existing ? queued : mutation)
    : [...state.mutationQueue, queued];
}

function providerMutationReceiptKey(receipt: Pick<ProviderMutationReceipt, "providerId" | "mutationId">): string {
  return `${receipt.providerId}\u0000${receipt.mutationId}`;
}

function sameProviderMutationIntent(left: ProviderMutationReceipt, right: ProviderMutationReceipt): boolean {
  return left.providerId === right.providerId
    && left.mutationId === right.mutationId
    && left.itemId === right.itemId
    && left.operation === right.operation
    && left.intentFingerprint === right.intentFingerprint
    && (left.remoteId || "") === (right.remoteId || "")
    && (left.baseRevision || "") === (right.baseRevision || "");
}

function boundedMutationIds(input: string[]): Set<string> {
  if (!Array.isArray(input) || input.length > 100) throw new Error("密码源持久同步操作数量超过单批上限。");
  const ids = new Set<string>();
  for (const id of input) {
    if (typeof id !== "string" || !id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id) || ids.has(id)) {
      throw new Error("密码源持久同步操作标识无效或重复。");
    }
    ids.add(id);
  }
  return ids;
}

function baseProviderRemoteId(remoteId: string): string {
  return remoteId.replace(/#(?:fido2|totp):.*$/, "");
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
  remote: VaultItem[],
  acknowledgementsByItemId: Map<string, ProviderAcknowledgedMutation> = new Map(),
  adoptRemoteRemovals = false
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
    const acknowledgement = acknowledgementsByItemId.get(id);
    if (localChanged) locallyChangedIds.add(id);

    if (!before) {
      if (!local && incoming) replacementById.set(id, incoming);
      else if (local && incoming && !sameVaultItem(local, incoming) && referencesProvider(providerId, local, incoming)) {
        conflicts.push({ itemId: id, reason: "同步期间本地和远端同时新增了同一项目。", local, remote: incoming });
      }
      continue;
    }
    // The incoming projection is the acknowledgement of the snapshot intent,
    // not an independent remote edit. If the user changed the item while the
    // request was in flight, preserve that newer payload and only rebase the
    // authoritative remote reference so a follow-up mutation remains queued.
    if (acknowledgement?.followUp && local) {
      replacementById.set(id, withAcknowledgedProviderReference(local, incoming, providerId, acknowledgement.remoteId));
      continue;
    }
    if (localChanged && acknowledgement && local) {
      replacementById.set(id, withAcknowledgedProviderReference(local, incoming, providerId, acknowledgement.remoteId));
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
      if (adoptRemoteRemovals && !localChanged) {
        replacementById.set(id, undefined);
        continue;
      }
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

function withAcknowledgedProviderReference(local: VaultItem, incoming: VaultItem | undefined, providerId: string, remoteId: string): VaultItem {
  const current = local.providerRefs.find((candidate) => candidate.providerId === providerId);
  const authoritative = incoming?.providerRefs.find((candidate) => candidate.providerId === providerId);
  return {
    ...local,
    providerRefs: [
      ...local.providerRefs.filter((candidate) => candidate.providerId !== providerId),
      {
        ...current,
        ...authoritative,
        providerId,
        remoteId: authoritative?.remoteId || remoteId,
        revision: authoritative?.revision || current?.revision
      }
    ]
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
