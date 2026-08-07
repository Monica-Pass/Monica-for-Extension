import { describe, expect, it } from "vitest";
import type { ProviderAccount } from "../../core/model";
import {
  KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG,
  createKeePassCacheEncryptionKey,
  openKeePassDurableReceipt,
  sealKeePassDurableReceipt
} from "./keepass-receipt-crypto";
import type { KeePassDurableMutationReceipt } from "./keepass-working-copy-store";

describe("KeePass durable receipt encryption", () => {
  it("keeps semantic mutation results out of the IndexedDB envelope", async () => {
    const target = account();
    const receipt = groupReceipt();
    const envelope = await sealKeePassDurableReceipt(target, receipt);

    expect(envelope).toMatchObject({ version: 1, providerId: target.id, operationId: receipt.operationId, cipher: "AES-256-GCM" });
    expect(JSON.stringify(envelope)).not.toContain("private-group-uuid");
    await expect(openKeePassDurableReceipt(target, envelope)).resolves.toEqual(receipt);
  });

  it("binds ciphertext to provider, operation, intent and the encrypted-vault cache key", async () => {
    const target = account();
    const first = await sealKeePassDurableReceipt(target, groupReceipt());
    const changed = await sealKeePassDurableReceipt(target, {
      ...groupReceipt(),
      intentSha256: "e".repeat(64)
    });
    expect(changed.intentTag).not.toBe(first.intentTag);

    await expect(openKeePassDurableReceipt({ ...target, config: { ...target.config, [KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]: createKeePassCacheEncryptionKey() } }, first))
      .rejects.toMatchObject({ code: "receipt-invalid" });
    await expect(openKeePassDurableReceipt(target, { ...first, operationId: "22222222-2222-4222-8222-222222222222" }))
      .rejects.toMatchObject({ code: "receipt-invalid" });
    await expect(openKeePassDurableReceipt({ ...target, config: {} }, first)).rejects.toMatchObject({ code: "cache-key-missing" });
  });
});

function account(): ProviderAccount {
  return {
    id: "keepass-remote-1",
    kind: "keepass",
    name: "Remote KeePass",
    enabled: true,
    isDefaultSaveTarget: false,
    config: {
      sourceMode: "webdav",
      [KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]: createKeePassCacheEncryptionKey()
    }
  };
}

function groupReceipt(): KeePassDurableMutationReceipt {
  return {
    providerId: "keepass-remote-1",
    operationId: "11111111-1111-4111-8111-111111111111",
    kind: "group-create",
    intentSha256: "d".repeat(64),
    completedAt: "2026-08-07T06:00:00.000Z",
    result: { type: "group", changed: true, groupUuid: "private-group-uuid" }
  };
}
