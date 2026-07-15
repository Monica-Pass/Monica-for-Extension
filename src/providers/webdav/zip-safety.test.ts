import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inspectZipArchive, safeUnzipSync } from "./zip-safety";

function patchFirstCentralDirectoryUncompressedSize(input: Uint8Array, size: number): Uint8Array {
  const bytes = input.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, size, true);
      return bytes;
    }
  }
  throw new Error("central directory not found");
}

describe("WebDAV ZIP safety preflight", () => {
  it("accepts a normal Android-style archive and reports bounded metadata", () => {
    const archive = zipSync({
      "folders/_root/passwords/password_1_1.json": strToU8('{"id":1}'),
      "images/image.enc": Uint8Array.of(1, 2, 3)
    });

    const inspection = inspectZipArchive(archive);

    expect(inspection.entryCount).toBe(2);
    expect(inspection.totalUncompressedBytes).toBe(11);
    expect(safeUnzipSync(archive)["images/image.enc"]).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("rejects declared decompressed sizes before invoking the inflater", () => {
    const archive = zipSync({ "folders/_root/passwords/password_1_1.json": strToU8("{}") });
    const hostile = patchFirstCentralDirectoryUncompressedSize(archive, 32 * 1024 * 1024);

    expect(() => inspectZipArchive(hostile, { maxEntryUncompressedBytes: 1024 })).toThrow("单个 ZIP 条目超过安全上限");
  });

  it("rejects traversal paths duplicate names excessive entry counts and suspicious ratios", () => {
    const traversal = zipSync({ "../escape.json": strToU8("{}") });
    expect(() => inspectZipArchive(traversal)).toThrow("不安全路径");

    const entries = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`safe/${index}.json`, strToU8("{}")]));
    expect(() => inspectZipArchive(zipSync(entries), { maxEntries: 3 })).toThrow("条目数量超过安全上限");

    const compressible = zipSync({ "safe/blob.bin": new Uint8Array(64 * 1024) });
    expect(() => inspectZipArchive(compressible, { maxCompressionRatio: 2 })).toThrow("压缩比异常");
  });

  it("rejects oversized JSON separately from opaque attachment payloads", () => {
    const json = zipSync({ "folders/_root/notes/note_1_1.json": strToU8("x".repeat(2048)) });
    expect(() => inspectZipArchive(json, { maxJsonEntryBytes: 1024, maxCompressionRatio: 10_000 })).toThrow("JSON 条目超过安全上限");

    const attachment = zipSync({ "attachments_portable/data.bin": new Uint8Array(2048) }, { level: 0 });
    expect(() => inspectZipArchive(attachment, { maxJsonEntryBytes: 1024, maxCompressionRatio: 10_000 })).not.toThrow();
  });
});
