import { expect, test, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import type * as Harness from './fixtures/keepass-source-removal-harness';

declare global { interface Window { keepassSourceRemovalTest: typeof Harness } }

for (const mode of ['local-file', 'webdav', 'onedrive'] as const) test(`KeePass ${mode} source file removal survives IndexedDB abort, lost reply and full Edge restart`, async ({}, info) => {
  test.setTimeout(90_000);
  const bundle = await build({ entryPoints: ['tests/e2e/fixtures/keepass-source-removal-harness.ts'], bundle: true,
    platform: 'browser', format: 'iife', globalName: 'keepassSourceRemovalTest', write: false, logLevel: 'silent',
    alias: { crypto: resolve('scripts/stubs/node-crypto.js') } });
  let context: BrowserContext | undefined;
  const open = async () => {
    context = await launchEdgeContext(info.outputPath('profile'));
    await context.route('https://source-removal.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic KeePass source removal</title>' }));
    const page = await context.newPage(); await page.goto('https://source-removal.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text }); return page;
  };
  try {
    const page = await open(), saved = await page.evaluate(mode => window.keepassSourceRemovalTest.first(mode), mode);
    await context!.close(); context = undefined;
    const restarted = await open(), evidence = await restarted.evaluate(saved => window.keepassSourceRemovalTest.restart(saved), saved);
    expect(evidence).toEqual({ aborted: true, lost: true, removed: 3, retained: 1, restored: 4,
      encryptedReceipt: true, originalSignature: true, originalCounter: 0, attachmentsExact: true, historyExact: true,
      noSessionRecovery: true, baseUnchanged: true, laterRestorationPreserved: true });
    await info.attach('source-removal-file-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } finally { await context?.close(); }
});
