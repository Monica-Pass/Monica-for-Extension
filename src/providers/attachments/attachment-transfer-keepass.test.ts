import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import type { ProviderAccount, VaultItem } from "../../core/model";
import { bytesToBase64 } from "../../security/encoding";
import { buildKeePassFixture, keePassCredentials } from "../keepass/keepass-fixture";
import { keePassFieldText } from "../keepass/keepass-login-codec";
import { KeePassProvider } from "../keepass/keepass-provider";
import {
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  type ProviderAttachmentMutationResult,
  type ProviderAttachmentReadBeginResult,
  type ProviderAttachmentReadChunk,
  type ProviderAttachmentSummary,
  type ProviderAttachmentUploadBeginResult,
  type ProviderAttachmentUploadChunkResult
} from "./attachment-contract";
import {
  ProviderAttachmentTransferCoordinator,
  type ProviderAttachmentTransferBackend
} from "./attachment-transfer";

const PASSWORD = "cross provider kdbx fixture password";
const SOURCE_PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";

class RealKeePassTransferBackend implements ProviderAttachmentTransferBackend {
  readonly events: string[] = [];
  sourceExists = true;
  private readonly reads = new Map<string, { providerId: string; attachmentId: string }>();
  private readonly uploads = new Map<string, { bytes: Uint8Array; received: number; fileName: string; mediaType?: string }>();
  private sequence = 0;

  constructor(
    private readonly provider: KeePassProvider,
    private readonly target: ProviderAccount,
    private readonly targetItem: VaultItem,
    private readonly sourceBytes: Uint8Array
  ) {}

  async beginRead(providerId: string, _itemId: string, attachmentId: string): Promise<ProviderAttachmentReadBeginResult> {
    if (providerId === SOURCE_PROVIDER_ID) {
      if (!this.sourceExists || attachmentId !== SOURCE_ATTACHMENT_ID) throw new Error("source attachment missing");
      const readHandle = `source-read-${++this.sequence}`;
      this.reads.set(readHandle, { providerId, attachmentId });
      this.events.push("source-read-begin");
      return {
        attachmentId,
        providerKind: "mdbx2",
        fileName: "android-evidence.bin",
        sizeBytes: this.sourceBytes.byteLength,
        protected: true,
        mediaType: "application/octet-stream",
        readHandle,
        maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES
      };
    }
    const attachment = this.provider.listAttachments(this.target, this.targetItem)
      .find((candidate) => candidate.attachmentId === attachmentId);
    if (!attachment) throw new Error("target attachment missing");
    const readHandle = `target-read-${++this.sequence}`;
    this.reads.set(readHandle, { providerId, attachmentId });
    this.events.push("target-read-begin");
    return { ...attachment, readHandle, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES };
  }

  async readChunk(providerId: string, readHandle: string, offset: number, maxBytes: number): Promise<ProviderAttachmentReadChunk> {
    const read = this.reads.get(readHandle);
    if (!read || read.providerId !== providerId) throw new Error("read handle mismatch");
    if (providerId === SOURCE_PROVIDER_ID) {
      const nextOffset = Math.min(this.sourceBytes.byteLength, offset + Math.min(maxBytes, 3));
      const bytes = this.sourceBytes.slice(offset, nextOffset);
      return {
        readHandle,
        attachmentId: SOURCE_ATTACHMENT_ID,
        fileName: "android-evidence.bin",
        sizeBytes: this.sourceBytes.byteLength,
        offset,
        nextOffset,
        dataBase64: bytesToBase64(bytes),
        eof: nextOffset === this.sourceBytes.byteLength
      };
    }
    const result = this.provider.readAttachment(this.target, this.targetItem, read.attachmentId, offset, Math.min(maxBytes, 3));
    return {
      readHandle,
      attachmentId: result.attachment.attachmentId,
      fileName: result.attachment.fileName,
      sizeBytes: result.attachment.sizeBytes,
      offset: result.offset,
      nextOffset: result.nextOffset,
      dataBase64: bytesToBase64(result.bytes),
      eof: result.eof
    };
  }

  async releaseRead(providerId: string, readHandle: string): Promise<boolean> {
    this.events.push(providerId === SOURCE_PROVIDER_ID ? "source-read-release" : "target-read-release");
    return this.reads.delete(readHandle);
  }

  async beginUpload(providerId: string, _itemId: string, input: {
    fileName: string;
    mediaType?: string;
    sizeBytes: number;
    replaceExisting: false;
    operationId: string;
    attachmentId: string;
  }): Promise<ProviderAttachmentUploadBeginResult> {
    expect(providerId).toBe(TARGET_PROVIDER_ID);
    const transferId = `target-upload-${++this.sequence}`;
    this.uploads.set(transferId, { bytes: new Uint8Array(input.sizeBytes), received: 0, fileName: input.fileName, mediaType: input.mediaType });
    this.events.push("target-upload-begin");
    return {
      transferId,
      nextOffset: 0,
      maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES,
      expiresAt: Date.now() + 60_000,
      operationId: input.operationId,
      attachmentId: input.attachmentId
    };
  }

