import { decryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { BitwardenClient, type BitwardenSessionConfig } from "./bitwarden-client";
import { mergeBitwardenCipherProjection } from "./bitwarden-cipher-codec";
import { bitwardenOrganizationRecords, resolveBitwardenOrganizationKeys, type BitwardenOrganizationKeyResult } from "./bitwarden-organization";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const MAX_COLLECTIONS = 2_000;
const MAX_COLLECTION_IDS = 200;

export interface BitwardenOrganizationSummary {
  organizationId: string;
  name: string;
  type: string;
  status: string;
  enabled: boolean;
  keyAvailable: boolean;
  fullAccess: boolean;
  canCreateCollections: boolean;
  canEditAnyCollections: boolean;
  canDeleteAnyCollections: boolean;
  canEditAssignedCollections: boolean;
  canDeleteAssignedCollections: boolean;
  allowAdminAccessToAllCollectionItems: boolean;
  limitCollectionCreation: boolean;
  limitCollectionDeletion: boolean;
  organizationPermissionsKnown: boolean;
}

export interface BitwardenCollectionSummary {
  collectionId: string;
  organizationId: string;
  name: string;
  externalId?: string;
  type?: number;
  revision?: string;
  readOnly: boolean;
  hidePasswords: boolean;
  manage: boolean;
  assigned?: boolean;
  readable: boolean;
  permissionKnown: boolean;
  writable: boolean;
  manageable: boolean;
  targetable: boolean;
}

export interface BitwardenCollectionPage {
  items: BitwardenCollectionSummary[];
  organizations: BitwardenOrganizationSummary[];
  warnings: string[];
  total: number;
  nextCursor?: string;
}

export interface BitwardenCollectionMutationResult {
  changed: boolean;
  organizationId?: string;
  collectionIds?: string[];
  previousCollectionIds?: string[];
  rawCipher?: Record<string, unknown>;
}

export class BitwardenCollectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BitwardenCollectionError";
  }
}

export class BitwardenCollectionService {
  constructor(private readonly client: BitwardenClient) {}

  async list(
    session: BitwardenSessionConfig,
    input: { pageSize?: number; cursor?: string } = {},
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; page: BitwardenCollectionPage }> {
    const synced = await this.client.sync(session, signal);
    const vaultKey = this.client.vaultKey(synced.session);
    let organizations: BitwardenOrganizationKeyResult | undefined;
    try {
      const resolvedOrganizations = await resolveBitwardenOrganizationKeys(synced.payload, vaultKey);
      organizations = resolvedOrganizations;
      const organizationRows = await decodeOrganizations(synced.payload, resolvedOrganizations.keys);
      const rawCollections = recordArray(synced.payload, "Collections", "collections");
      if (rawCollections.length > MAX_COLLECTIONS) throw new BitwardenCollectionError("collection-result-too-large", "Bitwarden Collection 响应超过安全上限。");
      const items = (await Promise.all(rawCollections.map((raw) => decodeCollection(raw, organizationRows, resolvedOrganizations.keys))))
        .filter((item): item is BitwardenCollectionSummary => Boolean(item));
      const page = paginate(items, organizationRows, [...resolvedOrganizations.warnings], input);
      return { session: synced.session, page };
    } finally {
      clearKey(vaultKey);
      if (organizations) clearKeys(organizations.keys);
    }
  }

