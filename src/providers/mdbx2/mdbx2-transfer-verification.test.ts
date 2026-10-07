import { describe, expect, it } from "vitest";
import { createLoginItem, type ProviderAccount } from "../../core/model";
import { readMdbx2TransferBinding, verifyMdbx2TransferBinding, verifyMdbx2TransferTargets } from "./mdbx2-transfer-verification";

const account: ProviderAccount = { id: "target", kind: "mdbx2", name: "Target", enabled: true,
  isDefaultSaveTarget: false, config: { vaultHandle: "handle" } };
const status = { vaultHandle: "handle", vaultId: "authenticated-id", open: true, available: true };
const binding = { providerId: "target", vaultHandle: "handle", vaultId: "authenticated-id" };
const item = { ...createLoginItem({ title: "Synthetic" }), providerRefs: [{ providerId: "target", remoteId: "object", remoteFolderId: "folder", revision: "written-commit" }] };
const record = { objectId: "object", collectionId: "folder", objectTypeId: "login", title: "Synthetic",
  payloadJson: "{}", payloadSchemaVersion: 1, headCommitId: "written-commit", deleted: false };

describe("MDBX move finalization verification", () => {
  it("uses live identity for legacy accounts but rejects conflicting saved identity", async () => {
    const client = { vaultStatus: async () => status };
    expect(await readMdbx2TransferBinding(client, account)).toEqual(binding);
    await expect(readMdbx2TransferBinding(client, { ...account, config: { ...account.config, nativeVaultId: "different" } })).rejects.toThrow();
  });
  it.each([{ open: false }, { available: false }, { vaultId: undefined }, { vaultHandle: "other" }])("rejects unverified native status %j", async change => {
    await expect(readMdbx2TransferBinding({ vaultStatus: async () => ({ ...status, ...change }) }, account)).rejects.toThrow();
  });
  it("rejects changed live identity or connection and unavailable provider", async () => {
    await expect(verifyMdbx2TransferBinding({ vaultStatus: async () => ({ ...status, vaultId: "other" }) }, account, binding)).rejects.toThrow();
    await expect(verifyMdbx2TransferBinding({ vaultStatus: async () => ({ ...status, vaultHandle: "new" }) }, { ...account, config: { vaultHandle: "new" } }, binding)).rejects.toThrow();
    await expect(verifyMdbx2TransferBinding({ vaultStatus: async () => status }, undefined, binding)).rejects.toThrow();
  });
  it.each([{ deleted: true }, { objectId: "other" }, { collectionId: "other" }, { headCommitId: "newer" }, { headCommitId: undefined }])("rejects changed destination %j", async change => {
    await expect(verifyMdbx2TransferTargets({ revealObject: async () => ({ ...record, ...change }) }, binding, [item])).rejects.toThrow();
  });
  it("accepts exact committed destination and rejects incomplete references", async () => {
    const client = { revealObject: async () => record };
    await verifyMdbx2TransferTargets(client, binding, [item]);
    await expect(verifyMdbx2TransferTargets(client, binding, [{ ...item, providerRefs: [] }])).rejects.toThrow();
    await expect(verifyMdbx2TransferTargets(client, binding, [{ ...item, providerRefs: [item.providerRefs[0], item.providerRefs[0]] }])).rejects.toThrow();
    await expect(verifyMdbx2TransferTargets(client, binding, [{ ...item, providerRefs: [{ ...item.providerRefs[0], revision: undefined }] }])).rejects.toThrow();
  });
});
