import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openKeePassVault } from '../../src/providers/keepass/keepass-vault';
import { groupedPasswords } from '../../src/core/password-groups';
import { readProjectCredential } from '../../src/core/project-credentials';
import type { LoginItem } from '../../src/core/model';

const sourceRoot = process.env.MONICA_KEEPASS_PROJECT_ANDROID;
const edgeProof = process.env.MONICA_KEEPASS_PROJECT_EDGE;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
it.skipIf(!sourceRoot || !edgeProof)('independently reopens exact Android and Edge KDBX files and retains the failed Android grouping result', async () => {
  const root = resolve(sourceRoot!), edge = JSON.parse(await readFile(edgeProof!, 'utf8'));
  const android = JSON.parse(await readFile(join(root, 'android-keepass-project.json'), 'utf8'));
  const source = await readFile(join(root, 'android-keepass-project.kdbx'));
  const returned = await readFile(join(dirname(edgeProof!), 'edge-return.kdbx'));
  expect(hash(source)).toBe(edge.androidFixtureSha256); expect(hash(returned)).toBe(edge.returnSha256);
  expect(edge.status).toBe('passed'); expect(android.projectIdentityPreserved).toBe(false);
  const original = (await openKeePassVault(source, { password: 'Synthetic transfer fixture password', providerId: 'source', databaseId: 1 })).items as LoginItem[];
  const reopened = (await openKeePassVault(returned, { password: 'Synthetic transfer fixture password', providerId: 'return', databaseId: 2 })).items as LoginItem[];
  expect(groupedPasswords(original).map(rows => rows.length).sort()).toEqual([1, 3]);
  expect(groupedPasswords(reopened).map(rows => rows.length).sort()).toEqual([1, 5]);
  for (const expected of edge.expected as LoginItem[]) {
    const actual = reopened.find(row => row.keepassEntryUuid === expected.keepassEntryUuid)!;
    expect(actual).toBeTruthy();
    for (const key of ['password', 'title', 'username', 'notes', 'email', 'phone', 'addressLine', 'city', 'state', 'zipCode', 'country', 'creditCardNumber', 'creditCardHolder', 'creditCardExpiry', 'creditCardCVV', 'appPackageName', 'appName', 'passwordGroupId', 'totpSecret'] as const) expect(actual[key], key).toBe(expected[key]);
    expect(actual.customFields).toEqual(expected.customFields);
    expect(readProjectCredential(actual.customFields)).toEqual(readProjectCredential(expected.customFields));
  }
  const lostProjectionFields: { password: string; field: string }[] = [];
  for (const before of android.before) {
    const after = android.after.find((row: { uuid: string }) => row.uuid === before.uuid);
    expect(after).toBeTruthy();
    for (const field of ['username', 'password', 'otp', 'notes', 'website', 'email', 'phone', 'addressLine', 'city', 'state', 'zipCode', 'country', 'creditCardNumber', 'creditCardHolder', 'creditCardExpiry', 'creditCardCVV', 'appPackageName', 'appName', 'fields']) {
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) lostProjectionFields.push({ password: before.password, field });
    }
  }
  await writeFile(join(root, 'independent-review.json'), JSON.stringify({ status: 'passed', androidFreshGroupingStatus: 'failed',
    sourceSha256: hash(source), returnedSha256: hash(returned), originalRowCount: original.length, returnedRowCount: reopened.length,
    lostAndroidProjectionFields: lostProjectionFields }, null, 2));
  expect(lostProjectionFields).toEqual([]);
});
