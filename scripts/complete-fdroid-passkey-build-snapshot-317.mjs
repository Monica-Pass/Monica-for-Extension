import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const manifestFile = path.join(root, '.tmp/android-passkey-fixes-317/fdroid-build-source-manifest.json');
const bytes = await readFile(manifestFile), manifest = JSON.parse(bytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (manifest.nativeInputsAdded) throw new Error('Native snapshot already complete');
// Do not combine native sources with Java/Kotlin bindings from a different revision.
for (const row of manifest.records) {
  if (hash(await readFile(path.join(manifest.original, row.file))) !== row.sha256) throw new Error(`Live source changed: ${row.file}`);
}
const files = execFileSync('rg', ['--files', '--hidden', '--no-ignore', '-g', '!**/target/**', '-g', '!**/.git/**',
  'rust-core', 'rust-crypto', 'rust-jni', 'Mdbx-ffi'], { cwd: manifest.original, maxBuffer: 64e6 }).toString()
  .split(/\r?\n/).filter(Boolean).map(file => file.replaceAll('\\', '/')).sort();
for (const file of files) {
  const content = await readFile(path.join(manifest.original, file)), destination = path.join(manifest.sourceRoot, file);
  await mkdir(path.dirname(destination), {recursive: true}); await writeFile(destination, content);
  manifest.records.push({file, sha256: hash(content), bytes: content.length});
}
for (const row of manifest.records) {
  if (hash(await readFile(path.join(manifest.original, row.file))) !== row.sha256) throw new Error(`Source changed during capture: ${row.file}`);
}
await copyFile(manifestFile, manifestFile + '.before-native-inputs');
manifest.nativeInputsAdded = { at: new Date().toISOString(), files: files.length };
await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({nativeInputFiles: files.length, completeFiles: manifest.records.length}));
