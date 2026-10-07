import { describe, expect, it } from "vitest";
import type { ProviderAccount } from "../core/model";
import { homeProviderStatus } from "./home-provider-status";

const provider: ProviderAccount = { id: "work", name: "Work", kind: "monica-webdav", enabled: true, isDefaultSaveTarget: false, config: {} };
describe("homepage database status", () => {
  it("distinguishes local storage, paused sources, pending changes and known sync history", () => {
    expect(homeProviderStatus({ ...provider, kind: "local" }).state).toBe("local");
    expect(homeProviderStatus({ ...provider, enabled: false }).state).toBe("paused");
    expect(homeProviderStatus(provider).state).toBe("never");
    expect(homeProviderStatus({ ...provider, lastSyncAt: "2026-09-13T00:00:00Z" }).state).toBe("synced");
    expect(homeProviderStatus(provider, { providerId: "work", pending: 3, failed: 0 })).toMatchObject({ state: "pending", count: 3 });
    expect(homeProviderStatus({ ...provider, kind: "keepass", config: { sourceMode: "local-file" } }).state).toBe("file");
    expect(homeProviderStatus({ ...provider, kind: "keepass", config: { sourceMode: "onedrive" } }).state).toBe("never");
    expect(homeProviderStatus({ ...provider, kind: "keepass", config: { sourceMode: "onedrive" }, lastSyncAt: "2026-10-05T00:00:00Z" }).state).toBe("synced");
  });
  it("prioritizes actionable conflicts and errors without exposing error payloads", () => {
    const failing = { ...provider, lastError: "https://secret@example.test?token=private" };
    expect(homeProviderStatus(failing, undefined, 2)).toMatchObject({ state: "conflict", count: 2, needsAttention: true });
    expect(homeProviderStatus({ ...failing, requiresEmptyRemoteConfirmation: true }).state).toBe("confirmation");
    expect(homeProviderStatus(failing).state).toBe("error");
    expect(JSON.stringify(homeProviderStatus(failing))).not.toContain("private");
    expect(homeProviderStatus(provider, { providerId: "work", pending: 1, failed: 1 }).needsAttention).toBe(true);
    expect(homeProviderStatus(undefined)).toMatchObject({ state: "missing", needsAttention: true });
    expect(homeProviderStatus(failing, undefined, 2, true).state).toBe("syncing");
  });
});
