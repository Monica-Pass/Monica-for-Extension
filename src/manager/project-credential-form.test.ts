import { expect, it } from 'vitest';
import { createLoginItem } from '../core/model';
import type { LoginForm } from './login-form';
import { moveProjectCredentialPassword, projectCredentialContentTokens, updateProjectContentFields } from './project-credential-form';
import { withContentOrder } from '../core/password-content';
import { addProjectCredentialGroup, startProjectCredentialGroups, setProjectCredentialGroupLabel, addProjectCredentialPassword, projectCredentialFormGroups, setProjectCredentialFormValue } from './project-credential-form';
function draft() {
  const fields = (passwordOrder: number) => [{ name: 'monica.content.credential', protected: true, value: JSON.stringify({ version: 1,
    groupId: '00000000-0000-0000-0000-000000000001', passwordId: `00000000-0000-0000-0000-00000000001${passwordOrder}`,
    label: 'Account', primary: true, groupOrder: 0, passwordOrder }) }];
  const original = { ...createLoginItem({ title: 'Project', username: 'shared', password: 'first' }), customFields: fields(0) };
  return { username: 'shared', password: 'second', totpSecret: '', passwordGroupId: 'explicit', customFields: fields(1),
    groupMembers: [{ id: original.id, username: original.username, password: original.password, original }] } as LoginForm;
}
it('reorders password identities without moving secrets, attachments, source snapshots or unknown metadata', () => {
  const form = draft();
  form.customFields[0].value = form.customFields[0].value.replace(/}$/, ',"future":9007199254740993}');
  const source = JSON.stringify(form.groupMembers[0].original);
  const group = projectCredentialFormGroups(form)![0];
  moveProjectCredentialPassword(form, group.id, group.rows[1].metadata!.passwordId, group.rows[0].metadata!.passwordId);
  const reordered = projectCredentialFormGroups(form)![0];
  expect(reordered.rows.map(row => row.password)).toEqual(['second', 'first']);
  expect(reordered.rows.map(row => row.metadata!.passwordOrder)).toEqual([0, 1]);
  expect(form.password).toBe('second'); expect(form.groupMembers[0].password).toBe('first');
  expect(form.customFields[0].value).toContain('9007199254740993');
  expect(form.customFields[0].protected).toBe(true);
  expect(JSON.stringify(form.groupMembers[0].original)).toBe(source);
  const before = JSON.stringify(form);
  expect(() => moveProjectCredentialPassword(form, group.id, 'missing', group.rows[0].metadata!.passwordId)).toThrow();
  expect(JSON.stringify(form)).toBe(before);
});
it('orders extra groups among other project content, keeps primary first and preserves unknown markers', () => {
  const form = draft();
  const primary = projectCredentialFormGroups(form)![0].id;
  const second = addProjectCredentialGroup(form), third = addProjectCredentialGroup(form);
  const before = JSON.stringify(form);
  expect(projectCredentialContentTokens(form)).toContain(`CREDENTIAL:${third}`);
  expect(projectCredentialContentTokens(form)).not.toContain(`CREDENTIAL:${primary}`);
  expect(JSON.stringify(form)).toBe(before);
  const fields = withContentOrder(form.customFields, [`CREDENTIAL:${third}`, 'NOTES', `CREDENTIAL:${second}`, 'FUTURE:opaque']);
  updateProjectContentFields(form, fields);
  expect(projectCredentialFormGroups(form)!.map(group => group.id)).toEqual([primary, third, second]);
  expect(projectCredentialFormGroups(form)!.map(group => group.order)).toEqual([0, 1, 2]);
  expect(projectCredentialContentTokens(form).slice(0, 4)).toEqual([`CREDENTIAL:${third}`, 'NOTES', `CREDENTIAL:${second}`, 'FUTURE:opaque']);
  expect(form.groupMembers[0].original!.customFields[0].value).toContain('"groupOrder":0');
  for (const member of form.groupMembers) {
    expect(member.customFields!.find(field => field.name === 'monica.content.order')!.value).toBe(form.customFields.find(field => field.name === 'monica.content.order')!.value);
  }
});
it('rejects conflicting per-row order metadata and duplicate content order without partially editing a draft', () => {
  const form = draft();
  form.groupMembers[0].original!.customFields[0].value = form.groupMembers[0].original!.customFields[0].value.replace('"primary":true', '"primary":false');
  expect(projectCredentialFormGroups(form)).toBeUndefined();
  const other = draft();
  other.groupMembers[0].original!.customFields.push({name:'monica.content.order',value:'NOTES',protected:true}, {name:'monica.content.order',value:'PAYMENT',protected:false});
  const before = JSON.stringify(other);
  expect(() => updateProjectContentFields(other, withContentOrder(other.customFields, ['ADDRESS', 'NOTES']))).toThrow('排序字段重复');
  expect(JSON.stringify(other)).toBe(before);
});
it('orders passwords independently of the selected entry and changes only intended draft values', () => {
  const form = draft(); const original = JSON.stringify(form.groupMembers[0].original);
  const groups = projectCredentialFormGroups(form)!;
  expect(groups[0].rows.map(row => row.index)).toEqual([0, -1]);
  setProjectCredentialFormValue(form, groups[0].rows.map(row => row.index), 'username', 'new account');
  setProjectCredentialFormValue(form, groups[0].rows.map(row => row.index), 'totpSecret', 'otp');
  setProjectCredentialFormValue(form, [0], 'password', 'new first');
  expect(form).toMatchObject({ username: 'new account', password: 'second', totpSecret: 'otp' });
  expect(form.groupMembers[0]).toMatchObject({ username: 'new account', password: 'new first', totpSecret: 'otp' });
  expect(JSON.stringify(form.groupMembers[0].original)).toBe(original);
  expect(projectCredentialFormGroups(form)).toHaveLength(1);
});
it('falls back without rewriting legacy, duplicate, future or conflicting data', () => {
  for (const alter of [(form: LoginForm) => form.customFields = [],
    (form: LoginForm) => form.customFields = form.groupMembers[0].original!.customFields,
    (form: LoginForm) => form.customFields[0].value = form.customFields[0].value.replace('"version":1', '"version":2'),
    (form: LoginForm) => form.groupMembers[0].username = 'conflict',
    (form: LoginForm) => form.groupMembers[0].totpSecret = 'different otp']) {
    const form = draft(); alter(form); const before = JSON.stringify(form);
    expect(projectCredentialFormGroups(form)).toBeUndefined(); expect(JSON.stringify(form)).toBe(before);
  }
});

