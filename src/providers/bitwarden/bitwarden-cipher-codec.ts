import type { CardItem, IdentityItem, LoginItem, LoginUriMatchType, LoginUriRule, PasskeyItem, ProviderReference, SecureCustomField, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";
import { decryptBitwardenString, decryptBitwardenSymmetricKey, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { parseTotpParameters } from "../../core/totp";
import { parsePortablePasskeyPrivateKey } from "../../passkey/private-key-portability";
import { decodeBitwardenCredentialId, normalizeCredentialId, toBitwardenCredentialId } from "../../passkey/source-policy";
import { normalizeRpId } from "../../passkey/webauthn-core";
import { jsonScalarText, parseLosslessJson } from "../../core/lossless-json";
import { assertWritableSshKeyData } from "../../core/ssh-key-data";
import { readProjectCredential } from "../../core/project-credentials";
import { parsePasswordCoverField } from "../../core/password-cover";
import { walletFieldsToItem, walletItemToFields, walletManagedNames, type WalletItem } from "./bitwarden-wallet-fields";

export const BITWARDEN_CUSTOM_FIELDS_VERSION = 1 as const;

const BITWARDEN_TEXT_FIELD = 0;
const BITWARDEN_HIDDEN_FIELD = 1;
// Extension transport metadata. Android's current Bitwarden mapper does not consume these yet.
const CUSTOM_ICON_FIELD_NAMES = new Set(["monica_custom_icon_type", "monica_custom_icon_value", "monica_custom_icon_updated_at"]);
const GROUP_COVER_FIELD = "monica_group_cover";
const PASSWORD_METADATA_ALIASES: readonly (readonly string[])[] = [
  ["monica_app_package", "appPackageName"], ["monica_app_name", "appName"],
  ["monica_email", "email"], ["monica_phone", "phone"],
  ["monica_address_line", "addressLine", "address"], ["monica_city", "city"],
  ["monica_state", "state"], ["monica_zip_code", "zipCode"], ["monica_country", "country"],
  ["monica_passkey_bindings"]
];
const PASSWORD_METADATA_NAMES = new Set(PASSWORD_METADATA_ALIASES.flat());
const SSH_METADATA_NAMES = new Set(['algorithm', 'key_size', 'public_key', 'private_key', 'fingerprint', 'comment', 'format'].map(name => `monica_ssh_${name}`));
const PASSWORD_METADATA_KEYS = ["appPackageName", "appName", "email", "phone", "addressLine", "city", "state", "zipCode", "country", "passkeyBindings"] as const;
const RESERVED_PASSWORD_FIELD_NAMES = new Set([
  ...CUSTOM_ICON_FIELD_NAMES,
  "monica_app_package", "appPackageName", "monica_app_name", "appName",
  "monica_email", "email", "monica_phone", "phone",
  "monica_address_line", "addressLine", "address", "monica_city", "city",
  "monica_state", "state", "monica_zip_code", "zipCode", "monica_country", "country",
  "monica_passkey_bindings", "monica_login_type",
  "monica_wifi_data", "MonicaWifiData",
  "monica_sso_provider", "monica_sso_ref_entry_id", "monica_sso_ref_logical_id",
  "monica_ssh_algorithm", "monica_ssh_key_size", "monica_ssh_public_key",
  "monica_ssh_private_key", "monica_ssh_fingerprint", "monica_ssh_comment", "monica_ssh_format"
]);
const RESERVED_NOTE_FIELD_NAMES = new Set(["monica_note_markdown", "monica_note_tags"]);

interface PlainBitwardenCustomField {
  raw: unknown;
  name: string;
  value: string;
  type: number;
  linked: boolean;
  readable: boolean;
}

export interface DecodedBitwardenCipher {
  items: VaultItem[];
  warning?: string;
  /** The login is usable; unreadable historical rows remain in its source envelope. */
  historyWarning?: string;
  unsupported?: boolean;
}

export async function decodeBitwardenCipher(raw: Record<string, unknown>, providerId: string, vaultKey: BitwardenSymmetricKey, remoteFolderName?: string): Promise<DecodedBitwardenCipher> {
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
    providerRefs: [reference],
    ...(remoteFolderName ? { categoryName: remoteFolderName } : {})
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
    const wifiMetadata = bitwardenSystemValue(systemFields, "monica_wifi_data", "MonicaWifiData") || undefined;
    const ssoRefEntryId = optionalPositiveOrZeroInteger(bitwardenSystemValue(systemFields, "monica_sso_ref_entry_id"));
    const history = await decodePasswordHistory(value(raw, 'PasswordHistory', 'passwordHistory'), key);
    const loginItem: LoginItem = {
      ...base,
      kind: "login",
      username,
      password,
      ...(history.rows.length ? { passwordHistory: history.rows.flatMap(row => row.plain ? [row.plain] : []) } : {}),
      ...(history.unreadable ? { passwordHistoryIncomplete: true } : {}),
      uris: [...new Set(uris.filter(Boolean))],
      uriRules: uriRules.filter((rule) => Boolean(rule.uri)),
      totpSecret: totpSecret || undefined,
      customFields,
      // Android CipherSyncProcessor uses this explicit, versioned identity. Titles,
      // accounts and URLs never establish membership; provider scope is separate.
      passwordGroupId: readProjectCredential(customFields)?.projectId,
      isGroupCover: readBitwardenGroupCover(decodedFields),
      bitwardenCustomFieldsVersion: BITWARDEN_CUSTOM_FIELDS_VERSION,
      bitwardenCipherId: cipherId,
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
      ssoProvider: bitwardenSystemValue(systemFields, "monica_sso_provider") || undefined,
      ssoRefEntryId,
      ssoRefLogicalId: bitwardenSystemValue(systemFields, "monica_sso_ref_logical_id") || undefined,
      ...readBitwardenCustomIcon(decodedFields),
      wifiMetadata,
      sshKeyData
    };
    const hasAndroidPasskeyMetadata = notes.includes("[Monica Passkey Metadata]");
    // Older Monica Android builds represented a passwordless item only by appending
    // " [Passkey]" to the Cipher name. There is no FIDO2 array in that format, so
    // keep the parent Login and project a metadata-only child below.
    const hasLegacyPasskeyName = isLegacyPasskeyName(name);
    const passkeys = await decodeFido2Credentials(login, base, reference, key, hasAndroidPasskeyMetadata);
    if (!passkeys.length && (hasAndroidPasskeyMetadata || hasLegacyPasskeyName)) {
      const metadataPasskey = decodeAndroidPasskeyMetadata(base, reference, notes, {
        legacyName: hasLegacyPasskeyName,
        fallbackRpId: extractRpIdFromUriRules(uriRules),
        fallbackUserName: username
      });
      if (metadataPasskey) passkeys.push(metadataPasskey);
    }
    // Bitwarden stores authenticators on Login.Totp for both ordinary credentials
    // and Monica Android's passwordless standalone validator carriers. Keep the
    // parent Login for lossless write-back, and always project a parseable value
    // into the validator list so the manager and autofill UI can discover it.
    const projectedTotp = totpSecret ? decodeStandaloneTotp(loginItem, totpSecret, reference) : undefined;
    return { items: [loginItem, ...(projectedTotp ? [projectedTotp] : []), ...passkeys],
      ...(history.unreadable ? { historyWarning: '部分 Bitwarden 密码历史无法读取，原始加密记录已保留。' } : {}) };
  }

  if (type === 2) {
    const decodedFields = await decodeBitwardenCustomFields(arrayValue(raw, "Fields", "fields"), key);
    const noteSystem = bitwardenSystemFieldMap(decodedFields);
    const tags = parseNoteTags(noteSystem.get("monica_note_tags"));
    const customFields = decodedFields
      .filter((field) => isEditableBitwardenSecureField(field) && !RESERVED_NOTE_FIELD_NAMES.has(field.name))
      .map((field) => ({ name: field.name, value: field.value, protected: field.type === BITWARDEN_HIDDEN_FIELD, ...(field.type === 2 ? { fieldType: "BOOLEAN" as const } : {}) }));
    return { items: [{ ...base, kind: "secure-note", content: notes, customFields, ...(["true", "false"].includes(noteSystem.get("monica_note_markdown") || "") ? { isMarkdown: noteSystem.get("monica_note_markdown") === "true" } : {}), ...(tags ? { tags } : {}) } satisfies SecureNoteItem] };
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
    const wallet = walletFieldsToItem("card", await decodeBitwardenCustomFields(arrayValue(raw, "Fields", "fields"), key)) as Partial<CardItem>;
    return { items: [{ ...base, ...wallet, kind: "card", cardholderName, number, expiryMonth, expiryYear, securityCode, brand: brand || undefined } satisfies CardItem] };
  }

  if (type === 4) {
    const identity = recordValue(raw, "Identity", "identity") || {};
    const fields = await decryptRecordFields(identity, key, [
      "Title", "FirstName", "MiddleName", "LastName", "Address1", "Address2", "Address3", "City", "State", "PostalCode", "Country", "Company", "Username", "Email", "Phone", "Ssn", "PassportNumber", "LicenseNumber"
    ]);
    const fullName = [fields.FirstName, fields.MiddleName, fields.LastName].filter(Boolean).join(" ");
    const wallet = walletFieldsToItem("identity", await decodeBitwardenCustomFields(arrayValue(raw, "Fields", "fields"), key)) as Partial<IdentityItem>;
    const documentType: IdentityItem["documentType"] = fields.PassportNumber ? "PASSPORT" : fields.LicenseNumber ? "DRIVER_LICENSE" : fields.Ssn ? "SOCIAL_SECURITY" : "OTHER";
    return {
      items: [{
        ...base,
        kind: "identity",
        ...wallet,
        documentType: wallet.documentType || documentType,
        documentNumber: fields.PassportNumber || fields.LicenseNumber || fields.Ssn,
        firstName: fields.FirstName,
        middleName: fields.MiddleName,
        lastName: fields.LastName,
        fullName,
        documentTitle: fields.Title,
        company: fields.Company,
        username: fields.Username,
        address3: fields.Address3,
        ssn: fields.Ssn,
        passportNumber: fields.PassportNumber,
        licenseNumber: fields.LicenseNumber,
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
        isGroupCover: readBitwardenGroupCover(decodedFields),
        bitwardenCipherId: cipherId,
        bitwardenSshKeyMode: "native",
        ...readBitwardenCustomIcon(decodedFields),
        loginType: "SSH_KEY",
        sshKeyData
      } satisfies LoginItem]
    };
  }

  const nativeType = jsonScalarText(value(raw, "Type", "type")) || "unknown";
  const fields = await decodeBitwardenCustomFields(arrayValue(raw, "Fields", "fields"), key);
  return {
    items: [{
      ...base,
      id: `${base.id}:opaque`,
      kind: "opaque",
      nativeType: `bitwarden:${nativeType}`,
      payloadSchemaVersion: 1,
      originalPayload: JSON.stringify({ cipher: raw, readableFields: fields.filter(field => field.readable).map(field => ({ name: field.name, value: field.value, protected: field.type === BITWARDEN_HIDDEN_FIELD, type: field.type })) }),
      readOnlyReason: "未知 Bitwarden 类型；可读的公共字段已显示，未来加密字段仍按原样保留，不猜测其格式。"
    }],
    warning: `Bitwarden Cipher ${cipherId} 的类型 ${nativeType} 暂不支持编辑，已提供只读查看。`,
    unsupported: true
  };
}

export async function resolveBitwardenCipherKey(raw: Record<string, unknown>, vaultKey: BitwardenSymmetricKey): Promise<BitwardenSymmetricKey> {
  const keyCipher = stringValue(raw, "Key", "key");
  return keyCipher ? decryptBitwardenSymmetricKey(keyCipher, vaultKey) : vaultKey;
}

export async function encodeBitwardenCipher(item: VaultItem, encryptionKey: BitwardenSymmetricKey, preservedRaw?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (item.kind === 'login') assertWritableSshKeyData(item.sshKeyData);
  if (item.kind === "opaque") throw new Error("未知 Bitwarden 类型仅可只读查看，不能编辑或新建。");
  if (preservedRaw) assertKnownBitwardenCipher(preservedRaw);
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
    if (item.passwordHistoryIncomplete && !(await decodePasswordHistory(value(preserved, 'PasswordHistory', 'passwordHistory'), encryptionKey)).unreadable)
      throw new Error('部分密码历史无法读取，不能完整转移到此密码源，请保留原密码源。');
    if (item.passwordHistory !== undefined) base.passwordHistory = await encodePasswordHistory(item.passwordHistory, value(preserved, 'PasswordHistory', 'passwordHistory'), encryptionKey);
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
      const previousUris = await Promise.all(arrayValue(recordValue(preserved, "Login", "login") || {}, "Uris", "uris").map(async (entry) => ({ raw: record(entry), uri: await decryptField(record(entry), encryptionKey, "Uri", "uri") })));
      login.uris = await Promise.all(effectiveLoginUriRules(item).map(async (rule) => {
        const index = previousUris.findIndex((entry) => entry.uri === rule.uri);
        const previous = index < 0 ? undefined : previousUris.splice(index, 1)[0];
        const raw = { ...previous?.raw };
        delete raw.Uri; delete raw.Match;
        return { ...raw, uri: previous ? value(previous.raw, "Uri", "uri") : await encryptBitwardenString(rule.uri, encryptionKey), match: previous && bitwardenMatchType(value(previous.raw, "Match", "match")) === rule.matchType ? value(previous.raw, "Match", "match") : bitwardenMatchCode(rule.matchType) };
      }));
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
    base.fields = await mergeWalletFields(item, arrayValue(preserved, "Fields", "fields"), encryptionKey);
  } else if (item.kind === "identity") {
    const identity = cipherRequestBody(recordValue(preserved, "Identity", "identity") || {});
    identity.title = item.documentTitle === undefined ? identity.title ?? null : await encryptOptional(item.documentTitle, encryptionKey);
    identity.firstName = await encryptOptional(item.firstName, encryptionKey);
    identity.middleName = await encryptOptional(item.middleName, encryptionKey);
    identity.lastName = await encryptOptional(item.lastName, encryptionKey);
    identity.address1 = await encryptOptional(item.address?.streetAddress || "", encryptionKey);
    identity.address2 = await encryptOptional(item.address?.apartment || "", encryptionKey);
    identity.address3 = item.address3 === undefined ? identity.address3 ?? null : await encryptOptional(item.address3, encryptionKey);
    identity.city = await encryptOptional(item.address?.city || "", encryptionKey);
    identity.state = await encryptOptional(item.address?.stateProvince || "", encryptionKey);
    identity.postalCode = await encryptOptional(item.address?.postalCode || "", encryptionKey);
    identity.country = await encryptOptional(item.address?.country || "", encryptionKey);
    identity.company = item.company === undefined ? identity.company ?? null : await encryptOptional(item.company, encryptionKey);
    identity.username = item.username === undefined ? identity.username ?? null : await encryptOptional(item.username, encryptionKey);
    identity.email = await encryptOptional(item.email || "", encryptionKey);
    identity.phone = await encryptOptional(item.phone || "", encryptionKey);
    identity.ssn = await encryptOptional(item.documentType === "SOCIAL_SECURITY" || item.documentType === "ID_CARD" ? item.documentNumber : item.ssn || "", encryptionKey);
    identity.passportNumber = await encryptOptional(item.documentType === "PASSPORT" ? item.documentNumber : item.passportNumber || "", encryptionKey);
    identity.licenseNumber = await encryptOptional(item.documentType === "DRIVER_LICENSE" ? item.documentNumber : item.licenseNumber || "", encryptionKey);
    base.identity = identity;
    base.fields = await mergeWalletFields(item, arrayValue(preserved, "Fields", "fields"), encryptionKey);
  } else if (item.kind === "secure-note") {
    base.notes = await encryptOptional(item.content, encryptionKey);
    base.secureNote = recordValue(preserved, "SecureNote", "secureNote") || { type: 0 };
    base.fields = await mergeSecureNoteFieldsPreservingUnknown(item, arrayValue(preserved, "Fields", "fields"), encryptionKey);
  }
  if (preservedRaw) await restoreUnchangedCipherScalars(base, preservedRaw, encryptionKey);
  return base;
}

