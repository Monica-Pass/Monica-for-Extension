import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../security/encoding";
import type { ProviderAccount, ProviderSourceRecord, VaultItem } from "../../core/model";
import type { ProviderAttachmentSummary } from "../attachments/attachment-contract";
import { Mdbx2TransferAttachmentService } from "./mdbx2-transfer-attachments";
import type {
  Mdbx2BatchTransferNativeClient,
  Mdbx2TransferAttachmentDescriptor
} from "./mdbx2-batch-transfer-coordinator";

const TARGET: ProviderAccount = { id: "mdbx-target", kind: "mdbx2", name: "Target", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: "11111111-1111-4111-8111-111111111111" } };
const SOURCE_MDBX: ProviderAccount = { id: "mdbx-source", kind: "mdbx2", name: "Source", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: "22222222-2222-4222-8222-222222222222" } };
const SOURCE_KEEPASS: ProviderAccount = { id: "keepass-source", kind: "keepass", name: "KeePass", enabled: true, isDefaultSaveTarget: false, config: {} };
const SOURCE_BITWARDEN: ProviderAccount = { id: "bw-source", kind: "bitwarden", name: "Bitwarden", enabled: true, isDefaultSaveTarget: false, config: {} };
const ITEM: VaultItem = {
  id: "item-1", kind: "login", title: "Attachment item", favorite: false, notes: "",
  createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z",
  providerRefs: [{ providerId: SOURCE_MDBX.id, remoteId: "source-object", remoteFolderId: "source-folder" }],
  username: "alice", password: "secret", uris: ["https://example.test"], customFields: []
} as VaultItem;

class AttachmentNativeFake implements Mdbx2BatchTransferNativeClient {
  readonly uploadChunks: Uint8Array[] = [];
  readonly begins: Array<Record<string, unknown>> = [];
  readonly released: string[] = [];
  readonly aborted: string[] = [];
  private uploadInput?: { attachmentId: string; fileName: string; sizeBytes: number; operationId: string };
  private accepted = 0;
  loseNextChunk = false;

  async listCollections() { return { items: [] as any[] }; }
  async createCollection(..._args: unknown[]): Promise<any> { throw new Error("not used"); }
  async vaultStatus(vaultHandle: string) { return { vaultHandle, open: true, available: true }; }
  async listObjects() { return { items: [] as any[] }; }
  async revealObject(..._args: unknown[]): Promise<any> { throw new Error("not used"); }
  async deleteObject(..._args: unknown[]): Promise<any> { throw new Error("not used"); }
  async resolveObjectOperation(..._args: unknown[]): Promise<any> { return { known: false, committed: false }; }
  async listAttachments(vaultHandle: string, collectionId: string, objectId: string) {
    if (vaultHandle === SOURCE_MDBX.config.vaultHandle && collectionId === "source-folder" && objectId === "source-object") {
      return { items: [{ attachmentId: "source-attachment", fileName: "evidence.bin", sizeBytes: 3, mediaType: "application/octet-stream", protected: true }] };
    }
    return { items: [] };
  }
  async beginAttachmentRead(_vaultHandle: string, attachmentId: string) {
    return { readHandle: "read-handle", attachmentId, fileName: "evidence.bin", sizeBytes: 3, maxChunkBytes: 2 };
  }
  async readAttachmentChunk(_readHandle: string, offset: number) {
    const bytes = offset === 0 ? new Uint8Array([1, 2]) : new Uint8Array([3]);
    return { readHandle: "read-handle", attachmentId: "source-attachment", fileName: "evidence.bin", sizeBytes: 3, offset, nextOffset: offset + bytes.length, dataBase64: bytesToBase64(bytes), eof: offset + bytes.length === 3 };
  }
  async releaseAttachmentRead(readHandle: string) { this.released.push(readHandle); return true; }
  async beginAttachmentUpload(_vaultHandle: string, input: { operationId: string; attachmentId: string; collectionId: string; objectId: string; fileName: string; mediaType?: string; mode: "create" | "replace"; sizeBytes: number; sha256?: string }) {
    this.uploadInput = input;
    this.begins.push(input);
    return { transferId: "upload-handle", operationId: input.operationId, attachmentId: input.attachmentId, nextOffset: 0, maxChunkBytes: 2, alreadyCommitted: false };
  }
  async sendAttachmentUploadChunk(_transferId: string, offset: number, bytes: Uint8Array) {
    if (this.loseNextChunk) {
      this.loseNextChunk = false;
      this.uploadChunks.push(bytes.slice());
      this.accepted = offset + bytes.length;
      throw new Error("chunk response lost");
    }
    if (offset < this.accepted) return { transferId: "upload-handle", nextOffset: this.accepted, acceptedBytes: 0, repeated: true };
    this.uploadChunks.push(bytes.slice());
    this.accepted = offset + bytes.length;
    return { transferId: "upload-handle", nextOffset: this.accepted, acceptedBytes: bytes.length, repeated: false };
  }
  async finishAttachmentUpload(transferId: string) {
    const input = this.uploadInput!;
    return { transferId, operationId: input.operationId, changed: true, alreadyCommitted: false, commitId: "commit-attachment", attachment: { attachmentId: input.attachmentId, fileName: input.fileName, sizeBytes: input.sizeBytes, mediaType: "application/octet-stream", storageMode: "embedded-chunked" as const, protected: true as const, deleted: false } };
  }
  async abortAttachmentUpload(transferId: string) { this.aborted.push(transferId); return true; }
}

