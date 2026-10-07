import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from '../core/project-credentials';
import { CONTENT_ORDER } from '../core/password-content';
import type { LoginForm } from './login-form';
import { addProjectCredentialGroup, addProjectCredentialPassword, projectCredentialFormGroups, setProjectCredentialFormValue } from './project-credential-form';
import { omitUnsavedProjectPasswords, projectRemovalRows, removedProjectItemIds, selectProjectPasswordRemoval, supportsProjectMemberRemoval } from './project-removal-form';

function fixture() {
  const projectId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const originals = [0, 1].map(passwordOrder => ({
    ...createLoginItem({ title: 'Project', username: 'shared', password: `secret-${passwordOrder}`, notes: 'Original notes' }),
    passwordGroupId: projectId,
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId, groupId,
      passwordId: crypto.randomUUID(), label: 'Work', primary: true, groupOrder: 0, passwordOrder }).replace(/}$/, ',"future":9007199254740993}') },
      { name: 'opaque', value: 'protected-value', protected: true }],
    email: 'email@example.test', phone: ' 123 ', imagePaths: ['asset-original']
  }));
  const form = { passwordGroupId: projectId, username: originals[0].username, password: originals[0].password, totpSecret: '',
    customFields: structuredClone(originals[0].customFields), providerId: '',
    groupMembers: [{ id: originals[1].id, username: originals[1].username, password: originals[1].password, original: structuredClone(originals[1]) }] } as LoginForm;
  return { form, originals, groupId };
}

it('marks the selected owner and undoes it without touching secrets, raw metadata or original snapshots', () => {
  const { form, originals } = fixture(), before = JSON.stringify(form);
  const row = projectRemovalRows(form).find(row => row.index === -1)!;
  selectProjectPasswordRemoval(form, [row.passwordId], true);
  expect(removedProjectItemIds(form, originals)).toEqual([originals[0].id]);
  expect(projectRemovalRows(form).filter(row => row.removed)).toHaveLength(1);
  selectProjectPasswordRemoval(form, [row.passwordId], false);
  const { removedPasswordIds, ...content } = form;
  expect(removedPasswordIds).toEqual([]); expect(JSON.stringify(content)).toBe(before);
});

it('rejects removing the last surviving password, even across groups, without partially updating selection', () => {
  const { form } = fixture();
  const added = addProjectCredentialGroup(form);
  const oldRows = projectRemovalRows(form).filter(row => row.groupId !== added);
  selectProjectPasswordRemoval(form, oldRows.map(row => row.passwordId), true);
  const before = JSON.stringify(form);
  expect(() => selectProjectPasswordRemoval(form, projectRemovalRows(form).map(row => row.passwordId), true)).toThrow('至少保留');
  expect(JSON.stringify(form)).toBe(before);
});

it('preserves selection by identity after addition and shared account edits', () => {
  const { form, groupId } = fixture(), row = projectRemovalRows(form)[0];
  selectProjectPasswordRemoval(form, [row.passwordId], true);
  addProjectCredentialPassword(form, groupId);
  setProjectCredentialFormValue(form, projectCredentialFormGroups(form)![0].rows.map(row => row.index), 'username', 'edited');
  expect(projectRemovalRows(form).filter(row => row.removed).map(row => row.passwordId)).toEqual([row.passwordId]);
  expect(form.groupMembers.every(row => row.username === 'edited')).toBe(true);
});

it('rejects invalid, stale and duplicate selections without guessing or discarding them', () => {
  for (const alter of [(form: LoginForm) => { form.removedPasswordIds = ['unknown']; },
    (form: LoginForm) => { const id = projectRemovalRows(form)[0].passwordId; form.removedPasswordIds = [id, id]; },
    (form: LoginForm) => { form.removedPasswordIds = [projectRemovalRows(form)[0].passwordId]; form.customFields = []; }]) {
    const { form } = fixture(); alter(form); const before = JSON.stringify(form);
    expect(() => projectRemovalRows(form)).toThrow('移除范围'); expect(JSON.stringify(form)).toBe(before);
  }
});

