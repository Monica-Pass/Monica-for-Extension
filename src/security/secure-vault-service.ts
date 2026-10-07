import { createEmptyVaultState, type PasskeyItem, type PendingMutation, type ProviderAccount, type ProviderConflict, type ProviderConflictInput, type ProviderConflictResolution, type ProviderDiagnostic, type ProviderDiagnosticExport, type ProviderMutationReceipt, type ProviderReference, type ProviderSourceRecord, type VaultItem, type VaultState, type WindowsHelloBinding } from "../core/model";
import { sameProviderBinding, type ProviderAcknowledgedMutation, type ProviderRequestedMutation, type ProviderSyncGuard } from "../core/provider";
import { matchesBinding, oneDriveConnectionBinding, parseOneDriveConnection, validOneDriveTokens, type OneDriveConnection } from "../providers/onedrive/onedrive-token-manager";
import type { OneDriveTokens } from "../providers/onedrive/onedrive-auth";
import { capturePasswordHistory } from '../core/password-history';
import { planKeePassProjectRemoval, type KeePassProjectRemovalDraft } from '../core/keepass-project-removal';
import { keePassRemovalRequestKey, keePassRemovalFileRequestHash, readKeePassProjectRemovalIntents, type KeePassProjectRemovalIntent } from '../core/keepass-project-removal-journal';
import { assertKeePassResolutionUnchanged, readKeePassProjectResolutionIntents, resolutionSnapshotKey, type KeePassProjectResolutionIntent } from '../core/keepass-project-resolution-journal';
import { keePassProjectResolutionRequestHash } from '../providers/keepass/keepass-project-resolution';
import { validateKeePassDurableMutationReceipt, type KeePassDurableMutationReceipt } from '../providers/keepass/keepass-working-copy-store';
import { assertKeePassRestoreProject, keePassRestoreProject, readKeePassProjectRestoreReceipts, readKeePassProjectRestoreRequest, type KeePassProjectRestoreRequest, type KeePassProjectRestoreReceipt } from '../core/keepass-project-restore';
import { mdbx2PasswordHistoryTransferBlockReason } from '../providers/mdbx2/mdbx2-batch-transfer';
import { providerSourceRecordsFor, replaceProviderSourceRecords, validProviderMutationReceipt } from "../core/migrations";
import { sourceRecordsBudgetError } from "../core/source-records";
import { redactProviderDiagnostic, redactProviderMessage } from "../providers/provider-diagnostics";
import { createDeviceVaultKey, decryptVaultState, deriveVaultKey, encryptVaultState, exportVaultKey, importVaultKey, vaultKdfNeedsUpgrade, type DeviceVaultKdfParameters, type VaultEnvelope, type VaultKdfParameters } from "./vault-crypto";
import { validateMasterPassword } from "./master-password-policy";
import { bytesToBase64, randomBytes } from "./encoding";
import type { VaultSessionStore } from "./vault-session";
import type { VaultEnvelopeStorage } from "./vault-storage";
import { MemoryVaultDeviceKeyStore, type VaultDeviceKeyStore } from "./vault-device-key";
import { LockedAutofillCache, supportsLockedAutofill } from "./locked-autofill";
import { autofillCredentialIdentities, type AutofillCredentialIdentity } from "../autofill/credential-identity";
import { normalizeSitePolicy, type AutofillSitePolicy } from "../autofill/site-policy";
import { addBlockedFieldSignature, normalizeBlockedFieldSignature, type BlockedFieldSignatureRecord } from "../autofill/field-policy";
import { normalizeHomePreferences, type HomePreferences } from "../core/home-preferences";
import { apiTokenValidationError } from "../core/api-token";
import type { LoginItem } from "../core/model";
import { passwordGroupMembers } from "../core/password-groups";
import { reconcileProjectCredentialEdits } from "../core/project-credential-edits";
import { readProjectCredential } from "../core/project-credentials";
import { advanceHotpCounter, findBoundTotpItem, hotpSigningIdentity, hotpUsageFromItem, otpSourceBinding, parametersFromItem, type HotpUsage } from '../core/login-otp';
import { normalizeOtpCounter } from '../core/otp-counter';
import { planPasswordProjectRemoval } from '../core/password-project-removal';
import { isPasswordProjectRemovalPending, retainPasswordProjectRemovalHistory, passwordProjectRemovalContent, readPasswordProjectRemovalJournal, type PasswordProjectNativeDeletionIntent, type PasswordProjectRemovalProof, type PasswordProjectRemovalRecord } from '../core/password-project-removal-journal';
import { cancelPasswordProjectRemovalDraft, assertCancellationPreservesLaterEdits } from '../core/password-project-removal-cancel';
import { assertPasswordProjectNativeDeletionScope } from '../core/password-project-removal-native';
import type { Mdbx2ObjectBatchResult } from '../providers/mdbx2/native-contract';
import { readMdbx2RestoreJournal, assertMdbx2RestoreScope, type Mdbx2RestoreRecord } from '../core/mdbx2-restore-journal';
import { mdbx2RestoreBatchSources, readMdbx2RestoreBatchJournal, readMdbx2RestoreBatchRequest, assertMdbx2RestoreBatchScope, type Mdbx2RestoreBatchRecord, type Mdbx2RestoreBatchRequest } from '../core/mdbx2-restore-batch-journal';
import { readMdbx2DeletionCancellations, type Mdbx2DeletionCancellation } from '../core/mdbx2-deletion-cancellation';
import { passwordGroupKey } from '../core/password-groups';
import type { Mdbx2ObjectsRestoreResult } from '../providers/mdbx2/native-contract';
import type { Mdbx2ObjectRestoreResult } from '../providers/mdbx2/native-contract';
import { mdbx2ItemFingerprint } from '../providers/mdbx2/mdbx2-provider';
import { readMdbx2MoveJournal, type Mdbx2MoveFinalizationRecord } from "../core/mdbx2-move-journal";
import { assertPasskeyCounterNotRegressed, nextBitwardenPasskeyCounter, nextPasskeyCounter, passkeyCounterHighWaterMark, preserveLocalPasskeyUsage, preservePasskeyCounterHistory, resolvePasskeyOwnership, samePasskeySigningIdentity } from "../passkey/ownership-policy";

export type VaultLifecycleStatus = "uninitialized" | "locked" | "unlocked";

