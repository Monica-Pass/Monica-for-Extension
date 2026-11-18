import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build outside the directory registered with the browser. Never empty or
// rename dist: unpacked extensions may be read while the browser starts.
export async function withStagedBuild(root, build, checkpoint = async () => {}) {
  const scratch = join(root, '.tmp');
  await mkdir(scratch, { recursive: true });
  const lockPath = join(scratch, 'extension-build.lock');
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('Another extension build owns .tmp/extension-build.lock. If it crashed, confirm that process has stopped before removing the lock.');
    throw error;
  });
  let stage;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    stage = await mkdtemp(join(scratch, 'extension-build-'));
    await build(stage);
    await publish(stage, join(root, 'dist'), scratch, checkpoint);
  } finally {
    try { if (stage) await removeScratch(stage, scratch); }
    finally { await lock.close(); await rm(lockPath); }
  }
}

async function removeScratch(directory, scratch) {
  const resolved = await realpath(directory), parent = await realpath(scratch);
  if (dirname(resolved) !== parent || !/^extension-(build|publish)-/.test(relative(parent, resolved))) throw new Error(`Refusing to clean unexpected build scratch directory: ${resolved}`);
  await rm(resolved, { recursive: true, force: true });
}

async function listFiles(directory) {
  const rootStat = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!rootStat) return [];
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Refusing linked or non-directory build output: ${directory}`);
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = join(current, entry.name), entryStat = await lstat(target);
      if (entryStat.isSymbolicLink()) throw new Error(`Refusing linked build output: ${target}`);
      if (entryStat.isDirectory()) await visit(target);
      else if (entryStat.isFile()) files.push(relative(directory, target));
      else throw new Error(`Refusing non-file build output: ${target}`);
    }
  }
  await visit(directory);
  return files;
}

async function validateManifest(stage, files) {
  const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || !manifest.version || !manifest.key) throw new Error('Invalid staged extension manifest.');
  const paths = [manifest.background?.service_worker, manifest.action?.default_popup, manifest.options_page,
    manifest.side_panel?.default_path, ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])])];
  if (manifest.default_locale) paths.push(`_locales/${manifest.default_locale}/messages.json`);
  const names = new Set(files);
  for (const path of paths.filter(Boolean)) {
    const clean = path.split(/[?#]/, 1)[0];
    const name = relative(stage, resolve(stage, clean));
    if (!clean || clean.includes('\0') || isAbsolute(clean) || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) throw new Error(`Invalid manifest path outside build output: ${path}`);
    if (!names.has(name)) throw new Error(`Staged extension is missing ${path}`);
  }
}

async function publish(stage, destination, scratch, checkpoint) {
  const next = await listFiles(stage);
  await validateManifest(stage, next);
  const previous = await listFiles(destination);
  const nextSet = new Set(next), previousSet = new Set(previous);
  const transaction = await mkdtemp(join(scratch, 'extension-publish-'));
  const pending = join(transaction, 'pending'), backup = join(transaction, 'backup');
  let retainRecovery = false;
  const replaced = [], removed = [];
  try {
    // Prepare all replacement bytes and rollback copies before touching dist.
    for (const file of next) {
      await mkdir(dirname(join(pending, file)), { recursive: true });
      await copyFile(join(stage, file), join(pending, file));
    }
    for (const file of previous) {
      await mkdir(dirname(join(backup, file)), { recursive: true });
      await copyFile(join(destination, file), join(backup, file));
    }
    const priority = file => file === 'manifest.json' ? 2 : file.endsWith('.html') ? 1 : 0;
    next.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b, 'en'));
    await checkpoint({ phase: 'prepared' });
    await mkdir(destination, { recursive: true });
    try {
      for (const file of next) {
        await mkdir(dirname(join(destination, file)), { recursive: true });
        // Same-volume rename replaces a complete file; never unlink first.
        await rename(join(pending, file), join(destination, file));
        replaced.push(file);
        await checkpoint({ phase: 'replaced', file });
      }
      // Prune only after all current references exist. Packaging sees exactly
      // the current build, without accumulating old hashed JS or helper ZIPs.
      for (const file of previous.filter(file => !nextSet.has(file))) {
        await rm(join(destination, file)); removed.push(file);
      }
      await checkpoint({ phase: 'complete' });
    } catch (error) {
      try {
        // Restore dependencies before the old manifest; retire new-only files
        // afterwards so both manifests keep their referenced files available.
        for (const file of [...removed, ...replaced.filter(file => previousSet.has(file))].sort((a, b) => priority(a) - priority(b))) {
          await rename(join(backup, file), join(destination, file));
        }
        for (const file of replaced.filter(file => !previousSet.has(file))) await rm(join(destination, file));
      } catch (rollbackError) {
        retainRecovery = true;
        throw new AggregateError([error, rollbackError], `Build publication and rollback failed; recovery files retained at ${transaction}`, { cause: rollbackError });
      }
      throw error;
    }
  } finally {
    if (!retainRecovery) await removeScratch(transaction, scratch);
  }
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  const require = createRequire(import.meta.url);
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await withStagedBuild(root, async stage => {
    const env = { ...process.env, MONICA_BUILD_OUT_DIR: stage };
    function run(script, args = []) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Build step failed: ${script} (${result.signal || result.status})`);
    }
    run('scripts/build-identity.mjs');
    run(npmCli, ['run', 'check']);
    run('scripts/verify-icon-font.mjs');
    run(join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), ['build']);
    run('scripts/build-workers.mjs');
    run('scripts/verify-extension-pages.mjs');
  });
  console.log('Published verified extension to dist without clearing its registered directory.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
