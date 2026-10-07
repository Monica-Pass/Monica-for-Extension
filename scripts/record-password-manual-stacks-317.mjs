import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const task = '.codex-tasks/android-interop-315';
const edge = '.tmp/password-manual-stacks-edge-317-final';
const run = JSON.parse(await readFile(path.join(root, edge, '.last-run.json'), 'utf8'));
if (run.status !== 'passed' || run.failedTests.length) throw new Error('Final Edge acceptance did not pass');
const cleanup = JSON.parse((await readFile(path.join(root, task, 'raw/password-manual-stacks-cache-cleanup.json'), 'utf8')).replace(/^\uFEFF/, ''));
if (cleanup.integrityFailures.length) throw new Error('Cache cleanup integrity failure');
const sources = [
  'src/core/password-manual-stacks.ts', 'src/core/password-manual-stacks.test.ts', 'src/core/password-display-stacks.ts',
  'src/core/password-display-stacks.test.ts', 'src/core/credential-fields.ts', 'src/core/home-preferences.ts',
  'src/security/secure-vault-service.ts', 'src/security/password-manual-stacks.test.ts', 'src/security/password-cover.test.ts',
  'src/providers/password-manual-stack-roundtrip.test.ts', 'src/runtime/messages.ts', 'src/runtime/client.ts',
  'src/background/index.ts', 'src/App.vue', 'src/components/PasswordStackDialog.vue', 'src/components/PasswordStackList.vue',
  'src/manager.css', 'src/i18n/ui-en.json', ...['de', 'es', 'ja', 'ko', 'ru', 'vi'].map(locale => `public/locales/ui-${locale}.json`),
  'tests/e2e/password-display-stacks.spec.ts', 'tests/e2e/password-manual-stacks.spec.ts',
  'docs/password-display-stacks-317.md', 'docs/password-manual-stacks-317.md',
  'docs/design/password-manual-stacks-317.md', 'docs/design/password-manual-stacks-317.m3e.json',
  'scripts/password-manual-stacks-317-canvas.mjs', 'scripts/record-password-manual-stacks-317.mjs',
  `${task}/raw/clean-password-stack-browser-caches-20261006.ps1`, `${task}/TODO.csv`, `${task}/PROGRESS.md`,
];
const logs = ['password-manual-stacks-regression.log', 'password-manual-stacks-full-tests.log',
  'password-manual-stacks-i18n-final.log', 'password-manual-stacks-build-final.log', 'password-manual-stacks-security-final.log',
  'password-manual-stacks-edge-types.log', 'password-manual-stacks-edge-final.log',
  'password-manual-stacks-cache-inventory.json', 'password-manual-stacks-cache-cleanup.json', 'password-manual-stacks-cache-cleanup-complete.log'];
const evidence = logs.map(file => `${task}/raw/${file}`);
for (const directory of [edge, `${task}/raw/password-manual-stacks-canvas`]) {
  for (const file of await readdir(path.join(root, directory), { recursive: true })) {
    if (/\.(png|json)$/.test(file)) evidence.push(`${directory}/${file.replaceAll('\\', '/')}`);
  }
}
const built = ['dist/background.js', ...(await readdir(path.join(root, 'dist/assets'))).filter(file => /^(manager-|runtime-|client-).*\.(js|css)$/.test(file)).map(file => `dist/assets/${file}`)];
const digest = value => createHash('sha256').update(value).digest('hex');
const hashes = files => Promise.all(files.map(async file => {
  const bytes = await readFile(path.join(root, file)); return { path: file, size: bytes.length, sha256: digest(bytes) };
}));
const manifest = {
  recordedAt: new Date().toISOString(), scope: 'manual password display stacks, all-member atomic metadata changes and browser cache cleanup',
  goalComplete: false, androidProductSourcesChanged: false,
  git: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), trackedDiffSha256: digest(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 30 * 1024 * 1024 })) },
  acceptance: { focused: { files: 5, tests: 37, passed: true },
    consolidatedSuite: { files: 225, tests: 2311, passedTests: 2310, initialFailures: 1, failedFile: 'src/i18n/runtime.test.ts', reason: 'two missing translation keys',
      repairedFileRerun: { tests: 28, passed: true }, fullSuiteRerunAfterCatalogRepair: false },
    build: true, strictE2eTypes: true, securityAuditRuntimeCommands: 192, realEdgeScenarios: 2,
    widths: [1180, 420, 320], browserRestart: true, androidApplicationManualStackRoundtrip: false, liveCloudManualStackRoundtrip: false },
  cleanup: { removedLogicalBytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length, integrityFailures: 0 },
  sources: await hashes(sources), built: await hashes(built), evidence: await hashes(evidence),
};
await writeFile(path.join(root, task, 'raw/password-manual-stacks-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Recorded ${manifest.sources.length} source files, ${manifest.built.length} build artifacts and ${manifest.evidence.length} evidence files. Goal remains active.`);
