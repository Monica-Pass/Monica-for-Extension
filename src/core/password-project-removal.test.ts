import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem } from './model';
import { planPasswordProjectRemoval } from './password-project-removal';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from './project-credentials';
import { CONTENT_ORDER } from './password-content';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function removalRows(): LoginItem[] {
  return [0, 1, 2].map(index => ({ ...createLoginItem({ title: 'Project', username: index < 2 ? 'shared' : 'recovery', password: `secret-${index}` }),
    passwordGroupId: uuid(99), passwordHistory: [{ password: `old-${index}`, lastUsedAt: '2026-10-04T00:00:00.000Z' }],
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true,
      value: JSON.stringify({ version: 1, projectId: uuid(99), groupId: uuid(index < 2 ? 1 : 2), passwordId: uuid(index + 10),
        primary: index < 2, label: index < 2 ? 'Primary' : 'Recovery', groupOrder: index < 2 ? 0 : 1, passwordOrder: index < 2 ? index : 0 }).replace(/}$/, ',"future":9007199254740993}') }]
  }));
}
it('removes one password by identity while retaining shared fields and both rows’ private identities', () => {
  const rows = removalRows(); rows[0].customFields.push({ name: 'project field', value: '  shared\r\ntext  ', protected: true });
  rows[0].imagePaths = ['shared-image']; rows[0].passkeyBindings = '{"future":9007199254740993}';
  rows[1].customFields.push({ name: 'project field', value: 'own field', protected: false });
  const before = JSON.stringify(rows);
  const plan = planPasswordProjectRemoval(rows, rows, [rows[0].id]);
  expect(plan.ownerTransfer).toEqual({ sourceItemId: rows[0].id, targetItemId: rows[1].id });
  expect(plan.removed).toEqual([rows[0]]); expect(plan.retained.map(item => item.password)).toEqual(['secret-1', 'secret-2']);
  expect(plan.retained[0]).toMatchObject({ id: rows[1].id, imagePaths: ['shared-image'], passkeyBindings: rows[0].passkeyBindings, passwordHistory: rows[1].passwordHistory });
  expect(plan.retained[0].customFields.slice(1)).toEqual([rows[1].customFields[1], rows[0].customFields[1]]);
  expect(readProjectCredential(plan.retained[0].customFields)).toMatchObject({ passwordId: uuid(11), passwordOrder: 0 });
  expect(plan.retained[0].customFields[0].value).toContain('9007199254740993'); expect(JSON.stringify(rows)).toBe(before);
});
it('promotes the remaining group to a singleton and removes only the explicitly removed group’s order token', () => {
  const rows = removalRows(); rows[0].customFields.push({ name: CONTENT_ORDER, protected: true, value: `NOTES,CREDENTIAL:${uuid(1)},future-token,CREDENTIAL:${uuid(2)}` });
  const plan = planPasswordProjectRemoval(rows, rows, rows.slice(0, 2).map(item => item.id));
  expect(plan.retained).toHaveLength(1);
  expect(readProjectCredential(plan.retained[0].customFields)).toMatchObject({ primary: true, groupOrder: 0, passwordOrder: 0, passwordId: uuid(12) });
  expect(plan.retained[0].customFields.find(field => field.name === CONTENT_ORDER)?.value).toBe(`NOTES,future-token,CREDENTIAL:${uuid(2)}`);
});
it('does not create a deletion for a discarded new draft and leaves the existing owner untouched', () => {
  const rows = removalRows(); const plan = planPasswordProjectRemoval(rows, [rows[0]], [rows[1].id]);
  expect(plan.removed).toEqual([]); expect(plan.ownerTransfer).toBeUndefined();
  expect(plan.retained[0]).toEqual(rows[0]);
});
it('retains shared content when the unsaved first password of a wholly new project is discarded', () => {
  const rows = removalRows();
  rows[0].customFields.push({ name: 'Shared draft', value: 'unsaved shared content', protected: true });
  const plan = planPasswordProjectRemoval(rows, [], [rows[0].id]);
  expect(plan.removed).toEqual([]); expect(plan.ownerTransfer).toBeUndefined();
  expect(plan.retained[0].customFields).toContainEqual(rows[0].customFields[1]);
});
it('preserves ordering-field attributes and refuses incompatible attributes', () => {
  const rows = removalRows();
  rows[0].customFields.push({ name: CONTENT_ORDER, value: 'NOTES', protected: true, fieldType: 'HIDDEN' });
  rows[1].customFields.push({ name: CONTENT_ORDER, value: 'CUSTOM_FIELDS', protected: false });
  const plan = planPasswordProjectRemoval(rows, rows, [rows[0].id]);
  expect(plan.retained[0].customFields.find(field => field.name === CONTENT_ORDER)).toEqual({ name: CONTENT_ORDER, value: 'NOTES,CUSTOM_FIELDS', protected: true, fieldType: 'HIDDEN' });
  rows[1].customFields[1].fieldType = 'TEXT';
  expect(() => planPasswordProjectRemoval(rows, rows, [rows[0].id])).toThrow('字段冲突');
});
it.each(['last', 'unknown-id', 'duplicate', 'future', 'conflict'])('rejects %s removal before modifying source data', scenario => {
  const rows = removalRows(); let ids = [rows[0].id];
  if (scenario === 'last') ids = rows.map(item => item.id);
  if (scenario === 'unknown-id') ids = ['missing'];
  if (scenario === 'duplicate') ids = [rows[0].id, rows[0].id];
  if (scenario === 'future') rows[1].customFields[0].value = rows[1].customFields[0].value.replace('"version":1', '"version":2');
  if (scenario === 'conflict') {
    rows[0].customFields.push({ name: 'monica.content.wallet.same', value: 'source', protected: true });
    rows[1].customFields.push({ name: 'monica.content.wallet.same', value: 'target', protected: true });
  }
  const before = JSON.stringify(rows); expect(() => planPasswordProjectRemoval(rows, rows, ids)).toThrow(); expect(JSON.stringify(rows)).toBe(before);
});
