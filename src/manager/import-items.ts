import type { CardFaceConfig, IdentityItem, LoginItem, LoginUriMatchType, PasskeyItem, SecureCustomField, TotpItem, VaultItem, VaultItemKind } from "../core/model";
import { jsonScalarText } from "../core/lossless-json";
import { normalizeOtpCounter } from "../core/otp-counter";
import { apiTokenFromPayload, serializeApiTokenMetadata, serializeApiTokenPayload } from "../core/api-token";

const KINDS = new Set<VaultItemKind>(["login", "secure-note", "totp", "card", "identity", "billing-address", "payment-account", "api-token", "passkey", "opaque"]);

export function normalizeImportedVaultItem(input: unknown, now = new Date().toISOString()): VaultItem | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const original = input as Record<string, unknown>;
  let originalPayload: string;
  try { originalPayload = JSON.stringify(original); } catch { return null; }
  try {
    const raw = { ...original };
    if (raw.kind === "totp" && raw.counter != null) raw.counter = normalizeOtpCounter(jsonScalarText(raw.counter));
    if (raw.kind === "api-token" && Array.isArray(raw.customFields)) raw.customFields = raw.customFields.map(value => {
      if (!value || typeof value !== "object") return value;
      const field = value as Record<string, unknown>;
      return isRawNumber(field.id) ? { ...field, id: jsonScalarText(field.id) } : field;
    });
    if (hasUncacheableNumber(raw)) throw new Error("包含当前手动导入缓存无法无损保留的数字，已保留原始内容。");
    validateImportShapes(raw);
    const normalized = normalizeKnownImportedItem(structuredClone(raw), now);
    if (!normalized) throw new Error("此项目类型或数据版本尚未支持编辑。");
    if (normalized.kind === "identity" && raw.address && typeof raw.address === "object") {
      normalized.address = { ...raw.address as Record<string, unknown>, ...normalized.address };
    }
    // Optional null is meaningful data, not Number(null)=0 or an absent value.
    const required = requiredKeys(normalized.kind);
    for (const [key, value] of Object.entries(raw)) if (value === null && !required.has(key)) (normalized as unknown as Record<string, unknown>)[key] = null;
    return normalized;
  } catch (error) {
    return {
      id: typeof original.id === "string" && original.id ? original.id : crypto.randomUUID(), kind: "opaque",
      title: typeof original.title === "string" ? original.title : "只读导入项目", favorite: false, notes: "", providerRefs: [],
      createdAt: date(original.createdAt, now), updatedAt: date(original.updatedAt, now),
      nativeType: typeof original.kind === "string" ? original.kind : "unknown",
      payloadSchemaVersion: typeof original.payloadSchemaVersion === "number" && Number.isSafeInteger(original.payloadSchemaVersion) && original.payloadSchemaVersion > 0 ? original.payloadSchemaVersion : 1, originalPayload,
      readOnlyReason: error instanceof Error ? error.message : "此项目仅可安全查看。"
    };
  }
}

