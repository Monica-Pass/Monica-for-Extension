import { describe, expect, it, vi } from "vitest";
import { createEmptyVaultState, createLoginItem, type LoginItem, type VaultItem, type VaultState } from "../core/model";
import { MAX_SOURCE_RECORD_PAYLOAD_BYTES } from "../core/source-records";
import { decryptVaultState, deriveVaultKey, encryptVaultState, type Pbkdf2VaultKdfParameters } from "./vault-crypto";
import { MemoryVaultSessionStore } from "./vault-session";
import { SecureVaultService, VaultLockedError, VaultUnlockError } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultDeviceKeyStore } from "./vault-device-key";
import { MonicaWebDavProvider } from "../providers/webdav/monica-webdav-provider";

describe("encrypted vault", () => {
  it("keeps a durable mutation successful when only session activity refresh fails", async () => {
    class FailingRefreshSessionStore extends MemoryVaultSessionStore {
      private writes = 0;

      override async write(session: Parameters<MemoryVaultSessionStore["write"]>[0]): Promise<void> {
        this.writes += 1;
        if (this.writes === 2) throw new Error("session refresh failed");
        await super.write(session);
      }
    }

    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new FailingRefreshSessionStore());
    await service.setup("durable mutation password");
    const login = createLoginItem({ title: "Durable", password: "secret", uris: ["example.com"] });
    await expect(service.upsertItem(login)).resolves.toMatchObject({ id: login.id });
    expect((await service.readState()).items).toEqual([expect.objectContaining({ id: login.id })]);
  });

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

    const keePass = await service.upsertProvider({
      id: "keepass-1",
      kind: "keepass",
      name: "KeePass",
      enabled: true,
      isDefaultSaveTarget: false,
      config: {
        fileName: "personal.kdbx",
        protectionMode: "password-and-key-file",
        password: "keepass-password-secret",
        keyFile: "keepass-key-secret"
      }
    });
    expect(keePass.config).toEqual({ fileName: "personal.kdbx", protectionMode: "password-and-key-file" });
    expect(JSON.stringify(await service.listProviders())).not.toMatch(/keepass-password-secret|keepass-key-secret/);
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

    const backup = await source.exportEncryptedBackup("backup master password");
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
    const backup = await source.exportEncryptedBackup("source backup password");
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

  it("merges a provider result against its snapshot so interleaved local changes are never overwritten", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("snapshot merge password");
    await service.upsertProvider({ id: "bw", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} });
    const first = createLoginItem({ title: "First", password: "before", uris: ["first.example"], providerRefs: [{ providerId: "bw", remoteId: "first" }] });
    const removed = createLoginItem({ title: "Removed", password: "before", uris: ["removed.example"], providerRefs: [{ providerId: "bw", remoteId: "removed" }] });
    const untouched = createLoginItem({ title: "Untouched", password: "before", uris: ["untouched.example"], providerRefs: [{ providerId: "bw", remoteId: "untouched" }] });
    await service.applyProviderSync("bw", [first, removed, untouched]);
    const snapshot = (await service.readState()).items;

    await service.upsertItem({ ...first, password: "local edit" });
    await service.deleteItem(removed.id);
    const added = await service.upsertItem(createLoginItem({ title: "Added during sync", password: "new", uris: ["new.example"], providerRefs: [{ providerId: "bw" }] }));
    const remoteFirst = { ...first, password: "remote edit", updatedAt: "2026-07-26T00:00:00.000Z" };
    const remoteUntouched = { ...untouched, title: "Remote update", updatedAt: "2026-07-26T00:00:00.000Z" };

    await service.applyProviderSync("bw", [remoteFirst, remoteUntouched], undefined, [], undefined, snapshot);

    const state = await service.readState();
    expect(state.items.find((item) => item.id === first.id)).toMatchObject({ password: "local edit" });
    expect(state.items.find((item) => item.id === removed.id)).toBeUndefined();
    expect(state.items.find((item) => item.id === added.id)).toMatchObject({ title: "Added during sync" });
    expect(state.items.find((item) => item.id === untouched.id)).toMatchObject({ title: "Remote update" });
    expect(state.mutationQueue).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: first.id, providerId: "bw" }),
      expect.objectContaining({ itemId: added.id, providerId: "bw" })
    ]));
    expect(state.providerConflicts.find((conflict) => conflict.itemId === first.id)).toMatchObject({ local: { password: "local edit" }, remote: { password: "remote edit" } });
    expect(state.providerConflicts.find((conflict) => conflict.itemId === removed.id)).toBeUndefined();
  });

  it("keeps a local edit made during Bitwarden creation under its original Monica ID", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("create acknowledgement password");
    await service.upsertProvider({ id: "bw", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} });
    const created = await service.upsertItem(createLoginItem({ title: "Created", password: "before", uris: ["created.example"], providerRefs: [{ providerId: "bw" }] })) as LoginItem;
    const snapshot = structuredClone((await service.readState()).items);
    const edited = await service.upsertItem({ ...created, password: "edited before create completed" });
    const acknowledged = { ...created, updatedAt: "2026-07-26T00:00:00.000Z", providerRefs: [{ providerId: "bw", remoteId: "remote-created", revision: "2026-07-26T00:00:00.000Z" }] };

    const summary = await service.applyProviderSync("bw", [acknowledged], undefined, [], undefined, snapshot);
    const state = await service.readState();
    expect(summary.conflicts).toBe(0);
    expect(state.items.find((item) => item.id === edited.id)).toMatchObject({ password: "edited before create completed", providerRefs: [expect.objectContaining({ remoteId: "remote-created" })] });
    expect(state.mutationQueue).toEqual([expect.objectContaining({ itemId: edited.id, operation: "update" })]);
  });

  it("turns create acknowledgement during a local delete into a remote delete mutation", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("create then delete password");
    await service.upsertProvider({ id: "bw", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} });
    const created = await service.upsertItem(createLoginItem({ title: "Created then deleted", password: "before", uris: ["created-deleted.example"], providerRefs: [{ providerId: "bw" }] })) as LoginItem;
    const snapshot = structuredClone((await service.readState()).items);
    await service.deleteItem(created.id);
    const acknowledged = {
      ...created,
      updatedAt: "2026-07-26T00:00:00.000Z",
      providerRefs: [{ providerId: "bw", remoteId: "remote-created-then-deleted", revision: "2026-07-26T00:00:00.000Z" }]
    };

    const summary = await service.applyProviderSync("bw", [acknowledged], undefined, [], undefined, snapshot);
    const state = await service.readState();
    const tombstone = state.items.find((item) => item.id === created.id);
    expect(summary.conflicts).toBe(0);
    expect(tombstone?.deletedAt).toBeTruthy();
    expect(tombstone?.providerRefs).toEqual([expect.objectContaining({ remoteId: "remote-created-then-deleted" })]);
    expect(state.mutationQueue).toEqual([expect.objectContaining({ itemId: created.id, operation: "delete" })]);
  });

  it("keeps the service baseline immutable through a real first WebDAV creation sync", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("webdav first creation password");
    const account = { id: "webdav", kind: "monica-webdav" as const, name: "WebDAV", enabled: true, isDefaultSaveTarget: false, config: { baseUrl: "https://cloud.example/dav", username: "user", password: "secret" } };
    await service.upsertProvider(account);
    const local = await service.upsertItem(createLoginItem({ title: "First WebDAV item", password: "secret", uris: ["webdav.example"], providerRefs: [{ providerId: account.id }] }));
    const snapshot = structuredClone((await service.readState()).items);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || "GET";
      const headers = new Headers(init?.headers);
      if (method === "PROPFIND" && headers.get("Depth") === "1") return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>`, { status: 207 });
      if (method === "PROPFIND") return new Response(null, { status: 207 });
      if (method === "PUT") return new Response(null, { status: 201, headers: { etag: '"created"' } });
      throw new Error(`Unexpected ${method}`);
    }) as unknown as typeof fetch;

    const result = await new MonicaWebDavProvider(fetcher).sync(account, { now: "2026-07-26T00:00:00.000Z", localItems: structuredClone(snapshot) });
    expect(snapshot.find((item) => item.id === local.id)?.providerRefs[0]?.remoteId).toBeUndefined();
    await service.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, snapshot);
    expect((await service.readState()).items.find((item) => item.id === local.id)?.providerRefs[0]).toMatchObject({ remoteId: local.id, etag: '"created"' });
  });

  it("reports the persisted merge conflict count and retains a non-deleted local item missing remotely", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("persisted conflict count password");
    await service.upsertProvider({ id: "bw", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} });
    const item = createLoginItem({ title: "Missing", password: "secret", uris: ["missing.example"], providerRefs: [{ providerId: "bw", remoteId: "missing", revision: "2026-01-01T00:00:00.000Z" }] });
    await service.applyProviderSync("bw", [item]);
    const summary = await service.applyProviderSync("bw", [], undefined, [], undefined, structuredClone((await service.readState()).items));
    expect(summary.conflicts).toBe(1);
    expect((await service.readState()).providers.find((provider) => provider.id === "bw")?.lastError).toBe("发现 1 个同步冲突。");
    expect((await service.readState()).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: item.id })]));
  });

  it("imports mixed additions and replacements with the same ordering as the pre-batch import semantics", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("mixed import password");
    const existing = createLoginItem({ title: "Existing", password: "old", uris: ["existing.example"] });
    const trailing = createLoginItem({ title: "Trailing", password: "secret", uris: ["trailing.example"] });
    await service.upsertItem(existing);
    await service.upsertItem(trailing);
    const firstNew = createLoginItem({ title: "First new", password: "secret", uris: ["first.example"] });
    const replacement = { ...existing, title: "Replaced", password: "new" };
    const secondNew = createLoginItem({ title: "Second new", password: "secret", uris: ["second.example"] });

    await service.importItems([firstNew, replacement, secondNew]);
    expect((await service.readState()).items.map((item) => item.id)).toEqual([secondNew.id, firstNew.id, trailing.id, existing.id]);
    expect((await service.readState()).items.find((item) => item.id === existing.id)?.title).toBe("Replaced");
  });

  it("imports 10,000 items with legacy prepend ordering and one persistence commit", async () => {
    const storage = new CountingMemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("large import password");
    await service.upsertProvider({ id: "bulk-provider", kind: "bitwarden", name: "Bulk provider", enabled: true, isDefaultSaveTarget: false, config: {} });
    const imported = Array.from({ length: 10_000 }, (_, index) => createLoginItem({ title: `Import ${index}`, password: "secret", uris: [`${index}.example`], providerRefs: [{ providerId: "bulk-provider" }] }));
    const startedAt = Date.now();

    const committed = await service.importItems(imported);

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(committed.map((item) => item.id)).toEqual(imported.map((item) => item.id));
    expect((await service.listItems()).map((item) => item.id)).toEqual([...imported].reverse().map((item) => item.id));
    expect((await service.readState()).mutationQueue).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: "bulk-provider", operation: "create" })]));
    expect((await service.readState()).mutationQueue).toHaveLength(10_000);
    expect(storage.writeCount).toBe(3);
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

  it("exports a device-key vault into a portable password-derived backup", async () => {
    const source = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore(), () => Date.now(), new MemoryVaultDeviceKeyStore());
    await source.setup("", [createLoginItem({ title: "Portable device vault", password: "device-secret", uris: ["device.example"] })]);

    const backup = await source.exportEncryptedBackup("portable backup password");
    expect(backup.envelope.kdf.name).not.toBe("DEVICE-KEY");
    expect(JSON.stringify(backup)).not.toContain("device-secret");

    const targetStorage = new MemoryVaultStorage();
    const target = new SecureVaultService(targetStorage, new MemoryVaultSessionStore(), () => Date.now(), new MemoryVaultDeviceKeyStore());
    await expect(target.restoreEncryptedBackup(backup, "portable backup password")).resolves.toMatchObject({ items: [expect.objectContaining({ title: "Portable device vault", password: "device-secret" })] });
    expect(targetStorage.envelope?.kdf.name).toBe("ARGON2ID");
    await target.lock();
    await expect(target.unlock("portable backup password")).resolves.toMatchObject({ settings: { protectionMode: "master-password" } });
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

  it("refuses an oversized source envelope instead of writing a vault that can no longer be decrypted", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("source budget password");
    await service.upsertProvider({ id: "big-source", kind: "mdbx", name: "MDBX", enabled: true, isDefaultSaveTarget: false, config: {} });
    const oversized = { providerId: "big-source", remoteId: "row-1", format: "mdbx-row", encoding: "json", payload: "x".repeat(MAX_SOURCE_RECORD_PAYLOAD_BYTES + 1), contentHash: "hash" };

    await expect(service.applyProviderSync("big-source", [], undefined, [], [oversized])).rejects.toThrow("超过单条");
    expect(await service.getProviderSourceRecords("big-source")).toEqual([]);
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

class CountingMemoryVaultStorage extends MemoryVaultStorage {
  writeCount = 0;

  override async write(envelope: NonNullable<MemoryVaultStorage["envelope"]>): Promise<void> {
    this.writeCount += 1;
    await super.write(envelope);
  }
}
