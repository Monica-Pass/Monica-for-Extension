import { describe, expect, it } from "vitest";
import { createEmptyVaultState, createLoginItem } from "./model";
import { migrateVaultState } from "./migrations";

describe("vault schema migrations", () => {
  it("migrates v1 URI strings and defaults idempotently", () => {
    const current = createEmptyVaultState("2026-07-18T00:00:00.000Z");
    const login = createLoginItem({ title: "Legacy", password: "", uris: ["example.com", "https://login.example.com"] });
    const legacyLogin = { ...login } as Record<string, unknown>;
    delete legacyLogin.uriRules;
    const legacy = {
      ...current,
      schemaVersion: 1,
      items: [legacyLogin],
      settings: { autoLockMinutes: 15, defaultProviderId: current.settings.defaultProviderId }
    } as Record<string, unknown>;
    delete legacy.sourceRecords;

    const migrated = migrateVaultState(legacy);
    expect(migrated).toMatchObject({ schemaVersion: 2, sourceRecords: [], settings: { protectionMode: "master-password" } });
    expect(migrated.items[0]).toMatchObject({
      kind: "login",
      uriRules: [
        { uri: "example.com", matchType: "base-domain" },
        { uri: "https://login.example.com", matchType: "base-domain" }
      ]
    });
    expect(migrateVaultState(migrated)).toEqual(migrated);
  });
});
