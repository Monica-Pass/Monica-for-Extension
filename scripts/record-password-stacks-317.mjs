import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const task = '.codex-tasks/android-interop-315';
const edge = '.tmp/password-stacks-edge-317-complete';
const run = JSON.parse(await readFile(path.join(root, edge, '.last-run.json'), 'utf8'));
if (run.status !== 'passed' || run.failedTests.length) throw new Error('Edge acceptance did not pass');
const sources = [
  'src/core/model.ts', 'src/core/password-cover.ts', 'src/core/password-display-stacks.ts', 'src/core/password-display-stacks.test.ts',
  'src/core/home-preferences.ts', 'src/manager/import-items.ts', 'src/providers/webdav/android-backup-codec.ts',
  'src/providers/mdbx2/mdbx2-item-codec.ts', 'src/providers/keepass/keepass-login-codec.ts', 'src/providers/keepass/keepass-vault.ts',
  'src/providers/bitwarden/bitwarden-cipher-codec.ts', 'src/providers/password-cover-roundtrip.test.ts',
  'src/security/secure-vault-service.ts', 'src/security/password-cover.test.ts', 'src/runtime/messages.ts', 'src/runtime/client.ts',
  'src/background/index.ts', 'src/App.vue', 'src/components/PasswordStackList.vue', 'src/manager.css', 'src/i18n/ui-en.json',
  ...['de', 'es', 'ja', 'ko', 'ru', 'vi'].map(locale => `public/locales/ui-${locale}.json`),
  'public/fonts/monica-symbols.woff2', 'scripts/icon-font-inventory.json', 'tests/e2e/password-display-stacks.spec.ts',
  'docs/password-display-stacks-317.md', 'docs/design/password-stacks-317.md', 'docs/design/password-stacks-317.m3e.json',
  'scripts/password-stacks-317-canvas.mjs', 'scripts/record-password-stacks-317.mjs'
];
const logs = ['password-cover-regression.log', 'password-stacks-regression.log', 'password-stacks-build-final.log',
  'password-stacks-security-final.log', 'password-stacks-edge-complete.log', 'password-stacks-edge-types-final.log'];
const evidence = logs.map(file => `${task}/raw/${file}`);
for (const file of await readdir(path.join(root, edge), { recursive: true })) if (/\.(png|json)$/.test(file)) evidence.push(`${edge}/${file.replaceAll('\\', '/')}`);
for (const file of await readdir(path.join(root, `${task}/raw/password-stacks-canvas`))) evidence.push(`${task}/raw/password-stacks-canvas/${file}`);
const built = ['dist/background.js', ...(await readdir(path.join(root, 'dist/assets'))).filter(file => /^(manager-|runtime-|client-).*\.(js|css)$/.test(file)).map(file => `dist/assets/${file}`)];
const hashes = async files => Promise.all(files.map(async file => {
  const bytes = await readFile(path.join(root, file));
  return { path: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const manifest = {
  recordedAt: new Date().toISOString(), scope: 'password display stacks, atomic local cover selection, lossless format transport',
  goalComplete: false, androidProductSourcesChanged: false,
  acceptance: { formatRegression: { files: 13, tests: 317 }, focusedRegression: { files: 5, tests: 60, overlapsFormatRegression: true },
    build: true, securityAuditRuntimeCommands: 191, realEdgeExtension: true, widths: [1180, 420, 320], browserRestart: true,
    androidApplicationCoverRoundtrip: false, cloudCoverRoundtrip: false, fullSuiteRerun: false },
  sources: await hashes(sources), built: await hashes(built), evidence: await hashes(evidence)
};
await writeFile(path.join(root, `${task}/raw/password-stacks-manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Recorded ${manifest.sources.length} source files, ${manifest.built.length} build artifacts and ${manifest.evidence.length} evidence files. Goal remains active.`);