  async moveCipher(
    session: BitwardenSessionConfig,
    cipherId: string,
    collectionIds: string[],
    expectedCipherRevision?: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; result: BitwardenCollectionMutationResult }> {
    assertId(cipherId, "Cipher");
    const requested = normalizeCollectionIds(collectionIds);
    const synced = await this.client.sync(session, signal);
    const vaultKey = this.client.vaultKey(synced.session);
    let organizations: BitwardenOrganizationKeyResult | undefined;
    try {
      const resolvedOrganizations = await resolveBitwardenOrganizationKeys(synced.payload, vaultKey);
      organizations = resolvedOrganizations;
      const organizationRows = await decodeOrganizations(synced.payload, resolvedOrganizations.keys);
      const rawCiphers = recordArray(synced.payload, "Ciphers", "ciphers");
      const raw = rawCiphers.find((candidate) => stringValue(candidate, "Id", "id") === cipherId);
      if (!raw) throw new BitwardenCollectionError("cipher-not-found", "Bitwarden 项目不存在或已被删除，请先同步密码源。");
      if (stringValue(raw, "DeletedDate", "deletedDate")) throw new BitwardenCollectionError("cipher-deleted", "回收站项目不能修改 Collection 路由。");
      const organizationId = stringValue(raw, "OrganizationId", "organizationId");
      if (!organizationId) throw new BitwardenCollectionError("collection-personal-cipher", "个人 Cipher 不能使用组织 Collection。");
      const organization = organizationRows.find((candidate) => candidate.organizationId === organizationId);
      if (!organization || !organization.keyAvailable || !organization.enabled) {
        throw new BitwardenCollectionError("organization-unavailable", "组织密钥或组织状态不可用，已停止修改 Collection 路由。");
      }
      const currentRevision = stringValue(raw, "RevisionDate", "revisionDate");
      if (!currentRevision || !Number.isFinite(Date.parse(currentRevision))) throw new BitwardenCollectionError("cipher-revision-invalid", "Bitwarden 项目缺少可验证修订时间。");
      if (expectedCipherRevision && expectedCipherRevision !== currentRevision) throw new BitwardenCollectionError("cipher-conflict", "项目已在其他设备修改，请刷新后再移动 Collection。");

      const allCollections = (await Promise.all(recordArray(synced.payload, "Collections", "collections").map((candidate) => decodeCollection(candidate, organizationRows, resolvedOrganizations.keys))))
        .filter((item): item is BitwardenCollectionSummary => Boolean(item));
      const byId = new Map(allCollections.map((item) => [item.collectionId, item]));
      for (const id of requested) {
        const target = byId.get(id);
        if (!target || target.organizationId !== organizationId) throw new BitwardenCollectionError("collection-target-invalid", "目标 Collection 不属于此组织或不在当前密码库中。");
        if (!target.readable || !target.targetable) throw new BitwardenCollectionError("collection-permission-denied", `Collection“${target.name}”当前不可写，已停止修改。`);
      }
      const previousCollectionIds = stringArrayValue(raw, "CollectionIds", "collectionIds") || [];
      const currentWritable = previousCollectionIds.every((id) => {
        const current = byId.get(id);
        return current?.targetable === true;
      });
      const canRouteAll = organization.canEditAnyCollections || (organization.fullAccess && organization.allowAdminAccessToAllCollectionItems);
      if (!currentWritable && !canRouteAll) throw new BitwardenCollectionError("collection-current-permission-denied", "当前项目所在 Collection 不允许修改路由；请使用拥有写权限的组织成员操作。");
      if (!requested.length && !canRouteAll) throw new BitwardenCollectionError("collection-empty-target-denied", "当前权限不能把组织项目移出全部 Collection。");
      if (sameIds(previousCollectionIds, requested)) {
        return { session: synced.session, result: { changed: false, organizationId, previousCollectionIds, collectionIds: requested, rawCipher: raw } };
      }

      const updated = await this.client.updateCipherCollections(synced.session, cipherId, requested, signal);
      const optional = unwrapOptionalCipher(updated.payload);
      if (optional.unavailable) throw new BitwardenCollectionError("cipher-unavailable", "修改 Collection 后项目不再对当前账户可见，未更新本地状态。");
      if (!optional.cipher) throw new BitwardenCollectionError("cipher-response-invalid", "Bitwarden Collection 响应缺少完整项目状态，未更新本地状态。");
      const responseId = stringValue(optional.cipher, "Id", "id");
      const responseRevision = stringValue(optional.cipher, "RevisionDate", "revisionDate");
      if (responseId !== cipherId || !responseRevision || !Number.isFinite(Date.parse(responseRevision))) {
        throw new BitwardenCollectionError("cipher-response-invalid", "Bitwarden Collection 响应缺少可验证项目修订信息，未更新本地状态。");
      }
      const updatedRaw = mergeBitwardenCipherProjection(raw, optional.cipher, { collectionIds: requested });
      const returnedRevision = stringValue(updatedRaw, "RevisionDate", "revisionDate");
      if (stringValue(updatedRaw, "Id", "id") !== cipherId || !returnedRevision || !Number.isFinite(Date.parse(returnedRevision))) {
        throw new BitwardenCollectionError("cipher-response-invalid", "Bitwarden Collection 响应缺少可验证项目修订信息，未更新本地状态。");
      }
      return {
        session: updated.session,
        result: { changed: true, organizationId, previousCollectionIds, collectionIds: requested, rawCipher: updatedRaw }
      };
    } finally {
      clearKey(vaultKey);
      if (organizations) clearKeys(organizations.keys);
    }
  }
}

