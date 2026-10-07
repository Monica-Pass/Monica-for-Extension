import { describe, expect, it, vi } from "vitest";
import { Mdbx2LocalFileExports, MDBX2_FILE_EXPORT_MAX_BYTES, MDBX2_FILE_EXPORT_TTL_MS } from "./local-file-export";
import type { Mdbx2CompleteBackupDescriptor, Mdbx2CompleteBackupChunk } from "./native-contract";

function fixture() {
  let now = 1000;
  const authorize = vi.fn(async () => ({ vaultHandle: "vault", fileName: "synthetic.mdbx" }));
  const descriptor: Mdbx2CompleteBackupDescriptor = { fileHandle: "native-file", sizeBytes: 3, sha256: "a".repeat(64), purpose: "vault-backup", format: "mdbx", blobCount: 0 };
  const native = {
    prepareCompleteBackup: vi.fn(async (): Promise<Mdbx2CompleteBackupDescriptor> => ({ ...descriptor })),
    readCompleteBackup: vi.fn(async (): Promise<Mdbx2CompleteBackupChunk> => ({ ...descriptor, offset: 0, dataBase64: "AQID", nextOffset: 3, eof: true })),
    releaseCompleteBackup: vi.fn(async () => true)
  };
  const exports = new Mdbx2LocalFileExports(native, authorize, () => now);
  return { native, descriptor, authorize, exports, advance: (delta: number) => { now += delta; } };
}

describe("manager-scoped complete encrypted MDBX export", () => {
  it("uses a separate native backup session and opaque owner-bound handles", async () => {
    const { native, exports } = fixture();
    const begun = await exports.begin("provider", "manager-a");
    expect(begun).toMatchObject({ fileName: "synthetic.mdbx", sizeBytes: 3, maxChunkBytes: 262144, format: "mdbx", blobCount: 0 });
    expect(begun.downloadHandle).not.toBe("native-file");
    expect(native.prepareCompleteBackup).toHaveBeenCalledWith("vault");
    const read = await exports.read("provider", "manager-a", begun.downloadHandle, 0);
    expect(read).toMatchObject({ dataBase64: "AQID", eof: true, nextOffset: 3 });
    expect(read).not.toHaveProperty("fileHandle");
    await expect(exports.release("provider", "manager-a", begun.downloadHandle)).resolves.toBe(true);
    expect(native.releaseCompleteBackup).toHaveBeenCalledWith("native-file");
  });

  it("rejects another manager/provider and out of range chunk offsets", async () => {
    const { native, exports } = fixture(); const begun = await exports.begin("provider", "a");
    await expect(exports.read("provider", "b", begun.downloadHandle, 0)).rejects.toThrow("不属于");
    await expect(exports.release("other", "a", begun.downloadHandle)).rejects.toThrow("不属于");
    await expect(exports.read("provider", "a", begun.downloadHandle, -1)).rejects.toThrow("偏移");
    expect(native.readCompleteBackup).not.toHaveBeenCalled();
  });

  it("offers an explicit archive for external Blobs and never falls back after an incomplete native backup", async () => {
    const { native, descriptor, exports } = fixture();
    descriptor.format = "zip"; descriptor.blobCount = 3;
    const begun = await exports.begin("p", "a");
    expect(begun).toMatchObject({ fileName: "synthetic.mdbx-backup.zip", format: "zip", blobCount: 3 });
    await expect(exports.read("p", "a", begun.downloadHandle, 0)).resolves.toMatchObject({ eof: true });
    native.prepareCompleteBackup.mockRejectedValue(new Error("missing Blob"));
    await expect(exports.begin("p", "a")).rejects.toThrow("missing Blob");
    descriptor.format = "mdbx";
    native.prepareCompleteBackup.mockResolvedValue(descriptor);
    await expect(exports.begin("p", "a")).rejects.toThrow("校验");
    expect(native.releaseCompleteBackup).toHaveBeenCalledWith("native-file");
  });

  it("enforces fixed TTL, output size and concurrent session bounds", async () => {
    const { native, descriptor, exports, advance } = fixture();
    const begun = await exports.begin("p", "a");
    advance(MDBX2_FILE_EXPORT_TTL_MS);
    await expect(exports.read("p", "a", begun.downloadHandle, 0)).rejects.toThrow("过期");
    expect(native.releaseCompleteBackup).toHaveBeenCalledWith("native-file");
    descriptor.sizeBytes = MDBX2_FILE_EXPORT_MAX_BYTES + 1;
    await expect(exports.begin("p", "a")).rejects.toThrow("512 MiB");
    descriptor.sizeBytes = 3;
    await Promise.all(Array.from({ length: 4 }, () => exports.begin("p", "a")));
    await expect(exports.begin("p", "a")).rejects.toThrow("会话过多");
  });

  it("releases results if authorization disappears during prepare or read", async () => {
    const first = fixture();
    first.native.prepareCompleteBackup.mockImplementation(async () => { first.authorize.mockRejectedValue(new Error("locked")); return first.descriptor; });
    await expect(first.exports.begin("p", "a")).rejects.toThrow("locked");
    expect(first.native.releaseCompleteBackup).toHaveBeenCalledWith("native-file");
    const second = fixture(); const begun = await second.exports.begin("p", "a");
    const chunk = await second.native.readCompleteBackup();
    second.native.readCompleteBackup.mockImplementation(async () => { second.authorize.mockRejectedValue(new Error("locked")); return chunk; });
    await expect(second.exports.read("p", "a", begun.downloadHandle, 0)).rejects.toThrow("locked");
    expect(second.native.releaseCompleteBackup).toHaveBeenCalledWith("native-file");
  });

  it("invalidates pending and established sessions on lock and binding changes", async () => {
    const { native, descriptor, authorize, exports } = fixture(); const begun = await exports.begin("p", "a");
    await exports.clear();
    await expect(exports.read("p", "a", begun.downloadHandle, 0)).rejects.toThrow("过期");
    native.prepareCompleteBackup.mockImplementation(async () => { await exports.clear(); return descriptor; });
    await expect(exports.begin("p", "a")).rejects.toThrow("变化");
    native.prepareCompleteBackup.mockResolvedValue(descriptor);
    const next = await exports.begin("p", "a"); authorize.mockResolvedValue({ vaultHandle: "different", fileName: "other" });
    await expect(exports.read("p", "a", next.downloadHandle, 0)).rejects.toThrow("变化");
  });

  it("rejects changed chunk identity/digest/format and pending mutations", async () => {
    for (const change of [{ fileHandle: "wrong" }, { sha256: "b".repeat(64) }, { format: "zip" as const }, { blobCount: 1 }]) {
      const { native, exports } = fixture(); const begun = await exports.begin("p", "a");
      native.readCompleteBackup.mockResolvedValue({ ...await native.readCompleteBackup(), ...change });
      await expect(exports.read("p", "a", begun.downloadHandle, 0)).rejects.toThrow("校验");
    }
    const pending = fixture(); pending.authorize.mockRejectedValue(new Error("请先同步待写入修改"));
    await expect(pending.exports.begin("p", "a")).rejects.toThrow("待写入");
    expect(pending.native.prepareCompleteBackup).not.toHaveBeenCalled();
  });
});
