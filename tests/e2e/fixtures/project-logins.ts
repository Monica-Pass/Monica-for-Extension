import type { LoginItem } from '../../../src/core/model';

/** Synthetic repeated-account project; input order deliberately differs from credential order. */
export function projectLogins(site: string): LoginItem[] {
  const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const rows = [2, 1, 0].map((index): LoginItem => ({
    id: `project-password-${index + 1}`, kind: 'login', title: 'Example Mail', username: 'same-account@example.test',
    password: `project-secret-${index + 1}`, passwordGroupId: uuid(99),
    uris: [index === 0 ? 'https://unmatched.example.net' : site], notes: 'private-project-note', favorite: false,
    createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', providerRefs: [],
    customFields: [{name: 'monica.content.credential', protected: true, value: JSON.stringify({version: 1,
      projectId: uuid(99), groupId: uuid(index === 2 ? 2 : 1), passwordId: uuid(10 + index),
      label: index === 2 ? '备用账户' : '工作账户', primary: index !== 2, groupOrder: index === 2 ? 1 : 0, passwordOrder: index === 2 ? 0 : index
    })}]
  }));
  return [...rows, {...rows[1], id: 'independent-project', passwordGroupId: undefined,
    password: 'independent-secret', customFields: []}];
}
