import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../security/encoding";
import {
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  ProviderAttachmentError,
  type ProviderAttachmentMutationResult,
  type ProviderAttachmentReadBeginResult,
  type ProviderAttachmentReadChunk,
  type ProviderAttachmentSummary,
  type ProviderAttachmentUploadBeginResult,
  type ProviderAttachmentUploadChunkResult
} from "./attachment-contract";
import {
  ProviderAttachmentTransferCoordinator,
  type ProviderAttachmentTransferBackend,
  type ProviderAttachmentTransferRequest
} from "./attachment-transfer";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

interface StoredAttachment {
  summary: ProviderAttachmentSummary;
  bytes: Uint8Array;
}

class TransferBackendFake implements ProviderAttachmentTransferBackend {
  readonly events: string[] = [];
  readonly attachments = new Map<string, StoredAttachment>();
  corruptTargetRead = false;
  failSourceDelete = false;
  private readonly reads = new Map<string, { key: string; providerId: string }>();
  private readonly uploads = new Map<string, { providerId: string; itemId: string; attachmentId: string; fileName: string; mediaType?: string; operationId: string; bytes: Uint8Array; received: number; committed?: ProviderAttachmentMutationResult }>();
  private readonly uploadByOperation = new Map<string, string>();
  private sequence = 0;
  failFinishAfterCommit = false;
  mismatchTargetSummary = false;

  put(providerId: string, itemId: string, attachmentId: string, bytes: Uint8Array, fileName = "evidence.bin"): void {
    this.attachments.set(key(providerId, itemId, attachmentId), {
      summary: { attachmentId, providerKind: providerId.includes("keepass") ? "keepass" : "mdbx2", fileName, sizeBytes: bytes.byteLength, protected: true, mediaType: "application/octet-stream" },
      bytes: bytes.slice()
    });
  }

  get(providerId: string, itemId: string, attachmentId: string): Uint8Array | undefined {
    return this.attachments.get(key(providerId, itemId, attachmentId))?.bytes.slice();
  }

  async beginRead(providerId: string, itemId: string, attachmentId: string): Promise<ProviderAttachmentReadBeginResult> {
    const stored = this.attachments.get(key(providerId, itemId, attachmentId));
    if (!stored) throw new ProviderAttachmentError("attachment-not-found", "missing attachment");
    const readHandle = `read-${++this.sequence}`;
    this.reads.set(readHandle, { key: key(providerId, itemId, attachmentId), providerId });
    this.events.push(`read-begin:${providerId}`);
    return { ...stored.summary, readHandle, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES };
  }

  async readChunk(providerId: string, readHandle: string, offset: number, maxBytes: number): Promise<ProviderAttachmentReadChunk> {
    const route = this.reads.get(readHandle);
    if (!route || route.providerId !== providerId) throw new Error("read route missing");
    const stored = this.attachments.get(route.key)!;
    const end = Math.min(stored.bytes.byteLength, offset + Math.min(maxBytes, 2));
    const bytes = stored.bytes.slice(offset, end);
    if (this.corruptTargetRead && providerId === "target-keepass" && offset === 0 && bytes.length) bytes[0] ^= 0xff;
    this.events.push(`read-chunk:${providerId}:${offset}`);
    return { readHandle, attachmentId: stored.summary.attachmentId, fileName: stored.summary.fileName, sizeBytes: stored.summary.sizeBytes, offset, nextOffset: end, dataBase64: bytesToBase64(bytes), eof: end === stored.bytes.byteLength };
  }

  async releaseRead(providerId: string, readHandle: string): Promise<boolean> {
    this.events.push(`read-release:${providerId}`);
    return this.reads.delete(readHandle);
  }

  async beginUpload(providerId: string, itemId: string, input: { fileName: string; mediaType?: string; sizeBytes: number; replaceExisting: false; operationId: string; attachmentId: string }): Promise<ProviderAttachmentUploadBeginResult> {
    const existingTransferId = this.uploadByOperation.get(input.operationId);
    if (existingTransferId) {
      const existing = this.uploads.get(existingTransferId)!;
      this.events.push(`upload-resume:${providerId}`);
      return { transferId: existingTransferId, nextOffset: existing.received, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES, expiresAt: Date.now() + 60_000, operationId: input.operationId, attachmentId: input.attachmentId };
    }
    if ([...this.attachments.values()].some((entry) => entry.summary.fileName === input.fileName && entry.summary.providerKind === (providerId.includes("keepass") ? "keepass" : "mdbx2"))) {
      throw new ProviderAttachmentError("attachment-name-conflict", "name conflict");
    }
    const transferId = `upload-${++this.sequence}`;
    this.uploads.set(transferId, { providerId, itemId, attachmentId: input.attachmentId, fileName: input.fileName, mediaType: input.mediaType, operationId: input.operationId, bytes: new Uint8Array(input.sizeBytes), received: 0 });
    this.uploadByOperation.set(input.operationId, transferId);
    this.events.push(`upload-begin:${providerId}`);
    return { transferId, nextOffset: 0, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES, expiresAt: Date.now() + 60_000, operationId: input.operationId, attachmentId: input.attachmentId };
  }