/**
 * Bitwarden answers `/sync` in PascalCase but binds write requests in camelCase, so every preserved
 * key — including ones this codec has no model for, such as attachments — has to
 * be carried across under the request casing or the server drops it.
 */
function cipherRequestBody(preserved: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(preserved).map(([name, entry]) => [lowerFirst(name), entry]));
}

async function decodePasswordHistory(raw: unknown, key: BitwardenSymmetricKey): Promise<{
  rows: { raw: unknown; plain?: { password: string; lastUsedAt: string } }[]; unreadable: boolean;
}> {
  if (raw == null) return { rows: [], unreadable: false };
  if (!Array.isArray(raw)) return { rows: [], unreadable: true };
  const rows = await Promise.all(raw.map(async rawRow => {
    const row = record(rawRow);
    const password = value(row, 'Password', 'password');
    const date = value(row, 'LastUsedDate', 'lastUsedDate');
    if (typeof password !== 'string' || !password || typeof date !== 'string' || !Number.isFinite(Date.parse(date))) return { raw: rawRow };
    try {
      return { raw: rawRow, plain: { password: await decryptBitwardenString(password, key), lastUsedAt: new Date(date).toISOString() } };
    } catch { return { raw: rawRow }; }
  }));
  return { rows, unreadable: rows.some(row => !('plain' in row)) };
}

