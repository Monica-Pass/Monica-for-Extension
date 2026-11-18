import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStagedBuild } from './build-extension.mjs';

async function files(root) {
  const result = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) result[join(entry.parentPath, entry.name).slice(root.length + 1)] = await readFile(join(entry.parentPath, entry.name), 'utf8');
  }
  return result;
}
async function seed(root, revision) {
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Synthetic test', version: '1.0.1', key: 'fixed-test-identity', background: { service_worker: 'background.js' }, content_scripts: [{ js: ['content.js'] }], action: { default_popup: 'popup.html' } }));
  await writeFile(join(root, 'background.js'), `background ${revision}`);
  await writeFile(join(root, 'content.js'), `content ${revision}`);
  await writeFile(join(root, 'popup.html'), `<script src="assets/${revision}.js"></script>`);
  await writeFile(join(root, 'assets', `${revision}.js`), revision);
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'monica-build-test-'));
  try { await seed(join(root, 'dist'), 'old'); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('compiler failure leaves the complete previous extension byte-identical', () => fixture(async root => {
  const before = await files(join(root, 'dist'));
  await assert.rejects(withStagedBuild(root, async stage => {
    await seed(stage, 'partial');
    assert.deepEqual(await files(join(root, 'dist')), before);
    throw new Error('synthetic compiler failure');
  }), /synthetic compiler failure/);
  assert.deepEqual(await files(join(root, 'dist')), before);
  assert.deepEqual(await readdir(join(root, '.tmp')), []);
}));

test('successful publication keeps required paths readable and removes stale files', () => fixture(async root => {
  let expected;
  const checkpoints = [];
  await withStagedBuild(root, async stage => { await seed(stage, 'new'); expected = await files(stage); }, async event => {
    checkpoints.push(event);
    for (const name of ['manifest.json', 'background.js', 'content.js', 'popup.html']) assert.ok(await readFile(join(root, 'dist', name)));
    const html = await readFile(join(root, 'dist', 'popup.html'), 'utf8');
    await readFile(join(root, 'dist', /src="([^"]+)"/.exec(html)[1]));
  });
  assert.deepEqual(await files(join(root, 'dist')), expected);
  assert.equal(checkpoints.filter(event => event.phase === 'replaced').at(-1).file, 'manifest.json');
}));

test('replacement failure rolls back applied files and leaves the old extension complete', () => fixture(async root => {
  const before = await files(join(root, 'dist'));
  await assert.rejects(withStagedBuild(root, stage => seed(stage, 'new'), event => {
    if (event.phase === 'replaced' && event.file === 'background.js') throw new Error('synthetic locked file');
  }), /synthetic locked file/);
  assert.deepEqual(await files(join(root, 'dist')), before);
}));

test('an incomplete extension never replaces the installed build', () => fixture(async root => {
  const before = await files(join(root, 'dist'));
  for (const missing of ['manifest.json', 'background.js', 'content.js', 'popup.html']) {
    await assert.rejects(withStagedBuild(root, async stage => { await seed(stage, 'new'); await rm(join(stage, missing)); }));
    assert.deepEqual(await files(join(root, 'dist')), before);
  }
}));

test('a concurrent build cannot write or remove another build staging directory', () => fixture(async root => {
  await withStagedBuild(root, async stage => {
    await assert.rejects(withStagedBuild(root, other => seed(other, 'racing')), /Another extension build/);
    await seed(stage, 'new');
  });
  assert.equal(await readFile(join(root, 'dist', 'background.js'), 'utf8'), 'background new');
}));

test('manifest traversal and linked output are refused without changing the destination', () => fixture(async root => {
  const before = await files(join(root, 'dist'));
  await assert.rejects(withStagedBuild(root, async stage => {
    await seed(stage, 'new');
    const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
    manifest.background.service_worker = '../outside.js';
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest));
  }), /outside|Invalid/);
  assert.deepEqual(await files(join(root, 'dist')), before);
  await mkdir(join(root, 'outside'));
  await assert.rejects(withStagedBuild(root, async stage => {
    await seed(stage, 'new');
    await symlink(join(root, 'outside'), join(stage, 'linked'), 'junction');
  }), /link/);
  assert.deepEqual(await files(join(root, 'dist')), before);
}));
