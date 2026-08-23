import type { ProviderReference, TotpItem, VaultItem } from "../../core/model";
import { exportSteamMaFile, parseSteamMaFile } from "../../core/steam-mafile";
import { androidRecordToItem, vaultItemToAndroidRecord } from "../webdav/android-backup-codec";
import type { Mdbx2ObjectRecord, Mdbx2ObjectUpsertInput } from "./native-contract";
import { parsePortablePasskeyPrivateKey } from "../../passkey/private-key-portability";

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
  const payload = parsePayload(record.payloadJson);
  const logicalObjectId = stringValue(payload.monica_entry_id) || record.objectId;
  if (isSteamMaFileType(record.objectTypeId)) {
    return decodeSteamMaFileObject(record, metadata, providerId, logicalObjectId, payload);
  }
  const folder = OBJECT_FOLDERS[record.objectTypeId];
  if (!folder) {
    return {
      logicalObjectId,
      payload,
      unsupportedReason: `MDBX2 Object 类型「${record.objectTypeId}」尚未映射，原始 JSON 已保留。`
    };
  }
  const raw = androidRawRecord(record, payload, logicalObjectId, metadata.updatedAt);
  const path = `folders/mdbx2/${folder}/${record.objectId}.json`;
  const decoded = androidRecordToItem(path, raw, providerId);
  if (!decoded) {
    return { logicalObjectId, payload, unsupportedReason: `MDBX2 Object「${logicalObjectId}」无法映射到 Monica 项目。` };
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
  if (item.kind === "passkey") {
    const portableKey = parsePortablePasskeyPrivateKey(payload.private_key_alias);
    const usable = portableKey?.algorithm === -7 && item.algorithm === -7;
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
  const logicalObjectId = logicalIdFor(item);
  const objectTypeId = objectTypeFor(item);
  if (!objectTypeId) return undefined;
  if (isSteamMaFileItem(item)) {
    const steamItem = item as TotpItem;
    const sharedSecret = steamItem.steamSharedSecretBase64 || steamItem.secret;
    if (!sharedSecret) return undefined;
    const maFileJson = exportSteamMaFile(steamItem);
    const parsed = parseSteamMaFile(maFileJson, steamItem.title);
    const payload: Record<string, unknown> = {
      ...originalPayload,
      kind: "steam_mafile",
      monica_entry_id: logicalObjectId,
      steamid: parsed.steamId || "",
      account_name: parsed.accountName,
      mafile_json: maFileJson
    };
    return {
      logicalObjectId,
      collectionId: steamItem.mdbxFolderId,
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
  const raw = vaultItemToAndroidRecord(item, originalRaw, originalItem);
  if (!raw) return undefined;
  const payload: Record<string, unknown> = { ...originalPayload };
  payload.kind = payloadKindFor(item);
  payload.monica_entry_id = logicalObjectId;
  payload.room_id = originalPayload.room_id ?? null;
  payload.mdbx_folder_id = item.mdbxFolderId ?? null;
  payload.notes = item.notes;
  payload.category_id = item.categoryId ?? null;
  payload.bitwarden_mode = originalPayload.bitwarden_mode ?? item.providerRefs.some((reference) => reference.providerId.startsWith("bitwarden"));
  payload.keepass_mode = originalPayload.keepass_mode ?? item.keepassDatabaseId != null;

  if (item.kind === "login") {
    payload.website = item.uris.join("\n");
    payload.username = item.username;
    payload.app_package_name = item.appPackageName || "";
    payload.app_name = item.appName || "";
    payload.password_plain = item.password;
    payload.bound_note_room_id = item.boundNoteId ?? null;
    payload.bound_note_entry_id = originalPayload.bound_note_entry_id ?? null;
    payload.login_type = item.loginType || "PASSWORD";
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
    payload.passkey_mode = item.passkeyMode || "LEGACY";
    payload.bitwarden_compatible = item.sourceMode === "bitwarden" || Boolean(item.keyAlgorithm);
    payload.keepass_compatible = item.passkeyMode === "KEEPASS_COMPAT";
  } else {
    payload.item_data = raw.itemData ?? originalPayload.item_data ?? "";
    payload.image_paths = raw.imagePaths ?? JSON.stringify(item.imagePaths || []);
    payload.bound_password_entry_id = originalPayload.bound_password_entry_id ?? null;
  }

  return {
    logicalObjectId,
    collectionId: item.mdbxFolderId,
    objectTypeId,
    title: item.title,
    payloadJson: JSON.stringify(payload)
  };
}

export function mdbx2LogicalObjectId(item: VaultItem): string {
  return logicalIdFor(item);
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
      authenticatorKey: payload.authenticator_key ?? "",
      passkeyBindings: payload.passkey_bindings ?? "",
      boundNoteId: payload.bound_note_room_id ?? null,
      loginType: payload.login_type ?? "PASSWORD",
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

function logicalIdFor(item: VaultItem): string {
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

function objectTypeFor(item: VaultItem): string | undefined {
  if (isSteamMaFileItem(item)) return "steam-mafile";
  return ({
    login: "login",
    "secure-note": "note",
    totp: "totp",
    card: "card",
    identity: "document-ref",
    "billing-address": "billing-address",
    "payment-account": "payment-account",
    passkey: "passkey"
  } as const)[item.kind];
}

function payloadKindFor(item: VaultItem): string {
  return isSteamMaFileItem(item) ? "steam_mafile"
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
  const parsed = JSON.parse(payloadJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MDBX2 Object payload must be a JSON object.");
  return structuredClone(parsed as Record<string, unknown>);
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
    return { logicalObjectId, payload, unsupportedReason: `MDBX2 Steam maFile「${logicalObjectId}」缺少 mafile_json，原始 JSON 已保留。` };
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
    return { logicalObjectId, payload, unsupportedReason: `MDBX2 Steam maFile「${logicalObjectId}」无法使用：${reason}，原始 JSON 已保留。` };
  }
}

function isSteamMaFileType(objectTypeId: string): boolean {
  const normalized = objectTypeId.trim().toLowerCase();
  return normalized === "steam-mafile" || normalized === "steam_mafile";
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
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizedDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}