async function encodePasswordHistory(history: NonNullable<LoginItem['passwordHistory']>, raw: unknown, key: BitwardenSymmetricKey): Promise<unknown> {
  const decoded = await decodePasswordHistory(raw, key);
  const previous = decoded.rows.flatMap(row => row.plain ? [row.plain] : []);
  if (JSON.stringify(history) === JSON.stringify(previous)) return raw ?? [];
  // An unknown whole-container format cannot be merged safely.
  if (raw != null && !Array.isArray(raw)) throw new Error('Bitwarden 密码历史格式无法安全修改，原始记录已保留。');
  const pool = [...decoded.rows];
  const result = await Promise.all(history.map(async entry => {
    const index = pool.findIndex(row => row.plain?.password === entry.password && row.plain.lastUsedAt === entry.lastUsedAt);
    if (index >= 0) return pool.splice(index, 1)[0].raw;
    if (!Number.isFinite(Date.parse(entry.lastUsedAt))) throw new Error('密码历史时间无效，原始记录已保留。');
    return { password: await encryptBitwardenString(entry.password, key), lastUsedDate: entry.lastUsedAt };
  }));
  return [...result, ...pool.filter(row => !row.plain).map(row => row.raw)];
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
  let systemFields = [...(includeSystemFields ? buildBitwardenSystemFields(item) : []), ...buildBitwardenCustomIconFields(item)];
  const initialized = item.bitwardenCustomFieldsVersion === BITWARDEN_CUSTOM_FIELDS_VERSION;
  const remotePlain = await decodeBitwardenCustomFields(remoteFields, encryptionKey);
  const coverFields = await encodeBitwardenGroupCover(item, remotePlain, encryptionKey);
  const managesSsh = includeSystemFields && initialized && (!item.sshKeyData?.trim() || Boolean(parseSshKeyData(item.sshKeyData)));
  if (includeSystemFields) {
    const previousSsh = bitwardenSystemFieldMap(remotePlain);
    for (const name of SSH_METADATA_NAMES) {
      const originals = remotePlain.filter(field => field.name === name && isManagedSshField(field));
      const current = systemFields.find(field => field.name === name);
      if (current && current.value === previousSsh.get(name)) {
        systemFields = systemFields.filter(field => field.name !== name);
        systemFields.push(...originals.map(field => ({ name, value: field.value, protected: current.protected || field.type === BITWARDEN_HIDDEN_FIELD })));
      } else if (current && originals.some(field => field.type === BITWARDEN_HIDDEN_FIELD)) {
        current.protected = true;
      }
    }
  }
  const hiddenMetadataNames = new Set(PASSWORD_METADATA_ALIASES.filter(aliases =>
    remotePlain.some(source => aliases.includes(source.name) && isReadableTextField(source) && source.type === BITWARDEN_HIDDEN_FIELD)).flat());
  // The compatibility address contains every address component, so it inherits
  // protection even when only a city, region, postal code, or country was hidden.
  if (["monica_city", "monica_state", "monica_zip_code", "monica_country"].some(name => hiddenMetadataNames.has(name))) hiddenMetadataNames.add("address");
  if (includeSystemFields && initialized) {
    const previous = bitwardenSystemFieldMap(remotePlain);
    const unchanged = PASSWORD_METADATA_KEYS.map((property, index) =>
      bitwardenSystemValue(previous, ...PASSWORD_METADATA_ALIASES[index]) === (item[property] ?? ""));
    for (const [index, aliases] of PASSWORD_METADATA_ALIASES.entries()) {
      const originals = remotePlain.filter(field => aliases.includes(field.name) && isReadableTextField(field));
      if (unchanged[index] && (index !== 4 || unchanged.slice(4, 9).every(Boolean))) {
        // Keep spelling, duplicate values and extension properties on unrelated edits.
        systemFields = systemFields.filter(field => !aliases.includes(field.name));
        systemFields.push(...originals.map(field => ({ name: field.name, value: field.value, protected: field.type === BITWARDEN_HIDDEN_FIELD })));
      } else {
        const current = systemFields.find(field => aliases.includes(field.name));
        if (!current) continue; // Explicit deletion removes every supported alias.
        const generated = new Map(systemFields.map(field => [field.name, field]));
        const seen = new Set<string>();
        for (const field of originals) {
          const target = generated.get(field.name);
          if (!target || seen.has(field.name)) systemFields.push({ name: field.name, value: target?.value ?? current.value, protected: field.type === BITWARDEN_HIDDEN_FIELD });
          seen.add(field.name);
        }
      }
    }
  }
  const generatedSystemNames = new Set(systemFields.map((field) => field.name));
  const localFields = item.customFields.filter((field) => field.name.trim() && !generatedSystemNames.has(field.name)
    && !(field.name === GROUP_COVER_FIELD && parsePasswordCoverField(field.value) !== undefined)
    && !(managesSsh && SSH_METADATA_NAMES.has(field.name))
    && !(includeSystemFields && initialized && PASSWORD_METADATA_NAMES.has(field.name)));
  const outgoing = [...systemFields.map(field => hiddenMetadataNames.has(field.name)
    ? { ...field, protected: true } : field), ...localFields];
  const encoded = await encodeFieldsRetainingMetadata(outgoing, remotePlain.filter(field =>
    !isManagedGroupCoverField(field) &&
    (!SSH_METADATA_NAMES.has(field.name) || isManagedSshField(field)) &&
    (!CUSTOM_ICON_FIELD_NAMES.has(field.name) || isManagedCustomIconField(field))
    && (!PASSWORD_METADATA_NAMES.has(field.name) || isReadableTextField(field))), encryptionKey);
  if (!remoteFields.length) return encoded.length || coverFields.length ? [...encoded, ...coverFields] : null;
  const remainingLocalOccurrences = occurrenceCounts(localFields);
  const preserved: unknown[] = [];
  for (const field of remotePlain) {
    if (isManagedGroupCoverField(field)) continue;
    if (includeSystemFields && SSH_METADATA_NAMES.has(field.name)) {
      if (!isManagedSshField(field) || (!managesSsh && !generatedSystemNames.has(field.name))) preserved.push(field.raw);
      continue;
    }
    if (includeSystemFields && PASSWORD_METADATA_NAMES.has(field.name)) {
      if (!isReadableTextField(field) || (!initialized && !generatedSystemNames.has(field.name))) preserved.push(field.raw);
      continue;
    }
    if (CUSTOM_ICON_FIELD_NAMES.has(field.name)) {
      if (!isManagedCustomIconField(field)) preserved.push(field.raw);
      continue;
    }
    // Relation fields have authoritative model projections. Choosing a stable
    // account or unlinking must also remove the previous Android Room reference.
    if (includeSystemFields && field.readable && !field.linked &&
      (field.type === BITWARDEN_TEXT_FIELD || field.type === BITWARDEN_HIDDEN_FIELD) &&
      (field.name === "monica_sso_ref_logical_id" ||
        field.name === "monica_sso_ref_entry_id" && optionalPositiveOrZeroInteger(field.value) !== undefined)) continue;
    if (field.readable && field.name && generatedSystemNames.has(field.name)) continue;
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
  const merged = [...preserved, ...encoded, ...coverFields];
  return merged.length ? merged : null;
}

async function mergeSecureNoteFieldsPreservingUnknown(
  item: SecureNoteItem,
  remoteFields: unknown[],
  encryptionKey: BitwardenSymmetricKey
): Promise<unknown[] | null> {
  const remotePlain = await decodeBitwardenCustomFields(remoteFields, encryptionKey);
  const outgoing: SecureCustomField[] = (item.customFields || [])
    .filter((field) => field.name.trim())
    .filter((field) => !RESERVED_NOTE_FIELD_NAMES.has(field.name));
  if (item.isMarkdown !== undefined) outgoing.push({ name: "monica_note_markdown", value: String(item.isMarkdown), protected: false });
  if (item.tags !== undefined) {
    const originalTags = remotePlain.find((field) => field.name === "monica_note_tags");
    const unchanged = JSON.stringify(parseNoteTags(originalTags?.value)) === JSON.stringify(item.tags);
    outgoing.push({ name: "monica_note_tags", value: unchanged ? originalTags!.value : JSON.stringify(item.tags), protected: false });
  }
  const generatedNames = new Set(outgoing.map((field) => field.name));
  const preserved = remotePlain
    .filter((field) => !isEditableBitwardenSecureField(field) || (RESERVED_NOTE_FIELD_NAMES.has(field.name) && !generatedNames.has(field.name)) || item.customFields === undefined && !generatedNames.has(field.name))
    .map((field) => field.raw);
  const merged = [...preserved, ...await encodeFieldsRetainingMetadata(outgoing, remotePlain, encryptionKey)];
  return merged.length ? merged : null;
}

async function encodeFieldsRetainingMetadata(fields: SecureCustomField[], original: PlainBitwardenCustomField[], key: BitwardenSymmetricKey): Promise<unknown[]> {
  const available = [...original];
  return Promise.all(fields.map(async (field) => {
    const type = field.fieldType === "BOOLEAN" ? 2 : field.protected || field.fieldType === "HIDDEN" ? 1 : 0;
    let index = available.findIndex((source) => source.readable && !source.linked && source.name === field.name && source.value === field.value && source.type === type);
    if (index < 0) index = available.findIndex((source) => source.readable && !source.linked && source.name === field.name);
    const source = index < 0 ? undefined : available.splice(index, 1)[0];
    const raw = { ...record(source?.raw) };
    if (source?.type === type && source.value === field.value) {
      for (const name of ["Name", "Value", "Type", "LinkedId"]) if (name in raw) { raw[lowerFirst(name)] = raw[name]; delete raw[name]; }
      return raw;
    }
    for (const known of ["Name", "Value", "Type", "LinkedId"]) delete raw[known];
    return { ...raw, type, name: source ? value(record(source.raw), "Name", "name") : await encryptBitwardenString(field.name, key), value: await encryptBitwardenString(field.value, key), linkedId: null };
  }));
}

async function mergeWalletFields(item: WalletItem, remoteFields: unknown[], key: BitwardenSymmetricKey): Promise<unknown[] | null> {
  const original = await decodeBitwardenCustomFields(remoteFields, key);
  const managed = walletManagedNames(item.kind);
  const outgoing = walletItemToFields(item, original);
  const generatedNames = new Set(outgoing.map((field) => field.name.toLowerCase()));
  const preserved = original.filter((field) => {
    if (!field.readable || field.linked || ![0, 1, 2].includes(field.type)) return true;
    if (!managed.has(field.name.toLowerCase())) return item.customFields === undefined;
    // Unknown card-face/version/enums stay read-only until understood; absence does not delete them.
    if ((field.name === "Monica Card Face" || field.name === "monica_card_face") && item.cardFace === undefined) return true;
    return !generatedNames.has(field.name.toLowerCase());
  }).map((field) => field.raw);
  const merged = [...preserved, ...await encodeFieldsRetainingMetadata(outgoing, original, key)];
  return merged.length ? merged : null;
}

function parseNoteTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.every((tag) => typeof tag === "string") ? parsed as string[] : undefined;
  } catch { return undefined; }
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
    let readable = true;
    const decode = async (names: string[]) => {
      try { return await decryptBitwardenString(stringValue(field, ...names), key); }
      catch { readable = false; return ""; }
    };
    const name = (await decode(["Name", "name"])).trim();
    const fieldValue = await decode(["Value", "value"]);
    return {
      raw: entry,
      name,
      value: fieldValue,
      type: numberValue(field, "Type", "type"),
      linked: linkedId !== null && linkedId !== undefined,
      readable
    };
  }));
}

