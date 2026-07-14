import { describe, expect, it } from "vitest";
import { createLoginItem } from "../core/model";
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
});
