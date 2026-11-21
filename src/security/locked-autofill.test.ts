import { describe, expect, it, vi } from "vitest";
import { createEmptyVaultState, createLoginItem, type LoginItem } from "../core/model";
import type { VaultEnvelope } from "./vault-crypto";
import { base64ToBytes, bytesToBase64 } from "./encoding";
import { LockedAutofillCache, MemoryLockedAutofillStorage } from "./locked-autofill";
import { SecureVaultService, VaultLockedError } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";
import { MemoryVaultDeviceKeyStore } from "./vault-device-key";
import { ANDROID_URL_RULE_FIELD } from '../core/url-rules';
import { loginMatchScore } from '../core/matching';

async function fixture() {
  const storage = new MemoryVaultStorage();
  const sessions = new MemoryVaultSessionStore();
  const device = new MemoryVaultDeviceKeyStore();
  const cacheStorage = new MemoryLockedAutofillStorage();
  const cache = new LockedAutofillCache(cacheStorage);
  const service = new SecureVaultService(storage, sessions, () => Date.now(), device, cache);
  await service.setup("selective autofill master password");
  const item = createLoginItem({ title: "Selected account", username: "selected-user", password: "selected-password-sentinel", uris: ["https://example.com"] });
  item.totpSecret = "JBSWY3DPEHPK3PXP";
  item.notes = "private-note-sentinel";
  item.customFields = [{ name: "Private field", value: "private-field-sentinel", protected: true }];
  await service.upsertItem(item);
  const other = createLoginItem({ title: "Other account", username: "other-user", password: "unselected-password-sentinel", uris: ["https://example.com"] });
  await service.upsertItem(other);
  return { storage, sessions, device, cache, cacheStorage, service, item, other };
}

