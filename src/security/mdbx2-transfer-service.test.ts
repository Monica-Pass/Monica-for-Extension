import { describe, expect, it } from "vitest";
import { createLoginItem, type ProviderAccount } from "../core/model";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultSessionStore } from "./vault-session";
import { MemoryVaultStorage } from "./vault-storage";

const targetProvider: ProviderAccount = {
  id: "mdbx-target",
  kind: "mdbx2",
  name: "MDBX2 target",
  enabled: true,
  isDefaultSaveTarget: false,
  config: { vaultHandle: "11111111-1111-4111-8111-111111111111" }
};

describe("completed MDBX2 transfer adoption", () => {
  it("adds a committed copy without queueing a second target mutation", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("completed transfer password");
    await service.upsertProvider(targetProvider);
    const source = await service.upsertItem(createLoginItem({ title: "Source", password: "secret" }));
    const copied = { ...source, id: "copied", providerRefs: [{ providerId: targetProvider.id, remoteId: "object-1", revision: "commit-1", etag: "etag" }] };

    await service.applyCompletedMdbx2Transfer([{ expected: source, result: copied, action: "copy" }], targetProvider.id);
    await service.applyCompletedMdbx2Transfer([{ expected: source, result: copied, action: "copy" }], targetProvider.id);

    expect(await service.listItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: source.id, title: "Source" }),
      expect.objectContaining({ id: "copied", providerRefs: [expect.objectContaining({ remoteId: "object-1" })] })
    ]));
    expect((await service.readState()).mutationQueue).toEqual([]);
  });

  it("replaces a move in place and rejects a stale source snapshot", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("completed move password");
    await service.upsertProvider(targetProvider);
    const source = await service.upsertItem(createLoginItem({ title: "Source", password: "secret" }));
    const moved = { ...source, providerRefs: [{ providerId: targetProvider.id, remoteId: "object-2", revision: "commit-2", etag: "etag" }] };
    await service.upsertItem({ ...source, notes: "changed concurrently" });

    await expect(service.applyCompletedMdbx2Transfer([{ expected: source, result: moved, action: "move" }], targetProvider.id))
      .rejects.toThrow("发生变化");
    expect((await service.listItems())[0]).toMatchObject({ notes: "changed concurrently" });
  });

  it("deletes a foreign source only inside the final adoption transaction", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("atomic transfer password");
    await service.upsertProvider(targetProvider);
    const source = await service.upsertItem(createLoginItem({ title: "Source", password: "secret" }));
    const moved = { ...source, providerRefs: [{ providerId: targetProvider.id, remoteId: "object-3", revision: "commit-3", etag: "etag" }] };
    let deleted = 0;
    await service.finalizeCompletedMdbx2Transfer({ expected: source, result: moved, action: "move" }, targetProvider.id, async () => { deleted += 1; });
    expect(deleted).toBe(1);
    expect(await service.getItem(source.id)).toMatchObject({ providerRefs: [expect.objectContaining({ remoteId: "object-3" })] });
    await service.finalizeCompletedMdbx2Transfer({ expected: source, result: moved, action: "move" }, targetProvider.id, async () => { deleted += 1; });
    expect(deleted).toBe(1);
  });
});
