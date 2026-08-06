import { describe, expect, it } from "vitest";
import type {
  Mdbx2CollectionMutationResult,
  Mdbx2CollectionSummary,
  Mdbx2CollectionSummaryPage
} from "./native-contract";
import {
  ensureMdbx2TransferCollectionPaths,
  mdbx2TransferPathKey,
  type Mdbx2TransferCollectionClient
} from "./mdbx2-transfer-collections";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_HANDLE = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "mdbx-target";

class FakeCollectionClient implements Mdbx2TransferCollectionClient {
  readonly collections: Mdbx2CollectionSummary[] = [];
  readonly creates: Array<{ operationId: string; collectionId: string; title: string; parentCollectionId?: string }> = [];
  loseNextResponse = false;

  async listCollections(): Promise<Mdbx2CollectionSummaryPage> {
    return { items: this.collections.map((collection) => ({ ...collection })) };
  }

  async createCollection(
    _vaultHandle: string,
    operationId: string,
    collectionId: string,
    title: string,
    parentCollectionId?: string
  ): Promise<Mdbx2CollectionMutationResult> {
    this.creates.push({ operationId, collectionId, title, parentCollectionId });
    let collection = this.collections.find((candidate) => candidate.collectionId === collectionId);
    const alreadyCommitted = Boolean(collection);
    if (!collection) {
      collection = summary(collectionId, title, parentCollectionId);
      this.collections.push(collection);
    }
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("response lost");
    }
    return { operationId, commitId: collection.headCommitId, alreadyCommitted, collection: { ...collection } };
  }
}

describe("MDBX2 transfer Collection paths", () => {
  it("reuses case-insensitive prefixes and creates only missing descendants", async () => {
    const client = new FakeCollectionClient();
    const work = summary("33333333-3333-4333-8333-333333333333", "Work");
    client.collections.push(work);

    const result = await ensureMdbx2TransferCollectionPaths(client, {
      operationId: OPERATION_ID,
      targetProviderId: PROVIDER_ID,
      vaultHandle: VAULT_HANDLE,
      paths: [["work", "Cloud"], ["Work", "Cloud", "Mail"]]
    });

    expect(client.creates.map((entry) => entry.title)).toEqual(["Cloud", "Mail"]);
    expect(result.collectionIdByPath.get(mdbx2TransferPathKey(["work", "Cloud"]))).toBe(client.creates[0].collectionId);
    expect(result.createdCount).toBe(2);
  });

  it("recovers a committed create after its response is lost and reuses deterministic IDs", async () => {
    const client = new FakeCollectionClient();
    client.loseNextResponse = true;
    const first = await ensureMdbx2TransferCollectionPaths(client, {
      operationId: OPERATION_ID,
      targetProviderId: PROVIDER_ID,
      vaultHandle: VAULT_HANDLE,
      paths: [["Accounts"]]
    });
    const firstId = first.collectionIdByPath.get(mdbx2TransferPathKey(["Accounts"]));
    const repeated = await ensureMdbx2TransferCollectionPaths(client, {
      operationId: OPERATION_ID,
      targetProviderId: PROVIDER_ID,
      vaultHandle: VAULT_HANDLE,
      paths: [["Accounts"]]
    });

    expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
    expect(repeated.collectionIdByPath.get(mdbx2TransferPathKey(["Accounts"]))).toBe(firstId);
    expect(client.collections).toHaveLength(1);
  });

  it("fails closed when the target contains ambiguous sibling names", async () => {
    const client = new FakeCollectionClient();
    client.collections.push(
      summary("33333333-3333-4333-8333-333333333333", "Accounts"),
      summary("44444444-4444-4444-8444-444444444444", "accounts")
    );
    await expect(ensureMdbx2TransferCollectionPaths(client, {
      operationId: OPERATION_ID,
      targetProviderId: PROVIDER_ID,
      vaultHandle: VAULT_HANDLE,
      paths: [["ACCOUNTS"]]
    })).rejects.toThrow("多个同名文件夹");
  });
});

function summary(collectionId: string, title: string, groupId?: string): Mdbx2CollectionSummary {
  return {
    collectionId,
    title,
    groupId,
    favorite: false,
    archived: false,
    attachmentCount: 0,
    headCommitId: collectionId,
    deleted: false,
    updatedAt: "2026-08-06T00:00:00.000Z"
  };
}
