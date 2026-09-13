import type { ProviderAccount, VaultItem, VaultItemKind } from "../core/model";

export interface HomeFolderRef {
  sourceId: string;
  type: "category" | "keepass" | "remote" | "mdbx" | "uncategorized";
  value: string;
  label: string;
}
export interface HomeFolder extends HomeFolderRef { key: string; count: number }
export interface HomeDestination {
  section: "vault" | "passwords" | "wallet" | "notes" | "totp" | "passkeys" | "archive" | "trash" | "providers";
  sourceId?: string;
  kind?: VaultItemKind;
  folder?: HomeFolderRef;
  favorite?: boolean;
  providerId?: string;
}

function sourceIds(item: VaultItem, localIds: ReadonlySet<string>): string[] {
  if (!item.providerRefs.length) return ["local"];
  return [...new Set(item.providerRefs.map(ref => localIds.has(ref.providerId) ? "local" : ref.providerId))];
}

function localSourceIds(providers: readonly ProviderAccount[]): Set<string> {
  return new Set(["local", ...providers.filter(provider => provider.kind === "local").map(provider => provider.id)]);
}

export function homeSourceIds(item: VaultItem, providers: readonly ProviderAccount[]): string[] {
  return sourceIds(item, localSourceIds(providers));
}

export function matchesHomeSource(item: VaultItem, sourceId: string, providers: readonly ProviderAccount[]): boolean {
  return sourceId === "all" || homeSourceIds(item, providers).includes(sourceId);
}

export function itemHomeFolders(item: VaultItem, providers: readonly ProviderAccount[]): HomeFolderRef[] {
  return foldersForSources(item, homeSourceIds(item, providers));
}

function foldersForSources(item: VaultItem, sources: readonly string[]): HomeFolderRef[] {
  return sources.map(sourceId => {
    if (item.keepassGroupUuid || item.keepassGroupPath) return { sourceId, type: "keepass", value: item.keepassGroupUuid || item.keepassGroupPath!, label: item.keepassGroupPath || "" };
    if (item.mdbxFolderId) return { sourceId, type: "mdbx", value: item.mdbxFolderId, label: item.categoryName?.trim() || "" };
    const remoteFolder = item.providerRefs.find(ref => ref.providerId === sourceId)?.remoteFolderId;
    if (remoteFolder) return { sourceId, type: "remote", value: remoteFolder, label: item.categoryName?.trim() || "" };
    const label = item.categoryName?.trim();
    if (label || item.categoryId !== undefined) return { sourceId, type: "category", value: item.categoryId === undefined ? `name:${label}` : `id:${item.categoryId}`, label: label || "" };
    return { sourceId, type: "uncategorized", value: "none", label: "" };
  });
}

export function homeFolderKey(folder: HomeFolderRef): string {
  return JSON.stringify([folder.sourceId, folder.type, folder.value]);
}

export function matchesHomeFolder(item: VaultItem, folder: HomeFolderRef, providers: readonly ProviderAccount[]): boolean {
  const key = homeFolderKey(folder);
  return itemHomeFolders(item, providers).some(candidate => homeFolderKey(candidate) === key);
}

/** One pass over the visible scope. Counts never merge equal folder IDs from different sources. */
export function buildHomeCatalog(items: readonly VaultItem[], providers: readonly ProviderAccount[], sourceId = "all") {
  const scoped: VaultItem[] = [];
  const favorites: VaultItem[] = [];
  const kinds = new Map<VaultItemKind, number>();
  const folders = new Map<string, HomeFolder>();
  const sourceCounts = new Map<string, number>();
  const localIds = localSourceIds(providers);
  for (const item of items) {
    if (item.deletedAt || item.archivedAt) continue;
    const sources = sourceIds(item, localIds);
    for (const id of sources) sourceCounts.set(id, (sourceCounts.get(id) || 0) + 1);
    if (sourceId !== "all" && !sources.includes(sourceId)) continue;
    scoped.push(item);
    if (item.favorite) favorites.push(item);
    kinds.set(item.kind, (kinds.get(item.kind) || 0) + 1);
    for (const folder of foldersForSources(item, sources)) {
      if (sourceId !== "all" && folder.sourceId !== sourceId) continue;
      const key = homeFolderKey(folder);
      const entry = folders.get(key);
      if (entry) entry.count++;
      else folders.set(key, { ...folder, key, count: 1 });
    }
  }
  return { items: scoped, favorites, kinds, folders: [...folders.values()].sort((a, b) => a.label.localeCompare(b.label) || a.sourceId.localeCompare(b.sourceId)), sourceCounts };
}

/** A small, deterministic recommendation set; this is not a usage-history ranking. */
export function suggestedHomeItems(items: readonly VaultItem[], limit = 6): VaultItem[] {
  const result: VaultItem[] = [];
  const compare = (a: VaultItem, b: VaultItem) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  for (const item of items) {
    const before = result.findIndex(candidate => compare(item, candidate) < 0);
    if (before >= 0) result.splice(before, 0, item);
    else if (result.length < limit) result.push(item);
    if (result.length > limit) result.pop();
  }
  return result;
}
