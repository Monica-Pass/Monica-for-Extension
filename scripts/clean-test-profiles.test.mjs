import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const script = fileURLToPath(new URL('./clean-test-profiles.ps1', import.meta.url)).replaceAll("'", "''");
// The guard is reached even in a fresh Windows checkout with no prior runs.
if (process.platform === 'win32') mkdirSync(fileURLToPath(new URL('../.tmp/edge-audit-profiles', import.meta.url)), { recursive: true });
function probe(processFunction) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `function Get-CimInstance { throw 'synthetic CIM unavailable' }; function Get-Process { ${processFunction} }; & '${script}' -RunId '${randomUUID()}' -DryRun`
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}
test('CIM failure permits cleanup only when native enumeration proves no browsers remain', { skip: process.platform !== 'win32' }, () => {
  const result = probe('return @()');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /none to clean/);
});
test('CIM failure preserves profiles if a browser still exists', { skip: process.platform !== 'win32' }, () => {
  const result = probe("[pscustomobject]@{ ProcessName = 'msedge' }");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /synthetic CIM unavailable/);
});
test('failed native enumeration cannot be mistaken for an empty browser list', { skip: process.platform !== 'win32' }, () => {
  const result = probe("throw 'synthetic process listing failed'");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /synthetic process listing failed/);
});
