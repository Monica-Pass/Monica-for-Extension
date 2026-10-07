import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), raw = '.codex-tasks/android-interop-315/raw';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function record(file) { const bytes = await readFile(path.resolve(root, file)); return { path: file.replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) }; }
async function tree(dir) {
  const files = [];
  for (const entry of await readdir(path.resolve(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await tree(file)); else if (entry.isFile()) files.push(file); else throw new Error('Unexpected evidence entry');
  }
  return files;
}
const log = await readFile(path.join(root, raw, 'password-history-317-full-final.log'), 'utf8');
if (!log.includes('230 passed') || !log.includes('2362 passed')) throw new Error('Full regression evidence missing');
const evidence = await tree('.tmp/password-history-edge-317-accepted');
const results = evidence.filter(file => path.basename(file) === 'evidence.json');
if (results.length !== 2) throw new Error('Two Edge scenarios required');
for (const file of results) { const result = JSON.parse(await readFile(path.resolve(root, file), 'utf8')); if (!result.passed || !result.restart) throw new Error('Edge acceptance incomplete'); }
const sources = ['src/core/model.ts', 'src/core/password-history.ts', 'src/security/secure-vault-service.ts', 'src/security/password-history.test.ts',
  'src/providers/webdav/android-backup-codec.ts', 'src/providers/webdav/android-backup-codec.test.ts', 'src/providers/webdav/password-history.test.ts',
  'src/providers/bitwarden/bitwarden-cipher-codec.ts', 'src/providers/bitwarden/bitwarden-password-history.test.ts',
  'src/providers/mdbx2/mdbx2-provider.ts', 'src/providers/mdbx2/mdbx2-provider.test.ts', 'src/providers/mdbx2/mdbx2-item-codec.ts',
  'src/providers/keepass/keepass-provider.ts', 'src/providers/keepass/keepass-login-codec.ts',
  'src/components/PasswordHistoryDetail.vue', 'src/components/VaultItemDetail.vue', 'src/App.vue', 'src/background/index.ts', 'src/runtime/messages.ts', 'src/runtime/client.ts',
  'src/i18n/ui-en.json', ...['ja','ko','de','es','ru','vi'].map(locale => `public/locales/ui-${locale}.json`),
  'tests/e2e/password-history.spec.ts', 'tests/e2e/fixtures/edge.ts', 'docs/password-history-317.md', 'docs/password-field-audit-316.md',
  'docs/design/password-history-317.md', 'docs/design/password-history-317.m3e.json', 'scripts/password-history-317-canvas.mjs', 'scripts/record-password-history-317.mjs'];
const androidRoot = '../Monica-main/Monica for Android/app/src/main/java/takagi/ru/monica/';
const androidSources = ['viewmodel/PasswordViewModel.kt', 'data/PasswordHistoryDao.kt', 'data/PasswordHistoryEntry.kt', 'utils/WebDavHelper.kt', 'utils/BackupRestoreApplier.kt'].map(file => androidRoot + file);
const host = await record('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
if (host.sha256 !== '781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5') throw new Error('Accepted Native Host changed');
const logs = (await readdir(path.resolve(root, raw))).filter(name => name.startsWith('password-history-317-') && name !== 'password-history-317-manifest.json').map(name => path.join(raw, name));
const manifest = { at: new Date().toISOString(), goalComplete: false, status: 'extension-history-batch-passed',
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  trackedDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore','pipe','pipe'] })),
  sources: await Promise.all(sources.map(record)), builtFiles: await Promise.all((await tree('dist')).map(record)),
  evidence: await Promise.all([...evidence, ...logs, ...await tree(`${raw}/password-history-canvas`)].map(record)),
  androidSourceOnly: await Promise.all(androidSources.map(record)), nativeHost: host,
  validation: { fullTestFiles: 230, fullTests: 2362, edgeScenarios: 2, edgeVersion: '154.0.4258.53', build: 'passed', strictE2eTypes: 'passed', runtimeCommands: 195 },
  limits: ['No Android runtime or live WebDAV/Bitwarden history acceptance', 'KDBX/MDBX password histories are local overlays, not fresh-client wire transfer', 'Previous Android Passkey and OneDrive acceptance gaps remain'] };
await writeFile(path.resolve(root, raw, 'password-history-317-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sources: manifest.sources.length, builtFiles: manifest.builtFiles.length, evidenceFiles: manifest.evidence.length }));
