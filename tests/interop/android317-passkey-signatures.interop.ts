import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PasskeyItem } from '../../src/core/model';
import { createAssertion, createPasskey } from '../../src/passkey/webauthn-core';
import { decodeMdbx2Object, encodeMdbx2Object } from '../../src/providers/mdbx2/mdbx2-item-codec';
import { Mdbx2NativeClient } from '../../src/providers/mdbx2/native-client';
import { Mdbx2LocalFileExports } from '../../src/providers/mdbx2/local-file-export';
import { ProcessNativeRuntime } from './mdbx2-interop-support';

const output = process.env.MONICA_315_APP_FIXTURE;
const phase = process.env.MONICA_PASSKEY_INTEROP_PHASE || 'prepare';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
interface Proof {
  credentialId: string; algorithm: number; rpId: string; userHandle: string; spki?: string; cose?: string;
  authenticatorData: string; clientDataJSON: string; signature: string; protectedRoomReference: boolean;
  keyMaterialSha256: string; storedSignCount: number; storedIsBackedUp: boolean; flags: number;
}
interface Expected { credentialId: string; algorithm: number; spki: string; keyMaterialSha256: string; signCount: number; backupEligible: boolean; backupState: boolean; }

function verifyProof(proof: Proof, spki: string) {
  const auth = Buffer.from(proof.authenticatorData, 'base64'), client = Buffer.from(proof.clientDataJSON, 'base64');
  expect(auth.length).toBe(37);
  expect(auth.subarray(0, 32).toString('hex')).toBe(hash(proof.rpId));
  expect(JSON.parse(client.toString())).toMatchObject({type: 'webauthn.get', origin: `https://${proof.rpId}`});
  expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
    createPublicKey({key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki'}), Buffer.from(proof.signature, 'base64'))).toBe(true);
  return {flags: auth[32], count: auth.readUInt32BE(33)};
}

it.skipIf(!output)(`actual Android key generation/protected storage/MDBX/signatures: ${phase}`, async () => {
  if (!output || !['prepare', 'return'].includes(phase)) throw new Error('Explicit synthetic fixture path and phase required');
  const stage = phase === 'prepare' ? 'export' : 'import';
  const android = JSON.parse(await readFile(join(output, `passkey-signatures-${stage}-evidence.json`), 'utf8'));
  expect(android.status).toBe('passed');
  for (const flag of ['androidSourcesUnchanged', 'testSourcesUnchanged', 'installedApplicationUnchanged', 'installedTestApkUnchanged', 'deviceBootUnchanged']) expect(android[flag], flag).toBe(true);
  for (const file of android.outputs as {name: string; sha256: string}[]) expect(hash(await readFile(join(output, file.name)))).toBe(file.sha256);
  const document = JSON.parse(await readFile(join(output, phase === 'prepare' ? 'android-signatures.json' : 'android-return-signatures.json'), 'utf8'));
  expect(document.synthetic).toBe(true);
  const proofs = document.proofs as Proof[];
  const expected: Expected[] = phase === 'return' ? JSON.parse(await readFile(join(output, 'extension-passkey-expected.json'), 'utf8')) : [];
  const source = join(output, phase === 'prepare' ? 'android-passkeys.mdbx' : 'android-return-passkeys.mdbx');
  const bytes = await readFile(source);
  const executable = resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
  const runtime = new ProcessNativeRuntime(executable, await mkdtemp(join(output, `signature-${phase}-host-`)));
  const native = new Mdbx2NativeClient(runtime);
  let exports: Mdbx2LocalFileExports | undefined;
  const gaps: unknown[] = [];
  const evidence: Record<string, unknown> = {status: 'failed', phase, inputSha256: hash(bytes), hostSha256: hash(await readFile(executable)), signatures: [], compatibilityGaps: gaps,
    androidAuthenticatorDataHelperUsesTestSuppliedZeroCount: true};
  try {
    const transfer = await native.beginInboundTransfer(bytes.length, hash(bytes));
    for (let offset = 0; offset < bytes.length;) offset = (await native.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
    const file = await native.finishInboundTransfer(transfer.transferId);
    const opened = await native.openVault({kind: 'file', handle: file.fileHandle}, {method: 'password', password: 'Synthetic transfer fixture password'});
    const collections = await native.listCollections(opened.vaultHandle);
    expect(collections.nextCursor).toBeUndefined();
    let count = 0;
    for (const collection of collections.items) {
      const rows = await native.listObjects(opened.vaultHandle, collection.collectionId);
      expect(rows.nextCursor).toBeUndefined();
      for (const row of rows.items) {
        const record = await native.revealObject(opened.vaultHandle, row.objectId);
        const decoded = decodeMdbx2Object(record, {headCommitId: row.headCommitId, updatedAt: row.updatedAt}, 'synthetic-passkey-provider');
        expect(decoded.item?.kind).toBe('passkey');
        const item = decoded.item as PasskeyItem;
        const proof = proofs.find(value => value.credentialId === item.credentialId)!;
        expect(proof).toBeDefined(); expect(proof.protectedRoomReference).toBe(true);
        expect(item.algorithm).toBe(proof.algorithm);
        expect(item.userHandle).toBe(proof.userHandle);
        expect(item.privateKeyPkcs8).toBeTruthy();
        const digest = createHash('sha256').update(Buffer.from(item.privateKeyPkcs8!, 'base64')).digest('base64');
        expect(digest).toBe(proof.keyMaterialSha256);
        const original = expected.find(value => value.credentialId === item.credentialId);
        const spki = phase === 'prepare' ? proof.spki! : original!.spki;
        const verified = verifyProof(proof, spki);
        // This is a core signing call with a known fixture UV result, not a browser UI ceremony.
        const assertion = await createAssertion({origin: `https://${item.rpId}`, rpId: item.rpId,
          challenge: Buffer.from(randomUUID()).toString('base64url'), credentialId: item.credentialId,
          userHandle: item.userHandle, privateKeyPkcs8: item.privateKeyPkcs8!, algorithm: item.algorithm,
          signCount: 0, backupEligible: item.backupEligible, backupState: item.backupState, userVerified: true});
        verifyProof({...proof, ...assertion.response}, spki);
        if (phase === 'prepare') {
          const updated = {...item, notes: item.notes + '\nExtension passkey roundtrip', backupEligible: item.algorithm !== -7,
            backupState: false, signCount: item.algorithm === -7 ? 41 : 0};
          const input = encodeMdbx2Object(updated, decoded.payload, item)!;
          await native.upsertObject(opened.vaultHandle, randomUUID(), input);
          expected.push({credentialId: item.credentialId, algorithm: item.algorithm, spki, keyMaterialSha256: digest,
            signCount: updated.signCount, backupEligible: updated.backupEligible, backupState: false});
        } else {
          expect(digest).toBe(original!.keyMaterialSha256);
          expect(item.signCount).toBe(original!.signCount);
          expect(proof.storedSignCount).toBe(original!.signCount);
          expect(item.backupEligible).toBe(original!.backupEligible);
          expect(item.backupState).toBe(original!.backupState);
          const expectedFlags = 0x05 | (original!.backupEligible ? 0x08 : 0) | (original!.backupState ? 0x10 : 0);
          if (verified.flags !== expectedFlags) gaps.push({kind: 'android-authenticator-backup-flags', credentialId: item.credentialId,
            expectedFlags, actualFlags: verified.flags, layer: 'actual Android authenticator-data helper ignores imported explicit backup flags'});
        }
        (evidence.signatures as unknown[]).push({credentialId: item.credentialId, algorithm: item.algorithm,
          android: verified, storedCount: proof.storedSignCount, backupEligible: item.backupEligible, backupState: item.backupState,
          androidStoredIsBackedUp: proof.storedIsBackedUp, independentAndroidVerification: true, extensionCoreSigningVerified: true});
        count++;
      }
    }
    expect(count).toBe(phase === 'prepare' ? 2 : 4);
    if (phase === 'prepare') {
      for (const algorithm of [-7, -257]) {
        const origin = 'https://passkey-interop.example.test';
        const created = await createPasskey({origin, rpName: 'Extension generated', challenge: Buffer.from(randomUUID()).toString('base64url'),
          userId: 'AAEC_w', userName: `extension-${algorithm}`, userDisplayName: 'Extension generated', algorithms: [algorithm], excludeCredentialIds: [], userVerified: true});
        const now = new Date().toISOString();
        const item: PasskeyItem = {id: randomUUID(), kind: 'passkey', title: `Extension generated ${algorithm}`, favorite: false,
          notes: 'Synthetic extension generated key', createdAt: now, updatedAt: now, providerRefs: [], credentialId: created.credentialId,
          rpId: created.rpId, rpName: 'Extension generated', userHandle: 'AAEC_w', userName: `extension-${algorithm}`, userDisplayName: 'Extension generated',
          algorithm, publicKey: created.publicKeySpki, privateKeyPkcs8: created.privateKeyPkcs8, signCount: 0, backupEligible: true, backupState: true,
          discoverable: true, transports: ['internal'], sourceMode: 'browser-local', passkeyMode: 'BW_COMPAT'};
        await native.upsertObject(opened.vaultHandle, randomUUID(), encodeMdbx2Object(item)!);
        expected.push({credentialId: item.credentialId, algorithm, spki: created.publicKeySpki,
          keyMaterialSha256: createHash('sha256').update(Buffer.from(item.privateKeyPkcs8!, 'base64')).digest('base64'), signCount: 0, backupEligible: true, backupState: true});
      }
      exports = new Mdbx2LocalFileExports(native, async () => ({vaultHandle: opened.vaultHandle, fileName: 'extension-passkeys.mdbx'}));
      const download = await exports.begin('fixture', 'document');
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < download.sizeBytes;) {
        const chunk = await exports.read('fixture', 'document', download.downloadHandle, offset);
        chunks.push(Buffer.from(chunk.dataBase64, 'base64')); offset = chunk.nextOffset;
      }
      const exported = Buffer.concat(chunks);
      expect(hash(exported)).toBe(download.sha256);
      await exports.release('fixture', 'document', download.downloadHandle);
      await writeFile(join(output, 'extension-passkeys.mdbx'), exported);
      await writeFile(join(output, 'extension-passkey-expected.json'), JSON.stringify(expected, null, 2));
    }
    expect(hash(await readFile(source))).toBe(hash(bytes));
    evidence.status = 'passed'; evidence.interoperabilityComplete = phase === 'return' && gaps.length === 0;
    evidence.scope = 'Android crypto/repository and actual Native Host/core signing; not Credential Manager, browser UI, or biometric verification';
  } catch (error) { evidence.error = String(error); throw error; }
  finally { await exports?.clear(); native.close(); await writeFile(join(output, `signature-${phase}-evidence.json`), JSON.stringify(evidence, null, 2)); }
});
