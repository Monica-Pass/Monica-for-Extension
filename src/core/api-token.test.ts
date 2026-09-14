import { describe, expect, it } from "vitest";
import type { ApiTokenItem } from "./model";
import { apiTokenFromPayload, apiTokenValidationError, decodeApiTokenPayload, serializeApiTokenMetadata, serializeApiTokenPayload } from "./api-token";
import { normalizeImportedVaultItem } from "../manager/import-items";
import { itemSearchText, itemSafeSummary } from "../manager/item-metadata";
import { decodeMdbx2Object, encodeMdbx2Object } from "../providers/mdbx2/mdbx2-item-codec";
import { normalizeMdbx2TransferItem, planMdbx2BatchTransfer } from "../providers/mdbx2/mdbx2-batch-transfer";
import { SecureVaultService } from "../security/secure-vault-service";
import { MemoryVaultSessionStore } from "../security/vault-session";
import { MemoryVaultStorage } from "../security/vault-storage";

const objectId = "1baea5a4-ccad-4371-955e-b9882513cad9";
const collectionId = "21be9357-1388-453c-87ed-35457088485e";
const payload = JSON.stringify({ schema: "monica.gateway.credential.v1", provider: "github", api_base: "https://api.github.com/", token: "synthetic-token-for-tests-only", note: "CLI usage", future: { policy: "preserve" } });
const metadata = JSON.stringify({ schema: "monica.api-token.fields.v1", notes: "Workspace automation", custom_fields: [{ id: 12, title: "scope", value: "synthetic-hidden-scope", protected: true, future: { version: 2 } }], future: [1, 2] });
const record = { objectId, collectionId, objectTypeId: "api-token", title: "workspace_token", payloadJson: payload, payloadSchemaVersion: 1, deleted: false, apiTokenMetadataJson: metadata, apiTokenFavorite: true };
const meta = { headCommitId: "commit-a", updatedAt: "2026-09-13T00:00:00.000Z" };
const token = (): ApiTokenItem => decodeMdbx2Object(record, meta, "mdbx-test").item as ApiTokenItem;

