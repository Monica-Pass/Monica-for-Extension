import { describe, expect, it } from "vitest";
import { createLoginItem, type LoginItem } from "../core/model";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";

const providerId = "synthetic-mdbx-source";
async function fixture(grouped: boolean) {
  const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  const originals: LoginItem[] = Array.from({ length: grouped ? 2 : 1 }, (_, index) => ({
    ...createLoginItem({ title: `synthetic stale draft ${index}`, password: "synthetic", providerRefs: [{ providerId }] }),
    ...(grouped ? { passwordGroupId: "synthetic-explicit-group" } : { loginType: "GPG_KEY" as const })
  }));
  await service.setup("synthetic stale reference master password", originals);
  await service.upsertProvider({ id: providerId, kind: "mdbx2", name: "Synthetic Native", enabled: true, isDefaultSaveTarget: false, config: {} });
  const acknowledged = originals.map((item, index) => ({ ...item, providerRefs: [{ providerId, remoteId: `synthetic-object-${index}`, remoteFolderId: "synthetic-collection", revision: "synthetic-committed-head", etag: `synthetic-etag-${index}` }] }));
  await service.applyProviderSync(providerId, acknowledged, undefined, [], [], originals);
  for (const item of acknowledged) {
    const saved = (await service.listItems()).find(candidate => candidate.id === item.id)!;
    expect(saved.updatedAt).toBe(item.updatedAt);
    expect(saved.providerRefs).toEqual(item.providerRefs);
  }
  return { service, originals, acknowledged };
}

