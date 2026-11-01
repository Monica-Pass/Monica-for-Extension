import test from 'node:test';
import assert from 'node:assert/strict';
import { olderRuntimeWorker } from './runtime-upgrade-fixture.mjs';

for (const quoted of [false, true]) {
  test(`older worker removes exactly the two real routes (${quoted ? 'quoted' : 'unquoted'} keys)`, () => {
    const key = name => quoted ? JSON.stringify(name) : name;
    const source = `const marker="VAULT_LOCKED_AUTOFILL_IDS";const routes={${key('VAULT_LOCKED_AUTOFILL_IDS')}:()=>1,${key('RUNTIME_INFO')}:()=>2,VAULT_UNLOCK:()=>3};`;
    const result = olderRuntimeWorker(source);
    assert.match(result, /LEGACY_LOCKED_AUTOFILL_IDS/);
    assert.match(result, /LEGACY_RUNTIME_INFO/);
    assert.match(result, /VAULT_UNLOCK:\(\)=>3/);
    assert.match(result, /marker="VAULT_LOCKED_AUTOFILL_IDS"/);
  });
}
test('missing real routes reject the fixture rather than silently use a current worker', () => {
  assert.throws(() => olderRuntimeWorker('const x="VAULT_LOCKED_AUTOFILL_IDS";const routes={RUNTIME_INFO:()=>2};'), /exactly one/);
});
test('ambiguous route definitions reject the fixture', () => {
  assert.throws(() => olderRuntimeWorker('const a={VAULT_LOCKED_AUTOFILL_IDS:()=>1,RUNTIME_INFO:()=>2};const b={RUNTIME_INFO:()=>3};'), /exactly one/);
});
