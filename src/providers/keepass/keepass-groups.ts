import * as kdbxweb from "kdbxweb";
import { buildKeePassPathKey, decodeKeePassPathForDisplay } from "./keepass-path-codec";

export const KEEPASS_GROUP_MAX_PAGE_SIZE = 100;
export const KEEPASS_GROUP_MAX_NAME_BYTES = 1024;
export const KEEPASS_GROUP_MAX_DEPTH = 256;
export const KEEPASS_GROUP_MAX_COUNT = 100_000;

export interface KeePassGroupSummary {
  groupId: string;
  parentGroupId?: string;
  name: string;
  displayPath: string;
  depth: number;
  entryCount: number;
  childGroupCount: number;
  nameTruncated: boolean;
  displayPathTruncated: boolean;
  isRecycleBin: boolean;
  inRecycleBin: boolean;
  canRename: boolean;
  canMove: boolean;
  canDelete: boolean;
  canRestore: boolean;
}

export interface KeePassGroupPage {
  items: KeePassGroupSummary[];
  nextCursor?: string;
  rootName: string;
  recycleBinEnabled: boolean;
}

export interface KeePassGroupMutationResult {
  changed: boolean;
  group: KeePassGroupSummary;
}

export interface KeePassGroupRecord {
  uuid: string;
  parentUuid?: string;
  previousParentUuid?: string;
  name: string;
  path: string;
  displayPath: string;
  depth: number;
  entryCount: number;
  childGroupCount: number;
  isRecycleBin: boolean;
  inRecycleBin: boolean;
  canRestore: boolean;
}

export class KeePassGroupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KeePassGroupError";
  }
}

export function listKeePassGroupRecords(database: kdbxweb.Kdbx, includeRecycleBin: boolean): KeePassGroupRecord[] {
  const root = database.getDefaultGroup();
  const recycleBinUuid = activeRecycleBinUuid(database);
  const records: KeePassGroupRecord[] = [];
  const seen = new Set<string>();
  const stack = [...root.groups].reverse().map((group) => ({
    group,
    parentUuid: root.uuid.toString(),
    parentPath: "",
    depth: 0,
    parentInRecycleBin: false
  }));

  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > KEEPASS_GROUP_MAX_DEPTH) {
      throw new KeePassGroupError("keepass-group-depth-limit", "KeePass 分组层级超过当前浏览器支持的安全上限。");
    }
    const uuid = current.group.uuid.toString();
    if (seen.has(uuid)) throw new KeePassGroupError("keepass-group-duplicate-uuid", "KeePass 分组包含重复 UUID，无法安全管理。");
    seen.add(uuid);
    if (seen.size > KEEPASS_GROUP_MAX_COUNT) {
      throw new KeePassGroupError("keepass-group-count-limit", "KeePass 分组数量超过当前浏览器支持的安全上限。");
    }

    const isRecycleBin = recycleBinUuid !== undefined && uuid === recycleBinUuid;
    const inRecycleBin = current.parentInRecycleBin || isRecycleBin;
    const name = current.group.name?.trim() || "(未命名)";
    const path = buildKeePassPathKey(current.parentPath, name);
    if (includeRecycleBin || !inRecycleBin) {
      records.push({
        uuid,
        parentUuid: current.parentUuid,
        previousParentUuid: current.group.previousParentGroup?.toString(),
        name,
        path,
        displayPath: decodeKeePassPathForDisplay(path),
        depth: current.depth,
        entryCount: current.group.entries.length,
        childGroupCount: current.group.groups.length,
        isRecycleBin,
        inRecycleBin,
        canRestore: inRecycleBin && !isRecycleBin && current.parentUuid === recycleBinUuid
      });
    }

    if (!includeRecycleBin && inRecycleBin) continue;
    for (let index = current.group.groups.length - 1; index >= 0; index -= 1) {
      stack.push({
        group: current.group.groups[index],
        parentUuid: uuid,
        parentPath: path,
        depth: current.depth + 1,
        parentInRecycleBin: inRecycleBin
      });
    }
  }

  return records.sort((left, right) => compareText(left.displayPath, right.displayPath));
}

