import { parseLosslessJson, jsonScalarText } from "../../core/lossless-json";
import { capturePasswordHistory, assertPortablePasswordHistory } from '../../core/password-history';
import { normalizeOtpCounter, otpCounterJson } from "../../core/otp-counter";
import { boundNoteLogicalId, boundNoteScope, resolveBoundNote } from "../../core/bound-notes";
import { strFromU8, strToU8, zipSync } from "fflate";
import type { BillingAddressItem, CardItem, IdentityItem, LoginItem, PasskeyItem, PaymentAccountItem, ProviderReference, SecureCustomField, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";
import {
  firstString,
  readCardFaceConfig,
  mergeMonicaItemData,
  normalizeCardType,
  normalizeDocumentType,
  normalizeOtpType,
  normalizePaymentAccountType,
  normalizeTotpAlgorithm,
  parseSecureCustomFields,
  parseSteamSession,
  serializeSecureCustomFields
} from "../monica-item-data";
import { inspectZipArchive, safeUnzipSync, validateUncompressedZipEntries } from "./zip-safety";
import { parsePortablePasskeyPrivateKey, portablePasskeyKeyMatchesAlgorithm } from "../../passkey/private-key-portability";

export interface AndroidBackupCodecOptions {
  allowPortablePasskeys?: boolean;
  allowPortableAttachments?: boolean;
  /** Only for an explicitly requested metadata-only export, never a complete migration. */
  allowMetadataOnlyPasskeys?: boolean;
}

export interface AndroidBackupRecord {
  path: string;
  raw: Record<string, unknown>;
  itemId: string;
  item: VaultItem;
  container?: "json-array";
}

export interface AndroidBackupDocument {
  entries: Record<string, Uint8Array>;
  items: VaultItem[];
  records: Map<string, AndroidBackupRecord>;
  warnings: string[];
  passwordHistoryRaw?: unknown[];
  generatorHistoryRecords?: AndroidGeneratorHistoryRecord[];
  portableAttachmentsAllowed?: boolean;
}

interface AndroidGeneratorHistoryRecord {
  path: string;
  values: unknown[];
}

export interface AndroidGeneratorHistoryEntry {
  id: string;
  password: string;
  timestamp: number;
  packageName: string;
  domain: string;
  username: string;
  type: string;
}

export interface AndroidPortableAttachment {
  attachmentId: string;
  parentPasswordId?: number | string;
  parentSecureItemId?: number | string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  sha256Hex: string;
  payloadPath: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AndroidPortableAttachmentInput {
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  sha256Hex: string;
  attachmentId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AndroidTimelineEntrySummary {
  id: string;
  itemType: string;
  itemId: number;
  itemTitle: string;
  operationType: string;
  deviceName: string;
  timestamp: number;
  reverted: boolean;
  changedFields: string[];
}

const PORTABLE_ATTACHMENT_MANIFEST = "attachments_portable/attachments_portable.json";
const PORTABLE_ATTACHMENT_PATH = /^attachments_portable\/([^/]+)\.bin$/;
const PORTABLE_ATTACHMENT_MAX_BYTES = 256 * 1024 * 1024;
const CATEGORIES_PATH = "categories.json";
const TIMELINE_PATH = "timeline_history.json";
const GENERATOR_HISTORY_SUFFIX = "_generated_history.json";
const GENERATOR_HISTORY_MAX_ENTRIES = 1_000;

// Current Android exports use folders/<category>/<kind>. Older exports kept
// passkeys at the archive root; Android restore still accepts that layout.
const JSON_PATH = /^(?:folders\/([^/]+)\/)?(passwords|totp|authenticators|bank_cards|documents|billing_addresses|payment_accounts|notes|passkeys)\/[^/]+\.json$/i;
const FUTURE_JSON_PATH = /^folders\/[^/]+\/[^/]+\/[^/]+\.json$/i;

export function listAndroidTimeline(document: AndroidBackupDocument): AndroidTimelineEntrySummary[] {
  const bytes = document.entries[TIMELINE_PATH];
  if (!bytes) return [];
  const parsed = parseLosslessJson(strFromU8(bytes)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Android 时间线不是 JSON 数组");
  return parsed.flatMap((value, index): AndroidTimelineEntrySummary[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const raw = value as Record<string, unknown>;
    const timestamp = optionalNumber(raw.timestamp);
    if (timestamp === undefined) return [];
    return [{
      id: jsonScalarText(raw.id ?? `${timestamp}:${index}`).slice(0, 128),
      itemType: (stringValue(raw.itemType) || "UNKNOWN").slice(0, 64),
      itemId: optionalNumber(raw.itemId) ?? 0,
      itemTitle: (stringValue(raw.itemTitle) || "未命名操作").slice(0, 512),
      operationType: (stringValue(raw.operationType) || "UNKNOWN").slice(0, 64),
      deviceName: (stringValue(raw.deviceName) || "未知设备").slice(0, 128),
      timestamp,
      reverted: Boolean(raw.isReverted),
      changedFields: timelineChangedFields(raw.changesJson)
    }];
  }).sort((left, right) => right.timestamp - left.timestamp);
}

export function listAndroidGeneratorHistory(document: AndroidBackupDocument): AndroidGeneratorHistoryEntry[] {
  return (document.generatorHistoryRecords || []).flatMap((record) => record.values.flatMap((value, index): AndroidGeneratorHistoryEntry[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const raw = value as Record<string, unknown>;
    const password = optionalString(raw.password);
    const timestamp = optionalNumber(raw.timestamp);
    if (password === undefined || timestamp === undefined) return [];
    return [{
      id: generatorHistoryId(record.path, index, timestamp),
      password,
      timestamp,
      packageName: optionalString(raw.packageName) || "",
      domain: optionalString(raw.domain) || "",
      username: optionalString(raw.username) || "",
      type: optionalString(raw.type) || "AUTOFILL"
    }];
  }));
}

export function deleteAndroidGeneratorHistoryEntry(document: AndroidBackupDocument, id: string): boolean {
  for (const record of document.generatorHistoryRecords || []) {
    const index = record.values.findIndex((value, candidateIndex) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const timestamp = optionalNumber((value as Record<string, unknown>).timestamp);
      return timestamp !== undefined && generatorHistoryId(record.path, candidateIndex, timestamp) === id;
    });
    if (index < 0) continue;
    record.values.splice(index, 1);
    document.entries[record.path] = strToU8(JSON.stringify(record.values));
    return true;
  }
  return false;
}

function generatorHistoryId(path: string, index: number, timestamp: number): string {
  return `${path}:${index}:${timestamp}`;
}

function timelineChangedFields(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = parseLosslessJson(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.flatMap((change) => {
      if (!change || typeof change !== "object" || Array.isArray(change)) return [];
      const name = optionalString((change as Record<string, unknown>).fieldName)?.trim();
      return name ? [name.slice(0, 128)] : [];
    }))].slice(0, 64);
  } catch {
    return [];
  }
}

export function readAndroidBackup(zipBytes: Uint8Array, providerId: string, options: AndroidBackupCodecOptions = {}): AndroidBackupDocument {
  const entries = safeUnzipSync(zipBytes);
  const items: VaultItem[] = [];
  const records = new Map<string, AndroidBackupRecord>();
  const warnings: string[] = [];
  const hasPortableAttachments = Boolean(entries[PORTABLE_ATTACHMENT_MANIFEST]);
  if (hasPortableAttachments && options.allowPortableAttachments === false) {
    warnings.push("未加密的 Android 备份包含 portable 附件；附件字节已原样保留，但不会显示或解密。");
  }

  for (const [path, bytes] of Object.entries(entries)) {
    if (!JSON_PATH.test(path) && !FUTURE_JSON_PATH.test(path)) continue;
    try {
      const raw = parseLosslessJson(strFromU8(bytes)) as Record<string, unknown>;
      const item = androidRecordToItem(path, raw, providerId, options);
      if (!item) continue;
      if (item.kind === "opaque") { item.originalPayload = strFromU8(bytes); warnings.push(`${path}: ${item.readOnlyReason}`); }
      items.push(item);
      records.set(item.id, { path, raw, itemId: item.id, item: cloneVaultItem(item) });
    } catch {
      const item = opaqueAndroidRecord(path, {}, providerId, "此记录无法安全解析，仅可读取原始数据。", strFromU8(bytes));
      items.push(item);
      records.set(item.id, { path, raw: {}, itemId: item.id, item: cloneVaultItem(item) });
      warnings.push(`${path}: ${item.readOnlyReason}`);
    }
  }
  readAndroidTrash(entries, providerId, options, items, records, warnings);
  hydrateAndroidCategories(entries, items, warnings);
  const passwordHistoryRaw = readAndroidPasswordHistory(entries, items, records, warnings);
  const generatorHistoryRecords = readAndroidGeneratorHistory(entries, warnings);
  restoreAndroidOtpBindings(items);
  restoreAndroidNoteBindings(items, records);
  for (const item of items) {
    const record = records.get(item.id);
    if (record) record.item = cloneVaultItem(item);
  }
  return { entries, items, records, warnings, passwordHistoryRaw, generatorHistoryRecords, portableAttachmentsAllowed: options.allowPortableAttachments !== false };
}

function restoreAndroidNoteBindings(items: VaultItem[], records: Map<string, AndroidBackupRecord>): void {
  for (const owner of items) {
    if (owner.kind !== "login" || owner.deletedAt || records.get(owner.id)?.raw.boundNoteEntryId !== undefined || !Number.isSafeInteger(owner.boundNoteId)) continue;
    const matches = items.filter(item => {
      const id = records.get(item.id)?.raw.id;
      return !item.deletedAt && item.kind !== "login" && (typeof id === "number" || typeof id === "string")
        && Number(id) === owner.boundNoteId;
    });
    if (matches.length === 1 && matches[0].kind === "secure-note" && boundNoteScope(matches[0]) === boundNoteScope(owner)) owner.boundNoteEntryId = boundNoteLogicalId(matches[0]);
  }
}

function synchronizeAndroidNoteBindings(document: AndroidBackupDocument, items: VaultItem[]): void {
  for (const owner of items) {
    if (owner.kind !== "login" || owner.deletedAt) continue;
    const previous = document.records.get(owner.id)?.item;
    if (!owner.boundNoteEntryId || (owner.boundNoteEntryId === previous?.boundNoteEntryId && owner.boundNoteId === previous?.boundNoteId)) continue;
    const note = resolveBoundNote(owner, items);
    if (!note) throw new Error("关联笔记不在此备份中、已删除或标识重复，无法同步关联。");
    const exportId = (item: VaultItem) => {
      const rawId = document.records.get(item.id)?.raw.id;
      return rawId === undefined ? numericId(item) : typeof rawId === "number" || typeof rawId === "string" ? Number(rawId) : NaN;
    };
    const id = exportId(note);
    if (!Number.isSafeInteger(id) || items.filter(item => !item.deletedAt && item.kind !== "login" && exportId(item) === id).length !== 1) {
      throw new Error("笔记的 Android 备份标识不唯一或无效，无法同步关联。");
    }
    owner.boundNoteId = id;
    // A provider-local fallback becomes durable when explicitly selected and exported.
    if (!note.replicaGroupId?.startsWith("note:")) note.replicaGroupId = boundNoteLogicalId(note);
  }
}

function restoreAndroidOtpBindings(items: VaultItem[]): void {
  const loginsByProviderAndId = new Map<string, LoginItem>();
  for (const item of items) {
    if (item.kind !== "login") continue;
    for (const reference of item.providerRefs) {
      const match = reference.remoteId?.match(/\/password_(-?\d+)_\d+\.json$/i);
      if (match) loginsByProviderAndId.set(`${reference.providerId}:${match[1]}`, item);
    }
  }
  for (const item of items) {
    if (item.kind !== "totp" || item.boundPasswordId == null) continue;
    for (const reference of item.providerRefs) {
      const login = loginsByProviderAndId.get(`${reference.providerId}:${item.boundPasswordId}`);
      if (login && !login.boundTotpItemId) login.boundTotpItemId = item.id;
    }
  }
}

/** Android stores the link on the authenticator; the extension edits it on the login. */
function synchronizeAndroidOtpBindings(document: AndroidBackupDocument, items: VaultItem[]): void {
  const logins = items.filter((item): item is LoginItem => item.kind === "login" && !item.deletedAt);
  const edits = logins.filter(login => {
    const original = document.records.get(login.id)?.item;
    // Missing means a legacy record; an empty string records an explicit unlink.
    return login.boundTotpItemId !== undefined && login.boundTotpItemId !== (original?.kind === "login" ? original.boundTotpItemId : undefined);
  });
  if (!edits.length) return;

  const authenticators = items.filter((item): item is TotpItem => item.kind === "totp");
  const byId = new Map(authenticators.map(item => [item.id, item]));
  const byPasswordId = new Map<number, TotpItem[]>();
  for (const item of authenticators) {
    if (item.boundPasswordId === undefined) continue;
    const group = byPasswordId.get(item.boundPasswordId) || [];
    group.push(item);
    byPasswordId.set(item.boundPasswordId, group);
  }
  const ids = new Map(logins.map(login => {
    const original = document.records.get(login.id)?.raw.id;
    return [login.id, original === undefined ? numericId(login) : typeof original === "number" || typeof original === "string" ? Number(original) : NaN];
  }));
  const idCounts = new Map<number, number>();
  const owners = new Map<string, number>();
  for (const login of logins) {
    const id = ids.get(login.id)!;
    idCounts.set(id, (idCounts.get(id) || 0) + 1);
    const original = document.records.get(login.id)?.item;
    const targetId = login.boundTotpItemId ?? (original?.kind === "login" ? original.boundTotpItemId : undefined);
    if (targetId) owners.set(targetId, (owners.get(targetId) || 0) + 1);
  }

  // Validate the whole edit before changing any companion record. A relationship
  // Android cannot represent must not silently disappear on the next sync.
  for (const login of edits) {
    const id = ids.get(login.id)!;
    if (!Number.isSafeInteger(id) || idCounts.get(id) !== 1) throw new Error("登录项的 Android 标识不唯一或无效，无法同步验证器绑定。");
    if (!login.boundTotpItemId) continue;
    const target = byId.get(login.boundTotpItemId);
    if (!target || target.deletedAt) throw new Error("验证器不在此 WebDAV 数据库中或已删除，无法同步绑定。");
    if (owners.get(target.id) !== 1) throw new Error("Android 的独立验证器只能绑定一个登录项，请先解除重复绑定。");
  }

  const changes = new Map<TotpItem, { passwordId?: number; updatedAt: string }>();
  for (const login of edits) {
    const id = ids.get(login.id)!;
    for (const item of byPasswordId.get(id) || []) {
      if (item.id !== login.boundTotpItemId) changes.set(item, { updatedAt: login.updatedAt });
    }
  }
  for (const login of edits) {
    if (login.boundTotpItemId) changes.set(byId.get(login.boundTotpItemId)!, { passwordId: ids.get(login.id), updatedAt: login.updatedAt });
  }
  for (const [item, change] of changes) {
    if (item.boundPasswordId === change.passwordId) continue;
    item.boundPasswordId = change.passwordId;
    if (Date.parse(change.updatedAt) > Date.parse(item.updatedAt)) item.updatedAt = change.updatedAt;
  }
}

export function writeAndroidBackup(document: AndroidBackupDocument, items: VaultItem[], providerId: string, options: AndroidBackupCodecOptions = {}): Uint8Array {
  // Serialization can reject a later item; edits to bindings/references commit only after the ZIP validates.
  const originalItems = items;
  items = items.map(cloneVaultItem);
  const entries = { ...document.entries };
  synchronizeAndroidOtpBindings(document, items);
  synchronizeAndroidNoteBindings(document, items);
  synchronizeAndroidCategories(document, items, entries);
  for (const item of items) {
    const existing = document.records.get(item.id);
    if (item.kind === "opaque" || existing?.item.kind === "opaque") {
      if (!existing || !sameWritableItem(item, existing.item)) throw new Error("未知类型或损坏的 Android 记录仅可原样保留，不能编辑或跨库新建。");
      continue;
    }
    if (item.deletedAt) {
      if (!existing) continue;
      if (sameWritableItem(item, existing.item)) continue;
      const target = serializeAndroidItem(item, existing.raw, existing.item, options);
      if (!target) continue;
      if (existing.container === "json-array") {
        updateAndroidArrayEntry(entries, existing.path, target.id, target.raw);
      } else {
        delete entries[existing.path];
        updateAndroidArrayEntry(entries, trashPath(item), target.id, target.raw);
      }
      continue;
    }
    if (existing && sameWritableItem(item, existing.item)) continue;
    const target = serializeAndroidItem(item, existing?.raw, existing?.item, options);
    if (!target) continue;
    if (existing?.container === "json-array") {
      updateAndroidArrayEntry(entries, existing.path, target.id, undefined);
      const remotePath = providerPath(item, target.id);
      entries[remotePath] = strToU8(JSON.stringify(target.raw));
      ensureProviderReference(item, providerId, remotePath);
      continue;
    }
    const remotePath = existing
      ? existingPathForCategory(item, existing)
      : providerPath(item, target.id);
    if (existing && remotePath !== existing.path) delete entries[existing.path];
    entries[remotePath] = strToU8(JSON.stringify(target.raw));
    ensureProviderReference(item, providerId, remotePath);
  }
  writeAndroidPasswordHistory(document, items, entries);
  validateUncompressedZipEntries(entries);
  const output = zipSync(entries, { level: 6 });
  inspectZipArchive(output);
  for (let index = 0; index < items.length; index += 1) Object.assign(originalItems[index], items[index]);
  return output;
}

interface AndroidCategoryRecord {
  id: number;
  name: string;
  sortOrder: number;
  raw: Record<string, unknown>;
}

function parseAndroidCategories(bytes: Uint8Array | undefined): { values: unknown[]; records: AndroidCategoryRecord[] } | undefined {
  if (!bytes) return { values: [], records: [] };
  const parsed = parseLosslessJson(strFromU8(bytes)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("分类清单不是 JSON 数组");
  const records: AndroidCategoryRecord[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    const id = optionalNumber(raw.id);
    const name = optionalString(raw.name)?.trim();
    if (id === undefined || !name) continue;
    records.push({ id, name, sortOrder: optionalNumber(raw.sortOrder) ?? 0, raw });
  }
  return { values: parsed, records };
}

function hydrateAndroidCategories(entries: Record<string, Uint8Array>, items: VaultItem[], warnings: string[]): void {
  let categories: ReturnType<typeof parseAndroidCategories>;
  try {
    categories = parseAndroidCategories(entries[CATEGORIES_PATH]);
  } catch (error) {
    warnings.push(`${CATEGORIES_PATH}: ${error instanceof Error ? error.message : "无法解析"}`);
    return;
  }
  if (!categories) return;
  const namesById = new Map(categories.records.map((category) => [category.id, category.name]));
  for (const item of items) {
    if (!item.categoryName && item.categoryId !== undefined) item.categoryName = namesById.get(item.categoryId);
  }
}

function synchronizeAndroidCategories(
  document: AndroidBackupDocument,
  items: VaultItem[],
  entries: Record<string, Uint8Array>
): void {
  let categories: ReturnType<typeof parseAndroidCategories>;
  try {
    categories = parseAndroidCategories(entries[CATEGORIES_PATH]);
  } catch (error) {
    const hasCategoryChange = items.some((item) => {
      const previous = document.records.get(item.id)?.item;
      return Boolean(item.categoryName?.trim()) && (!previous || item.categoryName !== previous.categoryName || item.categoryId !== previous.categoryId);
    });
    if (hasCategoryChange) {
      throw new Error(`${CATEGORIES_PATH} 无法安全更新：${error instanceof Error ? error.message : "无法解析"}`);
    }
    return;
  }
  if (!categories) return;

  const byId = new Map(categories.records.map((category) => [category.id, category]));
  const byName = new Map(categories.records.map((category) => [category.name, category]));
  for (const baseline of document.items) {
    const name = baseline.categoryName?.trim();
    if (!name || baseline.categoryId === undefined || byName.has(name) || byId.has(baseline.categoryId)) continue;
    const inferred = { id: baseline.categoryId, name, sortOrder: baseline.sortOrder ?? 0, raw: { id: baseline.categoryId, name, sortOrder: baseline.sortOrder ?? 0 } };
    byId.set(inferred.id, inferred);
    byName.set(inferred.name, inferred);
  }

  let changed = false;
  let nextId = Math.max(0, ...byId.keys()) + 1;
  let nextSortOrder = Math.max(-1, ...categories.records.map((category) => category.sortOrder)) + 1;
  for (const item of items) {
    const name = item.categoryName?.trim();
    if (!name) continue;
    const previous = document.records.get(item.id)?.item;
    const categoryChanged = !previous || name !== previous.categoryName?.trim() || item.categoryId !== previous.categoryId;
    if (!categoryChanged) continue;

    let category = byName.get(name);
    if (!category && item.categoryId !== undefined) {
      const matchingId = byId.get(item.categoryId);
      if (matchingId?.name === name) category = matchingId;
    }
    if (!category) {
      while (byId.has(nextId)) nextId += 1;
      const id = item.categoryId !== undefined && !byId.has(item.categoryId) ? item.categoryId : nextId++;
      const sortOrder = item.sortOrder ?? nextSortOrder++;
      const raw = { id, name, sortOrder };
      category = { id, name, sortOrder, raw };
      byId.set(id, category);
      byName.set(name, category);
    }
    item.categoryId = category.id;
    if (!categories.records.some((record) => record.id === category?.id || record.name === category?.name)) {
      categories.values.push(category.raw);
      categories.records.push(category);
      changed = true;
    }
  }
  if (changed) entries[CATEGORIES_PATH] = strToU8(JSON.stringify(categories.values));
}

export function deleteAndroidBackupItem(document: AndroidBackupDocument, itemId: string): void {
  const record = document.records.get(itemId);
  if (!record) return;
  if (record.item.kind === "opaque") throw new Error("未知类型或损坏记录仅可只读查看，不能删除原始数据。");
  for (const attachment of listAndroidPortableAttachments(document, record.item)) {
    deleteAndroidPortableAttachment(document, record.item, attachment.attachmentId);
  }
  if (record.container === "json-array") updateAndroidArrayEntry(document.entries, record.path, record.raw.id, undefined);
  else delete document.entries[record.path];
  document.records.delete(itemId);
  document.items = document.items.filter((item) => item.id !== itemId);
}

export function androidRecordToItem(path: string, raw: Record<string, unknown>, providerId: string, options: AndroidBackupCodecOptions = {}): VaultItem | null {
  const match = path.match(JSON_PATH);
  if ((match || FUTURE_JSON_PATH.test(path)) && !isJsonObject(raw)) return opaqueAndroidRecord(path, {}, providerId, "Android 项目不是对象，仅可读取原始数据。", JSON.stringify(raw));
  if (!match) return FUTURE_JSON_PATH.test(path) ? opaqueAndroidRecord(path, raw, providerId, "未知 Android 项目类型，仅可读取原始数据。") : null;
  // Current Android uses totp/item_<id>.json; retain the legacy extension
  // authenticators alias and keep the original source path on writeback.
  const kindFolder = match[2].toLowerCase() === "totp" ? "authenticators" : match[2].toLowerCase();
  const expectedTypes: Record<string, string> = { passwords: "PASSWORD", notes: "NOTE", authenticators: "TOTP", bank_cards: "BANK_CARD", documents: "DOCUMENT", billing_addresses: "BILLING_ADDRESS", payment_accounts: "PAYMENT_ACCOUNT" };
  if (raw.itemType != null && raw.itemType !== expectedTypes[kindFolder]) return opaqueAndroidRecord(path, raw, providerId, "项目原生类型与目录不匹配，仅可读取原始数据。");
  if (kindFolder !== "passwords" && kindFolder !== "passkeys") {
    try { parseNestedJson(raw.itemData); } catch { return opaqueAndroidRecord(path, raw, providerId, "项目 itemData 已损坏或版本未知，仅可读取原始数据。"); }
  }
  const base = baseFields(path, raw, providerId);

  if (kindFolder === "passwords") {
    const rawLoginType = stringValue(raw.loginType).trim().toUpperCase();
    if (rawLoginType && !["PASSWORD", "SSO", "WIFI", "SSH", "SSH_KEY", "GPG_KEY", "API_KEY", "BARCODE"].includes(rawLoginType)) return opaqueAndroidRecord(path, raw, providerId, "未知登录类型，仅可读取原始数据。");
    return {
      ...base,
      kind: "login",
      username: stringValue(raw.username),
      password: stringValue(raw.password),
      uris: splitUris(stringValue(raw.website)),
      uriRules: splitUris(stringValue(raw.website)).map((uri) => ({ uri, matchType: "base-domain" })),
      totpSecret: stringValue(raw.authenticatorKey) || undefined,
      customFields: Array.isArray(raw.customFields)
        ? raw.customFields.filter((field) => field && typeof field === "object" && !Array.isArray(field) && typeof field.title === "string" && typeof field.value === "string").map((field) => {
            const value = field as Record<string, unknown>;
            return { name: stringValue(value.title), value: stringValue(value.value), protected: Boolean(value.isProtected) };
          })
        : [],
      loginType: normalizeLoginType(raw.loginType),
      passwordGroupId: optionalString(raw.passwordGroupId),
      isGroupCover: typeof raw.isGroupCover === "boolean" ? raw.isGroupCover : undefined,
      ssoProvider: optionalString(raw.ssoProvider),
      ssoRefEntryId: optionalNumber(raw.ssoRefEntryId),
      ssoRefLogicalId: optionalString(raw.ssoRefLogicalId),
      appPackageName: optionalString(raw.appPackageName),
      appName: optionalString(raw.appName),
      email: optionalText(raw.email),
      phone: optionalText(raw.phone),
      addressLine: optionalText(raw.addressLine),
      city: optionalText(raw.city),
      state: optionalText(raw.state),
      zipCode: optionalText(raw.zipCode),
      country: optionalText(raw.country),
      creditCardNumber: optionalText(raw.creditCardNumber),
      creditCardHolder: optionalText(raw.creditCardHolder),
      creditCardExpiry: optionalText(raw.creditCardExpiry),
      creditCardCVV: optionalText(raw.creditCardCVV),
      passkeyBindings: optionalString(raw.passkeyBindings),
      sshKeyData: optionalString(raw.sshKeyData),
      wifiMetadata: optionalString(raw.wifiMetadata),
      barcodeData: optionalString(raw.barcodeData),
      customIconType: optionalString(raw.customIconType),
      customIconValue: optionalString(raw.customIconValue),
      customIconUpdatedAt: optionalNumber(raw.customIconUpdatedAt)
    } satisfies LoginItem;
  }

  if (kindFolder === "notes") {
    const data = parseNestedJson(raw.itemData);
    return {
      ...base,
      kind: "secure-note",
      content: Object.prototype.hasOwnProperty.call(data, "content") ? jsonScalarText(data.content) : stringValue(raw.notes),
      tags: parseStringArray(data.tags) || [],
      isMarkdown: Boolean(data.isMarkdown),
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies SecureNoteItem;
  }

  if (kindFolder === "authenticators") {
    const data = parseNestedJson(raw.itemData);
    const rawOtpType = stringValue(data.otpType);
    if (rawOtpType && !["TOTP", "HOTP", "STEAM", "YANDEX", "MOTP"].includes(rawOtpType)) return opaqueAndroidRecord(path, raw, providerId, "未知 OTP 类型，仅可读取原始数据。");
    const otpType = rawOtpType ? normalizeOtpType(rawOtpType) : undefined;
    const steamSharedSecret = firstString(data, "steamSharedSecretBase64");
    const steamSession = parseSteamSession(firstString(data, "steamRawJson"));
    return {
      ...base,
      kind: "totp",
      secret: otpType === "STEAM" || steamSharedSecret ? steamSharedSecret || firstString(data, "secret", "authenticatorKey") : firstString(data, "secret", "authenticatorKey"),
      issuer: firstString(data, "issuer") || undefined,
      accountName: firstString(data, "accountName") || undefined,
      otpType: otpType || (steamSharedSecret ? "STEAM" : undefined),
      counter: data.counter == null ? undefined : normalizeOtpCounter(data.counter),
      pin: optionalString(firstString(data, "pin")),
      link: optionalString(firstString(data, "link")),
      associatedApp: optionalString(firstString(data, "associatedApp")),
      customIconType: optionalString(firstString(data, "customIconType")),
      customIconValue: optionalString(firstString(data, "customIconValue")),
      customIconUpdatedAt: optionalNumber(data.customIconUpdatedAt),
      boundPasswordId: optionalNumber(data.boundPasswordId),
      categoryId: optionalNumber(data.categoryId),
      keepassDatabaseId: optionalNumber(data.keepassDatabaseId),
      steamFingerprint: optionalString(firstString(data, "steamFingerprint")),
      steamDeviceId: optionalString(firstString(data, "steamDeviceId")),
      steamSerialNumber: optionalString(firstString(data, "steamSerialNumber")),
      steamSharedSecretBase64: optionalString(steamSharedSecret),
      steamId: steamSession.steamId,
      steamAccessToken: steamSession.accessToken,
      steamRefreshToken: steamSession.refreshToken,
      steamLoginSecure: steamSession.loginSecure,
      steamRevocationCode: optionalString(firstString(data, "steamRevocationCode")),
      steamIdentitySecret: optionalString(firstString(data, "steamIdentitySecret")),
      steamTokenGid: optionalString(firstString(data, "steamTokenGid")),
      steamRawJson: optionalString(firstString(data, "steamRawJson")),
      algorithm: normalizeTotpAlgorithm(data.algorithm),
      digits: numberValue(data.digits, 6),
      period: numberValue(data.period, 30)
    } satisfies TotpItem;
  }

  if (kindFolder === "passkeys") {
    if (raw.signCount != null && optionalNumber(raw.signCount) === undefined) return opaqueAndroidRecord(path, raw, providerId, "Passkey 签名计数超出当前客户端范围，仅可读取原始数据。");
    const portableKey = options.allowPortablePasskeys ? parsePortablePasskeyPrivateKey(raw.privateKeyAlias) : undefined;
    return {
      ...base,
      kind: "passkey",
      credentialId: stringValue(raw.credentialId),
      rpId: stringValue(raw.rpId),
      rpName: stringValue(raw.rpName),
      userHandle: stringValue(raw.userId),
      userName: stringValue(raw.userName),
      userDisplayName: stringValue(raw.userDisplayName),
      algorithm: normalizePasskeyAlgorithm(raw.publicKeyAlgorithm),
      publicKey: stringValue(raw.publicKey),
      signCount: numberValue(raw.signCount, 0),
      backupEligible: typeof raw.backupEligible === "boolean" ? raw.backupEligible : undefined,
      backupState: typeof raw.backupState === "boolean" ? raw.backupState : undefined,
      discoverable: raw.isDiscoverable !== false,
      userVerificationRequired: raw.isUserVerificationRequired !== false,
      transports: (stringValue(raw.transports) || "internal").split(",").map((value) => value.trim()).filter(Boolean),
      aaguid: optionalString(raw.aaguid),
      lastUsedAt: dateValue(raw.lastUsedAt, base.updatedAt),
      useCount: numberValue(raw.useCount, 0),
      iconUrl: optionalString(raw.iconUrl),
      boundPasswordId: optionalNumber(raw.boundPasswordId),
      passkeyMode: normalizePasskeyMode(raw.passkeyMode),
      ...(portablePasskeyKeyMatchesAlgorithm(portableKey, numberValue(raw.publicKeyAlgorithm, -7))
        ? { privateKeyPkcs8: portableKey.pkcs8Base64, sourceMode: "browser-local" as const }
        : { sourceMode: "android-metadata-only" as const })
    } satisfies PasskeyItem;
  }

  const data = parseNestedJson(raw.itemData);
  if (kindFolder === "bank_cards") {
    return {
      ...base,
      kind: "card",
      cardholderName: firstString(data, "cardholderName"),
      number: firstString(data, "cardNumber", "number"),
      expiryMonth: firstString(data, "expiryMonth", "expMonth"),
      expiryYear: firstString(data, "expiryYear", "expYear"),
      securityCode: firstString(data, "cvv", "code"),
      brand: optionalString(firstString(data, "brand")),
      bankName: optionalString(firstString(data, "bankName")),
      cardType: normalizeCardType(data.cardType),
      billingAddress: optionalString(firstString(data, "billingAddress")),
      nickname: optionalString(firstString(data, "nickname")),
      validFromMonth: optionalString(firstString(data, "validFromMonth")),
      validFromYear: optionalString(firstString(data, "validFromYear")),
      pin: optionalString(firstString(data, "pin")),
      iban: optionalString(firstString(data, "iban")),
      swiftBic: optionalString(firstString(data, "swiftBic")),
      routingNumber: optionalString(firstString(data, "routingNumber")),
      accountNumber: optionalString(firstString(data, "accountNumber")),
      branchCode: optionalString(firstString(data, "branchCode")),
      currency: optionalString(firstString(data, "currency")),
      customerServicePhone: optionalString(firstString(data, "customerServicePhone")),
      cardFace: readCardFaceConfig(data.cardFace),
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies CardItem;
  }
  if (kindFolder === "documents") {
    const firstName = firstString(data, "firstName");
    const middleName = firstString(data, "middleName");
    const lastName = firstString(data, "lastName");
    const nameFromParts = [firstName, middleName, lastName].filter(Boolean).join(" ");
    return {
      ...base,
      kind: "identity",
      documentType: normalizeDocumentType(firstString(data, "documentType", "type")),
      documentNumber: firstString(data, "documentNumber", "number", "passportNumber", "licenseNumber", "driverLicense", "ssn"),
      firstName,
      middleName,
      lastName,
      fullName: Object.prototype.hasOwnProperty.call(data, "fullName") ? jsonScalarText(data.fullName) : nameFromParts || firstString(data, "name"),
      documentTitle: typeof data.title === "string" ? data.title : undefined,
      cardFace: readCardFaceConfig(data.cardFace),
      birthDate: optionalString(firstString(data, "birthDate")),
      issuedDate: optionalString(firstString(data, "issuedDate", "issueDate")),
      expiryDate: optionalString(firstString(data, "expiryDate")),
      issuedBy: optionalString(firstString(data, "issuedBy", "issuingAuthority")),
      nationality: optionalString(firstString(data, "nationality")),
      additionalInfo: optionalString(firstString(data, "additionalInfo")),
      company: optionalString(firstString(data, "company")),
      username: optionalString(firstString(data, "username")),
      ssn: optionalString(firstString(data, "ssn")),
      passportNumber: optionalString(firstString(data, "passportNumber")),
      licenseNumber: optionalString(firstString(data, "licenseNumber")),
      address3: optionalString(firstString(data, "address3")),
      email: optionalString(firstString(data, "email")),
      phone: optionalString(firstString(data, "phone", "phoneNumber")),
      address: {
        streetAddress: firstString(data, "address1", "streetAddress", "addressLine1"),
        apartment: firstString(data, "address2", "apartment", "addressLine2"),
        city: firstString(data, "city"),
        stateProvince: firstString(data, "stateProvince", "state", "province", "region"),
        postalCode: firstString(data, "postalCode", "zip", "zipCode"),
        country: firstString(data, "country"),
        company: firstString(data, "company"),
        email: firstString(data, "email"),
        phone: firstString(data, "phone", "phoneNumber")
      },
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies IdentityItem;
  }
  if (kindFolder === "billing_addresses") {
    return {
      ...base,
      kind: "billing-address",
      cardFace: readCardFaceConfig(data.cardFace),
      fullName: firstString(data, "fullName", "name"),
      company: firstString(data, "company", "organization"),
      streetAddress: firstString(data, "streetAddress", "address1", "addressLine1"),
      apartment: firstString(data, "apartment", "address2", "addressLine2"),
      city: firstString(data, "city"),
      stateProvince: firstString(data, "stateProvince", "state", "province", "region"),
      postalCode: firstString(data, "postalCode", "zip", "zipCode"),
      country: firstString(data, "country"),
      phone: firstString(data, "phone", "phoneNumber"),
      email: firstString(data, "email"),
      isDefault: Boolean(data.isDefault),
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies BillingAddressItem;
  }
  if (kindFolder === "payment_accounts") {
    return {
      ...base,
      kind: "payment-account",
      paymentType: normalizePaymentAccountType(firstString(data, "paymentType", "accountType", "type")),
      provider: firstString(data, "provider", "service", "brand", "network"),
      accountName: firstString(data, "accountName", "name", "nickname", "title"),
      accountHolderName: firstString(data, "accountHolderName", "holderName", "fullName", "nameOnAccount"),
      email: firstString(data, "email"),
      phone: firstString(data, "phone", "phoneNumber"),
      username: firstString(data, "username", "userName", "login"),
      accountId: firstString(data, "accountId", "accountIdentifier", "id"),
      maskedAccountNumber: firstString(data, "maskedAccountNumber", "maskedNumber", "accountNumber"),
      linkedCardLast4: optionalString(firstString(data, "linkedCardLast4")),
      routingNumber: firstString(data, "routingNumber"),
      iban: firstString(data, "iban"),
      swiftBic: firstString(data, "swiftBic", "swift", "bic"),
      website: firstString(data, "website", "url", "uri"),
      currency: firstString(data, "currency"),
      billingAddress: optionalString(firstString(data, "billingAddress")),
      paymentNotes: optionalString(firstString(data, "notes")),
      isDefault: Boolean(data.isDefault),
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies PaymentAccountItem;
  }
  return null;
}

function opaqueAndroidRecord(path: string, raw: Record<string, unknown>, providerId: string, reason: string, originalPayload = JSON.stringify(raw)): Extract<VaultItem, { kind: "opaque" }> {
  const parts = path.split("/");
  return { ...baseFields(path, raw, providerId), kind: "opaque", nativeType: typeof raw.itemType === "string" ? raw.itemType : parts[parts.length - 2] || "unknown", payloadSchemaVersion: optionalNumber(raw.version) ?? 1, originalPayload, readOnlyReason: reason };
}

function readAndroidTrash(
  entries: Record<string, Uint8Array>,
  providerId: string,
  options: AndroidBackupCodecOptions,
  items: VaultItem[],
  records: Map<string, AndroidBackupRecord>,
  warnings: string[]
): void {
  for (const path of ["trash/trash_passwords.json", "trash/trash_secure_items.json"] as const) {
    const bytes = entries[path];
    if (!bytes) continue;
    try {
      const values = parseLosslessJson(strFromU8(bytes)) as unknown;
      if (!Array.isArray(values)) throw new Error("回收站清单不是 JSON 数组");
      for (const value of values) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const raw = value as Record<string, unknown>;
        const id = jsonScalarText(raw.id);
        if (!/^-?\d+$/.test(id)) continue;
        const syntheticPath = path.endsWith("trash_passwords.json")
          ? `folders/_trash/passwords/password_${id}_0.json`
          : trashSecureSyntheticPath(id, stringValue(raw.itemType));
        const decoded = syntheticPath ? androidRecordToItem(syntheticPath, raw, providerId, options) : opaqueAndroidRecord(path, raw, providerId, "未知回收站项目类型，仅可读取原始数据。");
        if (!decoded) continue;
        const itemId = `android:${providerId}:${path}#${id}`;
        const item = {
          ...decoded,
          id: itemId,
          deletedAt: dateValue(raw.deletedAt, decoded.updatedAt),
          providerRefs: [{ providerId, remoteId: `${path}#${id}` }]
        } as VaultItem;
        items.push(item);
        records.set(itemId, { path, raw, itemId, item: cloneVaultItem(item), container: "json-array" });
      }
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : "无法解析"}`);
    }
  }
}

function trashSecureSyntheticPath(id: number | string, itemType: string): string | undefined {
  const mapping: Record<string, [string, string]> = {
    NOTE: ["notes", "note"],
    TOTP: ["authenticators", "totp"],
    BANK_CARD: ["bank_cards", "bank_card"],
    DOCUMENT: ["documents", "document"],
    BILLING_ADDRESS: ["billing_addresses", "billing_address"],
    PAYMENT_ACCOUNT: ["payment_accounts", "payment_account"]
  };
  const target = mapping[itemType.toUpperCase()];
  return target ? `folders/_trash/${target[0]}/${target[1]}_${id}_0.json` : undefined;
}

export function listAndroidPortableAttachments(document: AndroidBackupDocument, item: VaultItem): AndroidPortableAttachment[] {
  if (document.portableAttachmentsAllowed === false) return [];
  const manifest = parsePortableAttachmentManifest(document.entries[PORTABLE_ATTACHMENT_MANIFEST]);
  if (!manifest.length) return [];
  const record = document.records.get(item.id);
  const passwordOwner = item.kind === "login" || item.kind === "opaque" && Boolean(record?.path.match(/(?:^|\/)passwords\//i));
  const ids = new Set<string>();
  const rawId = portableParentId(record?.raw.id);
  if (rawId !== undefined) ids.add(String(rawId));
  // Raw record identity is authoritative. Filename fallback is only for legacy
  // callers without a bound record and never crosses the password/secure tables.
  else if (passwordOwner) for (const reference of item.providerRefs) {
    const match = reference.remoteId?.match(/(?:^|\/)passwords\/password_(-?\d+)(?:_\d+)?\.json$/i);
    const id = match ? portableParentId(match[1]) : undefined;
    if (id !== undefined) ids.add(String(id));
  }
  return manifest.filter(attachment => {
    const parent = passwordOwner ? attachment.parentPasswordId : attachment.parentSecureItemId;
    return parent !== undefined && ids.has(String(parent));
  });
}

export async function readAndroidPortableAttachment(document: AndroidBackupDocument, attachment: AndroidPortableAttachment): Promise<Uint8Array> {
  const bytes = document.entries[attachment.payloadPath];
  if (!bytes) throw new Error("Android portable 附件内容不存在。");
  if (bytes.byteLength !== attachment.sizeBytes) throw new Error("Android portable 附件大小校验失败。");
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== attachment.sha256Hex) throw new Error("Android portable 附件 SHA-256 校验失败。");
  return bytes.slice();
}

export function upsertAndroidPortableAttachment(document: AndroidBackupDocument, item: VaultItem, input: AndroidPortableAttachmentInput, bytes: Uint8Array): AndroidPortableAttachment {
  assertAndroidAttachmentWritable(document, item);
  if (bytes.byteLength !== input.sizeBytes) throw new Error("Android portable 附件大小与上传内容不一致。");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > PORTABLE_ATTACHMENT_MAX_BYTES) throw new Error("Android portable 附件大小无效。");
  if (!/^[0-9a-f]{64}$/i.test(input.sha256Hex)) throw new Error("Android portable 附件 SHA-256 无效。");
  const manifest = readPortableManifestForWrite(document.entries[PORTABLE_ATTACHMENT_MANIFEST]);
  const existing = input.attachmentId ? manifest.entries.find((entry) => `android-portable:${entry.payloadPath}` === input.attachmentId) : undefined;
  if (input.attachmentId && (!existing || !listAndroidPortableAttachments(document, item).some((entry) => entry.attachmentId === input.attachmentId))) {
    throw new Error("要替换的 Android portable 附件不存在或不属于当前项目。");
  }
  const payloadPath = existing?.payloadPath || `attachments_portable/${portablePayloadName()}.bin`;
  const owner = portableOwner(item, document.records.get(item.id)?.raw.id);
  const entry: AndroidPortableAttachment = {
    attachmentId: `android-portable:${payloadPath}`,
    ...owner,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256Hex: input.sha256Hex.toLowerCase(),
    payloadPath,
    createdAt: input.createdAt || existing?.createdAt || Date.now(),
    updatedAt: input.updatedAt || Date.now()
  };
  const nextEntries = manifest.rawEntries.filter((candidate) => {
    const payload = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>).payloadPath : undefined;
    return payload !== payloadPath;
  });
  nextEntries.push({ ...entry,
    ...(entry.parentPasswordId === undefined ? {} : { parentPasswordId: parseLosslessJson(String(entry.parentPasswordId)) }),
    ...(entry.parentSecureItemId === undefined ? {} : { parentSecureItemId: parseLosslessJson(String(entry.parentSecureItemId)) })
  });
  document.entries[payloadPath] = bytes.slice();
  document.entries[PORTABLE_ATTACHMENT_MANIFEST] = strToU8(JSON.stringify({ ...manifest.root, version: 2, entries: nextEntries }));
  return entry;
}

export function deleteAndroidPortableAttachment(document: AndroidBackupDocument, item: VaultItem, attachmentId: string): boolean {
  assertAndroidAttachmentWritable(document, item);
  const manifest = readPortableManifestForWrite(document.entries[PORTABLE_ATTACHMENT_MANIFEST]);
  const target = manifest.entries.find((entry) => `android-portable:${entry.payloadPath}` === attachmentId);
  if (!target || !listAndroidPortableAttachments(document, item).some((entry) => entry.attachmentId === attachmentId)) return false;
  delete document.entries[target.payloadPath];
  const entries = manifest.rawEntries.filter((entry) => {
    const payload = entry && typeof entry === "object" ? (entry as Record<string, unknown>).payloadPath : undefined;
    return payload !== target.payloadPath;
  });
  document.entries[PORTABLE_ATTACHMENT_MANIFEST] = strToU8(JSON.stringify({ ...manifest.root, version: 2, entries }));
  return true;
}

function assertAndroidAttachmentWritable(document: AndroidBackupDocument, item: VaultItem): void {
  if (item.kind === "opaque" || document.records.get(item.id)?.item.kind === "opaque") throw new Error("未知类型或损坏记录的附件仅可只读查看，不能上传或删除。");
}

function parsePortableAttachmentManifest(bytes?: Uint8Array): AndroidPortableAttachment[] {
  if (!bytes) return [];
  let raw: unknown;
  try { raw = parseLosslessJson(strFromU8(bytes)); } catch { return []; }
  const result: AndroidPortableAttachment[] = [];
  const entries: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).entries)
    ? (raw as Record<string, unknown>).entries as unknown[]
    : [];
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const payloadPath = typeof record.payloadPath === "string" ? record.payloadPath : "";
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const sha256Hex = typeof record.sha256Hex === "string" ? record.sha256Hex.toLowerCase() : "";
    const sizeBytes = typeof record.sizeBytes === "number" ? record.sizeBytes : NaN;
    if (!PORTABLE_ATTACHMENT_PATH.test(payloadPath) || !fileName || !/^[0-9a-f]{64}$/.test(sha256Hex)) continue;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > PORTABLE_ATTACHMENT_MAX_BYTES) continue;
    const parentPasswordId = portableParentId(record.parentPasswordId);
    const secureId = portableParentId(record.parentSecureItemId);
    const parentSecureItemId = secureId !== undefined && BigInt(secureId) > 0n ? secureId : undefined;
    if ((parentPasswordId === undefined) === (parentSecureItemId === undefined)) continue;
    result.push({
      attachmentId: `android-portable:${payloadPath}`,
      parentPasswordId,
      parentSecureItemId,
      fileName,
      mimeType: typeof record.mimeType === "string" && record.mimeType ? record.mimeType : undefined,
      sizeBytes,
      sha256Hex,
      payloadPath,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : undefined,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : undefined
    });
  }
  return result;
}

function readPortableManifestForWrite(bytes?: Uint8Array): { root: Record<string, unknown>; entries: AndroidPortableAttachment[]; rawEntries: unknown[] } {
  if (!bytes) return { root: {}, entries: [], rawEntries: [] };
  try {
    const parsed = parseLosslessJson(strFromU8(bytes)) as unknown;
    if (!isJsonObject(parsed)) throw new Error("Android portable 附件清单不是对象。");
    const root = parsed as Record<string, unknown>;
    if (![1, 2].includes(root.version as number) || !Array.isArray(root.entries)) throw new Error("Android portable 附件清单版本或条目无效。");
    const rawEntries = root.entries;
    return { root, entries: parsePortableAttachmentManifest(bytes), rawEntries };
  } catch {
    throw new Error("Android portable 附件清单损坏或版本不受支持，原始数据未修改。");
  }
}

function portableOwner(item: VaultItem, rawId: unknown): Pick<AndroidPortableAttachment, "parentPasswordId" | "parentSecureItemId"> {
  const id = portableParentId(rawId);
  if (id === undefined || BigInt(id) <= 0n) throw new Error("Android 项目缺少可关联的数字 ID，无法写入 portable 附件。");
  return item.kind === "login" ? { parentPasswordId: id } : { parentSecureItemId: id };
}

function portableParentId(value: unknown): number | string | undefined {
  if (value === undefined || value === null || typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
  const text = jsonScalarText(value);
  if (!/^-?(?:0|[1-9]\d*)$/.test(text)) return undefined;
  const integer = BigInt(text);
  if (integer < -9223372036854775808n || integer > 9223372036854775807n) return undefined;
  const number = Number(integer);
  return Number.isSafeInteger(number) ? number : text;
}

function portablePayloadName(): string {
  return btoa(crypto.randomUUID()).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function readAndroidPasswordHistory(
  entries: Record<string, Uint8Array>,
  items: VaultItem[],
  records: Map<string, AndroidBackupRecord>,
  warnings: string[]
): unknown[] {
  const path = Object.keys(entries).find((entry) => entry.toLowerCase() === "password_history.json");
  if (!path) return [];
  let raw: unknown;
  try { raw = parseLosslessJson(strFromU8(entries[path])); }
  catch {
    warnings.push("password_history.json: 无法解析，原始条目已保留。");
    for (const item of items) if (item.kind === 'login') item.passwordHistoryIncomplete = true;
    return [];
  }
  if (!Array.isArray(raw) || raw.length > 100_000) {
    warnings.push("password_history.json: 历史列表格式无效或过大，原始条目已保留。");
    for (const item of items) if (item.kind === 'login') item.passwordHistoryIncomplete = true;
    return [];
  }
  const loginsByEntryId = new Map<string, LoginItem>();
  for (const item of items) {
    if (item.kind !== "login") continue;
    const record = records.get(item.id);
    const entryId = record ? passwordHistoryOwner(record.raw.id) : undefined;
    if (entryId !== undefined) loginsByEntryId.set(entryId, item);
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const entryId = passwordHistoryOwner(value.entryId);
    const password = typeof value.password === "string" ? value.password : undefined;
    const lastUsedAt = dateValue(value.lastUsedAt, "");
    const login = entryId === undefined ? undefined : loginsByEntryId.get(entryId);
    if (!login) continue;
    if (password === undefined || !lastUsedAt) { login.passwordHistoryIncomplete = true; continue; }
    const history = login.passwordHistory || [];
    if (history.length < 1_000) login.passwordHistory = [...history, { password, lastUsedAt }];
    else login.passwordHistoryIncomplete = true;
  }
  return raw;
}

function readAndroidGeneratorHistory(entries: Record<string, Uint8Array>, warnings: string[]): AndroidGeneratorHistoryRecord[] {
  const records: AndroidGeneratorHistoryRecord[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.toLowerCase().endsWith(GENERATOR_HISTORY_SUFFIX)) continue;
    try {
      const parsed = parseLosslessJson(strFromU8(bytes)) as unknown;
      if (!Array.isArray(parsed) || parsed.length > GENERATOR_HISTORY_MAX_ENTRIES) {
        throw new Error("历史列表格式无效或过大");
      }
      records.push({ path, values: parsed });
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : "无法解析"}，原始条目已保留。`);
    }
  }
  return records;
}

function writeAndroidPasswordHistory(document: AndroidBackupDocument, items: VaultItem[], entries: Record<string, Uint8Array>): void {
  const original = document.passwordHistoryRaw || [];
  const replacements = new Map<string, { entryId: unknown; previous: NonNullable<LoginItem['passwordHistory']>; next: NonNullable<LoginItem['passwordHistory']> }>();
  for (const item of items) {
    if (item.kind !== "login") continue;
    const record = document.records.get(item.id);
    const entryId = record ? record.raw.id : numericId(item);
    if (!record) assertPortablePasswordHistory(item);
    const owner = passwordHistoryOwner(entryId);
    if (owner === undefined) continue;
    const previous = record?.item.kind === "login" ? record.item : undefined;
    let history = item.passwordHistory || [];
    // Direct codec callers may edit a password without going through the vault
    // service. Already captured/explicitly edited histories must not be captured twice.
    if (previous && JSON.stringify(history) === JSON.stringify(previous.passwordHistory || []))
      history = capturePasswordHistory(previous, item, item.updatedAt).passwordHistory || [];
    if (JSON.stringify(history) !== JSON.stringify(previous?.passwordHistory || []))
      replacements.set(owner, { entryId, previous: previous?.passwordHistory || [], next: history });
  }
  if (!replacements.size) return;
  const paths = Object.keys(entries).filter(path => path.toLowerCase() === 'password_history.json');
  const path = paths[0] || 'password_history.json';
  if (paths.length > 1) throw new Error('密码历史文件重复，原始备份已保留。');
  if (paths.length) {
    let raw: unknown;
    try { raw = parseLosslessJson(strFromU8(entries[path])); } catch { /* fail below without rewriting */ }
    if (!Array.isArray(raw) || raw.length > 100_000) throw new Error('密码历史无法安全读取，原始备份已保留。');
  }
  const retained = [...original];
  for (const [owner, { entryId, previous, next }] of replacements) {
    // Only replace rows that were actually projected. Unknown/malformed rows
    // and rows beyond the projection limit stay in the original archive.
    const pool: Record<string, unknown>[] = [];
    for (const value of previous) {
      const index = retained.findIndex(entry => historyRowMatches(entry, owner, value));
      if (index >= 0) pool.push(retained.splice(index, 1)[0] as Record<string, unknown>);
    }
    const rebuilt = next.map(value => {
      const index = pool.findIndex(entry => historyRowMatches(entry, owner, value));
      if (index >= 0) return pool.splice(index, 1)[0];
      const lastUsedAt = Date.parse(value.lastUsedAt);
      if (!Number.isFinite(lastUsedAt)) throw new Error('密码历史时间无效，原始备份已保留。');
      return { entryId, password: value.password, lastUsedAt };
    });
    retained.unshift(...rebuilt);
    if (retained.length > 100_000) {
      throw new Error('密码历史超出备份支持的数量，原始备份已保留。');
    }
  }
  entries[path] = strToU8(JSON.stringify(retained));
}

function passwordHistoryOwner(value: unknown): string | undefined {
  const text = jsonScalarText(value);
  return /^-?\d+$/.test(text) ? BigInt(text).toString() : undefined;
}

function historyRowMatches(entry: unknown, owner: string, value: { password: string; lastUsedAt: string }): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const raw = entry as Record<string, unknown>;
  return passwordHistoryOwner(raw.entryId) === owner && raw.password === value.password && dateValue(raw.lastUsedAt, '') === value.lastUsedAt;
}

export function vaultItemToAndroidRecord(item: VaultItem, original?: Record<string, unknown>, originalItem?: VaultItem): Record<string, unknown> | null {
  return serializeAndroidItem(item, original, originalItem)?.raw || null;
}

function baseFields(path: string, raw: Record<string, unknown>, providerId: string) {
  const createdAt = dateValue(raw.createdAt);
  const updatedAt = dateValue(raw.updatedAt, createdAt);
  return {
    id: `android:${providerId}:${path}`,
    title: stringValue(raw.title) || stringValue(raw.rpName) || "未命名项目",
    favorite: Boolean(raw.isFavorite),
    notes: stringValue(raw.notes),
    createdAt,
    updatedAt,
    deletedAt: Boolean(raw.isDeleted) ? dateValue(raw.deletedAt, updatedAt) : undefined,
    archivedAt: Boolean(raw.isArchived) ? dateValue(raw.archivedAt, updatedAt) : undefined,
    categoryId: optionalNumber(raw.categoryId),
    categoryName: optionalString(raw.categoryName),
    sortOrder: optionalNumber(raw.sortOrder),
    imagePaths: parseStringArray(raw.imagePaths),
    boundNoteId: optionalNumber(raw.boundNoteId),
    boundNoteEntryId: optionalString(raw.boundNoteEntryId),
    replicaGroupId: optionalString(raw.replicaGroupId ?? raw.replica_group_id),
    keepassDatabaseId: optionalNumber(raw.keepassDatabaseId),
    keepassGroupPath: optionalString(raw.keepassGroupPath),
    keepassEntryUuid: optionalString(raw.keepassEntryUuid ?? raw.keepass_entry_uuid),
    keepassGroupUuid: optionalString(raw.keepassGroupUuid ?? raw.keepass_group_uuid),
    mdbxDatabaseId: optionalNumber(raw.mdbxDatabaseId ?? raw.mdbx_database_id),
    mdbxFolderId: optionalString(raw.mdbxFolderId ?? raw.mdbx_folder_id),
    providerRefs: [{ providerId, remoteId: path }] as ProviderReference[]
  };
}

function serializeAndroidItem(item: VaultItem, original?: Record<string, unknown>, originalItem?: VaultItem, options: AndroidBackupCodecOptions = {}): { id: number | string; raw: Record<string, unknown> } | null {
  // Android API tokens are native MDBX2 objects, not Room password backup rows.
  if (item.kind === "api-token" || item.kind === "opaque") throw new Error(`Android JSON 备份没有 ${item.kind} 的无损写入格式，请保留原数据库或使用 MDBX 同步。`);
  const originalId = original?.id;
  const id: number | string = originalId === undefined ? numericId(item) : typeof originalId === "number" ? originalId : jsonScalarText(originalId);
  const raw: Record<string, unknown> = { ...(original || {}) };
  const isNew = !original || !originalItem;
  const setChanged = (key: string, value: unknown, current: unknown, previous: unknown) => {
    if (isNew || !sameValue(current, previous)) raw[key] = value;
  };
  const setNested = (updates: Record<string, unknown>, key: string, value: unknown, current: unknown, previous: unknown) => {
    if (isNew || !sameValue(current, previous)) updates[key] = value;
  };
  const applyCommon = (expectedKind: VaultItem["kind"], itemType?: string) => {
    const previous = originalItem?.kind === expectedKind ? originalItem : undefined;
    if (isNew) {
      raw.id = id;
      if (itemType) raw.itemType = itemType;
    }
    setChanged("title", item.title, item.title, previous?.title);
    setChanged("notes", item.notes, item.notes, previous?.notes);
    setChanged("isFavorite", item.favorite, item.favorite, previous?.favorite);
    setChanged("sortOrder", item.sortOrder || 0, item.sortOrder, previous?.sortOrder);
    setChanged("categoryId", item.categoryId ?? null, item.categoryId, previous?.categoryId);
    setChanged("categoryName", item.categoryName ?? null, item.categoryName, previous?.categoryName);
    setChanged("imagePaths", JSON.stringify(item.imagePaths || []), item.imagePaths || [], previous?.imagePaths || []);
    setChanged("isDeleted", Boolean(item.deletedAt), item.deletedAt, previous?.deletedAt);
    setChanged("deletedAt", item.deletedAt ? Date.parse(item.deletedAt) : null, item.deletedAt, previous?.deletedAt);
    setChanged("isArchived", Boolean(item.archivedAt), item.archivedAt, previous?.archivedAt);
    setChanged("archivedAt", item.archivedAt ? Date.parse(item.archivedAt) : null, item.archivedAt, previous?.archivedAt);
    setChanged("boundNoteId", item.boundNoteId ?? null, item.boundNoteId, previous?.boundNoteId);
    setChanged("boundNoteEntryId", item.boundNoteEntryId ?? null, item.boundNoteEntryId, previous?.boundNoteEntryId);
    setChanged("replicaGroupId", item.replicaGroupId ?? null, item.replicaGroupId, previous?.replicaGroupId);
    setChanged("keepassDatabaseId", item.keepassDatabaseId ?? null, item.keepassDatabaseId, previous?.keepassDatabaseId);
    setChanged("keepassGroupPath", item.keepassGroupPath ?? null, item.keepassGroupPath, previous?.keepassGroupPath);
    setChanged("keepassEntryUuid", item.keepassEntryUuid ?? null, item.keepassEntryUuid, previous?.keepassEntryUuid);
    setChanged("keepassGroupUuid", item.keepassGroupUuid ?? null, item.keepassGroupUuid, previous?.keepassGroupUuid);
    setChanged("mdbxDatabaseId", item.mdbxDatabaseId ?? null, item.mdbxDatabaseId, previous?.mdbxDatabaseId);
    setChanged("mdbxFolderId", item.mdbxFolderId ?? null, item.mdbxFolderId, previous?.mdbxFolderId);
    setChanged("createdAt", Date.parse(item.createdAt) || Date.now(), item.createdAt, previous?.createdAt);
    setChanged("updatedAt", Date.parse(item.updatedAt) || Date.now(), item.updatedAt, previous?.updatedAt);
    return previous;
  };
  const applyNested = (updates: Record<string, unknown>) => {
    if ((item.kind === "card" || item.kind === "identity" || item.kind === "billing-address") && (!originalItem || JSON.stringify(item.cardFace) !== JSON.stringify((originalItem as CardItem).cardFace))) updates.cardFace = item.cardFace ?? null;
    if (item.kind === "identity" && (!originalItem || item.documentTitle !== (originalItem as IdentityItem).documentTitle)) updates.title = item.documentTitle || "";
    if (Object.keys(updates).length > 0) raw.itemData = mergeNestedItemData(original?.itemData, updates);
  };

  switch (item.kind) {
    case "login": {
      const previous = applyCommon("login") as LoginItem | undefined;
      setChanged("username", item.username, item.username, previous?.username);
      setChanged("password", item.password, item.password, previous?.password);
      setChanged("website", item.uris.join("\n"), item.uris, previous?.uris);
      setChanged("authenticatorKey", item.totpSecret || "", item.totpSecret || "", previous?.totpSecret || "");
      setChanged("loginType", item.loginType || "PASSWORD", item.loginType || "PASSWORD", previous?.loginType || "PASSWORD");
      setChanged("passwordGroupId", item.passwordGroupId ?? null, item.passwordGroupId, previous?.passwordGroupId);
      // Absent and unfamiliar values survive unrelated edits; false is an explicit unpin.
      if (item.isGroupCover !== undefined || previous?.isGroupCover !== undefined) {
        if (original?.isGroupCover != null && typeof original.isGroupCover !== "boolean" && item.isGroupCover !== previous?.isGroupCover) {
          throw new Error("封面字段版本未知，无法安全修改。请保留原始数据。");
        }
        setChanged("isGroupCover", item.isGroupCover ?? false, item.isGroupCover, previous?.isGroupCover);
      }
      setChanged("ssoProvider", item.ssoProvider || "", item.ssoProvider || "", previous?.ssoProvider || "");
      setChanged("ssoRefEntryId", item.ssoRefEntryId ?? null, item.ssoRefEntryId, previous?.ssoRefEntryId);
      setChanged("ssoRefLogicalId", item.ssoRefLogicalId ?? null, item.ssoRefLogicalId, previous?.ssoRefLogicalId);
      for (const key of ["appPackageName", "appName", "email", "phone", "addressLine", "city", "state", "zipCode", "country", "creditCardNumber", "creditCardHolder", "creditCardExpiry", "creditCardCVV", "passkeyBindings", "sshKeyData", "wifiMetadata", "barcodeData", "customIconType", "customIconValue"] as const) {
        setChanged(key, item[key] || "", item[key] || "", previous?.[key] || "");
      }
      setChanged("customIconUpdatedAt", item.customIconUpdatedAt || 0, item.customIconUpdatedAt, previous?.customIconUpdatedAt);
      const customFields = item.customFields.map((field) => ({ title: field.name, value: field.value, isProtected: field.protected }));
      if (isNew || !sameValue(item.customFields, previous?.customFields)) raw.customFields = mergePasswordCustomFields(original?.customFields, customFields);
      return { id, raw };
    }
    case "secure-note": {
      const previous = applyCommon("secure-note", "NOTE") as SecureNoteItem | undefined;
      const updates: Record<string, unknown> = {};
      setNested(updates, "content", item.content, item.content, previous?.content);
      setNested(updates, "tags", item.tags || [], item.tags || [], previous?.tags || []);
      setNested(updates, "isMarkdown", Boolean(item.isMarkdown), Boolean(item.isMarkdown), Boolean(previous?.isMarkdown));
      setNested(updates, "customFields", serializeSecureCustomFields(item.customFields), item.customFields || [], previous?.customFields || []);
      applyNested(updates);
      return { id, raw };
    }
    case "totp": {
      const previous = applyCommon("totp", "TOTP") as TotpItem | undefined;
      const updates: Record<string, unknown> = {};
      const setOptionalNested = (key: string, value: unknown, current: unknown, previousValue: unknown) => {
        if (current !== undefined || previousValue !== undefined) setNested(updates, key, value, current, previousValue);
      };
      setNested(updates, "secret", item.secret, item.secret, previous?.secret);
      setNested(updates, "issuer", item.issuer || "", item.issuer || "", previous?.issuer || "");
      setNested(updates, "accountName", item.accountName || "", item.accountName || "", previous?.accountName || "");
      setOptionalNested("otpType", item.otpType, item.otpType, previous?.otpType);
      setOptionalNested("counter", item.counter === undefined ? undefined : otpCounterJson(item.counter), item.counter, previous?.counter);
      setOptionalNested("pin", item.pin, item.pin, previous?.pin);
      setOptionalNested("link", item.link, item.link, previous?.link);
      setOptionalNested("associatedApp", item.associatedApp, item.associatedApp, previous?.associatedApp);
      setOptionalNested("customIconType", item.customIconType, item.customIconType, previous?.customIconType);
      setOptionalNested("customIconValue", item.customIconValue, item.customIconValue, previous?.customIconValue);
      setOptionalNested("customIconUpdatedAt", item.customIconUpdatedAt, item.customIconUpdatedAt, previous?.customIconUpdatedAt);
      setOptionalNested("boundPasswordId", item.boundPasswordId, item.boundPasswordId, previous?.boundPasswordId);
      setOptionalNested("categoryId", item.categoryId, item.categoryId, previous?.categoryId);
      setOptionalNested("keepassDatabaseId", item.keepassDatabaseId, item.keepassDatabaseId, previous?.keepassDatabaseId);
      setOptionalNested("steamFingerprint", item.steamFingerprint, item.steamFingerprint, previous?.steamFingerprint);
      setOptionalNested("steamDeviceId", item.steamDeviceId, item.steamDeviceId, previous?.steamDeviceId);
      setOptionalNested("steamSerialNumber", item.steamSerialNumber, item.steamSerialNumber, previous?.steamSerialNumber);
      setOptionalNested("steamSharedSecretBase64", item.steamSharedSecretBase64, item.steamSharedSecretBase64, previous?.steamSharedSecretBase64);
      setOptionalNested("steamRevocationCode", item.steamRevocationCode, item.steamRevocationCode, previous?.steamRevocationCode);
      setOptionalNested("steamIdentitySecret", item.steamIdentitySecret, item.steamIdentitySecret, previous?.steamIdentitySecret);
      setOptionalNested("steamTokenGid", item.steamTokenGid, item.steamTokenGid, previous?.steamTokenGid);
      setOptionalNested("steamRawJson", item.steamRawJson, item.steamRawJson, previous?.steamRawJson);
      setNested(updates, "algorithm", item.algorithm, item.algorithm, previous?.algorithm);
      setNested(updates, "digits", item.digits, item.digits, previous?.digits);
      setNested(updates, "period", item.period, item.period, previous?.period);
      applyNested(updates);
      return { id, raw };
    }
    case "card": {
      const previous = applyCommon("card", "BANK_CARD") as CardItem | undefined;
      const updates: Record<string, unknown> = {};
      setNested(updates, "cardholderName", item.cardholderName, item.cardholderName, previous?.cardholderName);
      setNested(updates, "cardNumber", item.number, item.number, previous?.number);
      setNested(updates, "expiryMonth", item.expiryMonth, item.expiryMonth, previous?.expiryMonth);
      setNested(updates, "expiryYear", item.expiryYear, item.expiryYear, previous?.expiryYear);
      setNested(updates, "cvv", item.securityCode, item.securityCode, previous?.securityCode);
      setNested(updates, "brand", item.brand || "", item.brand || "", previous?.brand || "");
      for (const key of ["bankName", "billingAddress", "nickname", "validFromMonth", "validFromYear", "pin", "iban", "swiftBic", "routingNumber", "accountNumber", "branchCode", "currency", "customerServicePhone"] as const) {
        setNested(updates, key, item[key] || "", item[key] || "", previous?.[key] || "");
      }
      setNested(updates, "cardType", item.cardType || "CREDIT", item.cardType || "CREDIT", previous?.cardType || "CREDIT");
      setNested(updates, "customFields", serializeSecureCustomFields(item.customFields), item.customFields || [], previous?.customFields || []);
      applyNested(updates);
      return { id, raw };
    }
    case "identity": {
      const previous = applyCommon("identity", "DOCUMENT") as IdentityItem | undefined;
      const updates: Record<string, unknown> = {};
      setNested(updates, "documentType", item.documentType, item.documentType, previous?.documentType);
      setNested(updates, "documentNumber", item.documentNumber, item.documentNumber, previous?.documentNumber);
      setNested(updates, "firstName", item.firstName, item.firstName, previous?.firstName);
      setNested(updates, "middleName", item.middleName, item.middleName, previous?.middleName);
      setNested(updates, "lastName", item.lastName, item.lastName, previous?.lastName);
      setNested(updates, "fullName", item.fullName, item.fullName, previous?.fullName);
      setNested(updates, "birthDate", item.birthDate || "", item.birthDate || "", previous?.birthDate || "");
      setNested(updates, "issuedDate", item.issuedDate || "", item.issuedDate || "", previous?.issuedDate || "");
      setNested(updates, "expiryDate", item.expiryDate || "", item.expiryDate || "", previous?.expiryDate || "");
      setNested(updates, "issuedBy", item.issuedBy || "", item.issuedBy || "", previous?.issuedBy || "");
      setNested(updates, "nationality", item.nationality || "", item.nationality || "", previous?.nationality || "");
      for (const key of ["additionalInfo", "company", "username", "ssn", "passportNumber", "licenseNumber", "address3"] as const) {
        setNested(updates, key, item[key] || "", item[key] || "", previous?.[key] || "");
      }
      setNested(updates, "email", item.email || "", item.email || "", previous?.email || "");
      setNested(updates, "phone", item.phone || "", item.phone || "", previous?.phone || "");
      setNested(updates, "address1", item.address?.streetAddress || "", item.address?.streetAddress || "", previous?.address?.streetAddress || "");
      setNested(updates, "address2", item.address?.apartment || "", item.address?.apartment || "", previous?.address?.apartment || "");
      setNested(updates, "city", item.address?.city || "", item.address?.city || "", previous?.address?.city || "");
      setNested(updates, "stateProvince", item.address?.stateProvince || "", item.address?.stateProvince || "", previous?.address?.stateProvince || "");
      setNested(updates, "postalCode", item.address?.postalCode || "", item.address?.postalCode || "", previous?.address?.postalCode || "");
      setNested(updates, "country", item.address?.country || "", item.address?.country || "", previous?.address?.country || "");
      setNested(updates, "customFields", serializeSecureCustomFields(item.customFields), item.customFields || [], previous?.customFields || []);
      applyNested(updates);
      return { id, raw };
    }
    case "billing-address": {
      const previous = applyCommon("billing-address", "BILLING_ADDRESS") as BillingAddressItem | undefined;
      const updates: Record<string, unknown> = {};
      for (const key of ["fullName", "company", "streetAddress", "apartment", "city", "stateProvince", "postalCode", "country", "phone", "email"] as const) {
        setNested(updates, key, item[key], item[key], previous?.[key]);
      }
      setNested(updates, "isDefault", Boolean(item.isDefault), Boolean(item.isDefault), Boolean(previous?.isDefault));
      setNested(updates, "customFields", serializeSecureCustomFields(item.customFields), item.customFields || [], previous?.customFields || []);
      applyNested(updates);
      return { id, raw };
    }
    case "payment-account": {
      const previous = applyCommon("payment-account", "PAYMENT_ACCOUNT") as PaymentAccountItem | undefined;
      const updates: Record<string, unknown> = {};
      for (const key of ["paymentType", "provider", "accountName", "accountHolderName", "email", "phone", "username", "accountId", "maskedAccountNumber", "routingNumber", "iban", "swiftBic", "website", "currency"] as const) {
        setNested(updates, key, item[key], item[key], previous?.[key]);
      }
      for (const key of ["linkedCardLast4", "billingAddress"] as const) setNested(updates, key, item[key] || "", item[key] || "", previous?.[key] || "");
      setNested(updates, "notes", item.paymentNotes || "", item.paymentNotes || "", previous?.paymentNotes || "");
      setNested(updates, "isDefault", Boolean(item.isDefault), Boolean(item.isDefault), Boolean(previous?.isDefault));
      setNested(updates, "customFields", serializeSecureCustomFields(item.customFields), item.customFields || [], previous?.customFields || []);
      applyNested(updates);
      return { id, raw };
    }
    case "passkey": {
      const previous = originalItem?.kind === "passkey" ? originalItem : undefined;
      setChanged("credentialId", item.credentialId, item.credentialId, previous?.credentialId);
      setChanged("rpId", item.rpId, item.rpId, previous?.rpId);
      setChanged("rpName", item.rpName, item.rpName, previous?.rpName);
      setChanged("userId", item.userHandle, item.userHandle, previous?.userHandle);
      setChanged("userName", item.userName, item.userName, previous?.userName);
      setChanged("userDisplayName", item.userDisplayName, item.userDisplayName, previous?.userDisplayName);
      setChanged("publicKeyAlgorithm", item.algorithm, item.algorithm, previous?.algorithm);
      setChanged("publicKey", item.publicKey, item.publicKey, previous?.publicKey);
      setChanged("createdAt", Date.parse(item.createdAt) || Date.now(), item.createdAt, previous?.createdAt);
      setChanged("signCount", item.signCount, item.signCount, previous?.signCount);
      if (typeof item.backupEligible === "boolean") setChanged("backupEligible", item.backupEligible, item.backupEligible, previous?.backupEligible);
      if (typeof item.backupState === "boolean") setChanged("backupState", item.backupState, item.backupState, previous?.backupState);
      setChanged("isDiscoverable", item.discoverable, item.discoverable, previous?.discoverable);
      setChanged("lastUsedAt", Date.parse(item.lastUsedAt || item.updatedAt) || Date.now(), item.lastUsedAt, previous?.lastUsedAt);
      setChanged("useCount", item.useCount || 0, item.useCount, previous?.useCount);
      setChanged("iconUrl", item.iconUrl ?? null, item.iconUrl, previous?.iconUrl);
      setChanged("isUserVerificationRequired", item.userVerificationRequired !== false, item.userVerificationRequired, previous?.userVerificationRequired);
      setChanged("transports", (item.transports || ["internal"]).join(","), item.transports || [], previous?.transports || []);
      setChanged("aaguid", item.aaguid || "", item.aaguid, previous?.aaguid);
      setChanged("boundPasswordId", item.boundPasswordId ?? null, item.boundPasswordId, previous?.boundPasswordId);
      setChanged("passkeyMode", item.passkeyMode || "BW_COMPAT", item.passkeyMode, previous?.passkeyMode);
      setChanged("notes", item.notes, item.notes, previous?.notes);
      const portableKey = options.allowPortablePasskeys ? parsePortablePasskeyPrivateKey(item.privateKeyPkcs8) : undefined;
      const portableValue = portablePasskeyKeyMatchesAlgorithm(portableKey, item.algorithm) ? portableKey.pkcs8Base64 : "";
      if (portableValue) raw.privateKeyAlias = portableValue;
      else if (original && sameValue(item.privateKeyPkcs8, previous?.privateKeyPkcs8)) { /* Existing metadata is retained byte-for-byte; it does not acquire signing capability. */ }
      else if (options.allowMetadataOnlyPasskeys) raw.privateKeyAlias = "";
      else throw new Error("此 Passkey 没有可导出的私钥，不能创建完整 Android 备份。请使用明确的仅元数据导出流程。");
      if (isNew) {
        raw.categoryName = item.categoryName ?? null;
      }
      return { id: item.credentialId, raw };
    }
  }
}

function normalizePasskeyMode(value: unknown): PasskeyItem["passkeyMode"] {
  const mode = stringValue(value).toUpperCase();
  return mode === "BW_COMPAT" || mode === "KEEPASS_COMPAT" ? mode : "LEGACY";
}

function sameWritableItem(left: VaultItem, right: VaultItem): boolean {
  const { providerRefs: _leftProviderRefs, ...leftPayload } = left;
  const { providerRefs: _rightProviderRefs, ...rightPayload } = right;
  return sameValue(leftPayload, rightPayload);
}

function cloneVaultItem(item: VaultItem): VaultItem {
  return parseLosslessJson(JSON.stringify(item)) as VaultItem;
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function providerPath(item: VaultItem, id: number | string): string {
  const millis = Date.parse(item.createdAt) || Date.now();
  const mapping: Partial<Record<VaultItem["kind"], [string, string]>> = {
    login: ["passwords", "password"],
    "secure-note": ["notes", "note"],
    totp: ["authenticators", "totp"],
    card: ["bank_cards", "bank_card"],
    identity: ["documents", "document"],
    "billing-address": ["billing_addresses", "billing_address"],
    "payment-account": ["payment_accounts", "payment_account"],
    passkey: ["passkeys", "passkey"]
  };
  const location = mapping[item.kind];
  if (!location) throw new Error("此项目类型不属于 Android JSON 备份，请使用 MDBX2 同步。");
  const [folder, prefix] = location;
  const safeId = String(id).replace(/\//g, "_");
  const folderKey = androidFolderKey(item.categoryName);
  if (item.kind === "passkey") return `folders/${folderKey}/${folder}/${prefix}_${safeId}.json`;
  return `folders/${folderKey}/${folder}/${prefix}_${safeId}_${millis}.json`;
}

function trashPath(item: VaultItem): string {
  return item.kind === "login" ? "trash/trash_passwords.json" : "trash/trash_secure_items.json";
}

function updateAndroidArrayEntry(
  entries: Record<string, Uint8Array>,
  path: string,
  id: unknown,
  replacement: Record<string, unknown> | undefined
): void {
  let values: unknown[] = [];
  const bytes = entries[path];
  if (bytes) {
    try {
      const parsed = parseLosslessJson(strFromU8(bytes)) as unknown;
      if (!Array.isArray(parsed)) throw new Error("回收站清单不是 JSON 数组。");
      values = parsed;
    } catch {
      throw new Error(`${path} 无法安全更新，因为现有 JSON 已损坏。`);
    }
  }
  const key = jsonScalarText(id);
  const index = values.findIndex((value) => value && typeof value === "object" && !Array.isArray(value) && jsonScalarText((value as Record<string, unknown>).id) === key);
  if (replacement) {
    if (index >= 0) values[index] = replacement;
    else values.push(replacement);
  } else if (index >= 0) {
    values.splice(index, 1);
  }
  entries[path] = strToU8(JSON.stringify(values));
}

function existingPathForCategory(item: VaultItem, existing: AndroidBackupRecord): string {
  if (item.categoryName === existing.item.categoryName) return existing.path;
  const match = existing.path.match(/^folders\/[^/]+\/([^/]+)\/([^/]+)$/i);
  return match ? `folders/${androidFolderKey(item.categoryName)}/${match[1]}/${match[2]}` : existing.path;
}

/** Byte-for-byte equivalent of Monica Android WebDavHelper.toFolderKey. */
export function androidFolderKey(categoryName?: string): string {
  const normalized = categoryName?.trim() || "";
  if (!normalized) return "_root";
  let result = "";
  for (const character of normalized) {
    result += /[\p{L}\p{N}]/u.test(character) || character === "-" || character === "_"
      ? character
      : /\s/u.test(character) ? "_" : "_";
  }
  return result.replace(/^_+|_+$/g, "") || "_root";
}

function ensureProviderReference(item: VaultItem, providerId: string, remoteId: string) {
  const existing = item.providerRefs.find((reference) => reference.providerId === providerId);
  if (existing) existing.remoteId = remoteId;
  else item.providerRefs.push({ providerId, remoteId });
}

function numericId(item: VaultItem): number {
  let hash = 0;
  for (const char of item.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return Date.parse(item.createdAt) * 1000 + (hash % 1000);
}

function splitUris(value: string): string[] {
  return [...new Set(value.split(/[\r\n]+/).map((part) => part.trim()).filter(Boolean))];
}

function parseStringArray(value: unknown): string[] | undefined {
  const parsed = typeof value === "string" ? (() => { try { return parseLosslessJson(value) as unknown; } catch { return []; } })() : value;
  if (!Array.isArray(parsed)) return undefined;
  const values = parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
  return values.length ? values : undefined;
}

function parseNestedJson(value: unknown): Record<string, unknown> {
  if (isJsonObject(value)) return value;
  if (value == null || (typeof value === "string" && !value.trim())) return {};
  if (typeof value !== "string") throw new Error("itemData 不是 JSON 对象。");
  const parsed = parseLosslessJson(value);
  if (!isJsonObject(parsed)) throw new Error("itemData 不是 JSON 对象。");
  return parsed;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && !(JSON as typeof JSON & { isRawJSON?: (candidate: unknown) => boolean }).isRawJSON?.(value);
}

function mergePasswordCustomFields(original: unknown, updates: Array<{ title: string; value: string; isProtected: boolean }>): unknown[] {
  const remaining: unknown[] = Array.isArray(original) ? [...original] : [];
  const fields = updates.map((update) => {
    const index = remaining.findIndex((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).title === update.title);
    const source = index < 0 ? undefined : remaining.splice(index, 1)[0] as Record<string, unknown>;
    return { ...source, ...update };
  });
  return [...fields, ...remaining.filter((candidate) => !candidate || typeof candidate !== "object" || Array.isArray(candidate) || typeof (candidate as Record<string, unknown>).title !== "string" || typeof (candidate as Record<string, unknown>).value !== "string")];
}

function mergeNestedItemData(original: unknown, updates: Record<string, unknown>): string {
  return JSON.stringify(mergeMonicaItemData(parseNestedJson(original), updates));
}

function stringValue(value: unknown): string {
  return jsonScalarText(value);
}
function optionalString(value: unknown): string | undefined {
  return stringValue(value) || undefined;
}
// Supplemental text is content, not an optional identifier. An explicit clear
// must stay empty after native/ZIP reload instead of becoming an absent field.
function optionalText(value: unknown): string | undefined {
  return value == null ? undefined : stringValue(value);
}
function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(jsonScalarText(value));
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(jsonScalarText(value));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function dateValue(value: unknown, fallback = new Date().toISOString()): string {
  const millis = numberValue(value, Number.NaN);
  if (Number.isFinite(millis) && millis >= 0 && millis <= 8640000000000000) return new Date(millis).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}
function normalizeLoginType(value: unknown): NonNullable<LoginItem["loginType"]> {
  const normalized = stringValue(value).trim().toUpperCase();
  if (normalized === "SSH") return "SSH_KEY";
  return normalized === "SSO" || normalized === "WIFI" || normalized === "SSH_KEY" || normalized === "GPG_KEY" || normalized === "API_KEY" || normalized === "BARCODE" ? normalized : "PASSWORD";
}

function normalizePasskeyAlgorithm(value: unknown): PasskeyItem["algorithm"] {
  const algorithm = numberValue(value, -7);
  return Number.isSafeInteger(algorithm) ? algorithm : -7;
}