describe("UI draft opened before Native create acknowledgement", () => {
  it("does not drop authoritative remote identity when an unchanged-revision single-item draft is saved", async () => {
    const { service, originals: [draft], acknowledged: [remote] } = await fixture(false);
    const saved = await service.upsertItem({ ...draft, notes: "edited after automatic acknowledgement" }, undefined, draft.updatedAt);
    expect(saved.notes).toBe("edited after automatic acknowledgement");
    expect(saved.providerRefs).toEqual(remote.providerRefs);
    expect((await service.readState()).mutationQueue.find(mutation => mutation.itemId === draft.id)?.operation).toBe("update");
  });

  it("preserves both authoritative references when an explicit group draft predates acknowledgements", async () => {
    const { service, originals, acknowledged } = await fixture(true);
    const saved = await service.savePasswordGroup(originals.map(item => ({ ...item, notes: "edited group draft" })), Object.fromEntries(originals.map(item => [item.id, item.updatedAt])));
    for (const item of saved) expect(item.providerRefs).toEqual(acknowledged.find(remote => remote.id === item.id)!.providerRefs);
  });

  it("does not accept fabricated identity, revision or folder metadata for an existing binding", async () => {
    const { service, originals: [draft], acknowledged: [remote] } = await fixture(false);
    const saved = await service.upsertItem({ ...draft, username: "edited-user", password: "edited-secret", providerRefs: [{ providerId, remoteId: "different-object", revision: "fake-head", etag: "fake-etag", remoteFolderId: "different-collection", remoteCollectionIds: ["foreign"] }] }, undefined, draft.updatedAt);
    expect(saved).toMatchObject({ username: "edited-user", password: "edited-secret", providerRefs: remote.providerRefs });
  });

  it("allows an explicit new destination but never copies old database routing metadata to it", async () => {
    const { service, originals: [draft], acknowledged: [remote] } = await fixture(false);
    await service.upsertProvider({ id: "destination", kind: "mdbx2", name: "Other synthetic vault", enabled: true, isDefaultSaveTarget: false, config: {} });
    const saved = await service.upsertItem({ ...draft, notes: "move target only", providerRefs: [{ ...remote.providerRefs[0], providerId: "destination" }] }, undefined, draft.updatedAt);
    expect(saved.providerRefs).toEqual([{ providerId: "destination" }]);
    expect((await service.readState()).mutationQueue).toEqual([expect.objectContaining({ providerId: "destination", itemId: saved.id, operation: "create" })]);
  });

  it("does not resurrect a removed provider from an old multi-provider draft", async () => {
    const { service, acknowledged: [remote] } = await fixture(false);
    const second = { id: "remaining", kind: "mdbx2" as const, name: "Remaining", enabled: true, isDefaultSaveTarget: false, config: {} };
    await service.upsertProvider(second);
    const draft = { ...remote, providerRefs: [...remote.providerRefs, { providerId: second.id }] };
    await service.applyProviderSync(providerId, [draft]);
    await service.removeProvider(providerId);
    const before = await service.readState();
    await expect(service.upsertItem({ ...draft, notes: "stale provider" }, undefined, draft.updatedAt)).rejects.toThrow("密码源");
    expect(await service.readState()).toEqual(before);
  });

  it("still rejects genuinely stale item versions after merging provider-only acknowledgements", async () => {
    const { service, originals: [draft] } = await fixture(false);
    const updated = await service.upsertItem({ ...draft, notes: "new content version" }, undefined, draft.updatedAt);
    await expect(service.upsertItem({ ...draft, notes: "stale overwrite" }, undefined, draft.updatedAt)).rejects.toThrow("草稿仍然保留");
    expect(await service.getItem(draft.id)).toEqual(updated);
  });

  it("does not copy or forge a sibling's authoritative binding during group save", async () => {
    const { service, originals, acknowledged } = await fixture(true);
    const saved = await service.savePasswordGroup(originals.map(item => ({ ...item, password: "new group secret", providerRefs: [acknowledged[0].providerRefs[0]] })), Object.fromEntries(originals.map(item => [item.id, item.updatedAt])));
    for (const item of saved) expect(item).toMatchObject({ password: "new group secret", providerRefs: acknowledged.find(remote => remote.id === item.id)!.providerRefs });
    expect((await service.readState()).mutationQueue.map(mutation => mutation.operation)).toEqual(["update", "update"]);
  });

  it("does not allow a new group member to inherit another member's remote identity", async () => {
    const { service, originals, acknowledged } = await fixture(true);
    const newMember = { ...originals[0], id: crypto.randomUUID(), providerRefs: acknowledged[0].providerRefs };
    const saved = await service.savePasswordGroup([...originals, newMember], Object.fromEntries(originals.map(item => [item.id, item.updatedAt])));
    expect(saved.find(item => item.id === newMember.id)!.providerRefs).toEqual([{ providerId }]);
    expect((await service.readState()).mutationQueue.find(mutation => mutation.itemId === newMember.id)?.operation).toBe("create");
  });

  it("starts a copied single-item draft with a new remote identity and leaves the source untouched", async () => {
    const { service, acknowledged: [remote] } = await fixture(false);
    const copy = await service.upsertItem({ ...remote, id: crypto.randomUUID(), title: "independent copy" });
    expect(copy.providerRefs).toEqual([{ providerId }]);
    expect((await service.getItem(remote.id))!.providerRefs).toEqual(remote.providerRefs);
    expect((await service.readState()).mutationQueue.find(mutation => mutation.itemId === copy.id)?.operation).toBe("create");
  });

  it("rejects duplicate destination references before altering data or the queue", async () => {
    const { service, originals: [draft] } = await fixture(false);
    const before = await service.readState();
    await expect(service.upsertItem({ ...draft, providerRefs: [{ providerId }, { providerId }] }, undefined, draft.updatedAt)).rejects.toThrow("引用重复");
    expect(await service.readState()).toEqual(before);
  });

  it("does not orphan an in-flight source mutation when a draft switches destinations", async () => {
    const { service, originals: [draft] } = await fixture(false);
    const dirty = await service.upsertItem({ ...draft, notes: "pending source edit" }, undefined, draft.updatedAt);
    await service.upsertProvider({ id: "other", kind: "mdbx2", name: "Other", enabled: true, isDefaultSaveTarget: false, config: {} });
    const before = await service.readState();
    await expect(service.upsertItem({ ...dirty, providerRefs: [{ providerId: "other" }] }, undefined, dirty.updatedAt)).rejects.toThrow("待写入");
    expect(await service.readState()).toEqual(before);
  });
});
