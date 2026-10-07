import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem } from './model';
import { PROJECT_CREDENTIAL_FIELD } from './project-credentials';
import { reconcileProjectCredentialEdits } from './project-credential-edits';
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
export const credentialRows = (): LoginItem[] => [0, 1, 2].map(index => ({
  ...createLoginItem({ title: 'Synthetic', username: index === 2 ? 'second account' : 'shared', password: `secret-${index}` }),
  passwordGroupId: uuid(99), totpSecret: 'synthetic-original-otp',
  customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1,
    groupId: uuid(index === 2 ? 2 : 1), passwordId: uuid(index + 10), label: 'Account', primary: index !== 2,
    groupOrder: index === 2 ? 1 : 0, passwordOrder: index === 2 ? 0 : index, future: 'keep' }) }]
}));
it('propagates shared username and cleared OTP without replacing passwords or another credential group', () => {
  const original = credentialRows(); const before = JSON.stringify(original);
  const edited = original.map((item, i) => i === 0 ? { ...item, username: 'renamed', totpSecret: '', password: 'new password' } : item);
  const saved = reconcileProjectCredentialEdits(edited, original);
  expect(saved[0]).toEqual(edited[0]);
  expect(saved[1]).toEqual({ ...original[1], username: 'renamed', totpSecret: '' });
  expect(saved[2]).toEqual(original[2]); expect(JSON.stringify(original)).toBe(before);
});
it('accepts editing the shared account from a secondary password row', () => {
  const original = credentialRows();
  const saved = reconcileProjectCredentialEdits(original.map((item, i) => i === 1 ? { ...item, username: 'secondary edit' } : item), original);
  expect(saved.slice(0, 2).map(item => item.username)).toEqual(['secondary edit', 'secondary edit']);
});

it('applies edited project fields across credential groups while retaining each record identity and private content', () => {
  const original = credentialRows().map((row, index) => ({ ...row, notes: `old note ${index}`,
    replicaGroupId: `native-${index}`, email: 'old@example.invalid', phone: '0007',
    addressLine: 'old address', creditCardNumber: 'old card',
    imagePaths: [`image-${index}`], passwordHistory: [{ password: `history-${index}`, lastUsedAt: '2026-01-01' }] }));
  const patch = { title: '  Project title 🔑  ', notes: '  Shared note\r\n\tretained  ', email: '', phone: '  +86 001  ',
    addressLine: '街道\r\n第二行', city: 'city', state: 'state', zipCode: '00007', country: 'CN',
    creditCardNumber: '4111111111111111', creditCardHolder: '  Holder  ', creditCardExpiry: '03/29', creditCardCVV: '007',
    appName: '服务', appPackageName: 'invalid.synthetic', uris: ['https://example.invalid/path'],
    uriRules: [{ uri: 'https://example.invalid/path', matchType: 'exact' as const }], favorite: true };
  const before = JSON.stringify(original);
  const saved = reconcileProjectCredentialEdits(original.map((row, index) => index === 1 ? { ...row, ...patch } : row), original);
  for (const [index, row] of saved.entries()) expect(row).toEqual({ ...original[index], ...patch });
  expect(JSON.stringify(original)).toBe(before);
});

it('preserves untouched differences, applies an explicit clear to new rows, and rejects conflicting project edits', () => {
  const original = credentialRows().map((row, index) => ({ ...row, notes: `member note ${index}`, email: 'old@example.invalid' }));
  const renamed = reconcileProjectCredentialEdits(original.map((row, index) => index === 2 ? { ...row, title: 'New title' } : row), original);
  expect(renamed.map(row => row.notes)).toEqual(original.map(row => row.notes));
  expect(renamed.map(row => row.title)).toEqual(['New title', 'New title', 'New title']);
  const added = { ...original[0], id: 'added', customFields: original[0].customFields.map(field => ({ ...field,
    value: field.value.replace('000000000010', '000000000013') })) };
  const cleared = reconcileProjectCredentialEdits([...original.map((row, index) => index === 0 ? { ...row, email: '' } : row), added], original);
  expect(cleared.map(row => row.email)).toEqual(['', '', '', '']);
  expect(() => reconcileProjectCredentialEdits(original.map((row, index) => ({ ...row, title: `different ${index}` })), original)).toThrow('冲突');
});

