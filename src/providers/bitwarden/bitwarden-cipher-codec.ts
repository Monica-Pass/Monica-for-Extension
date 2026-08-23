import type { CardItem, IdentityItem, LoginItem, LoginUriMatchType, LoginUriRule, PasskeyItem, ProviderReference, SecureCustomField, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";
import { decryptBitwardenString, decryptBitwardenSymmetricKey, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { parseTotpParameters } from "../../core/totp";

export const BITWARDEN_CUSTOM_FIELDS_VERSION = 1 as const;

const BITWARDEN_TEXT_FIELD = 0;
const BITWARDEN_HIDDEN_FIELD = 1;
const RESERVED_PASSWORD_FIELD_NAMES = new Set([
  "monica_app_package", "appPackageName", "monica_app_name", "appName",
  "monica_email", "email", "monica_phone", "phone",
  "monica_address_line", "addressLine", "address", "monica_city", "city",
  "monica_state", "state", "monica_zip_code", "zipCode", "monica_country", "country",
  "monica_passkey_bindings", "monica_login_type",
  "monica_ssh_algorithm", "monica_ssh_key_size", "monica_ssh_public_key",
  "monica_ssh_private_key", "monica_ssh_fingerprint", "monica_ssh_comment", "monica_ssh_format"
]);

interface PlainBitwardenCustomField {
  raw: unknown;
  name: string;
  value: string;
  type: number;
  linked: boolean;
}

export interface DecodedBitwardenCipher {
  items: VaultItem[];
  warning?: string;
  unsupported?: boolean;
}

export async function decodeBitwardenCipher(raw: Record<string, unknown>, providerId: string, vaultKey: BitwardenSymmetricKey): Promise<DecodedBitwardenCipher> {
  const cipherId = stringValue(raw, "Id", "id");
  if (!cipherId) return { items: [], warning: "Bitwarden Cipher 缺少 ID，已跳过。" };
  const key = await resolveBitwardenCipherKey(raw, vaultKey);
  const type = numberValue(raw, "Type", "type");
  const revision = dateValue(value(raw, "RevisionDate", "revisionDate"));
  const createdAt = dateValue(value(raw, "CreationDate", "creationDate"), revision);
  const name = await decryptBitwardenString(stringValue(raw, "Name", "name"), key);
  const notes = await decryptBitwardenString(stringValue(raw, "Notes", "notes"), key);
  const favorite = booleanValue(raw, "Favorite", "favorite");
  const organizationId = stringValue(raw, "OrganizationId", "organizationId");
  const remoteCollectionIds = organizationId ? (stringArrayValue(raw, "CollectionIds", "collectionIds") || []) : undefined;
  const reference: ProviderReference = {
    providerId,
    remoteId: cipherId,
    remoteFolderId: stringValue(raw, "FolderId", "folderId") || undefined,
    ...(remoteCollectionIds !== undefined ? { remoteCollectionIds } : {}),
    revision
  };
  const base = {
    id: `bitwarden:${providerId}:${cipherId}`,
    title: name || "未命名 Bitwarden 项目",
    favorite,
    notes,
    createdAt,
    updatedAt: revision,
    deletedAt: optionalDateValue(value(raw, "DeletedDate", "deletedDate")),
    archivedAt: optionalDateValue(value(raw, "ArchivedDate", "archivedDate")),
    providerRefs: [reference]
  };

  if (type === 1) {
    const login = recordValue(raw, "Login", "login") || {};
    const username = await decryptBitwardenString(stringValue(login, "Username", "username"), key);
    const password = await decryptBitwardenString(stringValue(login, "Password", "password"), key);
    const totpSecret = await decryptBitwardenString(stringValue(login, "Totp", "totp"), key);
    const uriRules = await Promise.all(arrayValue(login, "Uris", "uris").map(async (entry): Promise<LoginUriRule> => {
      const rawUri = record(entry);
      return {
        uri: await decryptBitwardenString(stringValue(rawUri, "Uri", "uri"), key),
        matchType: bitwardenMatchType(value(rawUri, "Match", "match"))
      };
    }));
    const uris = uriRules.map((rule) => rule.uri);
    const decodedFields = await decodeBitwardenCustomFields(arrayValue(raw, "Fields", "fields"), key);
    const systemFields = bitwardenSystemFieldMap(decodedFields);
    const customFields = decodedFields
      .filter(isEditableBitwardenUserField)
      .map((field) => ({ name: field.name, value: field.value, protected: field.type === BITWARDEN_HIDDEN_FIELD }));
    const sshKeyData = bitwardenSshKeyData(systemFields);
    const loginType = bitwardenLoginType(systemFields, sshKeyData);
    const loginItem: LoginItem = {
      ...base,
      kind: "login",
      username,
      password,
      uris: [...new Set(uris.filter(Boolean))],
      uriRules: uriRules.filter((rule) => Boolean(rule.uri)),
      totpSecret: totpSecret || undefined,
      customFields,
      bitwardenCustomFieldsVersion: BITWARDEN_CUSTOM_FIELDS_VERSION,
      bitwardenSshKeyMode: sshKeyData ? "fallback" : undefined,
      appPackageName: bitwardenSystemValue(systemFields, "monica_app_package", "appPackageName") || undefined,
      appName: bitwardenSystemValue(systemFields, "monica_app_name", "appName") || undefined,
      email: bitwardenSystemValue(systemFields, "monica_email", "email") || undefined,
      phone: bitwardenSystemValue(systemFields, "monica_phone", "phone") || undefined,
      addressLine: bitwardenSystemValue(systemFields, "monica_address_line", "addressLine", "address") || undefined,
      city: bitwardenSystemValue(systemFields, "monica_city", "city") || undefined,
      state: bitwardenSystemValue(systemFields, "monica_state", "state") || undefined,
      zipCode: bitwardenSystemValue(systemFields, "monica_zip_code", "zipCode") || undefined,
      country: bitwardenSystemValue(systemFields, "monica_country", "country") || undefined,
      passkeyBindings: bitwardenSystemValue(systemFields, "monica_passkey_bindings") || undefined,
      loginType,
      sshKeyData
    };
    const passkeys = await decodeFido2Credentials(login, base, reference, key);
    // Monica Android represents an independent authenticator as a Login cipher with
    // an empty password, then projects the same cipher into its validator list.
    // Keep the Login projection for lossless Bitwarden write-back and expose the
    // validator projection so the extension's TOTP page and autofill binding can
    // discover it as a first-class item.
    const standaloneTotp = !password && totpSecret ? decodeStandaloneTotp(loginItem, totpSecret, reference) : undefined;
    return { items: [loginItem, ...(standaloneTotp ? [standaloneTotp] : []), ...passkeys] };
  }

  if (type === 2) {
    return { items: [{ ...base, kind: "secure-note", content: notes } satisfies SecureNoteItem] };
  }

  if (type === 3) {
    const card = recordValue(raw, "Card", "card") || {};
    const [cardholderName, number, expiryMonth, expiryYear, securityCode, brand] = await Promise.all([
      decryptField(card, key, "CardholderName", "cardholderName"),
      decryptField(card, key, "Number", "number"),
      decryptField(card, key, "ExpMonth", "expMonth"),
      decryptField(card, key, "ExpYear", "expYear"),
      decryptField(card, key, "Code", "code"),
      decryptField(card, key, "Brand", "brand")
    ]);
    return { items: [{ ...base, kind: "card", cardholderName, number, expiryMonth, expiryYear, securityCode, brand: brand || undefined } satisfies CardItem] };
  }

  if (type === 4) {
    const identity = recordValue(raw, "Identity", "identity") || {};
    const fields = await decryptRecordFields(identity, key, [
      "Title", "FirstName", "MiddleName", "LastName", "Address1", "Address2", "City", "State", "PostalCode", "Country", "Company", "Email", "Phone", "Ssn", "PassportNumber", "LicenseNumber"
    ]);
    const fullName = [fields.Title, fields.FirstName, fields.MiddleName, fields.LastName].filter(Boolean).join(" ");
    const documentType: IdentityItem["documentType"] = fields.PassportNumber ? "PASSPORT" : fields.LicenseNumber ? "DRIVER_LICENSE" : fields.Ssn ? "SOCIAL_SECURITY" : "OTHER";
    return {
      items: [{
        ...base,
        kind: "identity",
        documentType,
        documentNumber: fields.PassportNumber || fields.LicenseNumber || fields.Ssn,
        firstName: fields.FirstName,
        middleName: fields.MiddleName,
        lastName: fields.LastName,
        fullName,
        email: fields.Email || undefined,
        phone: fields.Phone || undefined,
        address: { streetAddress: fields.Address1, apartment: fields.Address2, city: fields.City, stateProvince: fields.State, postalCode: fields.PostalCode, country: fields.Country }
      } satisfies IdentityItem]
    };
  }

  if (type === 5) {
    const sshKey = recordValue(raw, "SshKey", "SSHKey", "sshKey", "ssh_key");
    if (!sshKey) return { items: [], warning: `Bitwarden SSH Cipher ${cipherId} 缺少 SSH Key 数据，已保留原始信封。` };
    const [privateKeyOpenSsh, publicKeyOpenSsh, fingerprintSha256] = await Promise.all([
      decryptField(sshKey, key, "PrivateKey", "privateKey", "private_key"),
      decryptField(sshKey, key, "PublicKey", "publicKey", "public_key"),
      decryptField(sshKey, key, "KeyFingerprint", "keyFingerprint", "Fingerprint", "fingerprint", "key_fingerprint")
    ]);
    if (!privateKeyOpenSsh && !publicKeyOpenSsh && !fingerprintSha256) {
      return { items: [], warning: `Bitwarden SSH Cipher ${cipherId} 的密钥字段为空，已保留原始信封。` };
    }
    const decodedFields = await decodeBitwardenCustomFields(arrayValue(raw, "Fields", "fields"), key);
    const customFields = decodedFields
      .filter(isEditableBitwardenUserField)
      .map((field) => ({ name: field.name, value: field.value, protected: field.type === BITWARDEN_HIDDEN_FIELD }));
    const sshKeyData = JSON.stringify({
      algorithm: inferSshAlgorithm(publicKeyOpenSsh),
      keySize: 0,
      publicKeyOpenSsh,
      privateKeyOpenSsh,
      fingerprintSha256,
      comment: "",
      format: "OPENSSH"
    });
    return {
      items: [{
        ...base,
        kind: "login",
        username: "",
        password: "",
        uris: [],
        uriRules: [],
        customFields,
        bitwardenCustomFieldsVersion: BITWARDEN_CUSTOM_FIELDS_VERSION,
        bitwardenSshKeyMode: "native",
        loginType: "SSH_KEY",
        sshKeyData
      } satisfies LoginItem]
    };
  }

  return { items: [], warning: `Bitwarden Cipher ${cipherId} 的类型 ${type} 暂不支持。`, unsupported: true };
}

export async function resolveBitwardenCipherKey(raw: Record<string, unknown>, vaultKey: BitwardenSymmetricKey): Promise<BitwardenSymmetricKey> {
  const keyCipher = stringValue(raw, "Key", "key");
  return keyCipher ? decryptBitwardenSymmetricKey(keyCipher, vaultKey) : vaultKey;
}

export async function encodeBitwardenCipher(item: VaultItem, encryptionKey: BitwardenSymmetricKey, preservedRaw?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const preserved = preservedRaw || {};
  const base = cipherRequestBody(preserved);
  const nativeSsh = isNativeBitwardenSshCipher(item, preserved);
  base.type = nativeSsh ? 5 : bitwardenType(item);
  base.name = await encryptBitwardenString(item.title, encryptionKey);
  base.notes = item.notes ? await encryptBitwardenString(item.notes, encryptionKey) : null;
  base.favorite = item.favorite;
  base.reprompt = numberValue(preserved, "Reprompt", "reprompt");
  base.key = value(preserved, "Key", "key") ?? null;
  base.organizationId = value(preserved, "OrganizationId", "organizationId") ?? null;
  const collectionReference = item.providerRefs.find((reference) => reference.remoteCollectionIds !== undefined);
  base.collectionIds = collectionReference?.remoteCollectionIds !== undefined
    ? collectionReference.remoteCollectionIds
    : value(preserved, "CollectionIds", "collectionIds") ?? null;
  base.folderId = item.providerRefs.find((reference) => reference.remoteFolderId)?.remoteFolderId || null;
  base.fields = value(preserved, "Fields", "fields") ?? null;
  base.archivedDate = item.archivedAt || null;

  if (item.kind === "login") {
    if (nativeSsh) {
      const sshData = parseSshKeyData(item.sshKeyData) || {};
      const sshKey = cipherRequestBody(recordValue(preserved, "SshKey", "SSHKey", "sshKey", "ssh_key") || {});
      sshKey.privateKey = await encryptOptional(stringProperty(sshData, "privateKeyOpenSsh") || "", encryptionKey);
      sshKey.publicKey = await encryptOptional(stringProperty(sshData, "publicKeyOpenSsh") || "", encryptionKey);
      sshKey.keyFingerprint = await encryptOptional(stringProperty(sshData, "fingerprintSha256") || "", encryptionKey);
      base.sshKey = sshKey;
      base.fields = await mergeCipherFieldsPreservingUnknown(item, arrayValue(preserved, "Fields", "fields"), encryptionKey, false);
    } else {
      const login = cipherRequestBody(recordValue(preserved, "Login", "login") || {});
      login.username = await encryptOptional(item.username, encryptionKey);
      login.password = await encryptOptional(item.password, encryptionKey);
      login.totp = await encryptOptional(item.totpSecret || "", encryptionKey);
      login.uris = await Promise.all(effectiveLoginUriRules(item).map(async (rule) => ({
        uri: await encryptBitwardenString(rule.uri, encryptionKey),
        match: bitwardenMatchCode(rule.matchType)
      })));
      login.fido2Credentials = login.fido2Credentials ?? null;
      base.login = login;
      base.fields = await mergeCipherFieldsPreservingUnknown(item, arrayValue(preserved, "Fields", "fields"), encryptionKey);
    }
  } else if (item.kind === "card") {
    const card = cipherRequestBody(recordValue(preserved, "Card", "card") || {});
    card.cardholderName = await encryptOptional(item.cardholderName, encryptionKey);
    card.number = await encryptOptional(item.number, encryptionKey);
    card.expMonth = await encryptOptional(item.expiryMonth, encryptionKey);
    card.expYear = await encryptOptional(item.expiryYear, encryptionKey);
    card.code = await encryptOptional(item.securityCode, encryptionKey);
    card.brand = await encryptOptional(item.brand || "", encryptionKey);
    base.card = card;
  } else if (item.kind === "identity") {
    const identity = cipherRequestBody(recordValue(preserved, "Identity", "identity") || {});
    identity.title = identity.title ?? null;
    identity.firstName = await encryptOptional(item.firstName, encryptionKey);
    identity.middleName = await encryptOptional(item.middleName, encryptionKey);
    identity.lastName = await encryptOptional(item.lastName, encryptionKey);
    identity.address1 = await encryptOptional(item.address?.streetAddress || "", encryptionKey);
    identity.address2 = await encryptOptional(item.address?.apartment || "", encryptionKey);
    identity.address3 = identity.address3 ?? null;
    identity.city = await encryptOptional(item.address?.city || "", encryptionKey);
    identity.state = await encryptOptional(item.address?.stateProvince || "", encryptionKey);
    identity.postalCode = await encryptOptional(item.address?.postalCode || "", encryptionKey);
    identity.country = await encryptOptional(item.address?.country || "", encryptionKey);
    identity.company = identity.company ?? null;
    identity.email = await encryptOptional(item.email || "", encryptionKey);
    identity.phone = await encryptOptional(item.phone || "", encryptionKey);
    identity.ssn = item.documentType === "SOCIAL_SECURITY" ? await encryptOptional(item.documentNumber, encryptionKey) : null;
    identity.passportNumber = item.documentType === "PASSPORT" ? await encryptOptional(item.documentNumber, encryptionKey) : null;
    identity.licenseNumber = item.documentType === "DRIVER_LICENSE" ? await encryptOptional(item.documentNumber, encryptionKey) : null;
    base.identity = identity;
  } else if (item.kind === "secure-note") {
    base.notes = await encryptOptional(item.content, encryptionKey);
    base.secureNote = recordValue(preserved, "SecureNote", "secureNote") || { type: 0 };
  }
  return base;
}

/**
 * Bitwarden answers `/sync` in PascalCase but binds write requests in camelCase, so every preserved
 * key — including ones this codec has no model for, such as attachments or passwordHistory — has to
 * be carried across under the request casing or the server drops it.
 */
function cipherRequestBody(preserved: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(preserved).map(([name, entry]) => [lowerFirst(name), entry]));
}

/**
 * Change only the top-level folder routing field of an already encrypted Cipher.
 * Encrypted values and unknown fields are copied without decrypting or re-encoding them.
 */
export function routeBitwardenCipherToFolder(raw: Record<string, unknown>, folderId?: string): Record<string, unknown> {
  const payload = Object.fromEntries(Object.entries(raw).map(([name, entry]) => [lowerFirst(name), entry]));
  payload.folderId = folderId || null;
  return payload;
}

/**
 * Replace only the top-level organization Collection routing list. The caller must have already
 * checked organization ownership and permissions; this helper deliberately performs no decryption.
 */
export function routeBitwardenCipherToCollections(raw: Record<string, unknown>, collectionIds: string[]): Record<string, unknown> {
  const payload = Object.fromEntries(Object.entries(raw).map(([name, entry]) => [lowerFirst(name), entry]));
  payload.collectionIds = [...collectionIds];
  return payload;
}

/**
 * Merge a possibly reduced server Cipher response over the complete encrypted projection held by
 * the caller. Unknown fields and nested encrypted values stay byte-for-byte intact.
 */
export function mergeBitwardenCipherProjection(
  original: Record<string, unknown>,
  response: Record<string, unknown>,
  patch: { folderId?: string; collectionIds?: string[] } = {}
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...original, ...response };
  const cipherId = stringValue(response, "Id", "id") || stringValue(original, "Id", "id");
  const hasResponseRevision = Object.prototype.hasOwnProperty.call(response, "RevisionDate") || Object.prototype.hasOwnProperty.call(response, "revisionDate");
  const revision = stringValue(response, "RevisionDate", "revisionDate");
  const hasFolderPatch = Object.prototype.hasOwnProperty.call(patch, "folderId");
  const hasCollectionPatch = Object.prototype.hasOwnProperty.call(patch, "collectionIds");
  const hasResponseFolder = Object.prototype.hasOwnProperty.call(response, "FolderId") || Object.prototype.hasOwnProperty.call(response, "folderId");
  const hasOriginalFolder = Object.prototype.hasOwnProperty.call(original, "FolderId") || Object.prototype.hasOwnProperty.call(original, "folderId");
  const folderId = hasFolderPatch
    ? patch.folderId
    : (hasResponseFolder ? stringValue(response, "FolderId", "folderId") : stringValue(original, "FolderId", "folderId"));
  const hasResponseCollections = Object.prototype.hasOwnProperty.call(response, "CollectionIds") || Object.prototype.hasOwnProperty.call(response, "collectionIds");
  const hasOriginalCollections = Object.prototype.hasOwnProperty.call(original, "CollectionIds") || Object.prototype.hasOwnProperty.call(original, "collectionIds");
  const collectionIds = hasCollectionPatch
    ? [...(patch.collectionIds || [])]
    : (hasResponseCollections ? stringArrayValue(response, "CollectionIds", "collectionIds") || [] : stringArrayValue(original, "CollectionIds", "collectionIds") || []);
  merged.id = cipherId;
  // A reduced mutation response must not inherit the old revision. Callers use
  // the missing value to fail closed instead of treating a stale baseline as a
  // freshly acknowledged server revision.
  if (hasResponseRevision) merged.revisionDate = revision;
  else delete merged.revisionDate;
  if (hasFolderPatch || hasResponseFolder || hasOriginalFolder) merged.folderId = folderId || null;
  else delete merged.folderId;
  if (hasCollectionPatch || hasResponseCollections || hasOriginalCollections) merged.collectionIds = collectionIds;
  else delete merged.collectionIds;
  delete merged.Id;
  delete merged.RevisionDate;
  delete merged.FolderId;
  delete merged.CollectionIds;
  for (const [canonical, pascal] of [["login", "Login"], ["card", "Card"], ["identity", "Identity"], ["secureNote", "SecureNote"], ["sshKey", "SshKey"]] as const) {
    const originalNested = isRecord(original[canonical]) ? original[canonical] : original[pascal];
    const responseNested = isRecord(response[canonical]) ? response[canonical] : response[pascal];
    if (isRecord(originalNested) && isRecord(responseNested)) merged[canonical] = { ...originalNested, ...responseNested };
  }
  return merged;
}

