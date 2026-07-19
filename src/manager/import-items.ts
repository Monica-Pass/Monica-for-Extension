import type { IdentityItem, LoginItem, LoginUriMatchType, PasskeyItem, SecureCustomField, TotpItem, VaultItem, VaultItemKind } from "../core/model";

const KINDS = new Set<VaultItemKind>(["login", "secure-note", "totp", "card", "identity", "billing-address", "payment-account", "passkey"]);

export function normalizeImportedVaultItem(input: unknown, now = new Date().toISOString()): VaultItem | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const kind = string(raw.kind) as VaultItemKind;
  if (!KINDS.has(kind)) return null;
  const base = {
    id: string(raw.id) || crypto.randomUUID(), kind, title: string(raw.title) || "导入项目", favorite: Boolean(raw.favorite), notes: string(raw.notes),
    createdAt: date(raw.createdAt, now), updatedAt: date(raw.updatedAt, now), deletedAt: optionalDate(raw.deletedAt), archivedAt: optionalDate(raw.archivedAt), categoryId: optionalNumber(raw.categoryId), categoryName: optional(raw.categoryName), sortOrder: optionalNumber(raw.sortOrder), imagePaths: strings(raw.imagePaths), boundNoteId: optionalNumber(raw.boundNoteId), replicaGroupId: optional(raw.replicaGroupId), keepassDatabaseId: optionalNumber(raw.keepassDatabaseId), keepassGroupPath: optional(raw.keepassGroupPath), keepassEntryUuid: optional(raw.keepassEntryUuid), keepassGroupUuid: optional(raw.keepassGroupUuid), mdbxDatabaseId: optionalNumber(raw.mdbxDatabaseId), mdbxFolderId: optional(raw.mdbxFolderId), providerRefs: Array.isArray(raw.providerRefs) ? raw.providerRefs.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const reference = value as Record<string, unknown>; const providerId = string(reference.providerId); if (!providerId) return [];
      return [{ providerId, remoteId: optional(reference.remoteId), remoteFolderId: optional(reference.remoteFolderId), revision: optional(reference.revision), etag: optional(reference.etag) }];
    }) : []
  };
  switch (kind) {
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
        boundTotpItemId: optional(raw.boundTotpItemId),
        customFields: secureCustomFields(raw.customFields),
        loginType: loginType(raw.loginType),
        ssoProvider: optional(raw.ssoProvider),
        ssoRefEntryId: optionalNumber(raw.ssoRefEntryId),
        appPackageName: optional(raw.appPackageName),
        appName: optional(raw.appName),
        email: optional(raw.email),
        phone: optional(raw.phone),
        addressLine: optional(raw.addressLine),
        city: optional(raw.city),
        state: optional(raw.state),
        zipCode: optional(raw.zipCode),
        country: optional(raw.country),
        passkeyBindings: optional(raw.passkeyBindings),
        sshKeyData: optional(raw.sshKeyData),
        wifiMetadata: optional(raw.wifiMetadata),
        barcodeData: optional(raw.barcodeData),
        customIconType: optional(raw.customIconType),
        customIconValue: optional(raw.customIconValue),
        customIconUpdatedAt: optionalNumber(raw.customIconUpdatedAt)
      } satisfies LoginItem;
    }
    case "secure-note": return { ...base, kind, content: string(raw.content), tags: strings(raw.tags), isMarkdown: Boolean(raw.isMarkdown) };
    case "totp": return {
      ...base,
      kind,
      secret: string(raw.secret),
      issuer: optional(raw.issuer),
      accountName: optional(raw.accountName),
      otpType: otpType(raw.otpType),
      counter: optionalNumber(raw.counter),
      pin: optional(raw.pin),
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
    case "passkey": return { ...base, kind, credentialId: string(raw.credentialId), rpId: string(raw.rpId), rpName: string(raw.rpName), userHandle: string(raw.userHandle), userName: string(raw.userName), userDisplayName: string(raw.userDisplayName), algorithm: passkeyAlgorithm(raw.algorithm), publicKey: string(raw.publicKey), privateKeyPkcs8: optional(raw.privateKeyPkcs8), signCount: number(raw.signCount, 0), discoverable: raw.discoverable !== false, sourceMode: sourceMode(raw.sourceMode) };
  }
}

function string(value: unknown): string { return typeof value === "string" ? value : value == null ? "" : String(value); }
function optional(value: unknown): string | undefined { return string(value).trim() || undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map(string).filter(Boolean) : []; }
function number(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function optionalNumber(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
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
      name: string(raw.name || raw.label || raw.title),
      value: string(raw.value),
      protected: protectedField,
      fieldType: protectedField ? "HIDDEN" : declaredType
    }];
  });
}
function customFieldType(value: unknown): "TEXT" | "HIDDEN" | "BOOLEAN" { const result = string(value).toUpperCase(); return result === "HIDDEN" || result === "BOOLEAN" ? result : "TEXT"; }
function loginType(value: unknown): NonNullable<LoginItem["loginType"]> { const result = string(value).toUpperCase(); if (result === "SSH") return "SSH_KEY"; return result === "SSO" || result === "WIFI" || result === "SSH_KEY" || result === "BARCODE" ? result : "PASSWORD"; }
function loginUriRules(value: unknown, uris: string[]) { return Array.isArray(value) ? value.flatMap((entry) => { if (!entry || typeof entry !== "object") return []; const raw = entry as Record<string, unknown>; const uri = string(raw.uri).trim(); const matchType = string(raw.matchType) as LoginUriMatchType; return uri && ["base-domain", "domain", "starts-with", "exact", "regex", "never"].includes(matchType) ? [{ uri, matchType }] : []; }) : uris.map((uri) => ({ uri, matchType: "base-domain" as const })); }
function passkeyAlgorithm(value: unknown): PasskeyItem["algorithm"] { const result = number(value, -7); return result === -257 || result === -37 || result === -8 ? result : -7; }
function sourceMode(value: unknown): PasskeyItem["sourceMode"] { const result = string(value); return result === "bitwarden" || result === "android-metadata-only" ? result : "browser-local"; }
