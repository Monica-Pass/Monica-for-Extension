import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { unzipSync } from "fflate";
import { Mdbx2NativeClient } from "../src/providers/mdbx2/native-client";
import type { Mdbx2ObjectRecord } from "../src/providers/mdbx2/native-contract";
import { ProcessNativeRuntime } from "../tests/interop/mdbx2-interop-support";

const evidenceFile = process.argv[2]; if (!evidenceFile) throw new Error("Pass the real Edge evidence.json path");
const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
assert.equal(evidence.status, "passed"); assert.equal(evidence.nativeHost.restored, true); assert.deepEqual(evidence.errors, []);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
assert.equal(hash(await readFile(evidence.nativeHost.executable)), evidence.nativeHost.sha256);
assert.equal(hash(await readFile(evidence.input.path)), evidence.input.sha256);
const archive = await readFile(evidence.archive.path); assert.equal(hash(archive), evidence.archive.sha256);
const files = unzipSync(archive); assert.equal(Object.keys(files).length, 14);
for (const [name, bytes] of Object.entries(files)) if (name !== "vault.mdbx") {
  const parts = name.split("/"); assert.equal(parts.length, 4); assert.equal(parts[0], "vault.mdbx.blobs");
  assert.equal(parts[1], parts[3].slice(0, 2)); assert.equal(parts[2], parts[3].slice(2, 4)); assert.equal(hash(bytes), parts[3]);
}
const nativeExpected: {objectId: string; value: Mdbx2ObjectRecord}[] = JSON.parse(await readFile(path.join(evidence.runRoot, "expected-native-objects.json"), "utf8"));
const nativeActual: Mdbx2ObjectRecord[] = [];
const appData = path.join(evidence.runRoot, "restored"); const nativeRoot = path.join(appData, "Monica Extension/MDBX2");
const handles = (await readdir(path.join(nativeRoot, "vaults"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); assert.equal(handles.length, 1);
const client = new Mdbx2NativeClient(new ProcessNativeRuntime(evidence.nativeHost.executable, appData));
let attachmentProof: Record<string, unknown> | undefined;
try {
  const session = await client.openVault({ kind: "vault", handle: handles[0] }, { method: "password", password: "Synthetic transfer fixture password" });
  for (const expected of nativeExpected) {
    const actual = await client.revealObject(session.vaultHandle, expected.objectId); assert.deepEqual(actual, expected.value); nativeActual.push(actual);
    const attachments = await client.listAttachments(session.vaultHandle, actual.collectionId, actual.objectId);
    for (const attachment of attachments.items) {
      assert.equal(attachment.fileName, "完整附件.bin"); const start = await client.beginAttachmentRead(session.vaultHandle, attachment.attachmentId);
      const chunks: Buffer[] = [];
      try { for (let offset = 0; offset < start.sizeBytes;) {
        const chunk = await client.readAttachmentChunk(start.readHandle, offset); const bytes = Buffer.from(chunk.dataBase64, "base64");
        assert.equal(chunk.nextOffset, offset + bytes.length); assert.ok(bytes.length); chunks.push(bytes); offset = chunk.nextOffset;
      } } finally { await client.releaseAttachmentRead(start.readHandle); }
      const actualBytes = Buffer.concat(chunks), original = Buffer.alloc(3 * 1024 * 1024 + 73);
      for (let i = 0; i < original.length; i++) original[i] = i % 251;
      assert.deepEqual(actualBytes, original); attachmentProof = { bytes: actualBytes.length, sha256: hash(actualBytes), attachmentId: attachment.attachmentId };
    }
  }
  assert.ok(attachmentProof); assert.equal(nativeActual.length, 7); await client.lockVault(session.vaultHandle);
} finally { client.close(); }
const keys = JSON.parse(await readFile(path.join(path.dirname(evidence.input.path), "edge-passkeys-expected.json"), "utf8"));
const assertion = JSON.parse(await readFile(path.join(evidence.runRoot, "restored-rsa-assertion.json"), "utf8")); const key = keys.at(-1);
const auth = Buffer.from(assertion.response.authenticatorData, "base64url"), clientData = Buffer.from(assertion.response.clientDataJSON, "base64url");
assert.equal(assertion.id, key.credentialId); assert.equal(auth.length, 37); assert.equal(auth.subarray(0, 32).toString("hex"), hash("passkey-interop.example.test"));
assert.equal(auth[32], 29); assert.equal(auth.readUInt32BE(33), 0);
assert.deepEqual(JSON.parse(clientData.toString()), { type: "webauthn.get", challenge: Buffer.alloc(32, 87).toString("base64url"), origin: "https://passkey-interop.example.test", crossOrigin: false });
assert.deepEqual(Buffer.from(assertion.response.userHandle, "base64url"), Buffer.from([0, 1, 2, 255]));
assert.ok(verify("sha256", Buffer.concat([auth, createHash("sha256").update(clientData).digest()]), createPublicKey({ key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" }), Buffer.from(assertion.response.signature, "base64url")));
await writeFile(path.join(evidence.runRoot, "independent-native-readback.json"), JSON.stringify(nativeActual, null, 2));
await writeFile(path.join(evidence.runRoot, "independent-review.json"), JSON.stringify({ status: "passed", at: new Date().toISOString(), archiveSha256: hash(archive), blobCount: 13, nativeObjectsExact: nativeActual.length, attachment: attachmentProof, originalRsaSignature: true, flags: auth[32], signCount: auth.readUInt32BE(33), androidAcceptance: false }, null, 2));
console.log("Independent review passed: 13 ciphertext Blobs, 7 exact persisted Native objects, attachment bytes and original RSA assertion.");
