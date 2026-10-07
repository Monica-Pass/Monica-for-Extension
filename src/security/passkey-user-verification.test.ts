import { describe, expect, it } from "vitest";
import { SecureVaultService, VaultLockedError, VaultUnlockError } from "./secure-vault-service";
import { MemoryVaultSessionStore } from "./vault-session";
import { MemoryVaultStorage } from "./vault-storage";
import type { PasskeyItem } from "../core/model";

describe("Passkey master-password user verification", () => {
  it("binds verification to one live unlock session and discards cancelled unlocks", async () => {
    let now = 1_000;
    const storage = new MemoryVaultStorage();
    const sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions, () => now);
    const password = "synthetic scoped unlock password";
    await service.setup(password);
    const first = await service.passkeySessionId();
    expect(first).toBeTruthy();
    await service.listItems();
    expect(await service.passkeySessionId()).toBe(first);
    await service.lock();
    expect(await service.passkeySessionId()).toBeUndefined();
    let checks = 0;
    await expect(service.unlock(password, () => { if (++checks > 1) throw new Error("cancelled during key derivation"); })).rejects.toThrow("cancelled during key derivation");
    expect(await service.status()).toBe("locked");
    await service.unlock(password);
    expect(await service.passkeySessionId()).not.toBe(first);
    now += 60 * 60_000;
    expect(await service.passkeySessionId()).toBeUndefined();
  });

  it("requires the actual password without rewriting the vault or changing its session", async () => {
    const storage = new MemoryVaultStorage();
    const sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions);
    await service.setup("synthetic Passkey verification password");
    const before = JSON.stringify(storage.envelope);
    const session = await sessions.read();
    await expect(service.verifyMasterPasswordForPasskey("wrong password")).rejects.toBeInstanceOf(VaultUnlockError);
    expect(await service.status()).toBe("unlocked");
    await expect(service.verifyMasterPasswordForPasskey("synthetic Passkey verification password")).resolves.toBeUndefined();
    expect(JSON.stringify(storage.envelope)).toBe(before);
    expect(await sessions.read()).toEqual(session);
    await service.lock();
    await expect(service.verifyMasterPasswordForPasskey("synthetic Passkey verification password")).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("does not treat an automatically unlocked device-key vault as user verification", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("");
    await expect(service.verifyMasterPasswordForPasskey("")).rejects.toThrow();
    await expect(service.verifyMasterPasswordForPasskey("arbitrary password")).rejects.toThrow();
  });

  it("increments only usage statistics and preserves imported counter metadata", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const now = new Date().toISOString();
    const item: PasskeyItem = { id: "synthetic", kind: "passkey", title: "Synthetic", favorite: false, notes: "", providerRefs: [], createdAt: now, updatedAt: now, credentialId: "c3ludGhldGlj", rpId: "example.com", rpName: "Example", userHandle: "dXNlcg", userName: "synthetic", userDisplayName: "Synthetic", algorithm: -7, publicKey: "synthetic-public", privateKeyPkcs8: "synthetic-private", signCount: 91, useCount: 10, discoverable: true, sourceMode: "browser-local" };
    await service.setup("", [item]);
    await service.recordPasskeyUse(item.id, now);
    await service.recordPasskeyUse(item.id, now);
    expect((await service.listItems())[0]).toMatchObject({ credentialId: item.credentialId, privateKeyPkcs8: item.privateKeyPkcs8, signCount: 91, useCount: 12, updatedAt: now });
    expect((await service.readState()).mutationQueue).toEqual([]);
  });
});
