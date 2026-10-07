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
const unit = await readFile(path.join(root, raw, 'keepass-recovery-317-all-final.log'), 'utf8');
assert.match(unit, /233 passed/); assert.match(unit, /2398 passed/);
const edgeDir = '.tmp/keepass-recovery-edge-317-final/keepass-project-recovery-r-dbede--before-a-full-Edge-restart';
const edge = await json(`${edgeDir}/evidence.json`), independent = await json(`${edgeDir}/independent-review.json`);
assert.equal(edge.status, 'passed'); assert.equal(edge.fullRestart, true); assert.equal(edge.freshBrowser, true);
assert.equal(independent.status, 'passed'); assert.equal(independent.recoveredRows, 8); assert.equal(independent.originalFieldsPreserved, true);
const cleanup = await json(`${raw}/keepass-recovery-317-cache-cleanup.json`); assert.deepEqual(cleanup.integrityFailures, []);
const stopped = await json('.tmp/keepass-recovery-317/docker-stopped.json'); assert.equal(stopped.Running, false);
const browser = await json(`${edgeDir}/profile-browser.json`); assert.match(browser.userAgent, /Edg\//); assert.equal(browser.version, '154.0.4258.53');
assert.equal(browser.headless, false);
const sources = ['src/providers/keepass/keepass-durable-sync.ts', 'src/providers/keepass/keepass-remote-session.ts',
  'src/security/secure-vault-service.ts', 'src/providers/keepass/keepass-recovery-state.test.ts', 'src/providers/keepass/keepass-durable-sync.test.ts',
  'tests/e2e/keepass-project-recovery.spec.ts', 'tests/interop/real-services315-keepass-recovery.interop.ts',
  'scripts/record-keepass-recovery-317.mjs', 'docs/keepass-recovery-317.md'];
const evidence = await tree('.tmp/keepass-recovery-317');
for (const dir of await readdir(path.join(root, '.tmp'))) if (dir.startsWith('keepass-recovery-edge-317')) evidence.push(...await tree(`.tmp/${dir}`));
evidence.push(...(await readdir(path.join(root, raw))).filter(file => file.startsWith('keepass-recovery-317-') && file !== 'keepass-recovery-317-manifest.json').map(file => `${raw}/${file}`),
  `${raw}/clean-keepass-recovery-cache-317.ps1`, `${raw}/keepass-project-317-manifest.json`, '.tmp/android-keepass-project-317/android-keepass-project.kdbx');
const git = (cwd, args) => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const androidRoot = path.resolve(root, '../Monica-main');
const android = { revision: git(androidRoot, ['rev-parse', 'HEAD']).toString().trim(),
  statusSha256: hash(git(androidRoot, ['status', '--porcelain=v1', '-uall'])), diffSha256: hash(git(androidRoot, ['diff', '--binary', 'HEAD'])) };
const priorAndroid = (await json('.tmp/android-keepass-project-317/build-evidence.json')).baseline;
const host = await record('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
assert.equal(host.sha256, '781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5');
const manifest = { at: new Date().toISOString(), goalComplete: false, status: 'KeePass-recovery-and-batch-boundary-passed',
  gitHead: git(root, ['rev-parse', 'HEAD']).toString().trim(), trackedDiffSha256: hash(git(root, ['diff', '--binary', 'HEAD'])),
  sources: await Promise.all(sources.map(record)), builtFiles: await Promise.all((await tree('dist')).map(record)),
  evidence: await Promise.all([...new Set(evidence)].map(record)), android: { baseline: android,
    unchangedSincePriorBatch: Object.entries(android).every(([key, value]) => priorAndroid[key] === value), runtimeTestedThisBatch: false, applicationRebuilt: false },
  validation: { unitFiles: 233, unitTests: 2398, focusedTests: 15, edgeScenarios: 1, edgeVersion: '154.0.4258.53',
    independentFileTest: 'passed', productionBuild: 'passed', bothTsProjects: 'passed', strictE2eTypes: 'passed', runtimeCommands: 195, freshListInspected: true },
  nativeHost: host, cleanup: { bytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length,
    elevenBatchLogicalBytes: 22150124907 + cleanup.removedLogicalBytes },
  limits: ['Android fresh KDBX grouping remains failed', 'No new actual OneDrive or Android Passkey validation',
    'Committed delete followed by local restore unverified', 'Full project conflict/lifecycle atomicity and native history transport incomplete'] };
await writeFile(path.join(root, raw, 'keepass-recovery-317-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sources: manifest.sources.length, artifacts: manifest.evidence.length, cacheBytes: manifest.cleanup.bytes,
  protectedFiles: manifest.cleanup.protectedFiles, androidSourcesUnchanged: manifest.android.unchangedSincePriorBatch, goalComplete: false }));
