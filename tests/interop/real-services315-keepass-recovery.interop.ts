import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openKeePassVault } from '../../src/providers/keepass/keepass-vault';
import { groupedPasswords } from '../../src/core/password-groups';
import type { LoginItem } from '../../src/core/model';

const proof = process.env.MONICA_KEEPASS_RECOVERY_EDGE;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fields = ['title', 'password', 'username', 'notes', 'passwordGroupId', 'totpSecret', 'uris', 'uriRules',
  'email', 'phone', 'addressLine', 'city', 'state', 'zipCode', 'country', 'creditCardNumber', 'creditCardHolder',
  'creditCardExpiry', 'creditCardCVV', 'appPackageName', 'appName', 'customFields'] as const;
it.skipIf(!proof)('independently opens actual Apache files before and after response-loss recovery', async () => {
  const report = JSON.parse(await readFile(proof!, 'utf8')), root = dirname(proof!);
  expect(report.status).toBe('passed'); expect(report.fullRestart).toBe(true); expect(report.freshBrowser).toBe(true);
  expect(report.audit.filter((entry: { dropped?: boolean }) => entry.dropped)).toHaveLength(1);
  const source = await readFile(resolve('.tmp/android-keepass-project-317/android-keepass-project.kdbx'));
  const committed = await readFile(join(root, 'committed-before-response-loss.kdbx'));
  const recovered = await readFile(join(root, 'recovered.kdbx'));
  expect(hash(source)).toBe(report.sourceSha256); expect(hash(committed)).toBe(report.committedSha256); expect(hash(recovered)).toBe(report.returnSha256);
  const read = async (bytes: Uint8Array, providerId: string) => (await openKeePassVault(bytes, {
    password: 'Synthetic transfer fixture password', providerId, databaseId: 1
  })).items as LoginItem[];
  const original = await read(source, 'original'), before = await read(committed, 'committed'), after = await read(recovered, 'recovered');
  expect(original).toHaveLength(4); expect(before).toHaveLength(7); expect(after).toHaveLength(8);
  expect(groupedPasswords(before).map(rows => rows.length).sort()).toEqual([1, 3, 3]);
  expect(groupedPasswords(after).map(rows => rows.length).sort()).toEqual([1, 3, 4]);
  const compare = (expected: LoginItem, rows: LoginItem[], fromEditor = false) => {
    const actual = rows.find(row => row.keepassEntryUuid === expected.keepassEntryUuid)!; expect(actual).toBeTruthy();
    for (const field of fields) {
      // Empty optional editor strings have no KDBX carrier. Source-file fields
      // and every nonempty editor value are still compared without normalization.
      if (fromEditor && (field === 'totpSecret' || fields.indexOf(field) >= fields.indexOf('email')) && field !== 'customFields' && expected[field] === '')
        expect(actual[field] ?? '', `${expected.title}: ${field}`).toBe('');
      else expect(actual[field], `${expected.title}: ${field}`).toEqual(expected[field]);
    }
  };
  for (const row of original) { compare(row, before); compare(row, after); }
  for (const row of report.expected as LoginItem[]) compare(row, after, true);
  expect(before.filter(row => row.title === 'Recovery project').map(row => row.password).sort()).toEqual(['initial-secret', 'other-secret', 'recovery-secret']);
  expect(after.filter(row => row.title === 'Recovery project').map(row => row.password).sort()).toEqual([
    'added-after-response-loss', 'edited-after-response-loss', 'other-secret', 'recovery-secret'
  ]);
  for (const row of before) expect(after.filter(item => item.keepassEntryUuid === row.keepassEntryUuid)).toHaveLength(1);
  await writeFile(join(root, 'independent-review.json'), JSON.stringify({ status: 'passed', sourceSha256: hash(source),
    committedSha256: hash(committed), recoveredSha256: hash(recovered), originalRows: original.length,
    committedRows: before.length, recoveredRows: after.length, originalFieldsPreserved: true, originalAndCreatedUuidsRetained: true }, null, 2));
});
