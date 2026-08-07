import { describe, expect, it } from "vitest";
import {
  BitwardenAttachmentMutationStoreError,
  MemoryBitwardenAttachmentMutationStore,
  type BitwardenAttachmentMutationRecord
} from "./bitwarden-attachment-mutation-store";

describe("Bitwarden attachment durable mutation storage", () => {
  it("survives a new service instance, clones records, and enforces compare-and-swap", async () => {
    const records = new Map<string, BitwardenAttachmentMutationRecord>();
    const first = new MemoryBitwardenAttachmentMutationStore(records);
    const created = await first.save(record(), 0);
    created.stage = "completed";

    const second = new MemoryBitwardenAttachmentMutationStore(records);
    const restored = await second.read("provider-1", OPERATION_ID);
    expect(restored).toMatchObject({ revision: 1, stage: "prepared", fileUploadType: 0 });

    const updated = await second.save({ ...restored!, stage: "uploading" }, 1);
    expect(updated.revision).toBe(2);
    await expect(first.save({ ...created, stage: "verifying" }, 1)).rejects.toMatchObject({ code: "revision-stale" });
  });

  it("lists provider-scoped records and removes a completed receipt", async () => {
    const store = new MemoryBitwardenAttachmentMutationStore();
    await store.save(record(), 0);
    await store.save({ ...record(), providerId: "provider-2", operationId: "22222222-2222-4222-8222-222222222222" }, 0);

    await expect(store.list("provider-1")).resolves.toHaveLength(1);
    await store.delete("provider-1", OPERATION_ID);
    await expect(store.read("provider-1", OPERATION_ID)).resolves.toBeUndefined();
  });

  it("rejects malformed or secret-bearing records", async () => {
    const store = new MemoryBitwardenAttachmentMutationStore();
    await expect(store.save({ ...record(), plaintextSha256: "invalid" }, 0)).rejects.toBeInstanceOf(BitwardenAttachmentMutationStoreError);
    await expect(store.save({ ...record(), accessToken: "must-not-persist" } as unknown as BitwardenAttachmentMutationRecord, 0))
      .rejects.toMatchObject({ code: "record-invalid" });
  });
});

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

function record(): BitwardenAttachmentMutationRecord {
  return {
    version: 1,
    revision: 0,
    providerId: "provider-1",
    operationId: OPERATION_ID,
    cipherId: "cipher-1",
    kind: "upload",
    stage: "prepared",
    attempt: 1,
    newAttachmentId: "attachment-1",
    fileUploadType: 0,
    plaintextSha256: "a".repeat(64),
    fileNameSha256: "b".repeat(64),
    encryptedFileNameSha256: "c".repeat(64),
    wrappedKeySha256: "d".repeat(64),
    plainSizeBytes: 32,
    encryptedSizeBytes: 80,
    serverRevisionDate: "2026-08-08T00:00:00.000Z",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z"
  };
}
