import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = JSON.parse(await readFile(resolve(root, 'docs/design/android-interop-315.m3e.json'), 'utf8'));
const frames = [
  { id: 'stacks317', name: '密码显示分组 · 420px', x: 0, y: 0, w: 420, h: 840 },
  { id: 'stackopen317', name: '展开网站组 · 420px', x: 480, y: 0, w: 420, h: 840 }
];
let next = 0;
const groups = [];
function group(frame, y, items) {
  groups.push({ id: `stacks-g${++next}`, frameId: frames[frame].id, x: frames[frame].x + 12, y, axis: 'y', gap: 4,
    items: items.map(item => ({ id: `stacks-i${++next}`, icon: null, variant: 'filled', size: 396, ...item })) });
}
for (let i = 0; i < 2; i++) {
  group(i, 20, [{ kind: 'topAppBar', label: '密码', icon: 'menu' }]);
  group(i, 96, [{ kind: 'searchBar', label: '搜索密码', icon: 'search' }]);
  group(i, 180, [{ kind: 'select', label: '显示分组', supporting: '按网站' }]);
  group(i, 264, [{ kind: 'select', label: '网站匹配', supporting: '完整域名' }]);
}
group(0, 368, [{ kind: 'listItem', label: 'example.test', supporting: '个人数据库 · 2 个项目 · 3 条密码', icon: 'expand_more', action: { to: 'stackopen317', transition: 'fade' } }]);
group(0, 456, [{ kind: 'listItem', label: '邮箱', supporting: 'mail@example.test · 个人数据库', icon: 'password' }]);
group(1, 368, [{ kind: 'listItem', label: 'example.test', supporting: '个人数据库 · 2 个项目 · 3 条密码', icon: 'expand_less', action: { to: 'stacks317', transition: 'fade' } }]);
group(1, 460, [{ kind: 'listItem', label: '个人账号', supporting: 'personal@example.test · 2 条密码 · 当前封面', icon: 'push_pin' },
  { kind: 'listItem', label: '工作账号', supporting: 'work@example.test · 1 条密码', icon: 'password' }]);
group(1, 638, [{ kind: 'button', label: '将工作账号设为封面', icon: 'push_pin' }]);
group(1, 722, [{ kind: 'listItem', label: '打开项目后管理密码、历史和附件', icon: 'chevron_right' }]);
const doc = { title: 'Monica · 密码显示分组与封面', brief: '显示分组与多密码项目独立。使用搜索、选择框、连续列表和折叠分组；同源项目才能归组。封面只修改同源且网站字符串相同的活动条目。', frame: 'phone', platform: 'web', paletteKey: 'teal', theme: base.theme, frames, groups };
const out = resolve(root, '.codex-tasks/android-interop-315/raw/password-stacks-canvas');
await mkdir(out, { recursive: true });
await writeFile(resolve(root, 'docs/design/password-stacks-317.m3e.json'), JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(resolve(root, 'docs/design/password-stacks-317.md'), `Editable local design: [Password display stacks](${link})\n\nSource: password-stacks-317.m3e.json. This is design evidence; application rendering is verified separately.\n`);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const frame of frames) {
    const page = await browser.newPage({ viewport: { width: 1060, height: 1020 } });
    await page.goto('http://127.0.0.1:5186/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(localStorage.getItem('m3e:doc')));
    const preview = { ...doc, frames: [{ ...frame, x: 0 }], groups: groups.filter(g => g.frameId === frame.id).map(g => ({ ...g, x: g.x - frame.x })) };
    await page.locator('input[type=file]').setInputFiles({ name: 'stacks.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preview)) });
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('m3e:doc') || '{}').frames?.[0]?.id === id || [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '确定'), frame.id);
    const confirm = page.getByRole('button', { name: '确定', exact: true });
    if (await confirm.isVisible()) await confirm.click();
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('m3e:doc') || '{}').frames?.[0]?.id === id, frame.id);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).waitFor();
    await page.screenshot({ path: resolve(out, `${frame.id}.png`), fullPage: true });
    await page.close();
  }
  await writeFile(resolve(out, 'render.json'), JSON.stringify({ browser: browser.version(), renderedAt: new Date().toISOString(), frames: frames.map(f => f.id) }, null, 2));
} finally { await browser.close(); }