  async uploadChunk(providerId: string, transferId: string, offset: number, bytes: Uint8Array): Promise<ProviderAttachmentUploadChunkResult> {
    const upload = this.uploads.get(transferId)!;
    expect(upload.providerId).toBe(providerId);
    if (offset < upload.received) {
      expect(upload.bytes.slice(offset, offset + bytes.byteLength)).toEqual(bytes);
      this.events.push(`upload-repeat:${providerId}:${offset}`);
      return { transferId, nextOffset: upload.received, acceptedBytes: 0, repeated: true };
    }
    upload.bytes.set(bytes, offset);
    upload.received = offset + bytes.byteLength;
    this.events.push(`upload-chunk:${providerId}:${offset}`);
    return { transferId, nextOffset: upload.received, acceptedBytes: bytes.byteLength, repeated: false };
  }

  async finishUpload(providerId: string, itemId: string, transferId: string): Promise<ProviderAttachmentMutationResult> {
    const upload = this.uploads.get(transferId)!;
    expect(upload.providerId).toBe(providerId);
    expect(upload.itemId).toBe(itemId);
    if (upload.committed) return { ...upload.committed, attachment: upload.committed.attachment ? { ...upload.committed.attachment } : undefined };
    const summary: ProviderAttachmentSummary = { attachmentId: upload.attachmentId, providerKind: providerId.includes("keepass") ? "keepass" : "mdbx2", fileName: upload.fileName, sizeBytes: upload.bytes.byteLength, protected: true, mediaType: upload.mediaType };
    this.attachments.set(key(providerId, itemId, upload.attachmentId), { summary, bytes: upload.bytes.slice() });
    this.events.push(`upload-finish:${providerId}`);
    upload.committed = { changed: true, attachment: summary };
    if (this.failFinishAfterCommit) {
      this.failFinishAfterCommit = false;
      throw new Error("finish response lost");
    }
    return { changed: true, attachment: this.mismatchTargetSummary ? { ...summary, sizeBytes: summary.sizeBytes + 1 } : summary };
  }

  async abortUpload(providerId: string, transferId: string): Promise<boolean> {
    this.events.push(`upload-abort:${providerId}`);
    const operationId = this.uploads.get(transferId)?.operationId;
    if (operationId) this.uploadByOperation.delete(operationId);
    return this.uploads.delete(transferId);
  }

  async deleteAttachment(providerId: string, itemId: string, attachmentId: string, _operationId: string): Promise<ProviderAttachmentMutationResult> {
    this.events.push(`delete:${providerId}`);
    if (providerId === "source-mdbx" && this.failSourceDelete) throw new Error("source delete failed");
    return { changed: this.attachments.delete(key(providerId, itemId, attachmentId)) };
  }
}