/**
 * Mirrors Android's adapter boundary. Unsupported raw entries always survive. Before the first
 * adapter-aware response, remote-only editable occurrences also survive; afterwards the local list
 * is authoritative, so deletion and rename are possible without collapsing duplicate occurrences.
 */
async function mergeCipherFieldsPreservingUnknown(
  item: LoginItem,
  remoteFields: unknown[],
  encryptionKey: BitwardenSymmetricKey,
  includeSystemFields = true
): Promise<unknown[] | null> {
  const systemFields = includeSystemFields ? buildBitwardenSystemFields(item) : [];
  const localFields = item.customFields.filter((field) => field.name.trim());
  const outgoing = [...systemFields, ...localFields];
  const encoded = await Promise.all(outgoing.map(async (field) => ({
    type: field.protected ? BITWARDEN_HIDDEN_FIELD : BITWARDEN_TEXT_FIELD,
    name: await encryptOptional(field.name, encryptionKey),
    value: await encryptOptional(field.value, encryptionKey),
    linkedId: null
  })));
  if (!remoteFields.length) return encoded.length ? encoded : null;
  const remotePlain = await decodeBitwardenCustomFields(remoteFields, encryptionKey);
  const initialized = item.bitwardenCustomFieldsVersion === BITWARDEN_CUSTOM_FIELDS_VERSION;
  const generatedSystemNames = new Set(systemFields.map((field) => field.name));
  const remainingLocalOccurrences = occurrenceCounts(localFields);
  const preserved: unknown[] = [];
  for (const field of remotePlain) {
    if (field.name && generatedSystemNames.has(field.name)) continue;
    if (!isEditableBitwardenUserField(field)) {
      preserved.push(field.raw);
      continue;
    }
    if (initialized) continue;
    const key = secureFieldOccurrenceKey({
      name: field.name,
      value: field.value,
      protected: field.type === BITWARDEN_HIDDEN_FIELD
    });
    const remaining = remainingLocalOccurrences.get(key) || 0;
    if (remaining > 0) {
      if (remaining === 1) remainingLocalOccurrences.delete(key);
      else remainingLocalOccurrences.set(key, remaining - 1);
    } else {
      preserved.push(field.raw);
    }
  }
  const merged = [...preserved, ...encoded];
  return merged.length ? merged : null;
}

