import { parseLosslessJson, jsonScalarText } from "../../core/lossless-json";
import { assertPortablePasswordHistory } from '../../core/password-history';
import type { ProviderReference, TotpItem, VaultItem } from "../../core/model";
import { exportSteamMaFile, parseSteamMaFile } from "../../core/steam-mafile";
import { androidRecordToItem, vaultItemToAndroidRecord } from "../webdav/android-backup-codec";
import type { Mdbx2ObjectRecord, Mdbx2ObjectUpsertInput } from "./native-contract";
import { parsePortablePasskeyPrivateKey, portablePasskeyKeyMatchesAlgorithm } from "../../passkey/private-key-portability";
import { apiTokenFromPayload, apiTokenValidationError, serializeApiTokenPayload, serializeApiTokenMetadata } from "../../core/api-token";

export interface Mdbx2ObjectMetadata {
  headCommitId: string;
  updatedAt: string;
}

export interface Mdbx2DecodedObject {
  logicalObjectId: string;
  payload: Record<string, unknown>;
  item?: VaultItem;
  unsupportedReason?: string;
}

const OBJECT_FOLDERS: Record<string, string> = {
  login: "passwords",
  note: "notes",
  totp: "authenticators",
  card: "bank_cards",
  "document-ref": "documents",
  "billing-address": "billing_addresses",
  "payment-account": "payment_accounts",
  passkey: "passkeys"
};

export function decodeMdbx2Object(
  record: Mdbx2ObjectRecord,
  metadata: Mdbx2ObjectMetadata,
  providerId: string
): Mdbx2DecodedObject {
  let payload: Record<string, unknown>;
  try { payload = parsePayload(record.payloadJson); }
  catch { return decodeOpaqueMdbxObject(record, metadata, providerId, "原始内容不是当前支持的 JSON 对象，仅可安全查看。"); }
  if (record.payloadSchemaVersion !== 1) return decodeOpaqueMdbxObject(record, metadata, providerId, "此项目使用更新的数据版本，仅可安全查看。", payload);
  if (record.objectTypeId === "login" && !supportedPasswordEncoding(payload)) {
    return decodeOpaqueMdbxObject(record, metadata, providerId, "此密码使用未知编码，仅可安全查看。", payload);
  }
  const logicalObjectId = stringValue(payload.monica_entry_id) || record.objectId;
  if (record.objectTypeId === "api-token") {
    const logicalId = `api-token:${record.objectId}`;
    // An old Host cannot disclose the Android label metadata. Do not expose an
    // editable partial record that would overwrite notes, fields or favorites.
    const decoded = record.apiTokenFavorite === undefined ? undefined : apiTokenFromPayload(record.payloadJson, record.apiTokenMetadataJson);
    if (!decoded) return decodeOpaqueMdbxObject(record, metadata, providerId, "API 令牌需要新版助手或数据适配，仅可安全查看。", payload);
    const updatedAt = normalizedDate(metadata.updatedAt);
    return { logicalObjectId: logicalId, payload, item: {
      id: `mdbx2:${providerId}:${logicalId}`, kind: "api-token", title: record.title,
      ...decoded, favorite: record.apiTokenFavorite === true, createdAt: updatedAt, updatedAt,
      deletedAt: record.deleted ? updatedAt : undefined, replicaGroupId: logicalId, mdbxFolderId: record.collectionId,
      providerRefs: [{ providerId, remoteId: record.objectId, remoteFolderId: record.collectionId, revision: metadata.headCommitId }]
    } };
  }
  if (isSteamMaFileType(record.objectTypeId)) {
    return decodeSteamMaFileObject(record, metadata, providerId, logicalObjectId, payload);
  }
  const folder = OBJECT_FOLDERS[record.objectTypeId];
  if (!folder) {
    return decodeOpaqueMdbxObject(record, metadata, providerId, "此原生类型尚无编辑器，完整内容以只读方式保留。", payload);
  }
  const path = `folders/mdbx2/${folder}/${record.objectId}.json`;
  let decoded: VaultItem | null;
  try { decoded = androidRecordToItem(path, androidRawRecord(record, payload, logicalObjectId, metadata.updatedAt), providerId); }
  catch { return decodeOpaqueMdbxObject(record, metadata, providerId, "项目字段形状或数值超出当前编辑器范围，仅可安全查看。", payload); }
  if (!decoded) {
    return decodeOpaqueMdbxObject(record, metadata, providerId, "此项目暂不能映射到编辑器，仅可安全查看。", payload);
  }
  const reference: ProviderReference = {
    providerId,
    remoteId: record.objectId,
    remoteFolderId: record.collectionId,
    revision: metadata.headCommitId
  };
  const updatedAt = normalizedDate(metadata.updatedAt);
  const item = {
    ...decoded,
    id: `mdbx2:${providerId}:${logicalObjectId}`,
    title: record.title || decoded.title,
    replicaGroupId: logicalObjectId,
    mdbxFolderId: record.collectionId,
    providerRefs: [reference],
    createdAt: decoded.createdAt || updatedAt,
    updatedAt,
    deletedAt: record.deleted ? updatedAt : undefined
  } as VaultItem;
  if (item.kind === "login") item.boundNoteEntryId = typeof payload.bound_note_entry_id === "string" ? payload.bound_note_entry_id || undefined : undefined;
  if (item.kind === "login") item.ssoRefLogicalId = typeof payload.sso_ref_logical_id === "string" ? payload.sso_ref_logical_id || undefined : undefined;
  if (item.kind === "passkey") {
    const portableKey = parsePortablePasskeyPrivateKey(payload.private_key_alias);
    const usable = portablePasskeyKeyMatchesAlgorithm(portableKey, item.algorithm);
    item.privateKeyPkcs8 = usable ? portableKey.pkcs8Base64 : undefined;
    item.sourceMode = usable ? "browser-local" : "android-metadata-only";
  }
  return { logicalObjectId, payload, item };
}

