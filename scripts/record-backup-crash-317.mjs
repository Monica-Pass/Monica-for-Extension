import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const raw = '.codex-tasks/android-interop-315/raw';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse((await readFile(path.resolve(root, file), 'utf8')).replace(/^\uFEFF/, ''));
const edgeDirectory = '.tmp/backup-crash-edge-317/mdbx2-complete-backup-real-341f3-ments-and-original-Passkeys';
const edge = await json(`${edgeDirectory}/evidence.json`);
assert.equal(edge.status, 'passed'); assert.equal(edge.nativeHost.restored, true); assert.deepEqual(edge.errors, []);
assert.equal(hash(await readFile(edge.nativeHost.executable)), edge.nativeHost.sha256);
const independent = await json(path.join(edge.runRoot, 'independent-review.json'));
assert.equal(independent.status, 'passed'); assert.equal(independent.nativeObjectsExact, 7); assert.equal(independent.originalRsaSignature, true);
const processEvidence = '.tmp/backup-crash-317/e52179fe-7fe8-4f37-b25f-53eef75d8c16/evidence.json';
const crash = await json(processEvidence); assert.equal(crash.status, 'passed'); assert.equal(crash.executableSha256, edge.nativeHost.sha256);
const cleanup = await json(`${raw}/backup-crash-cache-cleanup.json`); assert.deepEqual(cleanup.integrityFailures, []);
const legacy = ['run-6S1NJO', 'run-mnuwAH', 'run-EuP49Z'];
for (const run of legacy) {
  const result = await json(`.tmp/interop-315-edge/${run}/evidence.json`);
  assert.equal(result.status, 'passed'); assert.equal(result.nativeRegistryRestored, true); assert.deepEqual(result.consoleErrors, []);
}

const android = path.resolve(root, '../Monica-main/Monica for Android');
const androidSources = [
  ['app/src/main/java/takagi/ru/monica/ui/screens/MdbxLocalOpenScreen.kt', 'ActivityResultContracts.OpenDocument()'],
  ['app/src/main/java/takagi/ru/monica/viewmodel/MdbxViewModel.kt', 'mdbx2Repository.copyExternalDocumentToOwnedFile(sourceUri)', 'externalTreeUri = null'],
  ['app/src/main/java/takagi/ru/monica/repository/Mdbx2Repository.kt', 'sourceTreeUri: Uri? = null'],
  ['app/src/main/java/takagi/ru/monica/repository/Mdbx2VaultSessionExecutor.kt', 'externalStorage.copyDocumentToOwnedFile(sourceUri, target, sourceTreeUri)'],
  ['app/src/main/java/takagi/ru/monica/repository/Mdbx2ExternalStorage.kt', 'sourceTreeUri?.let { treeUri ->'],
];
const sourceTrace = { capturedAt: new Date().toISOString(), kind: 'read-only-source-trace', runtimeAcceptance: false, files: [] };
for (const [name, ...patterns] of androidSources) {
  const file = path.join(android, name), bytes = await readFile(file), lines = bytes.toString('utf8').split(/\r?\n/);
  const observations = patterns.map(pattern => {
    const index = lines.findIndex(line => line.includes(pattern)); assert.ok(index >= 0, `Source contract changed: ${pattern}`);
    return { line: index + 1, pattern, excerpt: lines.slice(Math.max(0, index - 2), index + 4).join('\n') };
  });
  sourceTrace.files.push({ path: file, sha256: hash(bytes), observations });
}
await writeFile(path.join(root, raw, 'backup-crash-android-source-trace.json'), JSON.stringify(sourceTrace, null, 2) + '\n');
const sources = ['native/mdbx2-host/Cargo.toml', 'native/mdbx2-host/Cargo.lock',
  ...['main.rs', 'runtime.rs', 'local_export.rs', 'backup_scratch.rs'].map(file => `native/mdbx2-host/src/${file}`),
  ...['verify-backup-crash-317.mjs', 'record-backup-crash-317.mjs', 'interop-mdbx-download.mjs', 'interop-315-edge.mjs',
    'interop-315-edge-features.mjs', 'interop-316-edge-api-address.mjs', 'interop-317-edge-native-restore.mjs',
    'complete-backup-317-canvas.mjs', 'verify-complete-backup-edge-317.ts'].map(file => `scripts/${file}`),
  'src/App.vue', 'src/i18n/ui-en.json', ...['de', 'es', 'ja', 'ko', 'ru', 'vi'].map(locale => `public/locales/ui-${locale}.json`),
  'tests/e2e/mdbx2-complete-backup-real.spec.ts', 'docs/mdbx-backup-crash-317.md', 'docs/mdbx-complete-backup-317.md',
  'docs/design/complete-backup-317.md', 'docs/design/complete-backup-317.m3e.json'];
const artifacts = ['native/mdbx2-host/target/debug/monica-mdbx2-host.exe', '.tmp/backup-crash-317-prior-host/monica-mdbx2-host.exe'];
const evidence = [processEvidence];
async function files(directory, destination, filter = () => true) {
  for (const entry of await readdir(path.resolve(root, directory), { withFileTypes: true, recursive: true })) if (entry.isFile()) {
    const relative = path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/');
    if (filter(relative)) destination.push(relative);
  }
}
await files('dist', artifacts);
await files(edge.runRoot, evidence);
await files(edgeDirectory, evidence);
await files(crash.output, evidence);
for (const run of legacy) await files(`.tmp/interop-315-edge/${run}`, evidence, file => /\.(png|json|mdbx)$/.test(file) && !file.includes('/edge-profile/') && !file.includes('/host-appdata/'));
await files(`${raw}/complete-backup-android-copy-canvas`, evidence);
for (const entry of await readdir(path.join(root, raw))) if (/^(backup-crash-|backup-export-|backup-copy-|backup-android-copy-|clean-backup-crash-)/.test(entry) && !entry.includes('manifest') && !entry.endsWith('.jsonl')) {
  if (!entry.endsWith('.log') && !entry.endsWith('.json') && !entry.endsWith('.ps1')) continue;
  evidence.push(`${raw}/${entry}`);
}
const hashed = paths => Promise.all([...new Set(paths)].map(async file => { const bytes = await readFile(path.resolve(root, file)); return { path: file, bytes: bytes.length, sha256: hash(bytes) }; }));
const manifest = { recordedAt: new Date().toISOString(), goalComplete: false, status: 'export-crash-recovery-and-edge-verified',
  git: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSha256: hash(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })) },
  validation: { nativeFullSuite: 71, finalBackupSubset: 7, clippyWarningsDenied: true, languageTests: 28,
    strictTypes: true, productionBuild: true, securityCommands: 192, actualEdge: '154.0.4258.53', independentReview: true,
    originalRsaAuthentication: true, legacyEdgeRuns: legacy, nativeRegistrationRestored: true,
    androidRuntimeAcceptance: false, androidProductSourcesEdited: false, oneDriveAccountLogin: false,
    fullTypeScriptSuiteRepeated: false, releasePackaging: false, buildAfterCacheCleanup: false },
  cacheCleanup: { removedLogicalBytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length, integrityFailures: 0 },
  sources: await hashed(sources), artifacts: await hashed(artifacts), evidence: await hashed(evidence) };
await writeFile(path.join(root, raw, 'backup-crash-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sources: manifest.sources.length, artifacts: manifest.artifacts.length, evidence: manifest.evidence.length,
  cleanupBytes: cleanup.removedLogicalBytes, goalComplete: false }));
