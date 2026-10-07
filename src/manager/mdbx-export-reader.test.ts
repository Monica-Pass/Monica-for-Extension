import { describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../security/encoding";
import { attachmentSha256 } from "./attachment-reader";
import { readVerifiedMdbxExport, type MdbxExportReader } from "./mdbx-export-reader";

async function fixture() {
  const bytes = new Uint8Array([1, 2, 255]); const sha256 = await attachmentSha256(bytes);
  const client = {
    beginMdbx2FileExport: vi.fn(async (): Promise<import("../providers/mdbx2/local-file-export").Mdbx2FileExportBegin> => ({ downloadHandle: "h", fileName: "vault.mdbx", format: "mdbx", blobCount: 0, sizeBytes: bytes.length, sha256, maxChunkBytes: 262144, expiresAt: Date.parse("2099-01-01T00:00:00Z") })),
    readMdbx2FileExport: vi.fn(async () => ({ downloadHandle: "h", sizeBytes: bytes.length, sha256, offset: 0, nextOffset: bytes.length, eof: true, dataBase64: bytesToBase64(bytes) })),
    releaseMdbx2FileExport: vi.fn(async () => true)
  } satisfies MdbxExportReader;
  return { client, bytes };
}
describe("verified MDBX encrypted download", () => {
  it("keeps complete archives distinguishable from single-file databases", async () => {
    const { client } = await fixture();
    client.beginMdbx2FileExport.mockResolvedValue({ ...await client.beginMdbx2FileExport(), fileName: "bad/path.mdbx", format: "zip", blobCount: 4 });
    await expect(readVerifiedMdbxExport(client, "p")).resolves.toMatchObject({ format: "zip", blobCount: 4, fileName: "monica-export.mdbx-backup.zip" });
  });
  it("returns only complete verified bytes and releases the output handle", async () => {
    const {client,bytes} = await fixture();
    expect((await readVerifiedMdbxExport(client,"p")).bytes).toEqual(bytes);
    expect(client.releaseMdbx2FileExport).toHaveBeenCalledWith("p","h");
  });
  it("rejects invalid sizes, misplaced chunks and corrupt bytes", async () => {
    for (const mode of ["size", "offset", "hash"] as const) {
      const {client} = await fixture();
      if (mode === "size") client.beginMdbx2FileExport.mockResolvedValue({...await client.beginMdbx2FileExport(),sizeBytes:513*1024*1024});
      else client.readMdbx2FileExport.mockResolvedValue({...await client.readMdbx2FileExport(),...(mode === "offset" ? {offset:1} : {dataBase64:bytesToBase64(new Uint8Array([1,2,3]))})});
      await expect(readVerifiedMdbxExport(client,"p")).rejects.toThrow("未下载");
      expect(client.releaseMdbx2FileExport).toHaveBeenCalledWith("p","h");
    }
  });
  it("cancels on lock during begin and still releases the handle", async () => {
    const {client} = await fixture(); const abort = new AbortController(); const start = await client.beginMdbx2FileExport();
    client.beginMdbx2FileExport.mockImplementation(async()=>{abort.abort();return start;});
    await expect(readVerifiedMdbxExport(client,"p",abort.signal)).rejects.toMatchObject({name:"AbortError"});
    expect(client.readMdbx2FileExport).not.toHaveBeenCalled();
    expect(client.releaseMdbx2FileExport).toHaveBeenCalledWith("p","h");
  });
});
