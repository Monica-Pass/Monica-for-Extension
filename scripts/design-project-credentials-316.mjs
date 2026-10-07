import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const source = new URL('../docs/design/android-interop-315.m3e.json', import.meta.url);
const doc = JSON.parse(await readFile(source, 'utf8'));
const id = 'projectcredentials316'; const x = 18000; const width = 320;
doc.frames = doc.frames.filter(frame => frame.id !== id);
doc.groups = doc.groups.filter(group => group.frameId !== id);
doc.frames.push({ id, name: '多凭据组 · 编辑 · 320px', x, y: 0, w: width, h: 1120 });
let serial = 0;
function row(y, item, inset = 12) {
  const groupId = `${id}-${serial++}`;
  doc.groups.push({ id: groupId, frameId: id, x: x + inset, y, axis: 'y', gap: 4,
    items: [{ id: `${groupId}-control`, icon: null, variant: 'filled', size: width - inset * 2, ...item }] });
}
function input(y, label, value, radius = 4, secret = false) {
  row(y, { kind: 'textField', label, radius, ...(secret ? { trailingIcon: 'visibility' } : {}) });
  row(y + 27, { kind: 'text', label: value, size: 14 }, 28);
}
row(12, { kind: 'topAppBar', label: '编辑密码项目', icon: 'close' });
input(108, '项目名称', '工作服务', 24);
row(182, { kind: 'text', label: '主要凭据', size: 16 });
input(214, '用户名', 'work@example.com', 24);
input(274, '密码 1', '••••••••••••', 4, true);
input(334, '密码 2', '••••••••••••', 4, true);
input(394, '验证码密钥或链接', 'otpauth://totp/工作服务…', 24, true);
row(464, { kind: 'button', label: '添加密码', icon: 'add', variant: 'tonal', radius: 24 });
row(540, { kind: 'text', label: '其他凭据', size: 16 });
input(574, '凭据组名称', '恢复账号', 24);
input(634, '用户名', 'recovery@example.com');
input(694, '密码', '••••••••••••', 4, true);
input(754, '验证码密钥或链接', '可选', 24, true);
row(824, { kind: 'button', label: '添加密码', icon: 'add', variant: 'tonal', radius: 24 });
row(902, { kind: 'listItem', label: '添加凭据组', icon: 'add', radius: 24 });
row(986, { kind: 'button', label: '加密保存', icon: 'check', radius: 28 });
row(1050, { kind: 'button', label: '取消', variant: 'text', radius: 28 });
await writeFile(source, JSON.stringify(doc, null, 2) + '\n');
const url = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('../docs/design/project-credentials-316.md', import.meta.url), `# Project credential editor\n\nUse Monica Android's credential grouping: one username, several independently protected passwords, then the shared OTP. The primary group comes first; subsequent groups have editable labels and follow Android groupOrder. Each record retains its own identity and password.\n\nRetain Monica teal surface tokens, Segoe UI / Microsoft YaHei UI, 16px inputs, 12px page insets, 24px outside corners and 4px joins. One column at 320px, no nested horizontal padding. Adding passwords stays within its group; adding a group creates a separate shared username/OTP pair. Save/Cancel commit or discard the whole draft. A conflicting legacy group must keep every value visible for explicit resolution, never silently pick a winner.\n\nCritique: the former account-per-record form misrepresented multiple passwords as multiple accounts. This draft uses the group boundary to convey shared identity. No decorative cards or technical JSON in the normal flow. Scroll long projects while keeping native editor actions accessible. Existing member removal must be explicit and separately verified; no implicit deletion during save.\n\n[Editable local Canvas](${url})\n\nFrame: projectcredentials316. This is the design target; the browser form is not yet implemented. The current product fix reconciles shared-field edits on existing groups during atomic save.\n`);
