import { describe, expect, it, vi } from "vitest";
import { createLoginItem, type LoginItem } from "../core/model";
import { LockedAutofillCache, MemoryLockedAutofillStorage } from "./locked-autofill";
import { SecureVaultService, VaultLockedError } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";
import { MemoryVaultDeviceKeyStore } from "./vault-device-key";

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
  it("rejects a prepared fill after the vault locks or a grant is revoked", async () => {
    const { service, item } = await fixture();
    const unlocked = await service.readAutofillContext();
    const send = vi.fn(async () => ({ ok: true }));
    await service.lock();
    await expect(service.dispatchAutofill(unlocked, send)).rejects.toThrow("填写权限");
    expect(send).not.toHaveBeenCalled();
    await service.unlock("selective autofill master password");
    await service.setLockedAutofill(item.id, true);
    await service.lock();
    const granted = await service.readAutofillContext();
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