async function decodeOrganizations(
  payload: Record<string, unknown>,
  keys: ReadonlyMap<string, BitwardenSymmetricKey>
): Promise<BitwardenOrganizationSummary[]> {
  const rawOrganizations = bitwardenOrganizationRecords(payload);
  const rows = await Promise.all(rawOrganizations.map(async (raw) => {
    const organizationId = stringValue(raw, "Id", "id");
    if (!organizationId) return undefined;
    const key = keys.get(organizationId);
    const rawName = stringValue(raw, "Name", "name");
    const name = await decryptDisplayName(rawName, key, `组织 ${shortId(organizationId)}`);
    const type = organizationType(raw);
    const status = organizationStatus(raw);
    const statusAllowed = organizationStatusAllowed(status);
    const permissionsRecord = recordValue(raw, "Permissions", "permissions");
    const permissions = permissionsRecord || {};
    const organizationPermissionsKnown = Boolean(permissionsRecord);
    const ownerOrAdmin = type === "Owner" || type === "Admin" || type === "0" || type === "1";
    const custom = type === "Custom" || type === "4";
    const providerUser = bool(raw, "IsProviderUser", "isProviderUser");
    const allowAdminAccess = boolValue(raw, "AllowAdminAccessToAllCollectionItems", "allowAdminAccessToAllCollectionItems") === true;
    const canEditAny = providerUser || (custom && bool(permissions, "EditAnyCollection", "editAnyCollection")) || (allowAdminAccess && ownerOrAdmin);
    const canDeleteAny = providerUser || bool(permissions, "DeleteAnyCollection", "deleteAnyCollection") || (allowAdminAccess && ownerOrAdmin);
    // Bitwarden does not expose a separate "edit assigned" bit: a confirmed
    // member with a readable, non-read-only assigned Collection may edit it.
    // Missing the organization permission projection is treated as unknown.
    const canEditAssigned = organizationPermissionsKnown;
    const canDeleteAssigned = organizationPermissionsKnown;
    const limitCreation = boolValue(raw, "LimitCollectionCreation", "limitCollectionCreation") ?? false;
    return {
      organizationId,
      name,
      type,
      status,
      enabled: (boolValue(raw, "Enabled", "enabled") === true) && statusAllowed,
      keyAvailable: Boolean(key),
      fullAccess: ownerOrAdmin || bool(raw, "AccessAll", "accessAll"),
      canCreateCollections: !limitCreation || ownerOrAdmin || bool(permissions, "CreateNewCollections", "createNewCollections"),
      canEditAnyCollections: canEditAny,
      canDeleteAnyCollections: canDeleteAny,
      canEditAssignedCollections: canEditAssigned,
      canDeleteAssignedCollections: canDeleteAssigned,
      allowAdminAccessToAllCollectionItems: allowAdminAccess,
      limitCollectionCreation: limitCreation,
      limitCollectionDeletion: boolValue(raw, "LimitCollectionDeletion", "limitCollectionDeletion") ?? false,
      organizationPermissionsKnown
    } satisfies BitwardenOrganizationSummary;
  }));
  return rows.filter((row): row is BitwardenOrganizationSummary => Boolean(row));
}

async function decodeCollection(
  raw: Record<string, unknown>,
  organizations: BitwardenOrganizationSummary[],
  keys: ReadonlyMap<string, BitwardenSymmetricKey>
): Promise<BitwardenCollectionSummary | undefined> {
  const collectionId = stringValue(raw, "Id", "id");
  const organizationId = stringValue(raw, "OrganizationId", "organizationId");
  if (!collectionId || !organizationId || collectionId.length > 512 || organizationId.length > 512) return undefined;
  const organization = organizations.find((candidate) => candidate.organizationId === organizationId);
  const key = keys.get(organizationId);
  const encryptedName = stringValue(raw, "Name", "name");
  const name = await decryptDisplayName(encryptedName, key, `Collection ${shortId(collectionId)}`);
  const readOnlyRaw = boolValue(raw, "ReadOnly", "readOnly");
  const hidePasswordsRaw = boolValue(raw, "HidePasswords", "hidePasswords");
  const manageRaw = boolValue(raw, "Manage", "manage");
  const assigned = boolValue(raw, "Assigned", "assigned");
  const permissionKnown = readOnlyRaw !== undefined && hidePasswordsRaw !== undefined && manageRaw !== undefined;
  const readOnly = readOnlyRaw ?? true;
  const hidePasswords = hidePasswordsRaw ?? true;
  const manage = manageRaw === true;
  const readable = Boolean(key && organization?.keyAvailable && organization.enabled && name && !name.startsWith("（无法"));
  const writable = readable && permissionKnown && !readOnly;
  const permissionScope = organization?.organizationPermissionsKnown === true && (organization.canEditAnyCollections === true
    || manage
    || (organization.canEditAssignedCollections === true && assigned !== false));
  const manageable = readable && permissionScope;
  return {
    collectionId,
    organizationId,
    name,
    externalId: optionalString(raw, "ExternalId", "externalId"),
    type: numberValue(raw, "Type", "type"),
    revision: optionalString(raw, "RevisionDate", "revisionDate"),
    readOnly,
    hidePasswords,
    manage,
    assigned,
    readable,
    permissionKnown,
    writable,
    manageable,
    targetable: writable && permissionScope
  };
}