function isEditableBitwardenUserField(field: PlainBitwardenCustomField): boolean {
  return field.readable && Boolean(field.name) && !field.linked &&
    (field.type === BITWARDEN_TEXT_FIELD || field.type === BITWARDEN_HIDDEN_FIELD) &&
    !RESERVED_PASSWORD_FIELD_NAMES.has(field.name) && !isManagedGroupCoverField(field);
}

function isEditableBitwardenSecureField(field: PlainBitwardenCustomField): boolean {
  return field.readable && Boolean(field.name) && !field.linked && [0, 1, 2].includes(field.type);
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
  for (const field of fields) if (field.name && (!PASSWORD_METADATA_NAMES.has(field.name) || isReadableTextField(field))
    && (!SSH_METADATA_NAMES.has(field.name) || isManagedSshField(field))) mapped.set(field.name, field.value);
  return mapped;
}

function isReadableTextField(field: PlainBitwardenCustomField): boolean {
  return field.readable && !field.linked && (field.type === BITWARDEN_TEXT_FIELD || field.type === BITWARDEN_HIDDEN_FIELD);
}

function isManagedGroupCoverField(field: PlainBitwardenCustomField): boolean {
  return field.name === GROUP_COVER_FIELD && isReadableTextField(field) && parsePasswordCoverField(field.value) !== undefined;
}