it('adds a distinct password identity and keeps original metadata and shared draft fields', () => {
  const form = draft(); const before = JSON.stringify(form.groupMembers[0].original);
  const group = projectCredentialFormGroups(form)![0];
  const id = addProjectCredentialPassword(form, group.id);
  const added = form.groupMembers.find(row => row.id === id)!;
  expect(added.original).toBeUndefined(); expect(added.username).toBe('shared'); expect(added.totpSecret).toBe('');
  const rows = projectCredentialFormGroups(form)![0].rows;
  expect(rows.map(row => row.metadata!.passwordOrder)).toEqual([0, 1, 2]);
  expect(new Set(rows.map(row => row.metadata!.passwordId)).size).toBe(3);
  expect(JSON.stringify(form.groupMembers[0].original)).toBe(before);
  setProjectCredentialFormValue(form, rows.map(row => row.index), 'totpSecret', 'shared-new');
  expect(form.groupMembers.map(row => row.totpSecret)).toEqual(['shared-new', 'shared-new']);
});
it('rejects addition into unknown groups without changing the draft', () => {
  const form = draft(); const before = JSON.stringify(form);
  expect(() => addProjectCredentialPassword(form, 'missing')).toThrow();
  expect(JSON.stringify(form)).toBe(before);
});

it('starts a new project with distinct groups and identities without changing primary secrets', () => {
  const form = { ...draft(), passwordGroupId: '', groupMembers: [], customFields: [{ name: 'custom', value: 'retain', protected: true }] };
  startProjectCredentialGroups(form);
  const groups = projectCredentialFormGroups(form)!;
  expect(groups).toHaveLength(2); expect(groups.map(group => group.order)).toEqual([0, 1]);
  expect(new Set(groups.map(group => group.id)).size).toBe(2);
  expect(groups[0].rows[0].password).toBe('second'); expect(groups[1].rows[0].password).toBe('');
  expect(form.customFields[0]).toEqual({ name: 'custom', value: 'retain', protected: true });
  expect(groups.every(group => group.rows[0].metadata!.projectId === form.passwordGroupId)).toBe(true);
  addProjectCredentialGroup(form); expect(projectCredentialFormGroups(form)).toHaveLength(3);
  const before = JSON.stringify(form); expect(() => startProjectCredentialGroups(form)).toThrow(); expect(JSON.stringify(form)).toBe(before);
});
it('renames all group metadata without rounding unknown numbers or changing source snapshots', () => {
  const form = draft();
  for (const fields of [form.customFields, form.groupMembers[0].original!.customFields]) fields[0].value = fields[0].value.replace(/}$/, ',"future":9007199254740993}');
  const original = JSON.stringify(form.groupMembers[0].original);
  const group = projectCredentialFormGroups(form)![0];
  setProjectCredentialGroupLabel(form, group.id, '  label 🔑  ');
  expect(projectCredentialFormGroups(form)![0].label).toBe('  label 🔑  ');
  for (const fields of [form.customFields, form.groupMembers[0].customFields!]) {
    expect(fields[0].protected).toBe(true); expect(fields[0].value).toContain('9007199254740993');
  }
  expect(JSON.stringify(form.groupMembers[0].original)).toBe(original);
  const unchanged = JSON.stringify(form); setProjectCredentialGroupLabel(form, group.id, '  label 🔑  '); expect(JSON.stringify(form)).toBe(unchanged);
});
