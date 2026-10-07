import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const source = JSON.parse(await readFile('docs/design/keepass-resolution-317.m3e.json', 'utf8'));
const doc = { ...source, title: 'Monica · 恢复副本', brief: '沿用青绿色、系统字体、12px留白和连续分组。按日期选择副本，独立密码导出，明确删除范围。', frames: [], groups: [] };
function frame(id, name, x, height) {
  doc.frames.push({ id, name, x, y: 0, w: 360, h: height }); let serial = 0;
  return (y, item) => { const group = `${id}-${serial++}`; doc.groups.push({ id: group, frameId: id, x: x + 12, y, axis: 'y', gap: 4,
    items: [{ id: `${group}-control`, icon: null, size: 336, variant: 'filled', radius: 24, ...item }] }); };
}
const list = frame('recoverylist317', '恢复副本', 0, 680);
list(12, { kind: 'topAppBar', label: '恢复副本', icon: 'arrow_back', icon2: 'refresh' });
list(104, { kind: 'listItem', label: '个人 KeePass 密码库', supporting: '冲突处理前后的完整版本', icon: 'restore' });
list(202, { kind: 'listItem', label: '2026/10/06 20:30', supporting: '已完成 · 可导出或删除', icon: 'history' });
list(282, { kind: 'button', label: '导出加密副本', icon: 'download', variant: 'tonal' });
list(350, { kind: 'button', label: '删除此副本', icon: 'delete', variant: 'text' });
list(432, { kind: 'listItem', label: '2026/10/06 19:15', supporting: '操作未完成 · 暂不能删除', icon: 'pending_actions' });
list(520, { kind: 'button', label: '导出加密副本', icon: 'download', variant: 'tonal' });
const exp = frame('recoveryexport317', '导出加密副本', 460, 700);
exp(12, { kind: 'topAppBar', label: '导出加密副本', icon: 'arrow_back' });
exp(110, { kind: 'listItem', label: '2026/10/06 20:30', supporting: '包含原始、编辑、远端和处理后的版本', icon: 'encrypted' });
exp(214, { kind: 'textField', label: '导出密码', supporting: '至少 8 个字符，请妥善保管', icon: 'lock' });
exp(316, { kind: 'textField', label: '再次输入密码', icon: 'lock' });
exp(428, { kind: 'listItem', label: '使用 KeePass 打开导出的文件', supporting: '文件内包含恢复说明与原密码库附件', icon: 'info' });
exp(540, { kind: 'button', label: '生成并下载', icon: 'download' });
exp(614, { kind: 'button', label: '取消', variant: 'text' });
const del = frame('recoverydelete317', '删除恢复副本', 920, 520);
del(12, { kind: 'topAppBar', label: '删除此恢复副本？', icon: 'arrow_back' });
del(114, { kind: 'listItem', label: '2026/10/06 20:30', supporting: '建议先导出需要保留的版本', icon: 'history' });
del(218, { kind: 'listItem', label: '只删除这一份恢复副本', supporting: '当前密码库和其他副本保持不变', icon: 'info' });
del(338, { kind: 'button', label: '保留副本', variant: 'tonal' });
del(416, { kind: 'button', label: '确认删除', variant: 'text', icon: 'delete' });
await writeFile('docs/design/keepass-recovery-317.m3e.json', JSON.stringify(doc, null, 2) + '\n');
const url = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile('docs/design/keepass-recovery-317.md', `# 恢复副本管理\n\n按日期选择，单独密码导出完整 KDBX，未完成操作禁止删除。延续原生连续分组、12px留白与48px操作目标。\n\n[本地可编辑 Canvas](${url})\n`);
