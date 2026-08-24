import { strFromU8, strToU8, zipSync } from "fflate";
import type { BillingAddressItem, CardItem, IdentityItem, LoginItem, PasskeyItem, PaymentAccountItem, ProviderReference, SecureCustomField, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";
import {
  firstString,
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
import { parsePortablePasskeyPrivateKey } from "../../passkey/private-key-portability";

export interface AndroidBackupCodecOptions { allowPortablePasskeys?: boolean }

export interface AndroidBackupRecord {
  path: string;
  raw: Record<string, unknown>;
  itemId: string;
  item: VaultItem;
}

export interface AndroidBackupDocument {
  entries: Record<string, Uint8Array>;
  items: VaultItem[];
  records: Map<string, AndroidBackupRecord>;
  warnings: string[];
  passwordHistoryRaw?: unknown[];
}

export interface AndroidPortableAttachment {
  attachmentId: string;
  parentPasswordId?: number;
  parentSecureItemId?: number;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  sha256Hex: string;
  payloadPath: string;
  createdAt?: number;
  updatedAt?: number;
}

const PORTABLE_ATTACHMENT_MANIFEST = "attachments_portable/attachments_portable.json";
const PORTABLE_ATTACHMENT_PATH = /^attachments_portable\/([^/]+)\.bin$/;
const PORTABLE_ATTACHMENT_MAX_BYTES = 256 * 1024 * 1024;

const JSON_PATH = /^folders\/([^/]+)\/(passwords|authenticators|bank_cards|documents|billing_addresses|payment_accounts|notes|passkeys)\/[^/]+\.json$/i;

export function readAndroidBackup(zipBytes: Uint8Array, providerId: string, options: AndroidBackupCodecOptions = {}): AndroidBackupDocument {
  const entries = safeUnzipSync(zipBytes);
  const items: VaultItem[] = [];
  const records = new Map<string, AndroidBackupRecord>();
  const warnings: string[] = [];

  for (const [path, bytes] of Object.entries(entries)) {
    if (!JSON_PATH.test(path)) continue;
    try {
      const raw = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
      const item = androidRecordToItem(path, raw, providerId, options);
      if (!item) continue;
      items.push(item);
      records.set(item.id, { path, raw, itemId: item.id, item: cloneVaultItem(item) });
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : "无法解析"}`);
    }
  }
  const passwordHistoryRaw = readAndroidPasswordHistory(entries, items, records, warnings);
  restoreAndroidOtpBindings(items);
  for (const item of items) {
    const record = records.get(item.id);
    if (record) record.item = cloneVaultItem(item);
  }
  return { entries, items, records, warnings, passwordHistoryRaw };
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

export function writeAndroidBackup(document: AndroidBackupDocument, items: VaultItem[], providerId: string, options: AndroidBackupCodecOptions = {}): Uint8Array {
  const entries = { ...document.entries };
  for (const item of items) {
    const existing = document.records.get(item.id);
    if (item.deletedAt) {
      if (existing) delete entries[existing.path];
      continue;
    }
    if (existing && sameWritableItem(item, existing.item)) continue;
    const target = serializeAndroidItem(item, existing?.raw, existing?.item, options);
    if (!target) continue;
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
  return output;
}

export function deleteAndroidBackupItem(document: AndroidBackupDocument, itemId: string): void {
  const record = document.records.get(itemId);
  if (!record) return;
  delete document.entries[record.path];
  document.records.delete(itemId);
  document.items = document.items.filter((item) => item.id !== itemId);
}

export function androidRecordToItem(path: string, raw: Record<string, unknown>, providerId: string, options: AndroidBackupCodecOptions = {}): VaultItem | null {
  const match = path.match(JSON_PATH);
  if (!match) return null;
  const kindFolder = match[2].toLowerCase();
  const base = baseFields(path, raw, providerId);

  if (kindFolder === "passwords") {
    return {
      ...base,
      kind: "login",
      username: stringValue(raw.username),
      password: stringValue(raw.password),
      uris: splitUris(stringValue(raw.website)),
      uriRules: splitUris(stringValue(raw.website)).map((uri) => ({ uri, matchType: "base-domain" })),
      totpSecret: stringValue(raw.authenticatorKey) || undefined,
      customFields: Array.isArray(raw.customFields)
        ? raw.customFields.map((field) => {
            const value = field as Record<string, unknown>;
            return { name: stringValue(value.title), value: stringValue(value.value), protected: Boolean(value.isProtected) };
          })
        : [],
      loginType: normalizeLoginType(raw.loginType),
      ssoProvider: optionalString(raw.ssoProvider),
      ssoRefEntryId: optionalNumber(raw.ssoRefEntryId),
      appPackageName: optionalString(raw.appPackageName),
      appName: optionalString(raw.appName),
      email: optionalString(raw.email),
      phone: optionalString(raw.phone),
      addressLine: optionalString(raw.addressLine),
      city: optionalString(raw.city),
      state: optionalString(raw.state),
      zipCode: optionalString(raw.zipCode),
      country: optionalString(raw.country),
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
      content: firstString(data, "content") || stringValue(raw.itemData) || stringValue(raw.notes),
      tags: parseStringArray(data.tags) || [],
      isMarkdown: Boolean(data.isMarkdown),
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies SecureNoteItem;
  }

  if (kindFolder === "authenticators") {
    const data = parseNestedJson(raw.itemData);
    const rawOtpType = stringValue(data.otpType);
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
      counter: optionalNumber(data.counter),
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
      discoverable: raw.isDiscoverable !== false,
      userVerificationRequired: raw.isUserVerificationRequired !== false,
      transports: (stringValue(raw.transports) || "internal").split(",").map((value) => value.trim()).filter(Boolean),
      aaguid: optionalString(raw.aaguid),
      lastUsedAt: dateValue(raw.lastUsedAt, base.updatedAt),
      useCount: numberValue(raw.useCount, 0),
      iconUrl: optionalString(raw.iconUrl),
      boundPasswordId: optionalNumber(raw.boundPasswordId),
      passkeyMode: normalizePasskeyMode(raw.passkeyMode),
      ...(portableKey?.algorithm === -7 && portableKey.algorithm === numberValue(raw.publicKeyAlgorithm, -7)
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
      fullName: nameFromParts || firstString(data, "fullName", "name"),
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

export function listAndroidPortableAttachments(document: AndroidBackupDocument, item: VaultItem): AndroidPortableAttachment[] {
  const manifest = parsePortableAttachmentManifest(document.entries[PORTABLE_ATTACHMENT_MANIFEST]);
  if (!manifest.length) return [];
  const ids = new Set<number>();
  const secureItemId = optionalNumber(document.records.get(item.id)?.raw.id);
  for (const reference of item.providerRefs) {
    const match = reference.remoteId?.match(/password_(-?\d+)_\d+\.json$/i);
    if (match) ids.add(Number(match[1]));
  }
  return manifest.filter((attachment) =>
    (attachment.parentSecureItemId !== undefined && attachment.parentSecureItemId === secureItemId)
    || (attachment.parentPasswordId !== undefined && ids.has(attachment.parentPasswordId))
  );
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

function parsePortableAttachmentManifest(bytes?: Uint8Array): AndroidPortableAttachment[] {
  if (!bytes) return [];
  let raw: unknown;
  try { raw = JSON.parse(strFromU8(bytes)); } catch { return []; }
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
    const parentPasswordId = typeof record.parentPasswordId === "number" && Number.isSafeInteger(record.parentPasswordId) ? record.parentPasswordId : undefined;
    const parentSecureItemId = typeof record.parentSecureItemId === "number" && Number.isSafeInteger(record.parentSecureItemId) && record.parentSecureItemId > 0 ? record.parentSecureItemId : undefined;
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

function readAndroidPasswordHistory(
  entries: Record<string, Uint8Array>,
  items: VaultItem[],
  records: Map<string, AndroidBackupRecord>,
  warnings: string[]
): unknown[] {
  const path = Object.keys(entries).find((entry) => entry.toLowerCase() === "password_history.json");
  if (!path) return [];
  let raw: unknown;
  try { raw = JSON.parse(strFromU8(entries[path])); }
  catch {
    warnings.push("password_history.json: 无法解析，原始条目已保留。");
    return [];
  }
  if (!Array.isArray(raw) || raw.length > 100_000) {
    warnings.push("password_history.json: 历史列表格式无效或过大，原始条目已保留。");
    return [];
  }
  const loginsByEntryId = new Map<number, LoginItem>();
  for (const item of items) {
    if (item.kind !== "login") continue;
    const record = records.get(item.id);
    const entryId = record ? optionalNumber(record.raw.id) : undefined;
    if (entryId !== undefined) loginsByEntryId.set(entryId, item);
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const entryId = optionalNumber(value.entryId);
    const password = typeof value.password === "string" ? value.password : undefined;
    const lastUsedAt = dateValue(value.lastUsedAt, "");
    const login = entryId === undefined ? undefined : loginsByEntryId.get(entryId);
    if (!login || password === undefined || !lastUsedAt) continue;
    const history = login.passwordHistory || [];
    if (history.length < 1_000) login.passwordHistory = [...history, { password, lastUsedAt }];
  }
  return raw;
}

function writeAndroidPasswordHistory(document: AndroidBackupDocument, items: VaultItem[], entries: Record<string, Uint8Array>): void {
  const original = document.passwordHistoryRaw || [];
  const replacements = new Map<number, LoginItem["passwordHistory"]>();
  for (const item of items) {
    if (item.kind !== "login") continue;
    const record = document.records.get(item.id);
    const entryId = record ? optionalNumber(record.raw.id) : numericId(item);
    if (entryId === undefined) continue;
    const previous = record?.item.kind === "login" ? record.item : undefined;
    let history = [...(item.passwordHistory || [])].slice(-1_000);
    if (previous && item.password !== previous.password && previous.password && !history.some((entry) => entry.password === previous.password)) {
      history.push({ password: previous.password, lastUsedAt: previous.updatedAt });
    }
    if (JSON.stringify(history) !== JSON.stringify(previous?.passwordHistory || [])) replacements.set(entryId, history);
  }
  if (!replacements.size) return;
  const retained = original.filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
    const entryId = optionalNumber((entry as Record<string, unknown>).entryId);
    return entryId === undefined || !replacements.has(entryId);
  });
  for (const [entryId, history] of replacements) {
    const matchingRaw = original.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) && optionalNumber((entry as Record<string, unknown>).entryId) === entryId);
    for (const value of history || []) {
      const previousRaw = matchingRaw.find((entry) => entry.password === value.password && dateValue(entry.lastUsedAt, "") === value.lastUsedAt);
      retained.push({ ...(previousRaw || {}), entryId, password: value.password, lastUsedAt: Date.parse(value.lastUsedAt) || Date.now() });
    }
  }
  entries["password_history.json"] = strToU8(JSON.stringify(retained));
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
  const originalId = original?.id;
  const id: number | string = typeof originalId === "number" || typeof originalId === "string" ? originalId : numericId(item);
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
      setChanged("ssoProvider", item.ssoProvider || "", item.ssoProvider || "", previous?.ssoProvider || "");
      setChanged("ssoRefEntryId", item.ssoRefEntryId ?? null, item.ssoRefEntryId, previous?.ssoRefEntryId);
      for (const key of ["appPackageName", "appName", "email", "phone", "addressLine", "city", "state", "zipCode", "country", "passkeyBindings", "sshKeyData", "wifiMetadata", "barcodeData", "customIconType", "customIconValue"] as const) {
        setChanged(key, item[key] || "", item[key] || "", previous?.[key] || "");
      }
      setChanged("customIconUpdatedAt", item.customIconUpdatedAt || 0, item.customIconUpdatedAt, previous?.customIconUpdatedAt);
      const customFields = item.customFields.map((field) => ({ title: field.name, value: field.value, isProtected: field.protected }));
      setChanged("customFields", customFields, item.customFields, previous?.customFields);
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
      setOptionalNested("counter", item.counter, item.counter, previous?.counter);
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
      const portableValue = portableKey?.algorithm === -7 && item.algorithm === -7 ? portableKey.pkcs8Base64 : "";
      raw.privateKeyAlias = portableValue;
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
  const { providerRefs: _leftProviderRefs, deletedAt: _leftDeletedAt, ...leftPayload } = left;
  const { providerRefs: _rightProviderRefs, deletedAt: _rightDeletedAt, ...rightPayload } = right;
  return sameValue(leftPayload, rightPayload);
}

function cloneVaultItem(item: VaultItem): VaultItem {
  return JSON.parse(JSON.stringify(item)) as VaultItem;
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function providerPath(item: VaultItem, id: number | string): string {
  const millis = Date.parse(item.createdAt) || Date.now();
  const mapping: Record<VaultItem["kind"], [string, string]> = {
    login: ["passwords", "password"],
    "secure-note": ["notes", "note"],
    totp: ["authenticators", "totp"],
    card: ["bank_cards", "bank_card"],
    identity: ["documents", "document"],
    "billing-address": ["billing_addresses", "billing_address"],
    "payment-account": ["payment_accounts", "payment_account"],
    passkey: ["passkeys", "passkey"]
  };
  const [folder, prefix] = mapping[item.kind];
  const safeId = String(id).replace(/\//g, "_");
  const folderKey = androidFolderKey(item.categoryName);
  if (item.kind === "passkey") return `folders/${folderKey}/${folder}/${prefix}_${safeId}.json`;
  return `folders/${folderKey}/${folder}/${prefix}_${safeId}_${millis}.json`;
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
  if (item.providerRefs.some((reference) => reference.providerId === providerId && reference.remoteId === remoteId)) return;
  item.providerRefs.push({ providerId, remoteId });
}

function numericId(item: VaultItem): number {
  let hash = 0;
  for (const char of item.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return Date.parse(item.createdAt) * 1000 + (hash % 1000);
}

function splitUris(value: string): string[] {
  return [...new Set(value.split(/[\r\n,;]+/).map((part) => part.trim()).filter(Boolean))];
}

function parseStringArray(value: unknown): string[] | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return []; } })() : value;
  if (!Array.isArray(parsed)) return undefined;
  const values = parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
  return values.length ? values : undefined;
}

function parseNestedJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mergeNestedItemData(original: unknown, updates: Record<string, unknown>): string {
  return JSON.stringify({ ...parseNestedJson(original), ...updates });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
function optionalString(value: unknown): string | undefined {
  return stringValue(value) || undefined;
}
function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function dateValue(value: unknown, fallback = new Date().toISOString()): string {
  const millis = numberValue(value, Number.NaN);
  if (Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}
function normalizeLoginType(value: unknown): NonNullable<LoginItem["loginType"]> {
  const normalized = stringValue(value).trim().toUpperCase();
  if (normalized === "SSH") return "SSH_KEY";
  return normalized === "SSO" || normalized === "WIFI" || normalized === "SSH_KEY" || normalized === "BARCODE" ? normalized : "PASSWORD";
}

function normalizePasskeyAlgorithm(value: unknown): PasskeyItem["algorithm"] {
  const algorithm = numberValue(value, -7);
  return Number.isSafeInteger(algorithm) ? algorithm : -7;
}
