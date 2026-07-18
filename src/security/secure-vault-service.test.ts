import { describe, expect, it } from "vitest";
import { createEmptyVaultState, createLoginItem, type VaultItem, type VaultState } from "../core/model";
import { decryptVaultState, deriveVaultKey, encryptVaultState, type Pbkdf2VaultKdfParameters } from "./vault-crypto";
import { MemoryVaultSessionStore } from "./vault-session";
import { SecureVaultService, VaultLockedError, VaultUnlockError } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultDeviceKeyStore } from "./vault-device-key";

describe("encrypted vault", () => {
  it("encrypts secrets and rejects the wrong password", async () => {
    const storage = new MemoryVaultStorage();
    const sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions);
    const login = createLoginItem({ title: "Example", username: "joy", password: "super-secret-value", uris: ["example.com"] });
    await service.setup("a strong master password", [login]);
    expect(storage.envelope?.kdf).toMatchObject({ name: "ARGON2ID", memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 });

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
    const publicConfig = (await service.listProviders()).find((provider) => provider.id === "webdav-1")?.config;
    expect(publicConfig).toMatchObject({
      baseUrl: "https://cloud.example.com/private-dav",
      username: "webdav-user",
      passwordConfigured: true,
      backupPasswordConfigured: true
    });
    expect(JSON.stringify(publicConfig)).not.toMatch(/webdav-secret|android-backup-secret/);

    const returned = await service.upsertProvider({
      id: "bitwarden-1",
      kind: "bitwarden",
      name: "Bitwarden",
      enabled: true,
      isDefaultSaveTarget: false,
      config: {
        vaultUrl: "https://vault.bitwarden.com",
        email: "joy@example.com",
        accessToken: "bitwarden-access-secret",
        refreshToken: "bitwarden-refresh-secret",
        vaultKeyEnc: "vault-key-secret"
      }
    });
    expect(returned.config).toMatchObject({ vaultUrl: "https://vault.bitwarden.com", email: "joy@example.com", authenticated: true });
    expect(JSON.stringify(await service.listProviders())).not.toMatch(/bitwarden-access-secret|bitwarden-refresh-secret|vault-key-secret/);
  });

  it("accepts four-character master passwords and rejects shorter values", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await expect(service.setup("abc")).rejects.toThrow("至少需要 4 个字符");
    await expect(service.setup("abcd")).resolves.toMatchObject({ magic: "MONICA_EXTENSION_VAULT" });
    await expect(new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore()).setup("x".repeat(1_025))).rejects.toThrow("不能超过 1024 个字符");
  });

  it("stores support diagnostics encrypted and exports a redacted bounded document", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("diagnostic master password");
    await service.upsertProvider({
      id: "legacy-provider",
      kind: "bitwarden",
      name: "Legacy provider",
      enabled: true,
      isDefaultSaveTarget: false,
      config: {},
      lastError: "token=legacy-secret https://legacy.private.example/path"
    });
    expect((await service.listProviders()).find((provider) => provider.id === "legacy-provider")?.lastError).not.toMatch(/legacy-secret|legacy\.private/);

    await service.recordProviderDiagnostic({
      at: "2026-07-15T13:00:00.000Z",
      providerRef: "provider-deadbeef",
      kind: "bitwarden",
      operation: "sync",
      outcome: "failure",
      code: "authentication",
      status: 401,
      retryable: false,
      attempts: 1,
      durationMs: 42,
      message: "token=must-not-export https://private.example/path"
    });

    const exported = await service.exportProviderDiagnostics();
    expect(exported).toMatchObject({ magic: "MONICA_PROVIDER_DIAGNOSTICS", version: 1, diagnostics: [expect.objectContaining({ providerRef: "provider-deadbeef", status: 401, durationMs: 42 })] });
    expect(JSON.stringify(exported)).not.toMatch(/must-not-export|private\.example/);
    expect(JSON.stringify(storage.envelope)).not.toContain("provider-deadbeef");
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
    await expect(decryptVaultState(envelope, key)).resolves.toMatchObject({ magic: "MONICA_EXTENSION_VAULT", schemaVersion: 2 });
  });

  it("migrates a valid legacy PBKDF2 vault to Argon2id on unlock without changing its data", async () => {
    const storage = new MemoryVaultStorage();
    const sessions = new MemoryVaultSessionStore();
    const state = createEmptyVaultState();
    state.items = [createLoginItem({ title: "Legacy", username: "joy", password: "legacy-secret", uris: ["example.com"] })];
    const legacyKdf: Pbkdf2VaultKdfParameters = { name: "PBKDF2-SHA256", iterations: 600_000, salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" };
    const legacy = await deriveVaultKey("legacy migration password", legacyKdf);
    storage.envelope = await encryptVaultState(state, legacy.key, legacy.kdf);

    const service = new SecureVaultService(storage, sessions);
    await expect(service.unlock("legacy migration password")).resolves.toMatchObject({ items: [expect.objectContaining({ password: "legacy-secret" })] });
    expect(storage.envelope?.kdf).toMatchObject({ name: "ARGON2ID", memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 });
    await service.lock();
    await expect(service.unlock("legacy migration password")).resolves.toMatchObject({ items: [expect.objectContaining({ title: "Legacy" })] });
  });

  it("keeps a legacy vault usable when its best-effort KDF migration cannot be committed", async () => {
    const storage = new FlakyMemoryVaultStorage();
    const sessions = new MemoryVaultSessionStore();
    const state = createEmptyVaultState();
    state.items = [createLoginItem({ title: "Fallback", password: "still-readable", uris: ["example.com"] })];
    const legacyKdf: Pbkdf2VaultKdfParameters = { name: "PBKDF2-SHA256", iterations: 600_000, salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" };
    const legacy = await deriveVaultKey("legacy fallback password", legacyKdf);
    storage.envelope = await encryptVaultState(state, legacy.key, legacy.kdf);
    storage.failNextWrite = true;

    const service = new SecureVaultService(storage, sessions);
    await expect(service.unlock("legacy fallback password")).resolves.toMatchObject({ items: [expect.objectContaining({ password: "still-readable" })] });
    expect(storage.envelope?.kdf.name).toBe("PBKDF2-SHA256");
    await expect(service.readState()).resolves.toMatchObject({ items: [expect.objectContaining({ title: "Fallback" })] });
  });

  it("migrates a pre-conflict schema-v1 envelope without weakening validation", async () => {
    const state = await new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore()).setup("legacy schema password");
    const legacy = structuredClone(state) as Partial<VaultState>;
    delete legacy.providerConflicts;
    delete legacy.providerDiagnostics;
    const { key, kdf } = await deriveVaultKey("legacy schema password");
    const envelope = await encryptVaultState(legacy as VaultState, key, kdf);

    await expect(decryptVaultState(envelope, key)).resolves.toMatchObject({ providerConflicts: [], providerDiagnostics: [] });
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

  it("keeps conflicted mutations and both encrypted versions until explicit resolution", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("conflict retention password");
    await service.upsertProvider({ id: "bw", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} });
    const baseline = createLoginItem({ title: "Conflict", password: "baseline-secret", uris: ["example.com"], providerRefs: [{ providerId: "bw", remoteId: "cipher-1", revision: "2026-07-15T01:00:00.000Z" }] });
    const local = await service.upsertItem({ ...baseline, password: "local-conflict-secret" });
    const remote = { ...local, password: "remote-conflict-secret", updatedAt: "2026-07-15T02:00:00.000Z" };

    await service.applyProviderSync("bw", [local], { lastError: "发现冲突" }, [{ itemId: local.id, reason: "双方均已修改", local, remote }]);

    const state = await service.readState();
    expect(state.mutationQueue).toEqual([expect.objectContaining({ providerId: "bw", itemId: local.id, lastError: "双方均已修改" })]);
    expect(state.providerConflicts).toEqual([expect.objectContaining({ providerId: "bw", itemId: local.id, local: expect.objectContaining({ password: "local-conflict-secret" }), remote: expect.objectContaining({ password: "remote-conflict-secret" }) })]);
    expect(JSON.stringify(storage.envelope)).not.toMatch(/local-conflict-secret|remote-conflict-secret/);
  });

  it("atomically resolves a conflict by keeping the latest local copy", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("keep local conflict password");
    await service.upsertProvider({ id: "webdav", kind: "monica-webdav", name: "WebDAV", enabled: true, isDefaultSaveTarget: false, config: {} });
    const baseline = createLoginItem({ title: "Conflict", password: "baseline", uris: ["example.com"], providerRefs: [{ providerId: "webdav", remoteId: "42", revision: "2026-07-15T01:00:00.000Z" }] });
    const local = await service.upsertItem({ ...baseline, password: "local-newer" });
    const remote = { ...local, password: "remote-newer", updatedAt: "2026-07-15T02:00:00.000Z" };
    await service.applyProviderSync("webdav", [local], { lastError: "发现冲突" }, [{ itemId: local.id, reason: "双方均已修改", local, remote }]);
    const conflict = (await service.listProviderConflicts("webdav"))[0];

    await service.resolveProviderConflict(conflict.id, "keep-local");

    const state = await service.readState();
    expect(state.providerConflicts).toEqual([]);
    expect(state.items[0]).toMatchObject({ password: "local-newer", providerRefs: [expect.objectContaining({ remoteId: "42", revision: remote.updatedAt })] });
    expect(state.mutationQueue).toEqual([expect.objectContaining({ itemId: local.id, operation: "update", attempts: 0 })]);
    expect(state.mutationQueue[0]).not.toHaveProperty("lastError");
    expect(state.providers.find((provider) => provider.id === "webdav")?.lastError).toBeUndefined();
  });

  it("atomically resolves a conflict by accepting the remote copy", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("use remote conflict password");
    await service.upsertProvider({ id: "bw", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} });
    const baseline = createLoginItem({ title: "Conflict", password: "baseline", uris: ["example.com"], providerRefs: [{ providerId: "bw", remoteId: "cipher-1", revision: "2026-07-15T01:00:00.000Z" }] });
    const local = await service.upsertItem({ ...baseline, password: "local-newer" });
    const remote = { ...local, password: "remote-winner", updatedAt: "2026-07-15T02:00:00.000Z" };
    await service.applyProviderSync("bw", [local], { lastError: "发现冲突" }, [{ itemId: local.id, reason: "双方均已修改", local, remote }]);
    const conflict = (await service.listProviderConflicts("bw"))[0];

    await service.resolveProviderConflict(conflict.id, "use-remote");

    const state = await service.readState();
    expect(state.providerConflicts).toEqual([]);
    expect(state.items[0]).toMatchObject({ password: "remote-winner", updatedAt: remote.updatedAt });
    expect(state.mutationQueue).toEqual([]);
  });

  it("turns keep-local after a remote deletion into a safe create", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("remote deletion conflict password");
    await service.upsertProvider({ id: "bw", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} });
    const baseline = createLoginItem({ title: "Deleted remotely", password: "local", uris: ["example.com"], providerRefs: [{ providerId: "bw", remoteId: "deleted-cipher", revision: "2026-07-15T01:00:00.000Z" }] });
    const local = await service.upsertItem({ ...baseline, password: "local-newer" });
    await service.applyProviderSync("bw", [local], { lastError: "发现冲突" }, [{ itemId: local.id, reason: "远端已删除", local }]);
    const conflict = (await service.listProviderConflicts("bw"))[0];

    await service.resolveProviderConflict(conflict.id, "keep-local");

    const state = await service.readState();
    expect(state.items[0].providerRefs[0]).toEqual({ providerId: "bw" });
    expect(state.mutationQueue).toEqual([expect.objectContaining({ operation: "create", itemId: local.id })]);
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

    expect("salt" in storage.envelope!.kdf && "salt" in previousEnvelope.kdf && storage.envelope!.kdf.salt).not.toBe("salt" in previousEnvelope.kdf ? previousEnvelope.kdf.salt : undefined);
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

  it("upgrades a restored legacy PBKDF2 backup before persisting it locally", async () => {
    const state = createEmptyVaultState();
    state.items = [createLoginItem({ title: "Legacy backup", password: "backup-secret", uris: ["example.com"] })];
    const legacyKdf: Pbkdf2VaultKdfParameters = { name: "PBKDF2-SHA256", iterations: 600_000, salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" };
    const legacy = await deriveVaultKey("legacy backup password", legacyKdf);
    const envelope = await encryptVaultState(state, legacy.key, legacy.kdf);
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());

    await expect(service.restoreEncryptedBackup({ magic: "MONICA_EXTENSION_BACKUP", version: 1, exportedAt: "2026-07-15T00:00:00.000Z", envelope }, "legacy backup password"))
      .resolves.toMatchObject({ items: [expect.objectContaining({ password: "backup-secret" })] });
    expect(storage.envelope?.kdf.name).toBe("ARGON2ID");
    await service.lock();
    await expect(service.unlock("legacy backup password")).resolves.toMatchObject({ items: [expect.objectContaining({ title: "Legacy backup" })] });
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

  it("supports an optional master password with a session-aware device key", async () => {
    const storage = new MemoryVaultStorage();
    const deviceKeys = new MemoryVaultDeviceKeyStore();
    const sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions, () => Date.now(), deviceKeys);

    const setup = await service.setup("", [createLoginItem({ title: "Device vault" })]);
    expect(setup.settings.protectionMode).toBe("device-key");
    expect(storage.envelope?.kdf.name).toBe("DEVICE-KEY");
    expect(JSON.stringify(storage.envelope)).not.toContain("Device vault");

    await service.lock();
    await expect(service.status()).resolves.toBe("locked");
    await expect(service.unlock("")).resolves.toMatchObject({ settings: { protectionMode: "device-key" } });

    const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore(), () => Date.now(), deviceKeys);
    await deviceKeys.setAutoUnlockSuspended(false);
    await expect(restarted.status()).resolves.toBe("unlocked");
  });

  it("stores provider source records inside the encrypted vault without returning them from item APIs", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("source record password");
    await service.upsertProvider({ id: "webdav-source", kind: "monica-webdav", name: "WebDAV", enabled: true, isDefaultSaveTarget: false, config: {} });
    const item = createLoginItem({ title: "Source item", password: "item-secret", uris: ["example.test"] });
    const sourceRecord = { providerId: "webdav-source", itemId: item.id, remoteId: "folders/_root/passwords/item.json", format: "android-entry" as const, encoding: "base64" as const, payload: "cmF3LXByb3ZpZGVyLXNlY3JldA==", contentHash: "hash" };

    await service.applyProviderSync("webdav-source", [item], undefined, [], [sourceRecord]);

    expect(JSON.stringify(storage.envelope)).not.toContain(sourceRecord.payload);
    expect(await service.getProviderSourceRecords("webdav-source")).toEqual([sourceRecord]);
    expect(JSON.stringify(await service.listItems())).not.toContain(sourceRecord.payload);
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