/** Android-compatible remote-first merge by complete value and exact occurrence count. */
export function mergeBitwardenCustomFieldOccurrences(
  remote: SecureCustomField[],
  legacyLocal: SecureCustomField[]
): { fields: SecureCustomField[]; needsUpload: boolean } {
  const remainingRemote = occurrenceCounts(remote);
  const additions: SecureCustomField[] = [];
  for (const field of legacyLocal) {
    if (!field.name.trim() || RESERVED_PASSWORD_FIELD_NAMES.has(field.name)) continue;
    const key = secureFieldOccurrenceKey(field);
    const remaining = remainingRemote.get(key) || 0;
    if (remaining > 0) {
      if (remaining === 1) remainingRemote.delete(key);
      else remainingRemote.set(key, remaining - 1);
    } else {
      additions.push(field);
    }
  }
  return { fields: [...remote, ...additions], needsUpload: additions.length > 0 };
}

async function decodeBitwardenCustomFields(entries: unknown[], key: BitwardenSymmetricKey): Promise<PlainBitwardenCustomField[]> {
  return Promise.all(entries.map(async (entry) => {
    const field = record(entry);
    const linkedId = value(field, "LinkedId", "linkedId");
    return {
      raw: entry,
      name: (await decryptBitwardenString(stringValue(field, "Name", "name"), key).catch(() => "")).trim(),
      value: await decryptBitwardenString(stringValue(field, "Value", "value"), key).catch(() => ""),
      type: numberValue(field, "Type", "type"),
      linked: linkedId !== null && linkedId !== undefined
    };
  }));
}

