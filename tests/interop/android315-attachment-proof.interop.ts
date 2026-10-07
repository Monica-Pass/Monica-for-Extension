import { readFile, writeFile, mkdir, mkdtemp, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createLoginItem, type ProviderAccount, type VaultItem } from "../../src/core/model";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { Mdbx2TransferAttachmentService } from "../../src/providers/mdbx2/mdbx2-transfer-attachments";
import { readMdbx2TransferBinding, verifyMdbx2TransferTargets } from "../../src/providers/mdbx2/mdbx2-transfer-verification";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";
import { Mdbx2BatchTransferCoordinator } from "../../src/providers/mdbx2/mdbx2-batch-transfer-coordinator";
import { Mdbx2Provider } from "../../src/providers/mdbx2/mdbx2-provider";
import { decodeMdbx2Object } from "../../src/providers/mdbx2/mdbx2-item-codec";
import { SecureVaultService } from "../../src/security/secure-vault-service";
import { MemoryVaultSessionStore } from "../../src/security/vault-session";
import type { VaultEnvelopeStorage } from "../../src/security/vault-storage";
import type { VaultEnvelope } from "../../src/security/vault-crypto";

class FileVaultStorage implements VaultEnvelopeStorage {
  failNext = false;
  constructor(readonly path: string) {}
  async read(): Promise<VaultEnvelope | null> {
    try { return JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async write(envelope: VaultEnvelope): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error("Synthetic failure after actual Native source deletion"); }
    await writeFile(this.path, JSON.stringify(envelope));
  }
  async clear(): Promise<void> { throw new Error("Fixture must not clear its evidence"); }
}

