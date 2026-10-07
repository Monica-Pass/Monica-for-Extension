import { expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import * as kdbxweb from "kdbxweb";
import { keePassCredentials } from "../../src/providers/keepass/keepass-fixture";
import { readKeePassPasskeyFields } from "../../src/providers/keepass/keepass-passkey-codec";

test("actual Android KDBX import, protected storage, signature and edited return retain the Edge credential", async () => {
  const webdav = process.env.MONICA_PASSKEY_TRANSPORT === "webdav";
  const directory = path.resolve(process.env.MONICA_317_KDBX_PASSKEY_RETURN || ".tmp/android-kdbx-passkeys-317");
  const expected = JSON.parse(await readFile(path.join(directory, "extension-passkeys-expected.json"), "utf8"));
  const input = await readFile(path.join(directory, "extension-passkeys.kdbx"));
  const output = await readFile(path.join(directory, "android-return-passkeys.kdbx"));
  const proof = JSON.parse(await readFile(path.join(directory, "android-kdbx-signatures.json"), "utf8"));
  const device = JSON.parse(await readFile(path.join(directory, `passkey-signatures-${webdav ? "webdav" : "kdbx"}-evidence.json`), "utf8"));
  expect(device.status).toBe("passed");
  expect(device.deviceBootUnchanged).toBe(true);
  expect(device.installedApplicationUnchanged).toBe(true);
  expect(device.installedTestApkUnchanged).toBe(true);
  expect(device.androidSourcesUnchanged).toBe(true);
  expect(device.testSourcesUnchanged).toBe(true);
  expect(createHash("sha256").update(input).digest("hex")).toBe(expected.inputSha256);
  expect(proof.inputSha256).toBe(expected.inputSha256);
  if (webdav) {
    const transport = JSON.parse(await readFile(path.join(directory, "android-webdav-transport.json"), "utf8"));
    expect(transport).toMatchObject({ status: "passed", staleWriteRejected: true, inputSha256: expected.inputSha256,
      outputSha256: createHash("sha256").update(output).digest("hex") });
    expect(transport.afterEtag).not.toBe(transport.beforeEtag);
  }
  const original = await kdbxweb.Kdbx.load(Uint8Array.from(input).buffer, keePassCredentials(expected.password));
  const returned = await kdbxweb.Kdbx.load(Uint8Array.from(output).buffer, keePassCredentials(expected.password));
  const before = original.getDefaultGroup().entries, after = returned.getDefaultGroup().entries;
  expect(after.map(entry => entry.uuid.id).sort()).toEqual(before.map(entry => entry.uuid.id).sort());
  expect(after).toHaveLength(expected.passkeys.length);
  expect(proof.proofs).toHaveLength(expected.passkeys.length);
  const gaps: Array<Record<string, unknown>> = [];
  for (const key of expected.passkeys) {
    const value = after.map(entry => readKeePassPasskeyFields(entry.fields)).find(item => item?.credentialId === key.credentialId)!;
    expect(value).toMatchObject({ credentialId: key.credentialId, algorithm: key.algorithm, rpId: key.rpId,
      userHandle: key.userHandle, userName: key.userName, userDisplayName: key.userDisplayName, signCount: key.signCount,
      backupEligible: key.backupEligible, backupState: key.backupState, notes: "Android KDBX signature return" });
    expect(createHash("sha256").update(Buffer.from(value.privateKeyPkcs8!, "base64")).digest("base64")).toBe(key.keyMaterialSha256);
    const signature = proof.proofs.find((entry: any) => entry.credentialId === key.credentialId);
    expect(signature).toMatchObject({ algorithm: key.algorithm, rpId: key.rpId, userHandle: key.userHandle,
      storedSignCount: key.signCount, keyMaterialSha256: key.keyMaterialSha256, protectedRoomReference: true });
    const client = Buffer.from(signature.clientDataJSON, "base64"), auth = Buffer.from(signature.authenticatorData, "base64");
    expect(JSON.parse(client.toString())).toMatchObject({ type: "webauthn.get", origin: `https://${key.rpId}`, crossOrigin: false });
    expect(auth.subarray(0, 32)).toEqual(createHash("sha256").update(key.rpId).digest());
    const publicKey = createPublicKey({ format: "der", type: "spki", key: Buffer.from(key.spki, "base64") });
    expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), publicKey, Buffer.from(signature.signature, "base64"))).toBe(true);
    const flags = 5 | (key.backupEligible ? 8 : 0) | (key.backupState ? 16 : 0);
    if (auth[32] !== flags) gaps.push({ credentialId: key.credentialId, field: "authenticatorFlags", expected: flags, actual: auth[32] });
    if (signature.storedIsBackedUp !== key.backupState) gaps.push({ credentialId: key.credentialId, field: "androidStoredBackupState", expected: key.backupState, actual: signature.storedIsBackedUp });
    if (auth.readUInt32BE(33) !== key.signCount) gaps.push({ credentialId: key.credentialId, field: "signatureCounter", stored: key.signCount, actual: auth.readUInt32BE(33) });
  }
  await writeFile(path.join(directory, "kdbx-return-evidence.json"), JSON.stringify({ status: "passed", scope: "actual Android KDBX/Room/private-store/crypto helpers and independent Edge credential verification; not Credential Manager/UV or real Microsoft acceptance",
    passkeys: expected.passkeys.length, transport: webdav ? "actual Android WebDAV read/conditional-write with stale-version rejection" : "local KDBX", inputSha256: expected.inputSha256, outputSha256: createHash("sha256").update(output).digest("hex"),
    signatureVerified: true, keyAndFileIdentityPreserved: true, compatibilityGaps: gaps, interoperabilityComplete: false }, null, 2));
});
