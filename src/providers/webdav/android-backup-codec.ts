import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { BillingAddressItem, CardItem, IdentityItem, LoginItem, PasskeyItem, PaymentAccountItem, ProviderReference, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";

export interface AndroidBackupRecord {
  path: string;
  raw: Record<string, unknown>;
  itemId: string;
}

export interface AndroidBackupDocument {
  entries: Record<string, Uint8Array>;
  items: VaultItem[];
  records: Map<string, AndroidBackupRecord>;
  warnings: string[];
}

const JSON_PATH = /^folders\/([^/]+)\/(passwords|authenticators|bank_cards|documents|billing_addresses|payment_accounts|notes|passkeys)\/[^/]+\.json$/i;

export function readAndroidBackup(zipBytes: Uint8Array, providerId: string): AndroidBackupDocument {
  const entries = unzipSync(zipBytes);
  const items: VaultItem[] = [];
  const records = new Map<string, AndroidBackupRecord>();
  const warnings: string[] = [];

  for (const [path, bytes] of Object.entries(entries)) {
    if (!JSON_PATH.test(path)) continue;
    try {
      const raw = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
      const item = androidRecordToItem(path, raw, providerId);
      if (!item) continue;
      items.push(item);
      records.set(item.id, { path, raw, itemId: item.id });
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : "无法解析"}`);
    }
  }
  return { entries, items, records, warnings };
}

export function writeAndroidBackup(document: AndroidBackupDocument, items: VaultItem[], providerId: string): Uint8Array {
  const entries = { ...document.entries };
  for (const item of items) {
    const existing = document.records.get(item.id);
    if (item.deletedAt) {
      if (existing) delete entries[existing.path];
      continue;
    }
    const target = serializeAndroidItem(item, existing?.raw);
    if (!target) continue;
    const remotePath = existing?.path || providerPath(item, target.id);
    entries[remotePath] = strToU8(JSON.stringify(target.raw));
    ensureProviderReference(item, providerId, remotePath);
  }
  return zipSync(entries, { level: 6 });
}

export function deleteAndroidBackupItem(document: AndroidBackupDocument, itemId: string): void {
  const record = document.records.get(itemId);
  if (!record) return;
  delete document.entries[record.path];
  document.records.delete(itemId);
  document.items = document.items.filter((item) => item.id !== itemId);
}

function androidRecordToItem(path: string, raw: Record<string, unknown>, providerId: string): VaultItem | null {
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
      totpSecret: stringValue(raw.authenticatorKey) || undefined,
      customFields: Array.isArray(raw.customFields)
        ? raw.customFields.map((field) => {
            const value = field as Record<string, unknown>;
            return { name: stringValue(value.title), value: stringValue(value.value), protected: Boolean(value.isProtected) };
          })
        : []
    } satisfies LoginItem;
  }

  if (kindFolder === "notes") {
    return { ...base, kind: "secure-note", content: stringValue(raw.itemData) || stringValue(raw.notes) } satisfies SecureNoteItem;
  }

  if (kindFolder === "authenticators") {
    const data = parseNestedJson(raw.itemData);
    return {
      ...base,
      kind: "totp",
      secret: stringValue(data.secret) || stringValue(data.authenticatorKey),
      issuer: stringValue(data.issuer) || undefined,
      accountName: stringValue(data.accountName) || undefined,
      algorithm: normalizeTotpAlgorithm(data.algorithm),
      digits: numberValue(data.digits, 6),
      period: numberValue(data.period, 30)
    } satisfies TotpItem;
  }

  if (kindFolder === "passkeys") {
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
      sourceMode: "android-metadata-only"
    } satisfies PasskeyItem;
  }

  const data = parseNestedJson(raw.itemData);
  if (kindFolder === "bank_cards") {
    return {
      ...base,
      kind: "card",
      cardholderName: stringValue(data.cardholderName),
      number: stringValue(data.cardNumber),
      expiryMonth: stringValue(data.expiryMonth),
      expiryYear: stringValue(data.expiryYear),
      securityCode: stringValue(data.cvv),
      brand: stringValue(data.brand) || stringValue(data.bankName) || undefined
    } satisfies CardItem;
  }
  if (kindFolder === "documents") {
    return {
      ...base,
      kind: "identity",
      documentType: normalizeDocumentType(data.documentType),
      documentNumber: stringValue(data.documentNumber),
      firstName: stringValue(data.firstName),
      middleName: stringValue(data.middleName),
      lastName: stringValue(data.lastName),
      fullName: stringValue(data.fullName),
      birthDate: optionalString(data.birthDate),
      issuedDate: optionalString(data.issuedDate),
      expiryDate: optionalString(data.expiryDate),
      issuedBy: optionalString(data.issuedBy),
      nationality: optionalString(data.nationality),
      email: optionalString(data.email),
      phone: optionalString(data.phone),
      address: {
        streetAddress: stringValue(data.address1),
        apartment: stringValue(data.address2),
        city: stringValue(data.city),
        stateProvince: stringValue(data.stateProvince),
        postalCode: stringValue(data.postalCode),
        country: stringValue(data.country)
      }
    } satisfies IdentityItem;
  }
  if (kindFolder === "billing_addresses") {
    return {
      ...base,
      kind: "billing-address",
      fullName: stringValue(data.fullName),
      company: stringValue(data.company),
      streetAddress: stringValue(data.streetAddress),
      apartment: stringValue(data.apartment),
      city: stringValue(data.city),
      stateProvince: stringValue(data.stateProvince),
      postalCode: stringValue(data.postalCode),
      country: stringValue(data.country),
      phone: stringValue(data.phone),
      email: stringValue(data.email)
    } satisfies BillingAddressItem;
  }
  if (kindFolder === "payment_accounts") {
    return {
      ...base,
      kind: "payment-account",
      paymentType: stringValue(data.paymentType),
      provider: stringValue(data.provider),
      accountName: stringValue(data.accountName),
      accountHolderName: stringValue(data.accountHolderName),
      email: stringValue(data.email),
      phone: stringValue(data.phone),
      username: stringValue(data.username),
      accountId: stringValue(data.accountId),
      maskedAccountNumber: stringValue(data.maskedAccountNumber),
      routingNumber: stringValue(data.routingNumber),
      iban: stringValue(data.iban),
      swiftBic: stringValue(data.swiftBic),
      website: stringValue(data.website),
      currency: stringValue(data.currency)
    } satisfies PaymentAccountItem;
  }
  return null;
}

function baseFields(path: string, raw: Record<string, unknown>, providerId: string) {
  const createdAt = dateValue(raw.createdAt);
  return {
    id: `android:${providerId}:${path}`,
    title: stringValue(raw.title) || stringValue(raw.rpName) || "未命名项目",
    favorite: Boolean(raw.isFavorite),
    notes: stringValue(raw.notes),
    createdAt,
    updatedAt: dateValue(raw.updatedAt, createdAt),
    providerRefs: [{ providerId, remoteId: path }] as ProviderReference[]
  };
}

function serializeAndroidItem(item: VaultItem, original?: Record<string, unknown>): { id: number | string; raw: Record<string, unknown> } | null {
  const originalId = original?.id;
  const id: number | string = typeof originalId === "number" || typeof originalId === "string" ? originalId : numericId(item);
  const base = {
    ...(original || {}),
    id,
    title: item.title,
    notes: item.notes,
    isFavorite: item.favorite,
    createdAt: Date.parse(item.createdAt) || Date.now(),
    updatedAt: Date.parse(item.updatedAt) || Date.now()
  };
  switch (item.kind) {
    case "login":
      return { id, raw: { ...base, username: item.username, password: item.password, website: item.uris.join("\n"), authenticatorKey: item.totpSecret || "", customFields: item.customFields.map((field) => ({ title: field.name, value: field.value, isProtected: field.protected })) } };
    case "secure-note":
      return { id, raw: { ...base, itemType: "NOTE", itemData: item.content } };
    case "totp":
      return { id, raw: { ...base, itemType: "TOTP", itemData: mergeNestedItemData(original?.itemData, { secret: item.secret, issuer: item.issuer || "", accountName: item.accountName || "", algorithm: item.algorithm, digits: item.digits, period: item.period }) } };
    case "card":
      return { id, raw: { ...base, itemType: "BANK_CARD", itemData: mergeNestedItemData(original?.itemData, { cardholderName: item.cardholderName, cardNumber: item.number, expiryMonth: item.expiryMonth, expiryYear: item.expiryYear, cvv: item.securityCode, brand: item.brand || "" }) } };
    case "identity":
      return { id, raw: { ...base, itemType: "DOCUMENT", itemData: mergeNestedItemData(original?.itemData, { documentType: item.documentType, documentNumber: item.documentNumber, firstName: item.firstName, middleName: item.middleName, lastName: item.lastName, fullName: item.fullName, birthDate: item.birthDate || "", issuedDate: item.issuedDate || "", expiryDate: item.expiryDate || "", issuedBy: item.issuedBy || "", nationality: item.nationality || "", email: item.email || "", phone: item.phone || "", address1: item.address?.streetAddress || "", address2: item.address?.apartment || "", city: item.address?.city || "", stateProvince: item.address?.stateProvince || "", postalCode: item.address?.postalCode || "", country: item.address?.country || "" }) } };
    case "billing-address":
      return { id, raw: { ...base, itemType: "BILLING_ADDRESS", itemData: mergeNestedItemData(original?.itemData, { fullName: item.fullName, company: item.company, streetAddress: item.streetAddress, apartment: item.apartment, city: item.city, stateProvince: item.stateProvince, postalCode: item.postalCode, country: item.country, phone: item.phone, email: item.email }) } };
    case "payment-account":
      return { id, raw: { ...base, itemType: "PAYMENT_ACCOUNT", itemData: mergeNestedItemData(original?.itemData, { paymentType: item.paymentType, provider: item.provider, accountName: item.accountName, accountHolderName: item.accountHolderName, email: item.email, phone: item.phone, username: item.username, accountId: item.accountId, maskedAccountNumber: item.maskedAccountNumber, routingNumber: item.routingNumber, iban: item.iban, swiftBic: item.swiftBic, website: item.website, currency: item.currency }) } };
    case "passkey":
      return { id: item.credentialId, raw: { ...base, credentialId: item.credentialId, rpId: item.rpId, rpName: item.rpName, userId: item.userHandle, userName: item.userName, userDisplayName: item.userDisplayName, publicKeyAlgorithm: item.algorithm, publicKey: item.publicKey, privateKeyAlias: stringValue(original?.privateKeyAlias), signCount: item.signCount, isDiscoverable: item.discoverable, passkeyMode: item.sourceMode === "bitwarden" ? "BW_COMPAT" : "LEGACY" } };
  }
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
  return `folders/_root/${folder}/${prefix}_${safeId}_${millis}.json`;
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
function dateValue(value: unknown, fallback = new Date().toISOString()): string {
  const millis = numberValue(value, Number.NaN);
  if (Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}
function normalizeTotpAlgorithm(value: unknown): TotpItem["algorithm"] {
  const normalized = stringValue(value).toUpperCase();
  return normalized === "SHA256" || normalized === "SHA512" ? normalized : "SHA1";
}
function normalizePasskeyAlgorithm(value: unknown): PasskeyItem["algorithm"] {
  const algorithm = numberValue(value, -7);
  return algorithm === -257 || algorithm === -37 || algorithm === -8 ? algorithm : -7;
}
function normalizeDocumentType(value: unknown): IdentityItem["documentType"] {
  const normalized = stringValue(value).toUpperCase();
  return normalized === "ID_CARD" || normalized === "PASSPORT" || normalized === "DRIVER_LICENSE" || normalized === "SOCIAL_SECURITY" ? normalized : "OTHER";
}
