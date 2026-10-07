import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(process.env.MONICA_ANDROID_REPOSITORY || join(root, '..', 'Monica-main'));
const project = resolve(process.env.MONICA_ANDROID_PROJECT || join(repository, 'Monica for Android'));
const evidence = resolve(process.env.MONICA_315_APP_FIXTURE || join(root, '.tmp', 'android-app-interop-315'));
const buildRoot = resolve(process.env.MONICA_APP_INTEROP_BUILD_ROOT || join(root, '.tmp', 'android-app-build-315'));
const testApk = join(buildRoot, 'app/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
const adb = process.env.MONICA_INTEROP_ADB || 'D:/AndroidSDK/platform-tools/adb.exe';
const serial = process.env.MONICA_MDBX2_INTEROP_SERIAL || 'emulator-5554';
const stage = process.argv[2] || 'export';
const runStamp = new Date().toISOString().replaceAll(':', '-');
const env = { ...process.env, ANDROID_ADB_SERVER_PORT: '5037', MONICA_APP_INTEROP_SOURCE_DIR: join(root, 'tests', 'interop', 'android-app', 'src'), MONICA_APP_INTEROP_BUILD_DIR: buildRoot };
delete env.MONICA_APP_INTEROP_REUSE_VERIFIED_APPLICATION;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const testSet = process.env.MONICA_APP_INTEROP_TEST_SET;
if (stage.startsWith('passkey-signatures-') && testSet !== 'passkey-signatures') throw new Error('Passkey signature stages require MONICA_APP_INTEROP_TEST_SET=passkey-signatures');
if (stage === 'keepass-project-export' && testSet !== 'keepass-project') throw new Error('KeePass project stage requires MONICA_APP_INTEROP_TEST_SET=keepass-project');
const appFixtureDirectory = testSet === 'passkey-signatures' ? 'extension-interop-317-passkey' : 'extension-interop-315';
const targetedAndroidTestSources = [];
if (testSet) {
  const selected = { 'api-address': 'ExtensionApiAddressInteropTest.kt', 'full-fields': 'ExtensionAndroid315InteropTest.kt',
    'project-credentials': 'ExtensionProjectCredentialInteropTest.kt', 'bitwarden-project': 'ExtensionBitwardenProjectInteropTest.kt',
    'passkey-signatures': 'ExtensionPasskeySignatureInteropTest.kt',
    'system-credentials': 'ExtensionSystemCredentialInteropTest.kt',
    'system-backends': 'ExtensionSystemBackendCredentialInteropTest.kt',
    'passkey-repairs': 'ExtensionPasskeyRepairAcceptanceTest.kt',
    'password-history': 'ExtensionPasswordHistoryInteropTest.kt',
    'keepass-project': 'ExtensionKeePassProjectInteropTest.kt' }[testSet];
  if (!selected) throw new Error('Unknown targeted application test set');
  const sourceRoot = join(buildRoot, 'interop-test-sources', testSet);
  const packagePath = 'takagi/ru/monica/credentialexchange';
  for (const source of [join(project, 'app/src/androidTest/java', packagePath, 'TransferFixture.kt'), join(root, 'tests/interop/android-app/src', packagePath, selected)]) {
    const bytes = await readFile(source);
    const destination = join(sourceRoot, packagePath, source.split(/[\\/]/).at(-1));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    targetedAndroidTestSources.push({ source, destination, sha256: hash(bytes) });
  }
  env.MONICA_APP_INTEROP_SOURCE_DIR = sourceRoot;
  env.MONICA_APP_INTEROP_REPLACE_TEST_SOURCES = '1';
}

async function command(executable, args, options = {}) {
  return await new Promise((accept, reject) => {
    const process = spawn(executable, args, { cwd: options.cwd || root, env, windowsHide: true, shell: options.shell || false });
    const chunks = [], errors = [];
    process.stdout.on('data', bytes => { chunks.push(bytes); if (options.echo) globalThis.process.stdout.write(bytes); });
    process.stderr.on('data', bytes => { errors.push(bytes); if (options.echo) globalThis.process.stderr.write(bytes); });
    if (options.input) process.stdin.end(options.input);
    process.on('error', reject);
    process.on('close', code => {
      const bytes = Buffer.concat(chunks);
      if (options.allowFailure || code === 0) accept({ bytes, text: bytes.toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), code });
      else reject(new Error(`${executable} ${args.join(' ')} exited ${code}\n${bytes.toString('utf8')}\n${Buffer.concat(errors).toString('utf8')}`));
    });
  });
}
async function snapshot() {
  if (process.env.MONICA_APP_INTEROP_SOURCE_MANIFEST) {
    const bytes = await readFile(process.env.MONICA_APP_INTEROP_SOURCE_MANIFEST);
    const manifest = JSON.parse(bytes);
    if (resolve(manifest.sourceRoot) !== project || !manifest.records.length) throw new Error('Wrong application source snapshot');
    for (const row of manifest.records) {
      if (hash(await readFile(join(project, row.file))) !== row.sha256) throw new Error(`Application snapshot changed: ${row.file}`);
    }
    return { revision: manifest.revision, statusSha256: hash(bytes), diffSha256: hash(Buffer.from(JSON.stringify(manifest.records))),
      sourceSnapshot: resolve(process.env.MONICA_APP_INTEROP_SOURCE_MANIFEST), sourceRoot: project };
  }
  const revision = await command('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const status = await command('git', ['status', '--porcelain=v1', '-uall'], { cwd: repository });
  const diff = await command('git', ['diff', '--binary', 'HEAD'], { cwd: repository });
  return { revision: revision.text.trim(), statusSha256: hash(status.bytes), diffSha256: hash(diff.bytes) };
}
async function assertNoActiveInstrumentation() {
  const activity = (await command(adb, ['-s', serial, 'shell', 'dumpsys', 'activity', 'processes'])).text;
  if (!activity.includes('ACTIVITY MANAGER RUNNING PROCESSES') || activity.includes('FAILED_TRANSACTION'))
    throw new Error('Shared AVD activity service is unavailable; no instrumentation or test installation was submitted.');
  if (activity.includes('ActiveInstrumentation{'))
    throw new Error('An instrumentation session is already active on the shared AVD; do not replace its test package or submit another session.');
}
async function packageFingerprint(packageName) {
  const location = await command(adb, ['-s', serial, 'shell', 'pm', 'path', packageName], { allowFailure: true });
  const path = location.text.trim().replace(/^package:/, '');
  if (location.code !== 0 || !/^\/data\/app\/[^\r\n]+\/base\.apk$/.test(path)) return null;
  const digest = await command(adb, ['-s', serial, 'shell', 'sha256sum', path], { allowFailure: true });
  return digest.code === 0 ? digest.text.split(/\s+/)[0] : null;
}
async function pull(name, outputName = name) {
  if ([name, outputName].some(path => !/^[a-z0-9./-]+$/i.test(path) || path.includes('..'))) throw new Error('Unsafe fixture path');
  const remotePath = `files/${appFixtureDirectory}/${name}`;
  const expected = (await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'sha256sum', remotePath])).text.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Missing or unreadable Android fixture: ${name}`);
  const result = await command(adb, ['-s', serial, 'exec-out', 'run-as', 'takagi.ru.monica', 'cat', `files/${appFixtureDirectory}/${name}`]);
  if (hash(result.bytes) !== expected) throw new Error(`Android fixture pull integrity failed: ${name}`);
  await mkdir(dirname(join(evidence, outputName)), { recursive: true });
  await writeFile(join(evidence, outputName), result.bytes);
  return { name: outputName, ...(outputName !== name ? { sourceName: name } : {}), bytes: result.bytes.length, sha256: hash(result.bytes) };
}
async function push(name) {
  if (!/^[a-z0-9./-]+$/i.test(name) || name.includes('..')) throw new Error('Unsafe fixture path');
  await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'mkdir', '-p', `files/${appFixtureDirectory}/${dirname(name).replaceAll('\\', '/')}`]);
  // Only encrypted vault/ZIP/Blob artifacts are staged; never use /sdcard or user plaintext.
  const bytes = await readFile(join(evidence, name));
  const staging = `/data/local/tmp/monica-315-${randomUUID()}.encrypted`;
  try {
    await command(adb, ['-s', serial, 'push', join(evidence, name), staging]);
    await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'cp', staging, `files/${appFixtureDirectory}/${name}`]);
    const actual = (await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'sha256sum', `files/${appFixtureDirectory}/${name}`])).text.split(/\s+/)[0];
    if (actual !== hash(bytes)) throw new Error('Android pushed fixture integrity failed');
    return { name, bytes: bytes.length, sha256: actual };
  } finally {
    await command(adb, ['-s', serial, 'shell', 'rm', '-f', staging]);
  }
}

async function pushSyntheticBitwardenInput() {
  const name = 'bitwarden-project-input.json';
  const bytes = await readFile(join(evidence, name));
  const fixture = JSON.parse(bytes.toString('utf8'));
  if (fixture.synthetic !== true || fixture.baseUrl !== 'http://127.0.0.1:18316' || !/^project-[0-9a-f-]{36}@example\.invalid$/.test(fixture.email))
    throw new Error('Only the isolated synthetic project account is allowed');
  await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'mkdir', '-p', 'files/extension-interop-315']);
  // Synthetic session only, streamed to app-private storage. No shared staging or command-line secrets.
  await command(adb, ['-s', serial, 'exec-in', 'run-as', 'takagi.ru.monica', 'tee', `files/extension-interop-315/${name}`], { input: bytes });
  const actual = (await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'sha256sum', `files/extension-interop-315/${name}`])).text.split(/\s+/)[0];
  if (actual !== hash(bytes)) throw new Error('Private synthetic input integrity failed');
  return { name, bytes: bytes.length, sha256: actual };
}

async function pushSyntheticRemotePasskeyInput() {
  const bitwarden = stage === 'passkey-signatures-bitwarden';
  const name = bitwarden ? 'bitwarden-passkey-input.json' : 'webdav-passkey-input.json';
  const bytes = await readFile(join(evidence, name));
  const fixture = JSON.parse(bytes.toString('utf8'));
  const valid = bitwarden
    ? fixture.baseUrl === 'http://10.0.2.2:18316' && /^passkey-[0-9a-f-]{36}@example\.invalid$/.test(fixture.email)
    : fixture.baseUrl === 'http://10.0.2.2:18315' && /^passkey-[0-9a-f-]{36}\/vault\.kdbx$/.test(fixture.remotePath);
  if (fixture.synthetic !== true || !valid) throw new Error('Only the isolated synthetic remote passkey fixture is allowed');
  await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'mkdir', '-p', `files/${appFixtureDirectory}`]);
  await command(adb, ['-s', serial, 'exec-in', 'run-as', 'takagi.ru.monica', 'tee', `files/${appFixtureDirectory}/${name}`], { input: bytes });
  const actual = (await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'sha256sum', `files/${appFixtureDirectory}/${name}`])).text.split(/\s+/)[0];
  if (actual !== hash(bytes)) throw new Error('Private synthetic remote passkey input integrity failed');
  return { name, bytes: bytes.length, sha256: actual };
}

await mkdir(evidence, { recursive: true });
const deviceIndependentBuild = stage === 'build' && process.env.MONICA_APP_INTEROP_BUILD_OFFLINE === '1';
let runtime = '', installedApkSha256, installedTestApkSha256;
if (!deviceIndependentBuild) {
const avd = (await command(adb, ['-s', serial, 'emu', 'avd', 'name'])).text;
if (!avd.split(/\r?\n/).some(line => line.trim() === 'Monica_Issue136_API_32')) throw new Error('Selected device is not the shared Monica_Issue136_API_32 AVD; no device was started or cleared.');
runtime = (await command(adb, ['-s', serial, 'shell', 'dumpsys', 'package', 'takagi.ru.monica'])).text;
const installedPath = (await command(adb, ['-s', serial, 'shell', 'pm', 'path', 'takagi.ru.monica'])).text.trim().replace(/^package:/, '');
if (!/^\/data\/app\/[^\r\n]+\/base\.apk$/.test(installedPath)) throw new Error('Unexpected installed application path');
installedApkSha256 = (await command(adb, ['-s', serial, 'shell', 'sha256sum', installedPath])).text.split(/\s+/)[0];
const installedTestPath = (await command(adb, ['-s', serial, 'shell', 'pm', 'path', 'takagi.ru.monica.test'])).text.trim().replace(/^package:/, '');
if (!/^\/data\/app\/[^\r\n]+\/base\.apk$/.test(installedTestPath)) throw new Error('Unexpected instrumentation application path');
installedTestApkSha256 = (await command(adb, ['-s', serial, 'shell', 'sha256sum', installedTestPath])).text.split(/\s+/)[0];
}
const testSources = (await command('rg', ['--files', 'tests/interop/android-app'])).text.trim().split(/\r?\n/).sort();
const testSourceHashes = await Promise.all(testSources.map(async path => ({ path, sha256: hash(await readFile(join(root, path))) })));
const baseline = await snapshot();
const report = { stage, startedAt: runStamp, serial, androidUser: 0, avd: 'Monica_Issue136_API_32', androidVersion: runtime.match(/versionName=(\S+)/)?.[1], installedApkSha256, installedTestApkSha256, testSourceHashes, baseline, outputs: [] };
if (deviceIndependentBuild) report.deviceProvenance = 'Not observed: build only. Installation and instrumentation must verify their own device and exact built APK hashes.';
if (testSet) Object.assign(report, { testSet, targetedAndroidTestSources });
try {
  if (!deviceIndependentBuild) report.deviceBootId = (await command(adb, ['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id'])).text.trim();
  if (stage === 'build') {
    const retainedBuildConfig = process.env.MONICA_APP_INTEROP_KEEP_BUILD_CONFIG === '1'
      ? join(buildRoot, 'app/generated/source/buildConfig/debug/takagi/ru/monica/BuildConfig.java') : null;
    if (retainedBuildConfig) {
      if (!process.env.MONICA_APP_INTEROP_SOURCE_MANIFEST) throw new Error('Retaining BuildConfig requires verified immutable production sources');
      report.retainedBuildConfig = { path: retainedBuildConfig, sha256: hash(await readFile(retainedBuildConfig)) };
    }
    const buildApplication = process.env.MONICA_APP_INTEROP_BUILD_APPLICATION === '1';
    const reuseBuildPath = process.env.MONICA_APP_INTEROP_REUSE_BUILD_EVIDENCE;
    if (reuseBuildPath) {
      if (buildApplication) throw new Error('Choose either application rebuild or verified APK reuse');
      const previousBytes = await readFile(reuseBuildPath);
      const previous = JSON.parse(previousBytes.toString('utf8'));
      const priorCompileApi = previous.applicationCompileApi || (previous.reusedApplication && {
        path: previous.reusedApplication.classesJar, sha256: previous.reusedApplication.classesJarSha256,
      });
      if (!priorCompileApi?.path || hash(await readFile(priorCompileApi.path)) !== priorCompileApi.sha256)
        throw new Error('Prior compile API jar proof missing or changed');
      let verifiedNonProductionStatusChange = false;
      if (process.env.MONICA_APP_INTEROP_VERIFY_CLEAN_SOURCE_REUSE === '1' &&
          previous.baseline.revision === baseline.revision && previous.baseline.diffSha256 === hash(Buffer.alloc(0)) &&
          baseline.diffSha256 === hash(Buffer.alloc(0))) {
        const untracked = (await command('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repository }))
          .text.split('\0').filter(Boolean);
        // Exact same clean tracked commit. Only these non-production files may differ.
        const ignoredForApplication = path => /^Monica for Android\/(?:\.codex-tmp\/|docs\/|app\/src\/androidTest\/)/.test(path) ||
          /^Monica for Android\/hs_err_pid\d+\.log$/.test(path) ||
          /^\.scratch-handoff-run\.ps1$/.test(path) || /^kdbx_(?:negative_controls2?|picker_negative_controls|uitest_negative_controls)\.py$/.test(path);
        if (untracked.some(path => !ignoredForApplication(path))) throw new Error('Untracked files outside the verified non-production allowlist prevent APK reuse');
        verifiedNonProductionStatusChange = true;
        report.nonProductionStatusRevalidation = { previousBaseline: previous.baseline, currentBaseline: baseline,
          untrackedFiles: untracked, sourceRule: 'Same clean tracked commit, exact prior APK/API jar, only explicit documentation/scratch/replaced test sources untracked' };
      }
      if (previous.status !== 'passed' || previous.androidSourcesUnchanged !== true ||
          (!verifiedNonProductionStatusChange && JSON.stringify(previous.baseline) !== JSON.stringify(baseline)) ||
          hash(await readFile(previous.builtAppApk)) !== previous.builtAppApkSha256) {
        throw new Error('Application APK reuse requires a successful build of the exact unchanged Android source');
      }
      const classesJar = join(buildRoot, 'app/intermediates/compile_app_classes_jar/debug/bundleDebugClassesToCompileJar/classes.jar');
      if (resolve(priorCompileApi.path) !== resolve(classesJar)) {
        await mkdir(dirname(classesJar), { recursive: true });
        await copyFile(priorCompileApi.path, classesJar);
      }
      if (hash(await readFile(classesJar)) !== priorCompileApi.sha256) throw new Error('Restored compile API jar mismatch');
      report.reusedApplication = { buildEvidence: resolve(reuseBuildPath), buildEvidenceSha256: hash(previousBytes),
        classesJar, classesJarSha256: hash(await readFile(classesJar)), scope: 'Only instrumentation is rebuilt; actual app APK reused by exact hash and Android source snapshot' };
      report.builtAppApk = previous.builtAppApk;
      report.builtAppApkSha256 = previous.builtAppApkSha256;
      // Keep producers in the task graph so Kotlin can resolve their output providers.
      // The init script skips their actions only after the APK/source checks above.
      env.MONICA_APP_INTEROP_REUSE_VERIFIED_APPLICATION = '1';
    }
    const heap = process.env.MONICA_APP_INTEROP_HEAP_MB;
    if (heap && (!/^\d+$/.test(heap) || Number(heap) < (reuseBuildPath ? 1024 : 2048) || Number(heap) > 6144)) throw new Error('Interop heap must be 2048–6144 MiB, or at least 1024 MiB for verified test-only reuse');
    const resourceArgs = heap ? [`-Dorg.gradle.jvmargs="-Xmx${heap}m -Dfile.encoding=UTF-8 -XX:ActiveProcessorCount=2"`, `-Pkotlin.daemon.jvmargs=-Xmx${heap}m`, '--max-workers=1', '--no-parallel'] : [];
    if (heap) report.buildResources = { maxHeapMiB: Number(heap), activeProcessors: 2, maxWorkers: 1, parallel: false };
    const passkeyRegressionTasks = process.env.MONICA_APP_INTEROP_PASSKEY_REGRESSIONS === '1'
      ? [':app:testDebugUnitTest', ...['PasskeyCredentialIdCodecTest', 'PasskeyGetRequestPolicyTest',
        'PasskeyCredentialDiscoveryPolicyTest', 'PasskeyRemarkAndNavigationGuardTest.remarkWinsWithoutChangingOriginalPasskeyIdentity',
        'PasskeyRemarkAndNavigationGuardTest.blankRemarkFallsBackToOriginalDisplayName',
        'PasskeyRemarkAndNavigationGuardTest.credentialSelectorUsesAccountTitleWithoutNotes', 'PasskeyUserVerificationGuardTest',
        'PasskeyNotesCodecTest', 'PasskeyMapperInteropTest'].flatMap(name => ['--tests', `*.${name}`])] : [];
    const result = await command('.\\gradlew.bat', ['--project-cache-dir', join(root, '.tmp', 'android-app-gradle-315'), '-I', join(root, 'tests', 'interop', 'android-app', 'interop.init.gradle'),
      ...passkeyRegressionTasks,
      ...(buildApplication ? [':app:assembleDebug', '-PincludeX86TestAbi'] : []), ':app:assembleDebugAndroidTest', '-PdailySeq=36', '-Pkotlin.compiler.execution.strategy=in-process', ...resourceArgs, '--no-daemon', '--console=plain'], { cwd: project, shell: true, echo: true });
    await writeFile(join(evidence, 'build.log'), result.bytes);
    if (retainedBuildConfig && hash(await readFile(retainedBuildConfig)) !== report.retainedBuildConfig.sha256)
      throw new Error('Retained BuildConfig changed during build');
    report.builtTestApkSha256 = hash(await readFile(testApk));
    report.builtTestApk = testApk;
    if (report.reusedApplication && (hash(await readFile(report.builtAppApk)) !== report.builtAppApkSha256 ||
        hash(await readFile(report.reusedApplication.classesJar)) !== report.reusedApplication.classesJarSha256)) {
      throw new Error('Reused APK or compile API jar changed during instrumentation build');
    }
    if (buildApplication) {
      const apkDirectory = join(buildRoot, 'app/outputs/apk/debug');
      const apks = (await readdir(apkDirectory)).filter(name => /x86_64.*\.apk$/i.test(name));
      if (apks.length !== 1) throw new Error('Expected exactly one x86_64 debug application APK');
      report.builtAppApk = join(apkDirectory, apks[0]);
      report.builtAppApkSha256 = hash(await readFile(report.builtAppApk));
    }
    // Keep this small verified interface alongside evidence, outside disposable intermediates.
    // It enables a test-only build after compiler-cache cleanup without rebuilding the application.
    const compileApi = join(buildRoot, 'app/intermediates/compile_app_classes_jar/debug/bundleDebugClassesToCompileJar/classes.jar');
    const savedCompileApi = join(evidence, 'application-compile-api.jar');
    const compileApiHash = hash(await readFile(compileApi));
    await copyFile(compileApi, savedCompileApi);
    if (hash(await readFile(savedCompileApi)) !== compileApiHash) throw new Error('Saved compile API jar mismatch');
    report.applicationCompileApi = { path: savedCompileApi, sha256: compileApiHash };
  } else if (stage === 'install-test') {
    await assertNoActiveInstrumentation();
    report.testApkSha256 = hash(await readFile(testApk));
    await command(adb, ['-s', serial, 'install', '-r', '-t', testApk], { echo: true });
  } else if (stage === 'recover-ui-artifacts') {
    report.scope = 'Read existing UI-created fixture only; does not mark the previous UI test passed';
    for (const name of ['android-ui.mdbx', 'android-ui-record.json']) report.outputs.push(await pull(name));
  } else {
    const methods = {
      export: 'exportAndroidApplicationFixtures',
      import: 'reopenExtensionVaultThroughAndroidProjection',
      'restore-project': 'reopenRestoredPasswordProject',
      'removal-project': 'reopenRemovedPasswordProject',
      'password-encoding-export': 'exportPasswordEncodingProbe',
      'password-encoding-import': 'reopenLiteralCiphertextPasswords',
      zip: 'importExtensionArchiveWithoutModifyingUserData',
      'project-credentials-export': 'exportProjectCredentials',
      'project-credentials-import': 'restoreAndEditProjectCredentials',
      'passkey-signatures-export': 'generateExportAndSign',
      'passkey-signatures-import': 'importAndSignReturnedKeys',
      'passkey-signatures-kdbx': 'importSignEditAndReturnKeePassKeys',
      'passkey-signatures-webdav': 'importSignEditAndReturnWebDavKeys',
      'passkey-signatures-bitwarden': 'importSignEditAndReturnBitwardenKey',
      'bitwarden-project': 'downloadEditAndUploadProjects',
      cleanup: 'cleanupAbortedSyntheticUiFixture',
      'zip-note-export': 'exportBoundNoteArchive',
      'zip-note-import': 'restoreBoundNoteArchiveAndExportAgain',
      'edge-note-import': 'restoreEdgeBoundNoteArchiveAndExportAgain',
      'password-history-import': 'restoreEditAndExportHistory',
      'keepass-project-export': 'writeAndReopenProject',
      'api-address-export': 'exportApiAddressFixtures',
      'api-address-import': 'reopenEdgeApiAddresses'
    };
    const createUi = stage === 'ui' || stage === 'ui-recheck';
    if (!methods[stage] && !createUi && stage !== 'edge-ui' && stage !== 'failures') throw new Error('Choose build, install-test, export, import, zip, zip-note-export, zip-note-import, edge-note-import, ui, ui-recheck, edge-ui, cleanup, or failures');
    await assertNoActiveInstrumentation();
    if (createUi || stage === 'edge-ui') {
      const foregroundUser = (await command(adb, ['-s', serial, 'shell', 'am', 'get-current-user'])).text.trim();
      if (foregroundUser !== '0') throw new Error(`Android user ${foregroundUser} is active; UI fixtures belong to user 0. Coordinate with the active user session; no user switch or test was submitted.`);
    }
    if (stage === 'edge-ui') await push('edge-ui-return.mdbx');
    if (stage === 'password-encoding-import') report.inputs = [await push('extension.mdbx')];
    if (stage === 'import' || stage === 'restore-project' || stage === 'removal-project') {
      report.inputs = [await push('extension.mdbx')];
      if (stage === 'restore-project' || stage === 'removal-project') report.inputs.push(await push('edge-restored-project-expected.json'));
      const blobs = JSON.parse(await readFile(join(evidence, 'extension-blobs.json'), 'utf8'));
      for (const blob of blobs) {
        if (!/^[0-9a-f]{64}$/.test(blob.blobId) || blob.path !== `extension-blobs/${blob.blobId}`) throw new Error('Unsafe Blob manifest');
        const bytes = await readFile(join(evidence, blob.path));
        if (hash(bytes) !== blob.blobId || bytes.length !== blob.sizeBytes) throw new Error('Blob manifest integrity failure');
        report.inputs.push(await push(blob.path));
      }
    }
    if (stage === 'zip') report.inputs = [await push('extension.zip')];
    if (stage === 'project-credentials-import') report.inputs = [await push('extension-project-credentials.zip')];
    if (stage === 'passkey-signatures-import') report.inputs = [await push('extension-passkeys.mdbx')];
    if (stage === 'passkey-signatures-kdbx') report.inputs = [await push('extension-passkeys.kdbx'), await push('extension-passkeys-expected.json')];
    if (stage === 'passkey-signatures-webdav') report.inputs = [await push('extension-passkeys-expected.json'), await pushSyntheticRemotePasskeyInput()];
    if (stage === 'passkey-signatures-bitwarden') report.inputs = [await pushSyntheticRemotePasskeyInput()];
    if (stage === 'bitwarden-project') {
      const mappings = (await command(adb, ['-s', serial, 'reverse', '--list'])).text;
      const existing = mappings.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1] === 'tcp:18316');
      if (existing && existing[2] !== 'tcp:18316') throw new Error('An unrelated AVD reverse port mapping owns 18316');
      if (!existing) {
        await command(adb, ['-s', serial, 'reverse', 'tcp:18316', 'tcp:18316']);
        report.ownsBitwardenReversePort = true;
      }
      report.inputs = [await pushSyntheticBitwardenInput()];
      await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'rm', '-f',
        'files/extension-interop-315/bitwarden-project-return.json', 'files/extension-interop-315/bitwarden-project-progress.json']);
    }
    if (stage === 'zip-note-import') await push('extension-note.zip');
    if (stage === 'edge-note-import') report.inputs = [await push('edge-note.zip')];
    if (stage === 'password-history-import') report.inputs = [await push('extension-history.zip')];
    if (stage === 'keepass-project-export') {
      await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'rm', '-f',
        'files/extension-interop-315/android-keepass-project.json', 'files/extension-interop-315/android-keepass-project.kdbx']);
    }
    if (stage === 'api-address-import') report.inputs = [await push('edge-api-address.mdbx')];
    const cleanupArgs = stage === 'cleanup' ? ['-e', 'syntheticPrefix', process.env.MONICA_APP_CLEANUP_PREFIX || ''] : [];
    if (stage === 'cleanup' && !/^credential-transfer-[0-9a-f-]{36}$/.test(process.env.MONICA_APP_CLEANUP_PREFIX || '')) throw new Error('Set MONICA_APP_CLEANUP_PREFIX to the exact aborted fixture prefix');
    const result = await command(adb, ['-s', serial, 'shell', 'am', 'instrument', '--user', '0', '-w', '-r', ...cleanupArgs, '-e', 'class',
      createUi ? 'takagi.ru.monica.credentialexchange.ExtensionAndroid315UiTest#createNativeLoginInAndroidUiAndReopenDetails'
        : stage === 'edge-ui' ? 'takagi.ru.monica.credentialexchange.ExtensionAndroid315UiTest#reopenEdgeEditedVaultAndEditAgainInAndroidUi'
        : stage === 'failures' ? 'takagi.ru.monica.credentialexchange.ExtensionAndroid315FailureTest#rejectedInputsAndCancelledPreviewKeepExistingData'
        : `takagi.ru.monica.credentialexchange.${stage.startsWith('api-address-') ? 'ExtensionApiAddressInteropTest'
          : stage.startsWith('project-credentials-') ? 'ExtensionProjectCredentialInteropTest'
          : stage.startsWith('passkey-signatures-') ? 'ExtensionPasskeySignatureInteropTest'
          : stage === 'password-history-import' ? 'ExtensionPasswordHistoryInteropTest'
          : stage === 'keepass-project-export' ? 'ExtensionKeePassProjectInteropTest'
          : stage === 'bitwarden-project' ? 'ExtensionBitwardenProjectInteropTest' : 'ExtensionAndroid315InteropTest'}#${methods[stage]}`, 'takagi.ru.monica.test/androidx.test.runner.AndroidJUnitRunner'], { echo: true, allowFailure: true });
    await writeFile(join(evidence, `${stage}.log`), result.bytes);
    await writeFile(join(evidence, `${stage}-${runStamp}.log`), result.bytes);
    report.instrumentationExitCode = result.code;
    // Preserve actual native file and projection diagnostics even when the parity assertion fails.
    if (stage === 'keepass-project-export') {
      for (const name of ['android-keepass-project.json', 'android-keepass-project.kdbx']) {
        try { report.outputs.push(await pull(name)); } catch (error) {
          (report.diagnosticPullErrors ??= []).push({ name, message: String(error) });
        }
      }
    }
    if (result.stderr) report.instrumentationStderr = result.stderr;
    if (result.code !== 0) throw new Error(`Instrumentation client exited ${result.code}; incomplete output is preserved in ${stage}-${runStamp}.log. This is not a test pass.`);
    if (!/OK \(1 test\)/.test(result.text) || /FAILURES|INSTRUMENTATION_FAILED|Process crashed/i.test(result.text)) throw new Error(`Android application fixture failed; see ${stage}.log`);
    const files = stage === 'keepass-project-export' ? []
      : stage === 'api-address-export' ? ['android-api-address.mdbx', 'android-api-address.json']
      : stage === 'passkey-signatures-export' ? ['android-passkeys.mdbx', 'android-signatures.json']
      : stage === 'passkey-signatures-import' ? ['android-return-passkeys.mdbx', 'android-return-signatures.json']
      : stage === 'passkey-signatures-kdbx' ? ['android-return-passkeys.kdbx', 'android-kdbx-signatures.json']
      : stage === 'passkey-signatures-webdav' ? ['android-return-passkeys.kdbx', 'android-kdbx-signatures.json', 'android-webdav-transport.json']
      : stage === 'passkey-signatures-bitwarden' ? ['android-bitwarden-signatures.json']
      : stage === 'password-encoding-export' ? ['android.mdbx', 'password-encoding-probe.json']
      : stage === 'password-encoding-import' ? ['android-return.mdbx', 'password-encoding-readback.json']
      : stage === 'bitwarden-project' ? ['bitwarden-project-return.json']
      : stage === 'project-credentials-export' ? ['android-project-credentials.zip', 'android-project-credentials.json']
      : stage === 'project-credentials-import' ? ['android-project-credentials-return.zip', 'android-project-credentials-return.json']
      : stage === 'api-address-import' ? ['android-api-address-return.mdbx', 'android-api-address-return.json']
      : stage === 'edge-note-import' ? ['android-edge-note-return.zip', 'android-edge-note-restore.json']
      : stage === 'password-history-import' ? ['android-history-mdbx-return.zip', 'android-history-keepass-return.zip', 'android-history-return.json']
      : stage === 'zip-note-export' ? ['android-note.zip', 'android-note-seed.json']
      : stage === 'zip-note-import' ? ['android-note-return.zip', 'android-note-restore.json']
      : stage === 'export' ? ['android.mdbx', 'android.zip', 'android-records.json', 'android-writer-gaps.json', 'android-known-field-writeback.json']
      : stage === 'restore-project' ? ['android-return.mdbx', 'restored-project-android-readback.json']
      : stage === 'removal-project' ? ['android-return.mdbx', 'removed-project-android-readback.json']
      : stage === 'import' ? ['android-return.mdbx', 'extension-native-readback.json'] : createUi
        ? ['android-ui.mdbx', 'android-ui-record.json', 'android-ui-details.png']
          : stage === 'edge-ui' ? ['android-edge-ui-return.mdbx', 'android-edge-ui-return.json', 'android-edge-ui-return.png'] : stage === 'cleanup' ? ['ui-cleanup.json']
          : stage === 'failures' ? ['android-failure-readback.json'] : ['extension-zip-readback.json', 'extension-zip-return.zip'];
    for (const file of files) report.outputs.push(await pull(file, stage === 'ui-recheck' ? `recheck-${file}` : file));
    if (stage === 'export' || stage === 'import' || stage === 'restore-project' || stage === 'removal-project') {
      const prefix = stage === 'export' ? 'android' : 'android-return';
      report.outputs.push(await pull(`${prefix}-blobs.json`));
      for (const blob of JSON.parse(await readFile(join(evidence, `${prefix}-blobs.json`), 'utf8'))) {
        if (!/^[0-9a-f]{64}$/.test(blob.blobId) || blob.path !== `${prefix}-blobs/${blob.blobId}`) throw new Error('Unsafe exported Blob manifest');
        const result = await pull(blob.path);
        if (result.sha256 !== blob.blobId || result.bytes !== blob.sizeBytes) throw new Error('Exported Blob integrity failure');
        report.outputs.push(result);
      }
    }
  }
  report.status = 'passed';
} catch (error) {
  if (stage === 'password-history-import') {
    try { report.outputs.push(await pull('android-history-return.json')); } catch { /* May fail before restore. */ }
  }
  if (stage === 'bitwarden-project') {
    try { report.outputs.push(await pull('bitwarden-project-progress.json')); } catch { /* May fail before download. */ }
  }
  if (stage === 'edge-note-import') {
    try { report.outputs.push(await pull('android-edge-note-restore.json')); } catch { /* May fail before restore. */ }
  }
  if (stage === 'zip-note-import') {
    try { report.outputs.push(await pull('android-note-restore.json')); } catch { /* May fail before restore. */ }
  }
  if (stage === 'zip') {
    try { report.outputs.push(await pull('extension-zip-decoded.json')); } catch { /* May fail before decode. */ }
  }
  report.status = 'failed'; report.error = error.message; throw error;
} finally {
  if (report.ownsBitwardenReversePort) await command(adb, ['-s', serial, 'reverse', '--remove', 'tcp:18316']);
  if (stage === 'bitwarden-project') await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'rm', '-f', 'files/extension-interop-315/bitwarden-project-input.json'], { allowFailure: true });
  if (stage === 'passkey-signatures-webdav') await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'rm', '-f', `files/${appFixtureDirectory}/webdav-passkey-input.json`], { allowFailure: true });
  if (stage === 'passkey-signatures-bitwarden') await command(adb, ['-s', serial, 'shell', 'run-as', 'takagi.ru.monica', 'rm', '-f', `files/${appFixtureDirectory}/bitwarden-passkey-input.json`], { allowFailure: true });
  if (!deviceIndependentBuild) {
  const afterBoot = await command(adb, ['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id'], { allowFailure: true });
  report.deviceBootIdAfter = afterBoot.code === 0 ? afterBoot.text.trim() : null;
  report.deviceBootUnchanged = report.deviceBootIdAfter !== null && report.deviceBootId === report.deviceBootIdAfter;
  report.installedApkSha256After = await packageFingerprint('takagi.ru.monica');
  report.installedTestApkSha256After = await packageFingerprint('takagi.ru.monica.test');
  report.installedApplicationUnchanged = report.installedApkSha256 === report.installedApkSha256After;
  report.installedTestApkUnchanged = stage === 'install-test' || report.installedTestApkSha256 === report.installedTestApkSha256After;
  }
  report.after = await snapshot();
  report.androidSourcesUnchanged = JSON.stringify(baseline) === JSON.stringify(report.after);
  report.testSourceHashesAfter = await Promise.all(testSources.map(async path => ({ path, sha256: hash(await readFile(join(root, path))) })));
  report.testSourcesUnchanged = JSON.stringify(testSourceHashes) === JSON.stringify(report.testSourceHashesAfter);
  const provenanceErrors = [];
  for (const source of targetedAndroidTestSources) {
    if (hash(await readFile(source.destination)) !== source.sha256)
      provenanceErrors.push(`Staged Android test source changed during build: ${source.destination}`);
  }
  if (!deviceIndependentBuild && !report.deviceBootUnchanged) provenanceErrors.push('The shared AVD restarted or became unavailable during the run; do not accept incomplete device evidence. No device restart was requested by this runner.');
  if (!deviceIndependentBuild && (!report.installedApplicationUnchanged || !report.installedTestApkUnchanged)) provenanceErrors.push('Installed app or test APK changed during this run; do not combine evidence from different installed packages.');
  if (!report.androidSourcesUnchanged) provenanceErrors.push('Android source state changed during the run; inspect source provenance before accepting results.');
  if (!report.testSourcesUnchanged) provenanceErrors.push('Extension-owned Android test sources changed during the run; rebuild before accepting results.');
  if (provenanceErrors.length) {
    report.status = 'failed';
    report.provenanceErrors = provenanceErrors;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, `${stage}-${runStamp}-evidence.json`), JSON.stringify(report, null, 2));
  await writeFile(join(evidence, `${stage}-evidence.json`), JSON.stringify(report, null, 2));
  if (provenanceErrors.length) throw new Error(provenanceErrors.join('\n'));
}