function isEditableBitwardenUserField(field: PlainBitwardenCustomField): boolean {
  return Boolean(field.name) && !field.linked &&
    (field.type === BITWARDEN_TEXT_FIELD || field.type === BITWARDEN_HIDDEN_FIELD) &&
    !RESERVED_PASSWORD_FIELD_NAMES.has(field.name);
}

function occurrenceCounts(fields: SecureCustomField[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const field of fields) {
    const key = secureFieldOccurrenceKey(field);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function secureFieldOccurrenceKey(field: Pick<SecureCustomField, "name" | "value" | "protected">): string {
  return JSON.stringify([field.name, field.value, field.protected]);
}

function bitwardenSystemFieldMap(fields: PlainBitwardenCustomField[]): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const field of fields) if (field.name) mapped.set(field.name, field.value);
  return mapped;
}

function bitwardenSystemValue(fields: Map<string, string>, ...names: string[]): string {
  for (const name of names) if (fields.has(name)) return fields.get(name) || "";
  return "";
}

function bitwardenLoginType(fields: Map<string, string>, sshKeyData?: string): LoginItem["loginType"] {
  if (sshKeyData) return "SSH_KEY";
  const value = bitwardenSystemValue(fields, "monica_login_type").trim().toUpperCase();
  if (value === "STEAM_MAFILE") return value;
  return value === "PASSWORD" || value === "SSO" || value === "WIFI" || value === "SSH_KEY" || value === "BARCODE"
    ? value
    : undefined;
}

