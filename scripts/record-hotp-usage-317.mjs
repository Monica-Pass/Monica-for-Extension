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
    else throw new Error(`Unexpected non-file evidence: ${file}`);
  }
  return result;
}
const sources = ['src/core/login-otp.ts', 'src/core/login-otp.test.ts', 'src/core/otp-counter.ts',
  'src/core/password-groups.ts', 'src/core/project-credentials.ts', 'src/security/secure-vault-service.ts',
  'src/security/hotp-usage.test.ts', 'src/security/locked-autofill.test.ts', 'src/components/TotpCodeCell.vue',
  'src/App.vue', 'src/background/index.ts', 'src/runtime/messages.ts', 'src/runtime/client.ts',
  'tests/e2e/login-otp-detail.spec.ts', 'tests/e2e/inline-autofill.spec.ts', 'tests/e2e/fixtures/edge.ts',
  'tests/e2e/fixtures/project-logins.ts', 'docs/hotp-usage-consistency-317.md', 'scripts/record-hotp-usage-317.mjs'];
const logs = (await readdir(path.join(root, raw))).filter(name => /^(hotp-usage-|hotp-cache-|clean-hotp-cache-)/.test(name)
  && name !== 'hotp-usage-manifest.json').map(name => path.join(raw, name));
const host = await record('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
if (host.sha256 !== '781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5') throw new Error('Accepted Native Host changed');
const cleanup = JSON.parse(await readFile(path.join(root, raw, 'hotp-cache-cleanup.json'), 'utf8'));
if (cleanup.integrityFailures.length) throw new Error('Cache cleanup integrity failure');
const manifest = {
  at: new Date().toISOString(), status: 'extension-hotp-batch-passed', goalComplete: false,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  trackedDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { cwd: root, maxBuffer: 32 * 1024 * 1024 })),
  sources: await Promise.all(sources.map(record)),
  builtFiles: await Promise.all((await tree('dist')).map(record)),
  evidence: await Promise.all([...logs, ...await tree('.tmp/hotp-usage-edge-317'), ...await tree('.tmp/hotp-usage-edge-317-restart')].map(record)),
  nativeHost: host,
  validation: { fullTestFiles: 226, fullTests: 2333, focusedTests: 52, edgeInitialScenarios: 5, edgeExtendedRestartScenarios: 1,
    build: 'passed', strictE2eTypes: 'passed', securityRuntimeCommands: 193 },
  cleanup: { logicalBytes: cleanup.removedLogicalBytes, protectedFiles: cleanup.protectedFiles.length, integrityFailures: 0 },
  limits: ['No Android or live cloud HOTP acceptance', 'No global unique HOTP issuance across windows/devices',
    'Earlier Android Passkey and complete-backup SAF gaps remain open', 'Actual OneDrive SPA registration and sign-in remain pending']
};
await writeFile(path.join(root, raw, 'hotp-usage-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: manifest.status, sources: manifest.sources.length, builtFiles: manifest.builtFiles.length,
  evidenceFiles: manifest.evidence.length, cleanup: manifest.cleanup }, null, 2));
