import { expect, it } from "vitest";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PasskeyItem } from "../../src/core/model";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { decodeMdbx2Object } from "../../src/providers/mdbx2/mdbx2-item-codec";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";

const output = process.env.MONICA_317_PASSKEY_ANDROID_RETURN;
const edgeOutput = process.env.MONICA_317_PASSKEY_EDGE_RESULT;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const digest = (value: string) => createHash("sha256").update(Buffer.from(value, "base64")).digest("base64");

it.skipIf(!output || !edgeOutput)("actual Edge RSA registration returns through Android protected storage and independently verified signatures", async () => {
  if (!output || !edgeOutput) throw new Error("Explicit Edge and Android result directories required");
  const edge = JSON.parse(await readFile(join(edgeOutput, "evidence.json"), "utf8"));
  expect(edge.status).toBe("passed"); expect(edge.restartVerified).toBe(true); expect(edge.nativeHost.restored).toBe(true);
  const expected = JSON.parse(await readFile(join(edgeOutput, "edge-passkeys-expected.json"), "utf8")) as {
    credentialId: string; algorithm: number; spki: string; keyMaterialSha256: string; signCount: number; backupEligible: boolean; backupState: boolean;
  }[];
  expect(expected).toHaveLength(5);
  expect(new Set(expected.map(row => row.credentialId)).size).toBe(5);
  expect(expected.find(row => row.credentialId === edge.createdCredentialId)?.algorithm).toBe(-257);
  const android = JSON.parse(await readFile(join(output, "passkey-signatures-import-evidence.json"), "utf8"));
  expect(android.status).toBe("passed");
  if (edge.compatibilityGaps.length === 0) {
    const build = JSON.parse(await readFile(join(output, "build-evidence.json"), "utf8"));
    const source = JSON.parse(await readFile(join(output, "source-proof.json"), "utf8"));
    expect(build.status).toBe("passed"); expect(source.status).toBe("passed");
    expect(android.installedApkSha256).toBe(build.builtAppApkSha256);
    expect(android.installedTestApkSha256).toBe(build.builtTestApkSha256);
    expect(android.baseline).toEqual(build.baseline); expect(android.testSourceHashes).toEqual(build.testSourceHashes);
    expect(source.inputSha256).toBe(edge.exportSha256);
    for (const [name, proof] of Object.entries(source.files) as [string, { sha256: string }][]) expect(hash(await readFile(name))).toBe(proof.sha256);
  }
  for (const flag of ["androidSourcesUnchanged", "testSourcesUnchanged", "installedApplicationUnchanged", "installedTestApkUnchanged", "deviceBootUnchanged"]) expect(android[flag], flag).toBe(true);
  for (const file of android.outputs) expect(hash(await readFile(join(output, file.name)))).toBe(file.sha256);
  expect(android.inputs).toEqual([expect.objectContaining({ name: "extension-passkeys.mdbx", sha256: edge.exportSha256 })]);
  expect(hash(await readFile(join(edgeOutput, "edge-passkeys.mdbx")))).toBe(edge.exportSha256);
  const signed = JSON.parse(await readFile(join(output, "android-return-signatures.json"), "utf8"));
  expect(signed.synthetic).toBe(true); expect(signed.proofs).toHaveLength(5);
  expect(new Set(signed.proofs.map((row: any) => row.credentialId)).size).toBe(5);
  const executable = resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe");
  expect(hash(await readFile(executable))).toBe(edge.nativeHost.sha256);
  const native = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, await mkdtemp(join(output, "edge-return-host-"))));
  const evidence: Record<string, any> = { status: "failed", edgeOutput, edgeExportSha256: edge.exportSha256, androidAppSha256: android.installedApkSha256,
    androidTestSha256: android.installedTestApkSha256, signatures: [], compatibilityGaps: [], interoperabilityComplete: false,
    scope: "Actual Edge registration/Native file -> actual Android repository/private-store/projection/crypto helpers -> independent Native/Node verification. No Android Credential Manager or true Android UV." };
  try {
    const snapshots: Map<string, string>[] = [];
    for (const fileName of ["extension-passkeys.mdbx", "android-return-passkeys.mdbx"]) {
      const bytes = await readFile(join(output, fileName));
      if (fileName === "extension-passkeys.mdbx") expect(hash(bytes)).toBe(edge.exportSha256);
      else evidence.androidReturnSha256 = hash(bytes);
      const transfer = await native.beginInboundTransfer(bytes.length, hash(bytes));
      for (let offset = 0; offset < bytes.length;) offset = (await native.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
      const file = await native.finishInboundTransfer(transfer.transferId);
      const opened = await native.openVault({ kind: "file", handle: file.fileHandle }, { method: "password", password: "Synthetic transfer fixture password" });
      const collections = await native.listCollections(opened.vaultHandle); expect(collections.nextCursor).toBeUndefined();
      const identities = new Map<string, string>();
      for (const collection of collections.items) {
        const rows = await native.listObjects(opened.vaultHandle, collection.collectionId); expect(rows.nextCursor).toBeUndefined();
        for (const row of rows.items) {
          const record = await native.revealObject(opened.vaultHandle, row.objectId);
          const item = decodeMdbx2Object(record, { headCommitId: row.headCommitId, updatedAt: row.updatedAt }, "android-edge-passkeys").item as PasskeyItem;
          expect(item.kind).toBe("passkey");
          const original = expected.find(value => value.credentialId === item.credentialId)!; expect(original).toBeDefined();
          expect(identities.has(item.credentialId)).toBe(false); identities.set(item.credentialId, record.objectId);
          expect(item.algorithm).toBe(original.algorithm); expect(item.signCount).toBe(original.signCount);
          expect(item.backupEligible ?? true).toBe(original.backupEligible); expect(item.backupState ?? true).toBe(original.backupState);
          expect(item.userHandle).toBe("AAEC_w"); expect(digest(item.privateKeyPkcs8!)).toBe(original.keyMaterialSha256);
          if (fileName !== "android-return-passkeys.mdbx") continue;
          const proof = signed.proofs.find((value: any) => value.credentialId === item.credentialId);
          expect(proof).toMatchObject({ algorithm: original.algorithm, rpId: "passkey-interop.example.test", userHandle: "AAEC_w", storedSignCount: original.signCount,
            protectedRoomReference: true, keyMaterialSha256: original.keyMaterialSha256 });
          const auth = Buffer.from(proof.authenticatorData, "base64"), client = Buffer.from(proof.clientDataJSON, "base64");
          expect(auth.length).toBe(37); expect(auth.subarray(0, 32).toString("hex")).toBe(hash(item.rpId));
          expect(JSON.parse(client.toString())).toMatchObject({ type: "webauthn.get", origin: `https://${item.rpId}`, crossOrigin: false });
          expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), createPublicKey({ key: Buffer.from(original.spki, "base64"), format: "der", type: "spki" }), Buffer.from(proof.signature, "base64"))).toBe(true);
          const flags = 5 | (original.backupEligible ? 8 : 0) | (original.backupState ? 16 : 0);
          if (auth[32] !== flags) evidence.compatibilityGaps.push({ kind: "android-authenticator-backup-flags", credentialId: item.credentialId, expectedFlags: flags, actualFlags: auth[32] });
          evidence.signatures.push({ credentialId: item.credentialId, algorithm: item.algorithm, flags: auth[32], count: auth.readUInt32BE(33), storedCount: item.signCount,
            generatedByEdgeUi: item.credentialId === edge.createdCredentialId, protectedRoomReference: true, independentSignatureVerified: true });
        }
      }
      expect(identities.size).toBe(5); snapshots.push(identities);
      await native.lockVault(opened.vaultHandle);
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(evidence.signatures).toHaveLength(5);
    expect(evidence.signatures.find((row: any) => row.generatedByEdgeUi)).toMatchObject({ algorithm: -257, independentSignatureVerified: true });
    evidence.nativeObjectIdsPreserved = true;
    evidence.androidHelperUsesTestSuppliedZeroCount = true;
    evidence.androidCounterPolicyVerified = false;
    evidence.edgePositiveCounterGaps = edge.compatibilityGaps;
    evidence.status = "passed";
  } catch (error) { evidence.error = String(error); throw error; }
  finally { native.close(); await writeFile(join(output, "edge-return-evidence.json"), JSON.stringify(evidence, null, 2)); }
});
