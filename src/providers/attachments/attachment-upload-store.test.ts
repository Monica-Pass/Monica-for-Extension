import { describe, expect, it } from "vitest";
import {
  KEEPASS_ATTACHMENT_MAX_BYTES,
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS,
  PROVIDER_ATTACHMENT_UPLOAD_TTL_MS,
  type ProviderAttachmentUploadIntent
} from "./attachment-contract";
import { ProviderAttachmentUploadStore } from "./attachment-upload-store";

function intent(input: Partial<ProviderAttachmentUploadIntent> = {}): ProviderAttachmentUploadIntent {
  return {
    providerId: "keepass-provider",
    itemId: "item-1",
    providerKind: "keepass",
    fileName: "document.txt",
    mediaType: "text/plain",
    sizeBytes: 3,
    replaceExisting: false,
    ...input
  };
}

describe("provider attachment upload store", () => {
  it("accepts exact-offset chunks and treats byte-identical retries as idempotent", async () => {
    const store = new ProviderAttachmentUploadStore(() => 1000, () => "11111111-1111-4111-8111-111111111111");
    const begun = store.begin(intent(), KEEPASS_ATTACHMENT_MAX_BYTES);
    expect(begun).toMatchObject({ nextOffset: 0, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES });
    expect(store.intent(begun.transferId)).toMatchObject({ providerId: "keepass-provider", itemId: "item-1", fileName: "document.txt" });
    expect(store.write(begun.transferId, 0, new Uint8Array([1, 2]))).toMatchObject({ nextOffset: 2, acceptedBytes: 2, repeated: false });
    expect(store.write(begun.transferId, 0, new Uint8Array([1, 2]))).toMatchObject({ nextOffset: 2, acceptedBytes: 0, repeated: true });
    expect(store.write(begun.transferId, 2, new Uint8Array([3]))).toMatchObject({ nextOffset: 3 });
    const completed = await store.complete(begun.transferId);
    expect([...completed.bytes]).toEqual([1, 2, 3]);
    expect(completed.sha256).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    expect(await store.complete(begun.transferId)).toMatchObject({ sha256: completed.sha256 });
  });

  it("rejects gaps, changed overlap, oversized chunks, and bytes beyond the declared file", () => {
    const store = new ProviderAttachmentUploadStore(() => 1000, () => crypto.randomUUID());
    const begun = store.begin(intent(), KEEPASS_ATTACHMENT_MAX_BYTES);
    expect(() => store.write(begun.transferId, 1, new Uint8Array([1]))).toThrowError(/下一偏移量/);
    store.write(begun.transferId, 0, new Uint8Array([1]));
    expect(() => store.write(begun.transferId, 0, new Uint8Array([2]))).toThrowError(/不一致/);
    expect(() => store.write(begun.transferId, 1, new Uint8Array(PROVIDER_ATTACHMENT_CHUNK_BYTES + 1))).toThrowError(/256 KiB/);
    expect(() => store.write(begun.transferId, 1, new Uint8Array([2, 3, 4]))).toThrowError(/声明的文件大小/);
  });

  it("checks the optional SHA-256 and destroys rejected or released plaintext", async () => {
    const store = new ProviderAttachmentUploadStore(() => 1000, () => crypto.randomUUID());
    const mismatch = store.begin(intent({ sha256: "0".repeat(64) }), KEEPASS_ATTACHMENT_MAX_BYTES);
    store.write(mismatch.transferId, 0, new Uint8Array([1, 2, 3]));
    await expect(store.complete(mismatch.transferId)).rejects.toMatchObject({ code: "attachment-upload-digest-mismatch" });
    expect(store.has(mismatch.transferId)).toBe(false);

    const accepted = store.begin(intent(), KEEPASS_ATTACHMENT_MAX_BYTES);
    store.write(accepted.transferId, 0, new Uint8Array([1, 2, 3]));
    const completed = await store.complete(accepted.transferId);
    expect(store.release(accepted.transferId)).toBe(true);
    expect([...completed.bytes]).toEqual([0, 0, 0]);
  });

  it("allows an empty attachment to finish without a chunk", async () => {
    const store = new ProviderAttachmentUploadStore(() => 1000, () => crypto.randomUUID());
    const begun = store.begin(intent({ sizeBytes: 0, fileName: "empty.bin" }), KEEPASS_ATTACHMENT_MAX_BYTES);
    await expect(store.complete(begun.transferId)).resolves.toMatchObject({
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    });
  });

  it("keeps a bounded committed receipt for a lost manager response", async () => {
    const store = new ProviderAttachmentUploadStore(() => 1000, () => crypto.randomUUID());
    const begun = store.begin(intent(), KEEPASS_ATTACHMENT_MAX_BYTES);
    store.write(begun.transferId, 0, new Uint8Array([1, 2, 3]));
    const completed = await store.complete(begun.transferId);
    store.markCommitted(begun.transferId, {
      changed: true,
      attachment: { attachmentId: "22222222-2222-4222-8222-222222222222", providerKind: "keepass", fileName: "document.txt", sizeBytes: 3, protected: false }
    });

    expect([...completed.bytes]).toEqual([0, 0, 0]);
    expect(store.committedResult(begun.transferId)).toMatchObject({ changed: true, attachment: { fileName: "document.txt" } });
    expect(() => store.write(begun.transferId, 0, new Uint8Array([1]))).toThrowError(/已经写入/);
    await expect(store.complete(begun.transferId)).rejects.toMatchObject({ code: "attachment-upload-already-committed" });
  });

  it("enforces provider size and active-transfer limits", () => {
    let id = 0;
    const store = new ProviderAttachmentUploadStore(() => 1000, () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
    expect(() => store.begin(intent({ sizeBytes: KEEPASS_ATTACHMENT_MAX_BYTES + 1 }), KEEPASS_ATTACHMENT_MAX_BYTES)).toThrowError(/256 MiB/);
    for (let index = 0; index < PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS; index++) store.begin(intent({ fileName: `${index}.bin`, sizeBytes: 0 }), KEEPASS_ATTACHMENT_MAX_BYTES);
    expect(() => store.begin(intent({ fileName: "overflow.bin", sizeBytes: 0 }), KEEPASS_ATTACHMENT_MAX_BYTES)).toThrowError(/上传过多/);
  });

  it("expires inactive uploads and zeroes their buffers", async () => {
    let now = 1000;
    const store = new ProviderAttachmentUploadStore(() => now, () => crypto.randomUUID());
    const begun = store.begin(intent(), KEEPASS_ATTACHMENT_MAX_BYTES);
    store.write(begun.transferId, 0, new Uint8Array([1, 2, 3]));
    const completed = await store.complete(begun.transferId);
    now += PROVIDER_ATTACHMENT_UPLOAD_TTL_MS + 1;
    expect(store.has(begun.transferId)).toBe(false);
    expect([...completed.bytes]).toEqual([0, 0, 0]);
  });
});
