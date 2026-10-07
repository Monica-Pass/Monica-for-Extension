import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const backendBatch = process.env.MONICA_CM_BACKENDS === '1';
const repairBatch = process.env.MONICA_CM_REPAIRS === '1';
const out = resolve(process.env.MONICA_CM_EVIDENCE_DIR || join(root, backendBatch ? '.tmp/android-cm-backends-317' : '.tmp/android-credential-manager-317'));
const adb = 'D:/AndroidSDK/platform-tools/adb.exe';
const serial = 'emulator-5560';
const app = 'takagi.ru.monica';
const rp = 'com.monica.interop.rp317';
const directory = 'files/extension-credential-manager-317';
const provider = 'takagi.ru.monica/takagi.ru.monica.passkey.MonicaCredentialProviderService';
const packages = [app, `${app}.test`, rp];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function command(args, input) {
  return new Promise((accept, reject) => {
    const child = spawn(adb, ['-s', serial, ...args], { windowsHide: true });
    const buffers = [], errors = [];
    child.stdout.on('data', b => buffers.push(b)); child.stderr.on('data', b => errors.push(b));
    child.on('error', reject);
    child.on('close', code => code === 0 ? accept(Buffer.concat(buffers)) : reject(new Error(`ADB ${args.slice(0, 4).join(' ')} failed: ${Buffer.concat(errors)} ${Buffer.concat(buffers)}`)));
    if (input !== undefined) child.stdin.end(input);
  });
}
const text = async args => (await command(args)).toString('utf8').trim();
async function privateWrite(pkg, path, bytes) {
  // adb exec-in can truncate binary stdin on this Windows/device combination.
  // Stage only synthetic fixtures, then copy into app-private storage and verify exact bytes.
  const local = join(out, `staging-${randomBytes(8).toString('hex')}`);
  const remote = `/data/local/tmp/cm317-${randomBytes(8).toString('hex')}`;
  await writeFile(local, bytes);
  try {
    await command(['push', local, remote]);
    await command(['shell', 'chmod', '644', remote]);
    await command(['shell', 'run-as', pkg, 'cp', remote, path]);
  } finally {
    await command(['shell', 'rm', '-f', remote]);
    const { unlink } = await import('node:fs/promises');
    await unlink(local);
  }
  if ((await text(['shell', 'run-as', pkg, 'sha256sum', path])).split(/\s/)[0] !== hash(bytes)) throw new Error('Private input checksum mismatch');
}
async function pull(pkg, name, remote = name) {
  const bytes = await command(['exec-out', 'run-as', pkg, 'cat', pkg === app ? `${directory}/${remote}` : `files/${remote}`]);
  const parsed = JSON.parse(bytes);
  await writeFile(join(out, name), bytes);
  return parsed;
}
await mkdir(out, { recursive: true });
if (!(await text(['emu', 'avd', 'name'])).split(/\r?\n/).map(line => line.trim()).includes('Pixel_Fold_API_35')) throw new Error('Wrong AVD');
if (await text(['shell', 'getprop', 'sys.boot_completed']) !== '1') throw new Error('Boot incomplete');
const boot = await text(['shell', 'cat', '/proc/sys/kernel/random/boot_id']);
const stage = process.argv[2];
if (stage === 'install') {
  const list = await text(['shell', 'pm', 'list', 'packages', '-u']);
  if (packages.some(pkg => list.split(/\r?\n/).includes(`package:${pkg}`))) throw new Error('Requires absent synthetic test packages, never overwrites an existing install');
  const settings = await text(['shell', 'settings', '--user', '0', 'list', 'secure']);
  const baseline = { boot, serial, avd: 'Pixel_Fold_API_35', absentPackages: packages, settings: Object.fromEntries(
    ['credential_service', 'credential_service_primary'].map(key => [key, settings.split(/\r?\n/).find(line => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? null])) };
  await writeFile(join(out, 'device-baseline.json'), JSON.stringify(baseline, null, 2));
  const build = JSON.parse(await readFile(join(out, 'build-evidence.json')));
  const rpBuild = JSON.parse(await readFile(join(out, 'rp-build/build-evidence.json')));
  if (build.status !== 'passed' || build.androidSourcesUnchanged !== true) throw new Error('Unverified application build');
  const artifacts = [{ pkg: app, file: build.builtAppApk, sha256: build.builtAppApkSha256 },
    { pkg: `${app}.test`, file: build.builtTestApk, sha256: build.builtTestApkSha256 }, { pkg: rp, file: rpBuild.apk, sha256: rpBuild.apkSha256 }];
  await writeFile(join(out, 'package-install-journal.json'), JSON.stringify(artifacts, null, 2));
  for (const artifact of artifacts) {
    if (hash(await readFile(artifact.file)) !== artifact.sha256) throw new Error('APK changed since build');
    await command(['install', '--user', '0', '-t', artifact.file]);
    const path = (await text(['shell', 'pm', 'path', artifact.pkg])).replace(/^package:/, '');
    if ((await text(['shell', 'sha256sum', path])).split(/\s/)[0] !== artifact.sha256) throw new Error('Installed APK hash mismatch');
  }
  await command(['shell', 'settings', '--user', '0', 'put', 'secure', 'credential_service', provider]);
  await command(['shell', 'settings', '--user', '0', 'put', 'secure', 'credential_service_primary', provider]);
  console.log('Exact verified APKs installed; provider enabled for user0. Run prepare next.');
} else if (stage === 'prepare') {
  const artifacts = JSON.parse(await readFile(join(out, 'package-install-journal.json')));
  for (const artifact of artifacts) {
    const path = (await text(['shell', 'pm', 'path', artifact.pkg])).replace(/^package:/, '');
    if ((await text(['shell', 'sha256sum', path])).split(/\s/)[0] !== artifact.sha256) throw new Error('Installed APK mismatch');
  }
  if ((await text(['shell', 'dumpsys', 'activity', 'processes'])).includes('ActiveInstrumentation{')) throw new Error('Already instrumenting');
  await command(['shell', 'run-as', app, 'mkdir', '-p', directory]);
  if (repairBatch) {
    const bytes = await readFile(join(out, 'repair-config.json'));
    const config = JSON.parse(bytes);
    const edge = JSON.parse(await readFile(join(out, 'edge-prepare-evidence.json')));
    if (!config.syntheticFreshInstallation || edge.status !== 'passed' || edge.configSha256 !== hash(bytes)) throw new Error('Repair fixture provenance mismatch');
    await privateWrite(app, `${directory}/repair-config.json`, bytes);
    console.log('Exact original synthetic32 credential configuration staged');
  } else if (backendBatch) {
    const input = await readFile(join(out, 'edge-local.kdbx'));
    const configBytes = await readFile(join(out, 'backend-config.json'));
    const config = JSON.parse(configBytes);
    if (config.syntheticFreshInstallation !== true || hash(input) !== config.kdbx.inputSha256) throw new Error('Synthetic backend input mismatch');
    await privateWrite(app, `${directory}/edge-local.kdbx`, input);
    await privateWrite(app, `${directory}/backend-config.json`, configBytes);
    console.log('Backend inputs checksummed in verified app-private storage');
  } else {
  const input = await readFile(join(root, '.tmp/android-file-counter-passkeys-317/extension-passkeys.mdbx'));
  if (hash(input) !== '19954a4768355d6395756791ab7360c1fcd7a724936830eb21b054e86054f296') throw new Error('Historical actual Edge export changed');
  await privateWrite(app, `${directory}/extension-passkeys.mdbx`, input);
  await privateWrite(app, `${directory}/config.json`, Buffer.from(JSON.stringify({ syntheticFreshInstallation: true, inputSha256: hash(input) })));
  console.log('Synthetic input checksummed in verified app-private storage');
  }
} else if (stage === 'seed') {
  const result = await command(['shell', 'am', 'instrument', '--user', '0', '-w', '-r', '-e', 'class',
    repairBatch ? 'takagi.ru.monica.credentialexchange.ExtensionPasskeyRepairAcceptanceTest#roundtripLegacyBitwardenAndSeedSystem'
      : backendBatch ? 'takagi.ru.monica.credentialexchange.ExtensionSystemBackendCredentialInteropTest#seedBackendKeysForSystemCredentialManager'
      : 'takagi.ru.monica.credentialexchange.ExtensionSystemCredentialInteropTest#importedKeysThroughSystemCredentialManager',
    'takagi.ru.monica.test/androidx.test.runner.AndroidJUnitRunner']);
  await writeFile(join(out, 'instrumentation.log'), result);
  console.log(result.toString());
  if (!result.toString().includes('OK (1 test)')) throw new Error('Instrumentation did not pass');
} else if (stage === 'ready') {
  console.log(JSON.stringify(await pull(app, 'ready.json')));
  if (repairBatch) await pull(app, 'repair-roundtrip.json');
} else if (stage === 'request') {
  const id = process.argv[3];
  const tag = process.argv[4];
  if (!/^[a-z0-9-]+$/.test(tag)) throw new Error('Invalid evidence tag');
  const ready = JSON.parse(await readFile(join(out, 'ready.json')));
  if (!ready.records.some(row => row.credentialId === id) && id !== 'AAAAAAAAAAAAAAAAAAAAAA') throw new Error('Unknown synthetic credential');
  const request = { challenge: randomBytes(32).toString('base64url'), rpId: ready.records.find(row => row.credentialId === id)?.rpId ?? ready.records[0].rpId, userVerification: 'required',
    timeout: 180000, allowCredentials: [{ type: 'public-key', id }] };
  await writeFile(join(out, `${tag}-request.json`), JSON.stringify(request, null, 2));
  await command(['shell', 'am', 'force-stop', '--user', '0', rp]);
  await command(['shell', 'run-as', rp, 'mkdir', '-p', 'files']);
  await command(['shell', 'run-as', rp, 'rm', '-f', 'files/result.json']);
  await privateWrite(rp, 'files/request.json', Buffer.from(JSON.stringify(request)));
  await command(['shell', 'am', 'start', '-W', '--user', '0', '-n', `${rp}/.MainActivity`]);
  console.log(`Request staged: ${tag}`);
} else if (stage === 'result') {
  const tag = process.argv[3];
  if (!/^[a-z0-9-]+$/.test(tag)) throw new Error('Invalid tag');
  const result = await pull(rp, `${tag}-result.json`, 'result.json');
  console.log(result.error ? `Provider error: ${result.error}` : `Credential returned: ${result.response.id}`);
} else if (stage === 'snapshot') {
  await privateWrite(app, `${directory}/snapshot-request`, Buffer.from('snapshot'));
  console.log('Snapshot requested; pull storage after acknowledgement');
} else if (stage === 'storage') {
  console.log(JSON.stringify(await pull(app, 'storage.json')));
} else if (stage === 'finish') {
  await privateWrite(app, `${directory}/finish`, Buffer.from('finished'));
  console.log('Fixture cleanup requested');
} else if (stage === 'final-storage') {
  await pull(app, 'storage-final.json'); await pull(app, 'fixture-cleanup.json');
  console.log('Final storage and fixture cleanup evidence saved');
} else if (stage === 'storage-sqlite' || stage === 'storage-sqlite-live') {
  const tag = process.argv[3];
  if (!/^[a-z0-9-]+$/.test(tag)) throw new Error('Invalid storage tag');
  const live = stage === 'storage-sqlite-live';
  if (!live) {
    if ((await text(['shell', 'dumpsys', 'activity', 'processes'])).includes('ActiveInstrumentation{')) throw new Error('Cannot stop an active instrumentation');
    await command(['shell', 'am', 'force-stop', '--user', '0', app]);
  }
  const destination = join(out, tag);
  await mkdir(destination, { recursive: true });
  const existing = (await text(['shell', 'run-as', app, 'ls', 'databases'])).split(/\s+/);
  const names = ['password_database', 'password_database-wal', 'password_database-shm'].filter(name => existing.includes(name));
  const beforeHashes = Object.fromEntries(await Promise.all(names.map(async name => [name,
    (await text(['shell', 'run-as', app, 'sha256sum', `databases/${name}`])).split(/\s/)[0]])));
  const files = [];
  for (const name of ['password_database', 'password_database-wal', 'password_database-shm']) {
    if (!existing.includes(name)) continue;
    const bytes = await command(['exec-out', 'run-as', app, 'cat', `databases/${name}`]);
    const remoteHash = (await text(['shell', 'run-as', app, 'sha256sum', `databases/${name}`])).split(/\s/)[0];
    if (hash(bytes) !== remoteHash) throw new Error('Database copy truncated');
    await writeFile(join(destination, name), bytes); files.push({ name, sha256: hash(bytes) });
  }
  for (const file of files) {
    const afterHash = (await text(['shell', 'run-as', app, 'sha256sum', `databases/${file.name}`])).split(/\s/)[0];
    if (file.sha256 !== beforeHashes[file.name] || file.sha256 !== afterHash) throw new Error('Database changed during snapshot; retry after writes settle');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(destination, 'password_database'), { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const backendColumns = backendBatch || repairBatch ? ',keepass_database_id,bitwarden_vault_id,bitwarden_cipher_id' : '';
  const rows = db.prepare(`SELECT id,credential_id,rp_id,user_id,user_name,public_key_algorithm,sign_count,use_count,is_backed_up${backendColumns} FROM passkeys ORDER BY id`).all();
  db.close();
  await writeFile(join(destination, 'storage-evidence.json'), JSON.stringify({ source: live
    ? 'actual Android Room DB/WAL stable across before/copy/after hashes; no signing or storage test helpers'
    : 'actual force-stopped Android Room DB/WAL; no test helpers', files, integrity, rows }, null, 2));
  console.log(JSON.stringify(rows.map(row => ({ credentialId: row.credential_id, count: row.sign_count, useCount: row.use_count }))));
} else if (stage === 'restore') {
  const baseline = JSON.parse(await readFile(join(out, 'device-baseline.json')));
  if (baseline.boot !== boot) {
    const ownership = JSON.parse(await readFile(join(out, 'emulator-host-ownership.json')));
    if (process.env.MONICA_CM_RECOVER_OWNED_RESTART !== '1' || !ownership.startedByThisTask || ownership.serial !== serial || ownership.avd !== baseline.avd)
      throw new Error('Device restarted; inspect before restoration');
    await writeFile(join(out, 'restoration-reboot.json'), JSON.stringify({ previousBoot: baseline.boot, currentBoot: boot, ownership }, null, 2));
  }
  const activities = await text(['shell', 'dumpsys', 'activity', 'processes']);
  if (activities.includes('ActiveInstrumentation{')) throw new Error('Wait for fixture cleanup before package removal');
  const artifacts = JSON.parse(await readFile(join(out, 'package-install-journal.json')));
  for (const artifact of artifacts) {
    if (!baseline.absentPackages.includes(artifact.pkg)) throw new Error('Package was not absent at baseline');
    const path = (await text(['shell', 'pm', 'path', artifact.pkg])).replace(/^package:/, '');
    if ((await text(['shell', 'sha256sum', path])).split(/\s/)[0] !== artifact.sha256) throw new Error('Installed package changed; refuse uninstall');
  }
  for (const [key, value] of Object.entries(baseline.settings)) {
    const current = await text(['shell', 'settings', '--user', '0', 'get', 'secure', key]);
    if (current !== provider) throw new Error('Credential provider settings changed externally');
    // Empty strings require Android shell quoting; null represents a missing key.
    await command(['shell', 'settings', '--user', '0', value === null ? 'delete' : 'put', 'secure', key, ...(value === null ? [] : [value === '' ? "''" : value])]);
  }
  const inputBefore = (await readFile(join(out, 'input-method-baseline.txt'), 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
  const inputAfter = (await readFile(join(out, 'input-method-after.txt'), 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
  for (const line of inputBefore) {
    const index = line.indexOf('='), key = line.slice(0, index), value = line.slice(index + 1);
    const observedAfter = inputAfter.find(row => row.startsWith(`${key}=`))?.slice(index + 1);
    const current = await text(['shell', 'settings', 'get', 'secure', key]);
    if (current !== observedAfter) throw new Error('Input method setting changed externally');
  }
  for (const artifact of [...artifacts].reverse()) await command(['uninstall', artifact.pkg]);
  // Package removal may update IME subtype history. Restore after that system change.
  for (const line of inputBefore) {
    const index = line.indexOf('='), key = line.slice(0, index), value = line.slice(index + 1);
    const current = await text(['shell', 'settings', 'get', 'secure', key]);
    if (current !== value) {
      const quoted = `'${value.replaceAll("'", "'\\''")}'`;
      await command(['shell', 'settings', value === 'null' ? 'delete' : 'put', 'secure', key, ...(value === 'null' ? [] : [quoted])]);
    }
  }
  const list = await text(['shell', 'pm', 'list', 'packages', '-u']);
  if (packages.some(pkg => list.split(/\r?\n/).includes(`package:${pkg}`))) throw new Error('Test package cleanup incomplete');
  for (const [key, value] of Object.entries(baseline.settings)) {
    if (await text(['shell', 'settings', '--user', '0', 'get', 'secure', key]) !== (value ?? 'null')) throw new Error('Setting restoration mismatch');
  }
  for (const line of inputBefore) {
    const index = line.indexOf('='), key = line.slice(0, index), value = line.slice(index + 1);
    if (await text(['shell', 'settings', 'get', 'secure', key]) !== value) throw new Error('Input method restoration mismatch');
  }
  await writeFile(join(out, 'restored.json'), JSON.stringify({ boot, restored: true, removedOnlyPreviouslyAbsentPackages: packages }, null, 2));
  console.log('Provider settings and absent-package baseline restored');
} else throw new Error('Unknown device stage');
