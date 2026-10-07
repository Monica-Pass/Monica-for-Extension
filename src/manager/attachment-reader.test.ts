import { describe, expect, it, vi } from "vitest";
import { attachmentSha256, readVerifiedAttachment, type AttachmentReader } from "./attachment-reader";
import { bytesToBase64 } from "../security/encoding";
import type { WalletAsset } from "../core/password-content";

function fixture(bytes = new Uint8Array([1, 2, 3])) {
  const attachment = { attachmentId: "a", providerKind: "mdbx2" as const, fileName: "wallet-a", sizeBytes: bytes.length, protected: true, mediaType: "image/png" };
  const client = {
    listProviderAttachments: vi.fn(async () => ({ items: [attachment] })),
    beginProviderAttachmentRead: vi.fn(async () => ({ ...attachment, readHandle: "h", maxChunkBytes: 262144 as const })),
    readProviderAttachmentChunk: vi.fn(async () => ({ ...attachment, readHandle: "h", offset: 0, nextOffset: bytes.length, dataBase64: bytesToBase64(bytes), eof: true })),
    releaseProviderAttachmentRead: vi.fn(async () => true)
  } satisfies AttachmentReader;
  return { client, bytes };
}
describe("bounded verified attachment disclosure", () => {
  it("checks complete bytes and releases handle including empty files", async () => {
    for (const bytes of [new Uint8Array([0, 255, 3]), new Uint8Array()]) {
      const { client } = fixture(bytes);
      const expected: WalletAsset = { name: "wallet-a", displayName: "file", role: "ATTACHMENT", mimeType: "application/octet-stream", size: bytes.length, sha256: await attachmentSha256(bytes) };
      expect((await readVerifiedAttachment(client, "p", "i", "wallet-a", expected)).bytes).toEqual(bytes);
      expect(client.releaseProviderAttachmentRead).toHaveBeenCalledWith("p", "h");
    }
  });
  it("rejects a missing blob, duplicate name and repeating pagination cursor", async () => {
    const { client } = fixture();
    client.listProviderAttachments.mockResolvedValue({ items: [] });
    await expect(readVerifiedAttachment(client, "p", "i", "wallet-a")).rejects.toThrow("缺失");
    const { client: duplicate } = fixture(); const page = await duplicate.listProviderAttachments();
    duplicate.listProviderAttachments.mockResolvedValue({ items: [...page.items, ...page.items] });
    await expect(readVerifiedAttachment(duplicate, "p", "i", "wallet-a")).rejects.toThrow("重复");
    const repeating = { ...client, listProviderAttachments: vi.fn(async () => ({ items: [], nextCursor: "repeat" })) };
    await expect(readVerifiedAttachment(repeating, "p", "i", "wallet-a")).rejects.toThrow("分页");
    expect(repeating.listProviderAttachments).toHaveBeenCalledTimes(2);
  });
  it("rejects wrong hash and short/misidentified chunks without exposing bytes", async () => {
    const { client } = fixture();
    await expect(readVerifiedAttachment(client, "p", "i", "wallet-a", { name: "wallet-a", displayName: "f", role: "CARD_FACE", size: 3, mimeType: "image/png", sha256: "0".repeat(64) })).rejects.toThrow("SHA-256");
    client.readProviderAttachmentChunk.mockResolvedValue({ ...await client.readProviderAttachmentChunk(), readHandle: "wrong" });
    await expect(readVerifiedAttachment(client, "p", "i", "wallet-a")).rejects.toThrow("分段");
    expect(client.releaseProviderAttachmentRead).toHaveBeenCalledTimes(2);
  });
  it("cancels on lock or unmount and releases even when cancellation occurs during begin", async () => {
    const { client } = fixture(); const abort = new AbortController();
    const start = await client.beginProviderAttachmentRead();
    client.beginProviderAttachmentRead.mockImplementation(async () => { abort.abort(); return start; });
    await expect(readVerifiedAttachment(client, "p", "i", "wallet-a", undefined, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(client.readProviderAttachmentChunk).not.toHaveBeenCalled();
    expect(client.releaseProviderAttachmentRead).toHaveBeenCalledWith("p", "h");
  });
});
