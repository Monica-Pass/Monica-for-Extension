import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

const clean = (...args: string[]) => execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/clean-test-profiles.ps1'), ...args
], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });

test('isolated Edge profile keeps state across restarts until run cleanup', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Windows Edge');
  const logicalProfile = info.outputPath('profile');
  const first = await launchEdgeContext(logicalProfile);
  try {
    await first.addCookies([{ name: 'synthetic-restart', value: 'preserved', url: 'https://monica.test', expires: Math.floor(Date.now() / 1000) + 3600 }]);
    expect(clean('-RunId', process.env.MONICA_E2E_PROFILE_RUN_ID!)).toContain('active-skipped=1');
  } finally { await first.close(); }
  const before = JSON.parse(await readFile(`${logicalProfile}-browser.json`, 'utf8'));
  // Even between browser launches, manual cleanup must protect the live runner.
  expect(clean('-AllInactive')).toContain('active-skipped=1');
  const second = await launchEdgeContext(logicalProfile);
  try {
    expect((await second.cookies('https://monica.test'))[0]?.value).toBe('preserved');
    const after = JSON.parse(await readFile(`${logicalProfile}-browser.json`, 'utf8'));
    expect(after.profile).toBe(before.profile);
  } finally { await second.close(); }
});

test('failed tests also leave profiles for run cleanup', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Windows Edge');
  test.fail(true, 'Exercise cleanup after an assertion failure');
  const context = await launchEdgeContext(info.outputPath('profile'));
  try { expect('intentional failure').toBe('expected assertion'); }
  finally { await context.close(); }
});
