import * as kdbxweb from "kdbxweb";
import { isKeePassFieldProtected, keePassFieldText, readKeePassCustomFields } from "./keepass-login-codec";
import { readProjectCredential } from '../../core/project-credentials';

export type KeePassRebaseConflictKind =
  | "field"
  | "attachment"
  | "history"
  | "entry-structure"
  | "entry-metadata"
  | "group-structure"
  | "password-project";

export interface KeePassRebaseConflict {
  kind: KeePassRebaseConflictKind;
  projectId?: string;
  entryUuid?: string;
  groupUuid?: string;
  fieldNames?: string[];
  reason: string;
}

export class KeePassRemoteRebaseConflictError extends Error {
  readonly code = "keepass-rebase-conflict" as const;

  constructor(readonly conflicts: KeePassRebaseConflict[]) {
    super(buildConflictMessage(conflicts));
    this.name = "KeePassRemoteRebaseConflictError";
  }
}

export interface KeePassRemoteRebaseResult {
  database: kdbxweb.Kdbx;
  changed: boolean;
}

interface EntryLocation {
  entry: kdbxweb.KdbxEntry;
  parentUuid: string;
}

interface GroupLocation {
  group: kdbxweb.KdbxGroup;
  parentUuid?: string;
}

interface FieldState {
  name: string;
  present: boolean;
  value?: string;
  protected?: boolean;
}

export interface KeePassProjectConflictSide {
  entryUuids: string[];
  addedEntryUuids: string[];
  removedEntryUuids: string[];
  modifiedEntryUuids: string[];
  activeCount: number;
  trashCount: number;
}

export interface KeePassProjectConflictPreview {
  projectId: string;
  baseEntryUuids: string[];
  local: KeePassProjectConflictSide;
  remote: KeePassProjectConflictSide;
}

export interface KeePassProjectConflictChoice { projectId: string; choice: 'local' | 'remote' }

/** Apply explicit project decisions to disposable decoded snapshots only.
 * Callers must retain the original encrypted files before committing the result.
 * Base and remote are scratch databases; working remains unchanged.
 */
export function resolveKeePassProjectConflicts(base: kdbxweb.Kdbx, working: kdbxweb.Kdbx, remote: kdbxweb.Kdbx,
  choices: KeePassProjectConflictChoice[]): KeePassRemoteRebaseResult {
  const previews = previewKeePassProjectConflicts(base, working, remote);
  const unresolved = new Set(previews.map(row => row.projectId));
  if (!Array.isArray(choices) || !choices.length || choices.length !== unresolved.size) throw new Error('请逐项确认当前密码项目冲突。');
  for (const row of choices) {
    if (!row || !['local', 'remote'].includes(row.choice) || !unresolved.delete(row.projectId)) throw new Error('密码项目冲突选择已失效。');
  }
  const selected = new Set(choices.map(row => row.projectId));
  const assignments = new Map<string, Set<string | undefined>>();
  for (const database of [base, working, remote]) for (const [uuid, { entry }] of collectEntries(database)) {
    const ids = assignments.get(uuid) || new Set<string | undefined>();
    ids.add(readProjectCredential(readKeePassCustomFields(entry.fields))?.projectId); assignments.set(uuid, ids);
  }
  for (const ids of assignments.values()) if (ids.size > 1 && [...ids].some(id => id && selected.has(id)))
    throw new Error('冲突条目的项目归属已变化，请先核对凭据标识。');
  if (![working, remote].every(database => database.getDefaultGroup().uuid.equals(base.getDefaultGroup().uuid)))
    throw new Error('冲突数据库根标识不一致。');

  for (const row of choices) {
    // Making the selected project equal to working in the scratch baseline
    // suppresses its ordinary field merge while leaving unrelated changes intact.
    replaceProjectSnapshot(base, working, row.projectId);
    if (row.choice === 'local') replaceProjectSnapshot(remote, working, row.projectId);
  }
  const result = rebaseKeePassDatabase(base, working, remote);
  return { ...result, changed: result.changed || choices.some(row => row.choice === 'local') };
}

