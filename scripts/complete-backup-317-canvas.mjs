import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'docs/design/complete-backup-317.m3e.json');
const out = resolve(root, '.codex-tasks/android-interop-315/raw/complete-backup-android-copy-canvas');
const base = JSON.parse(await readFile(resolve(root, 'docs/design/android-interop-315.m3e.json'), 'utf8'));
const frames = [
  { id: 'backup317', name: 'MDBX 完整备份 · 420px', x: 0, y: 0, w: 420, h: 840 },
  { id: 'restore317', name: 'MDBX 备份恢复 · 420px', x: 480, y: 0, w: 420, h: 840 },
];
let sequence = 0;
const groups = [];
function group(frame, y, items, axis = 'y') {
  groups.push({ id: `backup-g${++sequence}`, frameId: frames[frame].id, x: frames[frame].x + 12, y, axis, gap: 4,
    items: items.map(item => ({ id: `backup-i${++sequence}`, icon: null, variant: 'filled', size: 396, ...item })) });
}
group(0, 20, [{ kind: 'topAppBar', label: '密码源', icon: 'arrow_back' }]);
group(0, 104, [{ kind: 'listItem', label: '个人数据库', supporting: 'MDBX2 · 已解锁', icon: 'storage' }]);
group(0, 200, [{ kind: 'listItem', label: '完整备份', supporting: '包含密码、Passkey、卡面与笔记附件', icon: 'backup' },
  { kind: 'listItem', label: '保留附件与历史记录', supporting: '使用原数据库密码恢复', icon: 'history' }]);
group(0, 384, [{ kind: 'button', label: '导出 MDBX2 完整备份', icon: 'download', action: { to: 'restore317', transition: 'fade' } }]);
group(0, 470, [{ kind: 'listItem', label: 'Android 恢复支持', supporting: '暂不支持直接恢复此完整备份 ZIP', icon: 'smartphone' },
  { kind: 'listItem', label: '保留完整备份', supporting: '在插件中打开 ZIP 可恢复数据库和附件', icon: 'folder' }]);
group(1, 20, [{ kind: 'topAppBar', label: '打开 MDBX2 数据库', icon: 'arrow_back' }]);
group(1, 108, [{ kind: 'textField', label: '名称', supporting: '个人数据库' }]);
group(1, 200, [{ kind: 'button', label: '选择 MDBX 或完整备份 ZIP', icon: 'folder_open' }]);
group(1, 292, [{ kind: 'listItem', label: 'personal.mdbx-backup.zip', supporting: '恢复数据库和附件 · 合计不超过 512 MiB', icon: 'folder_zip' }]);
group(1, 390, [{ kind: 'textField', label: '原数据库密码' }]);
group(1, 490, [{ kind: 'listItem', label: '先检查完整性，再打开', supporting: '缺失或损坏的附件会停止恢复', icon: 'verified_user' }]);
group(1, 608, [{ kind: 'button', label: '打开数据库', icon: 'lock_open' }]);
group(1, 686, [{ kind: 'button', label: '取消', variant: 'text', action: { to: 'backup317', transition: 'fade' } }]);
const doc = { title: 'Monica · MDBX 完整备份与恢复', brief: '复用密码源页和现有导入表单；12px留白、连续列表组、明确附件保留与恢复步骤。普通MDBX保持原流程，插件直接打开ZIP完整备份；Android的直接ZIP及完整附件恢复尚未打通。',
  frame: 'phone', platform: 'web', paletteKey: 'teal', theme: base.theme, frames, groups };
await mkdir(out, { recursive: true });
await writeFile(source, JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(resolve(root, 'docs/design/complete-backup-317.md'), `Editable local design: [MDBX backup and restore](${link})\n\nSource: complete-backup-317.m3e.json. Current render: raw/complete-backup-android-copy-canvas. Android's ordinary document picker does not pass a parent-tree grant for sidecar import; extraction alone is insufficient. Android full-archive acceptance remains pending.\n`);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const frame of frames) {
    const page = await browser.newPage({ viewport: { width: 1060, height: 1020 } });
    await page.goto('http://127.0.0.1:5186/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(localStorage.getItem('m3e:doc')));
    const preview = { ...doc, frames: [{ ...frame, x: 0 }], groups: groups.filter(g => g.frameId === frame.id).map(g => ({ ...g, x: g.x - frame.x })) };
    await page.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preview)) });
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('m3e:doc') || '{}').frames?.[0]?.id === id ||
      [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '确定'), frame.id).catch(async error => {
        await page.screenshot({path:resolve(out, `${frame.id}-failure.png`),fullPage:true});
        console.error((await page.locator('body').innerText()).slice(-2400));
        throw error;
      });
    const confirmation = page.getByRole('button', { name: '确定', exact: true });
    if (await confirmation.isVisible()) await confirmation.click();
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('m3e:doc') || '{}').frames?.[0]?.id === id, frame.id);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).waitFor();
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
    await page.screenshot({ path: resolve(out, `${frame.id}.png`), fullPage: true });
    console.log(frame.id, (await page.locator('body').innerText()).slice(-650));
    await page.close();
  }
  await writeFile(resolve(out, 'render.json'), JSON.stringify({ browser: browser.version(), frames: frames.map(f => f.id), source, renderedAt: new Date().toISOString() }, null, 2));
} finally { await browser.close(); }
