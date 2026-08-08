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
    delete legacy.providerMutationReceipts;

    const migrated = migrateVaultState(legacy);
    expect(migrated).toMatchObject({ schemaVersion: 2, sourceRecords: [], providerMutationReceipts: [], settings: { protectionMode: "master-password" } });
    expect(migrated.items[0]).toMatchObject({
      kind: "login",
      uriRules: [
        { uri: "example.com", matchType: "base-domain" },
        { uri: "https://login.example.com", matchType: "base-domain" }
      ]
    });
    expect(migrateVaultState(migrated)).toEqual(migrated);
  });

  it("carries source envelopes of unrecognised formats through untouched", () => {
    const current = createEmptyVaultState("2026-07-18T00:00:00.000Z");
    const future = {
      providerId: "provider-from-a-newer-build",
      itemId: "item-1",
      remoteId: "row-42",
      revision: "7",
      format: "some-format-this-build-has-never-heard-of",
      encoding: "cbor",
      payload: "b3BhcXVl",
      contentHash: "hash",
      extraKeyFromTheFuture: { nested: true }
    };
    const known = { providerId: "provider-1", remoteId: "cipher-1", format: "bitwarden-cipher", encoding: "json", payload: "{}", contentHash: "hash-2" };

    const migrated = migrateVaultState({ ...current, sourceRecords: [future, known] });

    expect(migrated.sourceRecords).toEqual([future, known]);
  });

  it("drops only structurally invalid source envelopes", () => {
    const current = createEmptyVaultState("2026-07-18T00:00:00.000Z");
    const valid = { providerId: "provider-1", remoteId: "row-1", format: "mdbx-row", encoding: "json", payload: "{}", contentHash: "hash" };

    const migrated = migrateVaultState({
      ...current,
      sourceRecords: [
        valid,
        { ...valid, format: "" },
        { ...valid, format: "f".repeat(65) },
        { ...valid, encoding: 7 },
        { ...valid, payload: undefined },
        null
      ]
    });

    expect(migrated.sourceRecords).toEqual([valid]);
  });

  it("retires MDBX1 accounts without discarding their encrypted configuration", () => {
    const current = createEmptyVaultState("2026-08-01T00:00:00.000Z");
    const local = current.providers[0];
    const legacy = {
      id: "mdbx-old",
      kind: "mdbx",
      name: "旧 MDBX",
      enabled: true,
      isDefaultSaveTarget: true,
      config: { fileName: "personal.mdbx", unlockMethod: "password", deviceId: "device-old" },
      lastError: "旧错误"
    };
    const state = {
      ...current,
      providers: [{ ...local, isDefaultSaveTarget: false }, legacy],
      settings: { ...current.settings, defaultProviderId: legacy.id }
    };

    const migrated = migrateVaultState(state);
    expect(migrated.providers.find((provider) => provider.id === legacy.id)).toEqual({
      ...legacy,
      kind: "mdbx-legacy",
      enabled: false,
      isDefaultSaveTarget: false,
      config: {
        ...legacy.config,
        mdbxGeneration: 1,
        formatVersion: "MDBX-1",
        supportState: "unsupported",
        legacyLastError: "旧错误"
      },
      lastError: "此密码源使用 Monica Extension 已停用的 MDBX1 实现。请使用 Monica Android 或桌面端升级为 MDBX2 后重新连接。"
    });
    expect(migrated.settings.defaultProviderId).toBe(local.id);
    expect(migrated.providers.find((provider) => provider.id === local.id)?.isDefaultSaveTarget).toBe(true);
    expect(migrateVaultState(migrated)).toEqual(migrated);
  });
});