  async uploadChunk(providerId: string, transferId: string, offset: number, bytes: Uint8Array): Promise<ProviderAttachmentUploadChunkResult> {
    expect(providerId).toBe(TARGET_PROVIDER_ID);
    const upload = this.uploads.get(transferId)!;
    upload.bytes.set(bytes, offset);
    upload.received = offset + bytes.byteLength;
    this.events.push(`target-upload-chunk:${offset}`);
    return { transferId, nextOffset: upload.received, acceptedBytes: bytes.byteLength, repeated: false };
  }

  async finishUpload(providerId: string, _itemId: string, transferId: string): Promise<ProviderAttachmentMutationResult> {
    expect(providerId).toBe(TARGET_PROVIDER_ID);
    const upload = this.uploads.get(transferId)!;
    expect(upload.received).toBe(upload.bytes.byteLength);
    const attachment = await this.provider.addAttachment(this.target, this.targetItem, upload.fileName, upload.bytes, false);
    this.events.push("target-upload-finish");
    return { changed: true, attachment };
  }

  async abortUpload(_providerId: string, transferId: string): Promise<boolean> {
    this.events.push("target-upload-abort");
    return this.uploads.delete(transferId);
  }

  async deleteAttachment(providerId: string, _itemId: string, attachmentId: string, _operationId: string): Promise<ProviderAttachmentMutationResult> {
    if (providerId === SOURCE_PROVIDER_ID) {
      const changed = this.sourceExists && attachmentId === SOURCE_ATTACHMENT_ID;
      this.sourceExists = false;
      this.events.push("source-delete");
      return { changed };
    }
    const changed = this.provider.deleteAttachment(this.target, this.targetItem, attachmentId);
    this.events.push("target-delete");
    return { changed };
  }
}

describe("cross-provider attachment transfer with a real KDBX fixture", () => {
  it("writes exact MDBX2 source bytes into KeePass history before deleting the source", async () => {
    const provider = new KeePassProvider();
    const target: ProviderAccount = {
      id: TARGET_PROVIDER_ID,
      kind: "keepass",
      name: "Target KeePass",
      enabled: true,
      isDefaultSaveTarget: false,
      config: { databaseId: 17 }
    };
    const fixture = await buildKeePassFixture({
      password: PASSWORD,
      version: 4,
      kdf: "argon2id",
      name: "Cross Provider Target",
      entries: [{ title: "Attachment Target", protectedFields: { Password: "secret" } }]
    });
    await provider.unlock(target, fixture, { password: PASSWORD });
    const targetItem = (await provider.sync(target, { now: "2026-08-07T05:00:00.000Z", localItems: [] })).items[0];
    const sourceBytes = new Uint8Array([0, 1, 2, 3, 4, 250, 251, 252]);
    const backend = new RealKeePassTransferBackend(provider, target, targetItem, sourceBytes);

    const result = await new ProviderAttachmentTransferCoordinator().execute({
      operationId: "44444444-4444-4444-8444-444444444444",
      sourceProviderId: SOURCE_PROVIDER_ID,
      sourceItemId: targetItem.id,
      sourceAttachmentId: SOURCE_ATTACHMENT_ID,
      targetProviderId: TARGET_PROVIDER_ID,
      targetItemId: targetItem.id,
      mode: "move",
      confirmedMove: true
    }, backend);

    expect(result).toMatchObject({ mode: "move", copiedBytes: sourceBytes.byteLength, sourceDeleted: true, attachment: { fileName: "android-evidence.bin" } });
    expect(backend.sourceExists).toBe(false);
    expect(backend.events.indexOf("target-read-release")).toBeLessThan(backend.events.indexOf("source-delete"));
    const attachment = provider.listAttachments(target, targetItem).find((candidate) => candidate.fileName === "android-evidence.bin")!;
    expect(readAll(provider, target, targetItem, attachment)).toEqual(sourceBytes);

    const reopened = await kdbxweb.Kdbx.load((await provider.snapshotFile(target.id)).slice().buffer, keePassCredentials(PASSWORD));
    const entry = reopened.getDefaultGroup().entries.find((candidate) => keePassFieldText(candidate.fields.get("Title")) === "Attachment Target")!;
    expect(entry.history).toHaveLength(1);
    expect(binaryBytes(entry.binaries.get("android-evidence.bin")!)).toEqual(sourceBytes);
    expect(entry.history[0].binaries.has("android-evidence.bin")).toBe(false);
  });
});

function readAll(provider: KeePassProvider, account: ProviderAccount, item: VaultItem, attachment: ProviderAttachmentSummary): Uint8Array {
  const result = provider.readAttachment(account, item, attachment.attachmentId, 0, attachment.sizeBytes || 1);
  expect(result.eof).toBe(true);
  return result.bytes;
}

function binaryBytes(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): Uint8Array {
  const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
  return value instanceof kdbxweb.ProtectedValue ? value.getBinary() : new Uint8Array(value);
}
