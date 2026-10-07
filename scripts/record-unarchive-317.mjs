import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const raw = '.codex-tasks/android-interop-315/raw';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function record(file) {
  const bytes = await readFile(path.join(root, file));
  return { path: file.replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) };
}
async function tree(directory) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await tree(file));
    else if (entry.isFile()) result.push(file);
    else throw new Error(`Unexpected evidence type: ${file}`);
  }
  return result;
}
const testLog = await readFile(path.join(root, raw, 'unarchive-317-full-tests.log'), 'utf8');
if (!/227 passed/.test(testLog) || !/2346 passed/.test(testLog)) throw new Error('Missing full test acceptance');
const evidenceFiles = await tree('.tmp/unarchive-edge-317');
const results = evidenceFiles.filter(file => path.basename(file) === 'evidence.json');
if (results.length !== 2) throw new Error('Missing Edge evidence');
for (const file of results) {
  const result = JSON.parse(await readFile(path.join(root, file), 'utf8'));
  if (result.status !== 'passed' || !result.restart) throw new Error('Incomplete Edge acceptance');
}
const sources = ['src/security/secure-vault-service.ts', 'src/security/unarchive-item.test.ts',
  'src/security/hotp-usage.test.ts', 'src/providers/keepass/keepass-provider.ts', 'src/providers/keepass/keepass-provider.test.ts',
  'src/App.vue', 'src/runtime/messages.ts', 'src/runtime/client.ts', 'src/background/index.ts',
  'tests/e2e/archive-lifecycle.spec.ts', 'tests/e2e/fixtures/edge.ts', 'docs/archive-lifecycle-317.md',
  'docs/password-field-audit-316.md', 'scripts/record-unarchive-317.mjs'];
const logs = (await readdir(path.join(root, raw))).filter(name => name.startsWith('unarchive-317-') && name !== 'unarchive-317-manifest.json').map(name => path.join(raw, name));
const host = await record('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
if (host.sha256 !== '781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5') throw new Error('Native Host changed');
const manifest = {
  at: new Date().toISOString(), status: 'extension-archive-batch-passed', goalComplete: false,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  trackedDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })),
  sources: await Promise.all(sources.map(record)),
  builtFiles: await Promise.all((await tree('dist')).map(record)),
  evidence: await Promise.all([...logs, ...evidenceFiles].map(record)),
  nativeHost: host,
  validation: { fullTestFiles: 227, fullTests: 2346, focusedTests: 64, actualEdgeScenarios: 2,
    build: 'passed', strictE2eTypes: 'passed', runtimeCommands: 194, postBuildChanges: 'comment grammar and documentation only' },
  cacheInspection: { browserCacheBytes: 19766574, action: 'retain small cache until next substantial batch; no native rebuild' },
  limits: ['No Android runtime acceptance this batch', 'Fresh-client KDBX archive transfer remains unsupported by the current shared field contract',
    'Passkey checks concern availability and exact material retention, not a new RP signature', 'Earlier Android Passkey gaps and real OneDrive login dependency remain open']
};
await writeFile(path.join(root, raw, 'unarchive-317-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: manifest.status, sources: manifest.sources.length, builtFiles: manifest.builtFiles.length, evidenceFiles: manifest.evidence.length }, null, 2));
