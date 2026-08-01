import { describe, expect, it } from "vitest";
import {
  mdbx2BlobPath,
  mdbx2SegmentPath,
  mdbx2SyncRoot,
  normalizeMdbx2RemoteComponent,
  normalizeMdbx2RemotePath,
  parseMdbx2RemoteSegmentPath
} from "./mdbx2-sync-paths";

describe("Android-compatible MDBX2 remote names", () => {
  it("matches Android's stable content-addressed vectors", () => {
    const digest = "ab".repeat(32);
    expect(mdbx2SyncRoot("/vaults/main.mdbx/")).toBe("vaults/main.mdbx.sync");
    const segment = mdbx2SegmentPath("vaults/main.mdbx", "device-a", "transfer-a", 7, digest);
    expect(segment).toBe(`vaults/main.mdbx.sync/streams/device-a/transfer-a/segments/0000000007-${digest}.mdbxsync`);
    expect(mdbx2BlobPath("vaults/main.mdbx", digest)).toBe(`vaults/main.mdbx.sync/blobs/ab/ab/${digest}`);
    expect(parseMdbx2RemoteSegmentPath("vaults/main.mdbx", segment)).toEqual({
      deviceId: "device-a",
      generationId: "transfer-a",
      sequence: 7,
      digestHex: digest,
      path: segment,
      streamId: "device-a/transfer-a"
    });
  });

  it("normalizes separators and rejects escape components", () => {
    expect(normalizeMdbx2RemotePath("  vaults\\main.mdbx  ")).toBe("vaults/main.mdbx");
    expect(normalizeMdbx2RemoteComponent(" device-a ")).toBe("device-a");
    expect(() => normalizeMdbx2RemotePath("vaults/../main.mdbx")).toThrow("不安全");
    expect(() => normalizeMdbx2RemoteComponent("device/a")).toThrow("不安全");
    expect(() => mdbx2SegmentPath("main.mdbx", "device", "transfer", 0, "ff")).toThrow("摘要");
    expect(parseMdbx2RemoteSegmentPath("main.mdbx", "main.mdbx.sync/streams/device/transfer/segments/7-bad.mdbxsync")).toBeUndefined();
  });
});