export interface AutofillContext {
  locked: boolean;
  items: VaultItem[];
  credentialIdentities: Record<string, AutofillCredentialIdentity>;
  allowedIds: string[];
  blockedHosts: string[];
  blockedFieldSignatures: string[];
  /** Internal revision check; never returned through extension messages. */
  envelopeVersion: string;
}

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
    private readonly deviceKeys: VaultDeviceKeyStore = new MemoryVaultDeviceKeyStore(),
    private readonly lockedAutofill: LockedAutofillCache = new LockedAutofillCache()
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

  async unlock(masterPassword: string, assertActive?: () => void): Promise<VaultState> {
    return this.runExclusive(async () => {
    assertActive?.();
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
    assertActive?.();
    if (envelope.kdf.name !== "DEVICE-KEY" && vaultKdfNeedsUpgrade(envelope.kdf)) {
      try {
        const upgraded = await deriveVaultKey(masterPassword);
        await this.storage.write(await encryptVaultState(state, upgraded.key, upgraded.kdf));
        key = upgraded.key;
      } catch {
        // A failed best-effort migration must not make a valid legacy vault unreadable.
      }
    }
    assertActive?.();
    await this.startSession(key, state.settings.autoLockMinutes);
    await this.deviceKeys.setAutoUnlockSuspended(false);
    await this.refreshLockedAutofill(state, await this.requireEnvelope());
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
    verify: (bindingId: string, challengeBase64Url: string) => Promise<unknown>,
    assertActive?: () => void
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
      assertActive?.();
      await this.startSession(key, state.settings.autoLockMinutes);
      await this.deviceKeys.setAutoUnlockSuspended(false);
      await this.refreshLockedAutofill(state, await this.requireEnvelope());
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

  /** Fresh verification for one WebAuthn ceremony; it must not unlock or extend a session. */
  async verifyMasterPasswordForPasskey(masterPassword: string): Promise<void> {
    return this.runExclusive(async () => {
      const { envelope } = await this.unlockedContext();
      if (envelope.kdf.name === "DEVICE-KEY") throw new Error("此密码库未设置主密码，请使用 Windows Hello 验证身份。");
      if (typeof masterPassword !== "string" || !masterPassword || masterPassword.length > 4096) throw new VaultUnlockError();
      try {
        const { key } = await deriveVaultKey(masterPassword, envelope.kdf);
        await decryptVaultState(envelope, key);
      } catch {
        throw new VaultUnlockError();
      }
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
      const newEnvelope = await encryptVaultState(state, newKey, newKdf);
      await this.refreshLockedAutofill(state, newEnvelope);
      await this.storage.write(newEnvelope);
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
      // A portable backup cannot grant device-local access on another installation.
      restoredState.settings.lockedAutofillItemIds = [];

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
      await this.refreshLockedAutofill(restoredState, restoredEnvelope);
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

  async readState(activity = false): Promise<VaultState> {
    return this.runExclusive(async () => {
    const { envelope, key } = await this.unlockedContext();
    const state = await decryptVaultState(envelope, key);
    if (activity) await this.touchSession(state.settings.autoLockMinutes);
    return state;
    });
  }

  /** Only explicit user interaction renews inactivity expiry; background reads do not. */
  async recordUserActivity(): Promise<void> {
    return this.runExclusive(async () => {
      const session = await this.sessions.read();
      if (!session || session.expiresAt <= this.now()) return;
      const lifetime = session.expiresAt - session.lastActivityAt;
      const now = this.now();
      await this.sessions.write({ ...session, lastActivityAt: now, expiresAt: now + lifetime });
    });
  }

  async getAutofillSitePolicy(): Promise<AutofillSitePolicy> {
    const state = await this.readState();
    return {
      blockedHosts: [...state.settings.autofillBlockedHosts],
      saveBlockedHosts: [...state.settings.saveBlockedHosts]
    };
  }

  async getHomePreferences(): Promise<HomePreferences> {
    return normalizeHomePreferences((await this.readState()).settings.home);
  }

  async setHomePreferences(input: Partial<HomePreferences>): Promise<HomePreferences> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const preferences = normalizeHomePreferences({ ...normalizeHomePreferences(state.settings.home), ...input });
      state.settings.home = preferences;
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
      return preferences;
    });
  }

  async setAutofillSitePolicy(input: AutofillSitePolicy): Promise<AutofillSitePolicy> {
    const policy = normalizeSitePolicy(input);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      state.settings.autofillBlockedHosts = policy.blockedHosts;
      state.settings.saveBlockedHosts = policy.saveBlockedHosts;
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
      return structuredClone(policy);
    });
  }

  async listAutofillBlockedFieldSignatures(): Promise<BlockedFieldSignatureRecord[]> {
    const state = await this.readState();
    return structuredClone(state.settings.autofillBlockedFieldSignatures);
  }

  async isAutofillFieldSignatureBlocked(signature: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(signature)) return false;
    const state = await this.readState();
    return state.settings.autofillBlockedFieldSignatures.some((record) => record.signature === signature);
  }

  async addAutofillBlockedFieldSignature(input: BlockedFieldSignatureRecord): Promise<BlockedFieldSignatureRecord> {
    const record = normalizeBlockedFieldSignature(input);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      state.settings.autofillBlockedFieldSignatures = addBlockedFieldSignature(state.settings.autofillBlockedFieldSignatures, record);
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
      return structuredClone(record);
    });
  }

  async removeAutofillBlockedFieldSignature(signature: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(signature)) throw new Error("字段签名格式无效。");
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const next = state.settings.autofillBlockedFieldSignatures.filter((record) => record.signature !== signature);
      if (next.length === state.settings.autofillBlockedFieldSignatures.length) return false;
      state.settings.autofillBlockedFieldSignatures = next;
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
      return true;
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
      await this.persist(state, key, envelope.kdf, false, false);
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
      await this.persist(state, key, envelope.kdf, false, false);
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
      await this.persist(state, key, envelope.kdf, false, false);
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
      await this.persist(state, key, envelope.kdf, false, false);
    });
  }

  async listItems(): Promise<VaultItem[]> {
    return (await this.readState()).items.filter((item) => !item.deletedAt && !item.archivedAt);
  }

  async listLockedAutofillItemIds(): Promise<string[]> {
    return [...((await this.readState()).settings.lockedAutofillItemIds || [])];
  }

  async setLockedAutofill(itemId: string, enabled: boolean): Promise<void> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      this.updateLockedAutofillGrant(state, itemId, enabled);
      await this.persist(state, key, envelope.kdf, enabled);
    });
  }

  /** Background-only projection; the runtime exposes summaries and explicit fills. */
  async readAutofillContext(): Promise<AutofillContext> {
    return this.runExclusive(async () => {
      const envelope = await this.requireEnvelope();
      const envelopeVersion = JSON.stringify(envelope);
      const session = await this.sessions.read();
      if (session && session.expiresAt > this.now()) {
        const state = await decryptVaultState(envelope, await importVaultKey(session.rawKey));
        return {
          locked: false, envelopeVersion, items: state.items.filter((item) => !item.deletedAt && !item.archivedAt),
          credentialIdentities: autofillCredentialIdentities(state.items),
          allowedIds: state.settings.lockedAutofillItemIds || [], blockedHosts: state.settings.autofillBlockedHosts,
          blockedFieldSignatures: state.settings.autofillBlockedFieldSignatures.map((record) => record.signature)
        };
      }
      const cached = await this.lockedAutofill.read(envelope);
      return { locked: true, envelopeVersion, items: cached?.logins || [], credentialIdentities: cached?.credentialIdentities || {}, allowedIds: cached?.logins.map((item) => item.id) || [], blockedHosts: cached?.blockedHosts || [], blockedFieldSignatures: cached?.blockedFieldSignatures || [] };
    });
  }

  /** Recheck after asynchronous page inspection and OTP generation, immediately before dispatch. */
  async dispatchAutofill<T>(context: AutofillContext, dispatch: () => Promise<T>): Promise<T> {
    const { result } = await this.runExclusive(async () => {
      const envelope = await this.requireEnvelope();
      const session = await this.sessions.read();
      const locked = !session || session.expiresAt <= this.now();
      if (locked !== context.locked || JSON.stringify(envelope) !== context.envelopeVersion) {
        throw new Error("填写权限或密码库已变化，请重新打开 Monica 后再填充。");
      }
      // Start delivery while authorized, but never hold the vault lock while awaiting a page.
      return { result: dispatch() };
    });
    return result;
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

  async upsertProvider(provider: ProviderAccount, activity = true, expectedProvider?: ProviderAccount,
    guard?: { sessionId: string; oneDriveReauthorization?: boolean }): Promise<ProviderAccount> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    if (guard && (await this.sessions.read())?.id !== guard.sessionId) throw new VaultLockedError();
    const currentProvider = state.providers.find(candidate => candidate.id === provider.id);
    if (expectedProvider && (!currentProvider || !sameProviderBinding(expectedProvider, currentProvider))) throw new Error("同步期间密码源配置已变化，请重新同步。");
    // A KDBX sync snapshot predates an OAuth refresh. Keep the independently
    // persisted connection when applying unrelated working-copy metadata.
    if (guard?.oneDriveReauthorization) {
      const current = parseOneDriveConnection(currentProvider?.config.oneDriveConnection);
      const incoming = parseOneDriveConnection(provider.config.oneDriveConnection);
      if (provider.kind !== "keepass" || provider.config.sourceMode !== "onedrive" || !current || !incoming || !matchesBinding(incoming, oneDriveConnectionBinding(current)) ||
        provider.config.oneDriveDriveId !== currentProvider?.config.oneDriveDriveId || provider.config.oneDriveItemId !== currentProvider?.config.oneDriveItemId) {
        throw new Error("OneDrive 登录账号或数据库已变化，请新增密码源。");
      }
    }
    if (expectedProvider && currentProvider && provider.kind === "keepass" && provider.config.sourceMode === "onedrive" && !guard?.oneDriveReauthorization) {
      const current = parseOneDriveConnection(currentProvider.config.oneDriveConnection);
      const incoming = parseOneDriveConnection(provider.config.oneDriveConnection);
      // Changing the KDBX password must not revert an OAuth refresh that happened
      // while opening the file. Database credentials are a separate identity.
      if (current && incoming && matchesBinding(incoming, oneDriveConnectionBinding(current)) &&
        provider.config.oneDriveDriveId === currentProvider.config.oneDriveDriveId && provider.config.oneDriveItemId === currentProvider.config.oneDriveItemId) {
        provider = { ...provider, config: { ...provider.config, oneDriveConnection: currentProvider.config.oneDriveConnection } };
      }
    }
    if (!activity && currentProvider) provider = { ...provider, name: currentProvider.name, enabled: currentProvider.enabled, isDefaultSaveTarget: currentProvider.isDefaultSaveTarget };
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
    await this.persist(state, key, envelope.kdf, false, activity);
    return publicProviderAccount(provider);
    });
  }

  async rotateOneDriveTokens(providerId: string, previous: OneDriveConnection, tokens: OneDriveTokens, signal?: AbortSignal): Promise<void> {
    const expected = parseOneDriveConnection(previous);
    if (!expected || !validOneDriveTokens(tokens)) throw new Error("OneDrive 登录凭据无效，请重新登录。");
    const replacement = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scope: tokens.scope };
    return this.runExclusive(async () => {
      signal?.throwIfAborted();
      const { state, envelope, key } = await this.mutableContext();
      const provider = state.providers.find(candidate => candidate.id === providerId);
      const current = parseOneDriveConnection(provider?.config.oneDriveConnection);
      if (provider?.kind !== "keepass" || !provider.enabled || provider.config.sourceMode !== "onedrive" || !current || !matchesBinding(current, oneDriveConnectionBinding(expected)) ||
        current.tokens.accessToken !== expected.tokens.accessToken || current.tokens.refreshToken !== expected.tokens.refreshToken ||
        current.tokens.expiresAt !== expected.tokens.expiresAt || current.tokens.scope !== expected.tokens.scope) {
        throw new Error("OneDrive 登录会话已变化，请重新同步。");
      }
      provider.config = { ...provider.config, oneDriveConnection: { ...current, tokens: replacement } };
      state.updatedAt = new Date(this.now()).toISOString();
      signal?.throwIfAborted();
      await this.persist(state, key, envelope.kdf, false, false);
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
    adoptRemoteRemovals = false,
    deferredMutationIds: string[] = [],
    guard: ProviderSyncGuard = {}
  ): Promise<{ conflicts: number }> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    const provider = state.providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error("密码源不存在。");
    if (guard.expectedAccount && !sameProviderBinding(guard.expectedAccount, provider)) throw new Error("同步期间密码源配置已变化，请重新同步。");
    if (readMdbx2RestoreJournal(state.mdbx2Restores).some(record => record.status === 'prepared' && record.provider.id === providerId)
      || readMdbx2RestoreBatchJournal(state.mdbx2RestoreBatches).some(record => record.status === 'prepared' && record.members[0].provider.id === providerId))
      throw new Error('此密码源还有待确认的恢复操作，请先重试恢复。');
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
      ? mergeProviderSyncItems(providerId, syncSnapshot, state.items, items, acknowledgementsByItemId, adoptRemoteRemovals, new Set(guard.confirmedRemovedItemIds || []))
      : { items, conflicts: [] as ProviderConflictInput[], locallyChangedIds: new Set<string>(), confirmedMutationIds: new Set<string>() };
    const persistedConflicts: ProviderConflict[] = [...conflicts, ...merge.conflicts].slice(0, 500).map((conflict) => ({
      ...structuredClone(conflict),
      id: crypto.randomUUID(),
      providerId,
      detectedAt
    }));
    const globalConflict = persistedConflicts.find((conflict) => conflict.itemId === providerId || !conflict.local && !conflict.remote);
    const previousById = new Map(state.items.map(item => [item.id, item]));
    const incomingById = new Map(items.map(item => [item.id, item]));
    state.items = merge.items.map(item => {
      if (item.kind !== "passkey") return item;
      const previous = previousById.get(item.id);
      const incoming = incomingById.get(item.id);
      const preserved = previous?.kind === "passkey" ? preservePasskeyCounterHistory(previous, item) : item;
      // History-only observations intentionally do not count as content edits,
      // but must survive even when the content merge keeps the local version.
      return incoming?.kind === "passkey" ? preservePasskeyCounterHistory(incoming, preserved) : preserved;
    });
    const deferredMutations = new Set(deferredMutationIds);
    const consumedAcknowledgements = new Set<string>();
    state.mutationQueue = state.mutationQueue.flatMap((mutation): PendingMutation[] => {
      if (mutation.providerId !== providerId) return [mutation];
      const conflict = globalConflict || persistedConflicts.find((candidate) => candidate.itemId === mutation.itemId);
      // A mutation made after the adapter took its snapshot was not acknowledged
      // by this sync, even if the remote response otherwise looks successful.
      if (conflict) return [{ ...mutation, lastError: conflict.reason }];
      if (deferredMutations.has(mutation.id)) return [mutation];
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
    await this.persist(state, key, envelope.kdf, false, false);
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
      await this.persist(state, key, envelope.kdf, false, false);
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
        const current = state.items.find(item => item.id === conflict.itemId) || conflict.local;
        let remote = conflict.remote ? structuredClone(conflict.remote) : undefined;
        if (current?.kind === "passkey" && remote?.kind === "passkey") {
          remote = preservePasskeyCounterHistory(current, { ...remote, id: current.id });
        }
        state.items = remote
          ? state.items.some((item) => item.id === conflict.itemId)
            ? state.items.map((item) => item.id === conflict.itemId ? remote! : item)
            : [remote, ...state.items]
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

  async upsertItem(item: VaultItem, allowLockedAutofill?: boolean, expectedUpdatedAt?: string): Promise<VaultItem> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    assertApiTokenDestination(item, state.providers);
    const existing = state.items.find((candidate) => candidate.id === item.id);
    if (item.kind === "opaque" || existing?.kind === "opaque") throw new Error("此原生类型或版本仅可读取，不能改写或转换为密码。");
    const now = new Date(Math.max(this.now(), (Date.parse(existing?.updatedAt || "") || 0) + 1)).toISOString();
    if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== "string" || !existing || existing.updatedAt !== expectedUpdatedAt)) {
      throw new Error("此项目已被其他设备或窗口修改。你的草稿仍然保留，请重新打开最新项目后再保存。");
    }
    let normalized: VaultItem = {
      ...item,
      createdAt: existing?.createdAt || item.createdAt || now,
      updatedAt: now,
      providerRefs: providerReferencesForEdit(item, existing, state)
    } as VaultItem;
    if (existing?.kind === "passkey" && normalized.kind === "passkey") normalized = preservePasskeyCounterHistory(existing, normalized);
    if (existing?.kind === 'login' && normalized.kind === 'login') normalized = capturePasswordHistory(existing, normalized, now);
    state.items = existing ? state.items.map((candidate) => (candidate.id === item.id ? normalized : candidate)) : [normalized, ...state.items];
    if (allowLockedAutofill !== undefined) this.updateLockedAutofillGrant(state, normalized.id, allowLockedAutofill);
    queueProviderMutations(state, normalized, existing ? "update" : "create", now);
    state.updatedAt = now;
    await this.persist(state, key, envelope.kdf, allowLockedAutofill === true);
    return normalized;
    });
  }

  /** Acknowledge actual copy/fill against current data; delayed replies cannot replace records. */
  async consumeHotp(usage: HotpUsage): Promise<boolean> {
    if (!usage || typeof usage.itemId !== 'string' || !usage.itemId || typeof usage.identity !== 'string'
      || !/^[a-f0-9]{64}$/.test(usage.identity) || usage.counter == null
      || usage.login && (typeof usage.login.itemId !== 'string' || typeof usage.login.binding !== 'string' || !/^[a-f0-9]{64}$/.test(usage.login.binding)))
      throw new Error('HOTP 使用记录无效。');
    const usedCounter = BigInt(normalizeOtpCounter(usage.counter));
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const fail = () => new Error('验证码来源或计数已变化，请重新打开项目核对。');
      const source = state.items.find(item => item.id === usage.itemId);
      if (!source || source.kind !== 'login' && source.kind !== 'totp' || source.deletedAt || source.archivedAt) throw fail();
      const current = await hotpUsageFromItem(source);
      if (!current || current.identity !== usage.identity) throw fail();
      if (usage.login) {
        const login = state.items.find(item => item.id === usage.login!.itemId);
        if (!login || login.kind !== 'login' || login.deletedAt || login.archivedAt
          || await otpSourceBinding(login) !== usage.login.binding
          || (findBoundTotpItem(login, state.items) || login).id !== source.id) throw fail();
      }
      const metadata = source.kind === 'login' && readProjectCredential(source.customFields);
      const project = source.kind === 'login' ? passwordGroupMembers(source, state.items) : [];
      const members = source.kind === 'login' && source.passwordGroupId && metadata
        ? project.filter(item => readProjectCredential(item.customFields)?.groupId === metadata.groupId) : [source];
      // Pending project operations retain exact snapshots, including other credential groups.
      const ids = new Set([source.id, ...project.map(item => item.id), ...(usage.login ? [usage.login.itemId] : [])]);
      assertNoMdbx2RestoreBatchOverlap(state, ids);
      if (readMdbx2RestoreJournal(state.mdbx2Restores).some(row => row.status === 'prepared' && ids.has(row.source.id))
        || readPasswordProjectRemovalJournal(state.passwordProjectRemovals).some(row => isPasswordProjectRemovalPending(row)
          && [...row.removed, ...row.retained].some(item => ids.has(item.id)))
        || readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row => row.status !== 'completed'
          && row.entries.some(entry => ids.has(entry.expected.id) || ids.has(entry.result.id)))
        || state.providerConflicts.some(row => ids.has(row.itemId))
        || state.mutationQueue.some(row => ids.has(row.itemId) && row.operation === 'delete')) throw fail();
      const signingIdentity = await hotpSigningIdentity(source);
      for (const member of members) {
        if (member.deletedAt || member.archivedAt || await hotpSigningIdentity(member) !== signingIdentity
          || BigInt(normalizeOtpCounter(parametersFromItem(member).counter)) !== BigInt(current.counter)) throw fail();
      }
      if (BigInt(current.counter) < usedCounter) throw fail();
      if (BigInt(current.counter) > usedCounter) return false; // Duplicate/delayed acknowledgement.
      const time = Math.max(this.now(), ...members.map(item => (Date.parse(item.updatedAt) || 0) + 1));
      const now = new Date(time).toISOString();
      const updates = members.map(item => {
        const updated = advanceHotpCounter(item, time)!;
        return { ...updated, providerRefs: providerReferencesForEdit(updated, item, state) };
      });
      const replacements = new Map(updates.map(item => [item.id, item]));
      state.items = state.items.map(item => replacements.get(item.id) || item);
      for (const item of updates) queueProviderMutations(state, item, 'update', now);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return true;
    });
  }

  /** Commit the complete explicit project, including singletons, in one encrypted write. */
  async savePasswordGroup(items: LoginItem[], expected: Record<string, string>, allowLockedAutofill?: boolean): Promise<LoginItem[]> {
    if (allowLockedAutofill !== undefined && typeof allowLockedAutofill !== "boolean") throw new Error("免解锁填写设置必须是布尔值。");
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const { saved, now } = preparePasswordGroupWrite(state, items, expected, this.now());
      commitPasswordGroupWrite(state, saved, now);
      if (allowLockedAutofill !== undefined) this.updateLockedAutofillGrant(state, saved[0].id, allowLockedAutofill);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf, allowLockedAutofill === true);
      return saved;
    });
  }

  /** Internal transaction entry point. Remote originals remain live until verified finalization. */
  async stagePasswordProjectRemoval(input: {
    operationId: string; items: LoginItem[]; expected: Record<string, string>; removedItemIds: string[]; allowLockedAutofill?: boolean;
  }): Promise<{ items: LoginItem[]; removal?: PasswordProjectRemovalRecord }> {
    if (!input || typeof input.operationId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.operationId))
      throw new Error('密码项目移除操作标识无效。');
    if (input.allowLockedAutofill !== undefined && typeof input.allowLockedAutofill !== 'boolean') throw new Error('免解锁填写设置必须是布尔值。');
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const journal = readPasswordProjectRemovalJournal(state.passwordProjectRemovals);
      const requestHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      const previous = journal.find(record => record.id === input.operationId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Error('移除操作标识已用于其他草稿，原密码尚未移除。');
        return { items: previous.retained, removal: previous };
      }
      const { saved, now } = preparePasswordGroupWrite(state, input.items, input.expected, this.now());
      const ids = new Set(saved.map(item => item.id));
      if (journal.some(record => isPasswordProjectRemovalPending(record) && [...record.retained, ...record.removed].some(item => ids.has(item.id))))
        throw new Error('此密码项目还有待完成的移除操作，请先重试该操作。');
      const restores = readMdbx2RestoreJournal(state.mdbx2Restores);
      assertNoMdbx2RestoreBatchOverlap(state, ids);
      if (restores.some(record => record.status === 'prepared' && ids.has(record.source.id)))
        throw new Error('此密码项目还有待完成的恢复操作，请先完成恢复。');
      const originals = state.items.filter((item): item is LoginItem => item.kind === 'login' && ids.has(item.id));
      const plan = planPasswordProjectRemoval(saved, originals, input.removedItemIds);
      commitPasswordGroupWrite(state, plan.retained, now);
      let removal: PasswordProjectRemovalRecord | undefined;
      if (plan.removed.length) {
        const providerBindings = plan.retained[0].providerRefs.map(ref => state.providers.find(provider => provider.id === ref.providerId)!);
        if (plan.removed.length > 50 && providerBindings.some(provider => provider.kind === 'mdbx2'))
          throw new Error('单次原生事务最多移除 50 条密码，请分次编辑。');
        const local = providerBindings.every(provider => provider.kind === 'local');
        removal = { version: 1, id: input.operationId, requestHash, createdAt: now, updatedAt: now,
          status: local ? 'completed' : 'preparing', retained: plan.retained, removed: plan.removed,
          cancellationItems: structuredClone(saved.filter(row => [...plan.retained, ...plan.removed].some(item => item.id === row.id))),
          providerBindings, ownerTransfer: plan.ownerTransfer, ...(local ? { proofs: [] } : {}) };
        if (local) tombstonePasswordProjectRows(state, plan.removed, now);
        const pending = journal.filter(isPasswordProjectRemovalPending);
        if (pending.length >= 80) throw new Error('待完成的密码项目移除操作过多，请先完成已有操作。');
        state.passwordProjectRemovals = [...retainPasswordProjectRemovalHistory(journal, restores), removal];
        readPasswordProjectRemovalJournal(state.passwordProjectRemovals);
      }
      if (input.allowLockedAutofill !== undefined) this.updateLockedAutofillGrant(state, plan.retained[0].id, input.allowLockedAutofill);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf, input.allowLockedAutofill === true);
      return { items: plan.retained, removal };
    });
  }

  /** Internal ceremony binding; never exposes the key or extends the session. */
  async passkeySessionId(): Promise<string | undefined> {
    return this.runExclusive(async () => {
      const session = await this.sessions.read();
      return session && session.expiresAt > this.now() ? session.id : undefined;
    });
  }

  async readPasswordProjectRemovals(): Promise<PasswordProjectRemovalRecord[]> {
    return readPasswordProjectRemovalJournal((await this.readState()).passwordProjectRemovals);
  }

  /** Only preparation can be cancelled: no native delete request can yet exist. */
  async cancelPasswordProjectRemovalPreparation(operationId: string): Promise<PasswordProjectRemovalRecord> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const journal = readPasswordProjectRemovalJournal(state.passwordProjectRemovals);
      const record = journal.find(row => row.id === operationId);
      if (!record) throw new Error('找不到密码项目移除操作。');
      if (record.status === 'cancelled') return structuredClone(record);
      if (record.status !== 'preparing' || record.nativeDeletion) throw new Error('删除请求已准备，必须先确认原操作结果，不能直接取消。');
      assertPasswordProjectRemovalBindings(state, record);
      const ids = new Set([...record.retained, ...record.removed].map(row => row.id));
      assertNoMdbx2RestoreBatchOverlap(state, ids);
      const current = state.items.filter((row): row is LoginItem => ids.has(row.id) && row.kind === 'login');
      if (state.providerConflicts.some(row => ids.has(row.itemId))
        || state.mutationQueue.some(row => ids.has(row.itemId) && row.operation === 'delete')
        || readMdbx2RestoreJournal(state.mdbx2Restores).some(row => row.status === 'prepared' && ids.has(row.source.id)))
        throw new Error('移除准备后项目又有变化，原始内容和恢复记录已保留。');
      const drafts = cancelPasswordProjectRemovalDraft(record, current);
      const { saved, now } = preparePasswordGroupWrite(state, drafts, Object.fromEntries(current.map(row => [row.id, row.updatedAt])), this.now());
      assertCancellationPreservesLaterEdits(record, current, saved);
      commitPasswordGroupWrite(state, saved, now);
      const cancelled: PasswordProjectRemovalRecord = { ...record, status: 'cancelled', updatedAt: now };
      state.passwordProjectRemovals = journal.map(row => row.id === record.id ? cancelled : row);
      state.updatedAt = now;
      readPasswordProjectRemovalJournal(state.passwordProjectRemovals);
      await this.persist(state, key, envelope.kdf);
      return structuredClone(cancelled);
    });
  }

  /** Reusable preflight before uploading attachments; finalization repeats it under the write lock. */
  async inspectPasswordProjectRemoval(operationId: string): Promise<{ record: PasswordProjectRemovalRecord; items: LoginItem[] }> {
    const state = await this.readState(false);
    const record = readPasswordProjectRemovalJournal(state.passwordProjectRemovals).find(candidate => candidate.id === operationId);
    if (!record) throw new Error('找不到密码项目移除操作。');
    if (record.status !== 'preparing') throw new Error('密码项目不在附件准备阶段。');
    return { record, items: assertPasswordProjectRemovalReady(state, record) };
  }

  /** Internal only: callers must read back and verify attachment copies before invoking this. */
  async finalizePasswordProjectRemoval(operationId: string, observed: LoginItem[], proofs: PasswordProjectRemovalProof[], nativeIntent?: PasswordProjectNativeDeletionIntent): Promise<PasswordProjectRemovalRecord> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const journal = readPasswordProjectRemovalJournal(state.passwordProjectRemovals);
      const record = journal.find(candidate => candidate.id === operationId);
      if (!record) throw new Error('找不到密码项目移除操作。');
      if (record.status !== 'preparing') return record;
      const members = assertPasswordProjectRemovalReady(state, record);
      const expected = [...record.retained, ...record.removed];
      const ids = new Set(expected.map(item => item.id));
      if (!Array.isArray(observed) || observed.length !== expected.length || new Set(observed.map(item => item.id)).size !== ids.size
        || observed.some(item => !ids.has(item.id))) throw new Error('密码项目校验快照不完整，原密码尚未移除。');
      for (const snapshot of expected) {
        const current = members.find(item => item.id === snapshot.id)!;
        const checked = observed.find(item => item.id === snapshot.id)!;
        if (passwordProjectRemovalContent(current) !== passwordProjectRemovalContent(checked)
          || current.updatedAt !== checked.updatedAt || JSON.stringify(current.providerRefs) !== JSON.stringify(checked.providerRefs))
          throw new Error('密码项目在移除校验期间已变化，原密码尚未移除。');
      }
      const now = new Date(Math.max(this.now(), ...members.map(item => (Date.parse(item.updatedAt) || 0) + 1))).toISOString();
      const next: PasswordProjectRemovalRecord = { ...record, status: 'deleting', updatedAt: now, proofs,
        retained: record.retained.map(row => members.find(item => item.id === row.id)!),
        removed: record.removed.map(row => members.find(item => item.id === row.id)!) };
      tombstonePasswordProjectRows(state, record.removed.map(item => members.find(current => current.id === item.id)!), now);
      if (nativeIntent) {
        const removedIds = new Set(next.removed.map(row => row.id));
        next.nativeDeletion = { intent: structuredClone(nativeIntent), deletedAt: now,
          pendingMutations: structuredClone(state.mutationQueue.filter(mutation => removedIds.has(mutation.itemId))) };
      }
      readPasswordProjectRemovalJournal([next]);
      if (nativeIntent) await assertPasswordProjectNativeDeletionScope(next);
      state.passwordProjectRemovals = journal.map(candidate => candidate.id === operationId ? next : candidate);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return next;
    });
  }

  /** Replace a stale, uncommitted request only after a new complete remote verification. */
  async replacePasswordProjectNativeDeletionIntent(operationId: string, expectedScope: string,
    prepare: (record: PasswordProjectRemovalRecord) => Promise<PasswordProjectNativeDeletionIntent>): Promise<PasswordProjectRemovalRecord> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const journal = readPasswordProjectRemovalJournal(state.passwordProjectRemovals);
      const record = journal.find(candidate => candidate.id === operationId);
      if (!record?.nativeDeletion || record.status !== 'deleting' || record.nativeDeletion.intent.operationScope !== expectedScope)
        throw new Error('密码项目删除请求已变化，请重新读取恢复记录。');
      assertPasswordProjectNativeDeletionReady(state, record);
      await assertPasswordProjectNativeDeletionScope(record);
      // Callback receives detached data and must not re-enter the service lock.
      const intent = await prepare(structuredClone(record));
      if (intent.providerId !== record.nativeDeletion.intent.providerId || intent.vaultHandle !== record.nativeDeletion.intent.vaultHandle
        || intent.writeRevision.vaultId !== record.nativeDeletion.intent.writeRevision.vaultId
        || intent.writeRevision.revisionSha256 === record.nativeDeletion.intent.writeRevision.revisionSha256)
        throw new Error('密码项目删除重试缺少新的数据库校验。');
      const next = { ...record, updatedAt: new Date(this.now()).toISOString(), nativeDeletion: { ...record.nativeDeletion, intent } };
      readPasswordProjectRemovalJournal([next]); await assertPasswordProjectNativeDeletionScope(next);
      state.passwordProjectRemovals = journal.map(candidate => candidate.id === operationId ? next : candidate);
      await this.persist(state, key, envelope.kdf);
      return structuredClone(next);
    });
  }

  /** Local edits cannot interleave between the final check and the native transaction.
   * The request already exists on disk. A failed local save leaves it recoverable.
   */
  async applyPasswordProjectNativeDeletion(operationId: string, expectedScope: string,
    execute: (record: PasswordProjectRemovalRecord) => Promise<Mdbx2ObjectBatchResult>): Promise<PasswordProjectRemovalRecord> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const journal = readPasswordProjectRemovalJournal(state.passwordProjectRemovals);
      const record = journal.find(candidate => candidate.id === operationId);
      if (!record?.nativeDeletion || record.nativeDeletion.intent.operationScope !== expectedScope)
        throw new Error('密码项目删除请求已变化，请重新读取恢复记录。');
      await assertPasswordProjectNativeDeletionScope(record);
      if (record.status === 'completed') return record;
      assertPasswordProjectNativeDeletionReady(state, record);
      const result = await execute(structuredClone(record));
      const mutations = record.nativeDeletion.intent.mutations;
      if (!result.operationId || !result.commitId || result.items.length !== mutations.length
        || result.items.some((item, index) => item.kind !== 'delete' || item.logicalObjectId !== mutations[index].logicalObjectId
          || `native:${item.objectId}` !== item.logicalObjectId)) throw new Error('密码项目删除回执与保存的请求不一致。');
      const next: PasswordProjectRemovalRecord = { ...record, status: 'completed', updatedAt: new Date(this.now()).toISOString(),
        nativeDeletion: { ...record.nativeDeletion, receipt: { operationId: result.operationId, commitId: result.commitId } } };
      const pendingIds = new Set(record.nativeDeletion.pendingMutations.map(mutation => mutation.id));
      state.mutationQueue = state.mutationQueue.filter(mutation => !pendingIds.has(mutation.id));
      const removedIds = new Set(record.removed.map(row => row.id));
      state.items = state.items.map(row => removedIds.has(row.id) ? { ...row, providerRefs: row.providerRefs.map(ref =>
        ref.providerId === record.nativeDeletion!.intent.providerId ? { ...ref, revision: result.commitId! } : ref) } : row);
      state.passwordProjectRemovals = journal.map(candidate => candidate.id === operationId ? next : candidate);
      readPasswordProjectRemovalJournal([next]);
      state.updatedAt = next.updatedAt;
      await this.persist(state, key, envelope.kdf);
      return structuredClone(next);
    });
  }

  /** Only replay a proven commit here; later local edits never authorize a new delete. */
  async acknowledgeCommittedPasswordProjectDeletion(operationId: string, expectedScope: string,
    confirm: (record: PasswordProjectRemovalRecord, restores: NonNullable<Mdbx2RestoreRecord['reapply']>[])
      => Promise<{ result: Mdbx2ObjectBatchResult; restores: Mdbx2RestoreRecord[] }>): Promise<PasswordProjectRemovalRecord> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const journal = readPasswordProjectRemovalJournal(state.passwordProjectRemovals);
      const record = journal.find(row => row.id === operationId);
      if (!record?.nativeDeletion || record.nativeDeletion.intent.operationScope !== expectedScope)
        throw new Error('密码项目删除请求已变化，请重新读取恢复记录。');
      await assertPasswordProjectNativeDeletionScope(record);
      if (record.status === 'completed') return structuredClone(record);
      assertPasswordProjectRemovalBindings(state, record);
      const native = record.nativeDeletion, providerId = native.intent.providerId;
      // Queue IDs are reused by later edits. Consume only the exact saved delete,
      // never an update or a newer deletion which happens to reuse its ID.
      const remainingQueue = state.mutationQueue.filter(row => !native.pendingMutations.some(saved => {
        if (!sameRemovalMutation(row, saved)) return false;
        const current = state.items.find(item => item.id === saved.itemId), original = record.removed.find(item => item.id === saved.itemId)!;
        return Boolean(current?.deletedAt === native.deletedAt && current.updatedAt === native.deletedAt
          && sameRemovalObject(current, original, providerId));
      }));
      const reapply = record.removed.flatMap(original => {
        const current = state.items.find(row => row.id === original.id);
        return current?.kind === 'login' && !current.deletedAt && sameRemovalObject(current, original, providerId)
          ? [{ deletionOperationId: record.id, item: current, pendingMutations: remainingQueue.filter(row => row.itemId === current.id) }] : [];
      });
      const verified = await confirm(structuredClone(record), structuredClone(reapply));
      const result = verified.result, mutations = native.intent.mutations;
      if (!result.alreadyCommitted || !result.operationId || !result.commitId || result.items.length !== mutations.length
        || result.items.some((row, index) => row.kind !== 'delete' || row.logicalObjectId !== mutations[index].logicalObjectId
          || `native:${row.objectId}` !== row.logicalObjectId)) throw new Error('缺少与原请求一致的已提交删除回执。');
      const restores = readMdbx2RestoreJournal(verified.restores);
      if (restores.length !== reapply.length) throw new Error('后续本地恢复请求不完整。');
      for (const desired of reapply) {
        const original = record.removed.find(row => row.id === desired.item.id)!;
        const restore = restores.find(row => row.source.id === desired.item.id);
        const source = { ...original, deletedAt: native.deletedAt, updatedAt: native.deletedAt,
          providerRefs: original.providerRefs.map(ref => ref.providerId === providerId ? { ...ref, revision: result.commitId } : ref) };
        if (!restore || restore.status !== 'prepared' || JSON.stringify(restore.source) !== JSON.stringify(source)
          || JSON.stringify(restore.reapply) !== JSON.stringify(desired)
          || JSON.stringify(restore.provider) !== JSON.stringify(record.providerBindings.find(row => row.id === providerId))
          || restore.intent.objectTypeId !== 'login' || restore.intent.writeRevision.vaultId !== native.intent.writeRevision.vaultId)
          throw new Error('后续本地恢复请求与当前编辑不一致。');
        await assertMdbx2RestoreScope(restore);
      }
      const priorRestores = readMdbx2RestoreJournal(state.mdbx2Restores);
      const pendingRestores = priorRestores.filter(row => row.status === 'prepared');
      if (pendingRestores.length + restores.length > 80) throw new Error('待完成的原生恢复操作过多。');
      const next: PasswordProjectRemovalRecord = { ...record, status: 'completed', updatedAt: new Date(this.now()).toISOString(),
        nativeDeletion: { ...native, receipt: { operationId: result.operationId, commitId: result.commitId } } };
      state.passwordProjectRemovals = journal.map(row => row.id === record.id ? next : row);
      state.mdbx2Restores = readMdbx2RestoreJournal([...pendingRestores, ...priorRestores.filter(row => row.status === 'completed').slice(-19), ...restores]);
      state.mutationQueue = remainingQueue;
      state.items = state.items.map(current => {
        const original = record.removed.find(row => row.id === current.id);
        if (!original || !current.deletedAt || !sameRemovalObject(current, original, providerId)) return current;
        const ref = current.providerRefs.find(row => row.providerId === providerId)!;
        if (ref.revision !== original.providerRefs.find(row => row.providerId === providerId)!.revision) return current;
        return { ...current, providerRefs: current.providerRefs.map(row => row.providerId === providerId ? { ...row, revision: result.commitId } : row) };
      });
      readPasswordProjectRemovalJournal([next]);
      state.updatedAt = next.updatedAt;
      await this.persist(state, key, envelope.kdf);
      return structuredClone(next);
    });
  }

  /** Completion follows acknowledged provider deletion; a failed delete remains retryable. */
  async completePasswordProjectRemoval(operationId: string): Promise<PasswordProjectRemovalRecord> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const journal = readPasswordProjectRemovalJournal(state.passwordProjectRemovals);
      const record = journal.find(candidate => candidate.id === operationId);
      if (!record) throw new Error('找不到密码项目移除操作。');
      if (record.status === 'completed') return record;
      if (record.status !== 'deleting') throw new Error('密码项目尚未完成移除校验。');
      if (record.nativeDeletion) throw new Error('密码项目原生删除必须确认已保存请求的提交回执。');
      assertPasswordProjectRemovalBindings(state, record);
      const ids = new Set(record.removed.map(item => item.id));
      if (state.items.some(item => ids.has(item.id) && !item.deletedAt)
        || state.mutationQueue.some(mutation => ids.has(mutation.itemId)) || state.providerConflicts.some(conflict => ids.has(conflict.itemId)))
        throw new Error('部分密码尚未完成远端移除，请重试同步。');
      const next: PasswordProjectRemovalRecord = { ...record, status: 'completed', updatedAt: new Date(this.now()).toISOString() };
      state.passwordProjectRemovals = journal.map(candidate => candidate.id === operationId ? next : candidate);
      await this.persist(state, key, envelope.kdf);
      return next;
    });
  }

  async recordPasskeyUse(itemId: string, usedAt: string, expected?: PasskeyItem): Promise<PasskeyItem> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const item = state.items.find((candidate): candidate is PasskeyItem => candidate.id === itemId && candidate.kind === "passkey" && !candidate.deletedAt);
      if (!item || item.archivedAt) throw new Error("Passkey 不存在或已被删除。");
      if (expected && (!samePasskeySigningIdentity(expected, item) || expected.signCount !== item.signCount)) {
        throw new Error("登录期间 Passkey 已变化，请重新发起登录。");
      }
      if (expected) {
        assertPasskeyCounterNotRegressed(item);
        assertPasskeyCounterNotRegressed(item, expected);
      }
      // Usage is separate from counter commits performed before signing.
      // Changing updatedAt here would make every login look like a remote database edit.
      const updated: PasskeyItem = { ...item, lastUsedAt: usedAt, useCount: (item.useCount || 0) + 1 };
      state.items = state.items.map((candidate) => candidate.id === itemId ? updated : candidate);
      state.updatedAt = usedAt;
      await this.persist(state, key, envelope.kdf);
      return updated;
    });
  }

  /** Internal compare-and-set; never exposed as a runtime command. */
  async advanceLocalPasskeyCounter(expected: PasskeyItem): Promise<PasskeyItem> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const item = state.items.find((candidate): candidate is PasskeyItem => candidate.id === expected.id && candidate.kind === "passkey");
      if (!item || item.deletedAt || item.archivedAt || !samePasskeySigningIdentity(expected, item) || expected.signCount !== item.signCount || expected.updatedAt !== item.updatedAt) {
        throw new Error("登录期间 Passkey 已变化，请重新发起登录。");
      }
      if (resolvePasskeyOwnership(item, state.providers).kind !== "local") {
        throw new Error("此 Passkey 需要先确认密码源的签名计数。");
      }
      assertPasskeyCounterNotRegressed(item);
      assertPasskeyCounterNotRegressed(item, expected);
      const signCount = nextPasskeyCounter(item.signCount);
      if (!signCount) return item;
      const now = new Date(Math.max(this.now(), (Date.parse(item.updatedAt) || 0) + 1)).toISOString();
      const updated = { ...item, signCount, signCountHighWaterMark: signCount, updatedAt: now };
      state.items = state.items.map(candidate => candidate.id === item.id ? updated : candidate);
      state.updatedAt = now;
      // Persist before signing. Cancellation may skip a number, never reuse one.
      await this.persist(state, key, envelope.kdf);
      return updated;
    });
  }

  /** Internal compare-and-set; never exposed as a runtime command. */
  async advanceFilePasskeyCounter(expected: PasskeyItem, expectedAccount: ProviderAccount): Promise<PasskeyItem> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const item = state.items.find((candidate): candidate is PasskeyItem => candidate.id === expected.id && candidate.kind === "passkey");
      if (!item || item.deletedAt || item.archivedAt || !samePasskeySigningIdentity(expected, item) || expected.signCount !== item.signCount || expected.updatedAt !== item.updatedAt) {
        throw new Error("登录期间 Passkey 已变化，请重新发起登录。");
      }
      const ownership = resolvePasskeyOwnership(item, state.providers);
      if ((ownership.kind !== "database" && ownership.kind !== "snapshot") || !ownership.account.enabled || !ownership.reference.remoteId
        || !sameProviderBinding(expectedAccount, ownership.account) || ownership.account.kind === "mdbx-legacy") {
        throw new Error("Passkey 密码源尚未完成同步或已变化。");
      }
      if (state.mutationQueue.some(mutation => mutation.providerId === ownership.account.id && mutation.itemId === item.id)) {
        throw new Error("此 Passkey 仍有未完成的同步。");
      }
      assertPasskeyCounterNotRegressed(item);
      assertPasskeyCounterNotRegressed(item, expected);
      const signCount = nextPasskeyCounter(item.signCount);
      if (!signCount) return item;
      const now = new Date(Math.max(this.now(), (Date.parse(item.updatedAt) || 0) + 1)).toISOString();
      const updated = { ...item, signCountHighWaterMark: Math.max(passkeyCounterHighWaterMark(item), item.signCount), signCount, updatedAt: now };
      state.items = state.items.map(candidate => candidate.id === item.id ? updated : candidate);
      queueProviderMutation(state, updated, ownership.account.id, "update", now);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return updated;
    });
  }

  /** Internal compare-and-set; never exposed as a runtime command. */
  async advanceBitwardenPasskeyCounter(expected: PasskeyItem): Promise<PasskeyItem> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const item = state.items.find((candidate): candidate is PasskeyItem => candidate.id === expected.id && candidate.kind === "passkey");
      if (!item || item.deletedAt || item.archivedAt || !samePasskeySigningIdentity(expected, item) || expected.signCount !== item.signCount || expected.updatedAt !== item.updatedAt) {
        throw new Error("登录期间 Passkey 已变化，请重新发起登录。");
      }
      const ownership = resolvePasskeyOwnership(item, state.providers);
      if (ownership.kind !== "bitwarden" || !ownership.account.enabled || !ownership.reference.remoteId || !ownership.reference.revision) {
        throw new Error("Bitwarden Passkey 尚未完成同步。");
      }
      assertPasskeyCounterNotRegressed(item);
      const signCount = nextBitwardenPasskeyCounter(item.signCount);
      if (!signCount) return item;
      const now = new Date(Math.max(this.now(), (Date.parse(item.updatedAt) || 0) + 1)).toISOString();
      const updated = { ...item, signCountHighWaterMark: Math.max(passkeyCounterHighWaterMark(item), item.signCount), signCount, updatedAt: now };
      state.items = state.items.map(candidate => candidate.id === item.id ? updated : candidate);
      queueProviderMutation(state, updated, ownership.account.id, "update", now);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return updated;
    });
  }

  async importItems(items: VaultItem[]): Promise<VaultItem[]> {
    return this.runExclusive(async () => {
      const imported = validateImportedItems(items);
      const { state, envelope, key } = await this.mutableContext();
      const providerIds = new Set(state.providers.map((provider) => provider.id));
      for (const item of imported) assertApiTokenDestination(item, state.providers);
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
        if (existing?.kind === "opaque" || item.kind === "opaque" && item.providerRefs.length) throw new Error("只读项目不能通过导入改写或上传。");
        let normalized = {
          ...item,
          createdAt: existing?.createdAt || item.createdAt || now,
          updatedAt: now,
          providerRefs: item.providerRefs || []
        } as VaultItem;
        if (existing?.kind === "passkey" && normalized.kind === "passkey") normalized = preservePasskeyCounterHistory(existing, normalized);
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
  async readMdbx2MoveFinalizations(operationId?: string): Promise<Mdbx2MoveFinalizationRecord[]> {
    const state = await this.readState();
    return readMdbx2MoveJournal(state.mdbx2MoveFinalizations).filter(record => !operationId || record.operationId === operationId);
  }

  /** Persist before native write or source deletion. Caller must verify both Native vault IDs. */
  async stageMdbx2MoveFinalization(input: Mdbx2MoveFinalizationRecord): Promise<void> {
    const [record] = readMdbx2MoveJournal([input]);
    if (record.status === "completed") throw new Error("移动恢复记录无效，已保留原始数据。");
    await this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const records = readMdbx2MoveJournal(state.mdbx2MoveFinalizations);
      const existing = records.find(item => item.id === record.id);
      if (existing) {
        if (JSON.stringify({ ...existing, status: record.status }) !== JSON.stringify(record)
          || existing.status === "writing" && record.status !== "writing"
          || existing.status !== "writing" && record.status === "writing") throw new Error("移动操作与已保存的恢复记录不一致。");
        return;
      }
      for (const entry of record.entries) {
        const current = state.items.find(item => item.id === entry.expected.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(entry.expected)) throw new Error(`项目「${entry.expected.title || entry.expected.id}」在传输期间发生变化，请重新读取后重试。`);
      }
      const sourceIds = new Set(record.entries.map(entry => entry.expected.id));
      if (records.some(item => item.status !== "completed" && item.entries.some(entry => sourceIds.has(entry.expected.id)))) {
        throw new Error("请先恢复未完成的移动操作。");
      }
      // Retain every unfinished operation; only completed receipts may age out.
      const pending = records.filter(item => item.status !== "completed");
      if (pending.length >= 100) throw new Error("请先恢复未完成的移动操作。");
      const completedSlots = 99 - pending.length;
      const completed = completedSlots ? records.filter(item => item.status === "completed").slice(-completedSlots) : [];
      state.mdbx2MoveFinalizations = [...pending, ...completed, record];
      await this.persist(state, key, envelope.kdf);
    });
  }

  /** Atomically promote a saved write intent after native receipt and attachment verification. */
  async prepareMdbx2MoveFinalization(input: Mdbx2MoveFinalizationRecord): Promise<void> {
    const [record] = readMdbx2MoveJournal([input]);
    if (record.status !== "prepared" || !record.writeIntent || !record.attachments) throw new Error("移动恢复记录无效，已保留原始数据。");
    await this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const records = readMdbx2MoveJournal(state.mdbx2MoveFinalizations);
      const existing = records.find(item => item.id === record.id);
      // Only the committed results and verified attachment proofs may change phases.
      const identity = (value: Mdbx2MoveFinalizationRecord) => JSON.stringify({ ...value, status: undefined,
        attachments: undefined, entries: value.entries.map(entry => ({ expected: entry.expected, action: entry.action })) });
      if (!existing || identity(existing) !== identity(record)) throw new Error("移动操作与已保存的恢复记录不一致。");
      if (existing.status !== "writing") {
        if (JSON.stringify({ ...existing, status: "prepared" }) !== JSON.stringify(record)) throw new Error("移动操作与已保存的恢复记录不一致。");
        return;
      }
      for (const entry of record.entries) {
        const current = state.items.find(item => item.id === entry.expected.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(entry.expected)) throw new Error(`项目「${entry.expected.title || entry.expected.id}」在传输期间发生变化，请重新读取后重试。`);
      }
      state.mdbx2MoveFinalizations = records.map(item => item.id === record.id ? record : item);
      await this.persist(state, key, envelope.kdf);
    });
  }

  async applyCompletedMdbx2Transfer(
    entries: CompletedMdbx2TransferEntry[],
    targetProviderId?: string,
    deleteSources?: (pendingMoves: readonly CompletedMdbx2TransferEntry[], providers: readonly ProviderAccount[]) => Promise<void>,
    finalizationId?: string
  ): Promise<VaultItem[]> {
    return this.runExclusive(async () => {
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 200) throw new Error("MDBX2 批量传输结果数量无效。");
      const { state, envelope, key } = await this.mutableContext();
      const journal = finalizationId ? readMdbx2MoveJournal(state.mdbx2MoveFinalizations) : undefined;
      const finalization = journal?.find(record => record.id === finalizationId);
      if (finalizationId && (!finalization || finalization.status === "writing" || finalization.targetProviderId !== targetProviderId || JSON.stringify(finalization.entries) !== JSON.stringify(entries))) {
        throw new Error("移动操作与已保存的恢复记录不一致。");
      }
      const currentById = new Map(state.items.map((item) => [item.id, item]));
      const resultIds = new Set<string>();
      const sourceIds = new Set<string>();
      const pendingMoves: CompletedMdbx2TransferEntry[] = [];
      const pendingEntries: CompletedMdbx2TransferEntry[] = [];
      const existingById = new Map(state.items.map((item) => [item.id, item]));
      for (const entry of entries) {
        if (!entry || !entry.expected || !entry.result || (entry.action !== "copy" && entry.action !== "move")) throw new Error("MDBX2 批量传输结果格式无效。");
        if (sourceIds.has(entry.expected.id)) throw new Error("MDBX2 批量传输结果包含重复项目 ID。");
        sourceIds.add(entry.expected.id);
        const current = currentById.get(entry.expected.id);
        const sameMoveIdentity = entry.action === "move" && entry.result.id === entry.expected.id;
        const existingResult = sameMoveIdentity ? undefined : existingById.get(entry.result.id);
        if (existingResult && JSON.stringify(existingResult) !== JSON.stringify(entry.result)) throw new Error(`目标项目「${entry.result.title || entry.result.id}」已存在不同内容。`);
        if (sameMoveIdentity && current && JSON.stringify(current) === JSON.stringify(entry.result)) {
          // A response-loss retry has already adopted this move.
        } else if (!existingResult && (!current || JSON.stringify(current) !== JSON.stringify(entry.expected))) {
          throw new Error(`项目「${entry.expected.title || entry.expected.id}」在传输期间发生变化，请重新读取后重试。`);
        }
        if (!existingResult && !(sameMoveIdentity && current && JSON.stringify(current) === JSON.stringify(entry.result))) {
          const historyIssue = mdbx2PasswordHistoryTransferBlockReason(entry.expected, entry.action, targetProviderId);
          if (historyIssue) throw new Error(historyIssue);
          if (entry.expected.kind === 'login' && entry.expected.passwordHistory?.length) {
            const source = entry.expected.providerRefs[0];
            const target = entry.result.providerRefs.find(reference => reference.providerId === targetProviderId);
            if (!sameMoveIdentity || source?.remoteId !== target?.remoteId || entry.result.kind !== 'login'
              || JSON.stringify(entry.expected.passwordHistory) !== JSON.stringify(entry.result.passwordHistory)
              || entry.expected.passwordHistoryIncomplete !== entry.result.passwordHistoryIncomplete) {
              throw new Error('MDBX2 分类移动未保留原生项目身份或密码历史，来源项目已保留。');
            }
          }
          pendingEntries.push(entry);
          if (entry.action === "move") pendingMoves.push(entry);
        }
        if (resultIds.has(entry.result.id)) throw new Error("MDBX2 批量传输结果包含重复项目 ID。");
        resultIds.add(entry.result.id);
        if (entry.action === "copy" && entry.result.id === entry.expected.id && !existingResult) throw new Error("MDBX2 复制结果不能复用来源项目 ID。");
        const targetReference = entry.result.providerRefs.find((reference) => targetProviderId ? reference.providerId === targetProviderId && Boolean(reference.remoteId) : Boolean(reference.remoteId));
        if (!targetReference) throw new Error("MDBX2 批量传输结果缺少已提交的远端 Object 标识。");
      }
      // Validate every member before an external deletion can begin. The callback must
      // commit the source group atomically and support operation-ID recovery on retry.
      if (!pendingEntries.length && (!finalization || finalization.status === "completed")) return entries.map(entry => structuredClone(entry.result));
      // Supply a detached snapshot from this lock; callbacks must not re-enter service reads.
      if (pendingMoves.length && deleteSources) await deleteSources(pendingMoves, structuredClone(state.providers));
      const replaceById = new Map(pendingEntries.filter((entry) => entry.action === "move").map((entry) => [entry.expected.id, entry.result]));
      const copies = pendingEntries.filter((entry) => entry.action === "copy").map((entry) => entry.result);
      state.items = [
        ...copies.slice().reverse(),
        ...state.items.map((item) => replaceById.get(item.id) || item)
      ];
      const affectedIds = new Set(pendingEntries.flatMap((entry) => entry.action === "move" ? [entry.expected.id, entry.result.id] : [entry.result.id]));
      state.mutationQueue = state.mutationQueue.filter((mutation) => !affectedIds.has(mutation.itemId));
      state.providerConflicts = state.providerConflicts.filter((conflict) => !affectedIds.has(conflict.itemId));
      state.updatedAt = new Date(this.now()).toISOString();
      if (finalization) {
        finalization.status = "completed";
        state.mdbx2MoveFinalizations = journal;
      }
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
    deleteSource?: (providers: readonly ProviderAccount[]) => Promise<void>
  ): Promise<VaultItem> {
    const results = await this.applyCompletedMdbx2Transfer([entry], targetProviderId,
      deleteSource ? async (_pending, providers) => deleteSource(providers) : undefined);
    return results[0];
  }

  async readMdbx2Restores(): Promise<Mdbx2RestoreRecord[]> {
    return readMdbx2RestoreJournal((await this.readState()).mdbx2Restores);
  }

  async readMdbx2RestoreBatches(): Promise<Mdbx2RestoreBatchRecord[]> {
    return readMdbx2RestoreBatchJournal((await this.readState()).mdbx2RestoreBatches);
  }

  async readMdbx2DeletionCancellations(): Promise<Mdbx2DeletionCancellation[]> {
    return readMdbx2DeletionCancellations((await this.readState()).mdbx2DeletionCancellations);
  }

  async replayMdbx2DeletionCancellation(operationId: string, expected?: Mdbx2RestoreBatchRequest): Promise<VaultItem[] | undefined> {
    return replayMdbx2DeletionCancellation(await this.readState(), operationId, expected);
  }

  async cancelPendingMdbx2ProjectDeletion(input: Mdbx2RestoreBatchRequest, expected: LoginItem[], account: ProviderAccount,
    verifyStillActive: () => Promise<void>): Promise<VaultItem[]> {
    const request = readMdbx2RestoreBatchRequest(input);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const replay = replayMdbx2DeletionCancellation(state, request.operationId, request);
      if (replay) return replay;
      const fail = () => new Error('删除结果或项目成员已变化，请先同步后再恢复。');
      const ids = new Set(Object.keys(request.expected));
      const provider = state.providers.find(row => row.id === request.providerId);
      const sources = state.items.filter((row): row is LoginItem => row.kind === 'login' && ids.has(row.id));
      const first = sources.find(row => row.id === request.anchorItemId);
      if (!first?.passwordGroupId || sources.length !== ids.size || expected.length !== ids.size
        || new Set(expected.map(row=>row.id)).size !== ids.size || account.kind !== 'mdbx2' || !provider?.enabled
        || account.id !== request.providerId || !sameProviderBinding(provider, account)
        || provider.config.nativeVaultId !== account.config.nativeVaultId
        || sources.some(row => row.deletedAt !== request.deletedAt || row.updatedAt !== request.expected[row.id]
          || JSON.stringify(row) !== JSON.stringify(expected.find(item=>item.id===row.id))
          || passwordGroupKey(row) !== passwordGroupKey(first) || row.providerRefs.length !== 1 || row.providerRefs[0].providerId !== provider.id)
        || state.items.some(row => row.kind === 'login' && passwordGroupKey(row) === passwordGroupKey(first)
          && (!row.deletedAt || row.deletedAt === request.deletedAt) && !ids.has(row.id))) throw fail();
      const batches = readMdbx2RestoreBatchJournal(state.mdbx2RestoreBatches);
      if (batches.some(row => row.id === request.operationId)) throw fail();
      if (batches.some(row=>row.status==='prepared' && passwordGroupKey(row.members[0].source as LoginItem)===passwordGroupKey(first))) throw fail();
      assertNoMdbx2RestoreBatchOverlap(state, ids);
      if (readMdbx2RestoreJournal(state.mdbx2Restores).some(row=>row.status==='prepared' && ids.has(row.source.id))
        || readPasswordProjectRemovalJournal(state.passwordProjectRemovals).some(row=>isPasswordProjectRemovalPending(row)
          && [...row.removed,...row.retained].some(item=>ids.has(item.id)))
        || readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row=>row.status!=='completed'
          && row.entries.some(entry=>ids.has(entry.expected.id)))
        || state.providerConflicts.some(row=>ids.has(row.itemId))) throw fail();
      const mutations=state.mutationQueue.filter(row=>ids.has(row.itemId));
      const remoteIds=sources.map(row=>row.providerRefs[0].remoteId).filter(Boolean);
      if(new Set(remoteIds).size!==remoteIds.length) throw fail();
      for(const source of sources) {
        const own=mutations.filter(row=>row.itemId===source.id), ref=source.providerRefs[0];
        if(own.length>1 || ref.remoteId && own.length!==1 || own.some(row=>row.providerId!==provider.id || row.operation!=='delete')) throw fail();
      }
      if(state.providerMutationReceipts.some(receipt=>ids.has(receipt.itemId)
        && (receipt.stage!=='prepared' || receipt.operation!=='delete' || !mutations.some(row=>row.id===receipt.mutationId)))) throw fail();
      // This callback reads only Native state. It must never reenter this service lock.
      await verifyStillActive();
      const now=new Date(Math.max(this.now(),...sources.map(row=>Date.parse(row.updatedAt)+1))).toISOString();
      const restored=sources.map(row=>({...row,deletedAt:undefined,updatedAt:now}));
      const byId=new Map(restored.map(row=>[row.id,row]));
      state.items=state.items.map(row=>byId.get(row.id)||row);
      state.mutationQueue=state.mutationQueue.filter(row=>!mutations.some(removed=>removed.id===row.id));
      state.providerMutationReceipts=state.providerMutationReceipts.filter(row=>!mutations.some(removed=>removed.id===row.mutationId));
      for(const row of restored) {
        const ref=row.providerRefs[0];
        if(!ref.remoteId) queueProviderMutation(state,row,provider.id,'create',now);
        else if(!ref.etag || ref.etag!==mdbx2ItemFingerprint(row)) queueProviderMutation(state,row,provider.id,'update',now);
      }
      state.mdbx2DeletionCancellations=[...readMdbx2DeletionCancellations(state.mdbx2DeletionCancellations).slice(-99),
        {version:1,request,title:first.title,completedAt:now}];
      state.updatedAt=now;
      // No preparation journal is needed: all state changes and the receipt share one save.
      await this.persist(state,key,envelope.kdf);
      return structuredClone(restored);
    });
  }

  async stageMdbx2RestoreBatch(input: Mdbx2RestoreBatchRecord, previousScope?: string): Promise<Mdbx2RestoreBatchRecord> {
    const [record] = readMdbx2RestoreBatchJournal([input]);
    if (record.status !== 'prepared') throw new Error('只能准备未提交的整组恢复请求。');
    await assertMdbx2RestoreBatchScope(record);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const records = readMdbx2RestoreBatchJournal(state.mdbx2RestoreBatches), old = records.find(row => row.id === record.id);
      if (readMdbx2DeletionCancellations(state.mdbx2DeletionCancellations).some(row=>row.request.operationId===record.id)) throw new Error('此恢复操作标识已用于撤销删除。');
      if (old && JSON.stringify(old) === JSON.stringify(record)) return structuredClone(old);
      // Refresh only the vault revision; member identities and complete snapshots stay immutable.
      const stable = (row: Mdbx2RestoreBatchRecord) => row.members.map(member => ({ ...member,
        intent: { ...member.intent, operationScope: '', writeRevision: { ...member.intent.writeRevision, revisionSha256: '' } } }));
      if (old && (old.status !== 'prepared' || old.operationScope !== previousScope || JSON.stringify(stable(old)) !== JSON.stringify(stable(record))
        || JSON.stringify(old.cancellation) !== JSON.stringify(record.cancellation)
        || JSON.stringify(old.request) !== JSON.stringify(record.request)))
        throw new Error('MDBX 整组恢复请求已变化。');
      if (!old && record.cancellation) {
        const { sources, pendingDeletions } = record.cancellation, ids = new Set(sources.map(row => row.id));
        const queue = state.mutationQueue.filter(row => ids.has(row.itemId));
        const nativeIds = new Set(record.members.map(row => row.source.id));
        if (sources.some(source => JSON.stringify(state.items.find(row => row.id === source.id)) !== JSON.stringify(source)
          || source.providerRefs[0].remoteId && !nativeIds.has(source.id) && !pendingDeletions.some(row => row.itemId === source.id))
          || queue.length !== pendingDeletions.length || queue.some(row => JSON.stringify(row) !== JSON.stringify(pendingDeletions.find(saved => saved.id === row.id)))
          || pendingDeletions.some(row => row.attempts > 0 && !nativeIds.has(row.itemId))
          || state.providerMutationReceipts.some(row => ids.has(row.itemId) && (row.stage !== 'prepared' || row.operation !== 'delete'
            || !pendingDeletions.some(saved => saved.id === row.mutationId && saved.itemId === row.itemId && saved.providerId === row.providerId))))
          throw new Error('项目的删除结果尚未确认，请先同步后再恢复。');
        const mutations = new Set(pendingDeletions.map(row => row.id));
        state.mutationQueue = state.mutationQueue.filter(row => !mutations.has(row.id));
        state.providerMutationReceipts = state.providerMutationReceipts.filter(row => !mutations.has(row.mutationId));
      }
      assertMdbx2RestoreBatchReady(state, record);
      const pending = records.filter(row => row.status === 'prepared' && row.id !== record.id);
      if (pending.length >= 80) throw new Error('待完成的整组恢复过多，请先完成已有操作。');
      state.mdbx2RestoreBatches = [...pending, ...records.filter(row => row.status === 'completed').slice(-19), record];
      readMdbx2RestoreBatchJournal(state.mdbx2RestoreBatches);
      await this.persist(state, key, envelope.kdf);
      return structuredClone(record);
    });
  }

  async applyMdbx2RestoreBatch(operationId: string, expectedScope: string,
    restore: (record: Mdbx2RestoreBatchRecord) => Promise<Mdbx2ObjectsRestoreResult>): Promise<VaultItem[]> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const records = readMdbx2RestoreBatchJournal(state.mdbx2RestoreBatches), record = records.find(row => row.id === operationId);
      if (!record || record.operationScope !== expectedScope) throw new Error('MDBX 整组恢复请求已变化。');
      await assertMdbx2RestoreBatchScope(record);
      if (record.status === 'completed') return mdbx2RestoreBatchSources(record).map(source => {
        const item = state.items.find(row => row.id === source.id);
        if (!item) throw new Error('恢复后的项目已被移除。');
        return structuredClone(item);
      });
      const deletedAgain = assertMdbx2RestoreBatchReady(state, record);
      const receipt = await restore(structuredClone(record));
      const completed: Mdbx2RestoreBatchRecord = { ...record, status: 'completed', receipt };
      readMdbx2RestoreBatchJournal([completed]);
      const restored = mdbx2RestoreBatchSources(record).map((source, index) => {
        const member = record.members.find(row => row.source.id === source.id);
        const local = deletedAgain[index] ? state.items.find(row => row.id === source.id)! : source;
        const now = new Date(Math.max(this.now(), Date.parse(local.updatedAt) + 1)).toISOString();
        return { ...local, deletedAt: deletedAgain[index] ? local.deletedAt : undefined, updatedAt: deletedAgain[index] ? local.updatedAt : now,
          providerRefs: local.providerRefs.map(ref => member && ref.providerId === member.provider.id ? { ...ref, revision: receipt.commitId,
            ...(deletedAgain[index] && !record.cancellation ? { etag: mdbx2ItemFingerprint(member.source) } : {}) } : ref) } as VaultItem;
      });
      const byId = new Map(restored.map(item => [item.id, item]));
      state.items = state.items.map(item => byId.get(item.id) || item);
      state.mdbx2RestoreBatches = records.map(row => row.id === record.id ? completed : row);
      if (record.cancellation) for (const item of restored) {
        if (item.deletedAt) continue;
        const ref = item.providerRefs[0];
        if (!ref.remoteId) queueProviderMutation(state, item, ref.providerId, 'create', item.updatedAt);
        else if (!ref.etag || ref.etag !== mdbx2ItemFingerprint(item)) queueProviderMutation(state, item, ref.providerId, 'update', item.updatedAt);
      }
      state.updatedAt = new Date(this.now()).toISOString();
      // All local members and the receipt are acknowledged in the same encrypted save.
      await this.persist(state, key, envelope.kdf);
      return structuredClone(restored);
    });
  }

  async cancelPendingMdbx2Deletion(expected: VaultItem, account: ProviderAccount,
    verifyStillActive: () => Promise<void>): Promise<VaultItem> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const provider = state.providers.find(row => row.id === account.id);
      const source = state.items.find(row => row.id === expected.id);
      const ref = source?.providerRefs.find(row => row.providerId === account.id);
      const mutations = state.mutationQueue.filter(row => row.itemId === expected.id);
      assertNoMdbx2RestoreBatchOverlap(state, new Set([expected.id]));
      if (!source?.deletedAt || source.kind === 'opaque' || !ref || account.kind !== 'mdbx2' || !provider?.enabled
        || !sameProviderBinding(provider, account) || provider.config.nativeVaultId !== account.config.nativeVaultId
        || JSON.stringify(source) !== JSON.stringify(expected) || mutations.length > 1
        || ref.remoteId && mutations.length !== 1
        || mutations.some(row => row.providerId !== account.id || row.operation !== 'delete')
        || state.providerConflicts.some(row => row.itemId === expected.id)
        || state.providerMutationReceipts.some(receipt => receipt.itemId === expected.id
          && (receipt.stage !== 'prepared' || receipt.operation !== 'delete' || receipt.providerId !== account.id
            || !mutations.some(row => row.id === receipt.mutationId)))
        || readMdbx2RestoreJournal(state.mdbx2Restores).some(row => row.status === 'prepared' && row.source.id === expected.id)
        || readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row => row.status !== 'completed'
          && row.entries.some(entry => entry.expected.id === expected.id))
        || readPasswordProjectRemovalJournal(state.passwordProjectRemovals).some(row => isPasswordProjectRemovalPending(row)
          && [...row.removed, ...row.retained].some(item => item.id === expected.id)))
        throw new Error('删除结果尚未确认，请先同步后再恢复。');
      await verifyStillActive();
      const now = new Date(Math.max(this.now(), Date.parse(source.updatedAt) + 1)).toISOString();
      const restored = { ...source, deletedAt: undefined, updatedAt: now } as VaultItem;
      state.items = state.items.map(row => row.id === source.id ? restored : row);
      state.mutationQueue = state.mutationQueue.filter(row => !mutations.some(saved => saved.id === row.id));
      state.providerMutationReceipts = state.providerMutationReceipts.filter(row => !mutations.some(saved => saved.id === row.mutationId));
      if (!ref.remoteId) queueProviderMutation(state, restored, account.id, 'create', now);
      else if (!ref.etag || ref.etag !== mdbx2ItemFingerprint(restored)) queueProviderMutation(state, restored, account.id, 'update', now);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return structuredClone(restored);
    });
  }

  async stageMdbx2Restore(input: Mdbx2RestoreRecord, previousScope?: string): Promise<Mdbx2RestoreRecord> {
    const [record] = readMdbx2RestoreJournal([input]);
    if (record.status !== 'prepared') throw new Error('只能准备未提交的恢复请求。');
    await assertMdbx2RestoreScope(record);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const records = readMdbx2RestoreJournal(state.mdbx2Restores);
      const old = records.find(entry => entry.id === record.id);
      if (old && JSON.stringify(old) === JSON.stringify(record)) return old;
      if (old && (old.status !== 'prepared' || old.intent.operationScope !== previousScope
        || JSON.stringify(old.source) !== JSON.stringify(record.source) || JSON.stringify(old.provider) !== JSON.stringify(record.provider)
        || JSON.stringify(old.reapply) !== JSON.stringify(record.reapply)
        || JSON.stringify(old.supersededDeletion) !== JSON.stringify(record.supersededDeletion)
        || old.intent.objectId !== record.intent.objectId || old.intent.collectionId !== record.intent.collectionId
        || old.intent.objectTypeId !== record.intent.objectTypeId || old.intent.expectedHeadCommitId !== record.intent.expectedHeadCommitId
        || old.intent.writeRevision.vaultId !== record.intent.writeRevision.vaultId)) throw new Error('MDBX 恢复请求已变化。');
      if (!old && record.supersededDeletion) {
        const deletion = record.supersededDeletion;
        const queued = state.mutationQueue.filter(row => row.itemId === record.source.id);
        if (JSON.stringify(state.items.find(row => row.id === record.source.id)) !== JSON.stringify(record.source)
          || queued.length !== 1 || JSON.stringify(queued[0]) !== JSON.stringify(deletion)
          || state.providerMutationReceipts.some(row => row.itemId === record.source.id
            && (row.providerId !== record.provider.id || row.mutationId !== deletion.id || row.operation !== 'delete' || row.stage !== 'prepared'))
          || readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row => row.status !== 'completed'
            && row.entries.some(entry => entry.expected.id === record.source.id)))
          throw new Error('删除结果尚未确认，请先同步后再恢复。');
        // Superseding the delete and staging restoration share one encrypted save.
        // A later delete creates a new queue entry and remains visible to recovery.
        state.mutationQueue = state.mutationQueue.filter(row => row.id !== deletion.id);
        state.providerMutationReceipts = state.providerMutationReceipts.filter(row => row.mutationId !== deletion.id);
      }
      assertMdbx2RestoreReady(state, record);
      const pending = records.filter(entry => entry.status === 'prepared' && entry.id !== record.id);
      if (pending.length >= 80 || pending.some(entry => entry.source.id === record.source.id)) throw new Error('此项目还有待完成的恢复操作。');
      state.mdbx2Restores = [...pending, ...records.filter(entry => entry.status === 'completed').slice(-19), record];
      await this.persist(state, key, envelope.kdf);
      return structuredClone(record);
    });
  }

  async applyMdbx2Restore(operationId: string, expectedScope: string,
    restore: (record: Mdbx2RestoreRecord) => Promise<Mdbx2ObjectRestoreResult>): Promise<VaultItem> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const records = readMdbx2RestoreJournal(state.mdbx2Restores);
      const record = records.find(entry => entry.id === operationId);
      if (!record || record.intent.operationScope !== expectedScope) throw new Error('MDBX 恢复请求已变化。');
      await assertMdbx2RestoreScope(record);
      if (record.status === 'completed') {
        const current = state.items.find(item => item.id === record.source.id);
        if (!current) throw new Error('恢复后的项目已被移除。');
        return structuredClone(current);
      }
      const deletedAgain = assertMdbx2RestoreReady(state, record);
      // Settle the durable request even when its response is unknown. A later
      // deletion stays queued; acknowledging restoration must never revive it.
      const receipt = await restore(structuredClone(record));
      const completed: Mdbx2RestoreRecord = { ...record, status: 'completed', receipt };
      readMdbx2RestoreJournal([completed]);
      const local = record.reapply || deletedAgain ? state.items.find(row => row.id === record.source.id)! : record.source;
      const now = new Date(Math.max(this.now(), Date.parse(local.updatedAt) + 1)).toISOString();
      const restored = { ...local, deletedAt: deletedAgain ? local.deletedAt : undefined, updatedAt: deletedAgain ? local.updatedAt : now, providerRefs: local.providerRefs.map(ref =>
        ref.providerId === record.provider.id ? { ...ref, revision: receipt.commitId,
          ...(record.reapply || deletedAgain ? { etag: mdbx2ItemFingerprint(record.source) } : {}) } : ref) } as VaultItem;
      state.items = state.items.map(item => item.id === restored.id ? restored : item);
      state.mdbx2Restores = records.map(entry => entry.id === record.id ? completed : entry);
      if (record.reapply && !deletedAgain && !state.mutationQueue.some(row => row.itemId === local.id && row.providerId === record.provider.id))
        queueProviderMutation(state, restored, record.provider.id, 'update', now);
      if (record.supersededDeletion && !deletedAgain) {
        const ref = restored.providerRefs.find(row => row.providerId === record.provider.id)!;
        if (!ref.etag || ref.etag !== mdbx2ItemFingerprint(restored)) queueProviderMutation(state, restored, record.provider.id, 'update', now);
      }
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return structuredClone(restored);
    });
  }

  async readKeePassProjectRestores() {
    return readKeePassProjectRestoreReceipts((await this.readState()).keepassProjectRestores);
  }

  async readKeePassProjectResolutions() {
    return readKeePassProjectResolutionIntents((await this.readState()).keepassProjectResolutionIntents);
  }

  async stageKeePassProjectResolution(input: Pick<KeePassProjectResolutionIntent, 'source' | 'request' | 'originals'>) {
    const request = structuredClone(input);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const intents = readKeePassProjectResolutionIntents(state.keepassProjectResolutionIntents);
      const candidate = readKeePassProjectResolutionIntents([{ ...request, version: 1, status: 'staged', createdAt: new Date(this.now()).toISOString() }])[0];
      const previous = intents.find(row => row.request.operationId === candidate.request.operationId);
      if (previous) {
        if (resolutionSnapshotKey([previous.source, previous.request, previous.originals]) !== resolutionSnapshotKey([request.source, request.request, request.originals]))
          throw new Error('冲突解决操作标识已用于其他选择。');
        return previous;
      }
      assertKeePassResolutionUnchanged(state, candidate);
      if (intents.some(row => row.source.id === candidate.source.id && ['staged', 'writing'].includes(row.status))
        || readKeePassProjectRemovalIntents(state.keepassProjectRemovalIntents).some(row => row.source.id === candidate.source.id && ['staged', 'writing'].includes(row.status)))
        throw new Error('此密码源已有待恢复操作。');
      state.keepassProjectResolutionIntents = readKeePassProjectResolutionIntents([...intents, candidate]);
      state.updatedAt = new Date(this.now()).toISOString(); await this.persist(state, key, envelope.kdf);
      return structuredClone(candidate);
    });
  }

  async beginKeePassProjectResolution(operationId: string) {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const intents = readKeePassProjectResolutionIntents(state.keepassProjectResolutionIntents);
      const intent = intents.find(row => row.request.operationId === operationId);
      if (!intent) throw new Error('冲突解决记录不存在。');
      if (intent.status !== 'staged') return intent;
      assertKeePassResolutionUnchanged(state, intent); intent.status = 'writing';
      state.keepassProjectResolutionIntents = intents;
      state.updatedAt = new Date(this.now()).toISOString(); await this.persist(state, key, envelope.kdf);
      return structuredClone(intent);
    });
  }

  async cancelKeePassProjectResolution(operationId: string) {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const intents = readKeePassProjectResolutionIntents(state.keepassProjectResolutionIntents);
      const intent = intents.find(row => row.request.operationId === operationId);
      if (!intent || !['staged', 'cancelled'].includes(intent.status)) throw new Error('冲突解决写入已开始，请先核对结果。');
      if (intent.status === 'cancelled') return intent;
      intent.status = 'cancelled'; state.keepassProjectResolutionIntents = intents;
      state.updatedAt = new Date(this.now()).toISOString(); await this.persist(state, key, envelope.kdf); return structuredClone(intent);
    });
  }

  /** Internal only: caller holds provider/native/file queues and has successfully
   * proved that this operation has no durable file receipt. No item is restored. */
  async cancelUncommittedKeePassProjectResolution(operationId: string, requestHash: string) {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const intents = readKeePassProjectResolutionIntents(state.keepassProjectResolutionIntents);
      const intent = intents.find(row => row.request.operationId === operationId);
      if (!intent || intent.status === 'completed' || await keePassProjectResolutionRequestHash(intent.request) !== requestHash)
        throw new Error('冲突解决取消凭据不匹配。');
      if (intent.status === 'cancelled') return structuredClone(intent);
      const source = state.providers.find(row => row.id === intent.source.id);
      if (!source || !sameProviderBinding(source, intent.source) || source.config.databaseId !== intent.source.config.databaseId)
        throw new Error('冲突解决的密码源已变化。');
      intent.status = 'cancelled'; state.keepassProjectResolutionIntents = intents;
      state.updatedAt = new Date(this.now()).toISOString(); await this.persist(state, key, envelope.kdf);
      return structuredClone(intent);
    });
  }

  async completeKeePassProjectResolution(operationId: string, input: {
    receipt: KeePassDurableMutationReceipt; projectionSha256: string; items: VaultItem[]; sourceRecords: ProviderSourceRecord[]; accountPatch?: Partial<ProviderAccount>;
  }) {
    const result = structuredClone(input), receipt = validateKeePassDurableMutationReceipt(result.receipt);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const intents = readKeePassProjectResolutionIntents(state.keepassProjectResolutionIntents);
      const intent = intents.find(row => row.request.operationId === operationId);
      if (!intent || !['writing', 'completed'].includes(intent.status) || receipt.operationId !== operationId || receipt.providerId !== intent.source.id
        || receipt.kind !== 'project-resolve' || receipt.result.type !== 'project-resolve' || receipt.result.reviewToken !== intent.request.reviewToken
        || receipt.intentSha256 !== await keePassProjectResolutionRequestHash(intent.request) || receipt.result.resolvedSha256 !== result.projectionSha256)
        throw new Error('冲突解决回执或文件投影不匹配。');
      if (intent.status === 'completed') {
        if (intent.resolvedSha256 !== result.projectionSha256) throw new Error('冲突解决回执版本不一致。');
        return intent;
      }
      const source = assertKeePassResolutionUnchanged(state, intent);
      const originals = new Map(intent.originals.map(item => [item.id, item]));
      if (new Set(result.items.map(item => item.id)).size !== result.items.length || result.items.some(item => !item.providerRefs.some(ref => ref.providerId === source.id)
        || state.items.some(existing => existing.id === item.id && !originals.has(existing.id)))
        || result.sourceRecords.some(row => row.providerId !== source.id)) throw new Error('冲突解决投影包含其他来源或重复项目。');
      for (const old of intent.originals) {
        const incoming = result.items.find(item => item.id === old.id);
        if (old.providerRefs.some(ref => ref.providerId !== source.id && (!incoming || !incoming.providerRefs.some(next => resolutionSnapshotKey(next) === resolutionSnapshotKey(ref)))))
          throw new Error('冲突解决不能移除其他密码源的引用。');
      }
      const merged = mergeProviderSyncItems(source.id, intent.originals, state.items, result.items, new Map(), true);
      if (merged.conflicts.length) throw new Error('冲突解决投影与当前密码库仍有冲突。');
      const incomingById = new Map(result.items.map(item => [item.id, item]));
      state.items = merged.items.map(item => {
        if (item.kind !== 'passkey') return item;
        const previous = originals.get(item.id), incoming = incomingById.get(item.id);
        const preserved = previous?.kind === 'passkey' ? preservePasskeyCounterHistory(previous, item) : item;
        // History-only observations are excluded from content comparisons but
        // must survive a resolution even when the merge retains local content.
        return incoming?.kind === 'passkey' ? preservePasskeyCounterHistory(incoming, preserved) : preserved;
      });
      replaceProviderSourceRecords(state, source.id, result.sourceRecords);
      const budgetError = sourceRecordsBudgetError(state.sourceRecords); if (budgetError) throw new Error(budgetError);
      if (result.accountPatch) {
        const updated = { ...source, ...result.accountPatch, id: source.id, kind: source.kind };
        if (!sameProviderBinding(source, updated) || updated.config.databaseId !== source.config.databaseId) throw new Error('冲突解决不能替换密码源。');
        state.providers = state.providers.map(row => row.id === source.id ? updated : row);
      }
      intent.status = 'completed'; intent.resolvedSha256 = result.projectionSha256; state.keepassProjectResolutionIntents = intents;
      state.updatedAt = new Date(this.now()).toISOString(); await this.persist(state, key, envelope.kdf);
      return structuredClone(intent);
    });
  }

  /** Internal encrypted preparation only; does not queue independent entry writes
   * or remove originals. The file transaction must revalidate this saved source,
   * full project and native attachment proofs before applying anything.
   */
  async stageKeePassProjectRemoval(input: { operationId: string; source: ProviderAccount; draft: KeePassProjectRemovalDraft }): Promise<KeePassProjectRemovalIntent> {
    const request = structuredClone(input);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const intents = readKeePassProjectRemovalIntents(state.keepassProjectRemovalIntents);
      const candidate = readKeePassProjectRemovalIntents([{ version: 1, operationId: request.operationId, status: 'staged',
        createdAt: new Date(this.now()).toISOString(), source: request.source, draft: request.draft }])[0];
      const previous = intents.find(row => row.operationId === request.operationId);
      if (previous) {
        if (keePassRemovalRequestKey(previous.source, previous.draft) !== keePassRemovalRequestKey(request.source, request.draft))
          throw new Error('移除操作标识已用于其他草稿。');
        return previous;
      }
      if (readKeePassProjectResolutionIntents(state.keepassProjectResolutionIntents).some(row => row.source.id === request.source.id
        && ['staged', 'writing'].includes(row.status))) throw new Error('此密码源已有待恢复的冲突解决。');
      const source = state.providers.find(row => row.id === request.source.id);
      if (!source || !source.enabled || !sameProviderBinding(source, request.source)
        || source.config.databaseId !== request.source.config.databaseId) throw new Error('KeePass 数据库来源已变化，请重新打开项目。');
      planKeePassProjectRemoval(request.draft, state.items, source);
      const ids = new Set(request.draft.items.map(row => row.id));
      if (state.providerConflicts.some(row => ids.has(row.itemId)) || intents.some(row => ['staged', 'writing'].includes(row.status)
        && row.draft.items.some(item => ids.has(item.id)))) throw new Error('项目已有待处理的移除操作或同步冲突。');
      // Never evict a pending intent or silently forget its operation ID.
      if (intents.length >= 100) throw new Error('KeePass 项目移除恢复记录已满。');
      state.keepassProjectRemovalIntents = [...intents, candidate];
      state.updatedAt = candidate.createdAt;
      await this.persist(state, key, envelope.kdf);
      return structuredClone(candidate);
    });
  }

  async readKeePassProjectRemovalIntents(): Promise<KeePassProjectRemovalIntent[]> {
    return readKeePassProjectRemovalIntents((await this.readState()).keepassProjectRemovalIntents);
  }

  /** Persist the exact input file binding before a durable file write may start. */
  async beginKeePassProjectRemoval(operationId: string, expectedWorkingSha256: string): Promise<KeePassProjectRemovalIntent> {
    if (!/^[a-f0-9]{64}$/.test(expectedWorkingSha256)) throw new Error('KeePass 文件版本标识无效。');
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const intents = readKeePassProjectRemovalIntents(state.keepassProjectRemovalIntents);
      const intent = intents.find(row => row.operationId === operationId);
      if (!intent || intent.status === 'cancelled') throw new Error('KeePass 项目移除操作不存在或已取消。');
      if (intent.status !== 'staged') {
        if (intent.expectedWorkingSha256 !== expectedWorkingSha256) throw new Error('KeePass 移除操作已绑定其他文件版本。');
        return intent;
      }
      const source = state.providers.find(row => row.id === intent.source.id);
      if (!source || !source.enabled || !sameProviderBinding(source, intent.source)
        || source.config.databaseId !== intent.source.config.databaseId) throw new Error('KeePass 数据库来源已变化。');
      planKeePassProjectRemoval(intent.draft, state.items, source);
      const ids = new Set(intent.draft.items.map(row => row.id));
      if (state.providerConflicts.some(row => ids.has(row.itemId)) || state.mutationQueue.some(row => ids.has(row.itemId)))
        throw new Error('项目还有未完成的同步，请先完成同步后再移除。');
      intent.status = 'writing'; intent.expectedWorkingSha256 = expectedWorkingSha256;
      state.keepassProjectRemovalIntents = readKeePassProjectRemovalIntents(intents);
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
      return structuredClone(intent);
    });
  }

  /** Adopt only a verified native file receipt, in one commit with the terminal
   * intent. Later user edits cause a recoverable conflict, never an old overwrite.
   */
  async completeKeePassProjectRemoval(operationId: string, input: KeePassDurableMutationReceipt): Promise<KeePassProjectRemovalIntent> {
    const receipt = validateKeePassDurableMutationReceipt(input);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const intents = readKeePassProjectRemovalIntents(state.keepassProjectRemovalIntents);
      const intent = intents.find(row => row.operationId === operationId);
      if (!intent || !['writing', 'completed'].includes(intent.status) || receipt.operationId !== operationId
        || receipt.providerId !== intent.source.id || receipt.kind !== 'project-remove' || receipt.result.type !== 'project-remove'
        || receipt.result.inputSha256 !== intent.expectedWorkingSha256
        || receipt.intentSha256 !== await keePassRemovalFileRequestHash(intent.source, {
          operationId, expectedWorkingSha256: intent.expectedWorkingSha256!, draft: intent.draft })) throw new Error('KeePass 移除回执与原操作不匹配。');
      if (intent.status === 'completed') {
        if (intent.outputSha256 !== receipt.result.outputSha256) throw new Error('KeePass 移除回执文件版本不一致。');
        return intent;
      }
      const source = state.providers.find(row => row.id === intent.source.id);
      if (!source || !source.enabled || !sameProviderBinding(source, intent.source)
        || source.config.databaseId !== intent.source.config.databaseId) throw new Error('KeePass 数据库来源已变化。');
      const plan = planKeePassProjectRemoval(intent.draft, state.items, source);
      const desired = new Map([...plan.retained, ...plan.removed].map(item => [item.id, item]));
      const originals = new Map(intent.draft.originals.map(item => [item.id, item]));
      const removed = new Set(plan.removed.map(item => item.id));
      const result = receipt.result.snapshotItems;
      if (result.length !== desired.size || result.some(item => {
        const expected = desired.get(item.id), original = originals.get(item.id);
        const metadata = item.kind === 'login' ? readProjectCredential(item.customFields) : undefined;
        const expectedMetadata = expected && readProjectCredential(expected.customFields);
        return item.kind !== 'login' || !expected || item.password !== expected.password
          || Boolean(item.deletedAt) !== removed.has(item.id) || item.keepassDatabaseId !== expected.keepassDatabaseId
          || !metadata || !expectedMetadata || metadata.projectId !== plan.projectId
          || ['passwordId', 'groupId', 'primary', 'groupOrder', 'passwordOrder'].some(key =>
            metadata[key as keyof typeof metadata] !== expectedMetadata[key as keyof typeof expectedMetadata])
          || original && item.keepassEntryUuid !== original.keepassEntryUuid;
      })) throw new Error('KeePass 移除回执成员或凭据标识不一致。');
      if (state.providerConflicts.some(row => desired.has(row.itemId)) || state.mutationQueue.some(row => desired.has(row.itemId)))
        throw new Error('项目有后续修改或同步冲突，已保留本地内容与恢复记录。');
      const byId = new Map(result.map(item => [item.id, item]));
      const existing = new Set(state.items.map(item => item.id));
      state.items = [...result.filter(item => !existing.has(item.id)), ...state.items.map(item => byId.get(item.id) || item)];
      if (intent.draft.allowLockedAutofill !== undefined)
        this.updateLockedAutofillGrant(state, plan.retained[0].id, intent.draft.allowLockedAutofill);
      intent.status = 'completed'; intent.outputSha256 = receipt.result.outputSha256;
      state.keepassProjectRemovalIntents = readKeePassProjectRemovalIntents(intents);
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf, intent.draft.allowLockedAutofill === true);
      return structuredClone(intent);
    });
  }

  async cancelKeePassProjectRemovalIntent(operationId: string): Promise<void> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const intents = readKeePassProjectRemovalIntents(state.keepassProjectRemovalIntents);
      const intent = intents.find(row => row.operationId === operationId);
      if (!intent) throw new Error('KeePass 项目移除恢复记录不存在。');
      if (intent.status === 'cancelled') return;
      if (intent.status !== 'staged') throw new Error('文件写入已开始，请先恢复确认结果，不能直接取消。');
      intent.status = 'cancelled';
      state.keepassProjectRemovalIntents = intents;
      state.updatedAt = new Date(this.now()).toISOString();
      await this.persist(state, key, envelope.kdf);
    });
  }

  /** One encrypted commit contains every restore mutation and its retry receipt. */
  async restoreKeePassPasswordProject(input: KeePassProjectRestoreRequest): Promise<KeePassProjectRestoreReceipt> {
    const request = readKeePassProjectRestoreRequest(input);
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const receipts = readKeePassProjectRestoreReceipts(state.keepassProjectRestores);
      const previous = receipts.find(row => row.request.operationId === request.operationId);
      if (previous) {
        if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw new Error('恢复操作标识已用于其他范围。');
        return previous;
      }
      const anchor = state.items.find(item => item.id === request.anchorItemId);
      if (!anchor) throw new Error('回收站项目不存在。');
      const members = keePassRestoreProject(anchor, state.items, state.providers);
      const targets = assertKeePassRestoreProject(members, request);
      const ids = new Set(members.map(item => item.id));
      if (state.providerConflicts.some(row => ids.has(row.itemId))
        || readPasswordProjectRemovalJournal(state.passwordProjectRemovals).some(row => isPasswordProjectRemovalPending(row)
          && [...row.retained, ...row.removed].some(item => ids.has(item.id))))
        throw new Error('项目还有待处理的同步或移除冲突，请先处理后再恢复。');
      const now = new Date(Math.max(this.now(), ...members.map(item => Date.parse(item.updatedAt) + 1))).toISOString();
      const restored = new Map(targets.map(item => [item.id, { ...item, deletedAt: undefined, updatedAt: now }]));
      for (const item of restored.values()) {
        queueProviderMutation(state, item, request.providerId, 'update', now);
        if (item.providerRefs[0].remoteId)
          state.mutationQueue.find(row => row.providerId === request.providerId && row.itemId === item.id)!.keepassRestore = true;
      }
      state.items = state.items.map(item => restored.get(item.id) || item);
      const receipt: KeePassProjectRestoreReceipt = { version: 1, request, title: anchor.title, queuedAt: now };
      state.keepassProjectRestores = [...receipts.slice(-99), receipt];
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return structuredClone(receipt);
    });
  }

  async restoreItem(itemId: string): Promise<VaultItem> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error("回收站项目不存在。");
      if (!item.deletedAt) return structuredClone(item);
      if (item.providerRefs.some(ref => state.providers.some(provider => provider.id === ref.providerId && provider.kind === 'mdbx2')))
        throw new Error('MDBX 项目必须通过原生恢复流程确认后才能移出回收站。');

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
          if (provider.kind === 'keepass') {
            // A remote KeePass delete can be committed in its encrypted working
            // copy even when the general provider receipt store is still empty.
            queueProviderMutation(state, restored, provider.id, 'update', now);
            if (reference.remoteId) state.mutationQueue.find(mutation => mutation.providerId === provider.id && mutation.itemId === restored.id)!.keepassRestore = true;
            continue;
          }
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

  /** Restore availability of exactly the selected current record, never an old full snapshot. */
  async unarchiveItem(itemId: string, expectedUpdatedAt: string): Promise<VaultItem> {
    if (typeof itemId !== 'string' || !itemId || typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt)))
      throw new Error('项目已变化，请刷新列表后重试。');
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const item = state.items.find(row => row.id === itemId);
      if (!item || item.deletedAt || item.updatedAt !== expectedUpdatedAt) throw new Error('项目已变化，请刷新列表后重试。');
      if (item.kind === 'opaque') throw new Error('此原生类型或版本仅可读取，请使用支持它的客户端管理。');
      const ids = new Set([item.id, ...(item.kind === 'login' ? passwordGroupMembers(item, state.items).map(row => row.id) : [])]);
      assertNoMdbx2RestoreBatchOverlap(state, ids);
      if (readMdbx2RestoreJournal(state.mdbx2Restores).some(row => row.status === 'prepared' && ids.has(row.source.id))
        || readPasswordProjectRemovalJournal(state.passwordProjectRemovals).some(row => isPasswordProjectRemovalPending(row)
          && [...row.retained, ...row.removed].some(candidate => ids.has(candidate.id)))
        || readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row => row.status !== 'completed'
          && row.entries.some(entry => ids.has(entry.expected.id) || ids.has(entry.result.id)))
        || state.providerConflicts.some(row => ids.has(row.itemId))
        || state.mutationQueue.some(row => ids.has(row.itemId) && row.operation === 'delete'))
        throw new Error('项目还有待处理的同步或恢复操作，请先处理后再取消归档。');
      if (!item.archivedAt) return structuredClone(item);
      const now = new Date(Math.max(this.now(), Date.parse(item.updatedAt) + 1)).toISOString();
      const restored = { ...item, archivedAt: undefined, updatedAt: now };
      state.items = state.items.map(row => row.id === item.id ? restored : row);
      queueProviderMutations(state, restored, 'update', now);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return structuredClone(restored);
    });
  }

  async deletePasswordHistory(itemId: string, index: number, expectedUpdatedAt: string): Promise<LoginItem> {
    if (typeof itemId !== 'string' || !itemId || !Number.isSafeInteger(index) || index < 0 || typeof expectedUpdatedAt !== 'string')
      throw new Error('密码历史已变化，请重新打开项目后重试。');
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const item = state.items.find(row => row.id === itemId);
      if (!item || item.kind !== 'login' || item.deletedAt || item.updatedAt !== expectedUpdatedAt || !item.passwordHistory?.[index])
        throw new Error('密码历史已变化，请重新打开项目后重试。');
      const ids = new Set(passwordGroupMembers(item, state.items).map(row => row.id)); ids.add(item.id);
      assertNoMdbx2RestoreBatchOverlap(state, ids);
      if (readMdbx2RestoreJournal(state.mdbx2Restores).some(row => row.status === 'prepared' && ids.has(row.source.id))
        || readPasswordProjectRemovalJournal(state.passwordProjectRemovals).some(row => isPasswordProjectRemovalPending(row)
          && [...row.retained, ...row.removed].some(candidate => ids.has(candidate.id)))
        || readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row => row.status !== 'completed'
          && row.entries.some(entry => ids.has(entry.expected.id) || ids.has(entry.result.id)))
        || state.providerConflicts.some(row => ids.has(row.itemId))
        || state.mutationQueue.some(row => ids.has(row.itemId) && row.operation === 'delete'))
        throw new Error('项目还有待处理的同步或恢复操作，请先处理后再删除历史。');
      const now = new Date(Math.max(this.now(), (Date.parse(item.updatedAt) || 0) + 1)).toISOString();
      const updated = { ...item, updatedAt: now, passwordHistory: item.passwordHistory.filter((_, i) => i !== index) };
      state.items = state.items.map(row => row.id === item.id ? updated : row);
      queueProviderMutations(state, updated, 'update', now);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return structuredClone(updated);
    });
  }

  async deleteItem(itemId: string): Promise<void> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    const now = new Date(this.now()).toISOString();
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    if (item.kind === "opaque") throw new Error("此原生类型或版本仅可读取，请使用支持它的客户端管理。");
    state.items = state.items.map((candidate) => (candidate.id === itemId ? { ...candidate, deletedAt: now, updatedAt: now } : candidate)) as VaultItem[];
    queueProviderMutations(state, item, "delete", now);
    state.updatedAt = now;
    await this.persist(state, key, envelope.kdf);
    });
  }

  /** A display operation: no project membership or credential ordering is rewritten. */
  async setPasswordStack(anchorItemIds: string[], action: import("../core/password-manual-stacks").PasswordStackAction, expected: Record<string, string>): Promise<LoginItem[]> {
    return this.runExclusive(async () => {
      const { PASSWORD_STACK_ACTIONS, putPasswordStackSetting } = await import("../core/password-manual-stacks");
      const { passwordDisplaySourceKey } = await import("../core/password-display-stacks");
      if (!PASSWORD_STACK_ACTIONS.includes(action) || !Array.isArray(anchorItemIds) || !anchorItemIds.length
        || anchorItemIds.length > 1000 || anchorItemIds.some(id => typeof id !== "string")) throw new Error("请选择有效的密码项目和堆叠操作。");
      const { state, envelope, key } = await this.mutableContext();
      const selected = new Map<string, LoginItem>();
      const projectKeys = new Set<string>();
      for (const id of new Set(anchorItemIds)) {
        const anchor = state.items.find((item): item is LoginItem => item.id === id && item.kind === "login" && !item.deletedAt && !item.archivedAt);
        if (!anchor) throw new Error("项目已变化，请重新打开堆叠设置。");
        const members = passwordGroupMembers(anchor, state.items);
        if (members.some(item => item.archivedAt)) throw new Error("项目包含已归档密码，请先恢复后再设置堆叠。");
        projectKeys.add(passwordGroupKey(anchor));
        for (const member of members) selected.set(member.id, member);
      }
      const members = [...selected.values()];
      if (action === "stack" && projectKeys.size < 2) throw new Error("请选择至少两个密码项目。");
      if (action === "stack" && new Set(members.map(passwordDisplaySourceKey)).size > 1) throw new Error("请在同一个密码源内创建手动堆叠。");
      if (!expected || typeof expected !== "object" || Array.isArray(expected) || Object.keys(expected).length !== members.length
        || members.some(item => !Object.prototype.hasOwnProperty.call(expected, item.id) || expected[item.id] !== item.updatedAt)) {
        throw new Error("项目成员或内容已变化，请重新打开堆叠设置。");
      }
      const groupId = action === "stack" ? crypto.randomUUID() : undefined;
      // Validate every member before scheduling writes. Unknown marker formats retain their data.
      const changes = members.map(item => ({ item, fields: putPasswordStackSetting(item.customFields, action, groupId) }))
        .filter(({ item, fields }) => fields !== item.customFields);
      if (!changes.length) return [];
      const now = new Date(changes.reduce((latest, { item }) => Math.max(latest, (Date.parse(item.updatedAt) || 0) + 1), this.now())).toISOString();
      const updates = changes.map(({ item, fields }) => ({ ...item, customFields: fields, updatedAt: now }));
      const byId = new Map(updates.map(item => [item.id, item]));
      for (const item of updates) queueProviderMutations(state, item, "update", now);
      state.items = state.items.map(item => byId.get(item.id) || item);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return updates;
    });
  }

  /** A display operation: no project membership or credential ordering is rewritten. */
  async setPasswordCover(anchorItemId: string, enabled: boolean, expected: Record<string, string>): Promise<LoginItem[]> {
    return this.runExclusive(async () => {
      if (typeof enabled !== "boolean") throw new Error("封面设置必须是布尔值。");
      const { state, envelope, key } = await this.mutableContext();
      const anchor = state.items.find((item): item is LoginItem => item.id === anchorItemId && item.kind === "login" && !item.deletedAt && !item.archivedAt);
      if (!anchor) throw new Error("此项目已变化，请刷新列表后重试。");
      const { passwordCoverPeers } = await import("../core/password-display-stacks");
      const peers = passwordCoverPeers(anchor, state.items);
      if (!expected || typeof expected !== "object" || Array.isArray(expected)
        || Object.keys(expected).length !== peers.length || peers.some(item => !Object.prototype.hasOwnProperty.call(expected, item.id) || expected[item.id] !== item.updatedAt)) {
        throw new Error("网站分组已变化，请刷新列表后重试。");
      }
      const changed = peers.filter(item => enabled ? (item.id === anchor.id ? item.isGroupCover !== true : item.isGroupCover === true) : item.id === anchor.id && item.isGroupCover === true);
      if (!changed.length) return [];
      const now = new Date(changed.reduce((latest, item) => Math.max(latest, (Date.parse(item.updatedAt) || 0) + 1), this.now())).toISOString();
      const updates = changed.map(item => ({ ...item, isGroupCover: enabled && item.id === anchor.id, updatedAt: now }));
      const byId = new Map(updates.map(item => [item.id, item]));
      for (const item of updates) queueProviderMutations(state, item, "update", now);
      state.items = state.items.map(item => byId.get(item.id) || item);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
      return updates;
    });
  }

  /** Delete one explicit project against the complete revision snapshot, atomically. */
  async deletePasswordGroup(anchorItemId: string, expected: Record<string, string>): Promise<void> {
    return this.runExclusive(async () => {
      const { state, envelope, key } = await this.mutableContext();
      const anchor = state.items.find((item): item is LoginItem => item.id === anchorItemId && item.kind === "login" && !item.deletedAt);
      if (!anchor?.passwordGroupId) throw new Error("此项目不存在或不属于显式分组，请重新打开项目。");
      if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error("分组成员已变化，请重新打开整个项目。");
      const members = passwordGroupMembers(anchor, state.items);
      const ids = new Set(members.map(item => item.id));
      const expectedIds = Object.keys(expected);
      if (expectedIds.length !== ids.size || expectedIds.some(id => !ids.has(id))) throw new Error("分组成员已变化，请重新打开整个项目。");
      if (members.some(item => typeof expected[item.id] !== "string" || expected[item.id] !== item.updatedAt)) throw new Error("分组成员已被修改，请重新打开整个项目后删除。");
      const now = new Date(Math.max(this.now(), ...members.map(item => (Date.parse(item.updatedAt) || 0) + 1))).toISOString();
      const deleted = new Map(members.map(item => [item.id, { ...item, deletedAt: now, updatedAt: now }]));
      for (const item of deleted.values()) queueProviderMutations(state, item, "delete", now);
      state.items = state.items.map(item => deleted.get(item.id) || item);
      state.updatedAt = now;
      await this.persist(state, key, envelope.kdf);
    });
  }

  async markProviderSyncFailure(providerId: string, message: string): Promise<void> {
    return this.runExclusive(async () => {
    const { state, envelope, key } = await this.mutableContext();
    state.mutationQueue = state.mutationQueue.map((mutation) => mutation.providerId === providerId ? { ...mutation, attempts: Math.min(5, mutation.attempts + 1), lastError: message } : mutation);
    await this.persist(state, key, envelope.kdf, false, false);
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

  private updateLockedAutofillGrant(state: VaultState, itemId: string, enabled: boolean): void {
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (enabled && (!item || !supportsLockedAutofill(item))) throw new Error("免解锁填写仅适用于有密码和匹配网站的未归档登录项。");
    const ids = new Set(state.settings.lockedAutofillItemIds || []);
    if (enabled) ids.add(itemId);
    else ids.delete(itemId);
    state.settings.lockedAutofillItemIds = [...ids];
  }

  private async refreshLockedAutofill(state: VaultState, envelope: VaultEnvelope, required = false): Promise<void> {
    try { await this.lockedAutofill.prepare(state, envelope); }
    catch (error) {
      // Normal vault writes still commit: the new envelope invalidates the old cache.
      // An explicit grant must be fully prepared before reporting success.
      if (required) throw error;
    }
  }

  private async persist(state: VaultState, key: CryptoKey, kdf: VaultKdfParameters, requireLockedAutofill = false, activity = true): Promise<void> {
    const eligible = new Set(state.items.filter(supportsLockedAutofill).map((item) => item.id));
    state.settings.lockedAutofillItemIds = (state.settings.lockedAutofillItemIds || []).filter((id) => eligible.has(id));
    const envelope = await encryptVaultState(state, key, kdf);
    await this.refreshLockedAutofill(state, envelope, requireLockedAutofill);
    await this.storage.write(envelope);
    try {
      if (activity) await this.touchSession(state.settings.autoLockMinutes);
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
      id: crypto.randomUUID(),
      rawKey: await exportVaultKey(key),
      lastActivityAt: now,
      expiresAt: now + autoLockMinutes * 60_000
    });
  }

  private async touchSession(autoLockMinutes: number): Promise<void> {
    const session = await this.sessions.read();
    if (!session || session.expiresAt <= this.now()) throw new VaultLockedError();
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
        ...(Number.isFinite(Number(provider.config.databaseId)) ? { databaseId: Number(provider.config.databaseId) } : {}),
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
        } : sourceMode === "onedrive" ? {
          sourceMode: "onedrive",
          oneDriveDriveId: stringConfig(provider, "oneDriveDriveId") || undefined,
          oneDriveItemId: stringConfig(provider, "oneDriveItemId") || undefined,
          ...publicOneDriveConnection(provider.config.oneDriveConnection),
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

function publicOneDriveConnection(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const profile = (value as Record<string, unknown>).profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const fields = profile as Record<string, unknown>;
  return {
    oneDriveClientId: parseOneDriveConnection(value)?.clientId,
    oneDriveUsername: typeof fields.username === "string" ? fields.username.slice(0, 320) : undefined,
    oneDriveDisplayName: typeof fields.displayName === "string" ? fields.displayName.slice(0, 256) : undefined
  };
}

function stringConfig(provider: ProviderAccount, key: string): string {
  return typeof provider.config[key] === "string" ? provider.config[key] as string : "";
}

const PUBLIC_KEEPASS_REMOTE_ERROR_CODES = new Set([
  "remote-provider-invalid", "remote-working-copy-missing", "remote-credential-missing", "remote-key-file-invalid",
  "remote-operation-reused", "remote-cache-key-missing", "remote-receipt-invalid", "remote-rebase-conflict", "remote-project-batch-limit",
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

/** UI drafts own destination selection, never a provider's acknowledged remote identity. */
function providerReferencesForEdit(item: VaultItem, existing: VaultItem | undefined, state: Pick<VaultState, "providers" | "mutationQueue">): ProviderReference[] {
  const requested = item.providerRefs ?? existing?.providerRefs ?? [];
  if (!Array.isArray(requested)) throw new Error("项目的密码源引用格式无效。");
  const available = new Set(state.providers.map(provider => provider.id));
  const selected = new Set<string>();
  const result = requested.map(reference => {
    if (!reference || typeof reference.providerId !== "string" || !available.has(reference.providerId) || selected.has(reference.providerId)) throw new Error("项目的密码源不存在或引用重复，请重新选择保存位置。");
    selected.add(reference.providerId);
    const authoritative = existing?.providerRefs.find(current => current.providerId === reference.providerId);
    // A new binding is a create even if a copied draft contains a different
    // database's remoteId/revision/folder. Sync and completed-transfer adoption
    // have separate authoritative APIs and do not pass through this edit path.
    return authoritative ? { ...authoritative } : { providerId: reference.providerId };
  });
  // Detaching a still-pending destination would leave an unrouteable mutation
  // or an ambiguous in-flight create behind. Finish it before changing targets.
  if (existing?.providerRefs.some(reference => !selected.has(reference.providerId) && state.mutationQueue.some(mutation => mutation.itemId === item.id && mutation.providerId === reference.providerId))) throw new Error("原密码源仍有待写入修改，请先完成同步再更改保存位置。");
  return result;
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
    ...(nextOperation === 'update' && existing?.keepassRestore ? { keepassRestore: true as const } : {}),
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
  return remoteId.replace(/#(?:fido2:.*|totp)$/, "");
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
  adoptRemoteRemovals = false,
  confirmedRemovedItemIds = new Set<string>()
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
      if ((adoptRemoteRemovals || confirmedRemovedItemIds.has(id) && local.providerRefs.some(reference => reference.providerId === providerId)) && !localChanged) {
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
    return replacement ? [item.kind === "passkey" && replacement.kind === "passkey" ? preserveLocalPasskeyUsage(item, replacement) : replacement] : [];
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
    // Native create ACKs establish routing as well as a provider reference.
    // Keep explicit local routing edits made during the request in flight.
    ...(local.replicaGroupId === undefined && incoming.replicaGroupId !== undefined ? { replicaGroupId: incoming.replicaGroupId } : {}),
    ...(local.mdbxFolderId === undefined && incoming.mdbxFolderId !== undefined ? { mdbxFolderId: incoming.mdbxFolderId } : {}),
    ...(local.keepassEntryUuid === undefined && incoming.keepassEntryUuid !== undefined ? { keepassEntryUuid: incoming.keepassEntryUuid } : {}),
    ...(local.keepassGroupUuid === undefined && incoming.keepassGroupUuid !== undefined ? { keepassGroupUuid: incoming.keepassGroupUuid } : {}),
    providerRefs: [...local.providerRefs.filter((candidate) => candidate.providerId !== providerId), structuredClone(reference)]
  } as VaultItem;
}

function withAcknowledgedProviderReference(local: VaultItem, incoming: VaultItem | undefined, providerId: string, remoteId: string): VaultItem {
  const current = local.providerRefs.find((candidate) => candidate.providerId === providerId);
  const authoritative = incoming?.providerRefs.find((candidate) => candidate.providerId === providerId);
  return {
    ...(incoming ? withProviderReference(local, incoming, providerId) : local),
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
  if (left?.kind === "passkey" && right?.kind === "passkey") {
    const { useCount: _leftUses, lastUsedAt: _leftUsedAt, signCountHighWaterMark: _leftCounterHistory, ...leftPayload } = left;
    const { useCount: _rightUses, lastUsedAt: _rightUsedAt, signCountHighWaterMark: _rightCounterHistory, ...rightPayload } = right;
    return JSON.stringify(leftPayload) === JSON.stringify(rightPayload);
  }
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
  const kinds = new Set(["login", "secure-note", "totp", "card", "identity", "billing-address", "payment-account", "api-token", "passkey", "opaque"]);
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

function assertApiTokenDestination(item: VaultItem, providers: ProviderAccount[]): void {
  if (item.kind !== "api-token") return;
  const error = apiTokenValidationError(item);
  if (error) throw new Error(error);
  if (item.providerRefs.some(ref => !["local", "mdbx2"].includes(providers.find(provider => provider.id === ref.providerId)?.kind || ""))) {
    throw new Error("API 密钥支持 Monica 本地库与 MDBX2；与 Android 同步请选择 MDBX2 密码源。");
  }
}

function preparePasswordGroupWrite(state: VaultState, items: LoginItem[], expected: Record<string, string>, time: number): { saved: LoginItem[]; now: string } {
  if (!expected || typeof expected !== "object" || Array.isArray(expected) || !Array.isArray(items) || items.length < 1 || items.length > 100 || items.some(item => !item || item.kind !== "login" || !Array.isArray(item.providerRefs) || typeof item.id !== "string") || new Set(items.map(item => item.id)).size !== items.length) throw new Error("密码项目需包含 1–100 个不同的成员。");
  validateImportedItems(items);
  if (items.some(item => typeof item.title !== "string" || typeof item.username !== "string" || typeof item.password !== "string" || typeof item.notes !== "string" || !Array.isArray(item.uris) || item.uris.some(uri => typeof uri !== "string") || !Array.isArray(item.customFields) || item.customFields.some(field => !field || typeof field.name !== "string" || typeof field.value !== "string"))) throw new Error("多密码成员字段格式无效，原项目未修改。");
  const groupId = items[0].passwordGroupId;
  const scope = (item: LoginItem) => JSON.stringify([item.providerRefs.map(ref => ref.providerId).sort(), item.mdbxDatabaseId ?? null, item.keepassDatabaseId ?? null]);
  if (typeof groupId !== "string" || !groupId || items.some(item => item.kind !== "login" || item.passwordGroupId !== groupId || scope(item) !== scope(items[0]))) throw new Error("多密码成员必须属于同一数据库和显式分组。");
  const providerIds = new Set(state.providers.filter(provider => ["local", "mdbx2", "monica-webdav", "bitwarden", "keepass"].includes(provider.kind)).map(provider => provider.id));
  if (items.some(item => item.providerRefs.some(ref => !providerIds.has(ref.providerId)))) throw new Error("此后端没有 Android 多密码分组约定，不能创建分组。");
  if (items[0].providerRefs.some(ref => state.providers.some(provider => provider.id === ref.providerId && ['bitwarden', 'keepass'].includes(provider.kind)))) {
    const metadata = items.map(item => readProjectCredential(item.customFields));
    if (metadata.some(value => value?.projectId !== groupId) || new Set(metadata.map(value => value?.passwordId)).size !== items.length)
      throw new Error("多密码成员必须属于同一数据库和显式分组。");
  }
  const incoming = new Set(items.map(item => item.id));
  // A draft may not silently forget a member that was detached/deleted while
  // the editor was open. Removal requires its own explicit transaction.
  if (Object.keys(expected).some(id => !incoming.has(id))) throw new Error("分组成员已变化，请重新打开整个项目。");
  if (state.items.some(item => item.kind === "login" && !item.deletedAt && item.passwordGroupId === groupId && scope(item) === scope(items[0]) && !incoming.has(item.id))) throw new Error("分组成员已变化，请重新打开整个项目。");
  for (const item of items) {
    const old = state.items.find(candidate => candidate.id === item.id);
    if (old && (old.kind !== "login" || old.deletedAt || expected[item.id] !== old.updatedAt || scope(old) !== scope(item) || old.passwordGroupId && old.passwordGroupId !== groupId)) throw new Error("分组成员已被修改，草稿未保存。");
    if (!old && Object.prototype.hasOwnProperty.call(expected, item.id)) throw new Error("分组成员已被移除，草稿未保存。");
  }
  items = reconcileProjectCredentialEdits(items, state.items.filter((item): item is LoginItem => item.kind === 'login'));
  const now = new Date(Math.max(time, ...items.map(item => (Date.parse(expected[item.id] || "") || 0) + 1))).toISOString();
  const saved = items.map(item => {
    const old = state.items.find(candidate => candidate.id === item.id);
    const normalized = { ...item, createdAt: old?.createdAt || item.createdAt || now, updatedAt: now, providerRefs: providerReferencesForEdit(item, old, state) };
    return old?.kind === 'login' ? capturePasswordHistory(old, normalized, now) : normalized;
  });
  return { saved, now };
}

function commitPasswordGroupWrite(state: VaultState, saved: LoginItem[], now: string): void {
  for (const item of saved) {
    const old = state.items.find(candidate => candidate.id === item.id);
    queueProviderMutations(state, item, old ? "update" : "create", now);
  }
  const replacements = new Map(saved.map(item => [item.id, item]));
  const existingIds = new Set(state.items.map(item => item.id));
  state.items = [...saved.filter(item => !existingIds.has(item.id)), ...state.items.map(item => replacements.get(item.id) || item)];
}

function tombstonePasswordProjectRows(state: VaultState, rows: LoginItem[], now: string): void {
  const deleted = new Map(rows.map(item => [item.id, { ...item, updatedAt: now, deletedAt: now }]));
  for (const item of deleted.values()) queueProviderMutations(state, item, 'delete', now);
  state.items = state.items.map(item => deleted.get(item.id) || item);
}

function assertPasswordProjectRemovalBindings(state: VaultState, record: PasswordProjectRemovalRecord): void {
  if (record.providerBindings.some(expected => {
    const current = state.providers.find(provider => provider.id === expected.id);
    return !current || !current.enabled || !sameProviderBinding(expected, current)
      || expected.kind === 'mdbx2' && expected.config.nativeVaultId !== current.config.nativeVaultId;
  })) throw new Error('密码源已变化或不可用，原密码尚未移除。');
}

function sameRemovalMutation(current: PendingMutation, saved: PendingMutation): boolean {
  return current.id === saved.id && current.itemId === saved.itemId && current.providerId === saved.providerId
    && current.operation === saved.operation && current.createdAt === saved.createdAt;
}

function sameRemovalObject(current: VaultItem, original: VaultItem, providerId: string): boolean {
  const expected = original.providerRefs.find(row => row.providerId === providerId);
  const actual = current.providerRefs.find(row => row.providerId === providerId);
  return current.kind === original.kind && Boolean(expected?.remoteId && actual?.remoteId === expected.remoteId
    && actual.remoteFolderId === expected.remoteFolderId);
}

function assertPasswordProjectRemovalReady(state: VaultState, record: PasswordProjectRemovalRecord): LoginItem[] {
  assertPasswordProjectRemovalBindings(state, record);
  const expected = [...record.retained, ...record.removed], ids = new Set(expected.map(item => item.id));
  const members = passwordGroupMembers(record.retained[0], state.items);
  if (members.length !== ids.size || members.some(item => !ids.has(item.id))) throw new Error('分组成员已变化，原密码尚未移除。');
  for (const snapshot of expected) {
    const current = members.find(item => item.id === snapshot.id)!;
    if (passwordProjectRemovalContent(current) !== passwordProjectRemovalContent(snapshot)
      || current.providerRefs.length !== snapshot.providerRefs.length
      || snapshot.providerRefs.some(ref => !current.providerRefs.some(actual => actual.providerId === ref.providerId && (!ref.remoteId || actual.remoteId === ref.remoteId))))
      throw new Error('密码项目在移除校验期间已变化，原密码尚未移除。');
  }
  if (state.mutationQueue.some(mutation => ids.has(mutation.itemId)) || state.providerConflicts.some(conflict => ids.has(conflict.itemId)))
    throw new Error('保留密码尚未完成同步或存在冲突，原密码尚未移除。');
  const external = new Set(record.providerBindings.filter(provider => provider.kind !== 'local').map(provider => provider.id));
  if (members.some(item => item.providerRefs.some(ref => external.has(ref.providerId) && !ref.remoteId)))
    throw new Error('保留密码尚未取得远端标识，原密码尚未移除。');
  return members;
}

function assertPasswordProjectNativeDeletionReady(state: VaultState, record: PasswordProjectRemovalRecord): void {
  assertPasswordProjectRemovalBindings(state, record);
  if (!record.nativeDeletion || record.status !== 'deleting') throw new Error('密码项目尚未保存原生删除请求。');
  const { deletedAt, pendingMutations } = record.nativeDeletion;
  const expected = [...record.retained, ...record.removed.map(row => ({ ...row, deletedAt, updatedAt: deletedAt }))];
  const ids = new Set(expected.map(row => row.id));
  const liveMembers = passwordGroupMembers(record.retained[0], state.items);
  if (liveMembers.length !== record.retained.length || liveMembers.some(row => !record.retained.some(saved => saved.id === row.id))
    || expected.some(snapshot => JSON.stringify(state.items.find(row => row.id === snapshot.id)) !== JSON.stringify(snapshot))
    || state.providerConflicts.some(conflict => ids.has(conflict.itemId)))
    throw new Error('密码项目在删除恢复期间已变化，当前编辑和恢复记录已保留。');
  const queue = state.mutationQueue.filter(mutation => ids.has(mutation.itemId));
  if (queue.length !== pendingMutations.length || pendingMutations.some(saved => {
    const current = queue.find(mutation => mutation.id === saved.id);
    return !current || current.itemId !== saved.itemId || current.providerId !== saved.providerId
      || current.operation !== saved.operation || current.createdAt !== saved.createdAt;
  })) throw new Error('密码项目的待同步修改已变化，当前编辑和恢复记录已保留。');
}

/** Returns whether a newer explicit delete must survive settlement of this restore. */
function assertMdbx2RestoreReady(state: VaultState, record: Mdbx2RestoreRecord, batchId?: string): boolean {
  assertNoMdbx2RestoreBatchOverlap(state, new Set([record.source.id]), batchId);
  const provider = state.providers.find(row => row.id === record.provider.id);
  const expected = record.reapply?.item || record.source;
  const current = state.items.find(row => row.id === record.source.id);
  const queue = state.mutationQueue.filter(row => row.itemId === record.source.id);
  if (record.reapply) {
    const deletion = readPasswordProjectRemovalJournal(state.passwordProjectRemovals).find(row => row.id === record.reapply!.deletionOperationId);
    if (deletion?.status !== 'completed' || !deletion.nativeDeletion?.receipt
      || deletion.nativeDeletion.receipt.commitId !== record.intent.expectedHeadCommitId
      || !deletion.removed.some(row => row.id === record.source.id && sameRemovalObject(row, record.source, record.provider.id)))
      throw new Error('后续恢复缺少已确认的原始删除记录。');
  }
  const sameIdentity = current && current.kind === expected.kind && current.providerRefs.length === expected.providerRefs.length
    && expected.providerRefs.every(ref => current.providerRefs.some(actual => actual.providerId === ref.providerId
      && actual.remoteId === ref.remoteId && actual.remoteFolderId === ref.remoteFolderId && actual.revision === ref.revision));
  const deletedAgain = Boolean(sameIdentity && current?.deletedAt && queue.length === 1
    && queue[0].providerId === record.provider.id && queue[0].operation === 'delete');
  const validLocal = deletedAgain || (record.reapply
    ? sameIdentity && !current!.deletedAt
      && queue.every(row => row.operation === 'update' && current.providerRefs.some(ref => ref.providerId === row.providerId))
    : JSON.stringify(current) === JSON.stringify(expected) && queue.length === 0);
  if (!provider?.enabled || !sameProviderBinding(provider, record.provider) || provider.config.nativeVaultId !== record.provider.config.nativeVaultId
    || !validLocal
    || state.providerConflicts.some(row => row.itemId === record.source.id))
    throw new Error('恢复期间项目或密码源已变化，当前内容已保留。');
  if (readPasswordProjectRemovalJournal(state.passwordProjectRemovals).some(row => isPasswordProjectRemovalPending(row)
    && [...row.retained, ...row.removed].some(item => item.id === record.source.id)))
    throw new Error('此密码项目的移除结果尚未确认，请先完成移除恢复。');
  return deletedAgain;
}

function replayMdbx2DeletionCancellation(state: VaultState, operationId: string, expected?: Mdbx2RestoreBatchRequest): VaultItem[] | undefined {
  const receipt=readMdbx2DeletionCancellations(state.mdbx2DeletionCancellations).find(row=>row.request.operationId===operationId);
  if(!receipt) return undefined;
  if(expected && JSON.stringify(receipt.request)!==JSON.stringify(readMdbx2RestoreBatchRequest(expected))) throw new Error('此恢复操作标识对应的原请求已变化。');
  return Object.keys(receipt.request.expected).map(id=>{
    const item=state.items.find(row=>row.id===id);
    if(!item) throw new Error('恢复后的项目已被移除。');
    // Read the current state; an old completed request must never undo a later delete or edit.
    return structuredClone(item);
  });
}

function assertNoMdbx2RestoreBatchOverlap(state: VaultState, ids: Set<string>, exceptId?: string): void {
  if (readMdbx2RestoreBatchJournal(state.mdbx2RestoreBatches).some(row => row.id !== exceptId && row.status === 'prepared'
    && mdbx2RestoreBatchSources(row).some(source => ids.has(source.id)))) throw new Error('此密码项目还有待完成的整组恢复操作。');
}

function assertMdbx2RestoreBatchReady(state: VaultState, record: Mdbx2RestoreBatchRecord): boolean[] {
  const sources = mdbx2RestoreBatchSources(record), ids = new Set(sources.map(row => row.id));
  if (readMdbx2RestoreJournal(state.mdbx2Restores).some(row => row.status === 'prepared' && ids.has(row.source.id)))
    throw new Error('此密码项目还有待完成的单项恢复操作。');
  const first = record.members[0].source as LoginItem;
  if (readMdbx2RestoreBatchJournal(state.mdbx2RestoreBatches).some(row => row.id !== record.id && row.status === 'prepared'
    && passwordGroupKey(row.members[0].source as LoginItem) === passwordGroupKey(first)))
    throw new Error('同一密码项目已有待完成的整组恢复操作。');
  const cohort = state.items.filter((item): item is LoginItem => item.kind === 'login' && passwordGroupKey(item) === passwordGroupKey(first)
    && (!item.deletedAt || item.deletedAt === first.deletedAt));
  if (cohort.some(item => !ids.has(item.id))) throw new Error('整组恢复的成员已变化，请重新读取回收站。');
  if (readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row => row.status !== 'completed'
    && row.entries.some(entry => ids.has(entry.expected.id)))) throw new Error('此项目还有待完成的移动操作。');
  return sources.map(source => {
    const member = record.members.find(row => row.source.id === source.id);
    if (member) return assertMdbx2RestoreReady(state, member, record.id);
    assertNoMdbx2RestoreBatchOverlap(state, new Set([source.id]), record.id);
    const current = state.items.find(row => row.id === source.id), queue = state.mutationQueue.filter(row => row.itemId === source.id);
    const sameIdentity = current?.kind === source.kind && JSON.stringify(current.providerRefs) === JSON.stringify(source.providerRefs);
    const deletedAgain = Boolean(sameIdentity && current?.deletedAt && queue.length === 1 && queue[0].operation === 'delete'
      && queue[0].providerId === record.members[0].provider.id);
    if ((!deletedAgain && (JSON.stringify(current) !== JSON.stringify(source) || queue.length))
      || state.providerConflicts.some(row => row.itemId === source.id)
      || readPasswordProjectRemovalJournal(state.passwordProjectRemovals).some(row => isPasswordProjectRemovalPending(row)
        && [...row.removed, ...row.retained].some(item => item.id === source.id)))
      throw new Error('整组恢复期间成员已变化，当前内容已保留。');
    return deletedAgain;
  });
}
