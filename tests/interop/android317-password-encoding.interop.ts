import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createLoginItem, type LoginItem, type ProviderAccount } from "../../src/core/model";
import { parseLosslessJson } from "../../src/core/lossless-json";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import type { Mdbx2ObjectRecord, Mdbx2ObjectMutationInput } from "../../src/providers/mdbx2/native-contract";
import { Mdbx2Provider } from "../../src/providers/mdbx2/mdbx2-provider";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";

const root = process.env.MONICA_315_APP_FIXTURE;
const phase = process.env.MONICA_PASSWORD_ENCODING_PHASE;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
class LostResponseClient extends Mdbx2NativeClient {
  loseResponse = false;
  async mutateObjects(handle: string, operationScope: string, mutations: Mdbx2ObjectMutationInput[]) {
    const committed = await super.mutateObjects(handle, operationScope, mutations);
    if (this.loseResponse) { this.loseResponse = false; throw new Error("Synthetic committed response loss"); }
    return committed;
  }
}

it.skipIf(!root || !phase)(`real Android ciphertext as a literal password: ${phase}`, async () => {
  if (!root || !["prepare", "return"].includes(phase || "")) throw new Error("Explicit fixture and prepare/return phase required");
  await mkdir(root, { recursive: true });
  const probe = JSON.parse(await readFile(join(root, "password-encoding-probe.json"), "utf8"));
  expect(probe.synthetic).toBe(true); expect(probe.literal).not.toBe(probe.cleartext);
  const stage = phase === "prepare" ? "password-encoding-export" : "password-encoding-import";
  const provenance = JSON.parse(await readFile(join(root, `${stage}-evidence.json`), "utf8"));
  expect(provenance.status).toBe("passed");
  for (const key of ["androidSourcesUnchanged", "testSourcesUnchanged", "installedApplicationUnchanged", "installedTestApkUnchanged", "deviceBootUnchanged"]) expect(provenance[key], key).toBe(true);
  const fileName = phase === "prepare" ? "android.mdbx" : "android-return.mdbx";
  const bytes = await readFile(join(root, fileName));
  expect(hash(bytes)).toBe(provenance.outputs.find((file: { name: string }) => file.name === fileName).sha256);
  const seedProvenance = JSON.parse(await readFile(join(root, "password-encoding-export-evidence.json"), "utf8"));
  expect(hash(await readFile(join(root, "password-encoding-probe.json")))).toBe(seedProvenance.outputs.find((file: { name: string }) => file.name === "password-encoding-probe.json").sha256);
  const executable = resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe");
  const client = new LostResponseClient(new ProcessNativeRuntime(executable, await mkdtemp(join(root, `encoding-${phase}-host-`))));
  const evidence: Record<string, unknown> = { status: "failed", phase, sourceSha256: hash(bytes), hostSha256: hash(await readFile(executable)),
    layer: "Actual Android SecurityManager + extension production MDBX provider + actual Native Host; application return uses Android repair/Room/PasswordViewModel/export" };
  try {
    const transfer = await client.beginInboundTransfer(bytes.length, hash(bytes));
    for (let offset = 0; offset < bytes.length;) offset = (await client.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
    const staged = await client.finishInboundTransfer(transfer.transferId);
    const opened = await client.openVault({ kind: "file", handle: staged.fileHandle }, { method: "password", password: "Synthetic transfer fixture password" });
    const account: ProviderAccount = { id: "encoding-317", kind: "mdbx2", enabled: true, name: "Synthetic encoding test", isDefaultSaveTarget: false,
      config: { vaultHandle: opened.vaultHandle, nativeVaultId: opened.vaultId } };
    const provider = new Mdbx2Provider(client);
    const snapshot = async () => {
      const collections = await client.listCollections(opened.vaultHandle); expect(collections.nextCursor).toBeUndefined();
      const rows: Mdbx2ObjectRecord[] = [];
      for (const collection of collections.items) {
        const listed = await client.listObjects(opened.vaultHandle, collection.collectionId); expect(listed.nextCursor).toBeUndefined();
        for (const item of listed.items) rows.push(await client.revealObject(opened.vaultHandle, item.objectId));
      }
      return rows;
    };
    const loaded = await provider.sync(account, { localItems: [], now: new Date().toISOString() });
    if (phase === "prepare") {
      expect(loaded.items).toHaveLength(1);
      const original = loaded.items[0] as LoginItem;
      expect(original.kind).toBe("login"); expect(original.password).toBe("original-password");
      const edited = { ...original, password: probe.literal };
      client.loseResponse = true;
      await expect(provider.sync(account, { localItems: [edited], now: new Date().toISOString() })).rejects.toThrow("Synthetic committed response loss");
      const committed = await snapshot();
      const recovered = await new Mdbx2Provider(client).sync(account, { localItems: [edited], now: new Date().toISOString() });
      expect(recovered.conflicts).toEqual([]); expect(recovered.items).toHaveLength(1);
      expect((recovered.items[0] as LoginItem).password).toBe(probe.literal);
      expect(await snapshot()).toEqual(committed);
      await provider.create(account, { ...createLoginItem({ title: "synthetic-encoding-new", password: probe.literal, username: "synthetic" }), mdbxFolderId: original.mdbxFolderId });
      // Deliberately create one authentic legacy ciphertext without the marker.
      // This is a repair-control fixture, not a production extension write.
      const legacyId = `password:${randomUUID()}`;
      await client.upsertObject(opened.vaultHandle, randomUUID(), { logicalObjectId: legacyId, collectionId: original.mdbxFolderId,
        objectTypeId: "login", title: "synthetic-encoding-legacy", payloadSchemaVersion: 1,
        payloadJson: JSON.stringify({ kind: "password", monica_entry_id: legacyId, password_plain: probe.literal, future: { keep: true } }) });
      const rows = await snapshot(); expect(rows).toHaveLength(3);
      for (const row of rows) {
        const payload = JSON.parse(row.payloadJson);
        expect(payload.password_plain).toBe(probe.literal);
        expect(payload.monica_password_encoding).toBe(row.title.endsWith("-encoding-legacy") ? undefined : "plaintext-v1");
      }
      const binding = hash(`password-encoding:${randomUUID()}`);
      const exported = await client.prepareSyncBootstrap(opened.vaultHandle, binding);
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < exported.file.sizeBytes;) {
        const chunk = await client.readOutputFile(opened.vaultHandle, exported.stateHandle, binding, exported.file.fileHandle, offset);
        expect(chunk.nextOffset).toBeGreaterThan(offset); chunks.push(Buffer.from(chunk.dataBase64, "base64")); offset = chunk.nextOffset;
      }
      const outgoing = Buffer.concat(chunks); expect(hash(outgoing)).toBe(exported.file.sha256);
      await writeFile(join(root, "extension.mdbx"), outgoing);
      await writeFile(join(root, "encoding-extension-records.json"), JSON.stringify(rows, null, 2));
      Object.assign(evidence, { status: "passed", extensionCreated: 1, extensionChanged: 1, unmarkedRepairControls: 1, committedResponseLossRecovered: true, outputSha256: hash(outgoing) });
    } else {
      const report = JSON.parse(await readFile(join(root, "password-encoding-readback.json"), "utf8"));
      expect(report).toEqual({ status: "passed", actualCiphertextAuthenticated: true, literalPasswordsPreserved: 2, legacyCiphertextsRepaired: 1, editedThroughPasswordViewModel: true, reopened: true });
      expect(provenance.installedApkSha256).toBe(seedProvenance.installedApkSha256);
      const expected = JSON.parse(await readFile(join(root, "encoding-extension-records.json"), "utf8")) as Mdbx2ObjectRecord[];
      const rows = await snapshot(); expect(rows).toHaveLength(3); expect(loaded.items).toHaveLength(3);
      for (const before of expected) {
        const after = rows.find(row => row.objectId === before.objectId)!; expect(after).toBeDefined();
        expect(after.title).toBe(before.title); expect(after.collectionId).toBe(before.collectionId);
        const old = parseLosslessJson(before.payloadJson) as Record<string, unknown>, payload = parseLosslessJson(after.payloadJson) as Record<string, unknown>;
        const legacy = before.title.endsWith("-encoding-legacy");
        expect(payload.password_plain).toBe(legacy ? probe.cleartext : probe.literal);
        expect(payload.monica_password_encoding).toBe("plaintext-v1");
        if (legacy) expect(payload).toEqual({ ...old, password_plain: probe.cleartext, monica_password_encoding: "plaintext-v1" });
        else {
          expect(payload.notes).toBe("Android encoding edit");
          expect(payload.room_id).toEqual(expect.any(Number));
          const expectedPayload: Record<string, unknown> = { ...old, notes: payload.notes, room_id: payload.room_id };
          if (before.title === "synthetic-encoding-new") {
            // Android's existing single-password save assigns a project ID and
            // drops these exact empty/default fields. Do not ignore arbitrary diffs.
            expect(old.password_group_id).toBeNull();
            expect(payload.password_group_id).toMatch(/^[0-9a-f-]{36}$/);
            expectedPayload.password_group_id = payload.password_group_id;
            const emptyFields = { bound_note_entry_id: null, bound_note_room_id: null, category_id: null,
              sso_provider: "", sso_ref_entry_id: null, sso_ref_logical_id: null };
            for (const [key, empty] of Object.entries(emptyFields)) {
              expect(old[key]).toBe(empty); expect(Object.hasOwn(payload, key)).toBe(false);
              delete expectedPayload[key];
            }
            expect(old.mdbx_folder_id).toBe(before.collectionId);
            const folders = await client.listCollections(opened.vaultHandle);
            expect(folders.items.find(folder => folder.collectionId === after.collectionId)?.title).toBe(".monica-root");
            expect(Object.hasOwn(payload, "mdbx_folder_id")).toBe(false);
            delete expectedPayload.mdbx_folder_id;
            evidence.newSingletonNormalization = { assignedProjectId: payload.password_group_id,
              removedEmptyFields: Object.keys(emptyFields), rootFolderPayloadOmittedWithSameNativeCollection: true };
          }
          expect(payload).toEqual(expectedPayload);
        }
        const decoded = loaded.items.find(item => item.providerRefs.some(ref => ref.remoteId === after.objectId)) as LoginItem;
        expect(decoded.password).toBe(legacy ? probe.cleartext : probe.literal);
      }
      Object.assign(evidence, { status: "passed", exactLiteralPasswords: 2, repairedLegacyPasswords: 1, nativeIdentitiesPreserved: true, otherFieldsExactOutsideDocumentedNormalization: true });
    }
    expect(hash(await readFile(join(root, fileName)))).toBe(hash(bytes));
  } catch (error) { evidence.error = String(error); throw error; }
  finally { client.close(); await writeFile(join(root, `encoding-${phase}-evidence.json`), JSON.stringify(evidence, null, 2)); }
});
