import { base64ToBytes } from "../security/encoding";
import { attachmentSha256 } from "./attachment-reader";
import type { Mdbx2FileExportBegin, Mdbx2FileExportChunk } from "../providers/mdbx2/local-file-export";

export interface MdbxExportReader {
  beginMdbx2FileExport(providerId: string): Promise<Mdbx2FileExportBegin>;
  readMdbx2FileExport(providerId: string, handle: string, offset: number): Promise<Mdbx2FileExportChunk>;
  releaseMdbx2FileExport(providerId: string, handle: string): Promise<unknown>;
}

/** Never offer a partial or unverified encrypted snapshot as a backup. */
export async function readVerifiedMdbxExport(client: MdbxExportReader, providerId: string, signal?: AbortSignal) {
  const check = () => { if (signal?.aborted) throw new DOMException("导出已取消。", "AbortError"); };
  let handle: string | undefined;
  check();
  try {
    const start = await client.beginMdbx2FileExport(providerId);
    handle = start.downloadHandle; check();
    if ((start.format !== "mdbx" && start.format !== "zip") || !Number.isSafeInteger(start.blobCount) || start.blobCount < 0 ||
      (start.format === "mdbx") !== (start.blobCount === 0)) throw new Error("MDBX 导出格式无效，未下载文件。");
    if (!handle || !Number.isSafeInteger(start.sizeBytes) || start.sizeBytes <= 0 || start.sizeBytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(start.sha256) || !Number.isSafeInteger(start.maxChunkBytes) || start.maxChunkBytes <= 0 || start.maxChunkBytes > 262144) throw new Error("MDBX 导出描述无效，未下载文件。");
    const bytes = new Uint8Array(start.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await client.readMdbx2FileExport(providerId, handle, offset); check();
      const data = base64ToBytes(chunk.dataBase64);
      if (chunk.downloadHandle !== handle || chunk.sha256 !== start.sha256 || chunk.sizeBytes !== bytes.length || chunk.offset !== offset || !data.length || data.length > start.maxChunkBytes || chunk.nextOffset !== offset + data.length || chunk.nextOffset > bytes.length || chunk.eof !== (chunk.nextOffset === bytes.length)) throw new Error("MDBX 导出分段校验失败，未下载文件。");
      bytes.set(data, offset); offset = chunk.nextOffset;
    }
    if (await attachmentSha256(bytes) !== start.sha256) throw new Error("MDBX 导出 SHA-256 不匹配，未下载文件。");
    check();
    const fileName = start.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
    const suffix = start.format === "zip" ? ".mdbx-backup.zip" : ".mdbx";
    return { bytes, sha256: start.sha256, format: start.format, blobCount: start.blobCount,
      fileName: fileName.endsWith(suffix) ? fileName : `monica-export${suffix}` };
  } finally {
    if (handle) await client.releaseMdbx2FileExport(providerId, handle).catch(() => undefined);
  }
}
