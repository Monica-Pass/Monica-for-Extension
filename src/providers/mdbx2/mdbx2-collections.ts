import type { Mdbx2CollectionSummary } from "./native-contract";

export interface Mdbx2CollectionPresentation {
  item: Mdbx2CollectionSummary;
  path: string;
  parentPath: string;
  depth: number;
  hierarchyState: "ready" | "parent-unavailable" | "cycle";
}

export function presentMdbx2Collections(
  visible: Mdbx2CollectionSummary[],
  all: Mdbx2CollectionSummary[]
): Mdbx2CollectionPresentation[] {
  const byId = new Map(all.map((item) => [item.collectionId, item]));
  const cache = new Map<string, Omit<Mdbx2CollectionPresentation, "item">>();

  const resolve = (item: Mdbx2CollectionSummary, visiting = new Set<string>()): Omit<Mdbx2CollectionPresentation, "item"> => {
    const cached = cache.get(item.collectionId);
    if (cached) return cached;
    if (visiting.has(item.collectionId)) {
      return { path: item.title, parentPath: "层级异常", depth: 0, hierarchyState: "cycle" };
    }
    const nextVisiting = new Set(visiting).add(item.collectionId);
    const parentId = item.groupId;
    if (!parentId) {
      const result = { path: item.title, parentPath: "顶层", depth: 0, hierarchyState: "ready" as const };
      cache.set(item.collectionId, result);
      return result;
    }
    const parent = byId.get(parentId);
    if (!parent) {
      const result = { path: item.title, parentPath: "父级未加载", depth: 0, hierarchyState: "parent-unavailable" as const };
      cache.set(item.collectionId, result);
      return result;
    }
    const parentPresentation = resolve(parent, nextVisiting);
    if (parentPresentation.hierarchyState === "cycle") {
      return { path: item.title, parentPath: "层级异常", depth: 0, hierarchyState: "cycle" };
    }
    const result = {
      path: `${parentPresentation.path} / ${item.title}`,
      parentPath: parentPresentation.path,
      depth: Math.min(parentPresentation.depth + 1, 32),
      hierarchyState: parentPresentation.hierarchyState
    };
    cache.set(item.collectionId, result);
    return result;
  };

  return visible
    .map((item) => ({ item, ...resolve(item) }))
    .sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { sensitivity: "base" }) || left.item.collectionId.localeCompare(right.item.collectionId));
}

export function mdbx2CollectionDescendantIds(
  items: Mdbx2CollectionSummary[],
  collectionId: string
): Set<string> {
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (!item.groupId) continue;
    const current = children.get(item.groupId) || [];
    current.push(item.collectionId);
    children.set(item.groupId, current);
  }
  const descendants = new Set<string>();
  const pending = [...(children.get(collectionId) || [])];
  while (pending.length) {
    const candidate = pending.pop()!;
    if (descendants.has(candidate)) continue;
    descendants.add(candidate);
    pending.push(...(children.get(candidate) || []));
  }
  return descendants;
}
