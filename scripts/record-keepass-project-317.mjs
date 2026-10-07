import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..'), raw = '.codex-tasks/android-interop-315/raw';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse((await readFile(path.resolve(root, file), 'utf8')).replace(/^\uFEFF/, ''));
async function record(file) {
  const bytes = await readFile(path.resolve(root, file));
  return { path: path.relative(root, path.resolve(root, file)).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) };
}
async function tree(dir) {
  const files = [];
  for (const entry of await readdir(path.resolve(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await tree(file)); else if (entry.isFile()) files.push(file); else throw new Error('Unexpected evidence entry');
  }
  return files;
}
const unit = await readFile(path.resolve(root, raw, 'keepass-project-317-all-final.log'), 'utf8');
assert.match(unit, /232 passed/); assert.match(unit, /2389 passed/);
const edgeDir = '.tmp/keepass-project-edge-317-sixth/keepass-project-android-An-73a29-el---file-and-fresh-browser';
const edge = await json(`${edgeDir}/evidence.json`), androidDir = '.tmp/android-keepass-project-317';
assert.equal(edge.status, 'passed'); assert.equal(edge.browserFullRestart, true); assert.equal(edge.freshBrowserFileImport, true);
const build = await json(`${androidDir}/build-evidence.json`), device = await json(`${androidDir}/keepass-project-export-evidence.json`);
const android = await json(`${androidDir}/android-keepass-project.json`), independent = await json(`${androidDir}/independent-review.json`);
assert.equal(build.status, 'passed'); assert.equal(device.androidSourcesUnchanged, true); assert.equal(device.installedApkSha256, build.builtAppApkSha256);
assert.equal(android.status, 'failed'); assert.equal(android.projectIdentityPreserved, false); assert.equal(android.originalFilterRestored, true);
assert.equal(independent.status, 'passed'); assert.deepEqual(independent.lostAndroidProjectionFields, []);
const cleanup = await json(`${raw}/keepass-project-317-cache-cleanup.json`); assert.deepEqual(cleanup.integrityFailures, []);
const sources = ['src/providers/keepass/keepass-vault.ts', 'src/providers/keepass/keepass-provider.ts', 'src/security/secure-vault-service.ts',
  'src/App.vue', 'src/components/LoginEditorFields.vue', 'src/providers/keepass/keepass-project-credentials.test.ts',
  'src/security/password-project-singleton.test.ts', 'tests/e2e/keepass-project-android.spec.ts', 'tests/interop/real-services315-keepass-project.interop.ts',
  'tests/interop/android-app/src/takagi/ru/monica/credentialexchange/ExtensionKeePassProjectInteropTest.kt',
  'scripts/interop-315-android-app.mjs', 'scripts/record-keepass-project-317.mjs', 'docs/keepass-project-credentials-317.md', 'docs/password-field-audit-316.md'];
const evidence = await tree(androidDir);
for (const dir of await readdir(path.join(root, '.tmp'))) if (dir.startsWith('keepass-project-edge-317')) evidence.push(...await tree(`.tmp/${dir}`));
evidence.push(...(await readdir(path.join(root, raw))).filter(file => file.startsWith('keepass-project-317-') && file !== 'keepass-project-317-manifest.json').map(file => `${raw}/${file}`), `${raw}/clean-keepass-project-cache-317.ps1`);
const git = (cwd, args) => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const androidRoot = path.resolve(root, '../Monica-main');
const currentAndroid = { revision: git(androidRoot, ['rev-parse', 'HEAD']).toString().trim(),
  statusSha256: hash(git(androidRoot, ['status', '--porcelain=v1', '-uall'])), diffSha256: hash(git(androidRoot, ['diff', '--binary', 'HEAD'])) };
assert.deepEqual(currentAndroid, build.baseline);
const host = await record('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
assert.equal(host.sha256, '781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5');
const manifest = { at: new Date().toISOString(), goalComplete: false, status: 'extension-KDBX-projects-passed-Android-fresh-grouping-failed',
  gitHead: git(root, ['rev-parse', 'HEAD']).toString().trim(), trackedDiffSha256: hash(git(root, ['diff', '--binary', 'HEAD'])),
  sources: await Promise.all(sources.map(record)), builtFiles: await Promise.all((await tree('dist')).map(record)),
  evidence: await Promise.all([...new Set(evidence)].map(record)), android: { baseline: currentAndroid, apkSha256: build.builtAppApkSha256, testApkSha256: build.builtTestApkSha256,
    applicationRebuilt: false, groupingPassed: false, beforeProjects: 2, afterProjects: 4, testedRichFieldsPreserved: true },
  validation: { unitFiles: 232, unitTests: 2389, edgeScenarios: 1, edgeVersion: '154.0.4258.53', independentFileTest: 'passed',
    productionBuild: 'passed', bothTsProjects: 'passed', strictE2eAndVerifierTypes: 'passed', runtimeCommands: 195, screenshotsInspected: true },
  nativeHost: host, cleanup: { bytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length, tenBatchLogicalBytes: 22150124907 },
  limits: ['Android fresh KDBX grouping failed', 'New-project UI and member removal/lifecycle acceptance incomplete', 'Cloud account and Passkey matrices unchanged'] };
await writeFile(path.join(root, raw, 'keepass-project-317-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sources: manifest.sources.length, artifacts: manifest.evidence.length, cacheBytes: manifest.cleanup.bytes, androidGroupingPassed: false }));
