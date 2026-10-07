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
const unit = await readFile(path.join(root, raw, 'keepass-project-atomic-317-full.log'), 'utf8');
assert.match(unit, /233 passed/); assert.match(unit, /2422 passed/);
const edgeDir = '.tmp/keepass-project-atomic-edge-317-second/keepass-project-conflict-r-af876-h-peer-can-save-it-together';
const edge = await json(`${edgeDir}/evidence.json`), browser = await json(`${edgeDir}/profile-browser.json`);
assert.equal(edge.status, 'passed'); assert.equal(edge.conflictSurvivesRestart, true);
assert.equal(edge.nativeUuidsAndOtherFieldsExact, true); assert.equal(edge.freshPeerWholeProjectSaved, true);
assert.match(browser.userAgent, /Edg\//); assert.equal(browser.version, '154.0.4258.53'); assert.equal(browser.headless, false);
assert.equal((await record(`${edgeDir}/accepted-project.kdbx`)).sha256, edge.acceptedSha256);
assert.equal((await record(`${edgeDir}/remote-concurrent.kdbx`)).sha256, edge.remoteConcurrentSha256);
const cleanup = await json(`${raw}/keepass-project-atomic-317-cache-cleanup.json`);
assert.deepEqual(cleanup.integrityFailures, []);
const sources = ['src/providers/keepass/keepass-provider.ts', 'src/providers/keepass/keepass-writer.ts',
  'src/providers/keepass/keepass-remote-rebase.ts', 'src/providers/keepass/keepass-project-credentials.test.ts',
  'src/providers/keepass/keepass-remote-rebase.test.ts', 'tests/e2e/keepass-project-conflict.spec.ts',
  'docs/keepass-project-atomic-317.md', 'scripts/record-keepass-project-atomic-317.mjs'];
const git = (cwd, args) => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const androidRoot = path.resolve(root, '../Monica-main');
const android = { revision: git(androidRoot, ['rev-parse', 'HEAD']).toString().trim(),
  statusSha256: hash(git(androidRoot, ['status', '--porcelain=v1', '-uall'])), diffSha256: hash(git(androidRoot, ['diff', '--binary', 'HEAD'])) };
const prior = (await json('.tmp/android-keepass-project-317/build-evidence.json')).baseline;
const evidenceFiles = [...await tree('.tmp/keepass-project-atomic-edge-317-second'), ...await tree('.tmp/keepass-project-atomic-317'),
  ...(await readdir(path.join(root, raw))).filter(file => file.startsWith('keepass-project-atomic-317-') && file !== 'keepass-project-atomic-317-manifest.json').map(file => `${raw}/${file}`),
  `${raw}/clean-keepass-project-atomic-cache-317.ps1`];
const manifest = { at: new Date().toISOString(), status: 'keepass-project-sync-protection-passed', goalComplete: false,
  gitHead: git(root, ['rev-parse', 'HEAD']).toString().trim(), trackedDiffSha256: hash(git(root, ['diff', '--binary', 'HEAD'])),
  sources: await Promise.all(sources.map(record)), builtFiles: await Promise.all((await tree('dist')).map(record)),
  evidence: await Promise.all(evidenceFiles.map(record)),
  android: { baseline: android, unchangedSincePriorBatch: Object.entries(android).every(([key, value]) => prior[key] === value), runtimeTestedThisBatch: false, applicationRebuilt: false },
  validation: { unitFiles: 233, unitTests: 2422, focusedTests: 75, rebaseTests: 19, productionBuild: 'passed', bothTsProjects: 'passed',
    strictE2eTypes: 'passed', runtimeCommands: 195, actualEdgeScenarios: 1, edgeVersion: browser.version, conflictScreenshotInspected: true },
  cleanup: { bytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length, fourteenBatchLogicalBytes: 25601322256 + cleanup.removedLogicalBytes },
  limits: ['Known validation/conflict paths protected; arbitrary in-memory exception rollback not implemented',
    'Whole-project restore UI remains open', 'Synthetic KDBX peer; no Android runtime/Passkey signing/OneDrive acceptance this batch',
    'Native readback compares binary names, not attachment bytes', 'Overall Android parity remains incomplete'] };
await writeFile(path.join(root, raw, 'keepass-project-atomic-317-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sources: manifest.sources.length, artifacts: manifest.evidence.length,
  androidSourcesUnchanged: manifest.android.unchangedSincePriorBatch, cacheBytes: manifest.cleanup.bytes,
  protectedFiles: manifest.cleanup.protectedFiles, goalComplete: false }));
