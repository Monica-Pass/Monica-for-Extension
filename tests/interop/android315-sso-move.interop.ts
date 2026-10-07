import { readFile, writeFile, mkdir, mkdtemp, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createLoginItem, type ProviderAccount, type VaultItem } from "../../src/core/model";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { Mdbx2TransferAttachmentService } from "../../src/providers/mdbx2/mdbx2-transfer-attachments";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";
import { Mdbx2BatchTransferCoordinator } from "../../src/providers/mdbx2/mdbx2-batch-transfer-coordinator";
import { Mdbx2Provider } from "../../src/providers/mdbx2/mdbx2-provider";
import { decodeMdbx2Object, encodeMdbx2Object } from "../../src/providers/mdbx2/mdbx2-item-codec";
import { SecureVaultService } from "../../src/security/secure-vault-service";
import { MemoryVaultSessionStore } from "../../src/security/vault-session";
import type { VaultEnvelopeStorage } from "../../src/security/vault-storage";
import type { VaultEnvelope } from "../../src/security/vault-crypto";

class DiskEnvelope implements VaultEnvelopeStorage {
  failNext = false;
  constructor(readonly path: string) {}
  async read(): Promise<VaultEnvelope | null> {
    try { return JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async write(envelope: VaultEnvelope) {
    if (this.failNext) { this.failNext = false; throw new Error("Synthetic post-delete envelope failure"); }
    await writeFile(this.path, JSON.stringify(envelope));
  }
  async clear(): Promise<void> { throw new Error("Keep synthetic evidence"); }
}
const root = process.env.MONICA_315_SSO_MOVE_OUTPUT;
const sourcePath = process.env.MONICA_315_PROOF_SOURCE, targetPath = process.env.MONICA_315_PROOF_TARGET;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it.skipIf(!root || !sourcePath || !targetPath)("recovers actual Native SSO account groups across vaults and folders", async () => {
  if (!root || !sourcePath || !targetPath) throw new Error("Explicit synthetic fixtures required");
  await mkdir(root, { recursive: true });
  const hostRoot = await mkdtemp(join(root, "host-"));
  const connect = () => new Mdbx2NativeClient(new ProcessNativeRuntime(resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe"), hostRoot));
  let client = connect();
  const credential = { method: "password" as const, password: "Synthetic transfer fixture password" };
  const open = async (path: string) => {
    const bytes = await readFile(path), transfer = await client.beginInboundTransfer(bytes.length, hash(bytes));
    for (let offset = 0; offset < bytes.length;) offset = (await client.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
    return client.openVault({ kind: "file", handle: (await client.finishInboundTransfer(transfer.transferId)).fileHandle }, credential);
  };
  try {
    const source = await open(sourcePath), target = await open(targetPath);
    expect(source.vaultId).not.toBe(target.vaultId);
    const account = (id: string, vaultHandle: string): ProviderAccount => ({ id, kind: "mdbx2", name: id, enabled: true, isDefaultSaveTarget: false, config: { vaultHandle } });
    const sourceAccount = account("linked-source", source.vaultHandle), targetAccount = account("linked-target", target.vaultHandle);
    const note: VaultItem = { ...createLoginItem({ title: "Synthetic shared SSO account" }), replicaGroupId: `password:${randomUUID()}` };
    const groupId = randomUUID();
    const inputs: VaultItem[] = [note, ...["first", "second"].map(password => ({ ...createLoginItem({ title: `Synthetic ${password}`, password }),
      passwordGroupId: groupId, loginType: "SSO" as const, ssoRefLogicalId: note.replicaGroupId, replicaGroupId: `password:${randomUUID()}` }))];
    const sourceItems: VaultItem[] = [];
    for (const input of inputs) {
      const written = await client.upsertObject(source.vaultHandle, randomUUID(), encodeMdbx2Object(input)!);
      const record = await client.revealObject(source.vaultHandle, written.objectId);
      sourceItems.push(decodeMdbx2Object(record, { headCommitId: written.commitId, updatedAt: input.updatedAt }, sourceAccount.id).item!);
      const bytes = new Uint8Array([1, 2, sourceItems.length]);
      const upload = await client.beginAttachmentUpload(source.vaultHandle, { operationId: randomUUID(), attachmentId: randomUUID(), collectionId: written.collectionId,
        objectId: written.objectId, fileName: `synthetic-${sourceItems.length}.bin`, mediaType: "application/octet-stream", mode: "create", sizeBytes: bytes.length, sha256: hash(bytes) });
      await client.sendAttachmentUploadChunk(upload.transferId, 0, bytes); await client.finishAttachmentUpload(upload.transferId); await client.abortAttachmentUpload(upload.transferId);
    }
    const storage = new DiskEnvelope(join(root, "local-envelope.json"));
    let local = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await local.setup("Synthetic linked move password");
    await local.upsertProvider(sourceAccount); await local.upsertProvider(targetAccount); await local.applyProviderSync(sourceAccount.id, sourceItems);
    let loseResponse = true, loseReceipt = true, failAfterDelete = true, deletes = 0, writes = 0;
    const instrument = () => new Proxy(client, { get(instance, key) {
      if (key === "resolveObjectOperation") return async (...args: Parameters<Mdbx2NativeClient["resolveObjectOperation"]>) => {
        if (loseReceipt) { loseReceipt = false; throw new Error("Synthetic lost receipt"); } return instance.resolveObjectOperation(...args);
      };
      if (key === "mutateObjects") return async (...args: Parameters<Mdbx2NativeClient["mutateObjects"]>) => {
        const result = await instance.mutateObjects(...args);
        if (args[2].every(mutation => mutation.kind === "delete")) { deletes++; expect(args[2]).toHaveLength(3); if (failAfterDelete) { failAfterDelete = false; storage.failNext = true; } }
        else { writes++; expect(args[2]).toHaveLength(3); if (loseResponse) { loseResponse = false; throw new Error("Synthetic lost whole-group write response"); } }
        return result;
      };
      const value = Reflect.get(instance, key); return typeof value === "function" ? value.bind(instance) : value;
    } });
    const coordinator = () => { const native = instrument(); return new Mdbx2BatchTransferCoordinator(local, { get() { throw new Error("No foreign provider"); } }, new Mdbx2Provider(native), native, new Mdbx2TransferAttachmentService(native, {} as never)); };
    const restart = async () => {
      await client.lockVault(source.vaultHandle); await client.lockVault(target.vaultHandle); client.close(); client = connect();
      await client.openVault({ kind: "vault", handle: source.vaultHandle }, credential); await client.openVault({ kind: "vault", handle: target.vaultHandle }, credential);
      local = new SecureVaultService(storage, new MemoryVaultSessionStore()); await local.unlock("Synthetic linked move password");
    };
    const request = { itemIds: [sourceItems[0].id], targetProviderId: targetAccount.id, action: "move" as const,
      confirmed: true, preserveCategories: false, operationId: randomUUID(), operationCreatedAt: new Date().toISOString() };
    expect((await coordinator().plan(request)).transferableCount).toBe(3);
    expect((await coordinator().execute(request)).failedCount).toBe(3); expect(deletes).toBe(0);
    expect((await local.readMdbx2MoveFinalizations(request.operationId))[0]).toMatchObject({ status: "writing" });
    await restart();
    expect((await coordinator().execute(request)).failedCount).toBe(3); expect(deletes).toBe(1);
    const [prepared] = await local.readMdbx2MoveFinalizations(request.operationId); expect(prepared.status).toBe("prepared"); expect(prepared.attachments).toHaveLength(3);
    await restart();
    expect((await coordinator().execute(request)).completedCount).toBe(3);
    const verify = async () => {
      const results = await Promise.all(sourceItems.map(item => local.getItem(item.id))); expect(results.every(Boolean)).toBe(true);
      const records = await Promise.all(results.map(item => client.revealObject(target.vaultHandle, item!.providerRefs[0].remoteId!)));
      const movedNote = records.find(record => record.title === "Synthetic shared SSO account")!; expect(movedNote).toBeDefined();
      for (const record of records) if (record.title !== "Synthetic shared SSO account") expect(JSON.parse(record.payloadJson)).toMatchObject({ sso_ref_logical_id: JSON.parse(movedNote.payloadJson).monica_entry_id, password_group_id: groupId });
      for (const item of results) await new Mdbx2TransferAttachmentService(client, {} as never).verifyMoveAttachmentProofs(targetAccount, item!, prepared.attachments!.filter(proof => proof.itemId === item!.id));
      return records;
    };
    const crossRecords = await verify();
    const beforeRetry = [writes, deletes]; expect((await coordinator().execute(request)).completedCount).toBe(3); expect([writes, deletes]).toEqual(beforeRetry);
    const folder = randomUUID(); await client.createCollection(target.vaultHandle, randomUUID(), folder, "Synthetic linked group destination");
    const same = { ...request, operationId: randomUUID(), operationCreatedAt: new Date().toISOString(), targetCollectionId: folder };
    loseResponse = true; loseReceipt = true;
    expect((await coordinator().execute(same)).failedCount).toBe(3);
    const backup = join(root, "edge-sso-move-backup.json"); await writeFile(backup, JSON.stringify(await local.exportEncryptedBackup("Synthetic-Edge-315-fixture-password")));
    await client.lockVault(source.vaultHandle); await client.lockVault(target.vaultHandle); client.close();
    const edgeHost = await mkdtemp(join(root, "edge-host-")); await cp(hostRoot, edgeHost, { recursive: true });
    await writeFile(join(root, "edge-sso-move-fixture.json"), JSON.stringify({ synthetic: true, appData: edgeHost, backup, operationId: same.operationId, sourceProviderId: targetAccount.id, targetProviderId: targetAccount.id }));
    client = connect(); await client.openVault({ kind: "vault", handle: target.vaultHandle }, credential);
    local = new SecureVaultService(storage, new MemoryVaultSessionStore()); await local.unlock("Synthetic linked move password");
    expect((await coordinator().execute(same)).completedCount).toBe(3);
    const sameRecords = await verify(); expect(sameRecords.map(record => record.objectId).sort()).toEqual(crossRecords.map(record => record.objectId).sort());
    expect(sameRecords.every(record => record.collectionId === folder)).toBe(true); expect(deletes).toBe(beforeRetry[1]);
    const finalWrites = writes; expect((await coordinator().execute(same)).completedCount).toBe(3); expect(writes).toBe(finalWrites);
    await writeFile(join(root, "sso-move-evidence.json"), JSON.stringify({ status: "passed", linkedPasswords: 2, sharedAccounts: 1, attachments: 3,
      crossVaultPrewriteAndPostDeleteRestart: true, sameVaultReceiptRestart: true, ssoAccountLinkAndGroupPreserved: true,
      nativeIdsPreservedWithinVault: true, allAttachmentDigestsVerified: true, completedRetriesNoWrites: true, writes, deletes }, null, 2));
    await client.lockVault(target.vaultHandle);
  } finally { client.close(); }
});