class KeePassFake {
  listAttachments(): ProviderAttachmentSummary[] {
    return [{ attachmentId: "keepass-attachment", providerKind: "keepass", fileName: "evidence.bin", sizeBytes: 3, protected: false, mediaType: "application/octet-stream" }];
  }
  readAttachment(_account: ProviderAccount, _item: VaultItem, _attachmentId: string, offset: number) {
    const bytes = offset === 0 ? new Uint8Array([1, 2]) : new Uint8Array([3]);
    return { attachment: this.listAttachments()[0], offset, nextOffset: offset + bytes.length, bytes, eof: offset + bytes.length === 3 };
  }
}

describe("MDBX2 transfer attachments", () => {
  it("copies KeePass bytes with a verified digest and retries a lost chunk response", async () => {
    const native = new AttachmentNativeFake();
    native.loseNextChunk = true;
    const service = new Mdbx2TransferAttachmentService(native, new KeePassFake() as never);
    const sourceItem = { ...ITEM, providerRefs: [{ providerId: SOURCE_KEEPASS.id, remoteId: "entry" }] } as VaultItem;
    const targetItem = { ...ITEM, providerRefs: [{ providerId: TARGET.id, remoteId: "target-object", remoteFolderId: "target-folder" }] } as VaultItem;
    await expect(service.transferAttachments(SOURCE_KEEPASS, sourceItem, TARGET, targetItem, "33333333-3333-4333-8333-333333333333")).resolves.toBe(1);

    expect(native.begins[0].sha256).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    // The exact digest assertion below is generated from the bytes rather than trusting metadata.
    expect(native.uploadChunks.reduce<number[]>((all, chunk) => [...all, ...chunk], [])).toEqual([1, 2, 3]);
    expect(native.aborted).toEqual([]);
  });

  it("reads MDBX2 source chunks and releases the read handle", async () => {
    const native = new AttachmentNativeFake();
    const service = new Mdbx2TransferAttachmentService(native, new KeePassFake() as never);
    const targetItem = { ...ITEM, providerRefs: [{ providerId: TARGET.id, remoteId: "target-object", remoteFolderId: "target-folder" }] } as VaultItem;
    await expect(service.transferAttachments(SOURCE_MDBX, ITEM, TARGET, targetItem, "44444444-4444-4444-8444-444444444444")).resolves.toBe(1);
    expect(native.released).toEqual(["read-handle"]);
  });

  it("blocks Bitwarden Cipher attachments before writing a target", async () => {
    const native = new AttachmentNativeFake();
    const records: ProviderSourceRecord[] = [{ providerId: SOURCE_BITWARDEN.id, remoteId: "cipher", format: "bitwarden-cipher", encoding: "json", payload: JSON.stringify({ Id: "cipher", Attachments: [{ Id: "file", FileName: "secret.txt", Size: "3" }] }), contentHash: "hash" }];
    const service = new Mdbx2TransferAttachmentService(native, new KeePassFake() as never, async () => records);
    const sourceItem = { ...ITEM, providerRefs: [{ providerId: SOURCE_BITWARDEN.id, remoteId: "cipher" }] } as VaultItem;
    await expect(service.listSourceAttachments(SOURCE_BITWARDEN, sourceItem)).rejects.toThrow("Bitwarden 附件");
    expect(native.begins).toEqual([]);
  });
});