export function createKeePassGroup(
  database: kdbxweb.Kdbx,
  parentUuid: string | undefined,
  name: unknown
): { group: kdbxweb.KdbxGroup; changed: boolean } {
  const normalizedName = normalizeGroupName(name);
  const parent = requireActiveParent(database, parentUuid);
  const existing = siblingWithName(parent, normalizedName);
  if (existing) return { group: existing, changed: false };
  assertGroupCapacity(database);
  assertSubtreeDepthFits(database, parent, 0);
  return { group: database.createGroup(parent, normalizedName), changed: true };
}

export function renameKeePassGroup(database: kdbxweb.Kdbx, groupUuid: string, name: unknown): { group: kdbxweb.KdbxGroup; changed: boolean } {
  const normalizedName = normalizeGroupName(name);
  const group = requireMutableActiveGroup(database, groupUuid);
  const parent = group.parentGroup;
  if (!parent) throw new KeePassGroupError("keepass-group-root-protected", "KeePass 根分组不能重命名。");
  assertSiblingNameAvailable(parent, normalizedName, group.uuid.toString());
  if (group.name === normalizedName) return { group, changed: false };
  group.name = normalizedName;
  group.times.update();
  return { group, changed: true };
}

export function moveKeePassGroup(
  database: kdbxweb.Kdbx,
  groupUuid: string,
  targetParentUuid: string | undefined
): { group: kdbxweb.KdbxGroup; changed: boolean } {
  const group = requireMutableActiveGroup(database, groupUuid);
  const target = requireActiveParent(database, targetParentUuid);
  if (group === target) throw new KeePassGroupError("keepass-group-self-move", "KeePass 分组不能移动到自身下面。");
  if (containsGroup(group, target.uuid.toString())) {
    throw new KeePassGroupError("keepass-group-descendant-move", "KeePass 分组不能移动到自身的子分组下面。");
  }
  if (group.parentGroup === target) return { group, changed: false };
  assertSiblingNameAvailable(target, group.name?.trim() || "(未命名)", group.uuid.toString());
  assertSubtreeDepthFits(database, target, subtreeDepth(group));
  database.move(group, target);
  return { group, changed: true };
}

export function deleteKeePassGroup(database: kdbxweb.Kdbx, groupUuid: string): kdbxweb.KdbxGroup {
  const group = requireMutableActiveGroup(database, groupUuid);
  const recycleBin = requireRecycleBin(database);
  if (containsGroup(group, recycleBin.uuid.toString())) {
    throw new KeePassGroupError("keepass-group-recycle-cycle", "KeePass 回收站位于所选分组内部，无法安全删除该分组。");
  }
  assertSubtreeDepthFits(database, recycleBin, subtreeDepth(group));
  database.move(group, recycleBin);
  return group;
}

export function restoreKeePassGroup(
  database: kdbxweb.Kdbx,
  groupUuid: string,
  targetParentUuid: string | undefined
): kdbxweb.KdbxGroup {
  const recycleBin = requireRecycleBin(database);
  const group = requireGroup(database, groupUuid);
  if (group === recycleBin || group.parentGroup !== recycleBin) {
    throw new KeePassGroupError("keepass-group-not-restorable", "仅能恢复回收站第一层中的完整 KeePass 分组树。");
  }

  const target = targetParentUuid
    ? requireActiveParent(database, targetParentUuid)
    : previousActiveParent(database, group) ?? database.getDefaultGroup();
  if (group === target || containsGroup(group, target.uuid.toString())) {
    throw new KeePassGroupError("keepass-group-descendant-move", "KeePass 分组不能恢复到自身的子分组下面。");
  }
  assertSiblingNameAvailable(target, group.name?.trim() || "(未命名)", group.uuid.toString());
  assertSubtreeDepthFits(database, target, subtreeDepth(group));
  database.move(group, target);
  group.previousParentGroup = undefined;
  return group;
}

export function requireKeePassGroup(database: kdbxweb.Kdbx, uuid: string): kdbxweb.KdbxGroup {
  return requireGroup(database, uuid);
}