function replaceProjectSnapshot(target: kdbxweb.Kdbx, source: kdbxweb.Kdbx, projectId: string): void {
  const belongs = (entry: kdbxweb.KdbxEntry) => readProjectCredential(readKeePassCustomFields(entry.fields))?.projectId === projectId;
  const rows = [...collectEntries(source).values()].filter(row => belongs(row.entry));
  const retained = new Set(rows.map(row => row.entry.uuid.toString()));
  const copyIcon = (uuid: kdbxweb.KdbxUuid | undefined) => {
    if (!uuid) return;
    const icon = source.meta.customIcons.get(uuid.toString());
    if (!icon) throw new Error('冲突项目引用的图标不存在。');
    const existing = target.meta.customIcons.get(uuid.toString());
    if (existing && (existing.data.byteLength !== icon.data.byteLength || new Uint8Array(existing.data).some((byte, i) => byte !== new Uint8Array(icon.data)[i])))
      throw new Error('冲突项目的共享图标内容不一致。');
    if (!existing) target.meta.customIcons.set(uuid.toString(), { ...icon, data: icon.data.slice(0), lastModified: icon.lastModified && new Date(icon.lastModified) });
  };
  const ensureParent = (group: kdbxweb.KdbxGroup): kdbxweb.KdbxGroup => {
    const existing = target.getGroup(group.uuid);
    if (existing) return existing;
    if (!group.parentGroup) throw new Error('冲突项目的父分组不存在。');
    const parent = ensureParent(group.parentGroup);
    copyIcon(group.customIcon);
    const created = target.createGroup(parent, group.name || '未命名分组');
    created.uuid = group.uuid; copyGroupMetadata(created, group);
    if (group.uuid.equals(source.meta.recycleBinUuid)) {
      if (target.meta.recycleBinUuid && target.getGroup(target.meta.recycleBinUuid) && !target.meta.recycleBinUuid.equals(group.uuid))
        throw new Error('冲突数据库的回收站标识不一致。');
      target.meta.recycleBinUuid = group.uuid; target.meta.recycleBinEnabled = source.meta.recycleBinEnabled;
    }
    return created;
  };
  // Validate and copy all referenced resources before replacing any entry.
  for (const row of rows) {
    ensureParent(row.entry.parentGroup!);
    for (const entry of [row.entry, ...row.entry.history]) copyIcon(entry.customIcon);
  }
  for (const { entry } of collectEntries(target).values()) if (belongs(entry)) {
    if (!retained.has(entry.uuid.toString())) target.move(entry, null);
    else entry.parentGroup!.entries.splice(entry.parentGroup!.entries.indexOf(entry), 1);
  }
  target.deletedObjects = target.deletedObjects.filter(row => !row.uuid || !retained.has(row.uuid.toString()));
  for (const row of rows) insertEntry(target, ensureParent(row.entry.parentGroup!), row.entry, source);
}

/** Read-only identity/size summary. No password, note, attachment bytes or raw
 * field signatures may leave this boundary. File revision binding is supplied
 * by the remote session before a future resolution is committed.
 */
export function previewKeePassProjectConflicts(base: kdbxweb.Kdbx, local: kdbxweb.Kdbx, remote: kdbxweb.Kdbx): KeePassProjectConflictPreview[] {
  const before = collectEntries(base), working = collectEntries(local), latest = collectEntries(remote);
  const conflicts = concurrentPasswordProjectChanges(before, working, latest, base, local, remote);
  const members = (entries: Map<string, EntryLocation>, id: string) => new Map([...entries].filter(([, row]) =>
    readProjectCredential(readKeePassCustomFields(row.entry.fields))?.projectId === id));
  return conflicts.map(conflict => {
    const projectId = conflict.projectId!, original = members(before, projectId);
    const side = (entries: Map<string, EntryLocation>, database: kdbxweb.Kdbx): KeePassProjectConflictSide => {
      const current = members(entries, projectId), ids = [...current.keys()].sort();
      let trashCount = 0;
      for (const { entry } of current.values()) {
        for (let parent = entry.parentGroup; parent; parent = parent.parentGroup) {
          if (parent.uuid.equals(database.meta.recycleBinUuid)) { trashCount++; break; }
        }
      }
      return { entryUuids: ids, addedEntryUuids: ids.filter(id => !original.has(id)),
        removedEntryUuids: [...original.keys()].filter(id => !current.has(id)).sort(),
        modifiedEntryUuids: ids.filter(id => {
          const old = original.get(id), now = current.get(id)!;
          return !!old && entryFullSignature(old.entry, base, old.parentUuid) !== entryFullSignature(now.entry, database, now.parentUuid);
        }), activeCount: ids.length - trashCount, trashCount };
    };
    return { projectId, baseEntryUuids: [...original.keys()].sort(), local: side(working, local), remote: side(latest, remote) };
  });
}

