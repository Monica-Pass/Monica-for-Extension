import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import type * as Fixture from './fixtures/record-vault';
declare global { interface Window { recordFixture: typeof Fixture } }
test('migrates and recovers real IndexedDB, and measures individual edits at two sizes', async ({}, info) => {
  test.setTimeout(300_000);
  const fixture = await build({entryPoints:['tests/e2e/fixtures/record-vault.ts'],bundle:true,platform:'browser',format:'iife',
    globalName:'recordFixture',write:false,alias:{crypto:resolve('scripts/stubs/node-crypto.js')}});
  const ctx = await launchEdgeContext(info.outputPath('record-profile'));
  try {
    await ctx.route('https://vault.example.test/**', r => r.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic vault</title>'}));
    const page = await ctx.newPage(); await page.goto('https://vault.example.test/'); await page.addScriptTag({content:fixture.outputFiles[0].text});
    await page.evaluate(() => window.recordFixture.compatibility());
    const results = [];
    for (const n of [1000,5000]) for (const v2 of [false,true]) {
      const result = await page.evaluate(([count,records]:[number,boolean]) => window.recordFixture.measure(count,records), [n,v2] as [number,boolean]);
      results.push(result);
      if(v2) expect(Math.max(...result.writes)).toBeLessThan(Math.min(...results[results.length-2].writes)/8);
    }
    console.log('Record measurements: '+JSON.stringify(results));
    const sync = [];
    for (const records of [false,true]) sync.push(await page.evaluate(v => window.recordFixture.syncMeasure(v),records));
    expect(Math.max(...sync[1].writes)).toBeLessThan(Math.min(...sync[0].writes)/8);
    console.log('Sync measurements: '+JSON.stringify(sync));
    await info.attach('measurements', {body:JSON.stringify(results),contentType:'application/json'});
  } finally { await ctx.close(); }
});