function normalizeKnownImportedItem(raw: Record<string, unknown>, now: string): VaultItem | null {
  const kind = string(raw.kind) as VaultItemKind;
  if (!KINDS.has(kind)) return null;
  const base = {
    ...raw,
    ...(["card", "identity", "billing-address"].includes(kind) ? { cardFace: cardFace(raw.cardFace) } : {}),
    ...(kind === "identity" ? { documentTitle: optional(raw.documentTitle) } : {}),
    ...(kind === "passkey" ? { signCountHighWaterMark: optionalNumber(raw.signCountHighWaterMark) } : {}),
    id: string(raw.id) || crypto.randomUUID(), kind, title: string(raw.title) || "导入项目", favorite: Boolean(raw.favorite), notes: string(raw.notes),
    createdAt: date(raw.createdAt, now), updatedAt: date(raw.updatedAt, now), deletedAt: optionalDate(raw.deletedAt), archivedAt: optionalDate(raw.archivedAt), categoryId: optionalNumber(raw.categoryId), categoryName: optional(raw.categoryName), sortOrder: optionalNumber(raw.sortOrder), imagePaths: strings(raw.imagePaths), boundNoteId: optionalNumber(raw.boundNoteId), boundNoteEntryId: optional(raw.boundNoteEntryId), replicaGroupId: optional(raw.replicaGroupId), keepassDatabaseId: optionalNumber(raw.keepassDatabaseId), keepassGroupPath: optional(raw.keepassGroupPath), keepassEntryUuid: optional(raw.keepassEntryUuid), keepassGroupUuid: optional(raw.keepassGroupUuid), mdbxDatabaseId: optionalNumber(raw.mdbxDatabaseId), mdbxFolderId: optional(raw.mdbxFolderId), providerRefs: Array.isArray(raw.providerRefs) ? raw.providerRefs.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const reference = value as Record<string, unknown>; const providerId = string(reference.providerId); if (!providerId) return [];
      const remoteCollectionIds = stringIds(reference.remoteCollectionIds);
      return [{ ...reference, providerId, remoteId: optional(reference.remoteId), remoteFolderId: optional(reference.remoteFolderId), ...(remoteCollectionIds !== undefined ? { remoteCollectionIds } : {}), revision: optional(reference.revision), etag: optional(reference.etag) }];
    }) : []
  };
  switch (kind) {
    case "opaque": return { ...base, kind, nativeType: string(raw.nativeType), payloadSchemaVersion: number(raw.payloadSchemaVersion, 1), originalPayload: typeof raw.originalPayload === "string" ? raw.originalPayload : undefined, readOnlyReason: string(raw.readOnlyReason) || "此项目仅可安全查看。" };
    case "api-token": {
      try {
        const payload = serializeApiTokenPayload({ title: base.title, provider: string(raw.provider), apiBase: string(raw.apiBase), token: string(raw.token), apiTokenPayload: optional(raw.apiTokenPayload) });
        const fields = Array.isArray(raw.customFields) ? raw.customFields.map((value, index) => {
          const field = value && typeof value === "object" ? value as Record<string, unknown> : {};
          if (field.id !== undefined && typeof field.id !== "number" && typeof field.id !== "string") throw new Error("Invalid field ID");
          return { ...secureCustomFields([field])[0], id: field.id as number | string | undefined ?? -(index + 1) };
        }) : [];
        const metadata = serializeApiTokenMetadata({ notes: base.notes, customFields: fields, apiTokenMetadata: optional(raw.apiTokenMetadata) });
        const decoded = apiTokenFromPayload(payload, metadata);
        return decoded ? { ...base, kind, ...decoded } : null;
      } catch { return null; }
    }
    case "login": {
      const uris = strings(raw.uris ?? raw.urls);
      return {
        ...base,
        kind,
        username: string(raw.username),
        password: string(raw.password),
        uris,
        uriRules: loginUriRules(raw.uriRules, uris),
        totpSecret: optional(raw.totpSecret),
        boundTotpItemId: raw.boundTotpItemId === "" ? "" : optional(raw.boundTotpItemId),
        customFields: secureCustomFields(raw.customFields),
        loginType: loginType(raw.loginType),
        passwordGroupId: optional(raw.passwordGroupId),
        isGroupCover: typeof raw.isGroupCover === "boolean" ? raw.isGroupCover : undefined,
        ssoProvider: optional(raw.ssoProvider),
        ssoRefEntryId: optionalNumber(raw.ssoRefEntryId),
        ssoRefLogicalId: optional(raw.ssoRefLogicalId),
        appPackageName: optional(raw.appPackageName),
        appName: optional(raw.appName),
        email: optional(raw.email),
        phone: optional(raw.phone),
        addressLine: optional(raw.addressLine),
        city: optional(raw.city),
        state: optional(raw.state),
        zipCode: optional(raw.zipCode),
        country: optional(raw.country),
        creditCardNumber: optional(raw.creditCardNumber),
        creditCardHolder: optional(raw.creditCardHolder),
        creditCardExpiry: optional(raw.creditCardExpiry),
        creditCardCVV: optional(raw.creditCardCVV),
        passkeyBindings: optional(raw.passkeyBindings),
        sshKeyData: optional(raw.sshKeyData),
        wifiMetadata: optional(raw.wifiMetadata),
        barcodeData: optional(raw.barcodeData),
        customIconType: optional(raw.customIconType),
        customIconValue: optional(raw.customIconValue),
        customIconUpdatedAt: optionalNumber(raw.customIconUpdatedAt),
        steamAccountName: optional(raw.steamAccountName), steamDisplayName: optional(raw.steamDisplayName), steamDeviceId: optional(raw.steamDeviceId),
        steamSharedSecretBase64: optional(raw.steamSharedSecretBase64), steamId: optional(raw.steamId), steamAccessToken: optional(raw.steamAccessToken),
        steamRefreshToken: optional(raw.steamRefreshToken), steamLoginSecure: optional(raw.steamLoginSecure), steamRevocationCode: optional(raw.steamRevocationCode),
        steamIdentitySecret: optional(raw.steamIdentitySecret), steamTokenGid: optional(raw.steamTokenGid), steamRawJson: optional(raw.steamRawJson),
        passwordHistory: passwordHistory(raw.passwordHistory)
      } satisfies LoginItem;
    }
    case "secure-note": return { ...base, kind, content: string(raw.content), tags: strings(raw.tags), isMarkdown: Boolean(raw.isMarkdown), customFields: secureCustomFields(raw.customFields) };
    case "totp": return {
      ...base,
      kind,
      secret: string(raw.secret),
      issuer: optional(raw.issuer),
      accountName: optional(raw.accountName),
      otpType: otpType(raw.otpType),
      counter: raw.counter == null ? undefined : normalizeOtpCounter(raw.counter),
      pin: optional(raw.pin),
      pinLength: optionalNumber(raw.pinLength),
      link: optional(raw.link),
      associatedApp: optional(raw.associatedApp),
      customIconType: optional(raw.customIconType),
      customIconValue: optional(raw.customIconValue),
      customIconUpdatedAt: optionalNumber(raw.customIconUpdatedAt),
      boundPasswordId: optionalNumber(raw.boundPasswordId),
      categoryId: optionalNumber(raw.categoryId),
      keepassDatabaseId: optionalNumber(raw.keepassDatabaseId),
      steamFingerprint: optional(raw.steamFingerprint),
      steamDeviceId: optional(raw.steamDeviceId),
      steamSerialNumber: optional(raw.steamSerialNumber),
      steamSharedSecretBase64: optional(raw.steamSharedSecretBase64),
      steamId: optional(raw.steamId),
      steamAccessToken: optional(raw.steamAccessToken),
      steamRefreshToken: optional(raw.steamRefreshToken),
      steamLoginSecure: optional(raw.steamLoginSecure),
      steamRevocationCode: optional(raw.steamRevocationCode),
      steamIdentitySecret: optional(raw.steamIdentitySecret),
      steamTokenGid: optional(raw.steamTokenGid),
      steamRawJson: optional(raw.steamRawJson),
      algorithm: totpAlgorithm(raw.algorithm),
      digits: number(raw.digits, 6),
      period: number(raw.period, 30)
    };
    case "card": return { ...base, kind, cardholderName: string(raw.cardholderName), number: string(raw.number), expiryMonth: string(raw.expiryMonth), expiryYear: string(raw.expiryYear), securityCode: string(raw.securityCode), brand: optional(raw.brand), billingAddressId: optional(raw.billingAddressId), bankName: optional(raw.bankName), cardType: cardType(raw.cardType), billingAddress: optional(raw.billingAddress), nickname: optional(raw.nickname), validFromMonth: optional(raw.validFromMonth), validFromYear: optional(raw.validFromYear), pin: optional(raw.pin), iban: optional(raw.iban), swiftBic: optional(raw.swiftBic), routingNumber: optional(raw.routingNumber), accountNumber: optional(raw.accountNumber), branchCode: optional(raw.branchCode), currency: optional(raw.currency), customerServicePhone: optional(raw.customerServicePhone), customFields: secureCustomFields(raw.customFields) };
    case "identity": {
      const address = raw.address && typeof raw.address === "object" ? raw.address as Record<string, unknown> : {};
      return { ...base, kind, documentType: documentType(raw.documentType), documentNumber: string(raw.documentNumber), firstName: string(raw.firstName), middleName: string(raw.middleName), lastName: string(raw.lastName), fullName: string(raw.fullName), birthDate: optional(raw.birthDate), issuedDate: optional(raw.issuedDate), expiryDate: optional(raw.expiryDate), issuedBy: optional(raw.issuedBy), nationality: optional(raw.nationality), additionalInfo: optional(raw.additionalInfo), company: optional(raw.company), username: optional(raw.username), ssn: optional(raw.ssn), passportNumber: optional(raw.passportNumber), licenseNumber: optional(raw.licenseNumber), address3: optional(raw.address3), email: optional(raw.email), phone: optional(raw.phone), address: { fullName: string(address.fullName), company: string(address.company), streetAddress: string(address.streetAddress), apartment: string(address.apartment), city: string(address.city), stateProvince: string(address.stateProvince), postalCode: string(address.postalCode), country: string(address.country), phone: string(address.phone), email: string(address.email) }, customFields: secureCustomFields(raw.customFields) };
    }
    case "billing-address": return { ...base, kind, fullName: string(raw.fullName), company: string(raw.company), streetAddress: string(raw.streetAddress), apartment: string(raw.apartment), city: string(raw.city), stateProvince: string(raw.stateProvince), postalCode: string(raw.postalCode), country: string(raw.country), phone: string(raw.phone), email: string(raw.email), isDefault: Boolean(raw.isDefault), customFields: secureCustomFields(raw.customFields) };
    case "payment-account": return { ...base, kind, paymentType: string(raw.paymentType), provider: string(raw.provider), accountName: string(raw.accountName), accountHolderName: string(raw.accountHolderName), email: string(raw.email), phone: string(raw.phone), username: string(raw.username), accountId: string(raw.accountId), maskedAccountNumber: string(raw.maskedAccountNumber), linkedCardLast4: optional(raw.linkedCardLast4), routingNumber: string(raw.routingNumber), iban: string(raw.iban), swiftBic: string(raw.swiftBic), website: string(raw.website), currency: string(raw.currency), billingAddress: optional(raw.billingAddress), paymentNotes: optional(raw.paymentNotes), isDefault: Boolean(raw.isDefault), customFields: secureCustomFields(raw.customFields) };
    case "passkey": return { ...base, kind, credentialId: string(raw.credentialId), rpId: string(raw.rpId), rpName: string(raw.rpName), userHandle: string(raw.userHandle), userName: string(raw.userName), userDisplayName: string(raw.userDisplayName), algorithm: passkeyAlgorithm(raw.algorithm), keyAlgorithm: optional(raw.keyAlgorithm), publicKey: string(raw.publicKey), privateKeyPkcs8: optional(raw.privateKeyPkcs8), signCount: number(raw.signCount, 0), backupEligible: typeof raw.backupEligible === "boolean" ? raw.backupEligible : undefined, backupState: typeof raw.backupState === "boolean" ? raw.backupState : undefined, discoverable: raw.discoverable !== false, userVerificationRequired: raw.userVerificationRequired === undefined ? undefined : Boolean(raw.userVerificationRequired), transports: strings(raw.transports), aaguid: optional(raw.aaguid), lastUsedAt: optionalDate(raw.lastUsedAt), useCount: optionalNumber(raw.useCount), iconUrl: optional(raw.iconUrl), boundPasswordId: optionalNumber(raw.boundPasswordId), passkeyMode: passkeyMode(raw.passkeyMode), sourceMode: sourceMode(raw.sourceMode) };
  }
}

