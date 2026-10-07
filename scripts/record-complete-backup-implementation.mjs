import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const paths = [
  'native/mdbx2-host/Cargo.toml', 'native/mdbx2-host/Cargo.lock', 'native/mdbx2-host/ENGINE-PROVENANCE.json',
  'native/mdbx2-host/src/main.rs', 'native/mdbx2-host/src/runtime.rs', 'native/mdbx2-host/src/cloud_sync.rs',
  'native/mdbx2-host/src/local_export.rs', 'native/mdbx2-host/src/interop315_tests.rs',
  'native/mdbx2-host/vendor/mdbx/crates/mdbx-ffi/src/sync_facade.rs',
  'native/mdbx2-host/runtime-patches/extension-complete-backup.patch',
  'src/providers/mdbx2/native-client.ts', 'src/providers/mdbx2/native-client.test.ts', 'src/providers/mdbx2/native-contract.ts',
  'src/providers/mdbx2/local-file-export.ts', 'src/providers/mdbx2/local-file-export.test.ts',
  'src/manager/mdbx-export-reader.ts', 'src/manager/mdbx-export-reader.test.ts',
  'src/App.vue', 'src/components/Mdbx2SourceDialog.vue', 'src/i18n/ui-en.json',
  ...['ja','ko','de','es','ru','vi'].map(locale => `public/locales/ui-${locale}.json`),
  'docs/mdbx-complete-backup-317.md', 'docs/design/complete-backup-317.m3e.json', 'docs/design/complete-backup-317.md',
  'scripts/complete-backup-317-canvas.mjs', 'scripts/record-complete-backup-overlay.mjs', 'scripts/sync-ui-catalog-keys.mjs',
  '.codex-tasks/android-interop-315/raw/complete-backup-ts-tests.log',
  '.codex-tasks/android-interop-315/raw/complete-backup-build-final.log',
  '.codex-tasks/android-interop-315/raw/complete-backup-security-final.log',
  ...['render.json','backup317.png','restore317.png'].map(name => `.codex-tasks/android-interop-315/raw/complete-backup-canvas/${name}`),
];
const files = {};
for (const path of paths) {
  const bytes = await readFile(resolve(root, path));
  files[path] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const manifest = { status: 'implementation-batch-verified-native-and-focused-tests', recordedAt: new Date().toISOString(),
  validation: { nativeTests: { command: 'cargo test --manifest-path native/mdbx2-host/Cargo.toml -j 2 complete_backup -- --nocapture', passed: 3, toolSession: 43501 }, typescript: { files: 3, tests: 62 }, typecheck: 'passed', build: 'passed', securityCommands: 190 },
  exclusions: ['real Edge extension acceptance', 'Android SAF archive restore', 'cloud roundtrip acceptance of this new archive', 'full regression', 'native release packaging', 'crash scavenging', 'restore317-failure.png'], files };
await writeFile(resolve(root, '.codex-tasks/android-interop-315/raw/complete-backup-implementation-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Recorded ${paths.length} files; no historical manifest changed.`);