it('limits persisted deletion to a single supported source using all original references', () => {
  const { form, originals } = fixture();
  const accounts = ['mdbx2','bitwarden','local'].map(kind => ({ id: kind, kind, enabled: true } as ProviderAccount));
  expect(supportsProjectMemberRemoval(form, originals[0], accounts)).toBe(true);
  form.providerId = 'mdbx2'; expect(supportsProjectMemberRemoval(form, originals[0], accounts)).toBe(true);
  form.groupMembers[0].original!.providerRefs = [{providerId:'bitwarden'}];
  expect(supportsProjectMemberRemoval(form, originals[0], accounts)).toBe(false);
  form.groupMembers[0].original!.providerRefs = [];
  form.providerId = 'missing'; expect(supportsProjectMemberRemoval(form, originals[0], accounts)).toBe(false);
});

it('enables remote KeePass member removal while retaining the local-file durability guard', () => {
  const { form, originals } = fixture();
  form.providerId = 'kp';
  for (const row of originals) row.providerRefs = [{ providerId: 'kp' }];
  for (const member of form.groupMembers) if (member.original) member.original.providerRefs = [{ providerId: 'kp' }];
  const provider: ProviderAccount = { id: 'kp', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: { sourceMode: 'webdav' } };
  expect(supportsProjectMemberRemoval(form, originals[0], [provider])).toBe(true);
  provider.config.sourceMode = 'onedrive'; expect(supportsProjectMemberRemoval(form, originals[0], [provider])).toBe(true);
  provider.config.sourceMode = 'local-file'; expect(supportsProjectMemberRemoval(form, originals[0], [provider])).toBe(false);
});

it('drops only unsaved rows, retains rich shared content and keeps original IDs/snapshots', () => {
  const { originals } = fixture(), before = JSON.stringify(originals);
  const added = structuredClone(originals[0]); added.id = crypto.randomUUID();
  added.customFields[0].value = JSON.stringify({ ...JSON.parse(added.customFields[0].value), passwordId: crypto.randomUUID(), passwordOrder: 2 });
  const drafts = [ { ...originals[0], notes: 'Edited shared notes' }, originals[1], added ];
  const retained = omitUnsavedProjectPasswords(drafts, originals, [added.id]);
  expect(retained.map(row => row.id)).toEqual(originals.map(row => row.id));
  for (const row of retained) {
    expect(row.notes).toBe('Edited shared notes'); expect(row.imagePaths).toEqual(['asset-original']);
    expect(row.customFields[0].value).toContain('9007199254740993');
    expect(row.customFields[1]).toEqual(originals[0].customFields[1]);
  }
  expect(JSON.stringify(originals)).toBe(before);
  expect(() => omitUnsavedProjectPasswords(drafts, originals, [originals[0].id])).toThrow('使用项目移除');
});

it('promotes a new draft owner without losing protected fields, project assets or remaining group order', () => {
  const { originals } = fixture();
  originals[0].customFields.push({name:CONTENT_ORDER, value:'NOTES,FUTURE:opaque', protected:true});
  originals[0].passkeyBindings = 'opaque-passkeys';
  originals[1].customFields = originals[1].customFields.slice(0, 1);
  const retained = omitUnsavedProjectPasswords(originals, [], [originals[0].id]);
  expect(retained).toHaveLength(1);
  expect(readProjectCredential(retained[0].customFields)?.passwordOrder).toBe(0);
  expect(retained[0].password).toBe(originals[1].password);
  expect(retained[0].customFields).toContainEqual(originals[0].customFields[1]);
  expect(retained[0].customFields).toContainEqual(originals[0].customFields[2]);
  expect(retained[0].passkeyBindings).toBe('opaque-passkeys');
});
