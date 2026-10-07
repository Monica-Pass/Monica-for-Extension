import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.tmp/android-cm-backends-317');
const android = resolve(root, '../Monica-main');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
async function record(path) { return { path: relative(root, path).replaceAll('\\', '/'), sha256: hash(await readFile(path)) }; }
const build = await json(join(out, 'build-evidence.json'));
assert.equal(build.status, 'passed');
assert.equal(build.androidSourcesUnchanged, true);
assert.equal(build.testSourcesUnchanged, true);
for (const [file, expected] of [[build.builtAppApk, build.builtAppApkSha256], [build.builtTestApk, build.builtTestApkSha256],
  [build.applicationCompileApi.path, build.applicationCompileApi.sha256]]) assert.equal(hash(await readFile(file)), expected);
const auth = await json(join(out, 'system-acceptance.json'));
const review = await json(join(out, 'metadata-ui-review.json'));
assert.equal(auth.proofs.length, 3);
assert.ok(auth.proofs.every(proof => proof.rpAcceptance === 'pass'));
assert.equal(review.interoperabilityComplete, false);
assert.ok(review.metadata.every(row => !row.preserved));
assert.ok(review.ui.every(row => row.fullStoredNotesShownBeforePassword));
assert.equal((await json(join(out, 'restored.json'))).restored, true);
const cleanup = await json(join(out, 'cache-cleanup.json'));
assert.deepEqual(cleanup.integrityFailures, []);
for (const folder of ['before-backends', 'after-backends']) {
  const storage = await json(join(out, folder, 'storage-evidence.json'));
  for (const file of storage.files.filter(row => !row.name.endsWith('-shm')))
    assert.equal(hash(await readFile(join(out, folder, file.name))), file.sha256, 'Saved database/WAL still match device copies');
}
const sourcePaths = [
  'scripts/interop-315-android-app.mjs', 'scripts/interop-317-android-cm-device.mjs', 'scripts/interop-317-android-cm-ui.mjs',
  'scripts/interop-317-android-cm-verify.mjs', 'scripts/interop-317-android-cm-rp-build.mjs',
  'scripts/interop-317-android-cm-backends-prepare.ts', 'scripts/interop-317-android-cm-backends-review.mjs',
  'scripts/record-android-cm-backends-317.mjs', 'tests/interop/android-cm-rp/MainActivity.java', 'tests/interop/android-cm-rp/AndroidManifest.xml',
  'tests/interop/android-app/src/takagi/ru/monica/credentialexchange/ExtensionSystemBackendCredentialInteropTest.kt',
  'docs/android-system-backends-317.md', 'docs/android-system-credential-manager-317.md',
  '.codex-tasks/android-interop-315/raw/clean-cm-backend-caches-20261006.ps1',
];
const androidPaths = [
  'passkey/MonicaCredentialProviderService.kt', 'passkey/PasskeyAuthActivity.kt', 'passkey/PasskeyCredentialIdCodec.kt',
  'passkey/PasskeyPrivateKeyStore.kt', 'data/PasskeyEntry.kt', 'repository/PasskeyRepository.kt',
  'utils/KeePassKdbxService.kt', 'utils/WebDavKeePassFileSource.kt', 'bitwarden/service/CipherSyncProcessor.kt',
].map(path => `Monica for Android/app/src/main/java/takagi/ru/monica/${path}`);
const testedAndroidSources = androidPaths.map(path => ({ path,
  commit: build.baseline.revision, gitBlobSha256: hash(execFileSync('git', ['show', `${build.baseline.revision}:${path}`], { cwd: android, windowsHide: true, maxBuffer: 8e6 })) }));
const currentDiff = execFileSync('git', ['diff', '--binary'], { cwd: android, windowsHide: true, maxBuffer: 16e6, stdio: ['ignore', 'pipe', 'ignore'] });
const currentDiffNames = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-only'], { cwd: android, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/).filter(Boolean);
const logs = (await files(join(root, '.codex-tasks/android-interop-315/raw'))).filter(path => /android-cm-backends-.*\.log$/.test(path));
const report = { at: new Date().toISOString(), scope: 'Three historical Edge registrations through production imports and actual native system credential authentication',
  credentialAuthentication: 'passed 3/3', metadataAndPreAuthenticationUi: 'failed', interoperabilityComplete: false,
  application: { path: build.builtAppApk, sha256: build.builtAppApkSha256, cleanSourceCommitAtBuild: build.baseline.revision, builtAt: build.finishedAt },
  sourceBoundary: { currentAndroidDiffSha256: hash(currentDiff), currentAndroidChangedFiles: currentDiffNames,
    note: 'Another batch of Android workspace changes appeared after the verified build, including MDBX Room-mirror guards. This evidence applies to the exact installed APK; this task made no Android product edits.' },
  testedAndroidSources, sources: await Promise.all(sourcePaths.map(path => record(join(root, path)))),
  evidence: await Promise.all((await files(out)).sort().map(record)), logs: await Promise.all(logs.sort().map(record)),
  built: await Promise.all([build.builtAppApk, build.builtTestApk].map(record)), cleanup: { logicalBytesRemoved: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles },
};
await writeFile(join(root, '.codex-tasks/android-interop-315/raw/android-cm-backends-manifest.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ credentialAuthentication: report.credentialAuthentication, metadataAndPreAuthenticationUi: report.metadataAndPreAuthenticationUi,
  evidenceFiles: report.evidence.length, protectedFiles: report.cleanup.protectedFiles, laterAndroidChangedFiles: currentDiffNames.length }));
