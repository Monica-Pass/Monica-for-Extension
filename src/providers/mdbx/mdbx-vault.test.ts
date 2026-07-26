import { beforeAll, describe, expect, it } from "vitest";
import type { LoginItem } from "../../core/model";
import { buildMdbxFixture } from "./mdbx-fixture";
import type { MdbxSqliteEngine } from "./mdbx-sqlite";
import { createSqlJsEngine } from "./mdbx-sqljs";
import { openMdbxVault } from "./mdbx-vault";

/**
 * These run against a real SQLite file produced by the same engine the extension ships, so a schema
 * or envelope mistake fails here rather than the first time a user opens an Android vault.
 */
let engine: MdbxSqliteEngine;

beforeAll(async () => {
  const initSqlJs = (await import("sql.js")).default;
  engine = await createSqlJsEngine(initSqlJs);
});

const PASSWORD = { unlockMethod: "password", password: "fixture master password" } as const;
const LOGIN_ENTRY = {
  entryId: "entry-login",
  entryType: "password",
  title: "示例站点",
  payload: {
    kind: "password",
    username: "ada",
    password_plain: "hunter2",
    website: "https://example.test",
    notes: "备注",
    custom_fields: [{ title: "PIN", value: "1234", is_protected: true, sort_order: 0 }],
    field_from_a_newer_android: { keep: true }
  }
};

describe("mdbx vault reader", () => {
  it("opens a password-protected vault and decrypts its entries", async () => {
    const bytes = await buildMdbxFixture(engine, { credential: PASSWORD, entries: [LOGIN_ENTRY] });

    const snapshot = await openMdbxVault(engine.open(bytes), PASSWORD, 1, "mdbx-a");

    expect(snapshot.access.level).toBe("read-write");
    expect(snapshot.meta).toMatchObject({ vaultId: "vault-fixture", formatVersion: "MDBX-1", unlockMethod: "password", iterations: 50_000 });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({ kind: "login", title: "示例站点", username: "ada", password: "hunter2" });
  });

  it("keeps the decrypted payload verbatim so a later write can diff against it", async () => {
    const bytes = await buildMdbxFixture(engine, { credential: PASSWORD, entries: [LOGIN_ENTRY] });

    const snapshot = await openMdbxVault(engine.open(bytes), PASSWORD, 1, "mdbx-a");

    expect(snapshot.payloads.get("entry-login")).toEqual(LOGIN_ENTRY.payload);
  });

  it("rejects a wrong password without decrypting anything", async () => {
    const bytes = await buildMdbxFixture(engine, { credential: PASSWORD, entries: [LOGIN_ENTRY] });

    await expect(openMdbxVault(engine.open(bytes), { unlockMethod: "password", password: "wrong" }, 1, "mdbx-a")).rejects.toThrow("凭据不正确");
  });

  it("refuses a credential whose unlock method is not the one the vault declares", async () => {
    const bytes = await buildMdbxFixture(engine, { credential: PASSWORD, entries: [] });

    await expect(openMdbxVault(engine.open(bytes), { unlockMethod: "device_key" }, 1, "mdbx-a")).rejects.toThrow("解锁方式");
  });

  it("opens a device-key vault, which is how an empty master password is stored", async () => {
    const credential = { unlockMethod: "device_key" } as const;
    const bytes = await buildMdbxFixture(engine, { credential, entries: [LOGIN_ENTRY] });

    const snapshot = await openMdbxVault(engine.open(bytes), credential, 1, "mdbx-a");

    expect(snapshot.meta.unlockMethod).toBe("device_key");
    expect(snapshot.items[0]).toMatchObject({ username: "ada" });
  });

  it("opens a key-file vault", async () => {
    const credential = { unlockMethod: "key_file", keyFile: new Uint8Array(64).fill(5) } as const;
    const bytes = await buildMdbxFixture(engine, { credential, entries: [LOGIN_ENTRY] });

    const snapshot = await openMdbxVault(engine.open(bytes), credential, 1, "mdbx-a");

    expect(snapshot.items[0]).toMatchObject({ username: "ada" });
  });

  it("warns rather than silently opening a vault that stores its contents in plaintext", async () => {
    const bytes = await buildMdbxFixture(engine, { credential: PASSWORD, unencrypted: true, entries: [LOGIN_ENTRY] });

    const snapshot = await openMdbxVault(engine.open(bytes), PASSWORD, 1, "mdbx-a");

    expect(snapshot.warnings.some((warning) => warning.includes("明文"))).toBe(true);
    expect(snapshot.items[0]).toMatchObject({ username: "ada" });
  });

  it("keeps an entry_type it cannot model instead of parsing or dropping the row", async () => {
    const bytes = await buildMdbxFixture(engine, {
      credential: PASSWORD,
      entries: [LOGIN_ENTRY, { entryId: "entry-x", entryType: "quantum_credential", title: "未来条目", payload: { anything: 1 } }]
    });

    const snapshot = await openMdbxVault(engine.open(bytes), PASSWORD, 1, "mdbx-a");

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.unsupported).toEqual([{ entryId: "entry-x", entryType: "quantum_credential", reason: expect.stringContaining("quantum_credential") }]);
    expect(snapshot.payloads.get("entry-x")).toEqual({ anything: 1 });
  });

  it("degrades to read-only when a write-only table is absent", async () => {
    const bytes = await buildMdbxFixture(engine, { credential: PASSWORD, omitTables: ["conflicts"], entries: [] });

    const snapshot = await openMdbxVault(engine.open(bytes), PASSWORD, 1, "mdbx-a");

    expect(snapshot.access.level).toBe("read-only");
    expect(snapshot.warnings.some((warning) => warning.includes("conflicts"))).toBe(true);
  });

  it("degrades to read-only when the vault declares an extension this build does not implement", async () => {
    const bytes = await buildMdbxFixture(engine, { credential: PASSWORD, criticalExtensions: "sky-portable-v2", entries: [] });

    const snapshot = await openMdbxVault(engine.open(bytes), PASSWORD, 1, "mdbx-a");

    expect(snapshot.access.level).toBe("read-only");
  });

  it("refuses to open a format version this build does not know", async () => {
    const bytes = await buildMdbxFixture(engine, { credential: PASSWORD, formatVersion: "MDBX-9", entries: [] });

    await expect(openMdbxVault(engine.open(bytes), PASSWORD, 1, "mdbx-a")).rejects.toThrow("MDBX-9");
  });

  it("marks a tombstoned entry as deleted rather than hiding it from the caller", async () => {
    const bytes = await buildMdbxFixture(engine, { credential: PASSWORD, entries: [{ ...LOGIN_ENTRY, deleted: true }] });

    const snapshot = await openMdbxVault(engine.open(bytes), PASSWORD, 1, "mdbx-a");

    expect((snapshot.items[0] as LoginItem).deletedAt).toBeTruthy();
  });
});
