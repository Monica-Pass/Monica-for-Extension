import { describe, expect, it } from "vitest";
import { createLoginItem, type LoginItem } from "../core/model";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";
import type { VaultEnvelope } from "./vault-crypto";

class ObservedStorage extends MemoryVaultStorage {
  writes = 0;
  fail = false;
  async write(envelope: VaultEnvelope): Promise<void> {
    this.writes++;
    if (this.fail) throw new Error("synthetic persistence failure");
    await super.write(envelope);
  }
}
function login(providerId: string, group?: string): LoginItem {
  return { ...createLoginItem({ title: "Same synthetic title", password: "synthetic", providerRefs: [{ providerId, remoteId: crypto.randomUUID(), revision: "native-revision" }] }), passwordGroupId: group };
}
async function fixture() {
  const storage = new ObservedStorage();
  const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const group = [login("native-a", "explicit"), login("native-a", "explicit"), login("native-a", "explicit")];
  const independent = login("native-a");
  const otherDatabase = login("native-b", "explicit");
  await service.setup("synthetic group delete password", [...group, independent, otherDatabase]);
  for (const id of ["native-a", "native-b"]) await service.upsertProvider({ id, kind: "mdbx2", name: id, enabled: true, isDefaultSaveTarget: false, config: {} });
  storage.writes = 0;
  return { service, storage, group, independent, otherDatabase, expected: Object.fromEntries(group.map(item => [item.id, item.updatedAt])) };
}

describe("atomic explicit multi-password project deletion", () => {
  it("tombstones and queues every scoped member with one encrypted commit; no title-based merge", async () => {
    const { service, storage, group, independent, otherDatabase, expected } = await fixture();
    await service.deletePasswordGroup(group[1].id, expected);
    expect(storage.writes).toBe(1);
    const state = await service.readState();
    const deleted = state.items.filter(item => item.deletedAt);
    expect(deleted.map(item => item.id).sort()).toEqual(group.map(item => item.id).sort());
    expect(new Set(deleted.map(item => item.deletedAt)).size).toBe(1);
    expect(state.mutationQueue.filter(item => item.operation === "delete").map(item => item.itemId).sort()).toEqual(group.map(item => item.id).sort());
    for (const id of [independent.id, otherDatabase.id]) expect(state.items.find(item => item.id === id)?.deletedAt).toBeUndefined();
    await service.lock();
    const reopened = await service.unlock("synthetic group delete password");
    expect(reopened.items.filter(item => item.deletedAt)).toHaveLength(3);
  });

  it("rejects incomplete, stale or expanded member snapshots before any write", async () => {
    const { service, storage, group, expected } = await fixture();
    const before = JSON.stringify(storage.envelope);
    await expect(service.deletePasswordGroup(group[0].id, { [group[0].id]: group[0].updatedAt })).rejects.toThrow("成员已变化");
    await expect(service.deletePasswordGroup(group[0].id, { ...expected, [group[1].id]: "stale" })).rejects.toThrow("被修改");
    expect(storage.writes).toBe(0);
    expect(JSON.stringify(storage.envelope)).toBe(before);
    await service.upsertItem(login("native-a", "explicit"));
    const expanded = JSON.stringify(storage.envelope);
    storage.writes = 0;
    await expect(service.deletePasswordGroup(group[0].id, expected)).rejects.toThrow("成员已变化");
    expect(storage.writes).toBe(0);
    expect(JSON.stringify(storage.envelope)).toBe(expanded);
  });

  it("leaves every member and queue unchanged on persistence failure and keeps single-delete semantics", async () => {
    const { service, storage, group, independent, expected } = await fixture();
    const before = JSON.stringify(storage.envelope);
    storage.fail = true;
    await expect(service.deletePasswordGroup(group[0].id, expected)).rejects.toThrow("synthetic persistence failure");
    expect(JSON.stringify(storage.envelope)).toBe(before);
    storage.fail = false;
    expect((await service.readState()).items.filter(item => item.deletedAt)).toEqual([]);
    await expect(service.deletePasswordGroup(independent.id, { [independent.id]: independent.updatedAt })).rejects.toThrow("显式分组");
    await service.deleteItem(group[0].id);
    expect((await service.readState()).items.filter(item => item.deletedAt).map(item => item.id)).toEqual([group[0].id]);
  });
});
