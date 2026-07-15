import { describe, expect, it } from "vitest";
import { createLoginItem, type VaultItem } from "../core/model";
import { decryptVaultState, deriveVaultKey, encryptVaultState } from "./vault-crypto";
import { MemoryVaultSessionStore } from "./vault-session";
import { SecureVaultService, VaultLockedError, VaultUnlockError } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";

describe("encrypted vault", () => {
  it("encrypts secrets and rejects the wrong password", async () => {
    const storage = new MemoryVaultStorage();
    const sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions);
    const login = createLoginItem({ title: "Example", username: "joy", password: "super-secret-value", uris: ["example.com"] });
    await service.setup("a strong master password", [login]);

    const serializedEnvelope = JSON.stringify(storage.envelope);
    expect(serializedEnvelope).not.toContain("super-secret-value");
    expect(serializedEnvelope).not.toContain("joy");

    await service.lock();
    await expect(service.unlock("wrong password")).rejects.toBeInstanceOf(VaultUnlockError);
    expect((await service.unlock("a strong master password")).items[0]).toMatchObject({ kind: "login", password: "super-secret-value" });
  });

  it("requires an active session for CRUD and automatically expires it", async () => {
    let now = 1_700_000_000_000;
    const storage = new MemoryVaultStorage();
    const sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions, () => now);
    await service.setup("another strong password");
    const login = createLoginItem({ title: "Account", password: "secret", uris: ["example.com"] });
    await service.upsertItem(login);
    expect(await service.listItems()).toHaveLength(1);

    now += 16 * 60_000;
    expect(await service.status()).toBe("locked");
    await expect(service.listItems()).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("keeps provider credentials inside the encrypted envelope", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("provider master password");
    await service.upsertProvider({
      id: "webdav-1",
      kind: "monica-webdav",
      name: "Android WebDAV",
      enabled: true,
      isDefaultSaveTarget: false,
      config: {
        baseUrl: "https://cloud.example.com/private-dav",
        username: "webdav-user",
        password: "webdav-secret",
        backupPassword: "android-backup-secret"
      }
    });

    const serializedEnvelope = JSON.stringify(storage.envelope);
    expect(serializedEnvelope).not.toContain("webdav-secret");
    expect(serializedEnvelope).not.toContain("android-backup-secret");
    expect((await service.listProviders()).find((provider) => provider.id === "webdav-1")?.config).toMatchObject({ password: "webdav-secret", backupPassword: "android-backup-secret" });
  });

  it("restores the local default and removes provider-only cache when disconnecting", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("disconnect master password");
    await service.upsertProvider({
      id: "webdav-1",
      kind: "monica-webdav",
      name: "Android WebDAV",
      enabled: true,
      isDefaultSaveTarget: true,
      config: { baseUrl: "https://cloud.example.com/dav", username: "", password: "" }
    });
    const login = createLoginItem({ title: "Synced", password: "secret", uris: ["example.com"], providerRefs: [{ providerId: "webdav-1", remoteId: "remote.json" }] });
    await service.upsertItem(login);
    await service.removeProvider("webdav-1");

    expect(await service.listItems()).toEqual([]);
    const providers = await service.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ kind: "local", isDefaultSaveTarget: true });
    expect((await service.readState()).settings.defaultProviderId).toBe(providers[0].id);
  });

  it("round-trips an envelope with its derived key", async () => {
    const state = (await new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore()).setup("0123456789-master"));
    const { key, kdf } = await deriveVaultKey("0123456789-master");
    const envelope = await encryptVaultState(state, key, kdf);
    await expect(decryptVaultState(envelope, key)).resolves.toMatchObject({ magic: "MONICA_EXTENSION_VAULT", schemaVersion: 1 });
  });

  it("queues external mutations, caps failed attempts, and clears them after sync", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("mutation queue password");
    await service.upsertProvider({ id: "bw", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} });
    const login = createLoginItem({ title: "Queued", password: "secret", uris: ["example.com"], providerRefs: [{ providerId: "bw" }] });
    await service.upsertItem(login);
    expect((await service.readState()).mutationQueue).toEqual([expect.objectContaining({ providerId: "bw", itemId: login.id, operation: "create", attempts: 0 })]);
    for (let attempt = 0; attempt < 7; attempt += 1) await service.markProviderSyncFailure("bw", "offline");
    expect((await service.readState()).mutationQueue[0]).toMatchObject({ attempts: 5, lastError: "offline" });
    await service.applyProviderSync("bw", [login], { lastSyncAt: new Date().toISOString(), lastError: undefined });
    expect((await service.readState()).mutationQueue).toEqual([]);
  });

  it("serializes concurrent mutations so accepted updates cannot overwrite each other", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("concurrent mutation password");
    const first = createLoginItem({ title: "First", password: "first-secret", uris: ["first.example.com"] });
    const second = createLoginItem({ title: "Second", password: "second-secret", uris: ["second.example.com"] });

    await Promise.all([service.upsertItem(first), service.upsertItem(second)]);

    expect((await service.listItems()).map((item) => item.title).sort()).toEqual(["First", "Second"]);
  });

  it("continues processing later mutations after a storage failure", async () => {
    const storage = new FlakyMemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("recovering mutation queue password");
    storage.failNextWrite = true;
    await expect(service.upsertItem(createLoginItem({ title: "Rejected", password: "secret", uris: ["rejected.example.com"] }))).rejects.toThrow("simulated write failure");

    await service.upsertItem(createLoginItem({ title: "Accepted", password: "secret", uris: ["accepted.example.com"] }));

    expect((await service.listItems()).map((item) => item.title)).toEqual(["Accepted"]);
  });

  it("rotates the master password with a fresh KDF while preserving the complete vault", async () => {
    const storage = new MemoryVaultStorage();
    const sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions);
    const login = createLoginItem({ title: "Preserved", username: "joy", password: "vault-secret", uris: ["example.com"] });
    await service.setup("old master password", [login]);
    await service.upsertProvider({ id: "webdav", kind: "monica-webdav", name: "WebDAV", enabled: true, isDefaultSaveTarget: false, config: { password: "provider-secret" } });
    const previousEnvelope = structuredClone(storage.envelope!);
    const previousSessionKey = sessions.session!.rawKey;

    await service.changeMasterPassword("old master password", "new master password");

    expect(storage.envelope!.kdf.salt).not.toBe(previousEnvelope.kdf.salt);
    expect(storage.envelope!.ciphertext).not.toBe(previousEnvelope.ciphertext);
    expect(JSON.stringify(storage.envelope)).not.toContain("vault-secret");
    expect(sessions.session!.rawKey).not.toBe(previousSessionKey);
    await service.lock();
    await expect(service.unlock("old master password")).rejects.toBeInstanceOf(VaultUnlockError);
    const restored = await service.unlock("new master password");
    expect(restored.items[0]).toMatchObject({ title: "Preserved", password: "vault-secret" });
    expect(restored.providers.find((provider) => provider.id === "webdav")?.config).toMatchObject({ password: "provider-secret" });
  });

  it("leaves the existing envelope unchanged when password rotation verification or storage fails", async () => {
    const storage = new FlakyMemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("stable master password", [createLoginItem({ title: "Stable", password: "secret", uris: ["example.com"] })]);
    const original = structuredClone(storage.envelope!);

    await expect(service.changeMasterPassword("wrong current password", "replacement password")).rejects.toBeInstanceOf(VaultUnlockError);
    expect(storage.envelope).toEqual(original);
    storage.failNextWrite = true;
    await expect(service.changeMasterPassword("stable master password", "replacement password")).rejects.toThrow("simulated write failure");
    expect(storage.envelope).toEqual(original);
    await service.lock();
    await expect(service.unlock("stable master password")).resolves.toBeTruthy();
  });

  it("exports and restores a complete encrypted vault without exposing provider or item secrets", async () => {
    const sourceStorage = new MemoryVaultStorage();
    const source = new SecureVaultService(sourceStorage, new MemoryVaultSessionStore());
    await source.setup("backup master password", [createLoginItem({ title: "Recovered", password: "item-secret", uris: ["example.com"] })]);
    await source.upsertProvider({ id: "webdav", kind: "monica-webdav", name: "WebDAV", enabled: true, isDefaultSaveTarget: true, config: { password: "provider-secret" } });

    const backup = await source.exportEncryptedBackup();
    expect(backup).toMatchObject({ magic: "MONICA_EXTENSION_BACKUP", version: 1 });
    expect(JSON.stringify(backup)).not.toContain("item-secret");
    expect(JSON.stringify(backup)).not.toContain("provider-secret");

    const targetStorage = new MemoryVaultStorage();
    const target = new SecureVaultService(targetStorage, new MemoryVaultSessionStore());
    const restored = await target.restoreEncryptedBackup(backup, "backup master password");
    expect(restored.items[0]).toMatchObject({ title: "Recovered", password: "item-secret" });
    expect(restored.providers.find((provider) => provider.id === "webdav")).toMatchObject({ isDefaultSaveTarget: true, config: { password: "provider-secret" } });
    expect(restored.settings.defaultProviderId).toBe("webdav");
    await target.lock();
    await expect(target.unlock("backup master password")).resolves.toMatchObject({ magic: "MONICA_EXTENSION_VAULT" });
  });

  it("authenticates the complete restore candidate before replacing any existing vault", async () => {
    const source = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await source.setup("source backup password", [createLoginItem({ title: "Source", password: "source-secret", uris: ["source.example.com"] })]);
    const backup = await source.exportEncryptedBackup();
    const targetStorage = new MemoryVaultStorage();
    const target = new SecureVaultService(targetStorage, new MemoryVaultSessionStore());
    await target.setup("target current password", [createLoginItem({ title: "Target", password: "target-secret", uris: ["target.example.com"] })]);
    const original = structuredClone(targetStorage.envelope!);

    await expect(target.restoreEncryptedBackup(backup, "wrong backup password", { replaceExisting: true, currentPassword: "target current password" })).rejects.toBeInstanceOf(VaultUnlockError);
    expect(targetStorage.envelope).toEqual(original);
    await expect(target.restoreEncryptedBackup(backup, "source backup password", { replaceExisting: true, currentPassword: "wrong current password" })).rejects.toBeInstanceOf(VaultUnlockError);
    expect(targetStorage.envelope).toEqual(original);
    await expect(target.restoreEncryptedBackup(backup, "source backup password")).rejects.toThrow("已存在");
    expect(targetStorage.envelope).toEqual(original);

    const restored = await target.restoreEncryptedBackup(backup, "source backup password", { replaceExisting: true, currentPassword: "target current password" });
    expect(restored.items.map((item) => item.title)).toEqual(["Source"]);
  });

  it("imports multiple items as one encrypted commit", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("atomic import password");
    const first = createLoginItem({ title: "First import", password: "first", uris: ["first.example.com"] });
    const invalid = { id: "invalid" } as VaultItem;

    await expect(service.importItems([first, invalid])).rejects.toThrow("导入项目");
    expect(await service.listItems()).toEqual([]);
    const second = createLoginItem({ title: "Second import", password: "second", uris: ["second.example.com"] });
    await service.importItems([first, second]);
    expect((await service.listItems()).map((item) => item.title).sort()).toEqual(["First import", "Second import"]);
  });
});

class FlakyMemoryVaultStorage extends MemoryVaultStorage {
  failNextWrite = false;

  override async write(envelope: NonNullable<MemoryVaultStorage["envelope"]>): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("simulated write failure");
    }
    await super.write(envelope);
  }
}