function readBitwardenGroupCover(fields: PlainBitwardenCustomField[]): boolean | undefined {
  const managed = fields.filter(isManagedGroupCoverField);
  return parsePasswordCoverField(managed[managed.length - 1]?.value);
}

async function encodeBitwardenGroupCover(item: LoginItem, remote: PlainBitwardenCustomField[], key: BitwardenSymmetricKey): Promise<unknown[]> {
  const original = remote.filter(isManagedGroupCoverField);
  // Older cached items have no projection; do not erase their remote metadata.
  if (!Object.prototype.hasOwnProperty.call(item, "isGroupCover")
    || item.isGroupCover === undefined && item.bitwardenCustomFieldsVersion !== BITWARDEN_CUSTOM_FIELDS_VERSION
    || item.isGroupCover === readBitwardenGroupCover(original)) return original.map(field => field.raw);
  if (item.isGroupCover === undefined) return [];
  const fields = original.length ? original.map(field => ({ name: GROUP_COVER_FIELD, value: String(item.isGroupCover), protected: field.type === BITWARDEN_HIDDEN_FIELD }))
    : [{ name: GROUP_COVER_FIELD, value: String(item.isGroupCover), protected: false }];
  return encodeFieldsRetainingMetadata(fields, original, key);
}

function isManagedSshField(field: PlainBitwardenCustomField): boolean {
  return isReadableTextField(field) && (field.name !== 'monica_ssh_key_size' || optionalPositiveOrZeroInteger(field.value) !== undefined);
}

