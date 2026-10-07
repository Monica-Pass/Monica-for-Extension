import type { LoginItem, SecureNoteItem, VaultItem, VaultItemBase } from "./model";

type NoteScope = Pick<VaultItemBase, "providerRefs" | "mdbxDatabaseId" | "keepassDatabaseId">;
export function boundNoteScope(item: NoteScope): string {
  return JSON.stringify([[...new Set(item.providerRefs.map(ref => ref.providerId))].sort(), item.mdbxDatabaseId ?? null, item.keepassDatabaseId ?? null]);
}

/** Same logical ID rule as Android's secureItemObjectId, never a title lookup. */
export function boundNoteLogicalId(note: SecureNoteItem): string {
  return note.replicaGroupId?.startsWith("note:") ? note.replicaGroupId : `note:${note.id}`;
}

export function boundNoteCandidates(owner: NoteScope, items: readonly VaultItem[]): SecureNoteItem[] {
  const ownerScope = boundNoteScope(owner);
  const notes = items.filter((item): item is SecureNoteItem => item.kind === "secure-note" && !item.deletedAt && boundNoteScope(item) === ownerScope);
  const counts = new Map<string, number>();
  for (const note of notes) { const id = boundNoteLogicalId(note); counts.set(id, (counts.get(id) || 0) + 1); }
  return notes.filter(note => counts.get(boundNoteLogicalId(note)) === 1);
}

export function resolveBoundNote(owner: LoginItem, items: readonly VaultItem[]): SecureNoteItem | undefined {
  if (!owner.boundNoteEntryId) return undefined;
  return boundNoteCandidates(owner, items).find(note => boundNoteLogicalId(note) === owner.boundNoteEntryId);
}

/** Explicit user choice removes the old local Room projection; Android rebuilds it. */
export function applyBoundNoteChoice(owner: LoginItem, logicalId: string, items: readonly VaultItem[]): LoginItem {
  if (logicalId && !boundNoteCandidates(owner, items).some(note => boundNoteLogicalId(note) === logicalId)) {
    throw new Error("关联笔记不可用，请重新选择。");
  }
  return { ...owner, boundNoteEntryId: logicalId || undefined, boundNoteId: undefined };
}
