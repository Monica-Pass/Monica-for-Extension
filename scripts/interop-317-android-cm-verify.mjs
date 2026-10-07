import { readFile, writeFile } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const backendBatch = process.env.MONICA_CM_BACKENDS === '1';
const repairBatch = process.env.MONICA_CM_REPAIRS === '1';
const out = resolve(process.env.MONICA_CM_EVIDENCE_DIR || join(root, backendBatch ? '.tmp/android-cm-backends-317' : '.tmp/android-credential-manager-317'));
const expectedPath = backendBatch || repairBatch ? join(out, 'expected.json') : join(root, '.tmp/passkey-file-counter-native-edge/passkey-android-native-act-4ca71-ugh-Native-Host-and-restart/edge-passkeys-expected.json');
const expected = JSON.parse(await readFile(expectedPath));
const ready = JSON.parse(await readFile(join(out, 'ready.json')));
const rp = JSON.parse(await readFile(join(out, 'rp-build/build-evidence.json')));
const proofs = [];
let backendStorage;
if (backendBatch) {
  const before = JSON.parse(await readFile(join(out, 'before-backends/storage-evidence.json')));
  const after = JSON.parse(await readFile(join(out, 'after-backends/storage-evidence.json')));
  for (const snapshot of [before, after]) {
    assert.deepEqual(snapshot.integrity, [{ integrity_check: 'ok' }]);
    assert.equal(snapshot.rows.length, 3);
  }
  for (const row of ready.records) {
    const original = before.rows.find(value => value.id === row.recordId);
    const final = after.rows.find(value => value.id === row.recordId);
    assert.ok(original && final, 'Same backend row must survive real authentication');
    assert.equal(original.keepass_database_id, row.keepassDatabaseId ?? null);
    assert.equal(original.bitwarden_vault_id, row.bitwardenVaultId ?? null);
    assert.equal(original.use_count, row.useCount);
    assert.equal(final.sign_count, original.sign_count);
    assert.deepEqual({ ...final, use_count: original.use_count }, original, 'Only usage changes in projected identity and zero-count history');
    assert.equal(final.use_count, original.use_count + 1, 'Exactly one actual system authentication per imported key');
  }
  backendStorage = { sameThreeRowsAndBackendBindings: true, eachUsedOnce: true, zeroCountHistoryPreserved: true };
}
for (const tag of process.argv.slice(2)) {
  assert.match(tag, /^[a-z0-9-]+$/);
  const request = JSON.parse(await readFile(join(out, `${tag}-request.json`)));
  const result = JSON.parse(await readFile(join(out, `${tag}-result.json`)));
  if (result.error) {
    const canceled = ['system-cancel', 'monica-cancel'].includes(tag) && result.error === 'android.credentials.GetCredentialException.TYPE_USER_CANCELED';
    const noMatchingCredential = tag === 'unknown-allow-list' && result.error === 'android.credentials.GetCredentialException.TYPE_NO_CREDENTIAL';
    proofs.push({ tag, providerError: result.error, expectedCancellation: canceled, noMatchingCredential,
      rpAcceptance: canceled || noMatchingCredential ? 'pass' : 'fail' });
    continue;
  }
  const response = result.response;
  const record = expected.find(row => row.credentialId === response.id);
  assert.ok(record, 'Returned ID belongs to actual imported fixture');
  if (backendBatch) assert.equal(record.tag, tag, 'Response must belong to the tested backend');
  const stored = ready.records.find(row => row.credentialId === response.id);
  const client = Buffer.from(response.response.clientDataJSON, 'base64url');
  const clientJson = JSON.parse(client);
  const auth = Buffer.from(response.response.authenticatorData, 'base64url');
  assert.equal(response.type, 'public-key'); assert.equal(response.rawId, response.id);
  assert.equal(clientJson.type, 'webauthn.get'); assert.equal(clientJson.challenge, request.challenge);
  assert.equal(clientJson.origin, rp.expectedOrigin); assert.equal(clientJson.crossOrigin, false);
  assert.equal(clientJson.androidPackageName, 'com.monica.interop.rp317');
  assert.equal(response.response.userHandle, stored.userHandle);
  assert.equal(auth.length, 37);
  assert.deepEqual(auth.subarray(0, 32), createHash('sha256').update(request.rpId).digest());
  assert.ok(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
    createPublicKey({ key: Buffer.from(record.spki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(response.response.signature, 'base64url')));
  const count = auth.readUInt32BE(33), flags = auth[32];
  const expectedFlags = 5 | (record.backupEligible ? 8 : 0) | (record.backupState ? 16 : 0);
  const checks = { signature: true, exactChallenge: true, nativeCertificateOrigin: true, userHandle: true,
    userPresenceAndVerification: (flags & 5) === 5,
    requestedCredential: request.allowCredentials.some(row => row.id === response.id),
    preservedBackupFlags: flags === expectedFlags,
    preservedCounterHistory: record.signCount === 0 ? count === 0 : count > record.signCount };
  proofs.push({ tag, credentialId: response.id, algorithm: record.algorithm, flags, expectedFlags, count, previouslyAcceptedCount: record.signCount,
    checks, rpAcceptance: Object.values(checks).every(Boolean) ? 'pass' : 'fail' });
}
let cancellationStorageUnchanged;
if (proofs.some(proof => proof.expectedCancellation)) {
  const before = JSON.parse(await readFile(join(out, 'after-unknown-allow-list/storage-evidence.json')));
  const after = JSON.parse(await readFile(join(out, 'final-room/storage-evidence.json')));
  assert.deepEqual(after.rows, before.rows, 'Cancellation cannot change credential counters or usage');
  cancellationStorageUnchanged = true;
}
await writeFile(join(out, 'system-acceptance.json'), JSON.stringify({ scope: 'Real Android platform CredentialManager + system picker + production master password, native RP only',
  expectedSource: expectedPath, cancellationStorageUnchanged, backendStorage, proofs }, null, 2));
console.log(JSON.stringify(proofs, null, 2));
if (proofs.some(proof => proof.rpAcceptance === 'fail')) process.exitCode = 1;
