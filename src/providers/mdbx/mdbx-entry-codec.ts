import type { LoginItem, ProviderReference, SecureCustomField, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";

/**
 * Android rebuilds `entries.payload_ct` from scratch on every write (`MdbxVaultStore.kt:1928-1956`),
 * which drops any key it does not model. We deliberately do not copy that: writes here start from
 * the decrypted original and only touch keys whose value actually changed, so a field Monica has no
 * model for survives an edit made in the browser.
 */
export interface MdbxEntryRow {
  entryId: string;
  projectId: string;
  entryType: string;
  title: string;
  payload: Record<string, unknown>;
  deleted: boolean;
  createdAt?: string;
  updatedAt?: string;
  objectClock?: number;
  payloadSchemaVersion?: number;
}

export interface MdbxDecodedEntry {
  item?: VaultItem;
  /** Set when `entry_type` is one this build cannot model. The row is kept and never rewritten. */
  unsupportedReason?: string;
}

const LOGIN_TYPES = new Set(["PASSWORD", "SSO", "WIFI", "SSH_KEY", "BARCODE"]);
const OTP_TYPES = new Set(["TOTP", "HOTP", "STEAM", "YANDEX", "MOTP"]);
const TOTP_ALGORITHMS = new Set(["SHA1", "SHA256", "SHA512"]);
const EPOCH = new Date(0).toISOString();

export function decodeMdbxEntry(row: MdbxEntryRow, providerId: string, databaseId: number): MdbxDecodedEntry {
  const providerRefs: ProviderReference[] = [{ providerId, remoteId: row.entryId, revision: String(row.objectClock ?? "") || undefined }];
  const createdAt = row.createdAt || EPOCH;
  const updatedAt = row.updatedAt || createdAt;
  const base = {
    id: `mdbx:${providerId}:${row.entryId}`,
    title: row.title || "未命名 MDBX 条目",
    favorite: false,
    notes: stringValue(row.payload.notes),
    createdAt,
    updatedAt,
    ...(row.deleted ? { deletedAt: updatedAt } : {}),
    categoryId: optionalNumber(row.payload.category_id),
    mdbxDatabaseId: databaseId,
    mdbxFolderId: optionalString(row.payload.mdbx_folder_id),
    providerRefs
  };

  switch (row.entryType) {
    /**
     * Android writes `entry_type = "login"` for a password (`MdbxVaultStore.kt:1961`) while the
     * payload's own `kind` says `"password"` (`:1929`). `"password"` also exists as a `SecureItem`
     * prefix (`:2094`), so both spellings are accepted on read even though writes always emit `login`.
     */
    case "login":
    case "password":
      return { item: { ...base, kind: "login", ...decodeLoginFields(row.payload) } as LoginItem };
    case "note":
      return { item: { ...base, kind: "secure-note", content: itemDataString(row.payload, "content") } as SecureNoteItem };
    case "totp":
      return { item: { ...base, kind: "totp", ...decodeTotpFields(row.payload) } as TotpItem };
    default:
      return { unsupportedReason: `未知的 MDBX 条目类型「${row.entryType}」，已原样保留但不解析。` };
  }
}

function decodeLoginFields(payload: Record<string, unknown>) {
  const website = stringValue(payload.website);
  return {
    username: stringValue(payload.username),
    password: stringValue(payload.password_plain),
    uris: website.split("\n").map((uri) => uri.trim()).filter(Boolean),
    totpSecret: optionalString(payload.authenticator_key),
    loginType: LOGIN_TYPES.has(stringValue(payload.login_type)) ? stringValue(payload.login_type) as LoginItem["loginType"] : undefined,
    appPackageName: optionalString(payload.app_package_name),
    appName: optionalString(payload.app_name),
    passkeyBindings: optionalString(payload.passkey_bindings),
    customFields: decodeCustomFields(payload.custom_fields)
  };
}

function decodeTotpFields(payload: Record<string, unknown>) {
  const data = parseItemData(payload);
  const otpType = stringValue(data.otpType);
  const algorithm = stringValue(data.algorithm).toUpperCase();
  return {
    secret: stringValue(data.authenticatorKey ?? data.secret),
    issuer: optionalString(data.issuer),
    accountName: optionalString(data.accountName),
    otpType: OTP_TYPES.has(otpType) ? otpType as TotpItem["otpType"] : undefined,
    algorithm: (TOTP_ALGORITHMS.has(algorithm) ? algorithm : "SHA1") as TotpItem["algorithm"],
    digits: numberValue(data.digits, 6),
    period: numberValue(data.period, 30)
  };
}

/**
 * Diff-gated encode. `original` is the payload as read from the database; every key it holds that we
 * do not explicitly touch is carried through byte-for-byte, including keys from newer Android builds.
 */
export function encodeMdbxPayload(item: VaultItem, original: Record<string, unknown> = {}, previous?: VaultItem): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...original };
  const isNew = !previous;
  const setChanged = (key: string, value: unknown, current: unknown, before: unknown) => {
    if (isNew || !sameValue(current, before)) payload[key] = value;
  };

  setChanged("notes", item.notes, item.notes, previous?.notes);
  setChanged("category_id", item.categoryId ?? null, item.categoryId, previous?.categoryId);
  setChanged("mdbx_folder_id", item.mdbxFolderId ?? "", item.mdbxFolderId, previous?.mdbxFolderId);

  if (item.kind === "login") {
    const before = previous?.kind === "login" ? previous : undefined;
    if (isNew) payload.kind = "password";
    setChanged("username", item.username, item.username, before?.username);
    setChanged("password_plain", item.password, item.password, before?.password);
    setChanged("website", item.uris.join("\n"), item.uris, before?.uris);
    setChanged("authenticator_key", item.totpSecret || "", item.totpSecret || "", before?.totpSecret || "");
    setChanged("login_type", item.loginType || "", item.loginType || "", before?.loginType || "");
    setChanged("app_package_name", item.appPackageName || "", item.appPackageName || "", before?.appPackageName || "");
    setChanged("app_name", item.appName || "", item.appName || "", before?.appName || "");
    setChanged("passkey_bindings", item.passkeyBindings || "", item.passkeyBindings || "", before?.passkeyBindings || "");
    setChanged("custom_fields", encodeCustomFields(item.customFields), item.customFields, before?.customFields);
    return payload;
  }

  if (item.kind === "secure-note") {
    const before = previous?.kind === "secure-note" ? previous : undefined;
    if (isNew) payload.kind = "note";
    if (isNew || !sameValue(item.content, before?.content)) {
      payload.item_data = mergeItemData(original.item_data, { content: item.content });
    }
    return payload;
  }

  if (item.kind === "totp") {
    const before = previous?.kind === "totp" ? previous : undefined;
    if (isNew) payload.kind = "totp";
    const updates: Record<string, unknown> = {};
    const setNested = (key: string, value: unknown, current: unknown, beforeValue: unknown) => {
      if (isNew || !sameValue(current, beforeValue)) updates[key] = value;
    };
    setNested("authenticatorKey", item.secret, item.secret, before?.secret);
    setNested("issuer", item.issuer || "", item.issuer || "", before?.issuer || "");
    setNested("accountName", item.accountName || "", item.accountName || "", before?.accountName || "");
    setNested("algorithm", item.algorithm, item.algorithm, before?.algorithm);
    setNested("digits", item.digits, item.digits, before?.digits);
    setNested("period", item.period, item.period, before?.period);
    if (item.otpType || before?.otpType) setNested("otpType", item.otpType, item.otpType, before?.otpType);
    if (Object.keys(updates).length) payload.item_data = mergeItemData(original.item_data, updates);
    return payload;
  }

  return payload;
}

/** `item_data` is a JSON string nested inside the payload, so its unknown keys need merging too. */
function mergeItemData(original: unknown, updates: Record<string, unknown>): string {
  return JSON.stringify({ ...parseJsonObject(original), ...updates });
}

function parseItemData(payload: Record<string, unknown>): Record<string, unknown> {
  return parseJsonObject(payload.item_data);
}

function itemDataString(payload: Record<string, unknown>, key: string): string {
  return stringValue(parseItemData(payload)[key]);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function decodeCustomFields(value: unknown): SecureCustomField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const field = candidate as Record<string, unknown>;
    const name = stringValue(field.title);
    return name ? [{ name, value: stringValue(field.value), protected: Boolean(field.is_protected) }] : [];
  });
}

function encodeCustomFields(fields: SecureCustomField[] | undefined): Array<Record<string, unknown>> {
  return (fields || []).map((field, index) => ({ title: field.name, value: field.value, is_protected: field.protected, sort_order: index }));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
