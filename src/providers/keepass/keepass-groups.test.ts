import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import type { ProviderAccount } from "../../core/model";
import { buildKeePassFixture, keePassCredentials } from "./keepass-fixture";
import { KeePassProvider } from "./keepass-provider";
import { KEEPASS_GROUP_MAX_DEPTH, createKeePassGroup, moveKeePassGroup, type KeePassGroupSummary } from "./keepass-groups";

const PASSWORD = "fixture master password";

function account(): ProviderAccount {
  return {
    id: "keepass-groups",
    kind: "keepass",
    name: "KeePass Groups",
    enabled: true,
    isDefaultSaveTarget: false,
    config: { databaseId: 41 }
  };
}

interface NestedFixture {
  bytes: Uint8Array;
  accountsUuid: string;
  workUuid: string;
}

async function nestedFixture(recycleBinEnabled = true): Promise<NestedFixture> {
  const initial = await buildKeePassFixture({
    name: "KeePass group fixture",
    entries: [{ title: "Nested login", fields: { UserName: "alice" }, protectedFields: { Password: "secret" } }]
  });
  const database = await kdbxweb.Kdbx.load(initial.slice().buffer, keePassCredentials(PASSWORD));
  database.header.versionMinor = 1;
  const root = database.getDefaultGroup();
  const accounts = database.createGroup(root, "Accounts");
  const work = database.createGroup(accounts, "Work");
  database.createGroup(root, "Archive");
  database.move(root.entries[0], work);
  work.notes = "group note";
  work.tags = ["android-compatible"];
  work.customData = new Map([["plugin", { value: "future-value", lastModified: new Date("2026-08-02T00:00:00.000Z") }]]);
  const entry = work.entries[0];
  entry.binaries.set("document.bin", await database.createBinary(new Uint8Array([1, 2, 3, 4]).buffer));
  entry.pushHistory();
  entry.fields.set("Notes", "current value");
  database.meta.recycleBinEnabled = recycleBinEnabled;
  return {
    bytes: new Uint8Array(await database.save()),
    accountsUuid: accounts.uuid.toString(),
    workUuid: work.uuid.toString()
  };
}

async function openProvider(recycleBinEnabled = true) {
  const fixture = await nestedFixture(recycleBinEnabled);
  const provider = new KeePassProvider();
  const target = account();
  await provider.unlock(target, fixture.bytes, { password: PASSWORD });
  return { fixture, provider, target };
}

