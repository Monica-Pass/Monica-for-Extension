export interface VaultDeviceKeyStore {
  read(keyId: string): Promise<string | null>;
  write(keyId: string, rawKey: string): Promise<void>;
  remove(keyId: string): Promise<void>;
  isAutoUnlockSuspended(): Promise<boolean>;
  setAutoUnlockSuspended(suspended: boolean): Promise<void>;
}

export class ChromeVaultDeviceKeyStore implements VaultDeviceKeyStore {
  private readonly prefix = "monica.secureVault.deviceKey.v1.";
  private readonly suspendedKey = "monica.secureVault.deviceKey.suspended.v1";

  async read(keyId: string): Promise<string | null> {
    const storageKey = this.prefix + keyId;
    const result = await chrome.storage.local.get(storageKey);
    return typeof result[storageKey] === "string" ? result[storageKey] as string : null;
  }

  async write(keyId: string, rawKey: string): Promise<void> {
    await chrome.storage.local.set({ [this.prefix + keyId]: rawKey });
  }

  async remove(keyId: string): Promise<void> {
    await chrome.storage.local.remove(this.prefix + keyId);
  }

  async isAutoUnlockSuspended(): Promise<boolean> {
    const result = await chrome.storage.session.get(this.suspendedKey);
    return result[this.suspendedKey] === true;
  }

  async setAutoUnlockSuspended(suspended: boolean): Promise<void> {
    if (suspended) await chrome.storage.session.set({ [this.suspendedKey]: true });
    else await chrome.storage.session.remove(this.suspendedKey);
  }
}

export class MemoryVaultDeviceKeyStore implements VaultDeviceKeyStore {
  readonly keys = new Map<string, string>();
  suspended = false;

  async read(keyId: string): Promise<string | null> { return this.keys.get(keyId) || null; }
  async write(keyId: string, rawKey: string): Promise<void> { this.keys.set(keyId, rawKey); }
  async remove(keyId: string): Promise<void> { this.keys.delete(keyId); }
  async isAutoUnlockSuspended(): Promise<boolean> { return this.suspended; }
  async setAutoUnlockSuspended(suspended: boolean): Promise<void> { this.suspended = suspended; }
}
