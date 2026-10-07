import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = JSON.parse(await readFile(resolve(root, 'docs/design/complete-backup-317.m3e.json'), 'utf8'));
const source = resolve(root, 'docs/design/complete-backup-layout-317.m3e.json');
const out = resolve(root, '.codex-tasks/android-interop-315/raw/complete-backup-layout-canvas'); await mkdir(out, { recursive: true });
const frames = [{ id: 'backupcompact317', name: '完整备份恢复 · 320px', x: 0, y: 0, w: 320, h: 940 }];
let sequence = 0;
const groups = [];
function group(y, items) { groups.push({ id: `backuplayout-g${++sequence}`, frameId: frames[0].id, x: 12, y, axis: 'y', gap: 4,
  items: items.map(item => ({ id: `backuplayout-i${++sequence}`, icon: null, variant: 'filled', size: 296, ...item })) }); }
group(16, [{ kind: 'topAppBar', label: '打开 MDBX2', icon: 'close' }]);
group(104, [{ kind: 'listItem', label: '本机助手已就绪', supporting: '已连接，可打开数据库与完整备份', icon: 'check_circle' }]);
group(204, [{ kind: 'textField', label: '显示名称', supporting: '完整备份恢复' }]);
group(300, [{ kind: 'button', label: '选择 MDBX 或完整备份 ZIP', icon: 'folder_open' }]);
group(388, [{ kind: 'listItem', label: 'complete.mdbx-backup.zip', supporting: '包含数据库和附件', icon: 'archive' }]);
group(492, [{ kind: 'select', label: '解锁方式', supporting: '密码' }]);
group(588, [{ kind: 'textField', label: '保险库密码（可留空）' }]);
group(704, [{ kind: 'button', label: '验证、解锁并导入', icon: 'lock_open' }]);
group(800, [{ kind: 'button', label: '取消', variant: 'text' }]);
const doc = { ...base, frames, groups }; await writeFile(source, JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(resolve(root, 'docs/design/complete-backup-layout-317.md'), `Editable local design: [Compact backup restore](${link})\n\nSource: complete-backup-layout-317.m3e.json. Keep status, controls and actions at their natural height within the scroll area; long text must not overlap the next group. Product validation is separate from this design preview.\n`);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1060, height: 1120 } });
  await page.goto('http://127.0.0.1:5186/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(localStorage.getItem('m3e:doc')));
  await page.locator('input[type=file]').setInputFiles({ name: 'backup-layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('m3e:doc') || '{}').frames?.[0]?.id === 'backupcompact317' || [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '确定'));
  const confirm = page.getByRole('button', { name: '确定', exact: true }); if (await confirm.isVisible()) await confirm.click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('m3e:doc') || '{}').frames?.[0]?.id === 'backupcompact317');
  await page.getByRole('button', { name: '预览', exact: true }).click(); await page.getByRole('button', { name: '关闭', exact: true }).waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
  await page.screenshot({ path: resolve(out, 'backupcompact317.png'), fullPage: true });
  await writeFile(resolve(out, 'render.json'), JSON.stringify({ browser: browser.version(), source, renderedAt: new Date().toISOString() }, null, 2));
} finally { await browser.close(); }
