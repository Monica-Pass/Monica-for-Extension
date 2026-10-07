import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { LoginItem, ProviderAccount } from "../core/model";
import { ProviderAttachmentUploadStore } from "../providers/attachments/attachment-upload-store";
import { finishWebDavAttachmentUpload } from "./webdav-attachment-upload";

const account: ProviderAccount = { id: "webdav", kind: "monica-webdav", name: "Synthetic", enabled: true, isDefaultSaveTarget: false, config: { backupPassword: "synthetic" } };
const item: LoginItem = { id: "login", kind: "login", title: "Synthetic", username: "", password: "", uris: [], customFields: [], notes: "", favorite: false, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z", providerRefs: [{ providerId: "webdav" }] };
const operationId = "11111111-1111-4111-8111-111111111111";
function setup(complete = true) {
  const store = new ProviderAttachmentUploadStore();
  const started = store.begin({ providerId: account.id, providerKind: "monica-webdav", itemId: item.id, fileName: "wallet-synthetic.png", mediaType: "image/png", sizeBytes: 3, replaceExisting: false, operationId }, 1024);
  if (complete) store.write(started.transferId, 0, Uint8Array.of(1, 2, 3));
  const addAttachment = vi.fn().mockResolvedValue({ attachmentId: "android-portable:synthetic.bin", providerKind: "monica-webdav", fileName: "wallet-synthetic.png", sizeBytes: 3, protected: true, mediaType: "image/png" });
  return { store, started, adapter: { addAttachment } };
}
describe("WebDAV attachment upload completion", () => {
  it("is wired into the actual background FINISH branch", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const branch = source.split('case "PROVIDER_ATTACHMENT_UPLOAD_FINISH":')[1].split('case "PROVIDER_ATTACHMENT_UPLOAD_ABORT":')[0];
    expect(branch).toContain('account.kind === "monica-webdav"');
    expect(branch).toContain("finishWebDavAttachmentUpload");
  });
  it("commits verified bytes through the existing encrypted adapter and replays a repeated finish", async () => {
    const { store, started, adapter } = setup();
    const request = { transferId: started.transferId, operationId };
    const pending = await store.complete(request.transferId);
    const result = await finishWebDavAttachmentUpload(store, adapter, account, item, request);
    expect(result).toMatchObject({ changed: true, attachment: { mediaType: "image/png" } });
    expect(adapter.addAttachment).toHaveBeenCalledWith(account, item, expect.objectContaining({ fileName: "wallet-synthetic.png", mediaType: "image/png", sizeBytes: 3, sha256Hex: pending.sha256 }), pending.bytes);
    expect([...pending.bytes]).toEqual([0, 0, 0]);
    expect(await finishWebDavAttachmentUpload(store, adapter, account, item, request)).toEqual(result);
    expect(adapter.addAttachment).toHaveBeenCalledTimes(1);
  });
  it.each(["wrong-item", "wrong-provider", "wrong-operation", "incomplete", "encryption-removed"])("rejects %s without remote side effects", async failure => {
    const { store, started, adapter } = setup(failure !== "incomplete");
    await expect(finishWebDavAttachmentUpload(store, adapter,
      failure === "wrong-provider" ? { ...account, id: "another" } : failure === "encryption-removed" ? { ...account, config: {} } : account,
      failure === "wrong-item" ? { ...item, id: "another" } : item,
      { transferId: started.transferId, operationId: failure === "wrong-operation" ? "22222222-2222-4222-8222-222222222222" : operationId }
    )).rejects.toThrow();
    expect(adapter.addAttachment).not.toHaveBeenCalled();
    expect(store.committedResult(started.transferId)).toBeUndefined();
  });
  it("does not acknowledge a failed remote upload and allows an explicit retry", async () => {
    const { store, started, adapter } = setup();
    adapter.addAttachment.mockRejectedValueOnce(new Error("Synthetic network failure"));
    const before = structuredClone(item);
    await expect(finishWebDavAttachmentUpload(store, adapter, account, item, started)).rejects.toThrow("network failure");
    expect(store.committedResult(started.transferId)).toBeUndefined();
    expect(item).toEqual(before);
    expect([...(await store.complete(started.transferId)).bytes]).toEqual([1, 2, 3]);
    await expect(finishWebDavAttachmentUpload(store, adapter, account, item, started)).resolves.toMatchObject({ changed: true });
  });
  it("coalesces overlapping finish retries into a single remote write", async () => {
    const { store, started, adapter } = setup();
    const results = await Promise.all([
      finishWebDavAttachmentUpload(store, adapter, account, item, started),
      finishWebDavAttachmentUpload(store, adapter, account, item, started)
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(adapter.addAttachment).toHaveBeenCalledTimes(1);
  });
});
