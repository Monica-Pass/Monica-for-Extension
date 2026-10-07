import type { LoginItem, VaultItem } from "./model";
import { readProjectCredential } from "./project-credentials";

function orderMembers(items: LoginItem[]): LoginItem[] {
  const metadata = items.map(item => readProjectCredential(item.customFields));
  // Keep legacy/unknown/mixed groups stable. Metadata never establishes membership.
  const known = metadata.every(value => value !== undefined)
    && new Set(metadata.map(value => value?.passwordId)).size === items.length;
  const byId = new Map(items.map((item, index) => [item.id, metadata[index]]));
  return [...items].sort((a, b) => {
    const left = byId.get(a.id); const right = byId.get(b.id);
    const credentialOrder = known && left && right
      ? left.groupOrder - right.groupOrder || left.passwordOrder - right.passwordOrder : 0;
    return credentialOrder || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
      || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

/** The scope is the database, never title/account/URL or the storage folder. */
export function passwordGroupKey(item: LoginItem): string {
  if (!item.passwordGroupId) return `item:${item.id}`;
  const scope = item.providerRefs.map(ref => ref.providerId).sort().join("\u0000") || "local";
  return JSON.stringify([scope, item.mdbxDatabaseId ?? null, item.keepassDatabaseId ?? null, item.passwordGroupId]);
}
export function groupedPasswords(items: LoginItem[]): LoginItem[][] {
  const groups = new Map<string, LoginItem[]>();
  for (const item of items) {
    const key = passwordGroupKey(item); const group = groups.get(key) || [];
    group.push(item); groups.set(key, group);
  }
  return [...groups.values()].map(orderMembers);
}
export function passwordGroupMembers(item: LoginItem, items: VaultItem[]): LoginItem[] {
  return orderMembers(items.filter((candidate): candidate is LoginItem => candidate.kind === "login" && !candidate.deletedAt && passwordGroupKey(candidate) === passwordGroupKey(item)));
}
export function expandPasswordGroupSelection(ids: string[], items: VaultItem[]): string[] {
  const selected = new Set(ids); const keys = new Set(items.filter((item): item is LoginItem => selected.has(item.id) && item.kind === "login").map(passwordGroupKey));
  return items.filter(item => selected.has(item.id) || item.kind === "login" && !item.deletedAt && keys.has(passwordGroupKey(item))).map(item => item.id);
}