/** A manual snapshot import cannot inherit another installation's live provider bindings. */
export function independentImportedPasskey(item: VaultItem): VaultItem {
  if (item.kind !== "passkey") return item;
  const {
    keepassDatabaseId: _database, keepassGroupPath: _group, keepassEntryUuid: _entry,
    keepassGroupUuid: _groupUuid, mdbxDatabaseId: _mdbx, mdbxFolderId: _folder,
    replicaGroupId: _replica, boundPasswordId: _password, boundNoteId: _note, boundNoteEntryId: _noteEntry, ...portable
  } = item;
  return {
    ...portable,
    id: crypto.randomUUID(),
    providerRefs: [],
    sourceMode: item.privateKeyPkcs8 ? "browser-local" : "android-metadata-only"
  };
}

function string(value: unknown): string { return jsonScalarText(value); }
function optional(value: unknown): string | undefined { return value == null ? undefined : string(value); }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map(string).filter(Boolean) : []; }
function stringIds(value: unknown): string[] | undefined { const result = strings(value); return result.length ? result : Array.isArray(value) ? [] : undefined; }
function number(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function optionalNumber(value: unknown): number | undefined { if (value == null || value === "") return undefined; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function date(value: unknown, fallback: string): string { const parsed = Date.parse(string(value)); return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString(); }
function optionalDate(value: unknown): string | undefined { const parsed = Date.parse(string(value)); return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString(); }
function totpAlgorithm(value: unknown): TotpItem["algorithm"] { const result = string(value).toUpperCase(); return result === "SHA256" || result === "SHA512" ? result : "SHA1"; }
function otpType(value: unknown): NonNullable<TotpItem["otpType"]> { const result = string(value).toUpperCase(); return result === "HOTP" || result === "STEAM" || result === "YANDEX" || result === "MOTP" ? result : "TOTP"; }
function documentType(value: unknown): IdentityItem["documentType"] { const result = string(value).toUpperCase(); return result === "ID_CARD" || result === "PASSPORT" || result === "DRIVER_LICENSE" || result === "SOCIAL_SECURITY" ? result : "OTHER"; }
function cardType(value: unknown): "CREDIT" | "DEBIT" | "PREPAID" { const result = string(value).toUpperCase(); return result === "DEBIT" || result === "PREPAID" ? result : "CREDIT"; }
function secureCustomFields(value: unknown): SecureCustomField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const declaredType = customFieldType(raw.fieldType || raw.type);
    const protectedField = Boolean(raw.protected || raw.isProtected) || declaredType === "HIDDEN";
    return [{
      ...raw,
      name: string(raw.name || raw.label || raw.title),
      value: string(raw.value),
      protected: protectedField,
      fieldType: protectedField ? "HIDDEN" : declaredType
    }];
  });
}
function customFieldType(value: unknown): "TEXT" | "HIDDEN" | "BOOLEAN" { const result = string(value).toUpperCase(); return result === "HIDDEN" || result === "BOOLEAN" ? result : "TEXT"; }
function loginType(value: unknown): NonNullable<LoginItem["loginType"]> { const result = string(value).toUpperCase(); if (result === "SSH") return "SSH_KEY"; return result === "SSO" || result === "WIFI" || result === "SSH_KEY" || result === "GPG_KEY" || result === "API_KEY" || result === "STEAM_MAFILE" || result === "BARCODE" ? result : "PASSWORD"; }
function loginUriRules(value: unknown, uris: string[]) { return Array.isArray(value) ? value.flatMap((entry) => { if (!entry || typeof entry !== "object") return []; const raw = entry as Record<string, unknown>; const uri = string(raw.uri); const matchType = string(raw.matchType) as LoginUriMatchType; return uri && ["base-domain", "domain", "starts-with", "exact", "regex", "never"].includes(matchType) ? [{ ...raw, uri, matchType }] : []; }) : uris.map((uri) => ({ uri, matchType: "base-domain" as const })); }
function passkeyAlgorithm(value: unknown): PasskeyItem["algorithm"] { const result = number(value, -7); return Number.isSafeInteger(result) ? result : -7; }
function sourceMode(value: unknown): PasskeyItem["sourceMode"] { const result = string(value); return result === "bitwarden" || result === "android-metadata-only" ? result : "browser-local"; }
function passkeyMode(value: unknown): PasskeyItem["passkeyMode"] { const result = string(value).toUpperCase(); return result === "BW_COMPAT" || result === "KEEPASS_COMPAT" ? result : result === "LEGACY" ? result : undefined; }

