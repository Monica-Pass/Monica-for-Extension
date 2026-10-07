import type { VaultItem } from "../../core/model";
import { boundNoteLogicalId, boundNoteScope } from "../../core/bound-notes";
import { passwordGroupKey } from "../../core/password-groups";
import { ssoLogicalId } from "../../core/sso-links";

/** Direction controls selection expansion; connected components control failure isolation. */
export function mdbx2TransferDependencies(ids: readonly string[], items: readonly VaultItem[], action: "copy" | "move") {
  const byId = new Map(items.map(item => [item.id, item]));
  if (ids.some(id => !byId.has(id))) throw new Error("所选项目已变化，请刷新管理页后重试。");
  const edges = new Map(items.map(item => [item.id, new Set<string>()]));
  const connect = (from: string, to: string, both = true) => {
    edges.get(from)!.add(to);
    if (both) edges.get(to)!.add(from);
  };
  const groups = new Map<string, string>();
  for (const item of items) {
    if (item.deletedAt || item.kind !== "login") continue;
    if (item.passwordGroupId) {
      const key = passwordGroupKey(item), first = groups.get(key);
      if (first) connect(first, item.id); else groups.set(key, item.id);
    }
    const otp = item.boundTotpItemId ? byId.get(item.boundTotpItemId) : undefined;
    if (otp?.kind === "totp" && !otp.deletedAt && boundNoteScope(otp) === boundNoteScope(item)) connect(item.id, otp.id);
    if (item.boundNoteEntryId) {
      // Include every matching replica. The planner must reject ambiguity; choosing one
      // here could move a note out from under an unresolved source relationship.
      for (const note of items) {
        if (note.kind === "secure-note" && !note.deletedAt && boundNoteScope(note) === boundNoteScope(item)
          && boundNoteLogicalId(note) === item.boundNoteEntryId) connect(item.id, note.id, action === "move");
      }
    }
    if (item.ssoRefLogicalId) {
      for (const account of items) {
        if (account.kind === "login" && !account.deletedAt && boundNoteScope(account) === boundNoteScope(item)
          && ssoLogicalId(account) === item.ssoRefLogicalId) connect(item.id, account.id, action === "move");
      }
    }
  }
  const selected = new Set(ids), pending = [...selected];
  for (let index = 0; index < pending.length; index++) {
    for (const next of edges.get(pending[index])!) if (!selected.has(next)) { selected.add(next); pending.push(next); }
  }
  // Make selected dependency edges undirected for batch and failure boundaries.
  for (const id of selected) for (const other of edges.get(id)!) if (selected.has(other)) edges.get(other)!.add(id);
  const unseen = new Set(selected), components: string[][] = [];
  for (const first of selected) {
    if (!unseen.delete(first)) continue;
    const component = [first];
    for (let index = 0; index < component.length; index++) {
      for (const next of edges.get(component[index])!) if (unseen.delete(next)) component.push(next);
    }
    components.push(component);
  }
  return { selectedIds: items.filter(item => selected.has(item.id)).map(item => item.id), components };
}

/** Never send a surviving fragment of a related group after one member failed preparation. */
export function completeTransferComponents<T>(components: readonly string[][], work: readonly T[], id: (entry: T) => string) {
  const byId = new Map(work.map(entry => [id(entry), entry]));
  return components.map(component => ({
    ids: component,
    entries: component.flatMap(itemId => byId.has(itemId) ? [byId.get(itemId)!] : []),
    complete: component.every(itemId => byId.has(itemId)),
  }));
}