function bitwardenSshKeyData(fields: Map<string, string>): string | undefined {
  const algorithm = bitwardenSystemValue(fields, "monica_ssh_algorithm");
  const publicKeyOpenSsh = bitwardenSystemValue(fields, "monica_ssh_public_key");
  const privateKeyOpenSsh = bitwardenSystemValue(fields, "monica_ssh_private_key");
  const fingerprintSha256 = bitwardenSystemValue(fields, "monica_ssh_fingerprint");
  if (!algorithm && !publicKeyOpenSsh && !privateKeyOpenSsh && !fingerprintSha256) return undefined;
  const parsedSize = Number.parseInt(bitwardenSystemValue(fields, "monica_ssh_key_size"), 10);
  return JSON.stringify({
    algorithm,
    keySize: Number.isInteger(parsedSize) && parsedSize > 0 ? parsedSize : 0,
    publicKeyOpenSsh,
    privateKeyOpenSsh,
    fingerprintSha256,
    comment: bitwardenSystemValue(fields, "monica_ssh_comment"),
    format: bitwardenSystemValue(fields, "monica_ssh_format") || "OPENSSH"
  });
}

/** Only fields represented by the selected Bitwarden wire format participate in durable recovery. */
export function bitwardenSshComparableData(item: LoginItem): string | undefined {
  if (item.loginType !== "SSH_KEY") return item.sshKeyData;
  const ssh = parseSshKeyData(item.sshKeyData);
  if (!ssh) return item.sshKeyData;
  const shared = {
    publicKeyOpenSsh: stringProperty(ssh, "publicKeyOpenSsh") || "",
    privateKeyOpenSsh: stringProperty(ssh, "privateKeyOpenSsh") || "",
    fingerprintSha256: stringProperty(ssh, "fingerprintSha256") || ""
  };
  return JSON.stringify(item.bitwardenSshKeyMode === "native" ? shared : {
    algorithm: stringProperty(ssh, "algorithm") || "",
    keySize: numberProperty(ssh, "keySize"),
    ...shared,
    comment: stringProperty(ssh, "comment") || "",
    format: stringProperty(ssh, "format") || "OPENSSH"
  });
}

