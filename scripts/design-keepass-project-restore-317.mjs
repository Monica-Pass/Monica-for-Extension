import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const file = new URL('../docs/design/android-interop-315.m3e.json', import.meta.url);
const doc = JSON.parse(await readFile(file, 'utf8'));
const ids = ['keepassrestore317', 'keepassrestoreconflict317'];
const start = doc.frames.find(frame => frame.id === ids[0])?.x ?? Math.max(...doc.frames.map(frame => frame.x + frame.w)) + 120;
doc.frames = doc.frames.filter(frame => !ids.includes(frame.id));
doc.groups = doc.groups.filter(group => !ids.includes(group.frameId));
for (const [index, id] of ids.entries()) {
  const x = start + index * 440;
  doc.frames.push({ id, name: index ? 'KeePass 整组恢复 · 失败重试' : 'KeePass 整组恢复 · 成员确认', x, y: 0, w: 320, h: index ? 850 : 720 });
  let serial = 0;
  const control = (y, item) => { const key = `${id}-${serial++}`; doc.groups.push({ id: key, frameId: id, x: x + 12, y, axis: 'y', gap: 4,
    items: [{ id: key + '-control', icon: null, variant: 'filled', size: 296, ...item }] }); };
  control(12, {kind:'topAppBar',label:'恢复整个密码项目',icon:'close'});
  control(100, {kind:'listItem',label:'工作邮箱',supporting:'KeePass · 云端密码库',icon:'key',radius:24});
  control(185, {kind:'listItem',label:'回收站中的 3 个密码',supporting:'包含此项目较早删除的成员',icon:'restore',radius:24});
  control(270, {kind:'listItem',label:'工作账号',supporting:'2 个密码',icon:'person',radius:24});
  control(350, {kind:'listItem',label:'恢复账号',supporting:'1 个密码',icon:'person',radius:24});
  control(438, {kind:'listItem',label:'保留原始内容、分组与附件',supporting:'确认后加入同步队列',icon:'sync',radius:24});
  if (index) {
    control(530, {kind:'listItem',label:'项目成员已变化',supporting:'关闭后重新核对；密码已保留',icon:'error',radius:24});
    control(618, {kind:'button',label:'打开密码源',variant:'text'});
  }
  control(index ? 694 : 536, {kind:'button',label:index ? '重试这次恢复' : '确认整组恢复',variant:'filled'});
  control(index ? 762 : 604, {kind:'button',label:index ? '关闭' : '取消',variant:'text'});
}
await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('../docs/design/keepass-project-restore-317.md', import.meta.url), `# KeePass project restore\n\nReuse Monica's existing teal Material theme, Segoe UI/Microsoft YaHei, 12px insets, 24px outer and 4px adjoining corners, 48px actions. Confirmation → original project/source → restored account groups/counts → explicit older-deletion scope and queued-sync explanation → cancel/confirm. Active members remain unchanged; their current metadata is validated against restored members. No password values in the confirmation. Existing MDBX deletion-cohort wording is retained separately.\n\n[Editable local Canvas](${link})\n\nFrames: ${ids.join(', ')}.\n`);
