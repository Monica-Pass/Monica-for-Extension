import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import type { ProviderAccount, VaultItem } from "../../core/model";
import { buildKeePassFixture, keePassCredentials } from "./keepass-fixture";
import {
  KEEPASS_HISTORY_MAX_FIELD_BYTES,
  KEEPASS_HISTORY_MAX_PAGE_SIZE
} from "./keepass-history";
import { keePassFieldText } from "./keepass-login-codec";
import { KeePassProvider } from "./keepass-provider";
import { SecureVaultService } from "../../security/secure-vault-service";
import { MemoryVaultSessionStore } from "../../security/vault-session";
import { MemoryVaultStorage } from "../../security/vault-storage";

const PASSWORD = "fixture master password";

function account(): ProviderAccount {
  return {
    id: "kp-history",
    kind: "keepass",
    name: "History KDBX",
    enabled: true,
    isDefaultSaveTarget: false,
    config: { databaseId: 19 }
  };
}

async function sync(provider: KeePassProvider, target: ProviderAccount): Promise<VaultItem> {
  return (await provider.sync(target, { now: "2026-08-02T12:00:00.000Z", localItems: [] })).items[0];
}

describe("KeePass entry history", () => {
  it("pages newest-first opaque summaries and returns no field values", async () => {
    const fixture = await historyFixture();
    const provider = new KeePassProvider();
    const target = account();
    await provider.unlock(target, fixture.bytes, { password: PASSWORD });
    const item = await sync(provider, target);

    const first = provider.listEntryHistory(target, item, { pageSize: 1 });
    expect(first.totalCount).toBe(2);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      modifiedAt: "2026-02-02T02:02:02.000Z",
      fieldCount: 4,
      protectedFieldCount: 1,
      attachmentCount: 1,
      tagCount: 1,
      customDataCount: 1,
      autoTypeItemCount: 1
    });
    expect(first.items[0].historyId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.nextCursor).toMatch(/^[a-f0-9-]{36}$/);

    const second = provider.listEntryHistory(target, item, { pageSize: 1, cursor: first.nextCursor });
    expect(second.items[0].modifiedAt).toBe("2026-01-01T01:01:01.000Z");
    expect(second.nextCursor).toBeUndefined();

    const serialized = JSON.stringify([first, second]);
    expect(serialized).not.toContain("secret-one");
    expect(serialized).not.toContain("secret-two");
    expect(serialized).not.toContain("unknown-one");
    expect(serialized).not.toContain(item.providerRefs[0].remoteId);
    expect(() => provider.listEntryHistory(target, item, { pageSize: KEEPASS_HISTORY_MAX_PAGE_SIZE + 1 }))
      .toThrowError(/分页数量/);
  });

  it("returns bounded metadata and reveals exactly one selected field", async () => {
    const fixture = await historyFixture();
    const provider = new KeePassProvider();
    const target = account();
    await provider.unlock(target, fixture.bytes, { password: PASSWORD });
    const item = await sync(provider, target);
    const oldest = provider.listEntryHistory(target, item, { pageSize: 2 }).items[1];

    const detail = provider.getEntryHistoryDetail(target, item, oldest.historyId);
    expect(detail).toMatchObject({
      historyId: oldest.historyId,
      modifiedAt: "2026-01-01T01:01:01.000Z",
      tagCount: 1,
      customDataCount: 1,
      qualityCheck: false,
      autoType: { enabled: false, itemCount: 1, hasDefaultSequence: true }
    });
    expect(detail.fields).toHaveLength(4);
    expect(detail.attachments).toEqual([
      expect.objectContaining({ fileName: "old.bin", sizeBytes: 3, protected: false })
    ]);
    expect(detail.fields.every((field) => !("value" in field))).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("secret-one");
    expect(JSON.stringify(detail)).not.toContain("unknown-one");

    const password = detail.fields.find((field) => field.name === "Password")!;
    expect(password.protected).toBe(true);
    expect(provider.readEntryHistoryField(target, item, oldest.historyId, password.fieldId)).toEqual({
      fieldId: password.fieldId,
      name: "Password",
      protected: true,
      value: "secret-one"
    });
    const unknown = detail.fields.find((field) => field.name === "Some Future Field")!;
    expect(provider.readEntryHistoryField(target, item, oldest.historyId, unknown.fieldId).value).toBe("unknown-one");
  });

  it("invalidates list/detail handles after another entry mutation and on lock", async () => {
    const fixture = await historyFixture();
    const provider = new KeePassProvider();
    const target = account();
    await provider.unlock(target, fixture.bytes, { password: PASSWORD });
    const item = await sync(provider, target);
    const page = provider.listEntryHistory(target, item, { pageSize: 1 });
    const detail = provider.getEntryHistoryDetail(target, item, page.items[0].historyId);

    await provider.update(target, { ...item, title: "修改后的当前版本" });

    expect(() => provider.getEntryHistoryDetail(target, item, page.items[0].historyId))
      .toThrowError(/已经发生变化/);
    expect(() => provider.listEntryHistory(target, item, { pageSize: 1, cursor: page.nextCursor }))
      .toThrowError(/已经发生变化/);
    provider.lockAccount(target.id);
    expect(() => provider.readEntryHistoryField(target, item, page.items[0].historyId, detail.fields[0].fieldId))
      .toThrowError(/尚未解锁/);
  });

  it("restores complete native state, retains current state in history and safely replays one operation", async () => {
    const fixture = await historyFixture();
    const provider = new KeePassProvider();
    const target = account();
    await provider.unlock(target, fixture.bytes, { password: PASSWORD });
    const item = await sync(provider, target);
    const page = provider.listEntryHistory(target, item, { pageSize: 2 });
    const newestId = page.items[0].historyId;
    const oldestId = page.items[1].historyId;
    const operationId = "11111111-1111-4111-8111-111111111111";

    const restored = provider.restoreEntryHistory(target, item, operationId, oldestId);
    expect(restored).toMatchObject({ changed: true, historyCount: 3 });
    expect(provider.summarize(target.id).dirty).toBe(true);

    const refreshed = await provider.sync(target, {
      now: "2026-08-02T12:01:00.000Z",
      localItems: [item]
    });
    expect(refreshed.conflicts).toHaveLength(0);
    expect(refreshed.items[0]).toMatchObject({ title: "版本一", username: "alice" });
    expect(provider.listEntryHistory(target, refreshed.items[0])).toMatchObject({ totalCount: 3 });

    expect(provider.restoreEntryHistory(target, item, operationId, oldestId)).toEqual(restored);
    expect(() => provider.restoreEntryHistory(target, item, operationId, newestId))
      .toThrowError(/已经用于其他历史恢复/);

    const reopened = await reopen(provider, target);
    const entry = reopened.getDefaultGroup().entries[0];
    expect(keePassFieldText(entry.fields.get("Title"))).toBe("版本一");
    expect(keePassFieldText(entry.fields.get("UserName"))).toBe("alice");
    expect(keePassFieldText(entry.fields.get("Password"))).toBe("secret-one");
    expect(entry.fields.get("Password")).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(keePassFieldText(entry.fields.get("Some Future Field"))).toBe("unknown-one");
    expect([...binaryBytes(entry.binaries.get("old.bin")!)]).toEqual([1, 2, 3]);
    expect(entry.tags).toEqual(["old-tag"]);
    expect(entry.customData?.get("plugin-state")).toEqual({
      value: "custom-one",
      lastModified: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(entry.qualityCheck).toBe(false);
    expect(entry.autoType).toMatchObject({
      enabled: false,
      obfuscation: 1,
      defaultSequence: "{USERNAME}{TAB}{PASSWORD}",
      items: [{ window: "Old *", keystrokeSequence: "{USERNAME}{ENTER}" }]
    });
    expect(entry.parentGroup).toBe(reopened.getDefaultGroup());
    expect(entry.previousParentGroup?.toString()).toBe(fixture.currentPreviousParentId);
    expect(entry.history).toHaveLength(3);

    const capturedCurrent = entry.history.find((history) => keePassFieldText(history.fields.get("Title")) === "当前版本")!;
    expect(capturedCurrent).toBeTruthy();
    expect(capturedCurrent.customData?.get("plugin-state")?.value).toBe("custom-current");
    expect(capturedCurrent.qualityCheck).toBe(true);
    expect(capturedCurrent.previousParentGroup?.toString()).toBe(fixture.currentPreviousParentId);
    expect([...binaryBytes(capturedCurrent.binaries.get("current.bin")!)]).toEqual([9, 8, 7, 6]);
    expect(entry.history.some((history) => keePassFieldText(history.fields.get("Title")) === "版本二")).toBe(true);
  });

  it("keeps one restore snapshot when the encrypted vault cache is refreshed immediately", async () => {
    const fixture = await historyFixture();
    const provider = new KeePassProvider();
    const target = account();
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup("history service integration password");
    await service.upsertProvider(target);
    await provider.unlock(target, fixture.bytes, { password: PASSWORD });

    const initialSnapshot = (await service.readState()).items;
    const initialSync = await provider.sync(target, {
      now: "2026-08-02T12:00:00.000Z",
      localItems: structuredClone(initialSnapshot)
    });
    await service.applyProviderSync(
      target.id,
      initialSync.items,
      initialSync.accountPatch,
      initialSync.conflicts,
      initialSync.sourceRecords,
      initialSnapshot
    );

    const cached = (await service.listItems())[0];
    const oldest = provider.listEntryHistory(target, cached, { pageSize: 2 }).items[1];
    provider.restoreEntryHistory(
      target,
      cached,
      "22222222-2222-4222-8222-222222222222",
      oldest.historyId
    );

    const refreshSnapshot = (await service.readState()).items;
    const refreshed = await provider.sync(target, {
      now: "2026-08-02T12:01:00.000Z",
      localItems: structuredClone(refreshSnapshot)
    });
    expect(refreshed.conflicts).toHaveLength(0);
    expect(refreshed.items[0]).toMatchObject({ title: "版本一", username: "alice" });
    await service.applyProviderSync(
      target.id,
      refreshed.items,
      refreshed.accountPatch,
      refreshed.conflicts,
      refreshed.sourceRecords,
      refreshSnapshot
    );

    const refreshedItem = (await service.listItems())[0];
    expect(refreshedItem).toMatchObject({ title: "版本一", username: "alice" });
    expect(provider.listEntryHistory(target, refreshedItem)).toMatchObject({ totalCount: 3 });
  });

  it("refuses to reveal an oversized history field without changing the database", async () => {
    const fixture = await historyFixture("x".repeat(KEEPASS_HISTORY_MAX_FIELD_BYTES + 1));
    const provider = new KeePassProvider();
    const target = account();
    await provider.unlock(target, fixture.bytes, { password: PASSWORD });
    const item = await sync(provider, target);
    const history = provider.listEntryHistory(target, item).items[1];
    const detail = provider.getEntryHistoryDetail(target, item, history.historyId);
    const large = detail.fields.find((field) => field.name === "Some Future Field")!;

    expect(() => provider.readEntryHistoryField(target, item, history.historyId, large.fieldId))
      .toThrowError(/超过安全上限/);
    expect(provider.summarize(target.id).dirty).toBe(false);
  });
});