/**
 * Applies the browser working copy on top of the newest remote KDBX using the same three-way
 * decision used by Android's KeePassChangeSetApplier. The base and working databases are never
 * mutated. A conflict is reported with field/category names only; values never enter an error.
 */
export function rebaseKeePassDatabase(
  baseDatabase: kdbxweb.Kdbx,
  workingDatabase: kdbxweb.Kdbx,
  remoteDatabase: kdbxweb.Kdbx
): KeePassRemoteRebaseResult {
  const baseGroups = collectGroups(baseDatabase);
  const workingGroups = collectGroups(workingDatabase);
  const remoteGroups = collectGroups(remoteDatabase);
  const baseEntries = collectEntries(baseDatabase);
  const workingEntries = collectEntries(workingDatabase);
  let remoteEntries = collectEntries(remoteDatabase);
  // A multi-password project is one edit unit. Three-way field merging across
  // different members could otherwise combine incompatible shared credentials,
  // membership or deletion decisions despite having no same-field conflict.
  const projectConflicts = concurrentPasswordProjectChanges(baseEntries, workingEntries, remoteEntries,
    baseDatabase, workingDatabase, remoteDatabase);
  if (projectConflicts.length) throw new KeePassRemoteRebaseConflictError(projectConflicts);
  const conflicts: KeePassRebaseConflict[] = [];
  let changed = false;

  const allGroupIds = new Set([...baseGroups.keys(), ...workingGroups.keys()]);
  for (const groupUuid of allGroupIds) {
    if (groupUuid === baseDatabase.getDefaultGroup().uuid.toString()) continue;
    const base = baseGroups.get(groupUuid);
    const working = workingGroups.get(groupUuid);
    const remote = remoteGroups.get(groupUuid);

    if (!base && working) {
      if (!remote) {
        const parent = working.parentUuid ? remoteDatabase.getGroup(working.parentUuid) : undefined;
        if (!parent) {
          conflicts.push({ kind: "group-structure", groupUuid, reason: "新建分组的父分组不存在。" });
        } else {
          insertGroupTree(remoteDatabase, parent, working.group, workingDatabase);
          changed = true;
        }
      } else if (groupTreeSignature(working.group, workingDatabase) !== groupTreeSignature(remote.group, remoteDatabase)) {
        conflicts.push({ kind: "group-structure", groupUuid, reason: "新建分组与远端同标识分组内容不同。" });
      } else {
      }
      continue;
    }

    if (base && !working) {
      if (!remote) {
      } else if (groupTreeSignature(base.group, baseDatabase) === groupTreeSignature(remote.group, remoteDatabase)) {
        removeGroupTree(remoteDatabase, remote.group);
        changed = true;
      } else {
        conflicts.push({ kind: "group-structure", groupUuid, reason: "本地删除分组时远端分组也发生了变化。" });
      }
      continue;
    }

    if (!base || !working) continue;
    if (!remote) {
      if (groupTreeSignature(base.group, baseDatabase) !== groupTreeSignature(working.group, workingDatabase)) {
        conflicts.push({ kind: "group-structure", groupUuid, reason: "远端分组已删除，但本地仍有结构修改。" });
      }
      continue;
    }

    const localParent = working.parentUuid;
    const baseParent = base.parentUuid;
    const remoteParent = remote.parentUuid;
    if (localParent !== baseParent) {
      if (remoteParent === baseParent) {
        const target = localParent ? remoteDatabase.getGroup(localParent) : remoteDatabase.getDefaultGroup();
        if (!target) {
          conflicts.push({ kind: "group-structure", groupUuid, reason: "本地分组移动目标不存在。" });
        } else {
          remoteDatabase.move(remote.group, target);
          changed = true;
        }
      } else if (remoteParent !== localParent) {
        conflicts.push({ kind: "group-structure", groupUuid, reason: "本地和远端分组移动目标不同。" });
      }
    }

    if (localParent !== baseParent || groupMetadataSignature(working.group) !== groupMetadataSignature(base.group)) {
      const remoteStructureChanged = remoteParent !== baseParent;
      const remoteMetadataChanged = groupMetadataSignature(remote.group) !== groupMetadataSignature(base.group);
      if (remoteStructureChanged && localParent !== baseParent && remoteParent !== localParent) {
        // The structural conflict was already recorded above; avoid duplicating it.
      } else if (remoteMetadataChanged && groupMetadataSignature(remote.group) !== groupMetadataSignature(working.group)) {
        conflicts.push({ kind: "group-structure", groupUuid, reason: "本地和远端分组元数据均发生了不同修改。" });
      } else if (!remoteMetadataChanged) {
        copyGroupMetadata(remote.group, working.group);
        changed = true;
      }
    }
  }

  // Group creation can include entries that were moved from an existing base group. Refresh the
  // remote index after group operations and let the entry pass decide whether each UUID is a move,
  // a create, or a structural conflict.
  remoteEntries = collectEntries(remoteDatabase);

  const allEntryIds = new Set([...baseEntries.keys(), ...workingEntries.keys()]);
  for (const entryUuid of allEntryIds) {
    const base = baseEntries.get(entryUuid);
    const working = workingEntries.get(entryUuid);
    const remote = remoteEntries.get(entryUuid);
    if (!base && working) {
      if (!remote) {
        const target = remoteDatabase.getGroup(working.parentUuid);
        if (!target) {
          conflicts.push({ kind: "entry-structure", entryUuid, reason: "新建条目的父分组不存在。" });
        } else {
          insertEntry(remoteDatabase, target, working.entry, workingDatabase);
          changed = true;
        }
      } else if (entryFullSignature(working.entry, workingDatabase, working.parentUuid) !== entryFullSignature(remote.entry, remoteDatabase, remote.parentUuid)) {
        conflicts.push({ kind: "entry-structure", entryUuid, reason: "新建条目与远端同标识条目不同。" });
      }
      continue;
    }

    if (base && !working) {
      if (!remote) continue;
      if (entryFullSignature(base.entry, baseDatabase, base.parentUuid) === entryFullSignature(remote.entry, remoteDatabase, remote.parentUuid)) {
        remoteDatabase.remove(remote.entry);
        changed = true;
      } else {
        conflicts.push({ kind: "entry-structure", entryUuid, reason: "本地删除条目时远端条目也发生了变化。" });
      }
      continue;
    }

    if (!base || !working) continue;
    if (!remote) {
      if (entryFullSignature(base.entry, baseDatabase, base.parentUuid) !== entryFullSignature(working.entry, workingDatabase, working.parentUuid)) {
        conflicts.push({ kind: "entry-structure", entryUuid, reason: "远端条目已删除，但本地仍有修改。" });
      }
      continue;
    }

    if (working.parentUuid !== base.parentUuid) {
      if (remote.parentUuid === base.parentUuid) {
        const target = remoteDatabase.getGroup(working.parentUuid);
        if (!target) conflicts.push({ kind: "entry-structure", entryUuid, reason: "本地条目移动目标不存在。" });
        else {
          remoteDatabase.move(remote.entry, target);
          changed = true;
        }
      } else if (remote.parentUuid !== working.parentUuid) {
        conflicts.push({ kind: "entry-structure", entryUuid, reason: "本地和远端条目移动目标不同。" });
      }
    }

    const fieldConflicts = mergeFields(base.entry, working.entry, remote.entry);
    if (fieldConflicts.length) conflicts.push({ kind: "field", entryUuid, fieldNames: fieldConflicts, reason: "本地和远端修改了相同字段。" });
    else if (fieldSignature(base.entry) !== fieldSignature(working.entry)) changed = true;

    const binaryConflict = mergeBinaries(base.entry, working.entry, remote.entry, baseDatabase, workingDatabase, remoteDatabase);
    if (binaryConflict.length) conflicts.push({ kind: "attachment", entryUuid, fieldNames: binaryConflict, reason: "本地和远端修改了相同附件。" });
    else if (binarySignature(base.entry, baseDatabase) !== binarySignature(working.entry, workingDatabase)) changed = true;

    const baseHistory = historySignature(base.entry, baseDatabase);
    const workingHistory = historySignature(working.entry, workingDatabase);
    const remoteHistory = historySignature(remote.entry, remoteDatabase);
    if (workingHistory !== baseHistory) {
      if (remoteHistory === baseHistory) {
        remote.entry.history = working.entry.history.map((entry) => cloneDetachedEntry(entry, workingDatabase, remoteDatabase));
        changed = true;
      } else if (remoteHistory !== workingHistory) {
        conflicts.push({ kind: "history", entryUuid, reason: "本地和远端历史记录均发生了不同修改。" });
      }
    }

    const baseMetadata = entryMetadataSignature(base.entry);
    const workingMetadata = entryMetadataSignature(working.entry);
    const remoteMetadata = entryMetadataSignature(remote.entry);
    if (workingMetadata !== baseMetadata) {
      if (remoteMetadata === baseMetadata) {
        copyEntryMetadata(remote.entry, working.entry);
        changed = true;
      } else if (remoteMetadata !== workingMetadata) {
        conflicts.push({ kind: "entry-metadata", entryUuid, reason: "本地和远端条目元数据均发生了不同修改。" });
      }
    }
  }

  if (conflicts.length) throw new KeePassRemoteRebaseConflictError(deduplicateConflicts(conflicts));
  return { database: remoteDatabase, changed };
}

