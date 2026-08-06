import { describe, expect, it } from "vitest";
import { createLoginItem, type ProviderAccount } from "../../core/model";
import { Mdbx2Provider, type Mdbx2CloudSynchronizer, type Mdbx2RuntimeClient } from "./mdbx2-provider";
import type { Mdbx2ObjectMutationInput, Mdbx2ObjectOperationResolution, Mdbx2ObjectRecord, Mdbx2ObjectUpsertInput, Mdbx2ObjectWriteResult } from "./native-contract";

const HANDLE = "11111111-1111-4111-8111-111111111111";
const COLLECTION = "22222222-2222-4222-8222-222222222222";
const LOGIN_OBJECT = "33333333-3333-4333-8333-333333333333";
const FUTURE_OBJECT = "44444444-4444-4444-8444-444444444444";
const CREATED_OBJECT = "55555555-5555-4555-8555-555555555555";

class FakeRuntime implements Mdbx2RuntimeClient {
  readonly writes: Mdbx2ObjectUpsertInput[] = [];
  readonly batchOperationIds: string[] = [];
  head = "commit-1";
  password = "secret";
  failAfterWrite = false;
  lastOperationScope?: string;

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
    return { objectId, collectionId: COLLECTION, objectTypeId: "login", title: "Example", payloadJson: JSON.stringify({ kind: "password", monica_entry_id: "password:42", website: "https://example.test", username: "demo", password_plain: this.password, future_field: 7 }), payloadSchemaVersion: 1, deleted: false };
  }
  async upsertObject(_handle: string, _operationId: string, input: Mdbx2ObjectUpsertInput): Promise<Mdbx2ObjectWriteResult> {
    this.writes.push(input);
    this.head = "commit-written";
    this.password = JSON.parse(input.payloadJson).password_plain || this.password;
    if (this.failAfterWrite) throw new Error("Native Host response was lost");
    return { commitId: "commit-written", alreadyCommitted: false, logicalObjectId: input.logicalObjectId, objectId: input.logicalObjectId === "password:42" ? LOGIN_OBJECT : CREATED_OBJECT, collectionId: input.collectionId || COLLECTION, objectTypeId: input.objectTypeId };
  }
  async deleteObject() { return { changed: true, commitId: "commit-delete", alreadyCommitted: false, logicalObjectId: "password:42", objectId: LOGIN_OBJECT }; }
  async mutateObjects(_handle: string, operationScope: string, mutations: Mdbx2ObjectMutationInput[]) {
    this.lastOperationScope = operationScope;
    if (mutations.length > 1) this.batchOperationIds.push(operationScope);
    const items = mutations.map((mutation) => {
      if (mutation.kind === "delete") return { kind: "delete" as const, changed: true, logicalObjectId: mutation.logicalObjectId, objectId: LOGIN_OBJECT };
      this.writes.push(mutation);
      this.password = JSON.parse(mutation.payloadJson).password_plain || this.password;
      return {
        kind: "upsert" as const,
        changed: true,
        logicalObjectId: mutation.logicalObjectId,
        objectId: mutation.logicalObjectId === "password:42" ? LOGIN_OBJECT : CREATED_OBJECT,
        collectionId: mutation.collectionId || COLLECTION,
        objectTypeId: mutation.objectTypeId
      };
    });
    const commitId = mutations.length > 1 ? "commit-batch" : "commit-written";
    this.head = commitId;
    if (this.failAfterWrite) throw new Error("Native Host response was lost");
    return { changed: true, operationId: HANDLE, commitId, alreadyCommitted: false, items };
  }
  async resolveObjectOperation(_handle: string, operationScope: string): Promise<Mdbx2ObjectOperationResolution> {
    return operationScope === this.lastOperationScope && (this.head === "commit-written" || this.head === "commit-batch")
      ? { known: true, committed: true, operationId: HANDLE, commitId: this.head }
      : { known: false, committed: false };
  }
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

  it("commits multiple browser changes as one bounded MDBX2 operation", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const imported = await provider.sync(account, { now: "2026-08-02T00:01:00Z", localItems: [] });
    const edited = { ...imported.items[0], password: "batch-changed" } as typeof imported.items[0];
    const created = createLoginItem({
      title: "Second",
      username: "second",
      password: "secret-2",
      uris: ["https://second.example"],
      providerRefs: [{ providerId: account.id }]
    });

    const result = await provider.sync(account, { now: "2026-08-02T00:02:00Z", localItems: [edited, created] });

    expect(runtime.batchOperationIds).toHaveLength(1);
    expect(runtime.writes).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
    expect(result.items.filter((item) => referenceForTest(item)?.revision === "commit-batch")).toHaveLength(2);
  });

  it("writes a prepared transfer batch with a caller-owned retry scope", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const first = createLoginItem({
      title: "Transfer one",
      username: "one",
      password: "secret-one",
      uris: ["https://one.example"],
      providerRefs: []
    });
    const second = createLoginItem({
      title: "Transfer two",
      username: "two",
      password: "secret-two",
      uris: ["https://two.example"],
      providerRefs: []
    });
    const result = await provider.createBatch(account, "ab".repeat(32), [first, second]);

    expect(runtime.lastOperationScope).toBe("ab".repeat(32));
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => referenceForTest(item)?.remoteId)).toBe(true);
  });

  it("rejects a non-SHA operation scope before calling the Native Runtime", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const item = createLoginItem({ title: "Transfer", password: "secret", providerRefs: [] });
    await expect(provider.createBatch(account, "transfer:operation:0", [item])).rejects.toThrow("64 位小写 SHA-256");
    expect(runtime.lastOperationScope).toBeUndefined();
  });

  it("applies a bounded Android payload patch while retaining the item model", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const item = createLoginItem({ title: "Patched", password: "secret", providerRefs: [] });
    const result = await provider.createPreparedBatch(account, "cd".repeat(32), [{
      item,
      payloadPatch: { bitwarden_mode: false, bound_note_entry_id: null }
    }]);
    expect(result.items[0]).toMatchObject({ title: "Patched" });
    expect(runtime.writes[runtime.writes.length - 1]?.payloadJson).toContain('"bound_note_entry_id":null');
  });

  it("recovers a committed Object operation after the Native Host response is lost", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const imported = await provider.sync(account, { now: "2026-08-02T00:01:00Z", localItems: [] });
    const edited = { ...imported.items[0], password: "durable-change" } as typeof imported.items[0];
    runtime.failAfterWrite = true;

    await expect(provider.sync(account, { now: "2026-08-02T00:02:00Z", localItems: [edited] })).rejects.toThrow("response was lost");
    runtime.failAfterWrite = false;
    const recovered = await provider.sync(account, { now: "2026-08-02T00:03:00Z", localItems: [edited] });

    expect(runtime.writes).toHaveLength(1);
    expect(recovered.conflicts).toHaveLength(0);
    expect(recovered.items[0]).toMatchObject({ password: "durable-change" });
    expect(recovered.items[0].providerRefs[0]).toMatchObject({ remoteId: LOGIN_OBJECT, revision: "commit-written" });
  });

  it("stops before opening the Native Host when the provider sync was cancelled", async () => {
    const runtime = new FakeRuntime();
    const provider = new Mdbx2Provider(runtime);
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(provider.sync(account, { now: "2026-08-02T00:02:00Z", localItems: [], signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.writes).toHaveLength(0);
  });

  it("runs WebDAV bundle synchronization before and after local reconciliation and reloads the final Host state", async () => {
    const runtime = new FakeRuntime();
    const calls: unknown[] = [];
    let count = 0;
    const cloud: Mdbx2CloudSynchronizer = {
      async synchronize(input) {
        calls.push(input);
        count += 1;
        runtime.head = count === 1 ? "commit-android" : "commit-final";
        return {
          uploadedSegments: 0,
          downloadedSegments: count === 1 ? 1 : 0,
          uploadedBlobs: 0,
          downloadedBlobs: 0,
          appliedCommits: count === 1 ? 1 : 0,
          skippedCommits: 0,
          conflicts: count === 2 ? 1 : 0,
          blockedStreams: count === 2 ? 1 : 0
        };
      }
    };
    const provider = new Mdbx2Provider(runtime, cloud);
    const cloudAccount: ProviderAccount = {
      ...account,
      config: {
        ...account.config,
        webDavBaseUrl: "https://vault.test/dav",
        webDavUsername: "joyins",
        webDavPassword: "secret",
        remotePath: "vaults/main.mdbx",
        syncStateHandle: "66666666-6666-4666-8666-666666666666"
      }
    };
    const result = await provider.sync(cloudAccount, { now: "2026-08-02T00:03:00Z", localItems: [] });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ vaultHandle: HANDLE, remotePath: "vaults/main.mdbx", username: "joyins" });
    expect(result.items[0].providerRefs[0].revision).toBe("commit-final");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("记录了 1 个冲突"),
      expect.stringContaining("1 个远端设备流")
    ]));
  });
});

function referenceForTest(item: { providerRefs: Array<{ providerId: string; remoteId?: string; revision?: string }> }) {
  return item.providerRefs.find((reference) => reference.providerId === account.id);
}