function listAll(provider: KeePassProvider, target: ProviderAccount, includeRecycleBin: boolean): KeePassGroupSummary[] {
  const items: KeePassGroupSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = provider.listGroups(target, { includeRecycleBin, cursor, pageSize: 2 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

describe("KeePass group lifecycle", () => {
  it("lists Android-style nested paths through opaque manager handles and paginates safely", async () => {
    const { fixture, provider, target } = await openProvider();
    const first = provider.listGroups(target, { pageSize: 2 });
    const second = provider.listGroups(target, { pageSize: 2, cursor: first.nextCursor });
    const groups = [...first.items, ...second.items];

    expect(groups.map((group) => group.displayPath)).toEqual(["Accounts", "Accounts > Work", "Archive"]);
    expect(groups.every((group) => /^[a-f0-9-]{36}$/.test(group.groupId))).toBe(true);
    expect(JSON.stringify(groups)).not.toContain(fixture.accountsUuid);
    expect(JSON.stringify(groups)).not.toContain(fixture.workUuid);
    expect(groups.find((group) => group.name === "Work")).toMatchObject({ depth: 1, entryCount: 1, inRecycleBin: false });
  });

  it("creates renames moves deletes and restores nested groups without losing native subtree data", async () => {
    const { fixture, provider, target } = await openProvider();
    let active = listAll(provider, target, false);
    const work = active.find((group) => group.name === "Work")!;
    const archive = active.find((group) => group.name === "Archive")!;

    const created = provider.createGroup(target, "create-projects", "Projects", work.groupId);
    expect(created).toMatchObject({ changed: true, group: { name: "Projects", displayPath: "Accounts > Work > Projects" } });
    const renamed = provider.renameGroup(target, "rename-projects", created.group.groupId, "Client Projects");
    expect(renamed.group.displayPath).toBe("Accounts > Work > Client Projects");
    const moved = provider.moveGroup(target, "move-projects", created.group.groupId, archive.groupId);
    expect(moved.group.displayPath).toBe("Archive > Client Projects");

    const deleted = provider.deleteGroup(target, "delete-work", work.groupId);
    expect(deleted.group).toMatchObject({ name: "Work", inRecycleBin: true, canRestore: true });
    expect(provider.deleteGroup(target, "delete-work", work.groupId)).toEqual(deleted);
    expect(provider.summarize(target.id).itemCount).toBe(0);

    const recycleGroups = listAll(provider, target, true);
    expect(recycleGroups.find((group) => group.name === "Work")).toMatchObject({ canRestore: true, inRecycleBin: true });
    const restored = provider.restoreGroup(target, "restore-work", work.groupId);
    expect(restored.group).toMatchObject({ displayPath: "Accounts > Work", inRecycleBin: false });
    expect(provider.summarize(target.id)).toMatchObject({ dirty: true, itemCount: 1 });

    const exported = await provider.exportFile(target.id);
    const reopened = await kdbxweb.Kdbx.load(exported.slice().buffer, keePassCredentials(PASSWORD));
    const accounts = reopened.getGroup(fixture.accountsUuid)!;
    const reopenedWork = reopened.getGroup(fixture.workUuid)!;
    const reopenedArchive = reopened.getDefaultGroup().groups.find((group) => group.name === "Archive")!;
    expect(reopenedWork.parentGroup).toBe(accounts);
    expect(reopenedWork.previousParentGroup).toBeUndefined();
    expect(reopenedWork.notes).toBe("group note");
    expect(reopenedWork.tags).toEqual(["android-compatible"]);
    expect(reopenedWork.customData?.get("plugin")?.value).toBe("future-value");
    expect(reopenedWork.entries[0].history).toHaveLength(1);
    expect(reopenedWork.entries[0].binaries.get("document.bin")).toBeDefined();
    expect(reopenedArchive.groups.map((group) => group.name)).toContain("Client Projects");
  });

  it("matches Android idempotent create while rejecting rename conflicts self or descendant moves and changed operation replay", async () => {
    const { provider, target } = await openProvider();
    const active = listAll(provider, target, false);
    const accounts = active.find((group) => group.name === "Accounts")!;
    const work = active.find((group) => group.name === "Work")!;

    expect(provider.createGroup(target, "duplicate", "work", accounts.groupId)).toMatchObject({
      changed: false,
      group: { groupId: work.groupId, name: "Work" }
    });
    expect(provider.summarize(target.id).dirty).toBe(false);
    expect(() => provider.moveGroup(target, "descendant", accounts.groupId, work.groupId)).toThrowError(/子分组/);
    expect(() => provider.moveGroup(target, "self", work.groupId, work.groupId)).toThrowError(/自身/);

    const created = provider.createGroup(target, "reused-operation", "Personal", accounts.groupId);
    expect(created.group.name).toBe("Personal");
    expect(() => provider.renameGroup(target, "rename-conflict", created.group.groupId, "WORK")).toThrowError(/同名/);
    expect(() => provider.createGroup(target, "reused-operation", "Other", accounts.groupId))
      .toThrowError(/已经用于其他操作/);
  });

  it("invalidates a page cursor after a mutation and refuses irreversible delete when recycle bin is disabled", async () => {
    const { provider, target } = await openProvider();
    const first = provider.listGroups(target, { pageSize: 1 });
    provider.createGroup(target, "cursor-mutation", "New group");
    expect(() => provider.listGroups(target, { pageSize: 1, cursor: first.nextCursor })).toThrowError(/已经发生变化/);

    const disabled = await openProvider(false);
    const work = listAll(disabled.provider, disabled.target, true).find((group) => group.name === "Work")!;
    expect(() => disabled.provider.deleteGroup(disabled.target, "disabled-delete", work.groupId))
      .toThrowError(/关闭了回收站/);
  });

  it("clears group handles cursors and operation receipts when the KeePass session is locked", async () => {
    const { fixture, provider, target } = await openProvider();
    const first = provider.listGroups(target, { pageSize: 1 });
    const accounts = first.items[0];
    const created = provider.createGroup(target, "session-operation", "Personal", accounts.groupId);
    const staleGroupId = created.group.groupId;
    const staleCursor = first.nextCursor!;

    provider.lockAccount(target.id);
    await provider.unlock(target, fixture.bytes, { password: PASSWORD });

    expect(() => provider.listGroups(target, { pageSize: 1, cursor: staleCursor })).toThrowError(/失效/);
    expect(() => provider.renameGroup(target, "stale-handle", staleGroupId, "Other")).toThrowError(/失效/);
    const reopenedAccounts = provider.listGroups(target).items.find((group) => group.name === "Accounts")!;
    expect(provider.createGroup(target, "session-operation", "Personal", reopenedAccounts.groupId)).toMatchObject({ changed: true });
  });

  it("rejects create and move before they can exceed the browser group-depth boundary", async () => {
    const initial = await buildKeePassFixture({ name: "Depth fixture" });
    const database = await kdbxweb.Kdbx.load(initial.slice().buffer, keePassCredentials(PASSWORD));
    const root = database.getDefaultGroup();
    let deepest = root;
    for (let depth = 0; depth <= KEEPASS_GROUP_MAX_DEPTH; depth += 1) {
      deepest = database.createGroup(deepest, `Depth ${depth}`);
    }
    const source = database.createGroup(root, "Source");
    database.createGroup(source, "Child");

    expect(() => createKeePassGroup(database, deepest.uuid.toString(), "Too deep")).toThrowError(/层级/);
    expect(deepest.groups).toHaveLength(0);
    expect(() => moveKeePassGroup(database, source.uuid.toString(), deepest.uuid.toString())).toThrowError(/层级/);
    expect(source.parentGroup).toBe(root);
  });
});
