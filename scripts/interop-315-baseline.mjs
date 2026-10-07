import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';

const extension = resolve(import.meta.dirname, '..');
const android = resolve(extension, '../Monica-main');
const output = resolve(extension, '.codex-tasks/android-interop-315/raw', process.argv[2] || 'baseline.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
const repositories = {};
for (const [name, cwd] of Object.entries({ extension, android })) {
  const paths = [...new Set(git(cwd, ['ls-files', '--modified', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean))];
  const files = {};
  for (const path of paths) {
    try { files[path] = hash(await readFile(resolve(cwd, path))); }
    catch (error) { if (error.code === 'ENOENT') files[path] = 'deleted'; else throw error; }
  }
  repositories[name] = { head: git(cwd, ['rev-parse', 'HEAD']).toString().trim(), diffSha256: hash(git(cwd, ['diff', '--binary', 'HEAD'])), statusSha256: hash(git(cwd, ['status', '--porcelain=v1', '-uall'])), files };
}
const declarations = JSON.parse(await readFile(resolve(android, 'docs/storage/MONICA-ANDROID-DATA-MODELS-1.0.315.sources.json'), 'utf8'));
const sourceChecks = {};
for (const [path, expected] of Object.entries(declarations.sourceSha256)) {
  const bytes = await readFile(resolve(android, 'Monica for Android/app/src/main/java/takagi/ru/monica', path));
  sourceChecks[path] = { expected, actual: hash(bytes), lfSha256: hash(bytes.toString().replace(/\r\n/g, '\n')) };
}
const provenancePath = resolve(android, 'Monica for Android/mdbx-engine/MDBX3_RUNTIME_PROVENANCE.json');
const provenanceBytes = await readFile(provenancePath);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ at: new Date().toISOString(), node: process.version, repositories, sourceChecks, androidRuntime: JSON.parse(provenanceBytes), provenanceSha256: hash(provenanceBytes) }, null, 2));
console.log(JSON.stringify({ output, changedFiles: Object.fromEntries(Object.entries(repositories).map(([k,v]) => [k, Object.keys(v.files).length])), declarationMismatches: Object.entries(sourceChecks).filter(([,v]) => v.actual !== v.expected && v.lfSha256 !== v.expected).map(([k]) => k) }));