export function encodeMdbx2Object(
  item: VaultItem,
  originalPayload: Record<string, unknown> = {},
  originalItem?: VaultItem
): Mdbx2ObjectUpsertInput | undefined {
  if (item.kind === 'login') assertPortablePasswordHistory(item);
  if (item.kind === "opaque" || originalItem?.kind === "opaque") throw new Error("未知类型或版本的项目仅可读取，不能通过已知类型编辑器改写。");
  if (item.kind === "login" && !supportedPasswordEncoding(originalPayload)) throw new Error("此密码使用未知编码，不能改写。");
  const nativeReference = originalItem?.providerRefs.find(reference => reference.remoteId && item.providerRefs.some(current => current.providerId === reference.providerId && current.remoteId === reference.remoteId));
  const logicalObjectId = item.kind !== "api-token" && nativeReference ? `native:${nativeReference.remoteId}` : logicalIdFor(item);
  // A SecureItem STEAM record can contain partial/full maFile metadata without
  // becoming a standalone native steam-mafile Object.
  const steamMaFile = isSteamMaFileItem(item) && !Object.prototype.hasOwnProperty.call(originalPayload, "item_data");
  const objectTypeId = objectTypeFor(item, steamMaFile);
  if (!objectTypeId) return undefined;
  if (item.kind === "api-token") {
    const error = apiTokenValidationError(item);
    if (error) throw new Error(error);
    return {
      logicalObjectId, collectionId: item.mdbxFolderId, objectTypeId, title: item.title,
      expectedHeadCommitId: nativeReference?.revision,
      payloadSchemaVersion: 1,
      payloadJson: serializeApiTokenPayload(item),
      apiTokenMetadataJson: serializeApiTokenMetadata(item), apiTokenFavorite: item.favorite
    };
  }
  if (steamMaFile) {
    const steamItem = item as TotpItem;
    const sharedSecret = steamItem.steamSharedSecretBase64 || steamItem.secret;
    if (!sharedSecret) return undefined;
    const maFileJson = exportSteamMaFile(steamItem);
    const parsed = parseSteamMaFile(maFileJson, steamItem.title);
    const payload: Record<string, unknown> = {
      ...originalPayload,
      kind: "steam_mafile",
      monica_entry_id: originalPayload.monica_entry_id ?? logicalObjectId,
      steamid: parsed.steamId || "",
      account_name: parsed.accountName,
      mafile_json: maFileJson
    };
    if (originalItem) {
      const baseline = encodeMdbx2Object(originalItem, originalPayload);
      if (baseline) {
        const projected = parsePayload(baseline.payloadJson);
        for (const key of Object.keys(payload)) {
          if (key !== "monica_entry_id" && JSON.stringify(payload[key]) !== JSON.stringify(projected[key])) continue;
          if (Object.prototype.hasOwnProperty.call(originalPayload, key)) payload[key] = originalPayload[key];
          else delete payload[key];
        }
      }
    } else if (Object.prototype.hasOwnProperty.call(originalPayload, "monica_entry_id")) {
      payload.monica_entry_id = originalPayload.monica_entry_id;
    }
    return {
      logicalObjectId,
      collectionId: steamItem.mdbxFolderId,
      expectedHeadCommitId: nativeReference?.revision,
      payloadSchemaVersion: 1,
      objectTypeId,
      title: steamItem.title,
      payloadJson: JSON.stringify(payload)
    };
  }
  const originalRaw = originalItem
    ? androidRawRecord({
        objectId: "",
        collectionId: originalItem.mdbxFolderId || item.mdbxFolderId || "",
        objectTypeId,
        title: originalItem.title,
        payloadJson: JSON.stringify(originalPayload),
        payloadSchemaVersion: 1,
        deleted: Boolean(originalItem.deletedAt)
      }, originalPayload, logicalObjectId, originalItem.updatedAt)
    : undefined;
  // MDBX Passkey metadata is not an Android ZIP export. Its native alias and
  // explicit signing capability are handled below without exporting a key.
  const raw = item.kind === "passkey" ? {} : vaultItemToAndroidRecord(item, originalRaw, originalItem);
  if (!raw) return undefined;
  const payload: Record<string, unknown> = { ...originalPayload };
  payload.kind = payloadKindFor(item, steamMaFile);
  payload.monica_entry_id = logicalObjectId;
  payload.room_id = originalPayload.room_id ?? null;
  payload.mdbx_folder_id = item.mdbxFolderId ?? null;
  payload.notes = item.notes;
  payload.sort_order = item.sortOrder ?? 0;
  payload.category_id = item.categoryId ?? null;
  payload.bitwarden_mode = originalPayload.bitwarden_mode ?? item.providerRefs.some((reference) => reference.providerId.startsWith("bitwarden"));
  payload.keepass_mode = originalPayload.keepass_mode ?? item.keepassDatabaseId != null;

  if (item.kind === "login") {
    payload.website = item.uris.join("\n");
    payload.username = item.username;
    payload.app_package_name = item.appPackageName || "";
    payload.app_name = item.appName || "";
    payload.custom_icon_type = item.customIconType;
    payload.custom_icon_value = item.customIconValue;
    payload.custom_icon_updated_at = item.customIconUpdatedAt;
    payload.password_plain = item.password;
    payload.bound_note_room_id = item.boundNoteId ?? null;
    payload.bound_note_entry_id = item.boundNoteEntryId ?? null;
    payload.login_type = item.loginType || "PASSWORD";
    payload.sso_provider = item.ssoProvider ?? "";
    payload.sso_ref_entry_id = item.ssoRefEntryId ?? null;
    payload.sso_ref_logical_id = item.ssoRefLogicalId ?? null;
    payload.password_group_id = item.passwordGroupId ?? null;
    // Extension transport metadata; current Android native mapping does not consume it.
    // Keep unknown source values when no cover was projected, including baseline encoding.
    if (item.isGroupCover !== undefined || originalItem?.kind === "login" && originalItem.isGroupCover !== undefined) {
      if (originalPayload.is_group_cover != null && typeof originalPayload.is_group_cover !== "boolean") {
        throw new Error("封面字段版本未知，无法安全修改。请保留原始数据。");
      }
      payload.is_group_cover = item.isGroupCover ?? false;
    }
    payload.ssh_key_data = item.sshKeyData || "";
    payload.wifi_metadata = item.wifiMetadata ?? "";
    for (const [wire, model] of LOGIN_CONTENT_FIELDS) payload[wire] = item[model] ?? "";
    payload.authenticator_key = item.totpSecret || "";
    payload.passkey_bindings = item.passkeyBindings || "";
    payload.custom_fields = mergeCustomFields(originalPayload.custom_fields, item.customFields.map((field, sortOrder) => ({
      title: field.name,
      value: field.value,
      is_protected: field.protected,
      sort_order: sortOrder
    })));
  } else if (item.kind === "passkey") {
    payload.credential_id = item.credentialId;
    payload.rp_id = item.rpId;
    payload.rp_name = item.rpName;
    payload.user_id = item.userHandle;
    payload.user_name = item.userName;
    payload.user_display_name = item.userDisplayName;
    payload.public_key_algorithm = item.algorithm;
    payload.public_key = item.publicKey;
    payload.private_key_alias = item.privateKeyPkcs8 || originalPayload.private_key_alias || "";
    payload.transports = (item.transports || []).join(",");
    payload.aaguid = item.aaguid || "";
    payload.sign_count = item.signCount;
    if (typeof item.backupEligible === "boolean") payload.backup_eligible = item.backupEligible;
    if (typeof item.backupState === "boolean") payload.backup_state = item.backupState;
    payload.passkey_mode = item.passkeyMode || "LEGACY";
    payload.bitwarden_compatible = item.sourceMode === "bitwarden" || Boolean(item.keyAlgorithm);
    payload.keepass_compatible = item.passkeyMode === "KEEPASS_COMPAT";
  } else {
    payload.item_data = raw.itemData ?? originalPayload.item_data ?? "";
    payload.image_paths = raw.imagePaths ?? JSON.stringify(item.imagePaths || []);
    payload.bound_password_entry_id = originalPayload.bound_password_entry_id ?? null;
  }

  // Compare the editor projection, not raw JSON defaults: absent/null/empty and
  // unfamiliar source shapes stay untouched when their UI value did not change.
  if (originalItem) {
    const baseline = encodeMdbx2Object(originalItem, originalPayload);
    if (baseline) {
      const projected = parsePayload(baseline.payloadJson);
      for (const key of Object.keys(payload)) {
        if (key === "item_data") continue; // already patched by the nested codec
        if (JSON.stringify(payload[key]) !== JSON.stringify(projected[key])) continue;
        if (Object.prototype.hasOwnProperty.call(originalPayload, key)) payload[key] = originalPayload[key];
        else delete payload[key];
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(originalPayload, "monica_entry_id")) payload.monica_entry_id = originalPayload.monica_entry_id;
  // Android repairs legacy installation-encrypted password_plain values. A new
  // user password can itself be a valid ciphertext; explicitly mark its meaning.
  // Do this after preservation, and never relabel unchanged legacy content.
  if (item.kind === "login" && (!originalItem || originalItem.kind !== "login" || item.password !== originalItem.password)) {
    payload.monica_password_encoding = "plaintext-v1";
  }
  return {
    logicalObjectId,
    expectedHeadCommitId: nativeReference?.revision,
    payloadSchemaVersion: 1,
    collectionId: item.mdbxFolderId,
    objectTypeId,
    title: item.title,
    payloadJson: JSON.stringify(payload)
  };
}

export function mdbx2LogicalObjectId(item: VaultItem): string {
  return logicalIdFor(item);
}

function supportedPasswordEncoding(payload: Record<string, unknown>): boolean {
  const encoding = payload.monica_password_encoding;
  return encoding == null || encoding === "" || encoding === "plaintext-v1";
}

function androidRawRecord(
  record: Mdbx2ObjectRecord,
  payload: Record<string, unknown>,
  logicalObjectId: string,
  updatedAt: string
): Record<string, unknown> {
  const common: Record<string, unknown> = {
    id: payload.room_id ?? logicalObjectId,
    title: record.title,
    notes: payload.notes ?? "",
    sortOrder: payload.sort_order,
    categoryId: payload.category_id ?? null,
    imagePaths: payload.image_paths ?? "[]",
    mdbxFolderId: record.collectionId,
    replicaGroupId: logicalObjectId,
    isDeleted: record.deleted,
    deletedAt: record.deleted ? updatedAt : null,
    createdAt: updatedAt,
    updatedAt
  };
  if (record.objectTypeId === "login") {
    return {
      ...common,
      website: payload.website ?? "",
      username: payload.username ?? "",
      password: payload.password_plain ?? payload.password ?? "",
      appPackageName: payload.app_package_name ?? payload.appPackageName ?? "",
      appName: payload.app_name ?? payload.appName ?? "",
      customIconType: payload.custom_icon_type ?? payload.customIconType,
      customIconValue: payload.custom_icon_value ?? payload.customIconValue,
      customIconUpdatedAt: payload.custom_icon_updated_at ?? payload.customIconUpdatedAt,
      authenticatorKey: payload.authenticator_key ?? "",
      passkeyBindings: payload.passkey_bindings ?? "",
      boundNoteId: payload.bound_note_room_id ?? null,
      loginType: payload.login_type ?? "PASSWORD",
      ssoProvider: Object.prototype.hasOwnProperty.call(payload, "sso_provider") ? payload.sso_provider : payload.ssoProvider,
      ssoRefEntryId: Object.prototype.hasOwnProperty.call(payload, "sso_ref_entry_id") ? payload.sso_ref_entry_id : payload.ssoRefEntryId,
      passwordGroupId: payload.password_group_id,
      isGroupCover: payload.is_group_cover,
      sshKeyData: payload.ssh_key_data,
      wifiMetadata: wifiMetadataFromPayload(payload),
      ...Object.fromEntries(LOGIN_CONTENT_FIELDS.map(([wire, model]) => [model, payload[wire]])),
      customFields: Array.isArray(payload.custom_fields)
        ? payload.custom_fields.map((candidate) => {
            const field = objectValue(candidate);
            return {
              title: stringValue(field.title),
              value: stringValue(field.value),
              isProtected: Boolean(field.is_protected ?? field.isProtected),
              sortOrder: numberValue(field.sort_order ?? field.sortOrder)
            };
          })
        : []
    };
  }
  if (record.objectTypeId === "passkey") {
    return {
      ...common,
      credentialId: payload.credential_id ?? "",
      rpId: payload.rp_id ?? "",
      rpName: payload.rp_name ?? record.title,
      userId: payload.user_id ?? "",
      userName: payload.user_name ?? "",
      userDisplayName: payload.user_display_name ?? "",
      publicKeyAlgorithm: payload.public_key_algorithm ?? -7,
      publicKey: payload.public_key ?? "",
      transports: payload.transports ?? "internal",
      aaguid: payload.aaguid ?? "",
      signCount: payload.sign_count ?? 0,
      backupEligible: payload.backup_eligible,
      backupState: payload.backup_state,
      notes: payload.notes ?? "",
      passkeyMode: payload.passkey_mode ?? "LEGACY"
    };
  }
  return {
    ...common,
    itemType: itemTypeForObject(record.objectTypeId),
    itemData: payload.item_data ?? ""
  };
}

const LOGIN_CONTENT_FIELDS = [
  ["email", "email"], ["phone", "phone"], ["address_line", "addressLine"], ["city", "city"],
  ["state", "state"], ["zip_code", "zipCode"], ["country", "country"],
  ["credit_card_number_plain", "creditCardNumber"], ["credit_card_holder", "creditCardHolder"],
  ["credit_card_expiry", "creditCardExpiry"], ["credit_card_cvv_plain", "creditCardCVV"]
] as const;

function wifiMetadataFromPayload(payload: Record<string, unknown>): string | undefined {
  // Android accepts the canonical snake-case key and older camel-case objects.
  const value = payload.wifi_metadata ?? payload.wifiMetadata;
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
  throw new Error("Unsupported Wi-Fi metadata shape");
}

function logicalIdFor(item: VaultItem): string {
  if (item.kind === "api-token") {
    if (item.replicaGroupId?.startsWith("api-token:")) return item.replicaGroupId;
    return `api-token:${item.id}`;
  }
  const native = item.providerRefs.find(reference => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(reference.remoteId || ""));
  if (native && item.id.startsWith("mdbx2:")) return `native:${native.remoteId}`;
  const prefix = isSteamMaFileItem(item) ? "steam-mafile"
    : item.kind === "login" ? "password"
    : item.kind === "secure-note" ? "note"
      : item.kind === "totp" ? "totp"
        : item.kind === "card" ? "card"
          : item.kind === "identity" ? "document-ref"
            : item.kind === "billing-address" ? "billing-address"
              : item.kind === "payment-account" ? "payment-account"
                : "passkey";
  if (item.replicaGroupId?.startsWith(`${prefix}:`)) return item.replicaGroupId;
  if (item.kind === "passkey" && item.credentialId) return `passkey:${item.credentialId}`;
  return `${prefix}:${item.id}`;
}

function objectTypeFor(item: VaultItem, steamMaFile: boolean): string | undefined {
  if (steamMaFile) return "steam-mafile";
  return ({
    login: "login",
    "secure-note": "note",
    totp: "totp",
    card: "card",
    identity: "document-ref",
    "billing-address": "billing-address",
    "payment-account": "payment-account",
    passkey: "passkey",
    "api-token": "api-token",
    opaque: undefined
  } as const)[item.kind];
}

function payloadKindFor(item: VaultItem, steamMaFile: boolean): string {
  return steamMaFile ? "steam_mafile"
    : item.kind === "card" ? "bank_card"
    : item.kind === "login" ? "password"
    : item.kind === "secure-note" ? "note"
      : item.kind === "identity" ? "document"
        : item.kind === "billing-address" ? "billing_address"
          : item.kind === "payment-account" ? "payment_account"
            : item.kind;
}

function itemTypeForObject(objectTypeId: string): string {
  return ({
    note: "NOTE",
    totp: "TOTP",
    card: "BANK_CARD",
    "document-ref": "DOCUMENT",
    "billing-address": "BILLING_ADDRESS",
    "payment-account": "PAYMENT_ACCOUNT"
  } as Record<string, string>)[objectTypeId] || objectTypeId.toUpperCase();
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  const parsed = parseLosslessJson(payloadJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MDBX2 Object payload must be a JSON object.");
  return parsed as Record<string, unknown>;
}

export function decodeOpaqueMdbxObject(record: Mdbx2ObjectRecord, metadata: Mdbx2ObjectMetadata, providerId: string, reason: string, payload: Record<string, unknown> = {}): Mdbx2DecodedObject {
  const updatedAt = normalizedDate(metadata.updatedAt);
  return {
    logicalObjectId: `native:${record.objectId}`, payload, unsupportedReason: `${record.objectTypeId}: ${reason}`,
    item: {
      id: `mdbx2:${providerId}:${record.objectId}`, kind: "opaque", title: record.title,
      nativeType: record.objectTypeId, payloadSchemaVersion: record.payloadSchemaVersion,
      originalPayload: record.payloadJson, readOnlyReason: reason,
      favorite: false, notes: "", createdAt: updatedAt, updatedAt,
      deletedAt: record.deleted ? updatedAt : undefined,
      mdbxFolderId: record.collectionId,
      providerRefs: [{ providerId, remoteId: record.objectId, remoteFolderId: record.collectionId, revision: metadata.headCommitId }]
    }
  };
}

function decodeSteamMaFileObject(
  record: Mdbx2ObjectRecord,
  metadata: Mdbx2ObjectMetadata,
  providerId: string,
  logicalObjectId: string,
  payload: Record<string, unknown>
): Mdbx2DecodedObject {
  const maFileJson = stringValue(payload.mafile_json);
  if (!maFileJson) {
    return decodeOpaqueMdbxObject(record, metadata, providerId, "Steam maFile 缺少 mafile_json，完整内容仅可安全查看。", payload);
  }
  try {
    const steam = parseSteamMaFile(maFileJson, record.title);
    const updatedAt = normalizedDate(metadata.updatedAt);
    const reference: ProviderReference = {
      providerId,
      remoteId: record.objectId,
      remoteFolderId: record.collectionId,
      revision: metadata.headCommitId
    };
    const item: TotpItem = {
      id: `mdbx2:${providerId}:${logicalObjectId}`,
      kind: "totp",
      title: record.title || steam.accountName || "Steam",
      favorite: false,
      notes: "",
      createdAt: updatedAt,
      updatedAt,
      providerRefs: [reference],
      replicaGroupId: logicalObjectId,
      mdbxFolderId: record.collectionId,
      secret: steam.sharedSecretBase64,
      issuer: "Steam",
      accountName: steam.accountName,
      otpType: "STEAM",
      steamDeviceId: steam.deviceId,
      steamSharedSecretBase64: steam.sharedSecretBase64,
      steamId: steam.steamId,
      steamAccessToken: steam.accessToken,
      steamRefreshToken: steam.refreshToken,
      steamLoginSecure: steam.steamLoginSecure,
      steamRevocationCode: steam.revocationCode,
      steamIdentitySecret: steam.identitySecret,
      steamTokenGid: steam.tokenGid,
      steamRawJson: steam.rawJson,
      algorithm: "SHA1",
      digits: 5,
      period: 30
    };
    return { logicalObjectId, payload, item };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "maFile 解析失败";
    return decodeOpaqueMdbxObject(record, metadata, providerId, `Steam maFile 无法使用：${reason}，完整内容仅可安全查看。`, payload);
  }
}

function isSteamMaFileType(objectTypeId: string): boolean {
  return objectTypeId === "steam-mafile";
}

function isSteamMaFileItem(item: VaultItem): boolean {
  return item.kind === "totp"
    && item.otpType === "STEAM"
    && (item.replicaGroupId?.startsWith("steam-mafile:") === true || Boolean(item.steamRawJson));
}

function mergeCustomFields(original: unknown, current: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const remaining = Array.isArray(original)
    ? original.map((candidate) => objectValue(candidate))
    : [];
  return current.map((field, index) => {
    const title = stringValue(field.title);
    const matchIndex = remaining.findIndex((candidate) => stringValue(candidate.title) === title);
    const selectedIndex = matchIndex >= 0 ? matchIndex : index < remaining.length ? index : -1;
    const previous = selectedIndex >= 0 ? remaining.splice(selectedIndex, 1)[0] : {};
    return { ...previous, ...field };
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return jsonScalarText(value);
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizedDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}