function concurrentPasswordProjectChanges(
  base: Map<string, EntryLocation>, working: Map<string, EntryLocation>, remote: Map<string, EntryLocation>,
  baseDatabase: kdbxweb.Kdbx, workingDatabase: kdbxweb.Kdbx, remoteDatabase: kdbxweb.Kdbx
): KeePassRebaseConflict[] {
  const projects = (entries: Map<string, EntryLocation>, database: kdbxweb.Kdbx) => {
    const result = new Map<string, Array<[string, string]>>();
    for (const [uuid, location] of entries) {
      const id = readProjectCredential(readKeePassCustomFields(location.entry.fields))?.projectId;
      if (!id) continue;
      const rows = result.get(id) || [];
      rows.push([uuid, entryFullSignature(location.entry, database, location.parentUuid)]); result.set(id, rows);
    }
    return new Map([...result].map(([id, rows]) => [id, JSON.stringify(rows.sort(([a], [b]) => a.localeCompare(b)))]));
  };
  const before = projects(base, baseDatabase), local = projects(working, workingDatabase), latest = projects(remote, remoteDatabase);
  const conflicts: KeePassRebaseConflict[] = [];
  for (const id of new Set([...before.keys(), ...local.keys(), ...latest.keys()])) {
    if (local.get(id) !== before.get(id) && latest.get(id) !== before.get(id) && local.get(id) !== latest.get(id)) {
      conflicts.push({ kind: 'password-project', projectId: id, reason: '同一密码项目在两端均有修改，请核对整组密码后再同步。' });
    }
  }
  return conflicts;
}