async function historyFixture(largeOldField?: string): Promise<{
  bytes: Uint8Array;
  currentPreviousParentId: string;
}> {
  const base = await buildKeePassFixture({
    name: "History Fixture",
    entries: [{
      title: "当前版本",
      fields: { UserName: "current-user", "Some Future Field": "unknown-current" },
      protectedFields: { Password: "secret-current" },
      binaries: { "current.bin": new Uint8Array([9, 8, 7, 6]) },
      tags: ["current-tag"]
    }]
  });
  const db = await kdbxweb.Kdbx.load(base.slice().buffer, keePassCredentials(PASSWORD));
  db.header.versionMinor = 1;
  db.meta.historyMaxItems = 10;
  const entry = db.getDefaultGroup().entries[0];
  const currentPreviousParent = kdbxweb.KdbxUuid.random();
  entry.previousParentGroup = currentPreviousParent;
  entry.customData = customData("custom-current", "2026-03-03T00:00:00.000Z");
  entry.qualityCheck = true;
  entry.autoType = {
    enabled: true,
    obfuscation: 0,
    defaultSequence: "{USERNAME}{TAB}{PASSWORD}{ENTER}",
    items: [{ window: "Current *", keystrokeSequence: "{PASSWORD}{ENTER}" }]
  };
  entry.times.lastModTime = new Date("2026-03-03T03:03:03.000Z");

  const oldest = await historyState(db, entry, {
    title: "版本一",
    username: "alice",
    password: "secret-one",
    unknown: largeOldField ?? "unknown-one",
    attachmentName: "old.bin",
    attachmentBytes: new Uint8Array([1, 2, 3]),
    tag: "old-tag",
    customValue: "custom-one",
    customModifiedAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T01:01:01.000Z",
    qualityCheck: false,
    previousParentGroup: kdbxweb.KdbxUuid.random(),
    autoType: {
      enabled: false,
      obfuscation: 1,
      defaultSequence: "{USERNAME}{TAB}{PASSWORD}",
      items: [{ window: "Old *", keystrokeSequence: "{USERNAME}{ENTER}" }]
    }
  });
  const newest = await historyState(db, entry, {
    title: "版本二",
    username: "bob",
    password: "secret-two",
    unknown: "unknown-two",
    attachmentName: "second.bin",
    attachmentBytes: new Uint8Array([4, 5]),
    tag: "second-tag",
    customValue: "custom-two",
    customModifiedAt: "2026-02-02T00:00:00.000Z",
    modifiedAt: "2026-02-02T02:02:02.000Z",
    qualityCheck: true,
    previousParentGroup: kdbxweb.KdbxUuid.random(),
    autoType: {
      enabled: true,
      obfuscation: 0,
      defaultSequence: "{USERNAME}{ENTER}",
      items: [{ window: "Second *", keystrokeSequence: "{PASSWORD}{ENTER}" }]
    }
  });
  entry.history = [oldest, newest];
  return {
    bytes: new Uint8Array(await db.save()),
    currentPreviousParentId: currentPreviousParent.toString()
  };
}