function bitwardenSystemValue(fields: Map<string, string>, ...names: string[]): string {
  for (const name of names) if (fields.has(name)) return fields.get(name) || "";
  return "";
}

function bitwardenLoginType(fields: Map<string, string>, sshKeyData?: string): LoginItem["loginType"] {
  if (fields.get("monica_api_key_type") === "API_KEY") return "API_KEY";
  if (fields.get("monica_gpg_type") === "GPG_KEY") return "GPG_KEY";
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
  if (![...SSH_METADATA_NAMES].some(name => fields.has(name)) && fields.get('monica_login_type') !== 'SSH_KEY') return undefined;
  const parsedSize = optionalPositiveOrZeroInteger(bitwardenSystemValue(fields, "monica_ssh_key_size"));
  return JSON.stringify({
    algorithm,
    keySize: parsedSize ?? 0,
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

function isManagedCustomIconField(field: PlainBitwardenCustomField): boolean {
  return CUSTOM_ICON_FIELD_NAMES.has(field.name) && field.readable && !field.linked
    && (field.type === BITWARDEN_TEXT_FIELD || field.type === BITWARDEN_HIDDEN_FIELD)
    && (field.name !== "monica_custom_icon_updated_at" || optionalPositiveOrZeroInteger(field.value) !== undefined);
}

function readBitwardenCustomIcon(raw: PlainBitwardenCustomField[]): Pick<LoginItem, "customIconType" | "customIconValue" | "customIconUpdatedAt"> {
  const fields = bitwardenSystemFieldMap(raw.filter(isManagedCustomIconField));
  return {
    customIconType: fields.get("monica_custom_icon_type"),
    customIconValue: fields.get("monica_custom_icon_value"),
    customIconUpdatedAt: optionalPositiveOrZeroInteger(fields.get("monica_custom_icon_updated_at") || "")
  };
}

function buildBitwardenCustomIconFields(item: LoginItem): SecureCustomField[] {
  const fields: SecureCustomField[] = [];
  if (item.customIconType !== undefined) fields.push({ name: "monica_custom_icon_type", value: item.customIconType, protected: false });
  if (item.customIconValue !== undefined) fields.push({ name: "monica_custom_icon_value", value: item.customIconValue, protected: false });
  if (item.customIconUpdatedAt !== undefined) fields.push({ name: "monica_custom_icon_updated_at", value: String(item.customIconUpdatedAt), protected: false });
  return fields;
}

function buildBitwardenSystemFields(item: LoginItem): SecureCustomField[] {
  const fields: SecureCustomField[] = [];
  const add = (name: string, value: string | undefined, protectedField = false) => {
    if (value?.trim()) fields.push({ name, value, protected: protectedField });
  };
  const ssh = parseSshKeyData(item.sshKeyData);
  // Keep an existing valid marker in the custom-field sequence, including its
  // protection and source attributes. Generate one only when it is absent.
  if (item.loginType === "GPG_KEY" && !item.customFields.some(field => field.name === "monica_gpg_type" && field.value === "GPG_KEY")) add("monica_gpg_type", "GPG_KEY");
  if (item.loginType === "API_KEY" && !item.customFields.some(field => field.name === "monica_api_key_type" && field.value === "API_KEY")) add("monica_api_key_type", "API_KEY");
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
  if (item.loginType === "SSO") {
    add("monica_login_type", "SSO");
    add("monica_sso_provider", item.ssoProvider);
    add("monica_sso_ref_entry_id", item.ssoRefEntryId === undefined ? undefined : String(item.ssoRefEntryId));
    add("monica_sso_ref_logical_id", item.ssoRefLogicalId);
  } else if (item.loginType === "WIFI") {
    add("monica_login_type", "WIFI");
    add("monica_wifi_data", item.wifiMetadata);
  } else if (item.loginType === "BARCODE") {
    add("monica_login_type", "BARCODE");
  }
  addSsh(false);
  // A legacy composite must not become a new street after the street is cleared.
  if (item.addressLine) add("address", [item.addressLine, item.city, item.state, item.zipCode, item.country].filter(Boolean).join(", "));
  return fields;
}

function parseSshKeyData(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = parseLosslessJson(raw);
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

function optionalPositiveOrZeroInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
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
    credentialId: normalizeCredentialId(decodeBitwardenCredentialId(await decryptBitwardenString(stringValue(credential, "CredentialId", "credentialId"), encryptionKey)))
  })));
  const itemCredentialId = normalizeCredentialId(item.credentialId);
  const replacement = operation === "upsert" ? await encodeFido2Credential(item, encryptionKey, matched.find((entry) => entry.credentialId === itemCredentialId)?.credential) : undefined;
  const fido2Credentials = matched.flatMap((entry) => entry.credentialId === itemCredentialId ? (replacement ? [replacement] : []) : [entry.credential]);
  if (replacement && !matched.some((entry) => entry.credentialId === itemCredentialId)) fido2Credentials.push(replacement);

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