/** Preserve Android/future metadata that the current Bitwarden format cannot represent. */
export function mergeBitwardenSshLocalMetadata(local: LoginItem, remote: LoginItem): string | undefined {
  if (local.loginType !== "SSH_KEY" || remote.loginType !== "SSH_KEY") return remote.sshKeyData;
  const localSsh = parseSshKeyData(local.sshKeyData);
  const remoteSsh = parseSshKeyData(remote.sshKeyData);
  if (!localSsh) return remote.sshKeyData;
  if (!remoteSsh) return local.sshKeyData;
  const merged: Record<string, unknown> = { ...localSsh, ...remoteSsh };
  if (remote.bitwardenSshKeyMode === "native") {
    for (const field of ["keySize", "comment", "format"] as const) {
      if (localSsh[field] !== undefined) merged[field] = localSsh[field];
    }
  }
  return JSON.stringify(merged);
}

function isNativeBitwardenSshCipher(item: VaultItem, preserved: Record<string, unknown>): boolean {
  return item.kind === "login" && item.loginType === "SSH_KEY" && numberValue(preserved, "Type", "type") === 5;
}

function inferSshAlgorithm(publicKey: string): string {
  const normalized = publicKey.trim().toLowerCase();
  if (normalized.startsWith("ssh-rsa")) return "RSA";
  if (normalized.startsWith("ssh-ed25519")) return "ED25519";
  return "";
}

function buildBitwardenSystemFields(item: LoginItem): SecureCustomField[] {
  const fields: SecureCustomField[] = [];
  const add = (name: string, value: string | undefined, protectedField = false) => {
    if (value?.trim()) fields.push({ name, value, protected: protectedField });
  };
  const ssh = parseSshKeyData(item.sshKeyData);
  const addSsh = (privateProtected: boolean) => {
    if (!ssh) return;
    add("monica_ssh_algorithm", stringProperty(ssh, "algorithm"));
    const keySize = numberProperty(ssh, "keySize");
    add("monica_ssh_key_size", keySize > 0 ? String(keySize) : undefined);
    add("monica_ssh_public_key", stringProperty(ssh, "publicKeyOpenSsh"));
    add("monica_ssh_private_key", stringProperty(ssh, "privateKeyOpenSsh"), privateProtected);
    add("monica_ssh_fingerprint", stringProperty(ssh, "fingerprintSha256"));
    add("monica_ssh_comment", stringProperty(ssh, "comment"));
    add("monica_ssh_format", stringProperty(ssh, "format"));
  };

  if (item.loginType === "SSH_KEY") {
    addSsh(true);
    add("monica_login_type", "SSH_KEY");
    return fields;
  }

  add("monica_app_package", item.appPackageName);
  add("appPackageName", item.appPackageName);
  add("monica_app_name", item.appName);
  add("appName", item.appName);
  add("monica_email", item.email);
  add("email", item.email);
  add("monica_phone", item.phone);
  add("phone", item.phone);
  add("monica_address_line", item.addressLine);
  add("monica_city", item.city);
  add("monica_state", item.state);
  add("monica_zip_code", item.zipCode);
  add("monica_country", item.country);
  add("monica_passkey_bindings", item.passkeyBindings);
  addSsh(false);
  add("address", [item.addressLine, item.city, item.state, item.zipCode, item.country].filter(Boolean).join(", "));
  return fields;
}

