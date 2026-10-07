import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import { buildKeePassFixture, keePassCredentials } from "./keepass-fixture";
import { KeePassRemoteRebaseConflictError, rebaseKeePassDatabase, previewKeePassProjectConflicts, resolveKeePassProjectConflicts } from "./keepass-remote-rebase";
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';

const PASSWORD = "rebase fixture password";

describe("KeePass field-aware remote rebase", () => {
  for (const choice of ['local', 'remote'] as const) it.each(['edit', 'trash', 'hard-delete'] as const)(`resolves a ${choice} project %s without replacing unrelated field edits`, async action => {
    const [base, local, remote] = await loadCopies(await projectFixture());
    const owner = local.getDefaultGroup().entries[0];
    owner.pushHistory(); owner.fields.set('Notes', 'Selected local note');
    owner.binaries.set('local.bin', await local.createBinary(kdbxweb.ProtectedValue.fromBinary(Uint8Array.of(1, 2, 3).buffer)));
    if (action === 'trash') local.remove(owner);
    if (action === 'hard-delete') local.move(owner, null);
    remote.getDefaultGroup().entries[1].fields.set('Notes', 'Selected remote note');
    const added = remote.createEntry(remote.getDefaultGroup());
    added.fields.set(PROJECT_CREDENTIAL_FIELD, kdbxweb.ProtectedValue.fromString(projectMetadata(4)));
    added.fields.set('Password', kdbxweb.ProtectedValue.fromString('Remote addition'));
    const independentId = base.getDefaultGroup().entries[2].uuid.toString();
    [...local.getDefaultGroup().allEntries()].find(entry => entry.uuid.toString() === independentId)!.fields.set('Title', 'Independent local');
    [...remote.getDefaultGroup().allEntries()].find(entry => entry.uuid.toString() === independentId)!.fields.set('UserName', 'Independent remote');
    const project = (database: kdbxweb.Kdbx) => [...database.getDefaultGroup().allEntries()].filter(entry => entry.fields.has(PROJECT_CREDENTIAL_FIELD));
    const field = (value: unknown) => value instanceof kdbxweb.ProtectedValue ? value.getText() : value;
    const shape = (entry: kdbxweb.KdbxEntry) => ({ uuid: entry.uuid.toString(), parent: entry.parentGroup?.uuid.toString(),
      fields: [...entry.fields].map(([key, value]) => [key, field(value)]).sort(), history: entry.history.map(row => [...row.fields].map(([key, value]) => [key, field(value)]).sort()),
      binaries: [...entry.binaries].map(([key, value]) => { const payload = 'value' in value ? value.value : value;
        return [key, payload instanceof kdbxweb.ProtectedValue, [...(payload instanceof kdbxweb.ProtectedValue ? payload.getBinary() : new Uint8Array(payload as ArrayBuffer))]]; }).sort() });
    const expected = project(choice === 'local' ? local : remote).map(shape).sort((a, b) => a.uuid.localeCompare(b.uuid));
    const localXml = await local.saveXml();
    const result = resolveKeePassProjectConflicts(base, local, remote, [{ projectId: '00000000-0000-4000-8000-000000000099', choice }]);
    const reopened = await kdbxweb.Kdbx.load(await result.database.save(), keePassCredentials(PASSWORD));
    expect(project(reopened).map(shape).sort((a, b) => a.uuid.localeCompare(b.uuid))).toEqual(expected);
    const independent = [...reopened.getDefaultGroup().allEntries()].find(entry => entry.uuid.toString() === independentId)!;
    expect(independent.fields.get('Title')).toBe('Independent local'); expect(independent.fields.get('UserName')).toBe('Independent remote');
    expect(await local.saveXml()).toBe(localXml);
  });

  it('rejects missing or stale project decisions before modifying scratch databases', async () => {
    const [base, local, remote] = await loadCopies(await projectFixture());
    local.getDefaultGroup().entries[0].fields.set('Notes', 'Local'); remote.getDefaultGroup().entries[1].fields.set('Notes', 'Remote');
    const before = await Promise.all([base.saveXml(), remote.saveXml()]);
    expect(() => resolveKeePassProjectConflicts(base, local, remote, [])).toThrow();
    expect(() => resolveKeePassProjectConflicts(base, local, remote, [{ projectId: 'unknown', choice: 'local' }])).toThrow();
    expect(await Promise.all([base.saveXml(), remote.saveXml()])).toEqual(before);
  });

  it('copies selected custom icons and keeps history references after encrypted reopening', async () => {
    const [base, local, remote] = await loadCopies(await projectFixture());
    const owner = local.getDefaultGroup().entries[0], iconId = kdbxweb.KdbxUuid.random();
    local.meta.customIcons.set(iconId.toString(), { data: Uint8Array.of(6, 7, 8).buffer, name: 'Private icon' });
    owner.customIcon = iconId; owner.pushHistory(); owner.fields.set('Notes', 'Local');
    remote.getDefaultGroup().entries[1].fields.set('Notes', 'Remote');
    const result = resolveKeePassProjectConflicts(base, local, remote, [{ projectId: '00000000-0000-4000-8000-000000000099', choice: 'local' }]);
    const reopened = await kdbxweb.Kdbx.load(await result.database.save(), keePassCredentials(PASSWORD));
    const entry = [...reopened.getDefaultGroup().allEntries()].find(row => row.uuid.equals(owner.uuid))!;
    expect(entry.customIcon?.toString()).toBe(iconId.toString()); expect(entry.history[0].customIcon?.toString()).toBe(iconId.toString());
    expect([...new Uint8Array(reopened.meta.customIcons.get(iconId.toString())!.data)]).toEqual([6, 7, 8]);
  });

  it('rejects cross-project reassignment of a selected native entry', async () => {
    const [base, local, remote] = await loadCopies(await projectFixture());
    local.getDefaultGroup().entries[0].fields.set('Notes', 'Local');
    remote.getDefaultGroup().entries[0].fields.delete(PROJECT_CREDENTIAL_FIELD);
    remote.getDefaultGroup().entries[1].fields.set('Notes', 'Remote');
    const before = await Promise.all([base.saveXml(), remote.saveXml()]);
    expect(() => resolveKeePassProjectConflicts(base, local, remote, [{ projectId: '00000000-0000-4000-8000-000000000099', choice: 'local' }])).toThrow('归属');
    expect(await Promise.all([base.saveXml(), remote.saveXml()])).toEqual(before);
  });

  it('does not treat a project choice as permission to overwrite an unrelated conflict', async () => {
    const [base, local, remote] = await loadCopies(await projectFixture());
    local.getDefaultGroup().entries[0].fields.set('Notes', 'Local project');
    remote.getDefaultGroup().entries[1].fields.set('Notes', 'Remote project');
    local.getDefaultGroup().entries[2].fields.set('Notes', 'Unrelated local');
    remote.getDefaultGroup().entries[2].fields.set('Notes', 'Unrelated remote');
    expect(() => resolveKeePassProjectConflicts(base, local, remote, [{ projectId: '00000000-0000-4000-8000-000000000099', choice: 'local' }]))
      .toThrow(KeePassRemoteRebaseConflictError);
  });

  it.each(['trash', 'hard-delete', 'edit', 'attachment'] as const)('previews exact project identities and %s changes without secrets or database mutation', async action => {
    const [base, local, remote] = await loadCopies(await projectFixture());
    const owner = local.getDefaultGroup().entries[0], ownerId = owner.uuid.toString();
    const remoteMember = remote.getDefaultGroup().entries[1], remoteId = remoteMember.uuid.toString();
    if (action === 'trash') local.remove(owner);
    if (action === 'hard-delete') owner.parentGroup!.entries.splice(owner.parentGroup!.entries.indexOf(owner), 1);
    if (action === 'edit') owner.fields.set('Notes', 'Local private note sentinel');
    if (action === 'attachment') owner.binaries.set('Private file sentinel', await local.createBinary(Uint8Array.of(8, 9, 10).buffer));
    remoteMember.fields.set('Notes', 'Remote private note sentinel');
    const added = remote.createEntry(remote.getDefaultGroup());
    added.fields.set(PROJECT_CREDENTIAL_FIELD, kdbxweb.ProtectedValue.fromString(projectMetadata(4)));
    added.fields.set('Password', kdbxweb.ProtectedValue.fromString('Added password sentinel'));
    // Same display title is insufficient to join the independent third entry.
    remote.getDefaultGroup().entries[2].fields.set('Notes', 'Independent remote edit');
    const xml = await Promise.all([base.saveXml(), local.saveXml(), remote.saveXml()]);
    const previews = previewKeePassProjectConflicts(base, local, remote);
    expect(previews).toHaveLength(1);
    const preview = previews[0];
    expect(preview.projectId).toBe('00000000-0000-4000-8000-000000000099');
    expect(preview.baseEntryUuids).toEqual([ownerId, remoteId].sort());
    expect(preview.local).toMatchObject({ activeCount: action === 'trash' || action === 'hard-delete' ? 1 : 2,
      trashCount: action === 'trash' ? 1 : 0, addedEntryUuids: [], removedEntryUuids: action === 'hard-delete' ? [ownerId] : [],
      modifiedEntryUuids: action === 'hard-delete' ? [] : [ownerId] });
    expect(preview.remote).toMatchObject({ activeCount: 3, trashCount: 0, addedEntryUuids: [added.uuid.toString()],
      removedEntryUuids: [], modifiedEntryUuids: [remoteId] });
    for (const secret of ['synthetic-', 'sentinel', 'Private file', 'Independent remote edit', 'Same title'])
      expect(JSON.stringify(previews)).not.toContain(secret);
    expect(await Promise.all([base.saveXml(), local.saveXml(), remote.saveXml()])).toEqual(xml);
  });

  it('omits one-sided and identical project edits from the resolution preview', async () => {
    const [base, local, remote] = await loadCopies(await projectFixture());
    local.getDefaultGroup().entries[0].fields.set('Notes', 'Identical');
    expect(previewKeePassProjectConflicts(base, local, remote)).toEqual([]);
    remote.getDefaultGroup().entries[0].fields.set('Notes', 'Identical');
    expect(previewKeePassProjectConflicts(base, local, remote)).toEqual([]);
  });

  it.each(['edit', 'delete', 'append'] as const)('does not combine a project %s with a concurrent change to another member', async action => {
    const bytes = await projectFixture();
    const [base, working, remote] = await loadCopies(bytes);
    const local = working.getDefaultGroup().entries[0], remoteMember = remote.getDefaultGroup().entries[1];
    if (action === 'delete') working.remove(local);
    else local.fields.set('Notes', 'synthetic local project secret');
    if (action === 'append') {
      const added = remote.createEntry(remote.getDefaultGroup());
      added.fields.set(PROJECT_CREDENTIAL_FIELD, kdbxweb.ProtectedValue.fromString(projectMetadata(4)));
      added.fields.set('Password', kdbxweb.ProtectedValue.fromString('synthetic added password'));
    } else remoteMember.fields.set('Notes', 'synthetic remote project secret');
    const before = await remote.saveXml();
    expect(() => rebaseKeePassDatabase(base, working, remote)).toThrow(KeePassRemoteRebaseConflictError);
    expect(await remote.saveXml()).toBe(before);
    try { rebaseKeePassDatabase(base, working, remote); } catch (cause) {
      expect(JSON.stringify(cause)).not.toContain('synthetic local project secret');
      expect(JSON.stringify(cause)).not.toContain('synthetic remote project secret');
    }
  });

  it('merges an independent same-title record while keeping an identical project change idempotent', async () => {
    const [base, working, remote] = await loadCopies(await projectFixture());
    working.getDefaultGroup().entries[0].fields.set('Notes', 'identical project edit');
    remote.getDefaultGroup().entries[0].fields.set('Notes', 'identical project edit');
    remote.getDefaultGroup().entries[2].fields.set('Notes', 'independent remote edit');
    rebaseKeePassDatabase(base, working, remote);
    expect(remote.getDefaultGroup().entries[0].fields.get('Notes')).toBe('identical project edit');
    expect(remote.getDefaultGroup().entries[2].fields.get('Notes')).toBe('independent remote edit');
  });
  it("keeps an unrelated remote field while applying the local field change", async () => {
    const bytes = await buildKeePassFixture({
      password: PASSWORD,
      entries: [{ title: "Base title", fields: { UserName: "base-user" }, protectedFields: { Password: "base-password" } }]
    });
    const [base, working, remote] = await loadCopies(bytes);
    const baseEntry = base.getDefaultGroup().entries[0];
    const workingEntry = working.getDefaultGroup().entries[0];
    const remoteEntry = remote.getDefaultGroup().entries[0];
    workingEntry.fields.set("Title", "Local title");
    remoteEntry.fields.set("UserName", "Remote user");

    rebaseKeePassDatabase(base, working, remote);

    expect(remoteEntry.fields.get("Title")).toBe("Local title");
    expect(remoteEntry.fields.get("UserName")).toBe("Remote user");
    expect(remoteEntry.fields.get("Password")).toBeInstanceOf(kdbxweb.ProtectedValue);
  });

  it("fails closed when both replicas change the same field", async () => {
    const bytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Base title" }] });
    const [base, working, remote] = await loadCopies(bytes);
    working.getDefaultGroup().entries[0].fields.set("Title", "Local title");
    remote.getDefaultGroup().entries[0].fields.set("Title", "Remote title");

    try {
      rebaseKeePassDatabase(base, working, remote);
      throw new Error("expected a rebase conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(KeePassRemoteRebaseConflictError);
      expect((error as KeePassRemoteRebaseConflictError).conflicts).toEqual([
        expect.objectContaining({ kind: "field", fieldNames: ["Title"] })
      ]);
    }
  });

  it("treats the protected flag as part of the field base value", async () => {
    const bytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Entry", protectedFields: { Password: "same" } }] });
    const [base, working, remote] = await loadCopies(bytes);
    working.getDefaultGroup().entries[0].fields.set("Password", "same");

    rebaseKeePassDatabase(base, working, remote);

    expect(remote.getDefaultGroup().entries[0].fields.get("Password")).toBe("same");
    expect(remote.getDefaultGroup().entries[0].fields.get("Password")).not.toBeInstanceOf(kdbxweb.ProtectedValue);
  });

  it("fails closed when both replicas move an entry to different groups", async () => {
    const bytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Entry", group: "Base" }] });
    const [base, working, remote] = await loadCopies(bytes);
    const workingGroup = working.createGroup(working.getDefaultGroup(), "Local");
    const remoteGroup = remote.createGroup(remote.getDefaultGroup(), "Remote");
    working.move(working.getDefaultGroup().groups.find((group) => group.name === "Base")!.entries[0], workingGroup);
    remote.move(remote.getDefaultGroup().groups.find((group) => group.name === "Base")!.entries[0], remoteGroup);

    try {
      rebaseKeePassDatabase(base, working, remote);
      throw new Error("expected a structural conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(KeePassRemoteRebaseConflictError);
      expect((error as KeePassRemoteRebaseConflictError).conflicts).toEqual([
        expect.objectContaining({ kind: "entry-structure" })
      ]);
    }
  });

  it("merges independent attachment names and copies the local binary into the remote pool", async () => {
    const bytes = await buildKeePassFixture({
      password: PASSWORD,
      entries: [{ title: "Entry", binaries: { "base.txt": new Uint8Array([1]) } }]
    });
    const [base, working, remote] = await loadCopies(bytes);
    const workingEntry = working.getDefaultGroup().entries[0];
    const remoteEntry = remote.getDefaultGroup().entries[0];
    workingEntry.binaries.set("local.txt", await working.createBinary(new Uint8Array([2]).buffer));
    remoteEntry.binaries.set("remote.txt", await remote.createBinary(new Uint8Array([3]).buffer));

    rebaseKeePassDatabase(base, working, remote);

    expect([...remoteEntry.binaries.keys()].sort()).toEqual(["base.txt", "local.txt", "remote.txt"]);
    const saved = new Uint8Array(await remote.save());
    const reopened = await kdbxweb.Kdbx.load(saved.buffer, keePassCredentials(PASSWORD));
    expect([...reopened.getDefaultGroup().entries[0].binaries.keys()].sort()).toEqual(["base.txt", "local.txt", "remote.txt"]);
  });

  it("preserves a remote unknown field during a local managed-field removal", async () => {
    const bytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Entry", fields: { "MonicaLocalId": "7" } }] });
    const [base, working, remote] = await loadCopies(bytes);
    working.getDefaultGroup().entries[0].fields.delete("MonicaLocalId");
    remote.getDefaultGroup().entries[0].fields.set("PluginState", "remote-state");

    rebaseKeePassDatabase(base, working, remote);

    expect(remote.getDefaultGroup().entries[0].fields.has("MonicaLocalId")).toBe(false);
    expect(remote.getDefaultGroup().entries[0].fields.get("PluginState")).toBe("remote-state");
  });
});

function projectMetadata(index: number) {
  return JSON.stringify({ version: 1, projectId: '00000000-0000-4000-8000-000000000099', groupId: '00000000-0000-4000-8000-000000000001',
    passwordId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`, label: 'Primary', primary: true, groupOrder: 0, passwordOrder: index });
}
async function projectFixture() {
  return buildKeePassFixture({ password: PASSWORD, entries: [0, 1, 2].map(index => ({ title: 'Same title',
    protectedFields: { Password: `synthetic-${index}`, ...(index < 2 ? { [PROJECT_CREDENTIAL_FIELD]: projectMetadata(index) } : {}) } })) });
}

async function loadCopies(bytes: Uint8Array): Promise<[kdbxweb.Kdbx, kdbxweb.Kdbx, kdbxweb.Kdbx]> {
  const load = () => kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
  return [await load(), await load(), await load()];
}
