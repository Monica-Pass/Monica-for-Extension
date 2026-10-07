import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tests = ['PasskeyCredentialIdCodecTest.kt', 'PasskeyGetRequestPolicyTest.kt', 'PasskeyCredentialDiscoveryPolicyTest.kt',
  'PasskeyRemarkAndNavigationGuardTest.kt', 'PasskeyUserVerificationGuardTest.kt', 'PasskeyNotesCodecTest.kt', 'PasskeyMapperInteropTest.kt'];
const fdroidV2 = process.argv.includes('--fdroid-v2');
for (const [label, variant] of (fdroidV2 ? [['fdroid', 'fdroid']] : [['main', 'Monica for Android'], ['fdroid', 'fdroid']])) {
  const original = path.join(root, 'Monica-main', variant);
  const sourceRoot = label === 'main'
    ? path.join(root, 'Monica-main/.codex-tmp/passkey-request-fixes-317', label)
    : path.join(original, `.codex-tmp/passkey-request-fixes-317-source${fdroidV2 ? '-v2' : ''}`);
  try { await stat(sourceRoot); throw new Error('Snapshot exists; preserve it'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const select = name => /^(build.gradle|settings.gradle|gradle.properties|gradlew(?:.bat)?|local.properties)$/.test(name) ||
    /^gradle\//.test(name) || /^(app|mdbx-engine|baselineprofile)\/[^/]+\.(gradle|pro|xml|kts)$/.test(name) ||
    /^(app|mdbx-engine|baselineprofile)\/src\/(main|debug)\//.test(name) || /^app\/(libs|schemas)\//.test(name) ||
    (name.startsWith('app/src/test/') && tests.includes(path.basename(name))) ||
    name === 'app/src/androidTest/java/takagi/ru/monica/credentialexchange/TransferFixture.kt' ||
    /^(rust-core|rust-crypto|rust-jni|Mdbx-ffi)\//.test(name);
  const list = () => execFileSync('rg', ['--files', '--hidden', '--no-ignore', '-g', '!.git/**', '-g', '!**/.git/**', '-g', '!**/target/**', '-g', '!build/**', '-g', '!**/build/**', '-g', '!.gradle/**'],
    { cwd: original, maxBuffer: 64e6 }).toString().split(/\r?\n/).map(file => file.replaceAll('\\', '/')).filter(select).sort();
  const files = list(), records = [];
  for (const file of files) {
    const bytes = await readFile(path.join(original, file));
    const target = path.join(sourceRoot, file);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    records.push({ file, sha256: hash(bytes), bytes: bytes.length });
  }
  if (JSON.stringify(files) !== JSON.stringify(list())) throw new Error('Source file inventory changed during snapshot');
  for (const row of records) if (hash(await readFile(path.join(original, row.file))) !== row.sha256) throw new Error(`Source changed during snapshot: ${row.file}`);
  await writeFile(path.join(sourceRoot, '.gitignore'), '*\n');
  const manifest = { createdAt: new Date().toISOString(), label, original, sourceRoot,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: original }).toString().trim(), records };
  const destination = path.join(root, 'monica-extension/.tmp/android-passkey-fixes-317', `${label}${fdroidV2 ? '-v2' : ''}-build-source-manifest.json`);
  await writeFile(destination, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ label, sourceRoot, files: files.length, bytes: records.reduce((a, b) => a + b.bytes, 0), manifest: destination }));
}