function parseSshKeyData(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringProperty(raw: Record<string, unknown>, name: string): string | undefined {
  return typeof raw[name] === "string" ? raw[name] as string : undefined;
}

function numberProperty(raw: Record<string, unknown>, name: string): number {
  return typeof raw[name] === "number" && Number.isFinite(raw[name]) ? Math.floor(raw[name] as number) : 0;
}


export async function encodeBitwardenPasskeyCipher(
  item: PasskeyItem,
  encryptionKey: BitwardenSymmetricKey,
  preservedRaw?: Record<string, unknown>,
  operation: "upsert" | "delete" = "upsert"
): Promise<Record<string, unknown>> {
  if (item.algorithm !== -7) throw new Error("当前只能把 ES256 Passkey 保存到 Bitwarden。");
  if (operation === "upsert" && !item.privateKeyPkcs8) throw new Error("Bitwarden Passkey 缺少可同步的 PKCS#8 私钥。");
  if (preservedRaw && numberValue(preservedRaw, "Type", "type") !== 1) throw new Error("Bitwarden Passkey 的父项目不是登录 Cipher。");

  const preservedLogin = recordValue(preservedRaw || {}, "Login", "login") || {};
  const existingCredentials = arrayValue(preservedLogin, "Fido2Credentials", "fido2Credentials").map(record);
  const matched = await Promise.all(existingCredentials.map(async (credential) => ({
    credential,
    credentialId: await decryptBitwardenString(stringValue(credential, "CredentialId", "credentialId"), encryptionKey)
  })));
  const replacement = operation === "upsert" ? await encodeFido2Credential(item, encryptionKey, matched.find((entry) => entry.credentialId === item.credentialId)?.credential) : undefined;
  const fido2Credentials = matched.flatMap((entry) => entry.credentialId === item.credentialId ? (replacement ? [replacement] : []) : [entry.credential]);
  if (replacement && !matched.some((entry) => entry.credentialId === item.credentialId)) fido2Credentials.push(replacement);

  if (!preservedRaw) {
    return {
      type: 1,
      name: await encryptBitwardenString(item.title, encryptionKey),
      notes: await encryptOptional(item.notes, encryptionKey),
      favorite: item.favorite,
      reprompt: 0,
      key: null,
      archivedDate: item.archivedAt || null,
      folderId: item.providerRefs.find((reference) => reference.remoteFolderId)?.remoteFolderId || null,
      fields: null,
      login: {
        username: await encryptOptional(item.userName, encryptionKey),
        password: null,
        totp: null,
        uris: [{ uri: await encryptBitwardenString(`https://${item.rpId}`, encryptionKey), match: null }],
        fido2Credentials
      }
    };
  }

  const base = cipherRequestBody(preservedRaw);
  base.type = 1;
  base.name = value(preservedRaw, "Name", "name") || await encryptBitwardenString(item.title, encryptionKey);
  base.notes = value(preservedRaw, "Notes", "notes") ?? null;
  base.favorite = value(preservedRaw, "Favorite", "favorite") === true;
  base.archivedDate = item.archivedAt || null;
  base.reprompt = numberValue(preservedRaw, "Reprompt", "reprompt");
  base.key = value(preservedRaw, "Key", "key") ?? null;
  base.organizationId = value(preservedRaw, "OrganizationId", "organizationId") ?? null;
  base.collectionIds = value(preservedRaw, "CollectionIds", "collectionIds") ?? null;
  base.folderId = value(preservedRaw, "FolderId", "folderId") ?? null;
  base.fields = value(preservedRaw, "Fields", "fields") ?? null;
  const login = cipherRequestBody(preservedLogin);
  login.username = value(preservedLogin, "Username", "username") ?? null;
  login.password = value(preservedLogin, "Password", "password") ?? null;
  login.totp = value(preservedLogin, "Totp", "totp") ?? null;
  login.uris = value(preservedLogin, "Uris", "uris") ?? [];
  login.passwordRevisionDate = value(preservedLogin, "PasswordRevisionDate", "passwordRevisionDate") ?? null;
  login.autofillOnPageLoad = value(preservedLogin, "AutofillOnPageLoad", "autofillOnPageLoad") ?? null;
  login.fido2Credentials = fido2Credentials;
  base.login = login;
  return base;
}

async function encodeFido2Credential(item: PasskeyItem, key: BitwardenSymmetricKey, preserved?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const unknown = Object.fromEntries(Object.entries(preserved || {}).filter(([name]) => !FIDO2_FIELD_NAMES.has(name.toLowerCase())));
  return {
    ...unknown,
    credentialId: await encryptBitwardenString(item.credentialId, key),
    keyAlgorithm: await encryptBitwardenString(item.keyAlgorithm || "ECDSA", key),
    keyValue: await encryptBitwardenString(item.privateKeyPkcs8 || "", key),
    rpId: await encryptBitwardenString(item.rpId, key),
    rpName: await encryptBitwardenString(item.rpName || item.title, key),
    counter: await encryptBitwardenString(String(Math.max(0, Math.floor(item.signCount))), key),
    userHandle: await encryptBitwardenString(item.userHandle, key),
    userName: await encryptBitwardenString(item.userName, key),
    userDisplayName: await encryptBitwardenString(item.userDisplayName, key),
    discoverable: await encryptBitwardenString(String(item.discoverable), key),
    creationDate: await encryptBitwardenString(item.createdAt, key)
  };
}

const FIDO2_FIELD_NAMES = new Set([
  "credentialid", "keyalgorithm", "keyvalue", "rpid", "rpname", "counter", "userhandle", "username", "userdisplayname", "discoverable", "creationdate"
]);

function bitwardenType(item: VaultItem): number {
  if (item.kind === "login") return 1;
  if (item.kind === "secure-note") return 2;
  if (item.kind === "card") return 3;
  if (item.kind === "identity") return 4;
  throw new Error(`此 Monica 项目类型暂不能保存到 Bitwarden：${item.kind}`);
}

async function decodeFido2Credentials(
  login: Record<string, unknown>,
  base: { id: string; title: string; favorite: boolean; notes: string; createdAt: string; updatedAt: string },
  cipherReference: ProviderReference,
  key: BitwardenSymmetricKey
): Promise<PasskeyItem[]> {
  return Promise.all(arrayValue(login, "Fido2Credentials", "fido2Credentials").map(async (entry, index) => {
    const fido = record(entry);
    const decrypted = await decryptFidoRecordFields(fido, key, ["CredentialId", "KeyAlgorithm", "KeyValue", "RpId", "RpName", "Counter", "UserHandle", "UserName", "UserDisplayName", "Discoverable", "CreationDate"]);
    const credentialId = decrypted.CredentialId || `unknown-${index}`;
    const algorithm = normalizePasskeyAlgorithm(decrypted.KeyAlgorithm);
    return {
      ...base,
      id: `${base.id}:passkey:${credentialId}`,
      kind: "passkey",
      title: decrypted.RpName || base.title,
      credentialId,
      rpId: decrypted.RpId,
      rpName: decrypted.RpName,
      userHandle: decrypted.UserHandle,
      userName: decrypted.UserName,
      userDisplayName: decrypted.UserDisplayName,
      algorithm,
      keyAlgorithm: decrypted.KeyAlgorithm || undefined,
      publicKey: "",
      privateKeyPkcs8: decrypted.KeyValue || undefined,
      signCount: Number(decrypted.Counter) || 0,
      discoverable: decrypted.Discoverable.toLowerCase() !== "false",
      sourceMode: "bitwarden",
      createdAt: dateValue(decrypted.CreationDate, base.createdAt),
      providerRefs: [{ ...cipherReference, remoteId: `${cipherReference.remoteId}#fido2:${credentialId}` }]
    } satisfies PasskeyItem;
  }));
}

async function decryptRecordFields(raw: Record<string, unknown>, key: BitwardenSymmetricKey, names: string[]): Promise<Record<string, string>> {
  const pairs = await Promise.all(names.map(async (name) => [name, await decryptField(raw, key, name, lowerFirst(name))] as const));
  return Object.fromEntries(pairs);
}

function decryptField(raw: Record<string, unknown>, key: BitwardenSymmetricKey, ...names: string[]): Promise<string> {
  return decryptBitwardenString(stringValue(raw, ...names), key);
}

function encryptOptional(value: string, key: BitwardenSymmetricKey): Promise<string | null> {
  return value ? encryptBitwardenString(value, key) : Promise.resolve(null);
}

function normalizePasskeyAlgorithm(value: string): PasskeyItem["algorithm"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "ecdsa" || normalized === "es256") return -7;
  if (normalized === "rsa" || normalized === "rs256") return -257;
  if (normalized === "ps256") return -37;
  if (normalized === "eddsa" || normalized === "ed25519") return -8;
  // Fail closed: unknown or empty algorithms must not masquerade as ES256.
  // Use a non-ES256 COSE value so passkeyAvailability marks the item unsupported
  // without claiming a concrete supported algorithm family.
  return -257;
}