export function assertKnownBitwardenCipher(raw: Record<string, unknown>): void {
  if (value(raw, "Type", "type") !== undefined && ![1, 2, 3, 4, 5].includes(numberValue(raw, "Type", "type"))) throw new Error("未知 Bitwarden 类型仅可只读查看，不能编辑、转换或删除。");
}

/** Preserve null, absence, empty ciphertext and unchanged encrypted bytes while patching owned fields. */
async function restoreUnchangedCipherScalars(output: Record<string, unknown>, original: Record<string, unknown>, key: BitwardenSymmetricKey): Promise<void> {
  const restore = async (target: Record<string, unknown>, source: Record<string, unknown>, names: string[]) => {
    for (const name of names) {
      if (!(name in target)) continue;
      const pascal = name[0].toUpperCase() + name.slice(1);
      const before = value(source, pascal, name);
      const after = target[name];
      if ((before != null && typeof before !== "string") || (after != null && typeof after !== "string")) continue;
      if (await decryptBitwardenString(before as string | undefined, key) === await decryptBitwardenString(after as string | undefined, key)) {
        if (pascal in source || name in source) target[name] = before;
        else delete target[name];
      }
    }
  };
  await restore(output, original, ["name", "notes"]);
  for (const [nested, names] of Object.entries({ login: ["username", "password", "totp"], card: ["cardholderName", "number", "expMonth", "expYear", "code", "brand"], identity: ["title", "firstName", "middleName", "lastName", "address1", "address2", "address3", "city", "state", "postalCode", "country", "company", "username", "email", "phone", "ssn", "passportNumber", "licenseNumber"], sshKey: ["privateKey", "publicKey", "keyFingerprint"] })) {
    const target = recordValue(output, nested);
    if (target) await restore(target, recordValue(original, nested, nested[0].toUpperCase() + nested.slice(1)) || {}, names);
  }
}

