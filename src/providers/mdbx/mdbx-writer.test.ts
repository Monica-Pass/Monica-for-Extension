import { beforeAll, describe, expect, it } from "vitest";
import type { LoginItem } from "../../core/model";
import { buildMdbxFixture } from "./mdbx-fixture";
import { queryMdbxRow, queryMdbxRows, type MdbxSqliteEngine } from "./mdbx-sqlite";
import { createSqlJsEngine } from "./mdbx-sqljs";
import { openMdbxVault } from "./mdbx-vault";
import { deleteMdbxEntry, writeMdbxEntry, type MdbxWriteContext } from "./mdbx-writer";

let engine: MdbxSqliteEngine;

beforeAll(async () => {
  const initSqlJs = (await import("sql.js")).default;
  engine = await createSqlJsEngine(initSqlJs);
});

const CREDENTIAL = { unlockMethod: "password", password: "writer master password" } as const;
const PAYLOAD = {
  kind: "password",
  username: "ada",
  password_plain: "hunter2",
  website: "https://example.test",
  notes: "备注",
  future_key_from_a_newer_android: { nested: [1, 2], flag: true }
};

async function openFixture(overrides: Partial<Parameters<typeof buildMdbxFixture>[1]> = {}) {
  const bytes = await buildMdbxFixture(engine, {
    credential: CREDENTIAL,
    entries: [{ entryId: "entry-1", entryType: "password", title: "示例站点", payload: PAYLOAD }],
    ...overrides
  });
  const database = engine.open(bytes);
  const snapshot = await openMdbxVault(database, CREDENTIAL, 1, "mdbx-a");
  return { database, snapshot };
}

function writeContext(database: Awaited<ReturnType<typeof openFixture>>["database"], snapshot: Awaited<ReturnType<typeof openFixture>>["snapshot"]): MdbxWriteContext {
  return {
    database,
    epochKey: undefined,
    deviceId: "device-extension",
    now: "2026-07-26T12:00:00.000Z",
    originalPayload: snapshot.payloads.get("entry-1"),
    previous: snapshot.items[0]
  };
}