function dateValue(raw: unknown, fallback = new Date().toISOString()): string {
  if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  return fallback;
}

function optionalDateValue(raw: unknown): string | undefined {
  return typeof raw === "string" && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : undefined;
}

function lowerFirst(value: string): string {
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}

function value(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (name in raw) return raw[name];
  return undefined;
}

function effectiveLoginUriRules(item: LoginItem): LoginUriRule[] {
  const rules = item.uriRules?.filter((rule) => rule.uri.trim()) || [];
  const known = new Set(rules.map((rule) => rule.uri));
  return [...rules, ...item.uris.filter((uri) => uri.trim() && !known.has(uri)).map((uri) => ({ uri, matchType: "base-domain" as const }))];
}

function bitwardenMatchType(value: unknown): LoginUriMatchType {
  return ({ 0: "base-domain", 1: "domain", 2: "starts-with", 3: "exact", 4: "regex", 5: "never" } as Record<number, LoginUriMatchType>)[Number(value)] || "base-domain";
}

function bitwardenMatchCode(value: LoginUriMatchType): number {
  return ({ "base-domain": 0, domain: 1, "starts-with": 2, exact: 3, regex: 4, never: 5 } as const)[value];
}

function stringValue(raw: Record<string, unknown>, ...names: string[]): string {
  const result = value(raw, ...names);
  return typeof result === "string" ? result : result == null ? "" : String(result);
}

function numberValue(raw: Record<string, unknown>, ...names: string[]): number {
  const result = Number(value(raw, ...names));
  return Number.isFinite(result) ? result : 0;
}

function booleanValue(raw: Record<string, unknown>, ...names: string[]): boolean {
  return value(raw, ...names) === true;
}

function recordValue(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown> | undefined {
  const result = value(raw, ...names);
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
}

function arrayValue(raw: Record<string, unknown>, ...names: string[]): unknown[] {
  const result = value(raw, ...names);
  return Array.isArray(result) ? result : [];
}

function decodeStandaloneTotp(login: LoginItem, rawSecret: string, reference: ProviderReference): TotpItem | undefined {
  let parameters;
  try {
    parameters = parseTotpParameters(rawSecret);
  } catch {
    // Keep the parent Login usable even when a legacy/custom OTP payload is not
    // understood by this build; it remains available through login.totpSecret.
    return undefined;
  }
  const secret = parameters.secret || rawSecret;
  const otpType = parameters.otpType || "TOTP";
  return {
    id: `${login.id}:totp`,
    kind: "totp",
    title: login.title,
    favorite: login.favorite,
    notes: login.notes,
    createdAt: login.createdAt,
    updatedAt: login.updatedAt,
    providerRefs: [{ ...reference, remoteId: `${reference.remoteId}#totp` }],
    secret,
    issuer: parameters.issuer || login.title,
    accountName: parameters.accountName || login.username,
    otpType,
    counter: parameters.counter,
    pin: parameters.pin,
    pinLength: parameters.pinLength,
    algorithm: parameters.algorithm,
    digits: parameters.digits,
    period: parameters.period,
    steamSharedSecretBase64: parameters.secretEncoding === "base64" ? parameters.secret : undefined
  };
}

/** Some self-hosted Bitwarden versions return FIDO2 enum/scalar fields in plaintext. */
async function decryptFidoRecordFields(raw: Record<string, unknown>, key: BitwardenSymmetricKey, names: string[]): Promise<Record<string, string>> {
  const pairs = await Promise.all(names.map(async (name) => {
    const value = stringValue(raw, name, lowerFirst(name));
    if (!value) return [name, ""] as const;
    if (!looksLikeCipherString(value)) return [name, value] as const;
    return [name, await decryptBitwardenString(value, key)] as const;
  }));
  return Object.fromEntries(pairs);
}

function looksLikeCipherString(value: string): boolean {
  return /^(?:0|2)\.[^|]+\|[^|]+(?:\|[^|]+)?$/.test(value) || /^\.[^|]+\|[^|]+$/.test(value);
}

function stringArrayValue(raw: Record<string, unknown>, ...names: string[]): string[] | undefined {
  const result = value(raw, ...names);
  if (!Array.isArray(result)) return undefined;
  const ids = result.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 512);
  return [...new Set(ids)];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
