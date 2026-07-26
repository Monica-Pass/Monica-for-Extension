import { beforeAll, describe, expect, it } from "vitest";
import type { LoginItem, ProviderAccount, VaultItem } from "../../core/model";
import { buildMdbxFixture } from "./mdbx-fixture";
import { MdbxProvider } from "./mdbx-provider";
import { queryMdbxRow, queryMdbxRows, setMdbxSqliteEngineLoader, type MdbxSqliteEngine } from "./mdbx-sqlite";
import { createSqlJsEngine } from "./mdbx-sqljs";

let engine: MdbxSqliteEngine;

beforeAll(async () => {
  const initSqlJs = (await import("sql.js")).default;
  engine = await createSqlJsEngine(initSqlJs);
  setMdbxSqliteEngineLoader(async () => engine);
});

const CREDENTIAL = { unlockMethod: "password", password: "provider master password" } as const;
const PAYLOAD = {
  kind: "password",
  username: "ada",
  password_plain: "hunter2",
  website: "https://example.test",
  future_key_from_a_newer_android: { nested: [1, 2] }
};

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "mdbx-a",
    kind: "mdbx",
    name: "Monica MDBX",
    enabled: true,
    isDefaultSaveTarget: false,
    config: { deviceId: "device-extension" },
    ...overrides
  };
}

async function unlock(provider: MdbxProvider, options: Partial<Parameters<typeof buildMdbxFixture>[1]> = {}) {
  const bytes = await buildMdbxFixture(engine, {
    credential: CREDENTIAL,
    entries: [{ entryId: "entry-1", entryType: "password", title: "示例站点", payload: PAYLOAD }],
    ...options
  });
  const target = account();
  const summary = await provider.unlock(target, bytes, CREDENTIAL);
  return { target, summary };
}

/** An item the user chose to save into this file already carries a ref with no `remoteId` yet. */
function newLogin(overrides: Partial<LoginItem> = {}): LoginItem {
  return {
    id: "local-new",
    kind: "login",
    title: "浏览器新建",
    favorite: false,
    notes: "",
    createdAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:00.000Z",
    username: "hopper",
    password: "pw",
    uris: ["https://new.test"],
    customFields: [],
    providerRefs: [{ providerId: "mdbx-a" }],
    ...overrides
  };
}

async function sync(provider: MdbxProvider, target: ProviderAccount, localItems: VaultItem[]) {
  return provider.sync(target, { now: "2026-07-26T12:00:00.000Z", localItems });
}

