import { chromium, expect as baseExpect } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
const expect = baseExpect.configure({ timeout: 60000 });

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const extension = path.resolve(arg("--extension", "dist"));
const output = path.resolve(arg("--output", ".artifacts/home-performance/current.json"));
const counts = arg("--items", "10000,50000").split(",").map(Number);
if (counts.some(count => !Number.isInteger(count) || count < 100 || count > 50000)) throw new Error("Use 100–50000 synthetic items per sample.");
await mkdir(".artifacts", { recursive: true });
const fixture = path.resolve(".artifacts/home-performance-fixture.mjs");
await build({ entryPoints: ["tests/e2e/fixtures/vault-home.ts"], bundle: true, platform: "node", format: "esm", outfile: fixture });
const { homeBackup, homePassword } = await import(pathToFileURL(fixture).href);
const result = { version: JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8")).version, browser: "", measuredAt: new Date().toISOString(),
  notes: "Isolated Chromium with synthetic records. Interaction timings run from DOM input/change dispatch through two rendered frames; scope timing excludes asynchronous preference persistence. Cold reload includes driver/navigation time. Retained V8 heap is not total process memory. Five observations per interaction after the page is ready; the first picker query includes any lazy search-index construction. Exploratory measurements, not latency guarantees.", datasets: [] };

async function inputTime(page, selector, value, checkSelector, expected) {
  return page.evaluate(async ({ selector, value, checkSelector, expected }) => {
    const control = document.querySelector(selector);
    const start = performance.now();
    control.value = value;
    control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    const deadline = start + 60000;
    while (!document.querySelector(checkSelector)?.textContent?.includes(expected)) {
      if (performance.now() > deadline) throw new Error("Timed out waiting for benchmark result");
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  }, { selector, value, checkSelector, expected });
}
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)), maxMs: Number(sorted.at(-1).toFixed(2)), observationsMs: values.map(value => Number(value.toFixed(2))) };
}
for (const count of counts) {
  const profile = await mkdtemp(path.join(tmpdir(), "monica-home-perf-"));
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, locale: "en-US", colorScheme: "light", reducedMotion: "reduce", viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    result.browser = context.browser()?.version();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const restored = await page.evaluate(({ backup, password }) => chrome.runtime.sendMessage({ type: "VAULT_RESTORE_ENCRYPTED", backup, backupPassword: password }), { backup: await homeBackup(), password: homePassword });
    if (!restored.ok) throw new Error(restored.error);
    const imported = await page.evaluate(async count => {
      const now = "2026-09-01T08:00:00.000Z";
      const items = Array.from({ length: count }, (_, index) => ({ id: `home-benchmark-${index}`, kind: "login", title: `Benchmark account ${String(index).padStart(5, "0")}`, username: `person-${index}@example.test`, password: "synthetic-only", uris: ["https://synthetic.example.test"], notes: "", customFields: [], favorite: index % 50 === 0, categoryId: index % 200, categoryName: `Folder ${index % 200}`, createdAt: now, updatedAt: now, providerRefs: [{ providerId: index % 2 ? "work-db" : "home-local-source" }] }));
      for (let offset = 0; offset < items.length; offset += 5000) {
        const response = await chrome.runtime.sendMessage({ type: "VAULT_IMPORT_ITEMS", items: items.slice(offset, offset + 5000) });
        if (!response.ok) return { ok: false, error: response.error };
      }
      return { ok: true };
    }, count);
    if (!imported.ok) throw new Error(imported.error);
    const start = performance.now();
    await page.reload();
    await expect(page.locator(".home-toolbar button").last()).toBeEnabled();
    await expect(page.locator(".home-browse-all .home-count")).toHaveText(String(count + 10));
    const coldReloadMs = performance.now() - start;
    const scopes = [];
    for (let index = 0; index < 5; index++) {
      await expect(page.locator(".home-source-select select").first()).toBeEnabled();
      scopes.push(await inputTime(page, ".home-source-select select", index % 2 ? "all" : "work-db", ".home-browse-all .home-count", String(index % 2 ? count + 10 : count / 2 + 4)));
    }
    await expect(page.locator(".home-source-select select").first()).toBeEnabled();
    await page.locator(".home-source-select select").first().selectOption("all");
    await expect(page.locator("#home-manage-cards")).toBeEnabled();
    await page.locator("#home-manage-cards").click();
    const picker = [];
    for (let index = 0; index < 5; index++) {
      const title = `Benchmark account ${String(count - 1 - index).padStart(5, "0")}`;
      picker.push(await inputTime(page, "#home-pin-query", title, ".home-picker-item strong", title));
    }
    await page.locator("#home-card-picker").press("Escape");
    await page.locator(".home-browse-all").click();
    await expect(page.locator(".item-card")).toHaveCount(50);
    const search = [];
    for (let index = 0; index < 5; index++) {
      const title = `Benchmark account ${String(count - 1 - index).padStart(5, "0")}`;
      search.push(await inputTime(page, ".search input", title, ".item-card-main strong", title));
    }
    await page.locator(".home-context button").first().click();
    await expect(page.locator(".home-toolbar button").last()).toBeEnabled();
    const cdp = await context.newCDPSession(page);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    await cdp.detach();
    const dataset = { syntheticItems: count, totalActiveItems: count + 10, coldReloadMs: Number(coldReloadMs.toFixed(2)), scope: summarize(scopes), pickerSearch: summarize(picker), listSearch: summarize(search), retainedHeapBytes: heap.usedSize, ...dom };
    result.datasets.push(dataset);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(dataset));
  } finally {
    await context.close();
    const resolved = await realpath(profile);
    const tempRoot = await realpath(tmpdir());
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("monica-home-perf-")) throw new Error("Unexpected profile location");
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(`Saved ${output}`);