function cardFace(value: unknown): CardFaceConfig | null | undefined {
  if (value == null) return value as null | undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("卡面数据形状不兼容，仅可安全查看。");
  const raw = value as Record<string, unknown>;
  if (typeof raw.imageAttachmentName !== "string" || !["ALL", "CARD_NUMBER_ONLY", "HIDDEN"].includes(String(raw.displayMode)) || typeof raw.showBrandIcon !== "boolean") throw new Error("卡面版本或字段不兼容，仅可安全查看。");
  return raw as unknown as CardFaceConfig;
}
function passwordHistory(value: unknown): LoginItem["passwordHistory"] {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some(entry => !entry || typeof entry !== "object" || typeof entry.password !== "string" || typeof entry.lastUsedAt !== "string")) throw new Error("密码历史形状不兼容，仅可安全查看。");
  return value;
}
function isRawNumber(value: unknown): boolean { return (JSON as typeof JSON & { isRawJSON?: (input: unknown) => boolean }).isRawJSON?.(value) === true; }
function hasUncacheableNumber(value: unknown): boolean {
  if (isRawNumber(value) || typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return true;
  return Boolean(value && typeof value === "object" && Object.values(value).some(hasUncacheableNumber));
}
function requiredKeys(kind: VaultItemKind): Set<string> {
  const extra: Partial<Record<VaultItemKind, string>> = {
    login: "username password uris customFields", "secure-note": "content", totp: "secret algorithm digits period",
    card: "cardholderName number expiryMonth expiryYear securityCode", identity: "documentType documentNumber firstName middleName lastName fullName",
    "billing-address": "fullName company streetAddress apartment city stateProvince postalCode country phone email",
    "payment-account": "paymentType provider accountName accountHolderName email phone username accountId maskedAccountNumber routingNumber iban swiftBic website currency",
    "api-token": "provider apiBase token customFields", passkey: "credentialId rpId rpName userHandle userName userDisplayName algorithm publicKey signCount discoverable"
  };
  return new Set(`id kind title favorite notes createdAt updatedAt providerRefs ${extra[kind] || ""}`.split(" "));
}
function validateImportShapes(raw: Record<string, unknown>): void {
  const kind = raw.kind as VaultItemKind;
  if (!KINDS.has(kind)) throw new Error("此项目类型尚无编辑器，完整内容以只读方式保留。");
  const required = requiredKeys(kind);
  for (const key of required) if (raw[key] === null) throw new Error("必填字段具有不兼容的空值，完整内容仅可安全查看。");
  const objects = new Set(["providerRefs", "customFields", "imagePaths", "uris", "urls", "uriRules", "tags", "transports", "passwordHistory", "cardFace", "address"]);
  const knownScalars = new Set(("id kind title favorite notes createdAt updatedAt deletedAt archivedAt categoryId categoryName sortOrder boundNoteId boundNoteEntryId replicaGroupId keepassDatabaseId keepassGroupPath keepassEntryUuid keepassGroupUuid mdbxDatabaseId mdbxFolderId username password totpSecret boundTotpItemId loginType passwordGroupId ssoProvider ssoRefEntryId ssoRefLogicalId appPackageName appName email phone addressLine city state zipCode country creditCardNumber creditCardHolder creditCardExpiry creditCardCVV passkeyBindings sshKeyData wifiMetadata barcodeData customIconType customIconValue customIconUpdatedAt steamAccountName steamDisplayName steamDeviceId steamSharedSecretBase64 steamId steamAccessToken steamRefreshToken steamLoginSecure steamRevocationCode steamIdentitySecret steamTokenGid steamRawJson content isMarkdown secret issuer accountName otpType counter pin pinLength link associatedApp boundPasswordId steamFingerprint steamSerialNumber algorithm digits period cardholderName number expiryMonth expiryYear securityCode brand billingAddressId bankName cardType billingAddress nickname validFromMonth validFromYear iban swiftBic routingNumber accountNumber branchCode currency customerServicePhone documentType documentNumber firstName middleName lastName fullName documentTitle birthDate issuedDate expiryDate issuedBy nationality additionalInfo company ssn passportNumber licenseNumber address3 streetAddress apartment stateProvince postalCode isDefault paymentType provider accountHolderName accountId maskedAccountNumber linkedCardLast4 website paymentNotes apiBase token apiTokenPayload apiTokenMetadata credentialId rpId rpName userHandle userName userDisplayName keyAlgorithm publicKey privateKeyPkcs8 signCount signCountHighWaterMark backupEligible backupState discoverable userVerificationRequired aaguid lastUsedAt useCount iconUrl passkeyMode sourceMode").split(" "));
  for (const [key, value] of Object.entries(raw)) {
    if (knownScalars.has(key) && value !== null && typeof value === "object") throw new Error("已知字段形状不兼容，完整内容仅可安全查看。");
    if (objects.has(key) && value != null && key !== "cardFace" && key !== "address" && !Array.isArray(value)) throw new Error("列表字段形状不兼容，完整内容仅可安全查看。");
  }
  if (raw.address != null && (typeof raw.address !== "object" || Array.isArray(raw.address))) throw new Error("地址字段形状不兼容，完整内容仅可安全查看。");
  for (const key of ["favorite", "isGroupCover", "isMarkdown", "isDefault", "backupEligible", "backupState", "discoverable", "userVerificationRequired"]) {
    if (raw[key] != null && typeof raw[key] !== "boolean") throw new Error("布尔字段形状不兼容，完整内容仅可安全查看。");
  }
  for (const key of ["categoryId", "sortOrder", "boundNoteId", "keepassDatabaseId", "mdbxDatabaseId", "ssoRefEntryId", "customIconUpdatedAt", "pinLength", "boundPasswordId", "digits", "period", "signCount", "signCountHighWaterMark", "useCount", ...(kind === "passkey" ? ["algorithm"] : [])]) {
    if (raw[key] != null && (typeof raw[key] !== "number" && typeof raw[key] !== "string" || raw[key] === "" || !Number.isSafeInteger(Number(raw[key])))) throw new Error("整数超出当前字段安全范围，完整内容仅可安全查看。");
  }
  for (const key of ["imagePaths", "uris", "urls", "tags", "transports"]) {
    if (Array.isArray(raw[key]) && raw[key].some(value => typeof value !== "string")) throw new Error("字符串列表形状不兼容，完整内容仅可安全查看。");
  }
  if (Array.isArray(raw.uriRules)) for (const rule of raw.uriRules) {
    if (!rule || typeof rule !== "object" || typeof rule.uri !== "string" || !rule.uri || !["base-domain", "domain", "starts-with", "exact", "regex", "never"].includes(rule.matchType)) throw new Error("网址规则尚未支持，完整内容仅可安全查看。");
  }
  if (Array.isArray(raw.providerRefs)) for (const reference of raw.providerRefs) {
    if (!reference || typeof reference !== "object" || typeof reference.providerId !== "string" || !reference.providerId) throw new Error("密码源引用形状不兼容，完整内容仅可安全查看。");
  }
  const enumField = (key: string, allowed: string[]) => { if (raw[key] != null && raw[key] !== "" && !allowed.includes(string(raw[key]).toUpperCase())) throw new Error(`不支持的 ${key} 值，完整内容仅可安全查看。`); };
  if (kind === "login") enumField("loginType", ["PASSWORD", "SSO", "WIFI", "SSH", "SSH_KEY", "GPG_KEY", "API_KEY", "BARCODE", "STEAM_MAFILE"]);
  if (kind === "totp") { enumField("otpType", ["TOTP", "HOTP", "STEAM", "YANDEX", "MOTP"]); enumField("algorithm", ["SHA1", "SHA256", "SHA512"]); }
  if (kind === "card") enumField("cardType", ["CREDIT", "DEBIT", "PREPAID"]);
  if (kind === "identity") enumField("documentType", ["ID_CARD", "PASSPORT", "DRIVER_LICENSE", "SOCIAL_SECURITY", "OTHER"]);
  if (kind === "passkey") { enumField("passkeyMode", ["LEGACY", "BW_COMPAT", "KEEPASS_COMPAT"]); enumField("sourceMode", ["BROWSER-LOCAL", "BITWARDEN", "ANDROID-METADATA-ONLY"]); }
  if (Array.isArray(raw.customFields)) for (const field of raw.customFields) {
    if (!field || typeof field !== "object" || Array.isArray(field) || field.value != null && typeof field.value === "object") throw new Error("自定义字段形状不兼容，仅可安全查看。");
    const type = field.fieldType ?? field.type;
    if (type != null && !["TEXT", "HIDDEN", "BOOLEAN"].includes(string(type).toUpperCase())) throw new Error("自定义字段类型尚未支持，仅可安全查看。");
  }
}