function collectGroups(database: kdbxweb.Kdbx): Map<string, GroupLocation> {
  const result = new Map<string, GroupLocation>();
  for (const group of database.getDefaultGroup().allGroups()) {
    result.set(group.uuid.toString(), { group, parentUuid: group.parentGroup?.uuid.toString() });
  }
  return result;
}

function collectEntries(database: kdbxweb.Kdbx): Map<string, EntryLocation> {
  const result = new Map<string, EntryLocation>();
  for (const group of database.getDefaultGroup().allGroups()) {
    for (const entry of group.entries) result.set(entry.uuid.toString(), { entry, parentUuid: group.uuid.toString() });
  }
  return result;
}

function fieldSignature(entry: kdbxweb.KdbxEntry): string {
  return JSON.stringify([...entry.fields.entries()].map(([name, value]) => [name, keePassFieldText(value), isKeePassFieldProtected(value)]));
}

function fieldMap(entry: kdbxweb.KdbxEntry): Map<string, FieldState> {
  const result = new Map<string, FieldState>();
  for (const [name, value] of entry.fields) {
    const key = normalizeFieldName(name);
    if (!result.has(key)) result.set(key, { name, present: true, value: keePassFieldText(value), protected: isKeePassFieldProtected(value) });
  }
  return result;
}

