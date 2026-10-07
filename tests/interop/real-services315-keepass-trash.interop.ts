import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openKeePassVault } from '../../src/providers/keepass/keepass-vault';
import { keePassFieldText } from '../../src/providers/keepass/keepass-login-codec';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { groupedPasswords } from '../../src/core/password-groups';
import type { LoginItem, PasskeyItem } from '../../src/core/model';

const proof = process.env.MONICA_KEEPASS_TRASH_EDGE;
it.skipIf(!proof)('keeps actual Apache committed deletions in the native KDBX recycle bin', async () => {
  const before = await openKeePassVault(await readFile(join(proof!, 'before-delete.kdbx')), {
    password: 'Synthetic transfer fixture password', providerId: 'before', databaseId: 1 });
  const deleted = await openKeePassVault(await readFile(join(proof!, 'committed-delete.kdbx')), {
    password: 'Synthetic transfer fixture password', providerId: 'deleted', databaseId: 1 });
  await writeFile(join(proof!, 'native-trash-review.json'), JSON.stringify({
    before: { version: `${before.database.header.versionMajor}.${before.database.header.versionMinor}`, recycleBinEnabled: before.database.meta.recycleBinEnabled,
      recycleBinUuid: before.database.meta.recycleBinUuid?.toString(), entries: before.items.map(row => ({ id: row.keepassEntryUuid, kind: row.kind, deleted: !!row.deletedAt })) },
    deleted: { recycleBinEnabled: deleted.database.meta.recycleBinEnabled, recycleBinUuid: deleted.database.meta.recycleBinUuid?.toString(),
      entries: deleted.items.map(row => ({ id: row.keepassEntryUuid, kind: row.kind, deleted: !!row.deletedAt })) }
  }, null, 2));
  expect(deleted.items).toHaveLength(5); expect(deleted.items.filter(row => row.deletedAt)).toHaveLength(4);
  const evidence = JSON.parse(await readFile(join(proof!, 'evidence.json'), 'utf8'));
  expect(evidence.status).toBe('passed'); expect(evidence.freshNativeTrash).toBe(true); expect(evidence.passkeySigned).toBe(true);
  const returned = await readFile(join(proof!, 'restored.kdbx'));
  expect(createHash('sha256').update(returned).digest('hex')).toBe(evidence.returnSha256);
  expect(createHash('sha256').update(await readFile(join(proof!, 'committed-delete.kdbx'))).digest('hex')).toBe(evidence.committedSha256);
  const restored = await openKeePassVault(returned, { password: 'Synthetic transfer fixture password', providerId: 'restored', databaseId: 1 });
  expect(restored.items).toHaveLength(5); expect(restored.items.every(row => !row.deletedAt)).toBe(true);
  expect(groupedPasswords(restored.items.filter((row): row is LoginItem => row.kind === 'login')).map(rows => rows.length).sort()).toEqual([1, 3]);
  for (const original of before.items) {
    const entry = before.entriesByUuid.get(original.keepassEntryUuid!)!, tombstone = deleted.entriesByUuid.get(original.keepassEntryUuid!)!;
    const after = restored.entriesByUuid.get(original.keepassEntryUuid!)!;
    expect(tombstone).toBeTruthy(); expect(after).toBeTruthy(); expect(after.parentGroup?.uuid.toString()).toBe(entry.parentGroup?.uuid.toString());
    const exactFields = (row: typeof entry) => [...row.fields].map(([name, value]) => [name, keePassFieldText(value)]).sort(([a], [b]) => a.localeCompare(b));
    expect(exactFields(tombstone)).toEqual(exactFields(entry)); expect(tombstone.binaries).toEqual(entry.binaries);
    if (original.kind !== 'passkey') { expect(exactFields(after)).toEqual(exactFields(entry)); expect(after.history.length).toBe(entry.history.length); }
    expect(after.binaries).toEqual(entry.binaries);
  }
  const keyBefore = before.items.find(row => row.kind === 'passkey') as PasskeyItem, keyAfter = restored.items.find(row => row.kind === 'passkey') as PasskeyItem;
  for (const name of ['credentialId', 'rpId', 'userHandle', 'publicKey', 'privateKeyPkcs8', 'algorithm', 'backupEligible', 'backupState'] as const)
    expect(keyAfter[name], name).toBe(keyBefore[name]);
  expect(keyBefore.signCount).toBe(41); expect(keyAfter.signCount).toBe(42);
  const assertion = evidence.assertion, auth = Buffer.from(assertion.response.authenticatorData, 'base64url'), client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
  expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), createPublicKey({ key: Buffer.from(keyAfter.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
  await writeFile(join(proof!, 'independent-review.json'), JSON.stringify({ status: 'passed', beforeRows: before.items.length,
    deletedRows: deleted.items.filter(row => row.deletedAt).length, restoredRows: restored.items.length,
    repairedRecycleBin: before.database.meta.recycleBinEnabled === false && deleted.database.meta.recycleBinEnabled === true,
    originalEntryUuidsAndParentsPreserved: true, passwordsAndNativeFieldsExact: true, passkeyMaterialExact: true,
    actualAssertionVerified: true, returnSha256: evidence.returnSha256 }, null, 2));
});
