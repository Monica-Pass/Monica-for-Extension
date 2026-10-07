import { expect, it } from 'vitest';
import { createLoginItem } from './model';
import { passwordProjectGroups } from './password-project-view';
import { PROJECT_CREDENTIAL_FIELD } from './project-credentials';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (group: number, password: number) => ({ ...createLoginItem({ title: 'Same title', username: 'Same account' }),
  passwordGroupId: uuid(99), customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true,
    value: JSON.stringify({ version: 1, groupId: uuid(group + 1), passwordId: uuid(10 + group * 10 + password),
      label: '', primary: group === 0, groupOrder: group, passwordOrder: password }).replace(/}$/, ',"future":9007199254740993}') }] });

it('distinguishes groups with identical accounts and orders original password records without changing data', () => {
  const items = [row(1, 0), row(0, 1), row(0, 0)]; const before = JSON.stringify(items);
  const groups = passwordProjectGroups(items)!;
  expect(groups.map(group => group.rows.map(row => row.item.id))).toEqual([[items[2].id, items[1].id], [items[0].id]]);
  expect(groups[0].rows[0].item).toBe(items[2]); expect(JSON.stringify(items)).toBe(before);
});

it('retains a singleton group and never invents a project for an ungrouped login', () => {
  const single = row(0, 0);
  expect(passwordProjectGroups([single])).toHaveLength(1);
  expect(passwordProjectGroups([{ ...single, passwordGroupId: undefined }])).toBeUndefined();
  expect(passwordProjectGroups([])).toBeUndefined();
});

it.each(['legacy', 'future', 'duplicate', 'account-conflict', 'otp-conflict', 'label-conflict', 'scope', 'type'])('uses the original row navigation for %s without hiding or merging values', mode => {
  const items = [row(0, 0), row(0, 1)];
  if (mode === 'legacy') items[1].customFields = [];
  if (mode === 'future') items[1].customFields[0].value = items[1].customFields[0].value.replace('"version":1', '"version":2');
  if (mode === 'duplicate') items[1].customFields = items[0].customFields;
  if (mode === 'account-conflict') items[1].username = 'Other account';
  if (mode === 'otp-conflict') items[1].totpSecret = 'Different OTP';
  if (mode === 'label-conflict') items[1].customFields[0].value = items[1].customFields[0].value.replace('"label":""', '"label":"different"');
  if (mode === 'scope') items[1].providerRefs = [{ providerId: 'another' }];
  if (mode === 'type') items[1].loginType = 'WIFI';
  const before = JSON.stringify(items);
  expect(passwordProjectGroups(items)).toBeUndefined(); expect(JSON.stringify(items)).toBe(before);
});