describe("cross-provider attachment transfer", () => {
  it("copies exact bytes and verifies the target without deleting the source", async () => {
    const backend = new TransferBackendFake();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    backend.put("source-keepass", "item", "source-attachment", bytes);
    const result = await new ProviderAttachmentTransferCoordinator().execute(request("copy", "source-keepass", "target-mdbx"), backend);

    expect(result).toMatchObject({ mode: "copy", copiedBytes: 5, sourceDeleted: false, attachment: { fileName: "evidence.bin", sizeBytes: 5 } });
    expect(backend.get("source-keepass", "item", "source-attachment")).toEqual(bytes);
    expect(backend.get("target-mdbx", "item", result.attachment.attachmentId)).toEqual(bytes);
    expect(backend.events).not.toContain("delete:source-keepass");
  });

  it("deletes the source only after the target has been read back and verified", async () => {
    const backend = new TransferBackendFake();
    const bytes = new Uint8Array([9, 8, 7, 6]);
    backend.put("source-mdbx", "item", "source-attachment", bytes);
    const result = await new ProviderAttachmentTransferCoordinator().execute(request("move", "source-mdbx", "target-keepass"), backend);

    expect(result.sourceDeleted).toBe(true);
    expect(backend.get("source-mdbx", "item", "source-attachment")).toBeUndefined();
    expect(backend.get("target-keepass", "item", result.attachment.attachmentId)).toEqual(bytes);
    expect(backend.events.indexOf("read-release:target-keepass")).toBeLessThan(backend.events.indexOf("delete:source-mdbx"));
  });

  it("removes a corrupt target copy and always preserves the source", async () => {
    const backend = new TransferBackendFake();
    backend.put("source-mdbx", "item", "source-attachment", new Uint8Array([4, 5, 6]));
    backend.corruptTargetRead = true;
    await expect(new ProviderAttachmentTransferCoordinator().execute(request("move", "source-mdbx", "target-keepass"), backend))
      .rejects.toMatchObject({ code: "attachment-transfer-verification-failed" });
    expect(backend.get("source-mdbx", "item", "source-attachment")).toEqual(new Uint8Array([4, 5, 6]));
    expect(backend.events).toContain("delete:target-keepass");
    expect(backend.events).not.toContain("delete:source-mdbx");
  });

  it("keeps both copies when source deletion fails after target verification", async () => {
    const backend = new TransferBackendFake();
    const bytes = new Uint8Array([7, 7, 7]);
    backend.put("source-mdbx", "item", "source-attachment", bytes);
    backend.failSourceDelete = true;
    await expect(new ProviderAttachmentTransferCoordinator().execute(request("move", "source-mdbx", "target-keepass"), backend))
      .rejects.toMatchObject({ code: "attachment-transfer-source-delete-failed" });
    expect(backend.get("source-mdbx", "item", "source-attachment")).toEqual(bytes);
    const target = [...backend.attachments.entries()].find(([entryKey]) => entryKey.startsWith("target-keepass\nitem\n"));
    expect(target?.[1].bytes).toEqual(bytes);
  });

  it("retries a lost finish response without aborting or duplicating the verified target", async () => {
    const backend = new TransferBackendFake();
    const bytes = new Uint8Array([2, 4, 6, 8]);
    backend.put("source-keepass", "item", "source-attachment", bytes);
    backend.failFinishAfterCommit = true;
    const coordinator = new ProviderAttachmentTransferCoordinator();
    const input = request("copy", "source-keepass", "target-mdbx");

    await expect(coordinator.execute(input, backend)).rejects.toThrow("finish response lost");
    expect(backend.events).not.toContain("upload-abort:target-mdbx");
    expect(backend.get("source-keepass", "item", "source-attachment")).toEqual(bytes);

    const recovered = await coordinator.execute(input, backend);
    expect(backend.get("target-mdbx", "item", recovered.attachment.attachmentId)).toEqual(bytes);
    expect([...backend.attachments.keys()].filter((entryKey) => entryKey.startsWith("target-mdbx\nitem\n"))).toHaveLength(1);
  });

  it("cleans a committed target whose returned summary does not match the source", async () => {
    const backend = new TransferBackendFake();
    backend.put("source-mdbx", "item", "source-attachment", new Uint8Array([1, 3, 5]));
    backend.mismatchTargetSummary = true;

    await expect(new ProviderAttachmentTransferCoordinator().execute(request("copy", "source-mdbx", "target-keepass"), backend))
      .rejects.toMatchObject({ code: "attachment-transfer-verification-failed" });
    expect(backend.events).toContain("delete:target-keepass");
    expect(backend.get("source-mdbx", "item", "source-attachment")).toEqual(new Uint8Array([1, 3, 5]));
  });

  it("returns an in-memory completion receipt and rejects changed operation intent", async () => {
    const backend = new TransferBackendFake();
    backend.put("source-keepass", "item", "source-attachment", new Uint8Array([5, 4, 3]));
    const coordinator = new ProviderAttachmentTransferCoordinator();
    const input = request("copy", "source-keepass", "target-mdbx");
    const first = await coordinator.execute(input, backend);
    const eventCount = backend.events.length;

    await expect(coordinator.execute(input, backend)).resolves.toEqual(first);
    expect(backend.events).toHaveLength(eventCount);
    await expect(coordinator.execute({ ...input, targetProviderId: "another-target" }, backend))
      .rejects.toMatchObject({ code: "attachment-transfer-operation-reused" });
  });

  it("requires explicit move confirmation and rejects the same source and target", async () => {
    const coordinator = new ProviderAttachmentTransferCoordinator();
    const backend = new TransferBackendFake();
    await expect(coordinator.execute({ ...request("move", "source-mdbx", "target-keepass"), confirmedMove: false }, backend))
      .rejects.toMatchObject({ code: "attachment-transfer-confirmation-required" });
    await expect(coordinator.execute(request("copy", "source-mdbx", "source-mdbx"), backend))
      .rejects.toMatchObject({ code: "attachment-transfer-same-target" });
  });
});

function request(mode: "copy" | "move", sourceProviderId: string, targetProviderId: string): ProviderAttachmentTransferRequest {
  return {
    operationId: OPERATION_ID,
    sourceProviderId,
    sourceItemId: "item",
    sourceAttachmentId: "source-attachment",
    targetProviderId,
    targetItemId: "item",
    mode,
    confirmedMove: mode === "move"
  };
}

function key(providerId: string, itemId: string, attachmentId: string): string {
  return `${providerId}\n${itemId}\n${attachmentId}`;
}
