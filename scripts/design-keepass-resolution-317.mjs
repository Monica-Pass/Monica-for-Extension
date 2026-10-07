import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const source = JSON.parse(await readFile(new URL('../docs/design/keepass-removal-317.m3e.json', import.meta.url), 'utf8'));
const doc = { ...source, title: 'Monica · KeePass 项目冲突', brief: '现有青绿色主题、系统字体、12px留白，24px外角与4px相邻圆角。逐项目明确选择，本地接纳后另行同步；中断恢复不能误报成功。', frames: [], groups: [] };
function frame(id, name, x, h) {
  doc.frames.push({ id, name, x, y: 0, w: 360, h }); let serial = 0;
  return (y, item) => { const group = `${id}-${serial++}`; doc.groups.push({ id: group, frameId: id, x: x + 12, y, axis: 'y', gap: 4,
    items: [{ id: `${group}-control`, icon: null, size: 336, variant: 'filled', radius: 24, ...item }] }); };
}
const review = frame('keepassresolve317', '选择保留版本', 0, 840);
review(12, { kind: 'topAppBar', label: '处理项目冲突', icon: 'arrow_back' });
review(104, { kind: 'listItem', label: '个人 KeePass 密码库', supporting: '选择每个项目要保留的完整版本', icon: 'cloud_sync' });
review(194, { kind: 'listItem', label: '工作账号', supporting: '共享字段、密码与附件一起保留', icon: 'key' });
review(272, { kind: 'listItem', label: '本机版本 · 2 个密码', supporting: '新增 0 · 修改 1 · 移除 1', icon: 'devices' });
review(350, { kind: 'listItem', label: '远端版本 · 3 个密码', supporting: '新增 1 · 修改 1 · 移除 0', icon: 'cloud' });
review(444, { kind: 'select', label: '保留的版本', options: ['请选择', '保留本机版本', '保留远端版本'] });
review(550, { kind: 'listItem', label: '原始版本会保留为加密恢复副本', supporting: '完成后仍需同步到其他设备', icon: 'restore' });
review(660, { kind: 'button', label: '确认选择并保存', icon: 'check' });
review(734, { kind: 'button', label: '返回', variant: 'text' });
const pending = frame('keepassresolverecovery317', '恢复冲突处理', 460, 640);
pending(12, { kind: 'topAppBar', label: '未完成的冲突处理', icon: 'arrow_back', icon2: 'refresh' });
pending(110, { kind: 'listItem', label: '个人 KeePass 密码库', supporting: '需要核对文件保存结果', icon: 'pending_actions' });
pending(210, { kind: 'button', label: '核对并继续', icon: 'restore', variant: 'tonal' });
pending(286, { kind: 'button', label: '检查并取消', icon: 'undo', variant: 'text' });
pending(380, { kind: 'listItem', label: '只有文件尚未提交时才能取消', supporting: '原文件、当前编辑与恢复副本均保留', icon: 'info' });
pending(486, { kind: 'button', label: '重新查看冲突', icon: 'refresh', variant: 'tonal' });
await writeFile(new URL('../docs/design/keepass-resolution-317.m3e.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n');
const url = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('../docs/design/keepass-resolution-317.md', import.meta.url), `# KeePass project conflict resolution\n\nUses existing Monica colors/type, joined groups and12px insets. Explicit per-project selection; no preselected destructive choice. Safe summaries show member changes, with full project selection preserving native attachments/history. Recovery checks cancellation eligibility on the server. Completion is local; publication is separate.\n\n[Editable local Canvas](${url})\n`);
