import { expect, it, vi } from "vitest";
import { createLoginItem, type LoginItem } from "../core/model";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";
import { passwordCoverPeers } from "../core/password-display-stacks";

async function fixture() {
  const storage = new MemoryVaultStorage();
  const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const base = createLoginItem({ title: "Synthetic", username: "account", password: "secret", uris: ["https://example.test/login"] });
  const rows: LoginItem[] = [
    { ...base, id: "old", isGroupCover: true, passwordGroupId: "project-old", sortOrder: 5, providerRefs: [{ providerId: "native", remoteId: "old", revision: "head" }] },
    { ...base, id: "new", passwordGroupId: "project-new", sortOrder: 9, providerRefs: [{ providerId: "native", remoteId: "new", revision: "head" }] },
    { ...base, id: "other-source", isGroupCover: true, providerRefs: [{ providerId: "other" }] },
    { ...base, id: "archived", isGroupCover: true, archivedAt: "2026-10-05T00:00:00Z", providerRefs: [{ providerId: "native" }] },
    { ...base, id: "path", isGroupCover: true, uris: ["https://example.test/other"], providerRefs: [{ providerId: "native" }] }
  ];
  await service.setup("synthetic master password", rows);
  await service.upsertProvider({ id: "native", kind: "mdbx2", name: "Synthetic", enabled: true, isDefaultSaveTarget: false, config: {} });
  const storedRows = (await service.readState()).items as LoginItem[];
  const expected = Object.fromEntries(passwordCoverPeers(storedRows[1], storedRows).map(item => [item.id, item.updatedAt]));
  return { storage, service, rows: storedRows, expected };
}

it("atomically changes only exact-website cover flags, retains complete content, and persists sync intents across relock", async () => {
  const { service, rows, expected } = await fixture();
  const updates = await service.setPasswordCover("new", true, expected);
  expect(updates.map(item => item.id)).toEqual(["old", "new"]);
  for (const [index, update] of updates.entries()) {
    expect({ ...update, updatedAt: rows[index].updatedAt }).toEqual({ ...rows[index], isGroupCover: update.id === "new" });
  }
  const state = await service.readState();
  expect(state.items.slice(2)).toEqual(rows.slice(2));
  expect(state.mutationQueue.map(change => [change.itemId, change.operation])).toEqual([["old", "update"], ["new", "update"]]);
  await service.lock();
  expect((await service.unlock("synthetic master password")).items).toEqual(state.items);
  const nextExpected = Object.fromEntries(passwordCoverPeers(updates[1], state.items).map(item => [item.id, item.updatedAt]));
  expect((await service.setPasswordCover("new", false, nextExpected)).map(item => [item.id, item.isGroupCover])).toEqual([["new", false]]);
});

it.each(["missing", "extra", "stale", "bad-shape", "bad-boolean"])("rejects %s input without writing the encrypted vault or mutation queue", async kind => {
  const { service, storage, expected } = await fixture();
  const input = { ...expected };
  if (kind === "missing") delete input.old;
  if (kind === "extra") input.other = "revision";
  if (kind === "stale") input.old = "stale";
  const before = JSON.stringify(storage.envelope);
  const state = await service.readState();
  await expect(service.setPasswordCover("new", kind === "bad-boolean" ? "true" as unknown as boolean : true,
    kind === "bad-shape" ? [] as unknown as Record<string, string> : input)).rejects.toThrow();
  expect(JSON.stringify(storage.envelope)).toBe(before);
  expect(await service.readState()).toEqual(state);
});

it("rejects a newly added peer and an edited peer after the displayed snapshot was taken", async () => {
  const { service, storage, rows, expected } = await fixture();
  await service.upsertItem({ ...rows[1], id: "concurrent", providerRefs: [{ providerId: "native" }] });
  const before = JSON.stringify(storage.envelope);
  await expect(service.setPasswordCover("new", true, expected)).rejects.toThrow("网站分组已变化");
  expect(JSON.stringify(storage.envelope)).toBe(before);
  const fresh = Object.fromEntries(passwordCoverPeers(rows[1], (await service.readState()).items).map(item => [item.id, item.updatedAt]));
  await service.upsertItem({ ...rows[0], notes: "changed elsewhere" }, undefined, rows[0].updatedAt);
  const edited = JSON.stringify(storage.envelope);
  await expect(service.setPasswordCover("new", true, fresh)).rejects.toThrow("网站分组已变化");
  expect(JSON.stringify(storage.envelope)).toBe(edited);
});

it("leaves the durable state intact on storage failure and skips no-op writes", async () => {
  const { service, storage, expected } = await fixture();
  const before = JSON.stringify(storage.envelope);
  const failure = vi.spyOn(storage, "write").mockRejectedValueOnce(new Error("synthetic storage failure"));
  await expect(service.setPasswordCover("new", true, expected)).rejects.toThrow("synthetic storage failure");
  expect(JSON.stringify(storage.envelope)).toBe(before);
  expect(await service.setPasswordCover("old", true, expected)).toEqual([]);
  expect(failure).toHaveBeenCalledTimes(1);
  failure.mockRestore();
});
