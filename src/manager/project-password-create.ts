import { createLoginItem, type LoginItem } from '../core/model';
import type { LoginForm } from './login-form';
import { PROJECT_COMMON_FIELDS } from '../core/project-credential-edits';

/** New password row in the same project: copy common data, never another row's remote identity or history. */
export function createProjectPassword(anchor: LoginItem, member: LoginForm['groupMembers'][number]): LoginItem {
  const item = createLoginItem({ title: anchor.title, providerRefs: anchor.providerRefs.map(ref => ({ providerId: ref.providerId })) });
  const common = [...PROJECT_COMMON_FIELDS, 'categoryId', 'categoryName',
    'mdbxDatabaseId', 'mdbxFolderId', 'keepassDatabaseId', 'keepassGroupPath', 'keepassGroupUuid'] as const;
  for (const key of common) if (Object.prototype.hasOwnProperty.call(anchor, key)) Object.assign(item, { [key]: anchor[key] });
  return { ...item, id: member.id, loginType: 'PASSWORD', username: member.username, password: member.password,
    totpSecret: member.totpSecret, passwordGroupId: anchor.passwordGroupId, customFields: member.customFields ?? [] };
}
