import { describe, expect, it } from "vitest";
import { createLoginItem, type ProviderAccount } from "../../core/model";
import { Mdbx2Provider, type Mdbx2RuntimeClient } from "./mdbx2-provider";
import type { Mdbx2ObjectRecord, Mdbx2ObjectUpsertInput, Mdbx2ObjectWriteResult } from "./native-contract";

const HANDLE = "11111111-1111-4111-8111-111111111111";
const COLLECTION = "22222222-2222-4222-8222-222222222222";
const LOGIN_OBJECT = "33333333-3333-4333-8333-333333333333";
const FUTURE_OBJECT = "44444444-4444-4444-8444-444444444444";
const CREATED_OBJECT = "55555555-5555-4555-8555-555555555555";

class FakeRuntime implements Mdbx2RuntimeClient {
  readonly writes: Mdbx2ObjectUpsertInput[] = [];
  head = "commit-1";

  async vaultStatus() { return { vaultHandle: HANDLE, open: true, available: true }; }
  async listCollections(_handle: string, input: { deleted?: boolean } = {}) {
    return { items: input.deleted ? [] : [{ collectionId: COLLECTION, title: ".monica-root", favorite: false, archived: false, attachmentCount: 0, headCommitId: "root", deleted: false, updatedAt: "2026-08-02T00:00:00Z" }] };
  }
  async listObjects(_handle: string, _collection: string, input: { deleted?: boolean } = {}) {
    if (input.deleted) return { items: [] };
    return { items: [
      { objectId: LOGIN_OBJECT, collectionId: COLLECTION, objectTypeId: "login", title: "Example", payloadSchemaVersion: 1, headCommitId: this.head, deleted: false, updatedAt: "2026-08-02T00:00:00Z" },
      { objectId: FUTURE_OBJECT, collectionId: COLLECTION, objectTypeId: "future/v1", title: "Future", payloadSchemaVersion: 1, headCommitId: "future-1", deleted: false, updatedAt: "2026-08-02T00:00:00Z" }
    ] };
  }
  async revealObject(_handle: string, objectId: string): Promise<Mdbx2ObjectRecord> {
    if (objectId === FUTURE_OBJECT) return { objectId, collectionId: COLLECTION, objectTypeId: "future/v1", title: "Future", payloadJson: JSON.stringify({ monica_entry_id: "future:1", future: true }), payloadSchemaVersion: 1, deleted: false };
    return { objectId, collectionId: COLLECTION, objectTypeId: "login", title: "Example", payloadJson: JSON.stringify({ kind: "password", monica_entry_id: "password:42", website: "https://example.test", username: "demo", password_plain: "secret", future_field: 7 }), payloadSchemaVersion: 1, deleted: false };
  }
  async upsertObject(_handle: string, _operationId: string, input: Mdbx2ObjectUpsertInput): Promise<Mdbx2ObjectWriteResult> {
    this.writes.push(input);
    return { commitId: "commit-written", alreadyCommitted: false, logicalObjectId: input.logicalObjectId, objectId: input.logicalObjectId === "password:42" ? LOGIN_OBJECT : CREATED_OBJECT, collectionId: input.collectionId || COLLECTION, objectTypeId: input.objectTypeId };
  }
  async deleteObject() { return { changed: true, commitId: "commit-delete", alreadyCommitted: false, logicalObjectId: "password:42", objectId: LOGIN_OBJECT }; }
}

const account: ProviderAccount = { id: "mdbx-provider", kind: "mdbx2", name: "MDBX2", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: HANDLE } };

describe("MDBX2 provider", () => {
  it("imports Android objects and preserves unsupported future payloads", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const result = await provider.sync(account, { now: "2026-08-02T00:01:00Z", localItems: [] });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "login", username: "demo", password: "secret", replicaGroupId: "password:42" });
    expect(result.sourceRecords).toHaveLength(1);
    expect(result.warnings[0]).toContain("future/v1");
  });

  it("writes a local edit with the Android payload and preserves unknown fields", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const imported = await provider.sync(account, { now: "2026-08-02T00:01:00Z", localItems: [] });
    const login = { ...imported.items[0], password: "changed" } as typeof imported.items[0];
    const result = await provider.sync(account, { now: "2026-08-02T00:02:00Z", localItems: [login] });

    expect(result.conflicts).toHaveLength(0);
    expect(runtime.writes).toHaveLength(1);
    expect(JSON.parse(runtime.writes[0].payloadJson)).toMatchObject({ password_plain: "changed", future_field: 7 });
    expect(result.items[0].providerRefs[0]).toMatchObject({ revision: "commit-written", remoteId: LOGIN_OBJECT });
  });

  it("keeps the browser version when both sides changed", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const imported = await provider.sync(account, { now: "2026-08-02T00:01:00Z", localItems: [] });
    const login = { ...imported.items[0], password: "local-change" } as typeof imported.items[0];
    runtime.head = "commit-remote";
    const result = await provider.sync(account, { now: "2026-08-02T00:02:00Z", localItems: [login] });

    expect(result.conflicts).toHaveLength(1);
    expect(runtime.writes).toHaveLength(0);
    expect(result.items[0]).toMatchObject({ password: "local-change" });
  });

  it("creates a queued MDBX2 item whose provider reference has no physical Object ID", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const local = createLoginItem({
      title: "Local",
      username: "demo",
      password: "secret",
      uris: ["https://local.example"],
      providerRefs: [{ providerId: account.id }]
    });
    const result = await provider.sync(account, { now: "2026-08-02T00:02:00Z", localItems: [local] });

    expect(runtime.writes).toHaveLength(1);
    expect(runtime.writes[0]).toMatchObject({ logicalObjectId: `password:${local.id}`, objectTypeId: "login" });
    expect(result.items.find((item) => item.id === local.id)?.providerRefs[0]).toMatchObject({ remoteId: CREATED_OBJECT, revision: "commit-written" });
  });

  it("stops before opening the Native Host when the provider sync was cancelled", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(provider.sync(account, { now: "2026-08-02T00:02:00Z", localItems: [], signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.writes).toHaveLength(0);
  });
});
