import { createEmptyVaultState, type VaultItem, type VaultState } from "../core/model";
import { decryptVaultState, deriveVaultKey, encryptVaultState, exportVaultKey, importVaultKey, type VaultEnvelope, type VaultKdfParameters } from "./vault-crypto";
import type { VaultSessionStore } from "./vault-session";
import type { VaultEnvelopeStorage } from "./vault-storage";

export type VaultLifecycleStatus = "uninitialized" | "locked" | "unlocked";

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
  constructor(
    private readonly storage: VaultEnvelopeStorage,
    private readonly sessions: VaultSessionStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  async status(): Promise<VaultLifecycleStatus> {
    const envelope = await this.storage.read();
    if (!envelope) return "uninitialized";
    const session = await this.sessions.read();
    if (!session) return "locked";
    if (session.expiresAt <= this.now()) {
      await this.sessions.clear();
      return "locked";
    }
    return "unlocked";
  }

  async setup(masterPassword: string, initialItems: VaultItem[] = []): Promise<VaultState> {
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
  }

  async unlock(masterPassword: string): Promise<VaultState> {
    const envelope = await this.requireEnvelope();
    try {
      const { key } = await deriveVaultKey(masterPassword, envelope.kdf);
      const state = await decryptVaultState(envelope, key);
      await this.startSession(key, state.settings.autoLockMinutes);
      return state;
    } catch {
      await this.sessions.clear();
      throw new VaultUnlockError();
    }
  }

  async lock(): Promise<void> {
    await this.sessions.clear();
  }

  async readState(): Promise<VaultState> {
    const { envelope, key } = await this.unlockedContext();
    const state = await decryptVaultState(envelope, key);
    await this.touchSession(state.settings.autoLockMinutes);
    return state;
  }

  async listItems(): Promise<VaultItem[]> {
    return (await this.readState()).items.filter((item) => !item.deletedAt);
  }

  async getItem(itemId: string): Promise<VaultItem | undefined> {
    return (await this.readState()).items.find((item) => item.id === itemId && !item.deletedAt);
  }

  async upsertItem(item: VaultItem): Promise<VaultItem> {
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
    state.updatedAt = now;
    await this.persist(state, key, envelope.kdf);
    return normalized;
  }

  async deleteItem(itemId: string): Promise<void> {
    const { state, envelope, key } = await this.mutableContext();
    const now = new Date(this.now()).toISOString();
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    state.items = state.items.map((candidate) => (candidate.id === itemId ? { ...candidate, deletedAt: now, updatedAt: now } : candidate)) as VaultItem[];
    state.updatedAt = now;
    await this.persist(state, key, envelope.kdf);
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

function validateMasterPassword(value: string): void {
  if (value.length < 10) throw new Error("主密码至少需要 10 个字符。");
}
