export interface VaultSessionRecord {
  rawKey: string;
  lastActivityAt: number;
  expiresAt: number;
}

export interface VaultSessionStore {
  read(): Promise<VaultSessionRecord | null>;
  write(session: VaultSessionRecord): Promise<void>;
  clear(): Promise<void>;
}

export class ChromeVaultSessionStore implements VaultSessionStore {
  private readonly key = "monica.secureVault.session.v1";

  async read(): Promise<VaultSessionRecord | null> {
    const result = await chrome.storage.session.get(this.key);
    const value = result[this.key] as VaultSessionRecord | undefined;
    return value && typeof value.rawKey === "string" ? value : null;
  }

  async write(session: VaultSessionRecord): Promise<void> {
    await chrome.storage.session.set({ [this.key]: session });
  }

  async clear(): Promise<void> {
    await chrome.storage.session.remove(this.key);
  }
}

export class MemoryVaultSessionStore implements VaultSessionStore {
  session: VaultSessionRecord | null = null;

  async read(): Promise<VaultSessionRecord | null> {
    return this.session ? { ...this.session } : null;
  }

  async write(session: VaultSessionRecord): Promise<void> {
    this.session = { ...session };
  }

  async clear(): Promise<void> {
    this.session = null;
  }
}
