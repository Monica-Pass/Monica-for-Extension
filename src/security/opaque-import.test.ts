import { expect, it } from "vitest";
import { normalizeImportedVaultItem } from "../manager/import-items";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";

it("imports unfamiliar local items visibly and preserves them through locking without allowing replacement", async () => {
  const storage = new MemoryVaultStorage(); const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup("synthetic readonly master password", []);
  const item = normalizeImportedVaultItem({ id: "future", kind: "future-credential", title: "Future", data: { value: null, flags: [false, ""] } });
  if (!item || item.kind !== "opaque") throw new Error("Expected opaque projection");
  await service.importItems([item]);
  await service.lock(); await service.unlock("synthetic readonly master password");
  expect(await service.listItems()).toEqual([expect.objectContaining({ id:item.id,kind:"opaque",originalPayload:item.originalPayload })]);
  const before = JSON.stringify(storage.envelope);
  await expect(service.importItems([{...item,title:"Replace"}])).rejects.toThrow("只读");
  expect(JSON.stringify(storage.envelope)).toBe(before);
});
