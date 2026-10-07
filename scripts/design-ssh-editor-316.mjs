import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';

const file = new URL('../docs/design/android-interop-315.m3e.json', import.meta.url);
const doc = JSON.parse(await readFile(file, 'utf8'));
const ids = ['sshcompact316', 'sshadvanced316'];
doc.frames = doc.frames.filter(frame => !ids.includes(frame.id));
doc.groups = doc.groups.filter(group => !ids.includes(group.frameId));

for (const [index, id] of ids.entries()) {
  const x = 16000 + index * 500;
  doc.frames.push({ id, name: index ? 'SSH 高级设置 · 320px' : 'SSH 编辑 · 320px', x, y: 0, w: 320, h: 900 });
  let sequence = 0;
  const group = (y, items, inset = 24, gap = 12) => {
    if (items.some(item => item.kind === 'textField')) {
      items.forEach((item, n) => {
        const top = y + n * (56 + gap);
        const groupId = `${id}-${sequence++}`;
        const { supporting, ...field } = item;
        doc.groups.push({ id: groupId, frameId: id, x: x + inset, y: top, axis: 'y', gap: 4,
          items: [{ id: `${groupId}-field`, icon: null, variant: 'filled', size: 320 - inset * 2, ...field }] });
        if (item.kind === 'textField' && supporting) doc.groups.push({ id: `${groupId}-value`, frameId: id,
          x: x + inset + 16, y: top + 27, axis: 'y', gap: 4,
          items: [{ id: `${groupId}-text`, kind: 'text', label: supporting, icon: null, variant: 'filled', size: 14 }] });
      });
      return;
    }
    const groupId = `${id}-${sequence++}`;
    doc.groups.push({ id: groupId, frameId: id, x: x + inset, y, axis: 'y', gap,
      items: items.map((item, n) => ({ id: `${groupId}-${n}`, icon: null, variant: 'filled', size: 320 - inset * 2, ...item })) });
  };
  group(12, [{ kind: 'topAppBar', label: '编辑 SSH 密钥', icon: 'close' }], 12);
  if (!index) {
    group(110, [{ kind: 'textField', label: '名称 *', supporting: '工作服务器' },
      { kind: 'select', label: '保存到', tabs: [{ label: '我的 KeePass' }], selected: 0 }]);
    group(250, [{ kind: 'text', label: 'SSH 密钥', size: 14 }]);
    group(286, [{ kind: 'textField', label: 'OpenSSH 公钥', supporting: 'ssh-ed25519 AAAAC3NzaC1…' },
      { kind: 'textField', label: 'OpenSSH 私钥', supporting: '••••••••••••••••••••', trailingIcon: 'visibility' }]);
    group(450, [{ kind: 'listItem', label: '密钥信息与高级设置', icon: 'expand_more', radius: 16 }]);
    group(536, [{ kind: 'listItem', label: '补充信息', supporting: '笔记、自定义字段', icon: 'add', radius: 24 },
      { kind: 'textField', label: '备注', supporting: '密钥用途与恢复说明' }]);
  } else {
    group(110, [{ kind: 'listItem', label: '密钥信息与高级设置', icon: 'expand_less', radius: 16 }]);
    group(204, [{ kind: 'textField', label: '算法', supporting: 'ED25519' },
      { kind: 'textField', label: '密钥位数', supporting: '256' },
      { kind: 'textField', label: 'SHA-256 指纹', supporting: 'SHA256:synthetic' },
      { kind: 'textField', label: '注释', supporting: '工作服务器 · 2026' },
      { kind: 'textField', label: '格式', supporting: 'OpenSSH' }]);
    group(570, [{ kind: 'listItem', label: 'Android 原始元数据', icon: 'expand_more', radius: 16 }]);
    group(662, [{ kind: 'listItem', label: '补充信息', supporting: '笔记、自定义字段', icon: 'add', radius: 24 }]);
  }
  group(814, [{ kind: 'button', label: '加密保存', icon: 'check', radius: 28 }]);
}
await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
const url = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('../docs/design/ssh-editor-316.md', import.meta.url), `# SSH editor at narrow widths\n\nReference: Android AddEditSshKeyScreen delegates to the unified password editor; PasswordEditorSection uses one padded section around full-width fields. Retain Monica's teal M3E controls, Segoe UI / Microsoft YaHei UI text, 14px section labels and 16px inputs. No additional typeface or decorative card treatment.\n\nThe 320px editor uses 12px outer gutters and one 12px section inset. Expansion panels must not add their own 24px horizontal inset. Primary and advanced inputs share their left/right edges; 12px field gaps, 24px section corners, persistent top/bottom actions. Nested metadata stays optional and retains its full label. At desktop widths, keep the existing two-column field grid.\n\nFrames: sshcompact316 (collapsed) and sshadvanced316 (expanded). Use actual textField, select, listItem, topAppBar and button components; keep the native M3E focus, disclosure and error states.\n\n[Editable local Canvas](${url})\n\nSource: android-interop-315.m3e.json. Real Edge rendering and geometry evidence will be recorded after implementation.\n`);
console.log(JSON.stringify({ frames: ids, source: file.pathname }));
