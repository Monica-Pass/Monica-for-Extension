import { expect, it } from 'vitest';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { readAndroidBackup, writeAndroidBackup } from './android-backup-codec';
import { applyBoundNoteChoice, resolveBoundNote } from '../../core/bound-notes';
import type { LoginItem } from '../../core/model';

const fixture = (bound: boolean) => zipSync({
  'folders/_root/passwords/password_1_0.json': strToU8(JSON.stringify({ id: 1, title: 'Account', ...(bound ? { boundNoteEntryId: 'note:stable-note', boundNoteId: 42 } : {}), future: { keep: true } })),
  'folders/_root/notes/note_42_0.json': strToU8(JSON.stringify({ id: 42, title: 'Note', itemType: 'NOTE', replicaGroupId: 'note:stable-note', itemData: JSON.stringify({ content: 'Exact\n中文', future: [1, null] }) }))
});
it('preserves stable note association through ZIP edits and a different import source', () => {
  const original = readAndroidBackup(fixture(true), 'old');
  const owner = original.items.find(item => item.kind === 'login') as LoginItem;
  expect(resolveBoundNote(owner, original.items)?.content).toBe('Exact\n中文');
  const bytes = writeAndroidBackup(original, original.items.map(item => item.id === owner.id ? { ...item, title: 'Renamed' } : item), 'old');
  const reopened = readAndroidBackup(bytes, 'new');
  const renamed = reopened.items.find(item => item.kind === 'login') as LoginItem;
  expect(resolveBoundNote(renamed, reopened.items)?.content).toBe('Exact\n中文');
  expect(renamed.boundNoteId).toBe(42);
  expect(reopened.records.get(renamed.id)?.raw.future).toEqual({ keep: true });
  const unlinked = applyBoundNoteChoice(renamed, '', reopened.items);
  const final = readAndroidBackup(writeAndroidBackup(reopened, reopened.items.map(item => item.id === renamed.id ? unlinked : item), 'new'), 'final');
  const finalOwner = final.items.find(item => item.kind === 'login') as LoginItem;
  expect(finalOwner.boundNoteEntryId).toBeUndefined();
  expect(finalOwner.boundNoteId).toBeUndefined();
  expect(final.records.get(finalOwner.id)?.raw.boundNoteEntryId).toBeNull();
  expect(final.items.find(item => item.kind === 'secure-note')).toMatchObject({ content: 'Exact\n中文', replicaGroupId: 'note:stable-note' });
});

it('writes a newly chosen stable note using the existing Android backup ID', () => {
  const original = readAndroidBackup(fixture(false), 'source');
  const owner = original.items.find(item => item.kind === 'login') as LoginItem;
  const linked = applyBoundNoteChoice(owner, 'note:stable-note', original.items);
  const reopened = readAndroidBackup(writeAndroidBackup(original, original.items.map(item => item.id === owner.id ? linked : item), 'source'), 'destination');
  const result = reopened.items.find(item => item.kind === 'login') as LoginItem;
  expect(result.boundNoteId).toBe(42);
  expect(resolveBoundNote(result, reopened.items)?.title).toBe('Note');
});

const numericFixture = (duplicate = false) => zipSync({
  'folders/_root/passwords/password_1_0.json': strToU8(JSON.stringify({ id: 1, title: 'Account', boundNoteId: 42 })),
  'folders/_root/notes/note_42_0.json': strToU8(JSON.stringify({ id: 42, title: 'Same title', itemType: 'NOTE', itemData: JSON.stringify({ content: 'Exact target' }) })),
  'folders/other/notes/note_43_0.json': strToU8(JSON.stringify({ id: duplicate ? 42 : 43, title: 'Same title', itemType: 'NOTE', itemData: JSON.stringify({ content: 'Other note' }) }))
});

it('restores numeric links by exact ID and retains unchanged raw records across source reconnect', () => {
  const bytes = numericFixture();
  const document = readAndroidBackup(bytes, 'old');
  const owner = document.items.find(item => item.kind === 'login') as LoginItem;
  expect(resolveBoundNote(owner, document.items)?.content).toBe('Exact target');
  const output = writeAndroidBackup(document, document.items, 'old');
  expect(unzipSync(output)).toEqual(unzipSync(bytes));
  const reopened = readAndroidBackup(output, 'new');
  expect(resolveBoundNote(reopened.items.find(item => item.kind === 'login') as LoginItem, reopened.items)?.content).toBe('Exact target');
});