it('keeps project edits scoped to the original vault and preserves unknown metadata and owned assets', () => {
  const own = credentialRows();
  const other = own.map(row => ({ ...row, id: `other-${row.id}`, mdbxDatabaseId: 9 }));
  const original = [...own, ...other];
  const saved = reconcileProjectCredentialEdits(original.map((row, index) => index === 0 ? { ...row, notes: 'shared in one vault' } : row), original);
  expect(saved.slice(0, 3).map(row => row.notes)).toEqual(['shared in one vault', 'shared in one vault', 'shared in one vault']);
  expect(saved.slice(3)).toEqual(other);
  const mixed = own.map((row, index) => index === 2 ? { ...row, customFields: [] } : row);
  const draft = mixed.map((row, index) => index === 0 ? { ...row, title: 'edit' } : row);
  expect(reconcileProjectCredentialEdits(draft, mixed)).toEqual(draft);
});
it('rejects divergent drafts and pre-existing shared-field conflicts without mutating input', () => {
  const original = credentialRows();
  const conflicting = original.map((item, i) => i < 2 ? { ...item, username: `different-${i}` } : item);
  const before = JSON.stringify(conflicting);
  expect(() => reconcileProjectCredentialEdits(conflicting, original)).toThrow('冲突');
  expect(JSON.stringify(conflicting)).toBe(before);
  const baseline = original.map((item, i) => i === 1 ? { ...item, totpSecret: 'conflicting-secret' } : item);
  expect(() => reconcileProjectCredentialEdits(baseline.map((item, i) => i === 0 ? { ...item, totpSecret: 'new' } : item), baseline)).toThrow('冲突');
  expect(reconcileProjectCredentialEdits(baseline.map(item => ({ ...item, notes: 'safe unrelated edit' })), baseline).map(item => item.totpSecret)).toEqual(baseline.map(item => item.totpSecret));
});
it('does not infer shared fields from legacy project membership or across vaults', () => {
  for (const original of [credentialRows().map(item => ({ ...item, customFields: [] })), credentialRows().map((item, i) => ({ ...item, mdbxDatabaseId: i + 1 }))]) {
    const draft = original.map((item, i) => i === 0 ? { ...item, username: 'edited' } : item);
    expect(reconcileProjectCredentialEdits(draft, original)).toEqual(draft);
  }
});

it('rejects inconsistent shared fields when creating or extending a credential group', () => {
  const rows = credentialRows();
  for (const field of ['username', 'totpSecret'] as const) {
    const draft = rows.map((row, index) => index === 1 ? { ...row, [field]: 'conflict' } : row);
    const before = JSON.stringify(draft);
    expect(() => reconcileProjectCredentialEdits(draft, [])).toThrow('冲突');
    expect(() => reconcileProjectCredentialEdits(draft, [rows[0], rows[2]])).toThrow('冲突');
    expect(JSON.stringify(draft)).toBe(before);
  }
  expect(reconcileProjectCredentialEdits(rows, [])).toEqual(rows);
  expect(reconcileProjectCredentialEdits(rows, [rows[0], rows[2]])).toEqual(rows);
});

it('validates newly added passwords against reconciled existing account edits', () => {
  const original = credentialRows();
  const added = { ...original[0], id: 'new-password', customFields: original[0].customFields.map(field => ({
    ...field, value: field.value.replace('000000000010', '000000000013')
  })) };
  const draft = original.map((row, index) => index === 0 ? { ...row, username: 'new shared' } : row);
  expect(() => reconcileProjectCredentialEdits([...draft, added], original)).toThrow('冲突');
  const saved = reconcileProjectCredentialEdits([...draft, { ...added, username: 'new shared' }], original);
  expect(saved.filter(row => row.id !== original[2].id).map(row => row.username)).toEqual(['new shared', 'new shared', 'new shared']);
});