const sourcePath = process.env.MONICA_315_PROOF_SOURCE, targetPath = process.env.MONICA_315_PROOF_TARGET, root = process.env.MONICA_315_PROOF_OUTPUT;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it.skipIf(!sourcePath || !targetPath || !root)("verifies Native attachment proofs and resumes a cross-vault move after source deletion and local save failure", async () => {
  if (!sourcePath || !targetPath || !root) throw new Error("Explicit synthetic fixtures and output required");
  await mkdir(root, { recursive: true });
  const hostRoot = await mkdtemp(join(root, "host-"));
  const connect = () => new Mdbx2NativeClient(new ProcessNativeRuntime(resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe"), hostRoot));
  let client = connect();
  const credential = { method: "password" as const, password: "Synthetic transfer fixture password" };
  const sourceBytes = await readFile(sourcePath), targetBytes = await readFile(targetPath);
  const open = async (bytes: Uint8Array) => {
    const transfer = await client.beginInboundTransfer(bytes.length, hash(bytes));
    for (let offset = 0; offset < bytes.length;) offset = (await client.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
    const file = await client.finishInboundTransfer(transfer.transferId);
    return client.openVault({ kind: "file", handle: file.fileHandle }, credential);
  };
  try {
    const source = await open(sourceBytes), target = await open(targetBytes);
    expect(source.vaultId).not.toBe(target.vaultId);
    const account = (id: string, vaultHandle: string): ProviderAccount => ({ id, kind: "mdbx2", name: id, enabled: true, isDefaultSaveTarget: false, config: { vaultHandle } });
    const sourceAccount = account("proof-source", source.vaultHandle), targetAccount = account("proof-target", target.vaultHandle);
    const makeItem = async (provider: ProviderAccount): Promise<VaultItem> => {
      const item = createLoginItem({ title: "Synthetic attachment proof", password: "synthetic" });
      const logicalObjectId = `password:${randomUUID()}`;
      const written = await client.upsertObject(String(provider.config.vaultHandle), randomUUID(), { logicalObjectId,
        objectTypeId: "login", title: item.title, payloadJson: JSON.stringify({ kind: "password", monica_entry_id: logicalObjectId, title: item.title, password: "synthetic", future_source: { preserved: [1, null, "synthetic"] } }) });
      return { ...item, providerRefs: [{ providerId: provider.id, remoteId: written.objectId, remoteFolderId: written.collectionId, revision: written.commitId }] };
    };
    const sourceItem = await makeItem(sourceAccount), targetItem = await makeItem(targetAccount);
    const upload = async (provider: ProviderAccount, item: VaultItem, attachmentId: string, bytes: Uint8Array, mode: "create" | "replace") => {
      const ref = item.providerRefs[0];
      const started = await client.beginAttachmentUpload(String(provider.config.vaultHandle), { operationId: randomUUID(), attachmentId,
        collectionId: ref.remoteFolderId!, objectId: ref.remoteId!, fileName: "synthetic.bin", mediaType: "application/octet-stream", mode,
        sizeBytes: bytes.length, sha256: hash(bytes) });
      await client.sendAttachmentUploadChunk(started.transferId, 0, bytes);
      await client.finishAttachmentUpload(started.transferId);
    };
    await upload(sourceAccount, sourceItem, randomUUID(), new Uint8Array([1, 2, 3]), "create");
    const service = new Mdbx2TransferAttachmentService(client, {} as never), operation = randomUUID();
    expect(await service.transferAttachments(sourceAccount, sourceItem, targetAccount, targetItem, operation)).toBe(1);
    const proofs = await service.captureMoveAttachmentProofs(sourceAccount, sourceItem, targetAccount, targetItem, operation);
    const binding = await readMdbx2TransferBinding(client, targetAccount);
    await verifyMdbx2TransferTargets(client, binding, [targetItem]);
    expect(proofs).toHaveLength(1); expect(proofs[0].sha256).toBe(hash(new Uint8Array([1, 2, 3])));
    await client.lockVault(source.vaultHandle); await client.lockVault(target.vaultHandle);
    client.close(); client = connect();
    await client.openVault({ kind: "vault", handle: target.vaultHandle }, credential);
    expect((await client.vaultStatus(source.vaultHandle)).open).toBe(false);
    const restarted = new Mdbx2TransferAttachmentService(client, {} as never);
    await restarted.verifyMoveAttachmentProofs(targetAccount, targetItem, JSON.parse(JSON.stringify(proofs)));
    await upload(targetAccount, targetItem, proofs[0].attachmentId, new Uint8Array([1, 2, 4]), "replace");
    // The object revision alone cannot detect this attachment replacement.
    await verifyMdbx2TransferTargets(client, binding, [targetItem]);
    await expect(restarted.verifyMoveAttachmentProofs(targetAccount, targetItem, proofs)).rejects.toThrow("附件校验");
    // Exercise the complete coordinator using the untouched source attachment.
    await client.openVault({ kind: "vault", handle: source.vaultHandle }, credential);
    const sourceRecord = await client.revealObject(source.vaultHandle, sourceItem.providerRefs[0].remoteId!);
    const decoded = decodeMdbx2Object(sourceRecord, { headCommitId: sourceRecord.headCommitId!, updatedAt: sourceItem.updatedAt }, sourceAccount.id).item!;
    expect(decoded).toBeDefined();
    const envelopePath = join(hostRoot, "synthetic-local-envelope.json"), storage = new FileVaultStorage(envelopePath);
    let local = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const localPassword = "Synthetic recovery envelope password";
    await local.setup(localPassword);
    await local.upsertProvider(sourceAccount); await local.upsertProvider(targetAccount);
    await local.applyProviderSync(sourceAccount.id, [decoded]);
    const before = await local.getItem(decoded.id);
    let injectFailure = true, sourceDeleteCalls = 0, targetWriteCalls = 0;
    let loseTargetResponse = true, receiptUnavailable = true;
    const instrumented = () => new Proxy(client, { get(instance, key) {
      if (key === "resolveObjectOperation") return async (...args: Parameters<Mdbx2NativeClient["resolveObjectOperation"]>) => {
        if (receiptUnavailable) { receiptUnavailable = false; throw new Error("Synthetic unavailable receipt after committed target write"); }
        return instance.resolveObjectOperation(...args);
      };
      if (key === "mutateObjects") return async (...args: Parameters<Mdbx2NativeClient["mutateObjects"]>) => {
        const result = await instance.mutateObjects(...args);
        if (args[0] === target.vaultHandle) {
          targetWriteCalls++;
          if (loseTargetResponse) { loseTargetResponse = false; throw new Error("Synthetic lost response after actual target commit"); }
        }
        if (args[0] === source.vaultHandle && args[2].every(mutation => mutation.kind === "delete")) {
          sourceDeleteCalls++;
          if (injectFailure) { injectFailure = false; storage.failNext = true; }
        }
        return result;
      };
      const value = Reflect.get(instance, key); return typeof value === "function" ? value.bind(instance) : value;
    } });
    const coordinator = (vault: SecureVaultService) => {
      const native = instrumented();
      return new Mdbx2BatchTransferCoordinator(vault, { get() { throw new Error("Unexpected foreign provider"); } },
        new Mdbx2Provider(native), native, new Mdbx2TransferAttachmentService(native, {} as never));
    };
    const request = { itemIds: [decoded.id], targetProviderId: targetAccount.id,
      action: "move" as const, confirmed: true, preserveCategories: false, operationId: randomUUID(), operationCreatedAt: new Date().toISOString() };
    const earlyInterrupted = await coordinator(local).execute(request);
    expect(earlyInterrupted.failedCount, JSON.stringify(earlyInterrupted)).toBe(1);
    expect(sourceDeleteCalls).toBe(0); expect(targetWriteCalls).toBe(1);
    const [writing] = await local.readMdbx2MoveFinalizations(request.operationId);
    expect(writing.status).toBe("writing"); expect(writing.writeIntent).toBeDefined();
    expect(await local.getItem(decoded.id)).toEqual(before);
    const earlyBackup = join(root, "edge-prewrite-backup.json");
    await writeFile(earlyBackup, JSON.stringify(await local.exportEncryptedBackup("Synthetic-Edge-315-fixture-password")));
    await client.lockVault(source.vaultHandle); await client.lockVault(target.vaultHandle); client.close();
    const earlyHost = await mkdtemp(join(root, "early-host-"));
    await cp(hostRoot, earlyHost, { recursive: true });
    await writeFile(join(root, "edge-prewrite-fixture.json"), JSON.stringify({ synthetic: true, appData: earlyHost, backup: earlyBackup,
      operationId: request.operationId, sourceProviderId: sourceAccount.id, targetProviderId: targetAccount.id }));
    client = connect();
    await client.openVault({ kind: "vault", handle: source.vaultHandle }, credential);
    await client.openVault({ kind: "vault", handle: target.vaultHandle }, credential);
    local = new SecureVaultService(storage, new MemoryVaultSessionStore()); await local.unlock(localPassword);
    expect((await local.readMdbx2MoveFinalizations(request.operationId))[0]).toEqual(writing);
    const interrupted = await coordinator(local).execute(request);
    expect(interrupted.failedCount, JSON.stringify(interrupted)).toBe(1);
    expect(sourceDeleteCalls, JSON.stringify(interrupted)).toBe(1); expect(targetWriteCalls).toBe(2);
    const [journal] = await local.readMdbx2MoveFinalizations(request.operationId);
    expect(journal.status).toBe("prepared"); expect(journal.attachments).toHaveLength(1);
    const stagedTargetRef = journal.entries[0].result.providerRefs.find(ref => ref.providerId === targetAccount.id)!;
    const stagedTarget = await client.revealObject(target.vaultHandle, stagedTargetRef.remoteId!);
    // Transfer intentionally clears backend/Room projections; all other source fields remain exact.
    expect(JSON.parse(stagedTarget.payloadJson)).toEqual({ ...JSON.parse(sourceRecord.payloadJson),
      bitwarden_mode: false, keepass_mode: false, bound_note_entry_id: null, bound_note_room_id: null, mdbx_folder_id: null });
    expect(await local.getItem(decoded.id)).toEqual(before);
    const encrypted = await readFile(envelopePath, "utf8");
    expect(encrypted).not.toContain("Synthetic attachment proof");
    const edgeBackup = join(root, "edge-pending-backup.json");
    await writeFile(edgeBackup, JSON.stringify(await local.exportEncryptedBackup("Synthetic-Edge-315-fixture-password")));
    await writeFile(join(root, "edge-recovery-fixture.json"), JSON.stringify({ synthetic: true, appData: hostRoot, backup: edgeBackup,
      operationId: request.operationId, sourceProviderId: sourceAccount.id, targetProviderId: targetAccount.id }));
    await client.lockVault(source.vaultHandle); await client.lockVault(target.vaultHandle); client.close(); client = connect();
    await client.openVault({ kind: "vault", handle: source.vaultHandle }, credential);
    await client.openVault({ kind: "vault", handle: target.vaultHandle }, credential);
    const resumedLocal = new SecureVaultService(new FileVaultStorage(envelopePath), new MemoryVaultSessionStore());
    await resumedLocal.unlock(localPassword);
    const resumed = coordinator(resumedLocal);
    const recovered = await resumed.execute(request);
    expect(recovered.completedCount, JSON.stringify(recovered)).toBe(1);
    expect(targetWriteCalls).toBe(2); expect(sourceDeleteCalls).toBe(2);
    expect(await resumedLocal.getItem(decoded.id)).toEqual(journal.entries[0].result);
    expect((await resumedLocal.readMdbx2MoveFinalizations(request.operationId))[0].status).toBe("completed");
    const targetRef = journal.entries[0].result.providerRefs.find(ref => ref.providerId === targetAccount.id)!;
    const actualTarget = await client.revealObject(target.vaultHandle, targetRef.remoteId!);
    expect(actualTarget.payloadJson).toBe(stagedTarget.payloadJson);
    await new Mdbx2TransferAttachmentService(client, {} as never).verifyMoveAttachmentProofs(targetAccount, journal.entries[0].result, journal.attachments!);
    expect((await resumed.execute(request)).completedCount).toBe(1);
    expect(sourceDeleteCalls).toBe(2); expect(targetWriteCalls).toBe(2);
    const tombstones = await client.listObjects(source.vaultHandle, sourceRecord.collectionId, { deleted: true });
    expect(tombstones.items.some(item => item.objectId === sourceRecord.objectId && item.deleted)).toBe(true);
    await writeFile(join(root, "move-resume-evidence.json"), JSON.stringify({ status: "passed", operationId: request.operationId,
      actualSourceDeleteBeforePersistenceFailure: true, restartedHostAndDiskEnvelope: true, targetPayloadUnchangedAcrossRecovery: true,
      actualTargetCommitBeforeLostResponse: true, prewriteJournalResumedAfterHostAndEnvelopeRestart: true,
      sourceFieldsPreservedExceptExplicitTransferProjectionReset: true,
      targetAttachmentDigest: journal.attachments![0].sha256, sourceTombstonePresent: true, sourceDeleteCalls, targetWriteCalls,
      completedRetryNoNativeWrites: true, scope: "Real Native coordinator cross-vault move resume with one password and attachment; not Edge UI or linked-note moves" }, null, 2));
    const sameCollection = randomUUID();
    await client.createCollection(target.vaultHandle, randomUUID(), sameCollection, "Synthetic same-vault destination");
    const sameRequest = { ...request, operationId: randomUUID(), operationCreatedAt: new Date().toISOString(), targetCollectionId: sameCollection };
    loseTargetResponse = true; receiptUnavailable = true;
    const sameInterrupted = await coordinator(resumedLocal).execute(sameRequest);
    expect(sameInterrupted.failedCount, JSON.stringify(sameInterrupted)).toBe(1);
    const [sameWriting] = await resumedLocal.readMdbx2MoveFinalizations(sameRequest.operationId);
    expect(sameWriting).toMatchObject({ status: "writing", sourceProviderId: targetAccount.id, targetProviderId: targetAccount.id });
    expect(sameWriting.attachments).toHaveLength(1);
    const movedNative = await client.revealObject(target.vaultHandle, targetRef.remoteId!);
    expect(movedNative.collectionId).toBe(sameCollection); expect(movedNative.objectId).toBe(targetRef.remoteId);
    const movedAttachments = await client.listAttachments(target.vaultHandle, sameCollection, targetRef.remoteId!);
    await writeFile(join(root, "same-vault-attachment-location.json"), JSON.stringify({ operationId: sameRequest.operationId,
      objectId: targetRef.remoteId, oldCollectionId: targetRef.remoteFolderId, newCollectionId: sameCollection,
      savedAttachmentProofs: sameWriting.attachments, newCollectionAttachments: movedAttachments.items }, null, 2));
    await expect(client.listAttachments(target.vaultHandle, targetRef.remoteFolderId!, targetRef.remoteId!)).rejects.toThrow("selected Collection");
    const sameBackup = join(root, "edge-same-vault-backup.json");
    await writeFile(sameBackup, JSON.stringify(await resumedLocal.exportEncryptedBackup("Synthetic-Edge-315-fixture-password")));
    await client.lockVault(source.vaultHandle); await client.lockVault(target.vaultHandle); client.close();
    const sameHost = await mkdtemp(join(root, "same-host-")); await cp(hostRoot, sameHost, { recursive: true });
    await writeFile(join(root, "edge-same-vault-fixture.json"), JSON.stringify({ synthetic: true, appData: sameHost, backup: sameBackup,
      operationId: sameRequest.operationId, sourceProviderId: targetAccount.id, targetProviderId: targetAccount.id }));
    client = connect();
    await client.openVault({ kind: "vault", handle: target.vaultHandle }, credential);
    const sameLocal = new SecureVaultService(new FileVaultStorage(envelopePath), new MemoryVaultSessionStore()); await sameLocal.unlock(localPassword);
    const sameRecovered = await coordinator(sameLocal).execute(sameRequest);
    expect(sameRecovered.completedCount, JSON.stringify(sameRecovered)).toBe(1);
    expect(sourceDeleteCalls).toBe(2); expect(targetWriteCalls).toBe(4);
    const sameResult = (await sameLocal.getItem(decoded.id))!;
    expect(sameResult.providerRefs[0]).toMatchObject({ remoteId: targetRef.remoteId, remoteFolderId: sameCollection });
    await new Mdbx2TransferAttachmentService(client, {} as never).verifyMoveAttachmentProofs(targetAccount, sameResult, sameWriting.attachments!);
    expect((await client.revealObject(target.vaultHandle, targetRef.remoteId!)).payloadJson).toBe(movedNative.payloadJson);
    expect((await coordinator(sameLocal).execute(sameRequest)).completedCount).toBe(1);
    expect(sourceDeleteCalls).toBe(2); expect(targetWriteCalls).toBe(4);
    await writeFile(join(root, "same-vault-resume-evidence.json"), JSON.stringify({ status: "passed", operationId: sameRequest.operationId,
      nativeUuidPreserved: true, oldFolderAttachmentLookupRejected: true, prewriteAttachmentDigestVerified: sameWriting.attachments![0].sha256,
      restartedHostAndDiskEnvelope: true, replayedOriginalWriteReceipt: true, noSourceDelete: true, completedRetryNoNativeWrites: true,
      scope: "Actual Native same-vault password and attachment move; source of earlier cross-vault move remains locked" }, null, 2));
    expect(hash(await readFile(sourcePath))).toBe(hash(sourceBytes)); expect(hash(await readFile(targetPath))).toBe(hash(targetBytes));
    await writeFile(join(root, "attachment-proof-evidence.json"), JSON.stringify({ status: "passed", sourceVaultId: source.vaultId,
      targetVaultId: target.vaultId, digest: proofs[0].sha256, restartWithSourceLockedPassed: true, sameSizeReplacementRejected: true,
      objectRevisionUnchangedByAttachmentReplacement: true, originalFixturesUnchanged: true,
      scope: "Actual Native attachment proof primitives across two vaults; not coordinator crash recovery" }, null, 2));
  } finally { client.close(); }
});
