import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = JSON.parse(await readFile(resolve(root, 'docs/design/android-interop-315.m3e.json'), 'utf8'));
const frames = [
 { id: "manualstack317", name: "管理堆叠 · 420px", x: 0, y: 0, w: 420, h: 880 },
 { id: "manualresult317", name: "手动堆叠结果 · 420px", x: 480, y: 0, w: 420, h: 880 }
];
let next = 0;
const groups = [];
function group(frame, y, items) {
 groups.push({ id: `manual-g${++next}`, frameId: frames[frame].id, x: frames[frame].x + 12, y, axis: "y", gap: 4,
 items: items.map(item => ({ id: `manual-i${++next}`, icon: null, variant: "filled", size: 396, ...item })) });
}
group(0,20,[{kind:"topAppBar",label:"管理密码堆叠",icon:"close"}]);
group(0,96,[{kind:"select",label:"堆叠操作",supporting:"合并为手动堆叠"}]);
group(0,180,[{kind:"searchBar",label:"搜索项目",icon:"search"}]);
group(0,270,[{kind:"listItem",label:"个人账号",supporting:"personal@example.test · 2 条密码 · 已选择",icon:"check_circle"},
 {kind:"listItem",label:"工作账号",supporting:"work@example.test · 1 条密码 · 已选择",icon:"check_circle"},
 {kind:"listItem",label:"邮箱",supporting:"mail@example.test · 1 条密码",icon:"radio_button_unchecked"}]);
group(0,616,[{kind:"button",label:"应用到 2 个项目",icon:"done"}]);
group(0,694,[{kind:"button",label:"取消",variant:"text"}]);
group(1,20,[{kind:"topAppBar",label:"密码",icon:"menu"}]);
group(1,96,[{kind:"searchBar",label:"搜索密码",icon:"search"}]);
group(1,180,[{kind:"select",label:"显示分组",supporting:"按网站"}]);
group(1,270,[{kind:"button",label:"管理堆叠",icon:"tune"}]);
group(1,366,[{kind:"listItem",label:"个人账号",supporting:"手动堆叠 · 2 个项目 · 3 条密码",icon:"expand_less"}]);
group(1,464,[{kind:"listItem",label:"个人账号",supporting:"personal@example.test · 2 条密码",icon:"password"},
 {kind:"listItem",label:"工作账号",supporting:"work@example.test · 1 条密码",icon:"password"}]);
group(1,648,[{kind:"listItem",label:"邮箱",supporting:"永不堆叠 · 1 条密码",icon:"password"}]);
const doc = { title: 'Monica · 手动堆叠密码项目', brief: '管理同源完整密码项目的手动堆叠、永不堆叠和恢复自动堆叠；三种操作共用一个选择框。内部元数据沿用 Android 字段，显式密码项目成员与内容不改变。', frame: 'phone', platform: 'web', paletteKey: 'teal', theme: base.theme, frames, groups };
const out = resolve(root, '.codex-tasks/android-interop-315/raw/password-manual-stacks-canvas');
await mkdir(out, { recursive: true });
await writeFile(resolve(root, 'docs/design/password-manual-stacks-317.m3e.json'), JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(resolve(root, 'docs/design/password-manual-stacks-317.md'), `Editable local design: [Password display stacks](${link})\n\nSource: password-manual-stacks-317.m3e.json. This is design evidence; application rendering is verified separately.\n`);
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
