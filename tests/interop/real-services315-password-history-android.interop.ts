import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem } from '../../src/core/model';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { readAndroidBackup, writeAndroidBackup } from '../../src/providers/webdav/android-backup-codec';
import { decryptAndroidBackup, encryptAndroidBackup } from '../../src/providers/webdav/android-backup-crypto';

const stage = process.env.MONICA_HISTORY_ANDROID_STAGE;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
it.skipIf(!stage)(`Edge/server password history -> Android ${stage}`, async () => {
  if (!process.env.MONICA_315_APP_FIXTURE) throw new Error('Set an explicit isolated Android fixture directory');
  const root = resolve(process.env.MONICA_315_APP_FIXTURE); await mkdir(root, { recursive: true });
  if (stage === 'prepare') {
    if (!process.env.MONICA_HISTORY_EDGE_EVIDENCE) throw new Error('Exact real Edge evidence required');
    const proofBytes = await readFile(process.env.MONICA_HISTORY_EDGE_EVIDENCE), proof = JSON.parse(proofBytes.toString());
    expect(proof.status).toBe('passed'); expect(proof.freshBrowserSourceConnection).toBe(true);
    const config = JSON.parse(await readFile(proof.sourceFixture, 'utf8'));
    expect(config.synthetic).toBe(true); expect(config.baseUrl).toBe('http://127.0.0.1:18316'); expect(config.email).toMatch(/^history-[0-9a-f-]+@example\.invalid$/);
    const login = await new BitwardenClient().login({ vaultUrl: config.baseUrl, email: config.email, masterPassword: config.password, deviceId: crypto.randomUUID() });
    if (login.status !== 'authenticated') throw new Error('Synthetic history source unavailable');
    const result = await new BitwardenProvider().sync({ id: 'history-export', kind: 'bitwarden', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: login.session }, { now: new Date().toISOString(), localItems: [] });
    const row = result.items.find(item => item.title === 'Native history') as LoginItem;
    expect(row.passwordHistoryIncomplete).not.toBe(true); expect(row.passwordHistory).toEqual(proof.expectedHistory); expect(row.password).toBe('changed in real Edge');
    const control = { ...createLoginItem({ title: 'Independent history control', password: 'untouched control password', username: 'control' }),
      passwordHistory: [{ password: 'control history', lastUsedAt: '2025-02-03T00:00:00.000Z' }, { password: 'older control', lastUsedAt: '1970-01-01T00:00:00.000Z' }] };
    const bytes = await encryptAndroidBackup(writeAndroidBackup({ entries: {}, records: new Map(), items: [], warnings: [] }, [row, control], 'history-export'), 'synthetic archive password');
    const parsed = readAndroidBackup(await decryptAndroidBackup(bytes, 'synthetic archive password'), 'verify');
    expect(parsed.items).toHaveLength(2);
    expect((parsed.items.find(item => item.title === row.title) as LoginItem).passwordHistory).toEqual(row.passwordHistory);
    await writeFile(join(root, 'extension-history.zip'), bytes);
    await writeFile(join(root, 'expected-history.json'), JSON.stringify({ items: [row, control], inputSha256: hash(bytes), realEdgeProof: resolve(process.env.MONICA_HISTORY_EDGE_EVIDENCE), edgeProofSha256: hash(proofBytes), controlIsSynthetic: true }, null, 2));
  } else if (stage === 'return') {
    const expected = JSON.parse(await readFile(join(root, 'expected-history.json'), 'utf8')) as {
      items: LoginItem[]; inputSha256: string; realEdgeProof: string; edgeProofSha256: string;
    };
    expect(hash(await readFile(expected.realEdgeProof))).toBe(expected.edgeProofSha256);
    expect(hash(await readFile(join(root, 'extension-history.zip')))).toBe(expected.inputSha256);
    const build = JSON.parse(await readFile(join(root, 'build-evidence.json'), 'utf8'));
    expect(build.status).toBe('passed'); expect(build.androidSourcesUnchanged).toBe(true);
    expect(build.testSet).toBe('password-history');
    const device = JSON.parse(await readFile(join(root, 'password-history-import-evidence.json'), 'utf8'));
    expect(device.status).toBe('passed'); expect(device.androidSourcesUnchanged).toBe(true); expect(device.installedApplicationUnchanged).toBe(true);
    expect(device.installedTestApkUnchanged).toBe(true); expect(device.testSourcesUnchanged).toBe(true); expect(device.deviceBootUnchanged).toBe(true);
    expect(device.baseline).toEqual(build.after);
    expect(device.installedApkSha256).toBe(build.builtAppApkSha256);
    expect(device.installedTestApkSha256).toBe(build.builtTestApkSha256);
    expect(device.testSourceHashes).toEqual(build.testSourceHashesAfter);
    expect(hash(await readFile(build.builtAppApk))).toBe(build.builtAppApkSha256);
    expect(hash(await readFile(build.builtTestApk))).toBe(build.builtTestApkSha256);
    expect(device.inputs[0].sha256).toBe(expected.inputSha256);
    const reportBytes = await readFile(join(root, 'android-history-return.json'));
    expect(hash(reportBytes)).toBe(device.outputs.find((row: { name: string }) => row.name === 'android-history-return.json').sha256);
    const report = JSON.parse(reportBytes.toString()); expect(report.status).toBe('passed');
    expect(report.originalFilterRestored).toBe(true);
    expect(report.destinations.map((row: { kind: string; status: string }) => [row.kind, row.status])).toEqual([['mdbx', 'passed'], ['keepass', 'passed']]);
    const checked: unknown[] = [];
    for (const kind of ['mdbx', 'keepass']) {
      const name = `android-history-${kind}-return.zip`, bytes = await readFile(join(root, name));
      expect(hash(bytes)).toBe(device.outputs.find((row: { name: string }) => row.name === name).sha256);
      const document = readAndroidBackup(await decryptAndroidBackup(bytes, 'synthetic archive password'), `return-${kind}`);
      expect(document.items).toHaveLength(2);
      for (const before of expected.items) {
        const actual = document.items.find(item => item.title === before.title) as LoginItem;
        const changed = before.title === 'Native history';
        expect(actual.password).toBe(changed ? `Android history update ${kind}` : before.password);
        const history = changed ? [{ password: before.password, lastUsedAt: new Date(report.destinations.find((row: { kind: string }) => row.kind === kind).newHistoryTimestamp).toISOString() }, ...before.passwordHistory!] : before.passwordHistory;
        expect(actual.passwordHistory).toEqual(history); checked.push({ kind, title: actual.title, historyCount: actual.passwordHistory?.length });
      }
    }
    await writeFile(join(root, 'history-return-evidence.json'), JSON.stringify({ status: 'passed', checked, androidVersion: device.androidVersion, apkSha256: device.installedApkSha256,
      layer: 'Android ZIP targeted restore and history update; not native KDBX/MDBX file history sync' }, null, 2));
  } else throw new Error('Choose prepare or return');
});
