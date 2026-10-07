import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..'), raw = '.codex-tasks/android-interop-315/raw';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(path.resolve(root, file), 'utf8'));
async function record(file) {
  const bytes = await readFile(path.resolve(root, file));
  return { path: file.replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) };
}
async function tree(dir) {
  const files = [];
  for (const entry of await readdir(path.resolve(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await tree(file)); else if (entry.isFile()) files.push(file); else throw new Error('Unexpected evidence entry');
  }
  return files;
}
const unit = await readFile(path.resolve(root, raw, 'custom-autofill-controls-317-full.log'), 'utf8');
assert.match(unit, /231 passed/); assert.match(unit, /2381 passed/);
const edge = await readFile(path.resolve(root, raw, 'custom-autofill-controls-317-edge-final.log'), 'utf8');
assert.match(edge, /26 passed/); assert.doesNotMatch(edge, /\d+ failed/);
const accepted = await tree('.tmp/custom-autofill-controls-317-final');
const proofs = accepted.filter(file => path.basename(file) === 'evidence.json' && path.basename(path.dirname(file)).startsWith('custom-autofill-controls-'));
assert.equal(proofs.length, 3);
for (const file of proofs) assert.equal((await json(file)).passed, true);
const typed = await json(proofs.find(file => file.includes('be81d')));
assert.equal(typed.restart, true);
const cleanup = await json(`${raw}/custom-autofill-controls-317-cache-cleanup.json`);
assert.deepEqual(cleanup.integrityFailures, []);
const sources = ['src/autofill/custom-fields.ts', 'src/content/login-field-role.ts', 'src/content/dom.ts', 'src/background/index.ts',
  'src/content/custom-autofill-controls.test.ts', 'tests/e2e/custom-autofill-controls.spec.ts', 'tests/e2e/fixtures/edge.ts',
  'docs/custom-autofill-controls-317.md', 'docs/passkey-autofill-usability-317.md', 'scripts/record-custom-autofill-controls-317.mjs'];
const logs = (await readdir(path.resolve(root, raw))).filter(name => name.startsWith('custom-autofill-controls-317-') && name !== 'custom-autofill-controls-317-manifest.json').map(name => path.join(raw, name));
const host = await record('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
assert.equal(host.sha256, '781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5');
const androidOptions = { cwd: path.resolve(root, '../Monica-main'), maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
const previous = await json(`${raw}/password-history-live-317-manifest.json`);
const androidDiff = hash(execFileSync('git', ['diff', '--binary', 'HEAD'], androidOptions));
const manifest = { at: new Date().toISOString(), goalComplete: false, status: 'typed-custom-controls-and-partial-HOTP-fill-passed',
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  trackedDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })),
  sources: await Promise.all(sources.map(record)), builtFiles: await Promise.all((await tree('dist')).map(record)),
  evidence: await Promise.all([...accepted, ...await tree('.tmp/custom-autofill-controls-317-red'), ...logs, `${raw}/clean-custom-autofill-cache-317.ps1`].map(record)),
  validation: { unitFiles: 231, unitTests: 2381, focusedTests: 68, edgeScenarios: 26, newEdgeScenarios: 3, edgeVersion: '154.0.4258.53',
    build: 'passed', strictE2eTypes: 'passed', runtimeCommands: 195, screenshotInspected: true },
  nativeHost: host, android: { noDeviceOrBuildAction: true, diffSha256: androidDiff, sameTrackedDiffAsPriorBatch: androidDiff === previous.androidProvenance.build.diffSha256 },
  cleanup: { bytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length },
  limits: ['No Android runtime or backend custom-field acceptance in this batch', 'No arbitrary website-framework compatibility claim', 'Passkey/OneDrive/native history gaps remain'] };
await writeFile(path.resolve(root, raw, 'custom-autofill-controls-317-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sources: manifest.sources.length, evidence: manifest.evidence.length, cacheBytes: manifest.cleanup.bytes }));