describe("mdbx write-back", () => {
  it("survives a full round trip: edit, export, reopen", async () => {
    const { database, snapshot } = await openFixture();
    const item = snapshot.items[0] as LoginItem;

    await writeMdbxEntry({ ...writeContext(database, snapshot), epochKey: await epochKeyFor(database) }, "entry-1", { ...item, username: "grace" });

    const reopened = await openMdbxVault(engine.open(database.export()), CREDENTIAL, 1, "mdbx-a");
    expect(reopened.items[0]).toMatchObject({ username: "grace", password: "hunter2", title: "示例站点" });
  });

  it("carries an unknown payload key through the round trip", async () => {
    const { database, snapshot } = await openFixture();
    const item = snapshot.items[0] as LoginItem;

    await writeMdbxEntry({ ...writeContext(database, snapshot), epochKey: await epochKeyFor(database) }, "entry-1", { ...item, username: "grace" });

    const reopened = await openMdbxVault(engine.open(database.export()), CREDENTIAL, 1, "mdbx-a");
    expect(reopened.payloads.get("entry-1")?.future_key_from_a_newer_android).toEqual(PAYLOAD.future_key_from_a_newer_android);
  });

  it("leaves a column a newer Android build added untouched, because it never replaces the row", async () => {
    const { database, snapshot } = await openFixture();
    database.run("ALTER TABLE entries ADD COLUMN future_column TEXT");
    database.run("UPDATE entries SET future_column = 'from-a-newer-build' WHERE entry_id = 'entry-1'");
    const item = snapshot.items[0] as LoginItem;

    await writeMdbxEntry({ ...writeContext(database, snapshot), epochKey: await epochKeyFor(database) }, "entry-1", { ...item, username: "grace" });

    expect(queryMdbxRow(database, "SELECT future_column FROM entries WHERE entry_id = 'entry-1'")?.future_column).toBe("from-a-newer-build");
  });

  it("does not touch the row at all when nothing changed", async () => {
    const { database, snapshot } = await openFixture();
    const before = queryMdbxRow(database, "SELECT object_clock, updated_at FROM entries WHERE entry_id = 'entry-1'");

    await writeMdbxEntry({ ...writeContext(database, snapshot), epochKey: await epochKeyFor(database) }, "entry-1", snapshot.items[0]);

    expect(queryMdbxRow(database, "SELECT object_clock, updated_at FROM entries WHERE entry_id = 'entry-1'")).toEqual(before);
  });

  it("appends a commit whose parent is the previous head", async () => {
    const { database, snapshot } = await openFixture();
    const item = snapshot.items[0] as LoginItem;
    const context = { ...writeContext(database, snapshot), epochKey: await epochKeyFor(database) };

    const first = await writeMdbxEntry(context, "entry-1", { ...item, username: "grace" });
    const second = await writeMdbxEntry({ ...context, previous: { ...item, username: "grace" } }, "entry-1", { ...item, username: "hopper" });

    expect(queryMdbxRows(database, "SELECT parent_commit_id FROM commit_parents WHERE commit_id = ?", [second])).toEqual([{ parent_commit_id: first }]);
    expect(queryMdbxRow(database, "SELECT head_commit_id FROM device_heads WHERE device_id = 'device-extension'")?.head_commit_id).toBe(second);
    expect(queryMdbxRow(database, "SELECT head_commit_id FROM branches WHERE branch_id = 'main'")?.head_commit_id).toBe(second);
  });

  it("registers this browser as a device rather than impersonating the Android one", async () => {
    const { database, snapshot } = await openFixture();
    const item = snapshot.items[0] as LoginItem;

    await writeMdbxEntry({ ...writeContext(database, snapshot), epochKey: await epochKeyFor(database) }, "entry-1", { ...item, username: "grace" });

    expect(queryMdbxRow(database, "SELECT client_label FROM devices WHERE device_id = 'device-extension'")?.client_label).toBe("monica-extension");
  });

  it("tombstones a deletion instead of removing the row, so other devices see it", async () => {
    const { database, snapshot } = await openFixture();

    await deleteMdbxEntry({ ...writeContext(database, snapshot), epochKey: await epochKeyFor(database) }, "entry-1");

    expect(queryMdbxRow(database, "SELECT deleted FROM entries WHERE entry_id = 'entry-1'")?.deleted).toBe(1);
    expect(queryMdbxRows(database, "SELECT target_object_type FROM tombstones ORDER BY target_object_type")).toEqual([
      { target_object_type: "entry" },
      { target_object_type: "project" }
    ]);
  });

  it("creates a new entry with its project and index row", async () => {
    const { database, snapshot } = await openFixture();
    const item: LoginItem = {
      id: "local-new",
      kind: "login",
      title: "新条目",
      favorite: false,
      notes: "",
      createdAt: "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z",
      username: "hopper",
      password: "pw",
      uris: [],
      customFields: [],
      providerRefs: []
    };

    await writeMdbxEntry({ ...writeContext(database, snapshot), epochKey: await epochKeyFor(database), originalPayload: undefined, previous: undefined }, "entry-2", item);

    const reopened = await openMdbxVault(engine.open(database.export()), CREDENTIAL, 1, "mdbx-a");
    expect(reopened.items.map((entry) => entry.title).sort()).toEqual(["新条目", "示例站点"].sort());
    expect(queryMdbxRows(database, "SELECT object_id FROM object_index WHERE object_type = 'entry'")).toEqual([{ object_id: "entry-2" }]);
  });
});

async function epochKeyFor(database: Awaited<ReturnType<typeof openFixture>>["database"]): Promise<Uint8Array> {
  const { bytesEqual, deriveMdbxCredentialKey, mdbxVerifier, unwrapMdbxEpochKey } = await import("./mdbx-crypto");
  const meta = queryMdbxRow(database, "SELECT * FROM vault_meta LIMIT 1") || {};
  const wrapped = queryMdbxRow(database, "SELECT wrapped_epoch_key_ct FROM key_epochs WHERE status = 'active' LIMIT 1")?.wrapped_epoch_key_ct as Uint8Array;
  const key = await deriveMdbxCredentialKey(CREDENTIAL, meta.credential_salt as Uint8Array, 50_000);
  if (!bytesEqual(await mdbxVerifier(key, String(meta.vault_id)), meta.credential_verifier as Uint8Array)) throw new Error("fixture verifier mismatch");
  return unwrapMdbxEpochKey(key, wrapped);
}