export function truncateKeePassGroupText(value: string, maxCodePoints: number): { value: string; truncated: boolean } {
  const codePoints = [...value];
  if (codePoints.length <= maxCodePoints) return { value, truncated: false };
  return { value: `${codePoints.slice(0, Math.max(1, maxCodePoints - 1)).join("")}…`, truncated: true };
}

function normalizeGroupName(value: unknown): string {
  if (typeof value !== "string") throw new KeePassGroupError("keepass-group-name-invalid", "KeePass 分组名称格式无效。");
  const name = value.trim();
  if (!name) throw new KeePassGroupError("keepass-group-name-required", "KeePass 分组名称不能为空。");
  if (new TextEncoder().encode(name).byteLength > KEEPASS_GROUP_MAX_NAME_BYTES) {
    throw new KeePassGroupError("keepass-group-name-too-large", "KeePass 分组名称超过 1024 字节安全上限。");
  }
  return name;
}

function requireGroup(database: kdbxweb.Kdbx, uuid: string): kdbxweb.KdbxGroup {
  if (typeof uuid !== "string" || !uuid || uuid.length > 256) {
    throw new KeePassGroupError("keepass-group-id-invalid", "KeePass 分组标识无效，请刷新分组列表。");
  }
  const group = database.getGroup(uuid);
  if (!group) throw new KeePassGroupError("keepass-group-not-found", "KeePass 分组已不存在，请刷新分组列表。");
  return group;
}

function requireMutableActiveGroup(database: kdbxweb.Kdbx, uuid: string): kdbxweb.KdbxGroup {
  const group = requireGroup(database, uuid);
  if (group === database.getDefaultGroup()) throw new KeePassGroupError("keepass-group-root-protected", "KeePass 根分组不能执行此操作。");
  if (isInRecycleBin(database, group)) throw new KeePassGroupError("keepass-group-in-recycle-bin", "回收站中的分组只能恢复，不能重命名、移动或再次删除。");
  return group;
}

function requireActiveParent(database: kdbxweb.Kdbx, uuid: string | undefined): kdbxweb.KdbxGroup {
  const group = uuid ? requireGroup(database, uuid) : database.getDefaultGroup();
  if (isInRecycleBin(database, group)) throw new KeePassGroupError("keepass-group-target-in-recycle-bin", "目标父分组不能位于 KeePass 回收站中。");
  return group;
}

function requireRecycleBin(database: kdbxweb.Kdbx): kdbxweb.KdbxGroup {
  if (database.meta.recycleBinEnabled === false) {
    throw new KeePassGroupError("keepass-recycle-bin-disabled", "此 KeePass 数据库关闭了回收站，浏览器拒绝执行不可恢复的分组删除。");
  }
  let uuid = activeRecycleBinUuid(database);
  let recycleBin = uuid ? database.getGroup(uuid) : undefined;
  if (!recycleBin) {
    assertGroupCapacity(database);
    database.createRecycleBin();
    uuid = activeRecycleBinUuid(database);
    recycleBin = uuid ? database.getGroup(uuid) : undefined;
  }
  if (!recycleBin) throw new KeePassGroupError("keepass-recycle-bin-unavailable", "KeePass 回收站无法创建或读取。");
  return recycleBin;
}

function activeRecycleBinUuid(database: kdbxweb.Kdbx): string | undefined {
  if (database.meta.recycleBinEnabled === false) return undefined;
  const uuid = database.meta.recycleBinUuid;
  return uuid && !uuid.empty ? uuid.toString() : undefined;
}

function isInRecycleBin(database: kdbxweb.Kdbx, group: kdbxweb.KdbxGroup): boolean {
  const recycleBinUuid = activeRecycleBinUuid(database);
  if (!recycleBinUuid) return false;
  let current: kdbxweb.KdbxGroup | undefined = group;
  for (let depth = 0; current && depth <= KEEPASS_GROUP_MAX_DEPTH; depth += 1) {
    if (current.uuid.toString() === recycleBinUuid) return true;
    current = current.parentGroup;
  }
  return false;
}