function unwrapOptionalCipher(payload: Record<string, unknown>): { unavailable: boolean; cipher?: Record<string, unknown> } {
  const unavailable = payload.Unavailable === true || payload.unavailable === true;
  const nested = recordValue(payload, "Cipher", "cipher");
  return { unavailable, cipher: nested || (unavailable ? undefined : payload) };
}

function paginate(
  items: BitwardenCollectionSummary[],
  organizations: BitwardenOrganizationSummary[],
  warnings: string[],
  input: { pageSize?: number; cursor?: string }
): BitwardenCollectionPage {
  const pageSize = input.pageSize === undefined ? DEFAULT_PAGE_SIZE : input.pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new BitwardenCollectionError("collection-page-invalid", "Collection 分页大小无效。");
  const start = parseCursor(input.cursor);
  const page = items.slice(start, start + pageSize);
  return { items: page, organizations, warnings, total: items.length, ...(start + page.length < items.length ? { nextCursor: String(start + page.length) } : {}) };
}

function parseCursor(value?: string): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d{1,9}$/.test(value)) throw new BitwardenCollectionError("collection-cursor-invalid", "Collection 分页游标无效。");
  return Number(value);
}

function normalizeCollectionIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length > MAX_COLLECTION_IDS || ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 512)) {
    throw new BitwardenCollectionError("collection-target-invalid", "Collection 路由列表无效。");
  }
  return [...new Set(ids.map((id) => id.trim()))];
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function assertId(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new BitwardenCollectionError("collection-id-invalid", `${label} 标识无效。`);
  }
}

function organizationType(raw: Record<string, unknown>): string {
  const value = raw.Type ?? raw.type;
  if (typeof value === "number") return ["Owner", "Admin", "User", "Manager", "Custom"][value] || String(value);
  return typeof value === "string" && value ? value : "User";
}

function organizationStatus(raw: Record<string, unknown>): string {
  const value = raw.Status ?? raw.status;
  if (typeof value === "number") return value === -1 ? "Revoked" : ["Invited", "Accepted", "Confirmed", "Staged"][value] || String(value);
  return typeof value === "string" && value ? value : "Unknown";
}

function organizationStatusAllowed(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "confirmed" || normalized === "active" || normalized === "enabled" || normalized === "2";
}

function bool(raw: Record<string, unknown>, ...names: string[]): boolean {
  return names.some((name) => raw[name] === true);
}

function boolValue(raw: Record<string, unknown>, ...names: string[]): boolean | undefined {
  for (const name of names) if (typeof raw[name] === "boolean") return raw[name] as boolean;
  return undefined;
}

function numberValue(raw: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = Number(raw[name]);
    if (Number.isSafeInteger(value)) return value;
  }
  return undefined;
}

function stringValue(raw: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) if (typeof raw[name] === "string") return raw[name] as string;
  return "";
}

function optionalString(raw: Record<string, unknown>, ...names: string[]): string | undefined {
  return stringValue(raw, ...names) || undefined;
}

function stringArrayValue(raw: Record<string, unknown>, ...names: string[]): string[] | undefined {
  for (const name of names) {
    if (!Array.isArray(raw[name])) continue;
    return [...new Set((raw[name] as unknown[]).filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 512))];
  }
  return undefined;
}

function recordValue(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown> | undefined {
  for (const name of names) {
    const value = raw[name];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function recordArray(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown>[] {
  for (const name of names) {
    const value = raw[name];
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) {
      for (const nested of ["Data", "data", "Collections", "collections"]) {
        if (Array.isArray(value[nested])) return (value[nested] as unknown[]).filter(isRecord);
      }
    }
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function decryptDisplayName(value: string, key: BitwardenSymmetricKey | undefined, fallback: string): Promise<string> {
  if (!value) return "（无法读取名称）";
  if (!key) return "（无法解密）";
  try {
    const decrypted = await decryptBitwardenString(value, key);
    return decrypted || "（无法读取名称）";
  } catch {
    // Some self-hosted builds expose an unencrypted organization label. Do not
    // treat ordinary text as a cryptographic failure, but never guess for a
    // CipherString-looking value.
    return /^\d+\./.test(value) ? "（无法解密）" : value || fallback;
  }
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

function clearKey(key: BitwardenSymmetricKey): void {
  key.encKey.fill(0);
  key.macKey.fill(0);
}

function clearKeys(keys: ReadonlyMap<string, BitwardenSymmetricKey>): void {
  for (const key of keys.values()) clearKey(key);
}
