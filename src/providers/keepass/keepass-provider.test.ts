import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import type { LoginItem, ProviderAccount, VaultItem } from "../../core/model";
import { buildKeePassFixture, keePassCredentials, type KeePassFixtureEntry } from "./keepass-fixture";
import { KeePassProvider } from "./keepass-provider";
import { keePassFieldText } from "./keepass-login-codec";

/**
 * Adapter-level assertions: what the settings UI may see, and what survives an edit made through the
 * provider rather than through the writer directly. Fixtures are built in-extension with kdbxweb.
 */

const PASSWORD = "fixture master password";
const ENTRIES: KeePassFixtureEntry[] = [
  {
    title: "GitHub",
    fields: { UserName: "alice", "Some Future Field": "未来值" },
    protectedFields: { Password: "hunter2" }
  }
];

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "kp-a",
    kind: "keepass",
    name: "Monica KeePass",
    enabled: true,
    isDefaultSaveTarget: false,
    config: { databaseId: 7 },
    ...overrides
  };
}

async function unlock(provider: KeePassProvider, entries: KeePassFixtureEntry[] = ENTRIES) {
  const bytes = await buildKeePassFixture({ entries, name: "测试库" });
  const target = account();
  const summary = await provider.unlock(target, bytes, { password: PASSWORD });
  return { target, summary };
}

async function sync(provider: KeePassProvider, target: ProviderAccount, localItems: VaultItem[]) {
  return provider.sync(target, { now: "2026-07-26T12:00:00.000Z", localItems });
}

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
    providerRefs: [{ providerId: "kp-a" }],
    ...overrides
  };
}

async function reopen(provider: KeePassProvider, target: ProviderAccount): Promise<kdbxweb.Kdbx> {
  const bytes = await provider.exportFile(target.id);
  return kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
}