function mergeFields(base: kdbxweb.KdbxEntry, working: kdbxweb.KdbxEntry, remote: kdbxweb.KdbxEntry): string[] {
  const b = fieldMap(base);
  const w = fieldMap(working);
  const r = fieldMap(remote);
  const conflicts: string[] = [];
  const keys = new Set([...b.keys(), ...w.keys()]);
  for (const key of keys) {
    const baseState = b.get(key) || missingField(key);
    const workingState = w.get(key) || missingField(key);
    const remoteState = r.get(key) || missingField(key);
    if (sameField(workingState, baseState)) continue;
    if (!sameField(remoteState, baseState)) {
      if (sameField(remoteState, workingState)) continue;
      conflicts.push(displayFieldName(workingState, baseState, remoteState));
      continue;
    }
    for (const [name] of [...remote.fields]) if (normalizeFieldName(name) === key) remote.fields.delete(name);
    if (workingState.present) {
      remote.fields.set(workingState.name, workingState.protected
        ? kdbxweb.ProtectedValue.fromString(workingState.value || "")
        : workingState.value || "");
    }
  }
  return [...new Set(conflicts)].slice(0, 64);
}

function binarySignature(entry: kdbxweb.KdbxEntry, database: kdbxweb.Kdbx): string {
  return JSON.stringify([...entry.binaries.entries()].map(([name, value]) => [name, binaryHash(value, database)]));
}

function binaryMap(entry: kdbxweb.KdbxEntry, database: kdbxweb.Kdbx): Map<string, string | undefined> {
  return new Map([...entry.binaries.entries()].map(([name, value]) => [name, binaryHash(value, database)]));
}

function mergeBinaries(
  base: kdbxweb.KdbxEntry,
  working: kdbxweb.KdbxEntry,
  remote: kdbxweb.KdbxEntry,
  baseDatabase: kdbxweb.Kdbx,
  workingDatabase: kdbxweb.Kdbx,
  remoteDatabase: kdbxweb.Kdbx
): string[] {
  const b = binaryMap(base, baseDatabase);
  const w = binaryMap(working, workingDatabase);
  const r = binaryMap(remote, remoteDatabase);
  const conflicts: string[] = [];
  for (const name of new Set([...b.keys(), ...w.keys()])) {
    const baseValue = b.get(name);
    const workingValue = w.get(name);
    const remoteValue = r.get(name);
    if (workingValue === baseValue) continue;
    if (remoteValue !== baseValue) {
      if (remoteValue === workingValue) continue;
      conflicts.push(name);
      continue;
    }
    if (workingValue === undefined) remote.binaries.delete(name);
    else {
      const value = working.binaries.get(name);
      if (value) remote.binaries.set(name, cloneBinaryValue(value, workingDatabase, remoteDatabase));
    }
  }
  return [...new Set(conflicts)].slice(0, 64);
}

function binaryHash(value: unknown, database: kdbxweb.Kdbx): string | undefined {
  if (value && typeof value === "object" && "hash" in value && typeof (value as { hash?: unknown }).hash === "string") return (value as { hash: string }).hash;
  if (value && typeof value === "object" && "ref" in value && typeof (value as { ref?: unknown }).ref === "string") {
    return database.binaries.getByRef(value as { ref: string })?.hash;
  }
  return undefined;
}

function historySignature(entry: kdbxweb.KdbxEntry, database: kdbxweb.Kdbx): string {
  return JSON.stringify(entry.history.map((history) => entryFullSignature(history, database, "")));
}

function entryMetadataSignature(entry: kdbxweb.KdbxEntry): string {
  return JSON.stringify({
    icon: entry.icon,
    customIcon: entry.customIcon?.toString(),
    fgColor: entry.fgColor,
    bgColor: entry.bgColor,
    overrideUrl: entry.overrideUrl,
    tags: entry.tags,
    autoType: entry.autoType,
    previousParentGroup: entry.previousParentGroup?.toString(),
    qualityCheck: entry.qualityCheck,
    customData: customDataSignature(entry.customData)
  });
}

function groupMetadataSignature(group: kdbxweb.KdbxGroup): string {
  return JSON.stringify({
    name: group.name,
    notes: group.notes,
    icon: group.icon,
    customIcon: group.customIcon?.toString(),
    tags: group.tags,
    expanded: group.expanded,
    defaultAutoTypeSeq: group.defaultAutoTypeSeq,
    enableAutoType: group.enableAutoType,
    enableSearching: group.enableSearching,
    lastTopVisibleEntry: group.lastTopVisibleEntry?.toString(),
    previousParentGroup: group.previousParentGroup?.toString(),
    customData: customDataSignature(group.customData)
  });
}

