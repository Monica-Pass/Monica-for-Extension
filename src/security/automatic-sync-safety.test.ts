import { describe, expect, it } from "vitest";
import { createLoginItem, type LoginItem, type ProviderAccount, type ProviderMutationReceipt } from "../core/model";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultSessionStore } from "./vault-session";
import { MemoryVaultStorage } from "./vault-storage";

const account: ProviderAccount = { id: "bw", kind: "bitwarden", name: "Synthetic", enabled: true, isDefaultSaveTarget: false, config: { apiUrl: "https://original.example.test/api" } };

describe("automatic sync vault safety", () => {
  it("does not extend inactivity expiry through reads, merges, diagnostics, or durable receipts", async () => {
    let now = Date.parse("2026-09-14T00:00:00Z");
    const sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(new MemoryVaultStorage(), sessions, () => now);
    await service.setup("synthetic auto sync password");
    await service.upsertProvider(account);
    const item = await service.upsertItem(createLoginItem({ title: "Synthetic", password: "synthetic", providerRefs: [{ providerId: "bw" }] }));
    const expiresAt = sessions.session!.expiresAt;
    now += 5 * 60_000;
    await service.readState();
    await service.listItems();
    await service.readAutofillContext();
    await service.upsertProvider({ ...account, lastError: "synthetic network failure" }, false);
    await service.markProviderSyncFailure("bw", "synthetic network failure");
    const mutation = (await service.readState(false)).mutationQueue[0];
    const receipt: ProviderMutationReceipt = { version: 1, providerId: "bw", mutationId: mutation.id, itemId: item.id, operation: "create", stage: "prepared", intentFingerprint: "a".repeat(64), attemptCount: 0, createdAt: item.createdAt, updatedAt: item.updatedAt };
    await service.prepareProviderMutationReceipts([receipt]);
    await service.markProviderMutationReceiptsAttempted("bw", [mutation.id]);
    await service.commitProviderMutationReceipts("bw", [{ mutationId: mutation.id, itemId: item.id, operation: "create", remoteId: "cipher" }]);
    await service.clearProviderMutationReceipts("bw", [mutation.id]);
    const state = await service.readState(false);
    await service.applyProviderSync("bw", state.items, {}, [], undefined, state.items, [], [], false, [mutation.id]);
    expect(sessions.session!.expiresAt).toBe(expiresAt);
    await service.recordUserActivity();
    expect(sessions.session!.expiresAt).toBe(expiresAt + 5 * 60_000);
    now = sessions.session!.expiresAt + 1;
    await service.recordUserActivity();
    expect(await service.status()).toBe("locked");
  });

  it("keeps remote changes and the editing draft separate with an atomic version check", async () => {
    const now = Date.parse("2026-09-14T00:00:00Z");
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore(), () => now);
    await service.setup("synthetic editing password");
    const original = await service.upsertItem(createLoginItem({ title: "Before", password: "before" })) as LoginItem;
    const newer = await service.upsertItem({ ...original, title: "Edited elsewhere" });
    expect(newer.updatedAt).not.toBe(original.updatedAt);
    await expect(service.upsertItem({ ...original, password: "unsaved draft" }, undefined, original.updatedAt)).rejects.toThrow("草稿仍然保留");
    expect(await service.getItem(original.id)).toMatchObject({ title: "Edited elsewhere", password: "before" });
  });

  it("never applies an old response after the user replaces a server connection", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("synthetic connection password"); await service.upsertProvider(account);
    const snapshot = (await service.readState(false)).items;
    const replacement = { ...account, config: { apiUrl: "https://replacement.example.test/api" } };
    await service.upsertProvider(replacement);
    await expect(service.applyProviderSync("bw", snapshot, { config: account.config }, [], [], snapshot, [], [], false, [], { expectedAccount: account })).rejects.toThrow("配置已变化");
    expect((await service.getProvider("bw"))?.config.apiUrl).toBe(replacement.config.apiUrl);
  });

  it("adopts only individually confirmed removals and preserves edits made during that read", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("synthetic deletion password"); await service.upsertProvider(account);
    const items = ["confirmed", "unconfirmed", "edited"].map(id => ({ ...createLoginItem({ title: id, password: "synthetic", providerRefs: [{ providerId: "bw", remoteId: id, revision: "2026-09-14T00:00:00Z" }] }), id, updatedAt: "2026-09-14T00:00:00Z" }));
    await service.applyProviderSync("bw", items);
    const snapshot = (await service.readState(false)).items;
    await service.upsertItem({ ...items[2], title: "Keep this local edit" });
    await service.applyProviderSync("bw", [], {}, [], undefined, snapshot, [], [], false, [], { confirmedRemovedItemIds: ["confirmed", "edited"] });
    expect((await service.listItems()).map(item => item.id).sort()).toEqual(["edited", "unconfirmed"]);
    expect((await service.getItem("edited"))?.title).toBe("Keep this local edit");
    expect(await service.listProviderConflicts()).toHaveLength(2);
  });
});
