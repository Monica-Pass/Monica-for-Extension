import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const doc = JSON.parse(await readFile(process.argv[2] || 'docs/design/keepass-resolution-317.m3e.json', 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const frame of doc.frames) {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1060 } });
    await page.goto('http://127.0.0.1:5186/');
    await page.waitForFunction(() => !!localStorage.getItem('m3e:doc'));
    const preview = { ...doc, frames: [{ ...frame, x: 0, y: 0 }], groups: doc.groups.filter(g => g.frameId === frame.id).map(g => ({ ...g, x: g.x - frame.x })) };
    await page.locator('input[type=file]').setInputFiles({ name: 'preview.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preview)) });
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('m3e:doc')).frames[0].id === id, frame.id);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).waitFor();
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: `.codex-tasks/android-interop-315/raw/canvas-${frame.id}.png` });
    console.log(frame.id); await page.close();
  }
} finally { await browser.close(); }
