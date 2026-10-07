import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const template = JSON.parse(await readFile(new URL('../docs/design/passkey-unlock-317.m3e.json', import.meta.url), 'utf8'));
const doc = { ...template, title: 'Monica · OneDrive 数据库', brief: '插件内登录 Microsoft，选择已有 KDBX，连接后自动同步。沿用 Android 数据库管理的 12px 留白、24px 外侧与 4px 相邻圆角；实际表单、列表、按钮。没有密码或令牌明文。', frames: [], groups: [] };
function page(id, name, x, w, h) {
  doc.frames.push({ id, name, x, y: 0, w, h });
  let index = 0;
  return (y, item) => {
    const key = `${id}-${index++}`;
    doc.groups.push({ id: key, frameId: id, x: x + 12, y, axis: 'y', gap: 4, items: [{ id: `${key}-control`, icon: null, variant: 'filled', size: w - 24, radius: 24, ...item }] });
  };
}
const login = page('onedrivelogin317', '连接 OneDrive · 登录与凭据', 0, 420, 960);
login(12, { kind: 'topAppBar', label: '连接 KeePass', icon: 'close' });
login(94, { kind: 'select', label: '数据库来源', tabs: ['本地文件', 'WebDAV', 'OneDrive'].map(label => ({ label, icon: null })), selected: 2 });
login(180, { kind: 'textField', label: '显示名称', placeholder: '个人密码库', icon: 'database' });
login(274, { kind: 'listItem', label: 'Microsoft 账号', supporting: '登录后选择云端数据库', icon: 'account_circle' });
login(358, { kind: 'button', label: '登录 Microsoft 账号', icon: 'login' });
login(452, { kind: 'button', label: '选择数据库', icon: 'folder_open', variant: 'tonal', note: '登录前禁用，登录后可浏览文件。' });
login(548, { kind: 'textField', label: '数据库密码（可留空）', placeholder: '输入 KDBX 密码', icon: 'password' });
login(644, { kind: 'button', label: '选择密钥文件（可选）', icon: 'key', variant: 'tonal' });
login(732, { kind: 'checkbox', label: '设为默认保存目标' });
login(800, { kind: 'button', label: '连接并解锁', icon: 'lock_open', note: '尚未选择数据库时禁用。' });
login(872, { kind: 'button', label: '取消', variant: 'text' });
const files = page('onedrivefiles317', '选择 OneDrive 数据库 · 浏览与搜索', 500, 420, 860);
files(12, { kind: 'topAppBar', label: '选择数据库', icon: 'arrow_back', icon2: 'close' });
files(94, { kind: 'listItem', label: 'test@example.invalid', supporting: 'OneDrive / 密码库', icon: 'cloud' });
files(180, { kind: 'searchBar', label: '搜索当前文件夹', icon: 'search' });
files(270, { kind: 'listItem', label: '上一级', icon: 'drive_folder_upload', radius: 4, corners: { tl: 24, tr: 24, bl: 4, br: 4 } });
files(346, { kind: 'listItem', label: '家庭', supporting: '文件夹', icon: 'folder', icon2: 'chevron_right', radius: 4 });
files(422, { kind: 'listItem', label: '个人密码库.kdbx', supporting: '192 KB', icon: 'database', icon2: 'radio_button_checked', radius: 4 });
files(498, { kind: 'listItem', label: '工作账号.kdbx', supporting: '640 KB', icon: 'database', icon2: 'radio_button_unchecked', radius: 4, corners: { tl: 4, tr: 4, bl: 24, br: 24 } });
files(616, { kind: 'button', label: '使用这个数据库', icon: 'check' });
files(700, { kind: 'button', label: '刷新', icon: 'refresh', variant: 'tonal' });
files(776, { kind: 'button', label: '取消', variant: 'text' });
const status = page('onedrivestatus317', 'OneDrive 密码源 · 320px', 1000, 320, 760);
status(12, { kind: 'topAppBar', label: '密码源', icon: 'arrow_back' });
status(96, { kind: 'listItem', label: '个人密码库', supporting: 'OneDrive · 个人密码库.kdbx', icon: 'database' });
status(188, { kind: 'listItem', label: '连接状态', supporting: '已解锁', icon: 'lock_open', radius: 4, corners: { tl: 24, tr: 24, bl: 4, br: 4 } });
status(264, { kind: 'listItem', label: '离线访问', supporting: '可用', icon: 'offline_pin', radius: 4 });
status(340, { kind: 'listItem', label: '云端保存', supporting: '已同步', icon: 'cloud_done', radius: 4, corners: { tl: 4, tr: 4, bl: 24, br: 24 } });
status(450, { kind: 'button', label: '立即同步', icon: 'sync' });
status(538, { kind: 'button', label: '管理分组', icon: 'folder_managed', variant: 'tonal' });
status(626, { kind: 'button', label: '管理 KeePass', icon: 'settings', variant: 'text' });
const expired = page('onedriveexpired317', '登录失效 · 保留本机修改', 1400, 420, 670);
expired(12, { kind: 'topAppBar', label: '管理 KeePass', icon: 'close' });
expired(96, { kind: 'listItem', label: '个人密码库.kdbx', supporting: 'test@example.invalid', icon: 'database' });
expired(190, { kind: 'listItem', label: '需要重新登录 OneDrive', supporting: '本机修改已保留，登录后继续同步', icon: 'cloud_off' });
expired(292, { kind: 'button', label: '重新登录', icon: 'login' });
expired(396, { kind: 'listItem', label: '离线访问', supporting: '仍可查看和编辑本机数据库', icon: 'offline_pin' });
expired(510, { kind: 'button', label: '关闭', variant: 'text' });
// Canvas list corner overrides use radiusTop/radiusBottom, not the box-only corners field.
for (const group of doc.groups) for (const item of group.items) {
  if (item.kind === 'listItem') {
    item.radiusTop = item.corners?.tl ?? item.radius ?? 24;
    item.radiusBottom = item.corners?.bl ?? item.radius ?? 24;
  }
  delete item.corners;
  delete item.radius;
  delete item.placeholder;
}
// A continuous list must be one Canvas group; isolated groups always render standalone shapes.
for (const [frameId, start, end] of [['onedrivefiles317', 270, 498], ['onedrivestatus317', 188, 340]]) {
  const run = doc.groups.filter(group => group.frameId === frameId && group.y >= start && group.y <= end);
  const first = run[0];
  first.items = run.flatMap(group => group.items);
  doc.groups = doc.groups.filter(group => !run.includes(group) || group === first);
}
const json = JSON.stringify(doc, null, 2) + '\n';
await writeFile(new URL('../docs/design/onedrive-317.m3e.json', import.meta.url), json);
const url = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(json).toString('base64url');
await writeFile(new URL('../docs/design/onedrive-317.md', import.meta.url), `# OneDrive 数据库连接\n\n沿用 Monica Android 数据库管理布局：左右 12px，连续列表外侧 24px、相邻 4px，操作 48px 起。保留现有 Segoe UI / Microsoft YaHei，标题 24px、正文 16px、说明 14px；使用现有青绿主题（主色 #008577、背景 #f4faf7、容器 #e5f1ec、正文 #153a31、辅助文字 #50665f）。\n\n登录、浏览文件、选中、解锁分开呈现；账号切换和对话框取消会丢弃旧文件选择。网络结果绑定当前登录与当前文件夹；过期结果不得改写界面。重新登录只更新同一账号的授权，不能重新下载并覆盖待同步修改。已选文件的名称与账号始终可读，连接后复用离线访问与云端保存状态。实际文件协议与开发者应用配置只出现在错误帮助中。\n\n[本地可编辑 Canvas](${url})\n\n源文件：onedrive-317.m3e.json。设计尚需实际界面实现与验收。\n`);
