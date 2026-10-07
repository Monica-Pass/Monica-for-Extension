import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const source = JSON.parse(await readFile(new URL('../docs/design/android-interop-315.m3e.json', import.meta.url), 'utf8'));
const doc = { ...source, frames: [], groups: [] };
function frame(id, name, x, h) {
  doc.frames.push({ id, name, x, y: 0, w: 360, h });
  let serial = 0;
  return (y, item) => { const group = `${id}-${serial++}`; doc.groups.push({ id: group, frameId: id, x: x + 12, y, axis: 'y', gap: 4,
    items: [{ id: `${group}-control`, icon: null, size: 336, variant: 'filled', radius: 24, ...item }] }); };
}
const review = frame('keepassremove317', 'KeePass · 确认移除', 0, 650);
review(12, { kind: 'topAppBar', label: '确认移除密码', icon: 'arrow_back' });
review(108, { kind: 'listItem', label: '工作账号 · 密码 1', supporting: '移入回收站', icon: 'key' });
review(184, { kind: 'listItem', label: '保留 2 个密码', supporting: '共享内容与附件一起保留', icon: 'inventory_2' });
review(274, { kind: 'listItem', label: '个人 KeePass 密码库', supporting: '保存后自动同步到其他设备', icon: 'cloud_sync' });
review(376, { kind: 'button', label: '确认移除并保存', icon: 'check' });
review(446, { kind: 'button', label: '返回编辑', variant: 'text' });
const pending = frame('keepassremoverecovery317', 'KeePass · 恢复未完成操作', 460, 710);
pending(12, { kind: 'topAppBar', label: '未完成的密码移除', icon: 'arrow_back', icon2: 'refresh' });
pending(112, { kind: 'listItem', label: '工作邮箱', supporting: '个人 KeePass 密码库', icon: 'key' });
pending(188, { kind: 'listItem', label: '正在核对保存结果', supporting: '中断后可以继续，无需再次移除', icon: 'pending_actions' });
pending(280, { kind: 'button', label: '核对并继续', icon: 'restore', variant: 'tonal' });
pending(394, { kind: 'listItem', label: '恢复账号', supporting: '等待保存，可以取消', icon: 'schedule' });
pending(478, { kind: 'button', label: '核对并继续', icon: 'restore', variant: 'tonal' });
pending(548, { kind: 'button', label: '取消这次移除', icon: 'undo', variant: 'text' });
await writeFile(new URL('../docs/design/keepass-removal-317.m3e.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('../docs/design/keepass-removal-317.md', import.meta.url), `# KeePass member removal\n\nReuse the existing password removal review and joined recovery rows. Keep 12px margins and native listItem/button controls. A writing operation has Continue but no ambiguous Cancel; staged operations retain Cancel. Local save is followed by automatic synchronization, not a claim of remote completion.\n\n[Editable local Canvas](${link})\n`);
