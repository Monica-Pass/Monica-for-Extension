import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const doc = JSON.parse(await readFile(new URL('docs/design/keepass-removal-317.m3e.json', root), 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const frame of doc.frames) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
    await page.goto('http://127.0.0.1:5186/');
    await page.waitForFunction(() => Boolean(localStorage.getItem('m3e:doc')));
    const preview = { ...doc, frames: [{ ...frame, x: 0, y: 0 }], groups: doc.groups.filter(row => row.frameId === frame.id)
      .map(row => ({ ...row, x: row.x - frame.x })) };
    await page.locator('input[type=file]').setInputFiles({ name: 'preview.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preview)) });
    try { await page.getByRole('button', { name: '确定', exact: true }).click({ timeout: 5000 }); }
    catch (error) {
      await page.screenshot({ path: new URL('.codex-tasks/android-interop-315/raw/keepass-canvas-import-failure.png', root).pathname.slice(1) });
      console.log((await page.locator('body').innerText()).slice(-2500));
      throw error;
    }
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('m3e:doc') || '{}').frames?.[0]?.id === id, frame.id);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).waitFor();
    await page.screenshot({ path: new URL(`.codex-tasks/android-interop-315/raw/canvas-${frame.id}.png`, root).pathname.slice(1) });
    await page.close();
  }
  await writeFile(new URL('.codex-tasks/android-interop-315/raw/keepass-removal-canvas.json', root), JSON.stringify({ browser: browser.version(), channel: 'msedge',
    source: 'docs/design/keepass-removal-317.m3e.json', frames: doc.frames.map(row => row.id), at: new Date().toISOString() }, null, 2));
} finally { await browser.close(); }