describe("MdbxProvider", () => {
  it("reports the file's protection level without exposing the epoch key", async () => {
    const provider = new MdbxProvider();
    const { summary } = await unlock(provider);

    expect(summary).toMatchObject({ providerId: "mdbx-a", formatVersion: "MDBX-1", accessLevel: "read-write", encrypted: true, itemCount: 1, dirty: false });
    expect(Object.keys(summary)).not.toContain("epochKey");
  });

  it("surfaces a plaintext vault as unencrypted with a warning rather than refusing to open it", async () => {
    const provider = new MdbxProvider();
    const { summary } = await unlock(provider, { unencrypted: true });

    expect(summary.encrypted).toBe(false);
    expect(summary.warnings.join()).toContain("明文");
  });

  it("writes a browser-created login as entry_type 'login', which is what Android imports", async () => {
    const provider = new MdbxProvider();
    const { target } = await unlock(provider);

    const created = await provider.create(target, newLogin());

    const database = provider.exportFile(target.id);
    const reopened = engine.open(database);
    const remoteId = created.providerRefs.find((reference) => reference.providerId === target.id)?.remoteId;
    expect(queryMdbxRow(reopened, "SELECT entry_type FROM entries WHERE entry_id = ?", [remoteId])?.entry_type).toBe("login");
  });

  it("keeps an unmodelled payload key when the browser edits the same entry", async () => {
    const provider = new MdbxProvider();
    const { target } = await unlock(provider);
    const result = await sync(provider, target, []);
    const item = result.items[0] as LoginItem;

    await provider.update(target, { ...item, username: "grace" });

    const reopened = new MdbxProvider();
    const summary = await reopened.unlock(account({ id: "mdbx-b" }), provider.exportFile(target.id), CREDENTIAL);
    expect(summary.itemCount).toBe(1);
    const after = await reopened.sync(account({ id: "mdbx-b" }), { now: "2026-07-26T12:00:00.000Z", localItems: [] });
    expect((after.items[0] as LoginItem).username).toBe("grace");
    expect(after.sourceRecords).toEqual([]);
  });

  it("keeps an entry type this build cannot model out of the item list and envelopes it verbatim", async () => {
    const provider = new MdbxProvider();
    const { target, summary } = await unlock(provider, {
      entries: [
        { entryId: "entry-1", entryType: "password", title: "示例站点", payload: PAYLOAD },
        { entryId: "entry-9", entryType: "from-a-newer-android", title: "未来类型", payload: { anything: [1, 2, 3] } }
      ]
    });

    expect(summary.itemCount).toBe(1);
    expect(summary.unsupported).toMatchObject([{ entryId: "entry-9", entryType: "from-a-newer-android" }]);

    const result = await sync(provider, target, []);
    expect(result.sourceRecords).toMatchObject([{ remoteId: "entry-9", format: "mdbx-row", encoding: "json" }]);
    expect(JSON.parse(result.sourceRecords![0].payload)).toEqual({ entry_type: "from-a-newer-android", payload: { anything: [1, 2, 3] } });
    expect(result.warnings.join()).toContain("无法解析");
  });

  it("never rewrites the row of an entry type it cannot model", async () => {
    const provider = new MdbxProvider();
    const { target } = await unlock(provider, {
      entries: [{ entryId: "entry-9", entryType: "from-a-newer-android", title: "未来类型", payload: { anything: 1 } }]
    });
    const before = engine.open(provider.exportFile(target.id));
    const beforeRow = queryMdbxRow(before, "SELECT * FROM entries WHERE entry_id = 'entry-9'");

    await sync(provider, target, []);
    await provider.create(target, newLogin());

    const after = engine.open(provider.exportFile(target.id));
    expect(queryMdbxRow(after, "SELECT * FROM entries WHERE entry_id = 'entry-9'")).toEqual(beforeRow);
  });

  it("downgrades writes to conflicts when the file declares an extension this build does not implement", async () => {
    const provider = new MdbxProvider();
    const { target, summary } = await unlock(provider, { criticalExtensions: "quantum-shard-v2" });
    expect(summary.accessLevel).toBe("read-only");

    const result = await sync(provider, target, [newLogin()]);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toContain("只读");
    expect(queryMdbxRows(engine.open(provider.exportFile(target.id)), "SELECT entry_id FROM entries")).toEqual([{ entry_id: "entry-1" }]);
  });

  it("refuses a direct write on a read-only file instead of silently dropping it", async () => {
    const provider = new MdbxProvider();
    const { target } = await unlock(provider, { criticalExtensions: "quantum-shard-v2" });

    await expect(provider.create(target, newLogin())).rejects.toThrow("只读");
  });

  it("rejects a credential whose unlock method does not match the file", async () => {
    const provider = new MdbxProvider();
    const bytes = await buildMdbxFixture(engine, { credential: CREDENTIAL, entries: [] });

    await expect(provider.unlock(account(), bytes, { unlockMethod: "device_key" })).rejects.toThrow("解锁方式");
  });

  it("rejects a wrong password without leaving a session behind", async () => {
    const provider = new MdbxProvider();
    const bytes = await buildMdbxFixture(engine, { credential: CREDENTIAL, entries: [] });

    await expect(provider.unlock(account(), bytes, { unlockMethod: "password", password: "wrong" })).rejects.toThrow("凭据不正确");
    expect(provider.isUnlocked("mdbx-a")).toBe(false);
  });

  it("flags unsaved changes until the file is exported", async () => {
    const provider = new MdbxProvider();
    const { target } = await unlock(provider);

    await provider.create(target, newLogin());
    expect(provider.summarize(target.id).dirty).toBe(true);

    provider.exportFile(target.id);
    expect(provider.summarize(target.id).dirty).toBe(false);
  });

  it("drops every decrypted session on lock", async () => {
    const provider = new MdbxProvider();
    const { target } = await unlock(provider);

    provider.lock();

    expect(provider.isUnlocked(target.id)).toBe(false);
    expect(() => provider.summarize(target.id)).toThrow("尚未解锁");
    await expect(sync(provider, target, [])).rejects.toThrow("尚未解锁");
  });

  it("conflicts rather than overwriting when both sides changed the same entry", async () => {
    const provider = new MdbxProvider();
    const { target } = await unlock(provider);
    const synced = (await sync(provider, target, [])).items[0] as LoginItem;

    // Android moved on: the row's clock advances while the browser holds a stale reference.
    await provider.update(target, { ...synced, username: "android-edit" });
    const staleLocal = { ...synced, username: "browser-edit" };

    const result = await sync(provider, target, [staleLocal]);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toContain("都修改了");
    expect((result.items[0] as LoginItem).username).toBe("browser-edit");
  });
});
