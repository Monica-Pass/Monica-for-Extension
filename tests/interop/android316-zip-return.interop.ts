import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import type { VaultItem } from '../../src/core/model';
import { decryptAndroidBackup } from '../../src/providers/webdav/android-backup-crypto';
import { listAndroidPortableAttachments, readAndroidBackup, readAndroidPortableAttachment } from '../../src/providers/webdav/android-backup-codec';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const routeFields = new Set(['id', 'createdAt', 'updatedAt', 'providerRefs', 'providerSourceRecords', 'replicaGroupId',
  'mdbxDatabaseId', 'mdbxFolderId', 'keepassDatabaseId', 'passwordGroupId']);
const content = (item: VaultItem) => Object.fromEntries(Object.entries(item).filter(([key, value]) => !routeFields.has(key) && value !== undefined));

it('verifies the actual Android-restored and re-exported ZIP content, groups and attachment bytes', async () => {
  if (!process.env.MONICA_315_APP_FIXTURE) throw new Error('Explicit Android fixture directory required');
  const root = resolve(process.env.MONICA_315_APP_FIXTURE);
  const evidence: Record<string, unknown> = { status: 'failed', layer: 'Actual Android application ZIP return / browser codec; not Edge UI' };
  try {
    const build = JSON.parse(await readFile(join(root, 'build-evidence.json'), 'utf8'));
    const exportBytes = await readFile(join(root, 'export-evidence.json'));
    const exported = JSON.parse(exportBytes.toString('utf8'));
    const restored = JSON.parse(await readFile(join(root, 'zip-evidence.json'), 'utf8'));
    const forward = JSON.parse(await readFile(join(root, 'zip-codec-evidence.json'), 'utf8'));
    expect(build.status).toBe('passed'); expect(restored.status).toBe('passed'); expect(forward.status).toBe('passed');
    expect(exported.status).toBe('passed');
    expect(forward.exportEvidenceSha256).toBe(hash(exportBytes));
    expect(forward.inputSha256).toBe(hash(await readFile(join(root, 'android.zip'))));
    expect(forward.inputSha256).toBe(exported.outputs.find((file: { name: string }) => file.name === 'android.zip').sha256);
    for (const key of ['testSet', 'installedApkSha256', 'installedTestApkSha256', 'targetedAndroidTestSources', 'testSourceHashes', 'deviceBootId']) expect(exported[key], key).toEqual(restored[key]);
    expect(exported.baseline).toEqual(build.after);
    expect(exported.after).toEqual(restored.baseline);
    for (const key of ['androidSourcesUnchanged', 'testSourcesUnchanged', 'installedApplicationUnchanged', 'installedTestApkUnchanged', 'deviceBootUnchanged']) expect(exported[key], key).toBe(true);
    expect(restored.testSet).toBe('full-fields');
    expect(restored.installedTestApkSha256).toBe(build.builtTestApkSha256);
    expect(restored.installedApkSha256).toBe(build.installedApkSha256);
    expect(restored.targetedAndroidTestSources).toEqual(build.targetedAndroidTestSources);
    expect(restored.testSourceHashes).toEqual(build.testSourceHashes);
    expect(restored.baseline).toEqual(build.after);
    for (const key of ['androidSourcesUnchanged', 'testSourcesUnchanged', 'installedApplicationUnchanged', 'installedTestApkUnchanged', 'deviceBootUnchanged']) expect(restored[key], key).toBe(true);
    const beforeBytes = await readFile(join(root, 'extension.zip'));
    const returnedBytes = await readFile(join(root, 'extension-zip-return.zip'));
    expect(hash(beforeBytes)).toBe(forward.outputSha256);
    expect(hash(beforeBytes)).toBe(restored.inputs.find((file: { name: string }) => file.name === 'extension.zip').sha256);
    expect(hash(returnedBytes)).toBe(restored.outputs.find((file: { name: string }) => file.name === 'extension-zip-return.zip').sha256);
    const options = { allowPortableAttachments: true, allowPortablePasskeys: true };
    const before = readAndroidBackup(await decryptAndroidBackup(beforeBytes, 'synthetic archive password'), 'zip-return', options);
    const after = readAndroidBackup(await decryptAndroidBackup(returnedBytes, 'synthetic archive password'), 'zip-return', options);
    expect(before.items).toHaveLength(20); expect(after.items).toHaveLength(20);
    const matched = new Map<string, VaultItem>();
    const differences: Array<{ title: string; kind: string; fields: string[] }> = [];
    evidence.contentDifferences = differences;
    for (const expected of before.items) {
      const matches = after.items.filter(item => item.kind === expected.kind && item.title === expected.title
        && (item.kind !== 'login' || expected.kind !== 'login' || item.password === expected.password));
      expect(matches, expected.title).toHaveLength(1);
      const expectedContent = content(expected); const actualContent = content(matches[0]);
      const fields = [...new Set([...Object.keys(expectedContent), ...Object.keys(actualContent)])]
        .filter(key => !isDeepStrictEqual(expectedContent[key], actualContent[key]));
      if (fields.length) differences.push({ title: expected.title, kind: expected.kind, fields });
      matched.set(expected.id, matches[0]);
    }
    // The destination may allocate a new group ID, but it must preserve the entire
    // membership partition, including same-title independent logins.
    const logins = before.items.filter(item => item.kind === 'login');
    const together = (a: VaultItem, b: VaultItem) => a.kind === 'login' && b.kind === 'login'
      && Boolean(a.passwordGroupId) && a.passwordGroupId === b.passwordGroupId;
    for (const [index, a] of logins.entries()) for (const b of logins.slice(index + 1)) {
      expect(together(matched.get(a.id)!, matched.get(b.id)!), `Group membership changed: ${a.title} / ${b.title}`)
        .toBe(together(a, b));
    }
    const independent = after.items.filter(item => item.kind === 'login' && item.title.includes('-independent'));
    expect(independent).toHaveLength(2);
    expect(new Set(independent.map(item => item.id)).size).toBe(2);
    const group = after.items.filter(item => item.kind === 'login' && item.title.includes('-group'));
    expect(group).toHaveLength(3);
    expect(new Set(group.map(item => item.kind === 'login' && item.passwordGroupId)).size).toBe(1);
    expect(group.every(item => item.kind === 'login' && Boolean(item.passwordGroupId))).toBe(true);
    const attachments = async (document: typeof before) => {
      const result = [];
      for (const item of document.items) for (const attachment of listAndroidPortableAttachments(document, item)) {
        const bytes = await readAndroidPortableAttachment(document, attachment);
        result.push({ title: item.title, kind: item.kind, name: attachment.fileName, size: bytes.length, sha256: hash(bytes) });
      }
      return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    };
    const expectedAttachments = await attachments(before);
    expect(expectedAttachments.length).toBeGreaterThanOrEqual(3);
    expect(await attachments(after)).toEqual(expectedAttachments);
    evidence.attachments = expectedAttachments;
    evidence.membershipVerified = true;
    expect(differences, 'Every decoded content property must survive the actual Android return').toEqual([]);
    Object.assign(evidence, { status: 'passed', inputSha256: hash(beforeBytes), returnSha256: hash(returnedBytes), count: after.items.length,
      kinds: after.items.map(item => item.kind), attachments: expectedAttachments,
      exclusions: [...routeFields], checks: ['all decoded content properties', 'all login group membership pairs retained',
        'same-title independent identities retained', 'three-member group retained', 'owner/title-matched attachment bytes'] });
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    await writeFile(join(root, 'zip-return-codec-evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
