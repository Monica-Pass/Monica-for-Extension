import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';
const source = JSON.parse(await readFile('docs/design/android-interop-315.m3e.json', 'utf8'));
const doc = { ...source, frames: [{ id: 'passwordhistory317', name: '密码历史 · 当前密码成员', x: 0, y: 0, w: 420, h: 760 }], groups: [] };
let serial = 0;
function add(y, item) { const id = `history-${serial++}`; doc.groups.push({ id, frameId: 'passwordhistory317', x: 12, y, axis: 'y', gap: 4,
  items: [{ id: `${id}-control`, icon: null, variant: 'filled', size: 396, ...item }] }); }
add(12, { kind: 'topAppBar', label: '工作账号 · 密码 1', icon: 'close' });
add(92, { kind: 'listItem', label: '用户名', supporting: 'work@example.test', icon: 'person', icon2: 'content_copy', radius: 24 });
add(172, { kind: 'listItem', label: '密码', supporting: '••••••••', icon: 'password', icon2: 'visibility', radius: 24 });
add(264, { kind: 'listItem', label: '密码历史 · 2', supporting: '仅此密码的历史', icon: 'history', icon2: 'expand_more', radius: 24 });
add(344, { kind: 'listItem', label: '2026/10/06 12:30', supporting: '••••••••', icon: 'history', icon2: 'visibility', radius: 4, corners: { tl: 24, tr: 24, bl: 4, br: 4 } });
add(420, { kind: 'button', label: '复制历史密码 1', icon: 'content_copy', variant: 'tonal', radius: 24 });
add(480, { kind: 'button', label: '删除历史密码 1', icon: 'delete', variant: 'text', radius: 24 });
add(548, { kind: 'listItem', label: '2026/10/05 09:20', supporting: '••••••••', icon: 'history', icon2: 'visibility', radius: 4, corners: { tl: 4, tr: 4, bl: 24, br: 24 } });
add(654, { kind: 'button', label: '关闭', variant: 'text', radius: 24 });
await writeFile('docs/design/password-history-317.m3e.json', JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile('docs/design/password-history-317.md', `# Password history\n\nCurrent password member only. Reuse Monica teal tokens, Segoe UI/Microsoft YaHei UI, 12px gutters, 24px outer/4px joined corners and 48px actions. History starts collapsed and masked, newest first. Dates carry the hierarchy; reveal/copy/delete remain reachable at 320px through wrapping. Deletion selects one historical row, never the current password or another project member. Pending deletion disables repeated actions; errors retain data.\n\n[Editable local Canvas](${link})\n`);
const out = '.codex-tasks/android-interop-315/raw/password-history-canvas';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 970 } });
  await page.goto(link);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).waitFor();
  await page.screenshot({ path: `${out}/preview.png`, fullPage: true });
  await writeFile(`${out}/render.json`, JSON.stringify({ version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent), frame: doc.frames[0].id }, null, 2));
} finally { await browser.close(); }
