import { expect, it } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { buildKeePassFixture } from './keepass-fixture';
import { openKeePassVault } from './keepass-vault';
import { prepareKeePassProjectAttachmentHandoff } from './keepass-project-attachments';
import { removeKeePassEntry, restoreKeePassEntry } from './keepass-writer';

const password = 'fixture master password';
const options = { password, providerId: 'kp', databaseId: 7 };
async function fixture() {
  const vault = await openKeePassVault(await buildKeePassFixture({ entries: [
    { title: 'Owner', protectedFields: { Password: 'old-owner-secret' }, binaries: { 'shared.bin': Uint8Array.of(1, 2, 3), 'same.bin': Uint8Array.of(9) } },
    { title: 'Retained', protectedFields: { Password: 'retained-secret' }, binaries: { 'personal.bin': Uint8Array.of(4, 5), 'same.bin': Uint8Array.of(9) } }
  ] }), options);
  const entries = [...vault.entriesByUuid.values()];
  return { ...vault, source: entries.find(row => row.fields.get('Title') === 'Owner')!, target: entries.find(row => row.fields.get('Title') === 'Retained')! };
}
function bytes(entry: kdbxweb.KdbxEntry, name: string): number[] {
  const binary = entry.binaries.get(name)!;
  const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
  return [...(value instanceof kdbxweb.ProtectedValue ? value.getBinary() : new Uint8Array(value))];
}

it('retains both native identities, password history and all attachments through encrypted save, trash and restore', async () => {
  const f = await fixture(), sourceId = f.source.uuid.toString(), targetId = f.target.uuid.toString();
  f.source.binaries.set('protected.bin', await f.database.createBinary(kdbxweb.ProtectedValue.fromBinary(Uint8Array.of(8, 7, 6).buffer)));
  const handoff = prepareKeePassProjectAttachmentHandoff(f.database, f.source, f.target);
  expect(handoff.apply()).toBe(true);
  expect(bytes(f.target, 'shared.bin')).toEqual([1, 2, 3]);
  expect(f.target.history).toHaveLength(1);
  expect([...f.target.history[0].binaries.keys()].sort()).toEqual(['personal.bin', 'same.bin']);
  removeKeePassEntry(f.database, f.source);
  const reopened = await openKeePassVault(new Uint8Array(await f.database.save()), options);
  const source = reopened.entriesByUuid.get(sourceId)!, target = reopened.entriesByUuid.get(targetId)!;
  expect(reopened.items.find(row => row.keepassEntryUuid === sourceId)?.deletedAt).toBeTruthy();
  expect((target.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('retained-secret');
  expect((source.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('old-owner-secret');
  for (const entry of [source, target]) {
    expect(bytes(entry, 'shared.bin')).toEqual([1, 2, 3]);
    expect(bytes(entry, 'protected.bin')).toEqual([8, 7, 6]);
    expect((entry.binaries.get('protected.bin') as kdbxweb.KdbxBinaryWithHash).value).toBeInstanceOf(kdbxweb.ProtectedValue);
  }
  expect(bytes(target, 'personal.bin')).toEqual([4, 5]);
  restoreKeePassEntry(reopened.database, source);
  const restored = await openKeePassVault(new Uint8Array(await reopened.database.save()), options);
  expect(restored.items.every(row => !row.deletedAt)).toBe(true);
  expect(bytes(restored.entriesByUuid.get(sourceId)!, 'shared.bin')).toEqual([1, 2, 3]);
});

it.each(['source-change', 'target-change', 'source-extra', 'target-missing', 'source-trash', 'target-detached', 'identity-change'] as const)(
  'rejects %s after preparation before altering the destination', async mode => {
    const f = await fixture();
    const prepared = prepareKeePassProjectAttachmentHandoff(f.database, f.source, f.target);
    if (mode === 'source-change') f.source.binaries.set('shared.bin', await f.database.createBinary(Uint8Array.of(1, 2, 4).buffer));
    if (mode === 'target-change') f.target.binaries.set('personal.bin', await f.database.createBinary(Uint8Array.of(4, 6).buffer));
    if (mode === 'source-extra') f.source.binaries.set('extra.bin', await f.database.createBinary(Uint8Array.of(1).buffer));
    if (mode === 'target-missing') f.target.binaries.delete('personal.bin');
    if (mode === 'source-trash') removeKeePassEntry(f.database, f.source);
    if (mode === 'target-detached') f.target.parentGroup!.entries.splice(f.target.parentGroup!.entries.indexOf(f.target), 1);
    if (mode === 'identity-change') f.source.uuid = kdbxweb.KdbxUuid.random();
    const names = [...f.target.binaries.keys()], history = f.target.history.length;
    expect(() => prepared.apply()).toThrow();
    expect([...f.target.binaries.keys()]).toEqual(names);
    expect(f.target.history).toHaveLength(history);
  }
);

it('rejects same-name different bytes before mutation, including a conflict after other transferable files', async () => {
  const f = await fixture();
  f.target.binaries.set('same.bin', await f.database.createBinary(Uint8Array.of(0).buffer));
  expect(() => prepareKeePassProjectAttachmentHandoff(f.database, f.source, f.target)).toThrow(/同名冲突/);
  expect(f.target.binaries.has('shared.bin')).toBe(false);
  expect(f.target.history).toHaveLength(0);
});

it('can re-prepare after file reopen without duplicate attachments or extra history', async () => {
  const f = await fixture();
  expect(prepareKeePassProjectAttachmentHandoff(f.database, f.source, f.target).apply()).toBe(true);
  const reopened = await openKeePassVault(new Uint8Array(await f.database.save()), options);
  const target = reopened.entriesByUuid.get(f.target.uuid.toString())!, source = reopened.entriesByUuid.get(f.source.uuid.toString())!;
  const count = target.history.length;
  expect(prepareKeePassProjectAttachmentHandoff(reopened.database, source, target).apply()).toBe(false);
  expect(target.history).toHaveLength(count);
});

it('rejects same-entry, foreign-database and disposed preparations', async () => {
  const f = await fixture(), foreign = await fixture();
  expect(() => prepareKeePassProjectAttachmentHandoff(f.database, f.source, f.source)).toThrow();
  expect(() => prepareKeePassProjectAttachmentHandoff(f.database, f.source, foreign.target)).toThrow();
  const prepared = prepareKeePassProjectAttachmentHandoff(f.database, f.source, f.target);
  prepared.dispose();
  expect(() => prepared.apply()).toThrow();
  expect(f.target.binaries.has('shared.bin')).toBe(false);
});