describe("Android native API tokens", () => {
  it("preserves archive state through Android-style metadata edits and can unarchive", () => {
    const original = token();
    const encoded = encodeMdbx2Object({ ...original, archivedAt: meta.updatedAt })!;
    const androidEdit = JSON.stringify({ ...JSON.parse(encoded.apiTokenMetadataJson!), notes: "Edited on Android" });
    const restored = decodeMdbx2Object({ ...record, ...encoded, apiTokenMetadataJson: androidEdit }, meta, "mdbx-test").item as ApiTokenItem;
    expect(restored).toMatchObject({ archivedAt: meta.updatedAt, notes: "Edited on Android" });
    expect(JSON.parse(serializeApiTokenMetadata({ ...restored, archivedAt: undefined }))).not.toHaveProperty("monica:extension:archived_at");
    expect(encoded.payloadJson).toBe(payload);
  });
  it("keeps the native UUID, CLI schema and unknown payload/label fields across an edit", () => {
    const item = token();
    expect(item).toMatchObject({ kind: "api-token", title: "workspace_token", favorite: true, notes: "Workspace automation", customFields: [{ id: 12, name: "scope", protected: true }] });
    item.token = "updated-synthetic-token-only";
    item.customFields[0].value = "edited-scope";
    const encoded = encodeMdbx2Object(item)!;
    expect(encoded.logicalObjectId).toBe(`api-token:${objectId}`);
    expect(encoded.apiTokenFavorite).toBe(true);
    expect(JSON.parse(encoded.payloadJson)).toEqual({ ...JSON.parse(payload), token: item.token });
    expect(encoded.payloadJson).not.toContain("monica_entry_id");
    expect(JSON.parse(encoded.apiTokenMetadataJson!)).toEqual({ ...JSON.parse(metadata), custom_fields: [{ ...JSON.parse(metadata).custom_fields[0], value: "edited-scope" }] });
    const roundTrip = decodeMdbx2Object({ ...record, ...encoded }, meta, "mdbx-test").item;
    expect(roundTrip).toMatchObject({ token: item.token, customFields: [{ value: "edited-scope", protected: true }] });
  });

  it("uses the app schema for general providers while preserving legacy CLI notes", () => {
    const item = { ...token(), title: "我的 API 密钥", provider: "custom-service", apiBase: "https://example.test/v1/", token: "short" };
    expect(apiTokenValidationError(item)).toBeUndefined();
    expect(JSON.parse(serializeApiTokenPayload(item))).toMatchObject({ schema: "monica.api-token.v1", note: "CLI usage", future: { policy: "preserve" } });
  });

  it("preserves field IDs and unknown extensions through JSON export/import and reordered edits", () => {
    const item = token();
    item.customFields.unshift({ id: -1, name: "environment", value: "test", protected: false });
    const imported = normalizeImportedVaultItem(JSON.parse(JSON.stringify(item))) as ApiTokenItem;
    expect(imported.customFields).toEqual(item.customFields);
    expect(JSON.parse(serializeApiTokenMetadata(imported)).custom_fields[1]).toMatchObject({ id: 12, future: { version: 2 } });
    expect(JSON.parse(serializeApiTokenMetadata(imported)).future).toEqual([1, 2]);
  });

  it("preserves unsupported/partial records instead of offering a destructive editor", () => {
    expect(decodeMdbx2Object({ ...record, apiTokenFavorite: undefined }, meta, "p").item).toBeUndefined();
    expect(decodeMdbx2Object({ ...record, apiTokenMetadataJson: '{"schema":"future"}' }, meta, "p").unsupportedReason).toBeTruthy();
    expect(apiTokenFromPayload(payload, '{"schema":"monica.api-token.fields.v1","custom_fields":[{}]}')).toBeUndefined();
    expect(decodeApiTokenPayload(JSON.stringify({ schema: "monica.api-token.v2" }))).toBeUndefined();
  });

  it("validates Android limits without exposing secret values in errors or searchable metadata", () => {
    const item = token();
    expect(itemSafeSummary(item)).toBe("github");
    expect(itemSearchText(item)).not.toContain(item.token);
    expect(itemSearchText(item)).not.toContain(item.customFields[0].value);
    for (const invalid of [
      { ...item, title: item.token }, { ...item, apiBase: `https://example.test/${item.token}` },
      { ...item, apiBase: "https://username:password@example.test" }, { ...item, apiBase: "javascript:alert(1)" },
      { ...item, token: " " }, { ...item, token: "x".repeat(17 * 1024) },
      { ...item, customFields: [...item.customFields, ...item.customFields] }
    ]) {
      const error = apiTokenValidationError(invalid);
      expect(error).toBeTruthy();
      expect(error).not.toContain(item.token);
    }
  });

  it("copies to a fresh native identity without adding Room fields to the gateway payload", () => {
    const original = token();
    const copied = normalizeMdbx2TransferItem(original, { action: "copy", targetItemId: "38b9d16c-bc09-4c56-9784-7e1e7db5728b" });
    expect(encodeMdbx2Object(copied)!.logicalObjectId).toBe("api-token:38b9d16c-bc09-4c56-9784-7e1e7db5728b");
    expect(planMdbx2BatchTransfer([original], { action: "copy", preserveCategories: false }).items[0].payloadPatch).toEqual({});
  });

  it("encrypts tokens and fields, rejects unsupported sync targets, and never grants login autofill", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup("Synthetic API token master password");
    const item = { ...token(), id: objectId, providerRefs: [] };
    await service.upsertItem(item);
    await expect(service.upsertItem(item, true)).rejects.toThrow();
    await service.upsertProvider({ id: "legacy-json", kind: "monica-webdav", name: "Legacy JSON", enabled: true, isDefaultSaveTarget: false, config: {} });
    await expect(service.upsertItem({ ...item, providerRefs: [{ providerId: "legacy-json" }] })).rejects.toThrow(/MDBX2/);
    await service.lock();
    await service.unlock("Synthetic API token master password");
    expect(await service.listItems()).toEqual([expect.objectContaining({ kind: "api-token", token: item.token, customFields: item.customFields })]);
    expect(JSON.stringify(await storage.read())).not.toContain(item.token);
    expect(JSON.stringify(await storage.read())).not.toContain(item.customFields[0].value);
  });
});