async function encodeFido2Credential(item: PasskeyItem, key: BitwardenSymmetricKey, preserved?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const privateKey = parsePortablePasskeyPrivateKey(item.privateKeyPkcs8);
  if (!privateKey || privateKey.algorithm !== -7) throw new Error("Bitwarden Passkey 私钥不是有效的 ES256 PKCS#8。");
  const unknown = Object.fromEntries(Object.entries(preserved || {}).filter(([name]) => !FIDO2_FIELD_NAMES.has(name.toLowerCase())));
  return {
    ...unknown,
    credentialId: await encryptBitwardenString(toBitwardenCredentialId(item.credentialId), key),
    keyType: await encryptBitwardenString("public-key", key),
    keyAlgorithm: await encryptBitwardenString("ECDSA", key),
    keyCurve: await encryptBitwardenString("P-256", key),
    keyValue: await encryptBitwardenString(toBase64UrlText(privateKey.pkcs8Base64), key),
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
  "credentialid", "keytype", "keyalgorithm", "keycurve", "keyvalue", "rpid", "rpname", "counter", "userhandle", "username", "userdisplayname", "discoverable", "creationdate"
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
  key: BitwardenSymmetricKey,
  androidMetadata: boolean
): Promise<PasskeyItem[]> {
  const metadata = parseAndroidPasskeyMetadata(base.notes);
  return Promise.all(arrayValue(login, "Fido2Credentials", "fido2Credentials").map(async (entry, index) => {
    const fido = record(entry);
    const decrypted = await decryptFidoRecordFields(fido, key, ["CredentialId", "KeyType", "KeyAlgorithm", "KeyCurve", "KeyValue", "RpId", "RpName", "Counter", "UserHandle", "UserName", "UserDisplayName", "Discoverable", "CreationDate"]);
    const metadataCredential = metadata.get("credentialId") || "";
    const rawCredentialId = decrypted.CredentialId || metadataCredential || `${cipherReference.remoteId}#metadata-${index}`;
    const credentialId = decodeBitwardenCredentialId(rawCredentialId) || rawCredentialId;
    const algorithm = normalizePasskeyAlgorithm(decrypted.KeyAlgorithm || metadata.get("publicKeyAlgorithm") || "");
    const portableKey = parsePortablePasskeyPrivateKey(decrypted.KeyValue);
    const keyMetadataSupported = (!decrypted.KeyType || decrypted.KeyType === "public-key")
      && (!decrypted.KeyCurve || decrypted.KeyCurve.toUpperCase() === "P-256");
    const privateKeyPkcs8 = algorithm === -7 && keyMetadataSupported && portableKey?.algorithm === -7
      ? portableKey.pkcs8Base64
      : undefined;
    const rpId = decrypted.RpId || metadata.get("rpId") || "";
    const rpName = decrypted.RpName || metadata.get("rpName") || base.title.replace(/\s*\[Passkey\]\s*$/i, "");
    const userHandle = decrypted.UserHandle || metadata.get("userId") || "";
    const userName = decrypted.UserName || metadata.get("userName") || "";
    const userDisplayName = decrypted.UserDisplayName || metadata.get("userDisplayName") || userName;
    return {
      ...base,
      id: `${base.id}:passkey:${credentialId}`,
      kind: "passkey",
      title: rpName || base.title,
      credentialId,
      rpId,
      rpName,
      userHandle,
      userName,
      userDisplayName,
      algorithm,
      keyAlgorithm: decrypted.KeyAlgorithm || undefined,
      publicKey: "",
      privateKeyPkcs8,
      signCount: Number(decrypted.Counter || metadata.get("signCount")) || 0,
      discoverable: decrypted.Discoverable.toLowerCase() !== "false",
      sourceMode: privateKeyPkcs8 ? "bitwarden" : androidMetadata ? "android-metadata-only" : "bitwarden",
      createdAt: dateValue(decrypted.CreationDate || metadata.get("createdAt"), base.createdAt),
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

function toBase64UrlText(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

function decodeAndroidPasskeyMetadata(
  base: { id: string; title: string; favorite: boolean; notes: string; createdAt: string; updatedAt: string },
  reference: ProviderReference,
  notes: string,
  fallback: { legacyName?: boolean; fallbackRpId?: string; fallbackUserName?: string } = {}
): PasskeyItem | undefined {
  const marker = notes.indexOf("[Monica Passkey Metadata]");
  if (marker < 0 && !fallback.legacyName) return undefined;
  const values = parseAndroidPasskeyMetadata(notes);
  const credentialId = values.get("credentialId") || (fallback.legacyName ? `bw_ref_${reference.remoteId}` : `${reference.remoteId}#metadata`);
  const rpId = values.get("rpId") || fallback.fallbackRpId || "";
  const rpName = values.get("rpName") || base.title.replace(/\s*\[Passkey\]\s*$/i, "");
  const userName = values.get("userName") || fallback.fallbackUserName || "";
  const userDisplayName = values.get("userDisplayName") || userName;
  const userHandle = values.get("userId") || "";
  const algorithm = Number(values.get("publicKeyAlgorithm"));
  return {
    ...base,
    id: `${base.id}:passkey:${credentialId}`,
    kind: "passkey",
    title: rpName || base.title,
    credentialId,
    rpId,
    rpName,
    userHandle,
    userName,
    userDisplayName,
    algorithm: Number.isSafeInteger(algorithm) ? algorithm : -7,
    keyAlgorithm: "ANDROID_METADATA",
    publicKey: "",
    signCount: Number(values.get("signCount")) || 0,
    discoverable: true,
    sourceMode: "android-metadata-only",
    providerRefs: [{ ...reference, remoteId: `${reference.remoteId}#fido2:${credentialId}` }]
  };
}

function isLegacyPasskeyName(name: string): boolean {
  return /\s\[Passkey\]$/.test(name);
}

/** Extract a WebAuthn RP ID from Android's Login URI projection. */
function extractRpIdFromUriRules(uriRules: LoginUriRule[]): string {
  for (const rule of uriRules) {
    const candidate = rule.uri.trim();
    if (!candidate || rule.matchType === "regex" || rule.matchType === "never") continue;
    try {
      const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
      if (parsed.username || parsed.password || parsed.port) continue;
      const normalized = normalizeRpId(parsed.hostname);
      if (normalized) return normalized;
    } catch {
      // URI fields are user-controlled and may contain non-URL app identifiers.
    }
  }
  return "";
}

function parseAndroidPasskeyMetadata(notes: string): Map<string, string> {
  const marker = notes.indexOf("[Monica Passkey Metadata]");
  const values = new Map<string, string>();
  if (marker < 0) return values;
  for (const line of notes.slice(marker).split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(": ");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 2).trim());
  }
  return values;
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