describe("device-local selective autofill", () => {
  it('retains Android case-sensitive matching while stripping private carrier metadata from the locked cache', async () => {
    const { service, item } = await fixture();
    const value = JSON.stringify({ version: 1, private: 'future-secret-sentinel', urls: [{ url: '^https://example.com/Case$', mode: 'REGEX', private: 'row-secret-sentinel' }] });
    await service.upsertItem({ ...item, customFields: [...item.customFields, { name: ANDROID_URL_RULE_FIELD, value, protected: true }] });
    await service.setLockedAutofill(item.id, true);
    await service.lock();
    const copy = (await service.readAutofillContext()).items[0] as LoginItem;
    expect(loginMatchScore(copy, 'https://example.com/Case')).toBeGreaterThan(0);
    expect(loginMatchScore(copy, 'https://example.com/case')).toBe(0);
    for (const secret of ['future-secret-sentinel', 'row-secret-sentinel', 'private-field-sentinel', 'private-note-sentinel']) expect(JSON.stringify(copy)).not.toContain(secret);
    expect(copy.customFields).toHaveLength(1);
  });
  it('retains the granted member number across lock/restart and removes all revoked identity data', async () => {
    const { service, storage, sessions, device, cache, item, other } = await fixture();
    // Imports preserve existing creation times. Use explicit ordering rather than
    // relying on fixture inserts landing in different milliseconds or random IDs.
    const first = {...item, passwordGroupId: 'explicit-project', sortOrder: 0, customFields: []};
    const second = {...other, passwordGroupId: 'explicit-project', username: item.username,
      sortOrder: 1, customFields: []};
    await service.importItems([first, second]);
    await service.setLockedAutofill(second.id, true);
    const full = await service.readAutofillContext();
    expect(full.credentialIdentities[second.id]).toEqual({passwordNumber: 2});
    await service.lock();
    const restarted = new SecureVaultService(storage, sessions, () => Date.now(), device, cache);
    const locked = await restarted.readAutofillContext();
    expect(locked.credentialIdentities).toEqual({[second.id]: {passwordNumber: 2}});
    expect(locked.items).toHaveLength(1);
    expect(locked.items[0]).not.toHaveProperty('passwordGroupId');
    expect(locked.items[0]).toMatchObject({customFields: []});
    await restarted.unlock('selective autofill master password');
    await restarted.setLockedAutofill(second.id, false);
    await restarted.lock();
    expect((await restarted.readAutofillContext()).credentialIdentities).toEqual({});
  });

  it.each(['full', 'selected'])("rejects a prepared %s fill after the vault locks or a grant is revoked", async (scope) => {
    const { service, item } = await fixture();
    const unlocked = await service.readAutofillContext(scope === 'selected' ? item.id : undefined);
    const send = vi.fn(async () => ({ ok: true }));
    await service.lock();
    await expect(service.dispatchAutofill(unlocked, send)).rejects.toThrow("填写权限");
    expect(send).not.toHaveBeenCalled();
    await service.unlock("selective autofill master password");
    await service.setLockedAutofill(item.id, true);
    await service.lock();
    const granted = await service.readAutofillContext(scope === 'selected' ? item.id : undefined);
    await service.unlock("selective autofill master password");
    await service.setLockedAutofill(item.id, false);
    await service.lock();
    await expect(service.dispatchAutofill(granted, send)).rejects.toThrow("填写权限");
    expect(send).not.toHaveBeenCalled();
  });

  it("dispatches an authorized fill without blocking lock on an unresponsive page", async () => {
    const { service, item } = await fixture();
    await service.setLockedAutofill(item.id, true);
    await service.lock();
    const context = await service.readAutofillContext();
    let delivered!: () => void;
    const started = new Promise<void>((resolve) => { delivered = resolve; });
    let complete!: (value: string) => void;
    const response = new Promise<string>((resolve) => { complete = resolve; });
    const fill = service.dispatchAutofill(context, () => { delivered(); return response; });
    await started;
    await service.lock();
    expect(await service.status()).toBe("locked");
    complete("filled");
    expect(await fill).toBe("filled");
  });

  it("defaults to no grants and keeps general vault APIs locked", async () => {
    const { service, item } = await fixture();
    await service.lock();
    expect(await service.readAutofillContext()).toMatchObject({ locked: true, items: [] });
    await expect(service.listItems()).rejects.toBeInstanceOf(VaultLockedError);
    await expect(service.setLockedAutofill(item.id, true)).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("encrypts only the selected username/password with a non-exportable key and survives worker restart", async () => {
    const { storage, sessions, device, cache, cacheStorage, service, item } = await fixture();
    await service.setLockedAutofill(item.id, true);
    expect(JSON.stringify(cacheStorage.record)).not.toContain("sentinel");
    await expect(crypto.subtle.exportKey("raw", cacheStorage.record!.key)).rejects.toThrow();
    await service.lock();
    const restarted = new SecureVaultService(storage, sessions, () => Date.now(), device, cache);
    expect(await restarted.status()).toBe("locked");
    const access = await restarted.readAutofillContext();
    expect(access.items).toHaveLength(1);
    expect(access.items[0]).toMatchObject({ id: item.id, username: item.username, password: item.password, notes: "", customFields: [], providerRefs: [] });
    expect(access.items[0]).not.toHaveProperty("totpSecret");
    expect(await restarted.status()).toBe("locked");
    await expect(restarted.getItem(item.id)).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("preserves website and field exclusion policies while locked", async () => {
    const { service, item } = await fixture();
    await service.setAutofillSitePolicy({ blockedHosts: ["blocked.example.com"], saveBlockedHosts: [] });
    await service.addAutofillBlockedFieldSignature({ signature: "a".repeat(64), hostname: "example.com", role: "current-password", frameScope: "top-level", hints: ["current-password"], blockedAt: new Date().toISOString() });
    await service.setLockedAutofill(item.id, true);
    await service.lock();
    expect(await service.readAutofillContext()).toMatchObject({ blockedHosts: ["blocked.example.com"], blockedFieldSignatures: ["a".repeat(64)] });
  });

  it.each(["revoke", "delete", "archive", "specialize"])("withdraws access after %s", async (action) => {
    const { service, item } = await fixture();
    await service.setLockedAutofill(item.id, true);
    if (action === "revoke") await service.setLockedAutofill(item.id, false);
    if (action === "delete") await service.deleteItem(item.id);
    if (action === "archive") await service.upsertItem({ ...item, archivedAt: new Date().toISOString() });
    if (action === "specialize") await service.upsertItem({ ...item, loginType: "SSH_KEY" });
    await service.lock();
    expect((await service.readAutofillContext()).items).toEqual([]);
  });

  it("atomically opts in while saving a new login and updates the cached password", async () => {
    const { service, item } = await fixture();
    await service.upsertItem({ ...item, password: "updated-password" }, true);
    await service.lock();
    expect((await service.readAutofillContext()).items[0]).toMatchObject({ password: "updated-password" });
  });

  it("does not let imported item fields grant access and keeps device grants through Android sync", async () => {
    const { service, item } = await fixture();
    const remote = { ...item, id: "remote-login", providerRefs: [{ providerId: "android" }], allowLockedAutofill: true };
    await service.upsertProvider({ id: "android", kind: "monica-webdav", name: "Android", enabled: true, isDefaultSaveTarget: false, config: {} });
    await service.importItems([remote]);
    expect(await service.listLockedAutofillItemIds()).toEqual([]);
    await service.setLockedAutofill(remote.id, true);
    await service.applyProviderSync("android", (await service.listItems()).map((entry) => entry.id === remote.id ? { ...entry, password: "android-updated" } as LoginItem : entry));
    await service.lock();
    expect((await service.readAutofillContext()).items[0]).toMatchObject({ id: remote.id, password: "android-updated" });
  });

  it("revokes the cached projection for disabled providers", async () => {
    const { service, item } = await fixture();
    const provider = { id: "provider", kind: "monica-webdav" as const, name: "Android", enabled: true, isDefaultSaveTarget: false, config: {} };
    await service.upsertProvider(provider);
    await service.upsertItem({ ...item, providerRefs: [{ providerId: provider.id }] }, true);
    await service.upsertProvider({ ...provider, enabled: false });
    await service.lock();
    expect((await service.readAutofillContext()).items).toEqual([]);
  });

  it("never re-enables device grants when restoring a portable encrypted backup", async () => {
    const { service, item } = await fixture();
    await service.setLockedAutofill(item.id, true);
    const backup = await service.exportEncryptedBackup("portable backup password");
    await service.restoreEncryptedBackup(backup, "portable backup password", { replaceExisting: true, currentPassword: "selective autofill master password" });
    expect(await service.listLockedAutofillItemIds()).toEqual([]);
    await service.lock();
    expect((await service.readAutofillContext()).items).toEqual([]);
  });

  it("fails closed for stale, corrupted or missing cache records without affecting vault durability", async () => {
    const { cacheStorage, service, item } = await fixture();
    await service.setLockedAutofill(item.id, true);
    const old = structuredClone(cacheStorage.record);
    cacheStorage.write = async () => { throw new Error("storage unavailable"); };
    await service.deleteItem(item.id);
    expect(cacheStorage.record).toEqual(old);
    await service.lock();
    expect((await service.readAutofillContext()).items).toEqual([]);
  });

  it("does not commit a requested grant when the encrypted copy cannot be prepared", async () => {
    const { cacheStorage, service, item } = await fixture();
    cacheStorage.write = async () => { throw new Error("storage unavailable"); };
    await expect(service.setLockedAutofill(item.id, true)).rejects.toThrow("storage unavailable");
    expect(await service.listLockedAutofillItemIds()).toEqual([]);
  });
});

function grantedVault(password: string) {
  const state = createEmptyVaultState();
  const item = createLoginItem({ title: "Granted account", username: "granted-user", password, uris: ["https://example.com"] });
  state.items.push(item);
  state.settings.lockedAutofillItemIds = [item.id];
  return { state, item };
}

function envelopeFixture(tag: string): VaultEnvelope {
  return {
    version: 1,
    kdf: { name: "ARGON2ID", iterations: 3, memoryKiB: 65536, parallelism: 1, salt: `salt-${tag}` },
    cipher: "AES-256-GCM", iv: `iv-${tag}`, ciphertext: `ciphertext-${tag}`, updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("locked autofill cache prepare write policy", () => {
  it("skips rewriting when the snapshot and envelope are unchanged", async () => {
    const cacheStorage = new MemoryLockedAutofillStorage();
    const cache = new LockedAutofillCache(cacheStorage);
    const { state, item } = grantedVault("granted-password-sentinel");
    const envelope = envelopeFixture("stable");
    const write = vi.spyOn(cacheStorage, "write");
    await cache.prepare(structuredClone(state), envelope);
    await cache.prepare(structuredClone(state), envelope);
    expect(write).toHaveBeenCalledTimes(1);
    const snapshot = await cache.read(envelope);
    expect(snapshot?.logins).toHaveLength(1);
    expect(snapshot?.logins[0]).toMatchObject({ id: item.id, username: "granted-user", password: "granted-password-sentinel" });
  });

  it.each(["password", "uri rules", "blocked hosts"] as const)("rewrites when the granted %s change although the granted ids match", async (change) => {
    const cacheStorage = new MemoryLockedAutofillStorage();
    const cache = new LockedAutofillCache(cacheStorage);
    const { state } = grantedVault("granted-password-sentinel");
    await cache.prepare(state, envelopeFixture("before"));
    const changed = structuredClone(state);
    if (change === "password") (changed.items[0] as LoginItem).password = "rotated-password-sentinel";
    if (change === "uri rules") (changed.items[0] as LoginItem).uris = ["https://example.com", "https://rotated.example.org"];
    if (change === "blocked hosts") changed.settings.autofillBlockedHosts = ["blocked.example.com"];
    const write = vi.spyOn(cacheStorage, "write");
    await cache.prepare(changed, envelopeFixture("after"));
    expect(write).toHaveBeenCalledTimes(1);
    const snapshot = await cache.read(envelopeFixture("after"));
    expect(snapshot?.logins).toHaveLength(1);
    if (change === "password") expect(snapshot?.logins[0]).toMatchObject({ password: "rotated-password-sentinel" });
    if (change === "uri rules") expect(snapshot?.logins[0].uris).toHaveLength(2);
    if (change === "blocked hosts") expect(snapshot?.blockedHosts).toEqual(["blocked.example.com"]);
  });

  it("rewrites changed content even when the envelope digest still matches", async () => {
    const cacheStorage = new MemoryLockedAutofillStorage();
    const cache = new LockedAutofillCache(cacheStorage);
    const { state } = grantedVault("granted-password-sentinel");
    const envelope = envelopeFixture("stable");
    await cache.prepare(state, envelope);
    const changed = structuredClone(state);
    (changed.items[0] as LoginItem).password = "rotated-password-sentinel";
    const write = vi.spyOn(cacheStorage, "write");
    await cache.prepare(changed, envelope);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await cache.read(envelope))?.logins[0]).toMatchObject({ password: "rotated-password-sentinel" });
  });

  it("rewrites when the envelope digest no longer matches", async () => {
    const cacheStorage = new MemoryLockedAutofillStorage();
    const cache = new LockedAutofillCache(cacheStorage);
    const { state } = grantedVault("granted-password-sentinel");
    await cache.prepare(state, envelopeFixture("first"));
    const write = vi.spyOn(cacheStorage, "write");
    await cache.prepare(structuredClone(state), envelopeFixture("second"));
    expect(write).toHaveBeenCalledTimes(1);
    expect(await cache.read(envelopeFixture("first"))).toBeNull();
    expect((await cache.read(envelopeFixture("second")))?.logins).toHaveLength(1);
  });

  it("self-heals a corrupted cached record instead of skipping the write", async () => {
    const cacheStorage = new MemoryLockedAutofillStorage();
    const cache = new LockedAutofillCache(cacheStorage);
    const { state } = grantedVault("granted-password-sentinel");
    const envelope = envelopeFixture("stable");
    await cache.prepare(state, envelope);
    const corrupted = cacheStorage.record!;
    const bytes = base64ToBytes(corrupted.ciphertext);
    bytes[0] = bytes[0] ^ 0xff;
    await cacheStorage.write({ ...corrupted, ciphertext: bytesToBase64(bytes) });
    const write = vi.spyOn(cacheStorage, "write");
    await cache.prepare(structuredClone(state), envelope);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await cache.read(envelope))?.logins[0]).toMatchObject({ password: "granted-password-sentinel" });
  });

  it("does not write when the cache is already empty and nothing is granted", async () => {
    const cacheStorage = new MemoryLockedAutofillStorage();
    const cache = new LockedAutofillCache(cacheStorage);
    const write = vi.spyOn(cacheStorage, "write");
    await cache.prepare(createEmptyVaultState(), envelopeFixture("stable"));
    expect(write).not.toHaveBeenCalled();
    expect(cacheStorage.record).toBeNull();
  });

  it("still deletes a non-empty record when the last grant disappears", async () => {
    const cacheStorage = new MemoryLockedAutofillStorage();
    const cache = new LockedAutofillCache(cacheStorage);
    const { state } = grantedVault("granted-password-sentinel");
    await cache.prepare(state, envelopeFixture("granted"));
    const revoked = structuredClone(state);
    revoked.settings.lockedAutofillItemIds = [];
    const write = vi.spyOn(cacheStorage, "write");
    await cache.prepare(revoked, envelopeFixture("revoked"));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(null);
    expect(cacheStorage.record).toBeNull();
  });
});
