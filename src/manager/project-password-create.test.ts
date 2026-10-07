import { expect, it } from 'vitest';
import { createLoginItem } from '../core/model';
import { createProjectPassword } from './project-password-create';
it('preserves common fields and scope while allocating a fresh remote identity', () => {
  const anchor = { ...createLoginItem({ title: 'Project' }), mdbxDatabaseId: 7, mdbxFolderId: 'folder',
    passwordGroupId: 'group', username: 'old', password: 'old secret', notes: 'common notes', email: '',
    addressLine: '  literal address  ', uris: ['https://example.invalid'], replicaGroupId: 'old-replica',
    customIconType: 'EMOJI', customIconValue: '🔑', customIconUpdatedAt: 123,
    boundNoteId: 7, boundNoteEntryId: 'stable-note',
    keepassEntryUuid: 'old-entry', bitwardenCipherId: 'old-cipher', providerSourceRecords: [{ remoteId: 'old' }],
    providerRefs: [{ providerId: 'native', remoteId: 'old', revision: 'r1' }], imagePaths: ['old-image'],
    passwordHistory: [{ password: 'history', lastUsedAt: '2020' }], customFields: [{ name: 'attachment', value: 'old-ref', protected: true }] };
  const fields = [{ name: 'monica.content.credential', value: 'new metadata', protected: false }];
  const added = createProjectPassword(anchor, { id: 'new-id', username: 'shared', password: 'new secret', totpSecret: '', customFields: fields });
  expect(added).toMatchObject({ id: 'new-id', username: 'shared', password: 'new secret', totpSecret: '',
    mdbxDatabaseId: 7, mdbxFolderId: 'folder', passwordGroupId: 'group', notes: 'common notes', email: '', addressLine: '  literal address  ', customFields: fields,
    customIconType: 'EMOJI', customIconValue: '🔑', customIconUpdatedAt: 123, boundNoteId: 7, boundNoteEntryId: 'stable-note' });
  expect(added.providerRefs).toEqual([{ providerId: 'native' }]);
  for (const key of ['replicaGroupId','keepassEntryUuid','bitwardenCipherId','providerSourceRecords','imagePaths','passwordHistory']) expect(added).not.toHaveProperty(key);
});
