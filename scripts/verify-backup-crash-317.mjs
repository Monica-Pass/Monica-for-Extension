// Real framed Native Host processes; only the recorded synthetic Edge archive.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
const source = path.join(root, '.tmp/complete-backup-317/110153ff/complete.mdbx-backup.zip');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(source);
assert.equal(hash(bytes), '6dd0b2dc78b1aa12b3aab3bc62dbecfc11fbe400ac90b9aba6ac1a9b16f81281');
const output = path.join(root, '.tmp/backup-crash-317', randomUUID());
await mkdir(output, { recursive: true });
const storage = path.join(output, 'Monica Extension/MDBX2');
const processes = [];
const evidence = { status: 'failed', output, executable, executableSha256: hash(await readFile(executable)),
  source, sourceSha256: hash(bytes), phases: [] };

function host() {
  const child = spawn(executable, [], { windowsHide: true, env: { ...process.env, LOCALAPPDATA: output }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stopped = once(child, 'close');
  let buffer = Buffer.alloc(0), stderr = '';
  const pending = new Map();
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      assert.ok(length <= 900 * 1024);
      if (buffer.length < length + 4) break;
      const result = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
      const request = pending.get(result.requestId); assert.ok(request);
      pending.delete(result.requestId); clearTimeout(request.timer);
      result.ok ? request.resolve(result.result) : request.reject(new Error(JSON.stringify(result.error)));
    }
  });
  child.on('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Host closed: ${stderr}`)); } pending.clear(); });
  const instance = {
    pid: child.pid,
    rpc(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = randomUUID(); const data = Buffer.from(JSON.stringify({ protocol: 2, requestId, method, params }));
        const frame = Buffer.alloc(data.length + 4); frame.writeUInt32LE(data.length); data.copy(frame, 4);
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 60_000);
        pending.set(requestId, { resolve, reject, timer }); child.stdin.write(frame);
      });
    },
    async stop(abrupt = false) {
      if (child.exitCode === null && child.signalCode === null) abrupt ? child.kill('SIGKILL') : child.stdin.end();
      await stopped;
    }
  };
  processes.push(instance); return instance;
}
async function persistentFiles() {
  const result = {};
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name), absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, name);
      else if (entry.isFile()) result[name] = hash(await readFile(absolute));
      else assert.fail('Unexpected synthetic storage link');
    }
  }
  // These bytes are independent of per-process temporary backup workspaces.
  await visit(path.join(storage, 'vaults')); return result;
}
async function exportDirectories() {
  return (await readdir(storage)).filter(name => name.startsWith('complete-backup-'));
}
try {
  const first = host(); await first.rpc('host.hello');
  const transfer = await first.rpc('transfer.begin', { direction: 'extension-to-host', purpose: 'vault-bootstrap', sizeBytes: bytes.length, sha256: hash(bytes) });
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) await first.rpc('transfer.chunk', { transferId: transfer.transferId, offset, dataBase64: bytes.subarray(offset, offset + 256 * 1024).toString('base64') });
  const imported = await first.rpc('transfer.finish', { transferId: transfer.transferId });
  const opened = await first.rpc('vault.open', { source: { kind: 'file', handle: imported.fileHandle }, credential: { method: 'password', password: 'Synthetic transfer fixture password' } });
  await first.rpc('transfer.release', { fileHandle: imported.fileHandle });
  // Compare two closed/checkpointed databases. SQLite's live -shm and -wal are
  // connection state and disappear at a normal close, not lost vault content.
  await first.rpc('vault.lock', { vaultHandle: opened.vaultHandle });
  const before = await persistentFiles();
  await writeFile(path.join(output, 'persistent-before.json'), JSON.stringify(before, null, 2));
  const resumed = await first.rpc('vault.open', { source: { kind: 'vault', handle: opened.vaultHandle }, credential: { method: 'password', password: 'Synthetic transfer fixture password' } });
  assert.equal(resumed.vaultHandle, opened.vaultHandle);
  const prepared = await first.rpc('vault.export.begin', { vaultHandle: opened.vaultHandle });
  assert.equal(prepared.format, 'zip'); assert.equal(prepared.blobCount, 13);
  const directories = await exportDirectories(); assert.equal(directories.length, 1);
  evidence.abandonedDirectories = directories;
  const second = host(); await second.rpc('host.hello');
  assert.deepEqual(await exportDirectories(), directories, 'Starting another Host must preserve a live download');
  let data = [];
  for (let offset = 0; offset < prepared.sizeBytes;) {
    const chunk = await first.rpc('vault.export.read', { vaultHandle: opened.vaultHandle, fileHandle: prepared.fileHandle, offset, maxBytes: 256 * 1024 });
    const value = Buffer.from(chunk.dataBase64, 'base64'); assert.ok(value.length); data.push(value); offset += value.length;
  }
  assert.equal(hash(Buffer.concat(data)), prepared.sha256);
  await writeFile(path.join(output, 'download-before-crash.zip'), Buffer.concat(data));
  evidence.phases.push('live-export-survives-concurrent-host-and-exact-download');
  await second.stop(); await first.stop(true);
  assert.deepEqual(await exportDirectories(), directories, 'Forced termination must leave an actual orphan to test');
  const restarted = host(); await restarted.rpc('host.hello');
  assert.deepEqual(await exportDirectories(), [], 'Restart must reclaim only abandoned backup directories');
  const reopened = await restarted.rpc('vault.open', { source: { kind: 'vault', handle: opened.vaultHandle }, credential: { method: 'password', password: 'Synthetic transfer fixture password' } });
  await restarted.rpc('vault.export.begin', { vaultHandle: reopened.vaultHandle });
  await restarted.stop();
  assert.deepEqual(await exportDirectories(), [], 'Orderly shutdown must close file handles before deleting export data');
  assert.deepEqual(await persistentFiles(), before, 'Backup/crash/restart must preserve every working database and encrypted Blob byte');
  assert.equal(hash(await readFile(source)), evidence.sourceSha256);
  evidence.persistentFiles = before; evidence.phases.push('forced-exit-orphan-reclaimed-on-restart', 'normal-exit-cleans-export', 'database-and-13-blobs-byte-preserved');
  evidence.status = 'passed';
} catch (error) { evidence.error = String(error?.stack || error); process.exitCode = 1; }
finally {
  for (const instance of processes) await instance.stop(true);
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, output, phases: evidence.phases, error: evidence.error }, null, 2));
}