function groupTreeSignature(group: kdbxweb.KdbxGroup, database: kdbxweb.Kdbx): string {
  return JSON.stringify({
    uuid: group.uuid.toString(),
    parent: group.parentGroup?.uuid.toString(),
    metadata: groupMetadataSignature(group),
    groups: group.groups.map((child) => groupTreeSignature(child, database)),
    entries: group.entries.map((entry) => entryFullSignature(entry, database, group.uuid.toString()))
  });
}

function entryFullSignature(entry: kdbxweb.KdbxEntry, database: kdbxweb.Kdbx, parentUuid: string): string {
  return JSON.stringify({
    uuid: entry.uuid.toString(),
    parentUuid,
    fields: fieldSignature(entry),
    binaries: binarySignature(entry, database),
    history: historySignature(entry, database),
    metadata: entryMetadataSignature(entry)
  });
}

function copyGroupMetadata(target: kdbxweb.KdbxGroup, source: kdbxweb.KdbxGroup): void {
  target.name = source.name;
  target.notes = source.notes;
  target.icon = source.icon;
  target.customIcon = source.customIcon;
  target.tags = [...source.tags];
  target.expanded = source.expanded;
  target.defaultAutoTypeSeq = source.defaultAutoTypeSeq;
  target.enableAutoType = source.enableAutoType;
  target.enableSearching = source.enableSearching;
  target.lastTopVisibleEntry = source.lastTopVisibleEntry;
  target.previousParentGroup = source.previousParentGroup;
  target.customData = cloneCustomData(source.customData);
  target.times = source.times.clone();
}

function copyEntryMetadata(target: kdbxweb.KdbxEntry, source: kdbxweb.KdbxEntry): void {
  target.icon = source.icon;
  target.customIcon = source.customIcon;
  target.fgColor = source.fgColor;
  target.bgColor = source.bgColor;
  target.overrideUrl = source.overrideUrl;
  target.tags = [...source.tags];
  target.autoType = JSON.parse(JSON.stringify(source.autoType));
  target.previousParentGroup = source.previousParentGroup;
  target.qualityCheck = source.qualityCheck;
  target.customData = cloneCustomData(source.customData);
  target.times = source.times.clone();
}

function customDataSignature(data: kdbxweb.KdbxCustomDataMap | undefined): unknown {
  if (!data) return undefined;
  return [...data.entries()].map(([key, value]) => [key, value.value ?? "", value.lastModified?.getTime()]);
}

function cloneCustomData(data: kdbxweb.KdbxCustomDataMap | undefined): kdbxweb.KdbxCustomDataMap | undefined {
  if (!data) return undefined;
  const result = new Map<string, { value: string; lastModified?: Date }>();
  for (const [key, value] of data) result.set(key, { value: value.value ?? "", lastModified: value.lastModified ? new Date(value.lastModified) : undefined });
  return result as kdbxweb.KdbxCustomDataMap;
}

function insertGroupTree(database: kdbxweb.Kdbx, parent: kdbxweb.KdbxGroup, source: kdbxweb.KdbxGroup, sourceDatabase: kdbxweb.Kdbx): kdbxweb.KdbxGroup {
  const target = database.createGroup(parent, source.name || "未命名分组");
  target.uuid = source.uuid;
  copyGroupMetadata(target, source);
  target.groups = [];
  target.entries = [];
  for (const child of source.groups) insertGroupTree(database, target, child, sourceDatabase);
  const existingEntryIds = new Set([...database.getDefaultGroup().allEntries()].map((entry) => entry.uuid.toString()));
  for (const entry of source.entries) if (!existingEntryIds.has(entry.uuid.toString())) insertEntry(database, target, entry, sourceDatabase);
  return target;
}

