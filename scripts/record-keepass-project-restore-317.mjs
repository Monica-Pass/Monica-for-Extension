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
const unit = await readFile(path.join(root, raw, 'keepass-project-restore-317-full.log'), 'utf8');
assert.match(unit, /234 passed/); assert.match(unit, /2433 passed/);
assert.match(await readFile(path.join(root, raw, 'keepass-project-restore-317-focused-final.log'), 'utf8'), /41 passed/);
const edgeDir = '.tmp/keepass-project-restore-edge-317-final/keepass-project-restore-ac-3c29f-lishes-after-a-full-restart';
const edge = await json(`${edgeDir}/evidence.json`), browser = await json(`${edgeDir}/fresh-browser.json`);
assert.equal(edge.status, 'passed'); assert.equal(edge.cancelPreserved, true); assert.equal(edge.queuedRestartVerified, true);
assert.equal(edge.nativeIdentityFieldsParentsHistoryPreserved, true); assert.equal(edge.freshTrashProject, 3);
assert.match(browser.userAgent, /Edg\//); assert.equal(browser.version, '154.0.4258.53'); assert.equal(browser.headless, false);
assert.equal((await record(`${edgeDir}/restored-project.kdbx`)).sha256, edge.restoredSha256);
assert.equal((await record(`${edgeDir}/native-trash.kdbx`)).sha256, edge.trashSha256);
const cleanup = await json(`${raw}/keepass-project-restore-317-cache-cleanup.json`);
assert.deepEqual(cleanup.integrityFailures, []);
const sources = ['src/core/keepass-project-restore.ts', 'src/core/model.ts', 'src/security/secure-vault-service.ts',
  'src/security/keepass-project-restore.test.ts', 'src/providers/keepass/keepass-recovery-state.test.ts',
  'src/background/password-project-restore.ts', 'src/background/password-project-restore.test.ts',
  'src/manager/project-restore.ts', 'src/manager/project-restore.test.ts', 'src/runtime/client.ts', 'src/runtime/messages.ts',
  'src/App.vue', 'src/components/PasswordProjectRestoreDialog.vue', 'src/i18n/ui-en.json',
  ...['ja','ko','de','es','ru','vi'].map(locale => `public/locales/ui-${locale}.json`),
  'tests/e2e/keepass-project-restore.spec.ts', 'docs/keepass-project-restore-317.md', 'docs/design/keepass-project-restore-317.md',
  'docs/design/android-interop-315.m3e.json', 'scripts/design-keepass-project-restore-317.mjs',
  'scripts/localize-project-restore.mjs', 'scripts/record-keepass-project-restore-317.mjs'];
const git = (cwd, args) => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const androidRoot = path.resolve(root, '../Monica-main');
const android = { revision: git(androidRoot, ['rev-parse', 'HEAD']).toString().trim(),
  statusSha256: hash(git(androidRoot, ['status', '--porcelain=v1', '-uall'])), diffSha256: hash(git(androidRoot, ['diff', '--binary', 'HEAD'])) };
const prior = (await json('.tmp/android-keepass-project-317/build-evidence.json')).baseline;
const priorTrace = (await json(`${raw}/password-history-native-317-manifest.json`)).android.sourceTrace;
const androidTrace = await Promise.all(priorTrace.map(async previous => {
  const current = await record(previous.path);
  return { ...current, previousSha256: previous.sha256, unchanged: current.sha256 === previous.sha256 };
}));
const evidenceFiles = [...await tree('.tmp/keepass-project-restore-edge-317-final'), ...await tree('.tmp/keepass-project-restore-317'),
  ...(await readdir(path.join(root, raw))).filter(file => file.startsWith('keepass-project-restore-317-') && file !== 'keepass-project-restore-317-manifest.json').map(file => `${raw}/${file}`),
  `${raw}/clean-keepass-project-restore-cache-317.ps1`, `${raw}/canvas-keepassrestore317.png`, `${raw}/canvas-keepassrestoreconflict317.png`];
const manifest = { at: new Date().toISOString(), status: 'keepass-project-restore-passed', goalComplete: false,
  gitHead: git(root, ['rev-parse', 'HEAD']).toString().trim(), trackedDiffSha256: hash(git(root, ['diff', '--binary', 'HEAD'])),
  sources: await Promise.all(sources.map(record)), builtFiles: await Promise.all((await tree('dist')).map(record)), evidence: await Promise.all(evidenceFiles.map(record)),
  android: { baseline: android, unchangedSincePriorBatch: Object.entries(android).every(([key, value]) => prior[key] === value),
    sourceTrace: androidTrace, runtimeTestedThisBatch: false, applicationRebuilt: false,
    note: 'Android checkout changed during this batch; this task did not write Android sources. Revalidate its current source/APK before further Android acceptance.' },
  validation: { fullUnitFiles: 234, fullUnitTests: 2433, afterFinalSizeGuardFocusedTests: 41, finalProductionBuild: 'passed', bothTsProjects: 'passed',
    strictE2eTypes: 'passed', runtimeCommands: 195, actualEdgeScenarios: 1, edgeVersion: browser.version, screenshotsInspected: true },
  cleanup: { bytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length, fifteenBatchLogicalBytes: 25652444844 + cleanup.removedLogicalBytes },
  limits: ['KeePass restores all current trashed members explicitly confirmed, not a native deletion timestamp cohort',
    'Queued receipt acknowledges encrypted local staging, not cloud publication', 'Actual Edge fixture binary map/history count checks; three attachment byte arrays independently tested with in-memory remote transport',
    'No Android runtime, new Passkey signing or real OneDrive account acceptance this batch', 'Overall Android parity remains incomplete'] };
await writeFile(path.join(root, raw, 'keepass-project-restore-317-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sources: manifest.sources.length, artifacts: manifest.evidence.length,
  androidSourcesUnchanged: manifest.android.unchangedSincePriorBatch, cacheBytes: manifest.cleanup.bytes,
  protectedFiles: manifest.cleanup.protectedFiles, goalComplete: false }));
