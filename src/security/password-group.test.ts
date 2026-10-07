import { describe, expect, it, vi } from "vitest";
import { createLoginItem } from "../core/model";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";

describe("atomic explicit multi-password editing", () => {
  it('commits project fields and sync intents together, rejecting contradictory edits without changing stored data', async () => {
    const rows = [0, 1, 2].map(index => ({ ...createLoginItem({ title: 'Project', username: `user-${index}`, password: `secret-${index}` }),
      passwordGroupId: 'project', customFields: [{ name: 'monica.content.credential', protected: true,
        value: JSON.stringify({ version: 1, groupId: `00000000-0000-0000-0000-00000000000${index}`,
          passwordId: `00000000-0000-0000-0000-00000000001${index}`, label: 'Account', primary: index === 0, groupOrder: index, passwordOrder: 0 }) }]
    })).map(row => ({ ...row, email: 'old@example.invalid',
      providerRefs: [{ providerId: 'native-project', remoteId: row.id, revision: 'revision' }] }));
    const storage = new MemoryVaultStorage(); const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup('synthetic project common fields', rows);
    await service.upsertProvider({ id: 'native-project', kind: 'mdbx2', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} });
    const expected = Object.fromEntries(rows.map(row => [row.id, row.updatedAt]));
    const before = JSON.stringify(storage.envelope), state = await service.readState();
    await expect(service.savePasswordGroup(rows.map((row, index) => ({ ...row, title: `conflict ${index}` })), expected)).rejects.toThrow('公共字段存在冲突');
    expect(JSON.stringify(storage.envelope)).toBe(before); expect(await service.readState()).toEqual(state);
    const saved = await service.savePasswordGroup(rows.map((row, index) => index === 1
      ? { ...row, title: 'Project renamed', notes: '  shared\r\nnotes  ', email: '' } : row), expected);
    for (const [index, row] of saved.entries()) {
      expect(row).toMatchObject({ title: 'Project renamed', notes: '  shared\r\nnotes  ', email: '',
        id: rows[index].id, username: rows[index].username, password: rows[index].password, customFields: rows[index].customFields });
    }
    const after = await service.readState();
    expect(after.mutationQueue.filter(mutation => mutation.providerId === 'native-project').map(mutation => mutation.itemId).sort()).toEqual(rows.map(row => row.id).sort());
    await service.lock(); const reopened = await service.unlock('synthetic project common fields');
    expect(reopened.items).toEqual(after.items);
  });
  it("atomically saves Android shared credential fields and preserves the vault on conflicting drafts", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const rows = [0, 1].map(index => ({ ...createLoginItem({ title: 'Android project', username: 'shared', password: `password-${index}` }),
      passwordGroupId: 'explicit', totpSecret: 'original-otp', customFields: [{ name: 'monica.content.credential', protected: true,
        value: JSON.stringify({ version: 1, groupId: '00000000-0000-0000-0000-000000000001',
          passwordId: `00000000-0000-0000-0000-00000000001${index}`, label: 'Account', primary: true, groupOrder: 0, passwordOrder: index }) }] }));
    await service.setup('synthetic group master password', rows);
    const expected = Object.fromEntries(rows.map(row => [row.id, row.updatedAt]));
    const before = JSON.stringify(storage.envelope);
    await expect(service.savePasswordGroup(rows.map((row, index) => ({ ...row, username: `conflict-${index}` })), expected)).rejects.toThrow('冲突');
    expect(JSON.stringify(storage.envelope)).toBe(before);
    const saved = await service.savePasswordGroup(rows.map((row, index) => index === 1 ? { ...row, username: 'updated', totpSecret: '' } : row), expected);
    expect(saved.map(row => row.username)).toEqual(['updated', 'updated']);
    expect(saved.map(row => row.totpSecret)).toEqual(['', '']);
    expect(saved.map(row => row.password)).toEqual(rows.map(row => row.password));
    expect(saved.map(row => row.customFields)).toEqual(rows.map(row => row.customFields));
    const added = { ...saved[0], id: 'new-credential-password', username: 'conflicting addition',
      customFields: saved[0].customFields.map(field => ({ ...field,
        value: field.value.replace('000000000010', '000000000012') })) };
    const savedExpected = Object.fromEntries(saved.map(row => [row.id, row.updatedAt]));
    const beforeAddition = JSON.stringify(storage.envelope);
    const beforeState = await service.readState();
    await expect(service.savePasswordGroup([...saved, added], savedExpected)).rejects.toThrow('冲突');
    expect(JSON.stringify(storage.envelope)).toBe(beforeAddition);
    expect(await service.readState()).toEqual(beforeState);
    const extended = await service.savePasswordGroup([...saved, { ...added, username: 'updated' }], savedExpected);
    await service.lock();
    const reopened = await service.unlock('synthetic group master password');
    expect(reopened.items).toEqual(expect.arrayContaining(extended));
    expect(reopened.items).toHaveLength(3);
  });
  it("detaches only the selected member, preserves all content, and rejects stale confirmation", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const members = ["one", "two"].map(title => ({ ...createLoginItem({ title, password: "synthetic", notes: "keep content" }), passwordGroupId: "group", appName: "App", customFields: [{name:"future",value:"9007199254740993",protected:true}] }));
    await service.setup("synthetic group master password", members);
    const first = members[0];
    const edited = await service.upsertItem({ ...first, notes: "changed elsewhere" }, undefined, first.updatedAt);
    if (edited.kind !== "login") throw new Error("Expected password");
    const state = await service.readState();
    await expect(service.upsertItem({ ...first, passwordGroupId: undefined }, undefined, first.updatedAt)).rejects.toThrow("修改");
    expect(await service.readState()).toEqual(state);
    const detached = await service.upsertItem({ ...edited, passwordGroupId: undefined }, undefined, edited.updatedAt);
    expect({ ...detached, updatedAt: edited.updatedAt }).toEqual({ ...edited, passwordGroupId: undefined });
    expect((await service.listItems()).find(item => item.id === members[1].id)).toEqual(members[1]);
    await service.lock();
    const reopened = await service.unlock("synthetic group master password");
    expect(reopened.items.find(item=>item.id===first.id)).toMatchObject({notes:"changed elsewhere",appName:"App",customFields:first.customFields});
    expect(reopened.items.filter(item=>item.kind==='login' && item.passwordGroupId==='group')).toHaveLength(1);
  });
  it("rejects non-boolean locked-autofill grants without writing", async () => {
    const storage = new MemoryVaultStorage(); const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const members = [createLoginItem({ title: "one" }), createLoginItem({ title: "two" })].map(item => ({ ...item, passwordGroupId: "group" }));
    await service.setup("synthetic group master password", members);
    const before = JSON.stringify(storage.envelope);
    await expect(service.savePasswordGroup(members, {}, "false" as unknown as boolean)).rejects.toThrow("布尔值");
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });
  it("preserves independent same-title records and rejects stale or incomplete group saves", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const first = createLoginItem({ title: "Same", password: "synthetic-1" });
    const second = createLoginItem({ title: "Same", password: "synthetic-2" });
    const independent = createLoginItem({ title: "Same", password: "synthetic-3" });
    await service.setup("synthetic group master password", [first, independent]);
    const members = [{ ...first, createdAt: "2099-01-01T00:00:00.000Z", passwordGroupId: "explicit" }, { ...second, passwordGroupId: "explicit" }];
    const saved = await service.savePasswordGroup(members, { [first.id]: first.updatedAt });
    expect(saved[0].createdAt).toBe(first.createdAt);
    expect((await service.listItems()).find(item => item.id === independent.id)).not.toHaveProperty("passwordGroupId");
    const before = JSON.stringify(storage.envelope);
    await expect(service.savePasswordGroup(members, { [first.id]: first.updatedAt })).rejects.toThrow("被修改");
    expect(JSON.stringify(storage.envelope)).toBe(before);
    const third = { ...createLoginItem({ title: "Third" }), passwordGroupId: "explicit" };
    await expect(service.savePasswordGroup([saved[0], third], { [first.id]: saved[0].updatedAt })).rejects.toThrow("成员已变化");
    expect(JSON.stringify(storage.envelope)).toBe(before);
    await service.lock();
    const reopened = await service.unlock("synthetic group master password");
    expect(reopened.items).toHaveLength(3);
    expect(reopened.items.filter(item => item.kind === "login" && item.passwordGroupId === "explicit")).toHaveLength(2);
  });

  it("keeps the encrypted vault and queue unchanged after a group persist failure", async () => {
    const storage = new MemoryVaultStorage(); const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const members = [createLoginItem({title:"one"}),createLoginItem({title:"two"})].map(item=>({...item,passwordGroupId:"group"}));
    await service.setup("synthetic group master password", members);
    const before = JSON.stringify(storage.envelope); const state = await service.readState();
    const write = vi.spyOn(storage,"write").mockRejectedValueOnce(new Error("synthetic write failure"));
    await expect(service.savePasswordGroup(members.map(item=>({...item,password:"edited"})),Object.fromEntries(members.map(item=>[item.id,item.updatedAt])),false)).rejects.toThrow("synthetic write failure");
    expect(JSON.stringify(storage.envelope)).toBe(before); expect(await service.readState()).toEqual(state); expect(write).toHaveBeenCalledTimes(1);
  });
});