function previousActiveParent(database: kdbxweb.Kdbx, group: kdbxweb.KdbxGroup): kdbxweb.KdbxGroup | undefined {
  const uuid = group.previousParentGroup?.toString();
  if (!uuid) return undefined;
  const parent = database.getGroup(uuid);
  return parent && !isInRecycleBin(database, parent) ? parent : undefined;
}

function containsGroup(root: kdbxweb.KdbxGroup, uuid: string): boolean {
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    const currentUuid = current.uuid.toString();
    if (currentUuid === uuid) return true;
    if (seen.has(currentUuid)) continue;
    seen.add(currentUuid);
    stack.push(...current.groups);
  }
  return false;
}

function assertGroupCapacity(database: kdbxweb.Kdbx): void {
  if (listKeePassGroupRecords(database, true).length >= KEEPASS_GROUP_MAX_COUNT) {
    throw new KeePassGroupError("keepass-group-count-limit", "KeePass 分组数量已经达到当前浏览器支持的安全上限。");
  }
}

function assertSubtreeDepthFits(database: kdbxweb.Kdbx, targetParent: kdbxweb.KdbxGroup, relativeDepth: number): void {
  const targetDepth = groupDepth(database, targetParent) + 1;
  if (targetDepth + relativeDepth > KEEPASS_GROUP_MAX_DEPTH) {
    throw new KeePassGroupError("keepass-group-depth-limit", "此操作会让 KeePass 分组层级超过当前浏览器支持的安全上限。");
  }
}

function groupDepth(database: kdbxweb.Kdbx, group: kdbxweb.KdbxGroup): number {
  const root = database.getDefaultGroup();
  if (group === root) return -1;
  let current: kdbxweb.KdbxGroup | undefined = group;
  let depth = 0;
  const seen = new Set<string>();
  while (current && current !== root) {
    const uuid = current.uuid.toString();
    if (seen.has(uuid)) throw new KeePassGroupError("keepass-group-parent-cycle", "KeePass 分组父级关系包含循环，无法安全修改。");
    seen.add(uuid);
    current = current.parentGroup;
    if (current !== root) depth += 1;
    if (depth > KEEPASS_GROUP_MAX_DEPTH) {
      throw new KeePassGroupError("keepass-group-depth-limit", "KeePass 分组层级超过当前浏览器支持的安全上限。");
    }
  }
  if (current !== root) throw new KeePassGroupError("keepass-group-parent-invalid", "KeePass 分组没有连接到数据库根分组。");
  return depth;
}

function subtreeDepth(root: kdbxweb.KdbxGroup): number {
  let maximum = 0;
  const seen = new Set<string>();
  const stack = [{ group: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    const uuid = current.group.uuid.toString();
    if (seen.has(uuid)) throw new KeePassGroupError("keepass-group-duplicate-uuid", "KeePass 分组包含重复 UUID，无法安全修改。");
    seen.add(uuid);
    if (seen.size > KEEPASS_GROUP_MAX_COUNT) {
      throw new KeePassGroupError("keepass-group-count-limit", "KeePass 分组数量超过当前浏览器支持的安全上限。");
    }
    maximum = Math.max(maximum, current.depth);
    if (maximum > KEEPASS_GROUP_MAX_DEPTH) {
      throw new KeePassGroupError("keepass-group-depth-limit", "KeePass 分组层级超过当前浏览器支持的安全上限。");
    }
    for (const child of current.group.groups) stack.push({ group: child, depth: current.depth + 1 });
  }
  return maximum;
}

function assertSiblingNameAvailable(parent: kdbxweb.KdbxGroup, name: string, exceptUuid?: string): void {
  const conflict = siblingWithName(parent, name, exceptUuid);
  if (conflict) throw new KeePassGroupError("keepass-group-name-conflict", "同级已经存在同名 KeePass 分组。");
}

function siblingWithName(parent: kdbxweb.KdbxGroup, name: string, exceptUuid?: string): kdbxweb.KdbxGroup | undefined {
  const normalized = name.toLocaleLowerCase();
  return parent.groups.find((candidate) =>
    candidate.uuid.toString() !== exceptUuid && (candidate.name ?? "").trim().toLocaleLowerCase() === normalized
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
