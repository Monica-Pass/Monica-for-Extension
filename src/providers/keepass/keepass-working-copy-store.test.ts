import { describe, expect, it } from "vitest";
import {
  KeePassWorkingCopyStoreError,
  MemoryKeePassWorkingCopyStorage,
  type KeePassRemoteWorkingCopyRecord
} from "./keepass-working-copy-store";

describe("KeePass remote working-copy storage", () => {
  it("survives a new storage instance and never exposes mutable byte aliases", async () => {
    const records = new Map<string, KeePassRemoteWorkingCopyRecord>();
    const first = new MemoryKeePassWorkingCopyStorage(records);
    const input = fixture();
    const saved = await first.save(input, 0);
    input.baseBytes[0] = 99;
    saved.workingBytes[0] = 88;

    const second = new MemoryKeePassWorkingCopyStorage(records);
    const restored = await second.read("keepass-remote-1");

    expect(restored).toMatchObject({ revision: 1, baseEtag: '"etag-1"' });
    expect(restored?.baseBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(restored?.workingBytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("uses compare-and-swap revisions to reject a stale background writer", async () => {
    const records = new Map<string, KeePassRemoteWorkingCopyRecord>();
    const first = new MemoryKeePassWorkingCopyStorage(records);
    const second = new MemoryKeePassWorkingCopyStorage(records);
    await first.save(fixture(), 0);
    const current = await second.save({ ...fixture(), workingBytes: new Uint8Array([7]) }, 1);

    expect(current.revision).toBe(2);
    await expect(first.save(fixture(), 1)).rejects.toBeInstanceOf(KeePassWorkingCopyStoreError);
    await expect(first.save(fixture(), 1)).rejects.toMatchObject({ code: "revision-stale" });
  });

  it("rejects malformed metadata and oversized records", async () => {
    const storage = new MemoryKeePassWorkingCopyStorage();
    await expect(storage.save({ ...fixture(), baseSha256: "invalid" }, 0)).rejects.toMatchObject({ code: "record-invalid" });
    await expect(storage.save({ ...fixture(), providerId: "contains space" }, 0)).rejects.toMatchObject({ code: "record-invalid" });
  });
});

function fixture() {
  return {
    providerId: "keepass-remote-1",
    baseBytes: new Uint8Array([1, 2, 3]),
    workingBytes: new Uint8Array([4, 5, 6]),
    baseEtag: '"etag-1"',
    baseLastModified: "Wed, 15 Jul 2026 02:02:02 GMT",
    baseSha256: "a".repeat(64),
    workingSha256: "b".repeat(64),
    updatedAt: "2026-08-07T04:00:00.000Z"
  };
}