describe("KeePassProvider", () => {
  it("summarizes the file without handing the UI the database or its entries", async () => {
    const provider = new KeePassProvider();
    const { summary } = await unlock(provider);

    expect(summary).toMatchObject({ providerId: "kp-a", databaseName: "测试库", versionMajor: 4, itemCount: 1, dirty: false });
    expect(Object.keys(summary)).not.toContain("database");
    expect(Object.keys(summary)).not.toContain("entriesByUuid");
  });

  it("refuses every other call until the file is unlocked", async () => {
    const provider = new KeePassProvider();

    expect(provider.isUnlocked("kp-a")).toBe(false);
    await expect(provider.create(account(), newLogin())).rejects.toThrow("尚未解锁");
  });

  it("forgets the session on lock so a re-read needs the password again", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);

    provider.lock();

    expect(provider.isUnlocked(target.id)).toBe(false);
  });

  it("carries the KDBX 3 warning through to the summary rather than silently upgrading the file", async () => {
    const provider = new KeePassProvider();
    const bytes = await buildKeePassFixture({ entries: ENTRIES, version: 3 });

    const summary = await provider.unlock(account(), bytes, { password: PASSWORD });

    expect(summary.versionMajor).toBe(3);
    expect(summary.warnings.join()).toContain("KDBX 3");
  });

  it("creates an entry in the group the item names and reports it in the exported file", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);

    const created = await provider.create(target, newLogin({ keepassGroupPath: encodeURIComponent("工作") }));

    const reopened = await reopen(provider, target);
    const group = reopened.getDefaultGroup().groups.find((child) => child.name === "工作")!;
    expect(keePassFieldText(group.entries[0].fields.get("Title"))).toBe("浏览器新建");
    expect(created.providerRefs.find((reference) => reference.providerId === target.id)?.remoteId).toBe(
      group.entries[0].uuid.toString()
    );
  });

  /** The handoff's core requirement, exercised end to end: an edit may not disturb a field it does not own. */
  it("keeps a field this build has never heard of when the browser edits the same entry", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);
    const item = (await sync(provider, target, [])).items[0] as LoginItem;

    await provider.update(target, { ...item, username: "grace" });

    const reopened = new KeePassProvider();
    const bytes = await provider.exportFile(target.id);
    const summary = await reopened.unlock(account({ id: "kp-b" }), bytes, { password: PASSWORD });
    expect(summary.itemCount).toBe(1);
    const after = (await reopened.sync(account({ id: "kp-b" }), { now: "2026-07-26T12:00:00.000Z", localItems: [] }))
      .items[0] as LoginItem;
    expect(after.username).toBe("grace");
    expect(after.customFields?.find((field) => field.name === "Some Future Field")?.value).toBe("未来值");
  });

  it("marks the session dirty on write and clears it once the file is exported", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);
    expect(provider.summarize(target.id).dirty).toBe(false);

    await provider.create(target, newLogin());
    expect(provider.summarize(target.id).dirty).toBe(true);

    await provider.exportFile(target.id);
    expect(provider.summarize(target.id).dirty).toBe(false);
  });

  it("lists opaque attachment metadata and reads only the requested bounded bytes", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider, [{
      title: "GitHub",
      fields: { UserName: "alice" },
      protectedFields: { Password: "hunter2" },
      binaries: { "document.bin": new Uint8Array([1, 2, 3, 4]) }
    }]);
    const item = (await sync(provider, target, [])).items[0];

    const attachments = provider.listAttachments(target, item);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ providerKind: "keepass", fileName: "document.bin", sizeBytes: 4, protected: false });
    expect(attachments[0].attachmentId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(attachments)).not.toContain(item.providerRefs[0].remoteId);

    expect(provider.readAttachment(target, item, attachments[0].attachmentId, 1, 2)).toMatchObject({
      offset: 1,
      nextOffset: 3,
      bytes: new Uint8Array([2, 3]),
      eof: false
    });
    expect(provider.readAttachment(target, item, attachments[0].attachmentId, 4, 2)).toMatchObject({ bytes: new Uint8Array(), eof: true });
    expect(() => provider.readAttachment(target, item, attachments[0].attachmentId, 5, 2)).toThrowError(/超过文件大小/);
  });

  it("adds and explicitly replaces an attachment while preserving both prior entry states", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);
    const item = (await sync(provider, target, [])).items[0];

    await provider.addAttachment(target, item, "document.bin", new Uint8Array([1, 2, 3]), false);
    expect(provider.summarize(target.id).dirty).toBe(true);
    await expect(provider.addAttachment(target, item, "document.bin", new Uint8Array([4, 5]), false))
      .rejects.toMatchObject({ code: "attachment-name-conflict" });
    await provider.addAttachment(target, item, "document.bin", new Uint8Array([4, 5]), true);

    const reopened = await reopen(provider, target);
    const entry = reopened.getDefaultGroup().entries.find((candidate) => keePassFieldText(candidate.fields.get("Title")) === "GitHub")!;
    expect(entry.history).toHaveLength(2);
    expect([...binaryBytes(entry.binaries.get("document.bin")!)]).toEqual([4, 5]);
    expect([...binaryBytes(entry.history[1].binaries.get("document.bin")!)]).toEqual([1, 2, 3]);
  });

  it("deletes an attachment idempotently while retaining history and shared pool data", async () => {
    const shared = new Uint8Array([7, 8, 9]);
    const provider = new KeePassProvider();
    const { target } = await unlock(provider, [
      { title: "First", fields: { UserName: "one" }, protectedFields: { Password: "a" }, binaries: { "first.bin": shared } },
      { title: "Second", fields: { UserName: "two" }, protectedFields: { Password: "b" }, binaries: { "second.bin": shared } }
    ]);
    const items = await sync(provider, target, []);
    const first = items.items.find((item) => item.title === "First")!;
    const attachment = provider.listAttachments(target, first)[0];

    expect(provider.deleteAttachment(target, first, attachment.attachmentId)).toBe(true);
    expect(provider.deleteAttachment(target, first, attachment.attachmentId)).toBe(false);

    const reopened = await reopen(provider, target);
    const firstEntry = reopened.getDefaultGroup().entries.find((entry) => keePassFieldText(entry.fields.get("Title")) === "First")!;
    const secondEntry = reopened.getDefaultGroup().entries.find((entry) => keePassFieldText(entry.fields.get("Title")) === "Second")!;
    expect(firstEntry.binaries.has("first.bin")).toBe(false);
    expect([...binaryBytes(firstEntry.history[0].binaries.get("first.bin")!)]).toEqual([7, 8, 9]);
    expect([...binaryBytes(secondEntry.binaries.get("second.bin")!)]).toEqual([7, 8, 9]);
  });

  it("invalidates attachment handles when the KeePass session is locked", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider, [{ title: "GitHub", binaries: { "a.bin": new Uint8Array([1]) } }]);
    const item = (await sync(provider, target, [])).items[0];
    const attachment = provider.listAttachments(target, item)[0];

    provider.lockAccount(target.id);

    expect(() => provider.readAttachment(target, item, attachment.attachmentId, 0)).toThrowError(/尚未解锁/);
  });

  it("warns that the edited database only exists in memory until the user saves it", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);
    await provider.create(target, newLogin());

    const result = await sync(provider, target, []);

    expect(result.warnings.join()).toContain("导出文件并覆盖原文件");
  });

  it("moves a removed entry to the recycle bin rather than dropping it from the file", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);
    const item = (await sync(provider, target, [])).items[0] as LoginItem;

    await provider.remove(target, item);

    expect(provider.summarize(target.id).itemCount).toBe(0);
    const reopened = await reopen(provider, target);
    const bin = reopened.getDefaultGroup().groups.find((group) => group.uuid.equals(reopened.meta.recycleBinUuid!))!;
    expect(bin.entries).toHaveLength(1);
  });

  it("envelopes an entry no codec claimed and leaves it out of the item list", async () => {
    const provider = new KeePassProvider();
    const { target, summary } = await unlock(provider, [
      ...ENTRIES,
      { title: "未来", fields: { MonicaItemType: "CRYPTO_SEED" }, protectedFields: { MonicaItemData: "{}" } }
    ]);

    expect(summary.itemCount).toBe(1);
    expect(summary.skipped).toMatchObject([{ reason: "unknown-item-type" }]);

    const result = await sync(provider, target, []);
    expect(result.sourceRecords).toMatchObject([{ format: "keepass-entry", encoding: "json" }]);
    expect(JSON.parse(result.sourceRecords![0].payload).fields).toContainEqual({
      name: "MonicaItemType",
      protected: false,
      value: "CRYPTO_SEED"
    });
    expect(result.warnings.join()).toContain("无法解析");
  });

  it("never rewrites an entry it could not model", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider, [
      { title: "未来", fields: { MonicaItemType: "CRYPTO_SEED" }, protectedFields: { MonicaItemData: '{"a":1}' } }
    ]);

    await sync(provider, target, []);
    await provider.create(target, newLogin());

    const reopened = await reopen(provider, target);
    const untouched = reopened.getDefaultGroup().entries.find((entry) => keePassFieldText(entry.fields.get("Title")) === "未来")!;
    expect(keePassFieldText(untouched.fields.get("MonicaItemData"))).toBe('{"a":1}');
    expect(untouched.history).toHaveLength(0);
  });

  /** Without a stored fingerprint there is no baseline, so the file's copy must win rather than be overwritten. */
  it("takes the file's copy for an item that has never been synced", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);
    const item = (await sync(provider, target, [])).items[0] as LoginItem;
    const noBaseline = {
      ...item,
      username: "本地改过但没基线",
      providerRefs: item.providerRefs.map((reference) =>
        reference.providerId === target.id ? { ...reference, etag: undefined } : reference
      )
    };

    const result = await sync(provider, target, [noBaseline]);

    expect((result.items[0] as LoginItem).username).toBe("alice");
    expect(result.conflicts).toHaveLength(0);
  });

  it("reports a conflict instead of overwriting when both sides changed since the last sync", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);
    const item = (await sync(provider, target, [])).items[0] as LoginItem;
    const edited = {
      ...item,
      username: "本地",
      providerRefs: item.providerRefs.map((reference) =>
        reference.providerId === target.id ? { ...reference, revision: "stale" } : reference
      )
    };

    const result = await sync(provider, target, [edited]);

    expect(result.conflicts).toHaveLength(1);
    expect(result.accountPatch).toMatchObject({ lastError: expect.stringContaining("冲突") });
    const reopened = await reopen(provider, target);
    expect(keePassFieldText(reopened.getDefaultGroup().entries[0].fields.get("UserName"))).toBe("alice");
  });

  it("writes a locally edited item back when only the browser changed it", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);
    const item = (await sync(provider, target, [])).items[0] as LoginItem;

    const result = await sync(provider, target, [{ ...item, username: "grace" }]);

    expect(result.conflicts).toHaveLength(0);
    expect((result.items[0] as LoginItem).username).toBe("grace");
    const reopened = await reopen(provider, target);
    expect(keePassFieldText(reopened.getDefaultGroup().entries[0].fields.get("UserName"))).toBe("grace");
  });

  it("leaves items belonging to another provider untouched", async () => {
    const provider = new KeePassProvider();
    const { target } = await unlock(provider);
    const foreign = newLogin({ id: "other", providerRefs: [{ providerId: "bitwarden-a", remoteId: "x" }] });

    const result = await sync(provider, target, [foreign]);

    expect(result.items.find((item) => item.id === "other")).toEqual(foreign);
  });
});

function binaryBytes(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): Uint8Array {
  const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
  return value instanceof kdbxweb.ProtectedValue ? value.getBinary() : new Uint8Array(value);
}
