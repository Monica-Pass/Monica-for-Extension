import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'tests/interop/android-cm-rp');
const output = process.env.MONICA_CM_EVIDENCE_DIR ? join(resolve(process.env.MONICA_CM_EVIDENCE_DIR), 'rp-build')
  : join(root, process.env.MONICA_CM_BACKENDS === '1' ? '.tmp/android-cm-backends-317/rp-build' : '.tmp/android-credential-manager-317/rp-build');
const java = process.env.JAVA_HOME || 'C:/jdk-17.0.1';
const sdk = 'D:/AndroidSDK';
const buildTools = join(sdk, 'build-tools/35.0.0');
const api = join(sdk, 'platforms/android-35/android.jar');
for (const dir of [output, join(output, 'classes'), join(output, 'dex')]) await mkdir(dir, { recursive: true });
const log = [];
function run(file, args) {
  const result = spawnSync(file, args, { cwd: output, windowsHide: true, shell: file.endsWith('.bat'), encoding: 'utf8', maxBuffer: 8e6 });
  log.push({ file, args, status: result.status, stdout: result.stdout, stderr: result.stderr });
  if (result.status !== 0) throw new Error(`${file} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  run(join(java, 'bin/javac.exe'), ['-J-Xmx256m', '-source', '8', '-target', '8', '-classpath', api, '-d', join(output, 'classes'), join(source, 'MainActivity.java')]);
  run(join(java, 'bin/jar.exe'), ['cf', 'classes.jar', '-C', 'classes', '.']);
  run(join(buildTools, 'd8.bat'), ['--lib', api, '--min-api', '34', '--output', 'dex', 'classes.jar']);
  run(join(buildTools, 'aapt2.exe'), ['link', '-I', api, '--manifest', join(source, 'AndroidManifest.xml'), '-o', 'unsigned.apk']);
  run(join(java, 'bin/jar.exe'), ['uf', 'unsigned.apk', '-C', 'dex', 'classes.dex']);
  run(join(buildTools, 'zipalign.exe'), ['-f', '4', 'unsigned.apk', 'aligned.apk']);
  const keystore = join(output, 'synthetic-rp.jks');
  try { await readFile(keystore); } catch {
    run(join(java, 'bin/keytool.exe'), ['-J-Xmx128m', '-genkeypair', '-keystore', keystore, '-storepass', 'synthetic317', '-keypass', 'synthetic317',
      '-alias', 'synthetic-rp', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '30', '-dname', 'CN=Monica Synthetic CM RP']);
  }
  run(join(buildTools, 'apksigner.bat'), ['sign', '--ks', keystore, '--ks-key-alias', 'synthetic-rp', '--ks-pass', 'pass:synthetic317', '--out', 'rp.apk', 'aligned.apk']);
  run(join(buildTools, 'apksigner.bat'), ['verify', '--verbose', 'rp.apk']);
  run(join(java, 'bin/keytool.exe'), ['-J-Xmx128m', '-exportcert', '-keystore', keystore, '-storepass', 'synthetic317', '-alias', 'synthetic-rp', '-file', 'rp-cert.der']);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const evidence = { status: 'passed', apk: join(output, 'rp.apk'), apkSha256: hash(await readFile(join(output, 'rp.apk'))),
    expectedOrigin: `android:apk-key-hash:${createHash('sha256').update(await readFile(join(output, 'rp-cert.der'))).digest('base64url')}`,
    sourceHashes: Object.fromEntries(await Promise.all(['MainActivity.java', 'AndroidManifest.xml'].map(async name => [name, hash(await readFile(join(source, name)))]))) };
  await writeFile(join(output, 'build-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await writeFile(join(output, 'build-log.json'), JSON.stringify(log, null, 2)); }