function insertEntry(database: kdbxweb.Kdbx, parent: kdbxweb.KdbxGroup, source: kdbxweb.KdbxEntry, sourceDatabase: kdbxweb.Kdbx): kdbxweb.KdbxEntry {
  const target = database.createEntry(parent);
  target.uuid = source.uuid;
  copyEntryMetadata(target, source);
  target.fields.clear();
  for (const [name, value] of source.fields) target.fields.set(name, cloneFieldValue(value));
  target.binaries.clear();
  for (const [name, value] of source.binaries) target.binaries.set(name, cloneBinaryValue(value, sourceDatabase, database));
  target.history = source.history.map((entry) => cloneDetachedEntry(entry, sourceDatabase, database));
  return target;
}

function cloneDetachedEntry(source: kdbxweb.KdbxEntry, sourceDatabase: kdbxweb.Kdbx, targetDatabase: kdbxweb.Kdbx): kdbxweb.KdbxEntry {
  const target = new kdbxweb.KdbxEntry();
  target.uuid = source.uuid;
  copyEntryMetadata(target, source);
  target.fields.clear();
  for (const [name, value] of source.fields) target.fields.set(name, cloneFieldValue(value));
  target.binaries.clear();
  for (const [name, value] of source.binaries) target.binaries.set(name, cloneBinaryValue(value, sourceDatabase, targetDatabase));
  target.history = source.history.map((entry) => cloneDetachedEntry(entry, sourceDatabase, targetDatabase));
  return target;
}

function cloneFieldValue(value: string | kdbxweb.ProtectedValue): string | kdbxweb.ProtectedValue {
  return value instanceof kdbxweb.ProtectedValue ? value.clone() : value;
}

function cloneBinaryValue(value: unknown, sourceDatabase: kdbxweb.Kdbx, targetDatabase: kdbxweb.Kdbx): kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash {
  const resolved = value && typeof value === "object" && "ref" in value
    ? sourceDatabase.binaries.getByRef(value as { ref: string })
    : value as kdbxweb.KdbxBinaryWithHash | undefined;
  if (resolved && "hash" in resolved && "value" in resolved) {
    const existing = targetDatabase.binaries.getValueByHash(resolved.hash);
    if (!existing) targetDatabase.binaries.addWithHash({ hash: resolved.hash, value: cloneBinaryPayload(resolved.value) });
    return { hash: resolved.hash, value: targetDatabase.binaries.getValueByHash(resolved.hash) || cloneBinaryPayload(resolved.value) };
  }
  return cloneBinaryPayload(value as kdbxweb.KdbxBinary);
}

function cloneBinaryPayload(value: kdbxweb.KdbxBinary): kdbxweb.KdbxBinary {
  if (value instanceof kdbxweb.ProtectedValue) return value.clone();
  return value.slice(0);
}

function removeGroupTree(database: kdbxweb.Kdbx, group: kdbxweb.KdbxGroup): void {
  database.remove(group);
}

function normalizeFieldName(name: string): string {
  return name.trim().toLocaleLowerCase("en-US");
}

function missingField(name: string): FieldState {
  return { name, present: false };
}

function sameField(left: FieldState, right: FieldState): boolean {
  return left.present === right.present && (!left.present || (left.value === right.value && left.protected === right.protected));
}

function displayFieldName(...states: FieldState[]): string {
  return states.find((state) => state.present)?.name || states[0].name;
}

function deduplicateConflicts(conflicts: KeePassRebaseConflict[]): KeePassRebaseConflict[] {
  const result: KeePassRebaseConflict[] = [];
  const seen = new Set<string>();
  for (const conflict of conflicts) {
    const key = JSON.stringify([conflict.kind, conflict.entryUuid, conflict.groupUuid, conflict.fieldNames, conflict.reason]);
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ ...conflict, fieldNames: conflict.fieldNames ? [...new Set(conflict.fieldNames)] : undefined });
    }
  }
  return result.slice(0, 100);
}

function buildConflictMessage(conflicts: KeePassRebaseConflict[]): string {
  const fields = conflicts.filter((conflict) => conflict.kind === "field").flatMap((conflict) => conflict.fieldNames || []);
  const fieldPart = fields.length ? `字段：${[...new Set(fields)].slice(0, 8).join("、")}。` : "";
  const structureCount = conflicts.filter((conflict) => conflict.kind !== "field").length;
  return `KeePass 远端合并发生冲突。${fieldPart}${structureCount ? `结构冲突 ${structureCount} 项。` : ""}请先处理冲突后重试。`;
}
