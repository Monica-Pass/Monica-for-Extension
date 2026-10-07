import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.tmp/android-passkey-fixes-317/acceptance');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = {};
async function bytes(name) { const value = await readFile(join(out, name)); files[name] = sha(value); return value; }
async function json(name) { return JSON.parse(await bytes(name)); }
const visible = xml => Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('node'))
  .flatMap(node => [node.getAttribute('text'), node.getAttribute('content-desc')]).filter(Boolean);
function assertNoMatch(input) {
  assert.equal(input.result.error, 'android.credentials.GetCredentialException.TYPE_USER_CANCELED');
  assert.equal(input.result.response, undefined);
  assert.equal(input.request.rpId, input.record.rpId);
  assert.deepEqual(input.request.allowCredentials, [{ type: 'public-key', id: 'AAAAAAAAAAAAAAAAAAAAAA' }]);
  assert.notEqual(input.record.credentialId, input.request.allowCredentials[0].id);
  assert.equal(input.control.id, input.record.credentialId, 'Known same-RP credential must have successfully authenticated before no-match');
  assert.deepEqual(input.before.integrity, [{ integrity_check: 'ok' }]);
  assert.deepEqual(input.after.integrity, [{ integrity_check: 'ok' }]);
  assert.deepEqual(input.before.rows, input.after.rows, 'No-match cannot change records or usage');
  assert.equal(input.before.rows.length, 1);
  assert.equal(input.before.rows[0].credential_id, input.record.credentialId);
  assert.equal(input.before.rows[0].use_count, 1);
  const start = input.log.lastIndexOf('starting executeGetCredential with callingPackage: com.monica.interop.rp317');
  assert.ok(start >= 0);
  const session = input.log.slice(start);
  assert.ok(session.includes(`Resolved passkeys count=0, rpId=${input.record.rpId}`));
  assert.ok(session.includes('MonicaCredentialProviderService}, with status: EMPTY_RESPONSE'));
  assert.ok(session.includes('No data for UI from: takagi.ru.monica/takagi.ru.monica.passkey.MonicaCredentialProviderService'));
  assert.doesNotMatch(session, /Resolved passkeys count=[1-9]/);
  assert.ok(input.screen.includes('使用其他登录方式'));
  assert.ok(input.options.includes('使用其他设备'));
  for (const text of [...input.screen, ...input.options]) {
    assert.doesNotMatch(text, /Monica Pass|PRIVATE_NOTE_REPAIR_317/);
    assert.ok(!text.includes(input.record.userName));
    assert.ok(!text.includes(input.record.userDisplayName));
  }
}
const ready = await json('ready.json');
assert.equal(ready.records.length, 1);
const acceptance = await json('system-acceptance.json');
assert.equal(acceptance.proofs.find(proof => proof.tag === 'bitwarden32')?.rpAcceptance, 'pass');
const input = {
  record: ready.records[0], request: await json('unknown-allow-list-request.json'), result: await json('unknown-allow-list-result.json'),
  control: (await json('bitwarden32-result.json')).response,
  before: await json('after-login/storage-evidence.json'), after: await json('after-unknown-allow-list/storage-evidence.json'),
  log: (await bytes('unknown-allow-list-platform.log')).toString('utf8'),
  screen: visible((await bytes('unknown-allow-list-screen.xml')).toString('utf8')),
  options: visible((await bytes('unknown-allow-list-options.xml')).toString('utf8')),
};
assertNoMatch(input);
const historicalWrongResponse = JSON.parse(await readFile(join(root, '.tmp/android-credential-manager-317/unknown-allow-list-result.json')));
assert.throws(() => assertNoMatch({ ...input, result: historicalWrongResponse }));
assert.throws(() => assertNoMatch({ ...input, screen: [...input.screen, input.record.userDisplayName] }));
assert.throws(() => assertNoMatch({ ...input, log: input.log.replaceAll('count=0', 'count=1') }));
assert.throws(() => assertNoMatch({ ...input, after: { ...input.after, rows: input.after.rows.map(row => ({ ...row, use_count: row.use_count + 1 })) } }));
const roundtrip = await json('repair-roundtrip.json');
assert.equal(roundtrip.status, 'passed');
assert.equal(roundtrip.cycles.length, 3);
assert.equal(roundtrip.cycles[1].notes, '');
assert.ok(roundtrip.cycles.every(cycle => cycle.sameKeyAndId && cycle.uploaded === 1));
assert.equal(roundtrip.cycles[2].notes, input.record.notes);
const picker = visible((await bytes('bitwarden32-picker-visible.xml')).toString('utf8'));
const auth = visible((await bytes('bitwarden32-auth.xml')).toString('utf8'));
for (const text of [picker, auth]) {
  assert.ok(text.includes(input.record.userDisplayName));
  assert.ok(text.every(value => !value.includes('PRIVATE_NOTE_REPAIR_317') && !value.includes('只属于备注')));
}
assert.ok(auth.includes('使用主密码'));
assert.ok(auth.includes('取消'));
for (const name of ['bitwarden32-picker-visible.png', 'bitwarden32-auth.png', 'unknown-allow-list-screen.png', 'unknown-allow-list-options.png']) await bytes(name);
for (const name of ['edge-return-initial.json', 'edge-return-restart.json']) {
  const proof = await json(name);
  assert.equal(proof.originalId, input.record.credentialId);
  for (const key of ['signature', 'zeroCounter', 'originalPublicKey', 'notesExact']) assert.equal(proof[key], true);
}
const result = { status: 'passed', scope: 'Android repair batch evidence; no global parity claim',
  noMatch: 'Same RP with known usable credential; Monica returns EMPTY_RESPONSE, only system other-device choice remains; dismissal returns USER_CANCELED without signature or data changes',
  negativeControls: ['Historical wrong-ID signed response rejected', 'Canceled matching picker rejected', 'Nonempty provider result rejected', 'Changed storage rejected'],
  notes: { threeRealServerRoundtrips: true, emptyClearing: true, exactOriginalText: true, authenticationShowsAccountWithoutNotes: true },
  original32ByteCredential: { unchangedIdAndKey: true, actualSystemSignature: true, actualEdgeReturnAndRestartSignatures: true, zeroCounterRetained: true }, files };
await writeFile(join(out, 'repair-acceptance-review.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, noMatch: result.noMatch, negativeControls: result.negativeControls, notes: result.notes, original32ByteCredential: result.original32ByteCredential }, null, 2));