it('persists a new choice without replica metadata and clears both references on unlink', () => {
  const document = readAndroidBackup(numericFixture(), 'old');
  const owner = document.items.find(item => item.kind === 'login') as LoginItem;
  const target = document.items.find(item => item.kind === 'secure-note' && item.content === 'Other note')!;
  const linked = applyBoundNoteChoice(owner, `note:${target.id}`, document.items);
  const reopened = readAndroidBackup(writeAndroidBackup(document, document.items.map(item => item.id === owner.id ? linked : item), 'old'), 'new');
  const result = reopened.items.find(item => item.kind === 'login') as LoginItem;
  expect(result.boundNoteId).toBe(43);
  expect(resolveBoundNote(result, reopened.items)?.content).toBe('Other note');
  const unlinked = applyBoundNoteChoice(result, '', reopened.items);
  const final = readAndroidBackup(writeAndroidBackup(reopened, reopened.items.map(item => item.id === result.id ? unlinked : item), 'new'), 'final');
  const finalOwner = final.items.find(item => item.kind === 'login') as LoginItem;
  expect(finalOwner.boundNoteId).toBeUndefined();
  expect(resolveBoundNote(finalOwner, final.items)).toBeUndefined();
});

it('does not guess duplicate numeric IDs and rejects ambiguous export without mutating inputs', () => {
  const document = readAndroidBackup(numericFixture(true), 'source');
  const owner = document.items.find(item => item.kind === 'login') as LoginItem;
  expect(owner.boundNoteEntryId).toBeUndefined();
  const note = document.items.find(item => item.kind === 'secure-note')!;
  const linked = applyBoundNoteChoice(owner, `note:${note.id}`, document.items);
  const items = document.items.map(item => item.id === owner.id ? linked : item);
  const before = structuredClone(items);
  expect(() => writeAndroidBackup(document, items, 'source')).toThrow('标识不唯一');
  expect(items).toEqual(before);
});

it('keeps the numeric projection when explicitly reselecting the current imported note', () => {
  const document = readAndroidBackup(numericFixture(), 'old');
  const owner = document.items.find(item => item.kind === 'login') as LoginItem;
  const linked = applyBoundNoteChoice(owner, owner.boundNoteEntryId!, document.items);
  const reopened = readAndroidBackup(writeAndroidBackup(document, document.items.map(item => item.id === owner.id ? linked : item), 'old'), 'new');
  const result = reopened.items.find(item => item.kind === 'login') as LoginItem;
  expect(result.boundNoteId).toBe(42);
  expect(resolveBoundNote(result, reopened.items)?.content).toBe('Exact target');
});

it('uses the actual exported ID of a newly created note', () => {
  const document = readAndroidBackup(fixture(false), 'old');
  const owner = document.items.find(item => item.kind === 'login') as LoginItem;
  const template = document.items.find(item => item.kind === 'secure-note')!;
  const note = { ...template, id: 'fresh-note', replicaGroupId: undefined, createdAt: '2026-10-01T00:00:00.000Z' };
  const items = [...document.items, note];
  const linked = applyBoundNoteChoice(owner, 'note:fresh-note', items);
  const reopened = readAndroidBackup(writeAndroidBackup(document, items.map(item => item.id === owner.id ? linked : item), 'old'), 'new');
  const result = reopened.items.find(item => item.kind === 'login') as LoginItem;
  const target = resolveBoundNote(result, reopened.items)!;
  expect(target).toBeDefined();
  expect(reopened.records.get(target.id)?.raw.id).toBe(result.boundNoteId);
  expect(Number.isSafeInteger(result.boundNoteId)).toBe(true);
});

it.each([null, 'missing-target'])('preserves explicit stable reference %s without numeric guessing', stable => {
  const entries = unzipSync(numericFixture());
  entries['folders/_root/passwords/password_1_0.json'] = strToU8(JSON.stringify({ id: 1, title: 'Account', boundNoteId: 42, boundNoteEntryId: stable }));
  const document = readAndroidBackup(zipSync(entries), 'source');
  const owner = document.items.find(item => item.kind === 'login') as LoginItem;
  expect(resolveBoundNote(owner, document.items)).toBeUndefined();
  expect(unzipSync(writeAndroidBackup(document, document.items, 'source'))).toEqual(entries);
});
