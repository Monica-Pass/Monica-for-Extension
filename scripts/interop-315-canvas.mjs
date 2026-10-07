import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
const root = new URL("../", import.meta.url);
const doc = await readFile(new URL("docs/design/android-interop-315.m3e.json", root), "utf8");
const selectedFrames = process.argv.find(value => value.startsWith('--frames='))?.slice('--frames='.length).split(',');
if (selectedFrames?.some(id => !JSON.parse(doc).frames.some(frame => frame.id === id))) throw new Error('Unknown Canvas frame selection');
// The workspace Canvas is loopback-only; never fall back to a hosted editor.
const canvasBaseUrl = "http://127.0.0.1:5186/";
const url = canvasBaseUrl + "#docz=" + deflateRawSync(doc).toString("base64url");
const output = new URL(".codex-tasks/android-interop-315/raw/", root);
await mkdir(output, { recursive: true });
await writeFile(new URL("canvas-link.txt", output), url);
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 1100 } });
  await page.goto(canvasBaseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => Boolean(localStorage.getItem("m3e:doc")));
  await page.locator("input[type=file]").setInputFiles(new URL("docs/design/android-interop-315.m3e.json", root).pathname.slice(1));
  const confirm = page.getByRole("button", { name: "确定", exact: true });
  try { await confirm.click(); } catch (error) {
    await page.screenshot({path:new URL("canvas-import-failure.png",output).pathname.slice(1),fullPage:true});
    console.error((await page.locator("body").innerText()).slice(-3000));
    throw error;
  }
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("m3e:doc") || "{}").frames?.[0]?.id === "vault315");
  await page.screenshot({ path: new URL("canvas-editor.png", output).pathname.slice(1), fullPage: true });
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole('button', {name: '关闭', exact: true}).waitFor();
  await page.screenshot({ path: new URL("canvas-preview.png", output).pathname.slice(1), fullPage: true });
  if (process.argv.includes('--all-frames') || selectedFrames) {
    const frames = JSON.parse(doc).frames;
    for (const frame of selectedFrames ? frames.filter(frame => selectedFrames.includes(frame.id)) : frames.slice(1)) {
      // Inspect each page directly, without relying on optional prototype navigation links.
      const isolated = await browser.newPage({viewport:{width:1480,height:1100}});
      await isolated.goto(canvasBaseUrl,{waitUntil:'domcontentloaded'});
      await isolated.waitForFunction(() => Boolean(localStorage.getItem("m3e:doc")));
      const previewDoc = JSON.parse(doc);
      previewDoc.frames = [{...frame, x: 0, y: 0}];
      previewDoc.groups = previewDoc.groups.filter(group => group.frameId === frame.id || (!group.frameId && group.x >= frame.x && group.x < frame.x + (frame.w || 420)))
        .map(group => ({...group, x: group.x - frame.x, y: group.y - frame.y}));
      await isolated.locator('input[type=file]').setInputFiles({name:'preview.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(previewDoc))});
      await isolated.getByRole('button',{name:'确定',exact:true}).click();
      await isolated.waitForFunction(id=>JSON.parse(localStorage.getItem('m3e:doc')||'{}').frames?.[0]?.id===id,frame.id);
      await isolated.getByRole('button',{name:'预览',exact:true}).click();
      await isolated.getByRole('button', {name: '关闭', exact: true}).waitFor();
      await isolated.screenshot({path:new URL(`canvas-${frame.id}.png`,output).pathname.slice(1),fullPage:true});
      console.log(JSON.stringify({frame:frame.id,text:(await isolated.locator('body').innerText()).slice(-400)}));
      await isolated.close();
    }
  }
  const evidence = { version: browser.version(), browserChannel: 'msedge', canvasBaseUrl,
    source: 'docs/design/android-interop-315.m3e.json',
    frames: JSON.parse(doc).frames.map(frame => frame.id),
    allFramesInspected: process.argv.includes('--all-frames') && !selectedFrames, selectedFrames, checkedAt: new Date().toISOString(),
    canvasLinkFile: new URL('canvas-link.txt',output).pathname };
  await writeFile(new URL('canvas-local-evidence.json', output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, body: (await page.locator("body").innerText()).slice(-1000) }));
} finally { await browser.close(); }
