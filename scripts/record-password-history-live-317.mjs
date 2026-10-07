import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const raw = '.codex-tasks/android-interop-315/raw';
const android = '.tmp/android-password-history-317';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(path.resolve(root, file), 'utf8'));
async function record(file) {
  const bytes = await readFile(path.resolve(root, file));
  return { path: path.relative(root, path.resolve(root, file)).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) };
}
async function tree(dir, skipProfiles = false) {
  if (skipProfiles) {
    try { await access(path.resolve(root, dir, 'Local State')); return []; } catch { /* Not a browser profile. */ }
  }
  const files = [];
  for (const entry of await readdir(path.resolve(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await tree(file, skipProfiles));
    else if (entry.isFile()) files.push(file);
    else throw new Error('Unexpected evidence entry');
  }
  return files;
}

const full = await readFile(path.resolve(root, raw, 'password-history-live-317-full.log'), 'utf8');
assert.match(full, /230 passed/); assert.match(full, /2364 passed/);
const latest = await json('.tmp/password-history-live-317/latest.json');
assert.equal((await json(path.join(latest.output, 'evidence.json'))).status, 'passed');
const liveDir = '.tmp/password-history-live-edge-317-final/password-history-bitwarden-6e2c6-arate-fresh-browser-profile';
const live = await json(`${liveDir}/evidence.json`);
assert.equal(live.status, 'passed'); assert.equal(live.freshBrowserSourceConnection, true);
const localFiles = await tree('.tmp/password-history-live-edge-317-local-final', true);
const localProofs = localFiles.filter(file => path.basename(file) === 'evidence.json');
assert.equal(localProofs.length, 2);
for (const file of localProofs) { const proof = await json(file); assert.equal(proof.passed, true); assert.equal(proof.restart, true); }
const appBuild = await json(`${android}/build-evidence.json`);
assert.equal(appBuild.status, 'passed'); assert.equal(appBuild.androidSourcesUnchanged, true);
const device = await json(`${android}/password-history-import-evidence.json`);
const returned = await json(`${android}/history-return-evidence.json`);
assert.equal(device.status, 'passed'); assert.equal(returned.status, 'passed');
assert.equal(device.installedApkSha256, appBuild.builtAppApkSha256);
assert.equal(device.installedTestApkSha256, appBuild.builtTestApkSha256);
assert.deepEqual(device.baseline, appBuild.after);
assert.equal((await json(`${android}/emulator-stopped.json`)).stoppedOwnedAvd, true);
const cleanup = await json(`${raw}/password-history-live-317-cache-cleanup.json`);
assert.deepEqual(cleanup.integrityFailures, []);

const sources = ['src/providers/bitwarden/bitwarden-cipher-codec.ts', 'src/providers/bitwarden/bitwarden-provider.ts',
  'src/providers/bitwarden/bitwarden-provider.test.ts', 'src/providers/bitwarden/bitwarden-password-history.test.ts',
  'src/components/PasswordHistoryDetail.vue', 'tests/e2e/password-history.spec.ts', 'tests/e2e/password-history-bitwarden.spec.ts',
  'tests/interop/real-services315-password-history.interop.ts', 'tests/interop/real-services315-password-history-android.interop.ts',
  'tests/interop/android-app/src/takagi/ru/monica/credentialexchange/ExtensionPasswordHistoryInteropTest.kt',
  'tests/interop/android-app/interop.init.gradle', 'scripts/interop-315-android-app.mjs', 'scripts/record-password-history-live-317.mjs',
  'docs/password-history-317.md', 'docs/password-history-live-317.md'];
const logs = (await readdir(path.resolve(root, raw))).filter(name => name.startsWith('password-history-live-317-') && name !== 'password-history-live-317-manifest.json').map(name => path.join(raw, name));
const host = await record('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
assert.equal(host.sha256, '781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5');
const evidencePaths = [...await tree(liveDir, true), ...localFiles, ...await tree(android), ...await tree(latest.output), ...logs,
  appBuild.builtAppApk, appBuild.builtTestApk, `${raw}/clean-password-history-live-cache-317.ps1`];
const manifest = { at: new Date().toISOString(), goalComplete: false, status: 'live-bitwarden-edge-and-android-zip-history-passed',
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  trackedDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })),
  sources: await Promise.all(sources.map(record)), builtFiles: await Promise.all((await tree('dist')).map(record)),
  evidence: await Promise.all([...new Set(evidencePaths)].map(record)), nativeHost: host,
  androidProvenance: { build: appBuild.baseline, runtime: device.baseline, appSha256: device.installedApkSha256, testSha256: device.installedTestApkSha256 },
  validation: { fullFiles: 230, fullTests: 2364, actualEdgeScenarios: 3, edgeVersion: '154.0.4258.53', build: 'passed', strictE2eTypes: 'passed', securityCommands: 195,
    android: 'Actual targeted ZIP restore / password update / ZIP return for MDBX and KeePass' },
  cleanup: { bytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length },
  limits: ['Android native KDBX/MDBX password-history transport remains unimplemented', 'Android native Bitwarden history sync was not tested here',
    'No new Passkey or actual OneDrive acceptance; earlier gaps remain'] };
await writeFile(path.resolve(root, raw, 'password-history-live-317-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sources: manifest.sources.length, evidence: manifest.evidence.length, cleanupBytes: manifest.cleanup.bytes }));
