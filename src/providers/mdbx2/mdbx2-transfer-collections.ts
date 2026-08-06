import {
  MDBX2_MAX_COLLECTION_TITLE_BYTES,
  type Mdbx2CollectionMutationResult,
  type Mdbx2CollectionSummary,
  type Mdbx2CollectionSummaryPage
} from "./native-contract";
import { assertMdbx2TransferOperationId, mdbx2TransferUuid } from "./mdbx2-transfer-identity";

const MAX_COLLECTIONS = 10_000;
const MAX_PATH_DEPTH = 64;

export interface Mdbx2TransferCollectionClient {
  listCollections(
    vaultHandle: string,
    input?: { deleted?: boolean; excludeRoot?: boolean; pageSize?: number; cursor?: string }
  ): Promise<Mdbx2CollectionSummaryPage>;
  createCollection(
    vaultHandle: string,
    operationId: string,
    collectionId: string,
    title: string,
    parentCollectionId?: string
  ): Promise<Mdbx2CollectionMutationResult>;
}

export interface Mdbx2TransferCollectionPathInput {
  operationId: string;
  targetProviderId: string;
  vaultHandle: string;
  baseCollectionId?: string;
  paths: readonly (readonly string[])[];
}

export interface Mdbx2TransferCollectionPathResult {
  collections: Mdbx2CollectionSummary[];
  collectionIdByPath: Map<string, string | undefined>;
  createdCount: number;
}

export async function ensureMdbx2TransferCollectionPaths(
  client: Mdbx2TransferCollectionClient,
  input: Mdbx2TransferCollectionPathInput
): Promise<Mdbx2TransferCollectionPathResult> {
  const operationId = assertMdbx2TransferOperationId(input.operationId);
  const baseCollectionId = normalizedParentId(input.baseCollectionId);
  let collections = await listMdbx2TransferCollections(client, input.vaultHandle, true);
  if (baseCollectionId && !collections.some((collection) => collection.collectionId === baseCollectionId && !collection.deleted)) {
    throw new Error("所选 MDBX2 目标文件夹不存在或已删除。");
  }

  const normalizedPaths = uniquePaths(input.paths.map(validatePath));
  const collectionIdByPath = new Map<string, string | undefined>([[mdbx2TransferPathKey([]), baseCollectionId]]);
  let createdCount = 0;

  for (const path of normalizedPaths) {
    let parentCollectionId = baseCollectionId;
    const accumulated: string[] = [];
    for (const segment of path) {
      accumulated.push(segment);
      const key = mdbx2TransferPathKey(accumulated);
      const cached = collectionIdByPath.get(key);
      if (cached) {
        parentCollectionId = cached;
        continue;
      }

      const matches = childMatches(collections, parentCollectionId, segment);
      if (matches.length > 1) throw new Error(`目标中存在多个同名文件夹「${segment}」，无法安全选择。`);
      if (matches.length === 1) {
        parentCollectionId = matches[0].collectionId;
        collectionIdByPath.set(key, parentCollectionId);
        continue;
      }

      const identityName = JSON.stringify({
        version: 1,
        targetProviderId: input.targetProviderId,
        baseCollectionId: baseCollectionId || "root",
        path: accumulated
      });
      const collectionId = await mdbx2TransferUuid(operationId, `collection:${identityName}`);
      const collectionOperationId = await mdbx2TransferUuid(operationId, `collection-operation:${identityName}`);
      try {
        const created = await client.createCollection(
          input.vaultHandle,
          collectionOperationId,
          collectionId,
          segment,
          parentCollectionId
        );
        assertCreatedCollection(created.collection, collectionId, parentCollectionId, segment);
        collections.push(created.collection);
        parentCollectionId = created.collection.collectionId;
        createdCount += created.alreadyCommitted ? 0 : 1;
      } catch (error) {
        collections = await listMdbx2TransferCollections(client, input.vaultHandle, true);
        const recoveredById = collections.find((collection) => collection.collectionId === collectionId && !collection.deleted);
        const recoveredByName = childMatches(collections, parentCollectionId, segment);
        if (recoveredById) {
          assertCreatedCollection(recoveredById, collectionId, parentCollectionId, segment);
          parentCollectionId = recoveredById.collectionId;
        } else if (recoveredByName.length === 1) {
          parentCollectionId = recoveredByName[0].collectionId;
        } else {
          throw error;
        }
      }
      collectionIdByPath.set(key, parentCollectionId);
    }
  }

  return { collections, collectionIdByPath, createdCount };
}

export function mdbx2TransferPathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export async function listMdbx2TransferCollections(
  client: Mdbx2TransferCollectionClient,
  vaultHandle: string,
  excludeRoot: boolean
): Promise<Mdbx2CollectionSummary[]> {
  const items: Mdbx2CollectionSummary[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listCollections(vaultHandle, { deleted: false, excludeRoot, pageSize: 200, cursor });
    items.push(...page.items.filter((item) => !item.deleted));
    if (items.length > MAX_COLLECTIONS) throw new Error(`MDBX2 文件夹数量超过浏览器上限 ${MAX_COLLECTIONS}。`);
    if (!page.nextCursor) break;
    if (!page.items.length || cursors.has(page.nextCursor)) throw new Error("MDBX2 文件夹分页游标没有前进。");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function childMatches(
  collections: readonly Mdbx2CollectionSummary[],
  parentCollectionId: string | undefined,
  title: string
): Mdbx2CollectionSummary[] {
  const normalizedTitle = foldedTitle(title);
  return collections.filter((collection) => (
    normalizedParentId(collection.groupId) === parentCollectionId
      && foldedTitle(collection.title) === normalizedTitle
      && !collection.deleted
  ));
}

function validatePath(path: readonly string[]): string[] {
  if (!Array.isArray(path) || path.length > MAX_PATH_DEPTH) throw new Error(`MDBX2 分类层级最多支持 ${MAX_PATH_DEPTH} 层。`);
  return path.map((segment) => {
    const title = typeof segment === "string" ? segment.trim() : "";
    if (!title || title.includes("\0") || new TextEncoder().encode(title).byteLength > MDBX2_MAX_COLLECTION_TITLE_BYTES) {
      throw new Error("MDBX2 分类名称为空、包含 NUL 或超过 4096 个 UTF-8 字节。");
    }
    return title;
  });
}

function uniquePaths(paths: string[][]): string[][] {
  const byKey = new Map(paths.map((path) => [mdbx2TransferPathKey(path), path]));
  return [...byKey.values()].sort((left, right) => left.length - right.length || mdbx2TransferPathKey(left).localeCompare(mdbx2TransferPathKey(right)));
}

function normalizedParentId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized !== "root" ? normalized : undefined;
}

function foldedTitle(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function assertCreatedCollection(
  collection: Mdbx2CollectionSummary,
  collectionId: string,
  parentCollectionId: string | undefined,
  title: string
): void {
  if (
    collection.collectionId !== collectionId
      || normalizedParentId(collection.groupId) !== parentCollectionId
      || collection.title.trim() !== title
      || collection.deleted
  ) {
    throw new Error("MDBX2 文件夹创建响应与传输计划不一致。");
  }
}
