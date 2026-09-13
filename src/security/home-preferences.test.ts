import { describe, expect, it } from "vitest";
import { normalizeHomePreferences } from "../core/home-preferences";
import { createLoginItem } from "../core/model";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";
import { SecureVaultService, VaultLockedError } from "./secure-vault-service";

describe("encrypted home preferences", () => {
  it("requires an unlocked vault and preserves layout and pins through relock and backup restoration", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const login = { ...createLoginItem({ title: "Home fixture", password: "synthetic-password" }), id: "private-pinned-id-sentinel" };
    await service.setup("home preferences master password", [login]);
    expect(await service.getHomePreferences()).toEqual(normalizeHomePreferences());
    const preferences = normalizeHomePreferences({ order: ["databases", "frequent"], hidden: ["types"], collapsedModules: ["folders", "types"], pinnedItemIds: [login.id], suggestFrequent: false, favoritesExpanded: false, density: "comfortable", startupSource: "fixed", preferredSourceId: "private-source-sentinel", lastSourceId: "local" });
    await service.setHomePreferences(preferences);
    expect(JSON.stringify(storage.envelope)).not.toContain(login.id);
    expect(JSON.stringify(storage.envelope)).not.toContain("private-source-sentinel");
    const copy = await service.getHomePreferences();
    copy.pinnedItemIds.length = 0;
    expect(await service.getHomePreferences()).toEqual(preferences);
    const backup = await service.exportEncryptedBackup("home backup password");
    expect(JSON.stringify(backup)).not.toContain(login.id);
    await service.lock();
    await expect(service.getHomePreferences()).rejects.toBeInstanceOf(VaultLockedError);
    await expect(service.setHomePreferences(normalizeHomePreferences())).rejects.toBeInstanceOf(VaultLockedError);
    await service.unlock("home preferences master password");
    expect(await service.getHomePreferences()).toEqual(preferences);
    const restored = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await restored.restoreEncryptedBackup(backup, "home backup password");
    expect(await restored.getHomePreferences()).toEqual(preferences);
    expect(await restored.getItem(login.id)).toMatchObject({ password: "synthetic-password" });
  });

  it("serializes layout changes with item edits without dropping either", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("concurrent home preference password");
    const preferences = normalizeHomePreferences({ hidden: ["frequent"], suggestFrequent: false });
    const login = createLoginItem({ title: "Concurrent login", username: "before" });
    await Promise.all([service.setHomePreferences(preferences), service.upsertItem(login)]);
    const state = await service.readState();
    expect(state.settings.home).toEqual(preferences);
    expect(state.items.map(item => item.id)).toContain(login.id);
  });

  it("retains the last saved layout when durable storage rejects a write", async () => {
    class RejectingStorage extends MemoryVaultStorage {
      fail = false;
      override async write(envelope: Parameters<MemoryVaultStorage["write"]>[0]) {
        if (this.fail) throw new Error("Synthetic storage failure");
        await super.write(envelope);
      }
    }
    const storage = new RejectingStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("home storage failure password");
    const previous = normalizeHomePreferences({ favoritesExpanded: false });
    await service.setHomePreferences(previous);
    storage.fail = true;
    await expect(service.setHomePreferences(normalizeHomePreferences({ hidden: ["favorites"] }))).rejects.toThrow("Synthetic storage failure");
    expect(await service.getHomePreferences()).toEqual(previous);
  });

  it("merges independent preference edits from multiple manager pages", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("home concurrent preference edits");
    await Promise.all([
      service.setHomePreferences({ density: "comfortable", hidden: ["types"] }),
      service.setHomePreferences({ lastSourceId: "work" }),
      service.setHomePreferences({ pinnedItemIds: ["chosen-item"], suggestFrequent: false })
    ]);
    expect(await service.getHomePreferences()).toMatchObject({ density: "comfortable", hidden: ["types"], lastSourceId: "work", pinnedItemIds: ["chosen-item"], suggestFrequent: false });
  });
});