async function historyState(
  db: kdbxweb.Kdbx,
  live: kdbxweb.KdbxEntry,
  input: {
    title: string;
    username: string;
    password: string;
    unknown: string;
    attachmentName: string;
    attachmentBytes: Uint8Array;
    tag: string;
    customValue: string;
    customModifiedAt: string;
    modifiedAt: string;
    qualityCheck: boolean;
    previousParentGroup: kdbxweb.KdbxUuid;
    autoType: kdbxweb.KdbxEntryAutoType;
  }
): Promise<kdbxweb.KdbxEntry> {
  const history = new kdbxweb.KdbxEntry();
  history.copyFrom(live);
  history.fields = new Map<string, kdbxweb.KdbxEntryField>([
    ["Title", input.title],
    ["UserName", input.username],
    ["Password", kdbxweb.ProtectedValue.fromString(input.password)],
    ["Some Future Field", input.unknown]
  ]);
  history.binaries = new Map([[input.attachmentName, await db.createBinary(input.attachmentBytes.slice().buffer)]]);
  history.tags = [input.tag];
  history.customData = customData(input.customValue, input.customModifiedAt);
  history.qualityCheck = input.qualityCheck;
  history.previousParentGroup = input.previousParentGroup;
  history.autoType = JSON.parse(JSON.stringify(input.autoType)) as kdbxweb.KdbxEntryAutoType;
  history.times.lastModTime = new Date(input.modifiedAt);
  return history;
}

function customData(value: string, modifiedAt: string): kdbxweb.KdbxCustomDataMap {
  return new Map([["plugin-state", { value, lastModified: new Date(modifiedAt) }]]);
}

async function reopen(provider: KeePassProvider, target: ProviderAccount): Promise<kdbxweb.Kdbx> {
  return kdbxweb.Kdbx.load((await provider.exportFile(target.id)).slice().buffer, keePassCredentials(PASSWORD));
}

function binaryBytes(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): Uint8Array {
  const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
  return value instanceof kdbxweb.ProtectedValue ? value.getBinary() : new Uint8Array(value);
}
