import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.tmp/android-passkey-fixes-317');
try { await stat(path.join(out, 'source-baseline.json')); throw new Error('Baseline already exists; preserve it'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const files = ['passkey/PasskeyCredentialIdCodec.kt', 'passkey/MonicaCredentialProviderService.kt', 'passkey/PasskeyAuthActivity.kt',
  'data/PasskeyEntry.kt', 'data/PasskeyDao.kt', 'data/PasswordDatabase.kt', 'repository/PasskeyRepository.kt',
  'keepass/KeePassPasskeySyncCodec.kt', 'bitwarden/mapper/PasskeyMapper.kt'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const records = [];
for (const [label, project] of [['main', '../Monica-main/Monica for Android'], ['fdroid', '../Monica-main/fdroid']]) {
  for (const file of files) {
    const source = path.resolve(root, project, 'app/src/main/java/takagi/ru/monica', file);
    const bytes = await readFile(source), saved = path.join(out, 'original', label, file);
    await mkdir(path.dirname(saved), { recursive: true }); await writeFile(saved, bytes);
    records.push({ label, file, source, saved, sha256: hash(bytes) });
  }
}
const git = args => execFileSync('git', args, { cwd: path.resolve(root, '../Monica-main'), maxBuffer: 32 * 1024 * 1024 });
await writeFile(path.join(out, 'source-baseline.json'), JSON.stringify({ at: new Date().toISOString(),
  head: git(['rev-parse','HEAD']).toString().trim(), statusSha256: hash(git(['status','--porcelain=v1','-uall'])),
  diffSha256: hash(git(['diff','--binary','HEAD'])), records }, null, 2));
console.log(JSON.stringify({ files: records.length, differencesBetweenVariants: files.filter(file => {
  const matches = records.filter(row => row.file === file); return matches[0].sha256 !== matches[1].sha256;
}) }));
