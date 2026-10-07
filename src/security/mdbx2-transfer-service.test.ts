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
  it.each(['history', 'identity'] as const)('rejects a same-vault folder move that loses %s', async lost => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup('synthetic same-vault history');
    await service.upsertProvider(targetProvider);
    const source = { ...createLoginItem({ title: 'Native history' }), passwordHistory: [{ password: 'synthetic old', lastUsedAt: '1970-01-01T00:00:00.000Z' }], providerRefs: [{ providerId: targetProvider.id, remoteId: 'original-object' }] };
    await service.applyProviderSync(targetProvider.id, [source]);
    const expected = (await service.getItem(source.id))!;
    const result = { ...expected, ...(lost === 'history' ? { passwordHistory: [] } : {}),
      providerRefs: [{ providerId: targetProvider.id, remoteId: lost === 'identity' ? 'different-object' : 'original-object', remoteFolderId: 'different-folder' }] };
    const before = await service.readState();
    let deleted = false;
    await expect(service.applyCompletedMdbx2Transfer([{ expected, result, action: 'move' }], targetProvider.id, async () => { deleted = true; })).rejects.toThrow('密码历史');
    expect(deleted).toBe(false);
    expect(await service.readState()).toEqual(before);
  });

  it('refuses an old cross-vault move receipt with password history before deleting any source', async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup('synthetic history receipt');
    await service.upsertProvider(targetProvider);
    const source = await service.upsertItem({ ...createLoginItem({ title: 'History receipt' }), passwordHistory: [{ password: 'synthetic old', lastUsedAt: '1970-01-01T00:00:00.000Z' }] });
    const result = { ...source, providerRefs: [{ providerId: targetProvider.id, remoteId: 'old-committed-object' }] };
    const before = await service.readState();
    let deleted = false;
    await expect(service.applyCompletedMdbx2Transfer([{ expected: source, result, action: 'move' }], targetProvider.id, async () => { deleted = true; })).rejects.toThrow('密码历史');
    expect(deleted).toBe(false);
    expect(await service.readState()).toEqual(before);
  });

  it("keeps the original pending sync during copy and leaves later source edits intact on retry", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("copy queue password");
    await service.upsertProvider(targetProvider);
    const source = await service.upsertItem({ ...createLoginItem({ title: "Pending source" }), providerRefs: [{ providerId: targetProvider.id }] });
    const queued = (await service.readState()).mutationQueue;
    expect(queued.length).toBeGreaterThan(0);
    const result = { ...source, id: "copied-queue-item", providerRefs: [{ providerId: targetProvider.id, remoteId: "copied-object" }] };
    const entries = [{ expected: source, result, action: "copy" as const }];
    await service.applyCompletedMdbx2Transfer(entries, targetProvider.id);
    expect((await service.readState()).mutationQueue).toEqual(queued);
    await service.upsertItem({ ...source, notes: "Edited after copying" });
    const beforeRetry = await service.readState();
    await service.applyCompletedMdbx2Transfer(entries, targetProvider.id);
    expect(await service.readState()).toEqual(beforeRetry);
  });

  it("checks the last group member before deleting any source and adopts no partial group", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("group transfer password");
    await service.upsertProvider(targetProvider);
    const first = await service.upsertItem(createLoginItem({ title: "First" }));
    const second = await service.upsertItem(createLoginItem({ title: "Second" }));
    const entries = [first, second].map((expected, index) => ({ expected, action: "move" as const,
      result: { ...expected, providerRefs: [{ providerId: targetProvider.id, remoteId: `object-${index}` }] } }));
    const changed = await service.upsertItem({ ...second, notes: "Concurrent edit" });
    let deleted = false;
    await expect(service.applyCompletedMdbx2Transfer(entries, targetProvider.id, async () => { deleted = true; })).rejects.toThrow("发生变化");
    expect(deleted).toBe(false);
    expect(await service.getItem(first.id)).toEqual(first);
    expect(await service.getItem(second.id)).toEqual(changed);
  });

  it("retains both members after source-group failure and retries final adoption idempotently", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("group retry password");
    await service.upsertProvider(targetProvider);
    const originals = [await service.upsertItem(createLoginItem({ title: "First" })), await service.upsertItem(createLoginItem({ title: "Second" }))];
    const entries = originals.map((expected, index) => ({ expected, action: "move" as const,
      result: { ...expected, providerRefs: [{ providerId: targetProvider.id, remoteId: `object-${index}` }] } }));
    await expect(service.applyCompletedMdbx2Transfer(entries, targetProvider.id, async () => { throw new Error("Source batch conflict"); })).rejects.toThrow("Source batch conflict");
    for (const item of originals) expect(await service.getItem(item.id)).toEqual(item);
    let deletes = 0;
    const remove = async (pending: readonly unknown[]) => { expect(pending).toHaveLength(2); deletes++; };
    await service.applyCompletedMdbx2Transfer(entries, targetProvider.id, remove);
    await service.applyCompletedMdbx2Transfer(entries, targetProvider.id, remove);
    expect(deletes).toBe(1);
    for (const entry of entries) expect(await service.getItem(entry.result.id)).toEqual(entry.result);
    expect((await service.readState()).mutationQueue).toEqual([]);
  });

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
