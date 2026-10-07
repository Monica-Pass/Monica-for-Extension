import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..'), task = '.codex-tasks/android-interop-315';
const edge = '.tmp/complete-backup-edge-317-fourth/mdbx2-complete-backup-real-341f3-ments-and-original-Passkeys';
const result = JSON.parse(await readFile(path.join(root, edge, 'evidence.json'), 'utf8'));
if (result.status !== 'passed' || !result.nativeHost.restored || result.errors.length) throw new Error('Real Edge acceptance incomplete');
const fixture = path.relative(root, result.runRoot).replaceAll('\\', '/');
const independent = JSON.parse(await readFile(path.join(result.runRoot, 'independent-review.json'), 'utf8'));
if (independent.status !== 'passed' || independent.nativeObjectsExact !== 7 || !independent.originalRsaSignature) throw new Error('Independent review incomplete');
const cleanup = JSON.parse((await readFile(path.join(root, task, 'raw/complete-backup-edge-cache-cleanup.json'), 'utf8')).replace(/^\uFEFF/, ''));
if (cleanup.integrityFailures.length) throw new Error('Protected files changed');
const sourcePaths = [
  'src/components/Mdbx2SourceDialog.vue', 'src/App.vue', 'src/manager/mdbx-export-reader.ts', 'src/providers/mdbx2/local-file-export.ts',
  'src/providers/mdbx2/native-client.ts', 'src/providers/mdbx2/native-contract.ts', 'src/background/index.ts', 'src/runtime/messages.ts',
  'native/mdbx2-host/src/main.rs', 'native/mdbx2-host/src/runtime.rs', 'native/mdbx2-host/src/local_export.rs',
  'native/mdbx2-host/vendor/mdbx/crates/mdbx-ffi/src/sync_facade.rs', 'native/mdbx2-host/ENGINE-PROVENANCE.json',
  'native/mdbx2-host/runtime-patches/extension-complete-backup.patch', 'native/mdbx2-host/Cargo.lock',
  'tests/e2e/mdbx2-complete-backup-real.spec.ts', 'tests/e2e/fixtures/native-host.ts', 'tests/e2e/fixtures/edge.ts',
  'scripts/verify-complete-backup-edge-317.ts', 'scripts/complete-backup-layout-317-canvas.mjs', 'scripts/record-complete-backup-edge-317.mjs',
  'docs/mdbx-complete-backup-317.md', 'docs/mdbx-complete-backup-edge-317.md', 'docs/design/complete-backup-layout-317.md',
  'docs/design/complete-backup-layout-317.m3e.json', `${task}/TODO.csv`, `${task}/PROGRESS.md`, `${task}/raw/clean-complete-backup-edge-cache-317.ps1`,
];
const logs = ['complete-backup-edge-host-build.log', 'complete-backup-edge-host-provenance.log', 'complete-backup-edge-layout-build.log',
  'complete-backup-edge-types-final.log', 'complete-backup-verifier-types.log', 'complete-backup-edge-security-final.log',
  'complete-backup-edge-fourth.log', 'complete-backup-edge-independent-final.log', 'complete-backup-edge-cache-cleanup.json',
  'complete-backup-edge-cache-cleanup-retry.log', 'complete-backup-layout-canvas-final.log'];
const evidencePaths = logs.map(name => `${task}/raw/${name}`);
for (const directory of [edge, `${task}/raw/complete-backup-layout-canvas`]) for (const file of await readdir(path.join(root, directory), { recursive: true })) {
  if (/\.(json|png)$/.test(file) && !file.endsWith('-transition.png')) evidencePaths.push(`${directory}/${file.replaceAll('\\', '/')}`);
}
for (const name of ['complete.mdbx-backup.zip', 'embedded-passkeys.mdbx', 'expected-items.json', 'expected-native-objects.json', 'restored-rsa-assertion.json', 'independent-review.json', 'independent-native-readback.json']) evidencePaths.push(`${fixture}/${name}`);
const vaultDirectory = `${fixture}/restored/Monica Extension/MDBX2/vaults`;
for (const file of await readdir(path.join(root, vaultDirectory), { recursive: true, withFileTypes: true })) if (file.isFile()) {
  evidencePaths.push(path.relative(root, path.join(file.parentPath, file.name)).replaceAll('\\', '/'));
}
const artifacts = ['dist/background.js', 'native/mdbx2-host/target/debug/monica-mdbx2-host.exe',
  '.tmp/complete-backup-edge-317-prior-host/monica-mdbx2-host.exe',
  ...(await readdir(path.join(root, 'dist/assets'))).filter(name => /^(manager-|runtime-|client-).*\.(js|css)$/.test(name)).map(name => `dist/assets/${name}`)];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = paths => Promise.all([...new Set(paths)].map(async file => { const bytes = await readFile(path.join(root, file)); return { path: file, size: bytes.length, sha256: digest(bytes) }; }));
const manifest = {
  recordedAt: new Date().toISOString(), status: 'verified-edge-native-archive-roundtrip', goalComplete: false, androidProductSourcesChanged: false,
  git: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    trackedDiffSha256: digest(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 30 * 1024 * 1024 })) },
  acceptance: { realEdge: '154.0.4258.53', phases: result.phases, nativeMessagingRestored: true, independentReview: independent,
    productionBuild: true, strictTypes: true, securityRuntimeCommands: 192, nativeProvenance: true,
    androidSafAcceptance: false, crashCleanup: false, fullSuiteRepeated: false, releasePackaging: false },
  cacheCleanup: { removedLogicalBytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length, integrityFailures: 0 },
  sources: await hashes(sourcePaths), artifacts: await hashes(artifacts), evidence: await hashes(evidencePaths),
};
await writeFile(path.join(root, task, 'raw/complete-backup-edge-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Recorded ${manifest.sources.length} sources, ${manifest.artifacts.length} artifacts, ${manifest.evidence.length} evidence files. Android acceptance remains pending.`);
