import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..'), workspace = resolve(root, '..');
const project = join(workspace, 'Monica-main/Monica for Android');
const output = resolve(process.env.MONICA_CM_EVIDENCE_DIR || join(root, '.tmp/android-current-system-final-318'));
const build = join(output, 'build');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (file, value) => writeFile(join(output, file), JSON.stringify(value, null, 2) + '\n');
async function verify(files) {
  for (const [file, sha] of Object.entries(files)) assert.equal(hash(await readFile(file)), sha, `Changed: ${file}`);
}
await mkdir(output, { recursive: true });
if (process.argv[2] === 'capture') {
  try { await readFile(join(output, 'baseline.json')); throw new Error('Baseline already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const repairReportPath = join(workspace, '.codex-tasks/passkey-fix-20261010/verification.json');
  const filterReportPath = join(workspace, '.codex-tasks/passkey-filter-20261010/verification.json');
  const repair = (await json(repairReportPath)).main;
  const filter = (await json(filterReportPath)).main;
  assert.equal(filter.unit.tests, 52); assert.equal(filter.deviceTests, 9);
  const changedSinceRepair = [];
  for (const [relative, sha] of Object.entries(repair.sourceSHA256)) {
    const current = hash(await readFile(join(project, 'app/src', relative)));
    if (current !== sha) changedSinceRepair.push(relative);
  }
  assert.deepEqual(changedSinceRepair.sort(), [
    'main/java/takagi/ru/monica/ui/screens/PasskeyListScreen.kt',
  ].sort(), 'Review newer production changes before accepting this build');
  const sourceHashes = {};
  const names = execFileSync('rg', ['--files', 'app/src/main', '-g', '!*.so'], { cwd: project, windowsHide: true, encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const name of [...names, 'app/build.gradle', 'build.gradle', 'gradle.properties', 'settings.gradle']) {
    const file = join(project, name); sourceHashes[file] = hash(await readFile(file));
  }
  const metadata = await json(join(project, 'app/build/outputs/apk/debug/output-metadata.json'));
  const element = metadata.elements.find(row => row.filters.some(filter => filter.value === 'x86_64'));
  assert.equal(element.versionName, '1.0.318-26101012-05');
  const app = join(project, 'app/build/outputs/apk/debug', element.outputFile);
  const compileApi = join(project, 'app/build/intermediates/compile_app_classes_jar/debug/bundleDebugClassesToCompileJar/classes.jar');
  const evidenceFiles = {};
  for (const file of [repairReportPath, filterReportPath,
    join(workspace, '.codex-tasks/passkey-filter-20261010/main-build.log'),
    join(workspace, '.codex-tasks/passkey-filter-20261010/main-fixture-build.log')]) {
    const bytes = await readFile(file);
    if (file.endsWith('.log')) assert.match(bytes.toString(), /BUILD SUCCESSFUL/);
    evidenceFiles[file] = hash(bytes);
  }
  const testSources = {};
  const sourceDir = join(output, 'sources/takagi/ru/monica/credentialexchange');
  await mkdir(sourceDir, { recursive: true });
  for (const file of [join(project, 'app/src/androidTest/java/takagi/ru/monica/credentialexchange/TransferFixture.kt'),
    join(root, 'tests/interop/android-app/src/takagi/ru/monica/credentialexchange/ExtensionSystemCredentialInteropTest.kt')]) {
    const bytes = await readFile(file); testSources[file] = hash(bytes);
    await writeFile(join(sourceDir, file.split(/[\\/]/).at(-1)), bytes);
  }
  await save('baseline.json', { at: new Date().toISOString(), sourceHashes, testSources, evidenceFiles, changedSinceRepair,
    app, appSha256: hash(await readFile(app)), versionName: element.versionName,
    compileApi, compileApiSha256: hash(await readFile(compileApi)),
    provenance: 'Reuse current ordinary build output and compile API after the recorded filter build; capture current production source hashes before/after test compilation. No application rebuild in this harness.' });
  console.log(`Captured ${names.length} source files and current ${element.versionName} application.`);
} else if (process.argv[2] === 'build') {
  const baseline = await json(join(output, 'baseline.json'));
  await verify(baseline.sourceHashes); await verify(baseline.testSources); await verify(baseline.evidenceFiles);
  assert.equal(hash(await readFile(baseline.app)), baseline.appSha256);
  assert.equal(hash(await readFile(baseline.compileApi)), baseline.compileApiSha256);
  const classes = join(build, 'app/intermediates/compile_app_classes_jar/debug/bundleDebugClassesToCompileJar/classes.jar');
  await mkdir(resolve(classes, '..'), { recursive: true }); await copyFile(baseline.compileApi, classes);
  const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME || 'C:/jdk-17.0.1', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME || 'D:/GradleRepository',
    MONICA_APP_INTEROP_BUILD_DIR: build, MONICA_APP_INTEROP_SOURCE_DIR: join(output, 'sources'),
    MONICA_APP_INTEROP_REPLACE_TEST_SOURCES: '1', MONICA_APP_INTEROP_REUSE_VERIFIED_APPLICATION: '1',
    MONICA_APP_INTEROP_TEST_MANIFEST: join(root, 'tests/interop/android-app/passkey-signatures-AndroidManifest.xml') };
  await new Promise((done, fail) => {
    const child = spawn('gradlew.bat', ['--init-script', `"${join(root, 'tests/interop/android-app/interop.init.gradle')}"`,
      ':app:assembleDebugAndroidTest', '-PincludeX86TestAbi', '--max-workers=2', '--console=plain'],
    { cwd: project, env, windowsHide: true, shell: true, stdio: 'inherit' });
    child.on('error', fail); child.on('exit', code => code === 0 ? done() : fail(new Error(`Gradle exited ${code}`)));
  });
  await verify(baseline.sourceHashes); await verify(baseline.testSources); await verify(baseline.evidenceFiles);
  assert.equal(hash(await readFile(classes)), baseline.compileApiSha256);
  assert.equal(hash(await readFile(baseline.app)), baseline.appSha256);
  const apk = join(output, 'targeted-test.apk');
  await copyFile(join(build, 'app/outputs/apk/androidTest/debug/app-debug-androidTest.apk'), apk);
  await save('build-evidence.json', { at: new Date().toISOString(), status: 'passed', androidSourcesUnchanged: true,
    builtAppApk: baseline.app, builtAppApkSha256: baseline.appSha256, builtTestApk: apk, builtTestApkSha256: hash(await readFile(apk)),
    androidApplicationRebuilt: false, compileApiSha256: baseline.compileApiSha256, baseline: 'baseline.json' });
  console.log('Current system-seed instrumentation verified. Application sources and APK unchanged.');
} else throw new Error('Use capture or build');
