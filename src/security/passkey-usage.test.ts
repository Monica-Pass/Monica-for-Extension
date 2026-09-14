import { describe, expect, it } from "vitest";
import type { PasskeyItem, ProviderAccount } from "../core/model";
import { independentImportedPasskey, normalizeImportedVaultItem } from "../manager/import-items";
import { nextBitwardenPasskeyCounter, resolvePasskeyOwnership } from "../passkey/ownership-policy";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";

const REVISION = "2026-09-14T01:00:00.000Z";
const item: PasskeyItem = {
  id: "usage-test", kind: "passkey", title: "Example", favorite: false, notes: "", createdAt: REVISION, updatedAt: REVISION,
  providerRefs: [], credentialId: "00112233-4455-6677-8899-aabbccddeeff", rpId: "example.com", rpName: "Example", userHandle: "dXNlcg",
  userName: "synthetic", userDisplayName: "Synthetic", algorithm: -7, publicKey: "", signCount: 37, discoverable: true, sourceMode: "bitwarden"
};

describe("Passkey ownership and local statistics", () => {
  it.each(["local", "monica-webdav", "keepass", "mdbx2", "bitwarden"] as const)("does not dirty a %s source when only usage changes", async kind => {
    const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await vault.setup("");
    const account: ProviderAccount = { id: "usage-source", kind, name: kind, enabled: true, isDefaultSaveTarget: false, config: {} };
    await vault.upsertProvider(account);
    const imported = { ...item, providerRefs: [{ providerId: account.id, remoteId: "remote-item", revision: REVISION }] };
    await vault.applyProviderSync(account.id, [imported]);
    const before = (await vault.readState()).items;
    await vault.recordPasskeyUse(item.id, "2026-09-14T02:00:00.000Z");
    const after = await vault.recordPasskeyUse(item.id, "2026-09-14T03:00:00.000Z");
    expect(after).toMatchObject({ useCount: 2, signCount: 37, updatedAt: REVISION });
    expect((await vault.readState()).mutationQueue).toEqual([]);
    // A simultaneous remote edit wins for its content without overwriting usage or
    // creating a spurious conflict just because the user authenticated during sync.
    const remote = { ...imported, notes: "edited on Android", updatedAt: "2026-09-14T02:30:00.000Z", useCount: 100 };
    expect(await vault.applyProviderSync(account.id, [remote], undefined, [], undefined, before)).toEqual({ conflicts: 0 });
    expect(await vault.getItem(item.id)).toMatchObject({ useCount: 2, lastUsedAt: "2026-09-14T03:00:00.000Z", notes: "edited on Android" });
  });

  it("uses actual bindings instead of the imported sourceMode label", () => {
    expect(resolvePasskeyOwnership(item, [])).toEqual({ kind: "local" });
    const providers: ProviderAccount[] = [
      { id: "bw", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} },
      { id: "kdbx", kind: "keepass", name: "KeePass", enabled: true, isDefaultSaveTarget: false, config: {} }
    ];
    expect(resolvePasskeyOwnership({ ...item, sourceMode: "browser-local", providerRefs: [{ providerId: "bw" }] }, providers).kind).toBe("bitwarden");
    expect(resolvePasskeyOwnership({ ...item, providerRefs: [{ providerId: "kdbx" }] }, providers).kind).toBe("database");
    expect(() => resolvePasskeyOwnership({ ...item, providerRefs: [{ providerId: "missing" }] }, providers)).toThrow("已失效");
    expect(() => resolvePasskeyOwnership({ ...item, providerRefs: [{ providerId: "bw" }, { providerId: "kdbx" }] }, providers)).toThrow("多个密码源");
  });

  it.each(["edit", "import", "sync"] as const)("preserves known counter history across a %s replacement", async operation => {
    const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await vault.setup("");
    const account: ProviderAccount = { id: "history-source", kind: "bitwarden", name: "Synthetic", enabled: true, isDefaultSaveTarget: false, config: {} };
    await vault.upsertProvider(account);
    const original = { ...item, providerRefs: [{ providerId: account.id, remoteId: "remote-item", revision: REVISION }] };
    await vault.applyProviderSync(account.id, [original]);
    const replacement = { ...original, signCount: 0, notes: "new content" };
    if (operation === "edit") await vault.upsertItem(replacement);
    else if (operation === "import") await vault.importItems([replacement]);
    else await vault.applyProviderSync(account.id, [replacement]);
    await vault.lock();
    await vault.unlock("");
    expect(await vault.getItem(item.id)).toMatchObject({ signCount: 0, signCountHighWaterMark: 37, notes: "new content" });
  });

  it("does not transfer history to a different credential replacing the same local item", async () => {
    const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await vault.setup("");
    await vault.upsertItem(item);
    const replacement = await vault.upsertItem({ ...item, credentialId: "a-different-credential", signCount: 0 });
    expect(replacement).not.toHaveProperty("signCountHighWaterMark");
  });

  it("refuses completion if a higher counter is observed after signature preparation", async () => {
    const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await vault.setup("");
    const account: ProviderAccount = { id: "history-source", kind: "bitwarden", name: "Synthetic", enabled: true, isDefaultSaveTarget: false, config: {} };
    await vault.upsertProvider(account);
    const selected = { ...item, providerRefs: [{ providerId: account.id, remoteId: "remote-item", revision: REVISION }] };
    await vault.applyProviderSync(account.id, [selected]);
    await vault.applyProviderSync(account.id, [{ ...selected, signCountHighWaterMark: 38 }]);
    await expect(vault.recordPasskeyUse(selected.id, REVISION, selected)).rejects.toThrow("回退");
    expect(await vault.getItem(selected.id)).not.toHaveProperty("lastUsedAt");
  });

  it("detaches manually imported snapshots and preserves explicit registration backup flags", () => {
    const imported = normalizeImportedVaultItem({ ...item, backupEligible: false, backupState: false, keepassDatabaseId: 3, mdbxDatabaseId: 9, boundPasswordId: 1, providerRefs: [{ providerId: "bw", remoteId: "remote-credential" }] })!;
    const detached = independentImportedPasskey(imported) as PasskeyItem;
    expect(detached).toMatchObject({ credentialId: item.credentialId, signCount: 37, providerRefs: [], sourceMode: "android-metadata-only", backupEligible: false, backupState: false });
    expect(detached.id).not.toBe(item.id);
    expect(detached).not.toHaveProperty("keepassDatabaseId");
    expect(detached).not.toHaveProperty("mdbxDatabaseId");
    expect(detached).not.toHaveProperty("boundPasswordId");
    expect(resolvePasskeyOwnership(detached, []).kind).toBe("local");
  });

  it.each([-1, 0.1, NaN, Infinity, 0x100000000, 0xffffffff])("rejects invalid or exhausted Bitwarden counters (%s)", counter => {
    expect(() => nextBitwardenPasskeyCounter(counter)).toThrow();
  });

  it("preserves the official zero and positive counter branches", () => {
    expect(nextBitwardenPasskeyCounter(0)).toBe(0);
    expect(nextBitwardenPasskeyCounter(9000)).toBe(9001);
  });
});
