import { expect, it, vi } from "vitest";
import { createLoginItem, type LoginItem } from "../core/model";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";
import { MANUAL_STACK_FIELD, readPasswordStackSetting } from "../core/password-manual-stacks";

async function fixture() {
  const storage = new MemoryVaultStorage();
  const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const base = createLoginItem({ title: "Synthetic", username: "account", password: "secret", uris: ["https://example.test"] });
  const rows = [{ ...base, id: "a", passwordGroupId: "project", sortOrder: 0 }, { ...base, id: "b", passwordGroupId: "project", sortOrder: 1 },
    { ...base, id: "c", sortOrder: 3 }, { ...base, id: "other", providerRefs: [{ providerId: "native", remoteId: "other" }] }];
  await service.setup("synthetic stack password", rows);
  return { storage, service, rows: (await service.readState()).items as LoginItem[] };
}
const revisions = (rows: LoginItem[]) => Object.fromEntries(rows.map(item => [item.id, item.updatedAt]));

it("writes one shared Android stack marker to all project members atomically and restores auto/never without changing content", async () => {
  const { service, rows } = await fixture();
  const updates = await service.setPasswordStack(["a", "c"], "stack", revisions(rows.slice(0, 3)));
  expect(updates.map(item => item.id)).toEqual(["a", "b", "c"]);
  const modes = updates.map(item => readPasswordStackSetting(item.customFields));
  expect(modes.every(mode => mode.kind === "manual")).toBe(true);
  expect(new Set(modes.map(mode => mode.kind === "manual" ? mode.groupId : ""))).toHaveProperty("size", 1);
  updates.forEach((item, index) => expect({ ...item, updatedAt: rows[index].updatedAt, customFields: rows[index].customFields }).toEqual(rows[index]));
  await service.lock();
  const reopened = await service.unlock("synthetic stack password");
  expect(reopened.items.slice(0, 3)).toEqual(updates);
  const never = await service.setPasswordStack(["a"], "never", revisions(updates.slice(0, 2)));
  expect(never.map(item => readPasswordStackSetting(item.customFields))).toEqual([{ kind: "never" }, { kind: "never" }]);
  const automatic = await service.setPasswordStack(["a"], "auto", revisions(never));
  expect(automatic.map(item => item.customFields)).toEqual([[], []]);
  expect((await service.readState()).items[3]).toEqual(rows[3]);
});
it.each(["missing-member", "stale", "extra", "cross-source", "single-project", "bad-mode"])("rejects %s without a vault or sync-queue write", async kind => {
  const { service, storage, rows } = await fixture();
  const expected = revisions(rows.slice(0, 3));
  let ids = ["a", "c"];
  if (kind === "missing-member") delete expected.b;
  if (kind === "stale") expected.b = "stale";
  if (kind === "extra") expected.extra = "revision";
  if (kind === "cross-source") { ids = ["c", "other"]; Object.assign(expected, revisions(rows)); }
  if (kind === "single-project") ids = ["a", "b"];
  const before = JSON.stringify(storage.envelope);
  await expect(service.setPasswordStack(ids, kind === "bad-mode" ? "invalid" as "stack" : "stack", expected)).rejects.toThrow();
  expect(JSON.stringify(storage.envelope)).toBe(before);
});
it("rejects a project member added after the snapshot and unsupported marker formats before any partial mutation", async () => {
  const { service, storage, rows } = await fixture();
  await service.upsertItem({ ...rows[0], id: "new-member" });
  const before = JSON.stringify(storage.envelope);
  await expect(service.setPasswordStack(["a", "c"], "stack", revisions(rows.slice(0, 3)))).rejects.toThrow("成员或内容已变化");
  expect(JSON.stringify(storage.envelope)).toBe(before);
  await service.upsertItem({ ...rows[2], customFields: [{ name: MANUAL_STACK_FIELD, value: "protected", protected: true }] }, undefined, rows[2].updatedAt);
  const all = (await service.readState()).items.filter(item => item.id !== "other") as LoginItem[];
  const protectedBefore = JSON.stringify(storage.envelope);
  await expect(service.setPasswordStack(["a", "c"], "stack", revisions(all))).rejects.toThrow("已保留原始字段");
  expect(JSON.stringify(storage.envelope)).toBe(protectedBefore);
});
it("persists provider mutations in the same transaction, retains failed-save state, and skips a no-op", async () => {
  const { service, storage, rows } = await fixture();
  const original = rows[3];
  await service.upsertProvider({ id: "native", kind: "mdbx2", name: "Synthetic", enabled: true, isDefaultSaveTarget: false, config: {} });
  const before = JSON.stringify(storage.envelope);
  const spy = vi.spyOn(storage, "write").mockRejectedValueOnce(new Error("synthetic write failure"));
  await expect(service.setPasswordStack(["other"], "never", revisions([original]))).rejects.toThrow("synthetic write failure");
  expect(JSON.stringify(storage.envelope)).toBe(before);
  expect(await service.setPasswordStack(["other"], "auto", revisions([original]))).toEqual([]);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
  await service.setPasswordStack(["other"], "never", revisions([original]));
  expect((await service.readState()).mutationQueue.map(item => [item.itemId, item.operation])).toEqual([["other", "update"]]);
});
