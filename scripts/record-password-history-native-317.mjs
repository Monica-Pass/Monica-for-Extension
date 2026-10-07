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
  const result = [];
  for (const entry of await readdir(path.resolve(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await tree(file));
    else if (entry.isFile()) result.push(file);
    else throw new Error('Unexpected evidence link');
  }
  return result;
}
const unit = await readFile(path.join(root, raw, 'password-history-native-317-full.log'), 'utf8');
assert.match(unit, /233 passed/); assert.match(unit, /2414 passed/);
const edgeDir = '.tmp/password-history-native-edge-317/password-history-native-tr-79f8e-d-preserve-it-after-restart';
const edge = await json(`${edgeDir}/evidence.json`), browser = await json(`${edgeDir}/profile-browser.json`);
assert.equal(edge.status, 'passed'); assert.equal(edge.restartVerified, true); assert.equal(edge.nativeUnchanged, true);
assert.equal(edge.nativeHost.restored, true); assert.deepEqual(edge.consoleErrors, []);
assert.match(browser.userAgent, /Edg\//); assert.equal(browser.version, '154.0.4258.53'); assert.equal(browser.headless, false);
const cleanup = await json(`${raw}/password-history-native-317-cache-cleanup.json`);
assert.deepEqual(cleanup.integrityFailures, []);
const sources = ['src/providers/mdbx2/mdbx2-batch-transfer.ts', 'src/providers/mdbx2/mdbx2-batch-transfer-coordinator.ts',
  'src/security/secure-vault-service.ts', 'src/providers/mdbx2/mdbx2-batch-transfer.test.ts',
  'src/providers/mdbx2/mdbx2-batch-transfer-coordinator.test.ts', 'src/security/mdbx2-transfer-service.test.ts',
  'tests/e2e/password-history-native-transfer.spec.ts', 'docs/password-history-native-317.md',
  'docs/password-history-317.md', 'scripts/record-password-history-native-317.mjs'];
const androidPrefix = '../Monica-main/Monica for Android/app/src/main/java/takagi/ru/monica/';
const androidSourcePaths = ['viewmodel/PasswordViewModel.kt', 'repository/PasswordRepository.kt', 'repository/Mdbx2Repository.kt',
  'data/PasswordHistoryEntry.kt', 'data/PasswordHistoryDao.kt', 'utils/KeePassKdbxService.kt',
  'ui/screens/PasswordDetailScreen.kt', 'transfer/DatabaseArchiveExporter.kt', 'utils/BackupRestoreApplier.kt'];
const git = (cwd, args) => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const androidRoot = path.resolve(root, '../Monica-main');
const android = { revision: git(androidRoot, ['rev-parse', 'HEAD']).toString().trim(),
  statusSha256: hash(git(androidRoot, ['status', '--porcelain=v1', '-uall'])), diffSha256: hash(git(androidRoot, ['diff', '--binary', 'HEAD'])) };
const prior = (await json('.tmp/android-keepass-project-317/build-evidence.json')).baseline;
const nativeHost = await record('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
assert.equal(nativeHost.sha256, '781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5');
const evidenceFiles = [...await tree('.tmp/password-history-native-edge-317'),
  ...(await readdir(path.join(root, raw))).filter(file => file.startsWith('password-history-native-317-') && file !== 'password-history-native-317-manifest.json').map(file => `${raw}/${file}`),
  `${raw}/clean-password-history-native-cache-317.ps1`];
const manifest = { at: new Date().toISOString(), status: 'native-history-transfer-protection-passed', goalComplete: false,
  gitHead: git(root, ['rev-parse', 'HEAD']).toString().trim(), trackedDiffSha256: hash(git(root, ['diff', '--binary', 'HEAD'])),
  sources: await Promise.all(sources.map(record)), builtFiles: await Promise.all((await tree('dist')).map(record)),
  evidence: await Promise.all(evidenceFiles.map(record)), nativeHost,
  android: { baseline: android, unchangedSincePriorBatch: Object.entries(android).every(([key, value]) => prior[key] === value),
    sourceTrace: await Promise.all(androidSourcePaths.map(file => record(androidPrefix + file))), runtimeTestedThisBatch: false, applicationRebuilt: false },
  validation: { unitFiles: 233, unitTests: 2414, focusedTests: 55, productionBuild: 'passed', bothTsProjects: 'passed',
    strictE2eTypes: 'passed', runtimeCommands: 195, actualEdgeScenarios: 1, edgeVersion: browser.version, previewScreenshotInspected: true },
  cleanup: { bytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length, thirteenBatchLogicalBytes: 25578658528 + cleanup.removedLogicalBytes },
  limits: ['Native password-only history transport remains unsupported by current Android MDBX2/KDBX reader/writer',
    'Actual Android ZIP acceptance is previous evidence; no Android runtime test this batch',
    'Same-object folder relocation with local history tested at coordinator and encrypted-restart level',
    'No new Passkey or OneDrive acceptance; overall Android parity remains incomplete'] };
await writeFile(path.join(root, raw, 'password-history-native-317-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sources: manifest.sources.length, artifacts: manifest.evidence.length,
  androidSourcesUnchanged: manifest.android.unchangedSincePriorBatch, cacheBytes: manifest.cleanup.bytes,
  protectedFiles: manifest.cleanup.protectedFiles, goalComplete: false }));
