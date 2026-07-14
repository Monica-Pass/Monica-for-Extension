import type { IdentityItem, PasskeyItem, TotpItem, VaultItem, VaultItemKind } from "../core/model";

const KINDS = new Set<VaultItemKind>(["login", "secure-note", "totp", "card", "identity", "billing-address", "payment-account", "passkey"]);

export function normalizeImportedVaultItem(input: unknown, now = new Date().toISOString()): VaultItem | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const kind = string(raw.kind) as VaultItemKind;
  if (!KINDS.has(kind)) return null;
  const base = {
    id: string(raw.id) || crypto.randomUUID(), kind, title: string(raw.title) || "导入项目", favorite: Boolean(raw.favorite), notes: string(raw.notes),
    createdAt: date(raw.createdAt, now), updatedAt: date(raw.updatedAt, now), providerRefs: Array.isArray(raw.providerRefs) ? raw.providerRefs.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const reference = value as Record<string, unknown>; const providerId = string(reference.providerId); if (!providerId) return [];
      return [{ providerId, remoteId: optional(reference.remoteId), remoteFolderId: optional(reference.remoteFolderId), revision: optional(reference.revision), etag: optional(reference.etag) }];
    }) : []
  };
  switch (kind) {
    case "login": return { ...base, kind, username: string(raw.username), password: string(raw.password), uris: strings(raw.uris), totpSecret: optional(raw.totpSecret), customFields: Array.isArray(raw.customFields) ? raw.customFields.flatMap((value) => value && typeof value === "object" ? [{ name: string((value as Record<string, unknown>).name), value: string((value as Record<string, unknown>).value), protected: Boolean((value as Record<string, unknown>).protected) }] : []) : [] };
    case "secure-note": return { ...base, kind, content: string(raw.content) };
    case "totp": return { ...base, kind, secret: string(raw.secret), issuer: optional(raw.issuer), accountName: optional(raw.accountName), algorithm: totpAlgorithm(raw.algorithm), digits: number(raw.digits, 6), period: number(raw.period, 30) };
    case "card": return { ...base, kind, cardholderName: string(raw.cardholderName), number: string(raw.number), expiryMonth: string(raw.expiryMonth), expiryYear: string(raw.expiryYear), securityCode: string(raw.securityCode), brand: optional(raw.brand), billingAddressId: optional(raw.billingAddressId) };
    case "identity": {
      const address = raw.address && typeof raw.address === "object" ? raw.address as Record<string, unknown> : {};
      return { ...base, kind, documentType: documentType(raw.documentType), documentNumber: string(raw.documentNumber), firstName: string(raw.firstName), middleName: string(raw.middleName), lastName: string(raw.lastName), fullName: string(raw.fullName), birthDate: optional(raw.birthDate), issuedDate: optional(raw.issuedDate), expiryDate: optional(raw.expiryDate), issuedBy: optional(raw.issuedBy), nationality: optional(raw.nationality), email: optional(raw.email), phone: optional(raw.phone), address: { fullName: string(address.fullName), company: string(address.company), streetAddress: string(address.streetAddress), apartment: string(address.apartment), city: string(address.city), stateProvince: string(address.stateProvince), postalCode: string(address.postalCode), country: string(address.country), phone: string(address.phone), email: string(address.email) } };
    }
    case "billing-address": return { ...base, kind, fullName: string(raw.fullName), company: string(raw.company), streetAddress: string(raw.streetAddress), apartment: string(raw.apartment), city: string(raw.city), stateProvince: string(raw.stateProvince), postalCode: string(raw.postalCode), country: string(raw.country), phone: string(raw.phone), email: string(raw.email) };
    case "payment-account": return { ...base, kind, paymentType: string(raw.paymentType), provider: string(raw.provider), accountName: string(raw.accountName), accountHolderName: string(raw.accountHolderName), email: string(raw.email), phone: string(raw.phone), username: string(raw.username), accountId: string(raw.accountId), maskedAccountNumber: string(raw.maskedAccountNumber), routingNumber: string(raw.routingNumber), iban: string(raw.iban), swiftBic: string(raw.swiftBic), website: string(raw.website), currency: string(raw.currency) };
    case "passkey": return { ...base, kind, credentialId: string(raw.credentialId), rpId: string(raw.rpId), rpName: string(raw.rpName), userHandle: string(raw.userHandle), userName: string(raw.userName), userDisplayName: string(raw.userDisplayName), algorithm: passkeyAlgorithm(raw.algorithm), publicKey: string(raw.publicKey), privateKeyPkcs8: optional(raw.privateKeyPkcs8), signCount: number(raw.signCount, 0), discoverable: raw.discoverable !== false, sourceMode: sourceMode(raw.sourceMode) };
  }
}

function string(value: unknown): string { return typeof value === "string" ? value : value == null ? "" : String(value); }
function optional(value: unknown): string | undefined { return string(value).trim() || undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map(string).filter(Boolean) : []; }
function number(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function date(value: unknown, fallback: string): string { const parsed = Date.parse(string(value)); return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString(); }
function totpAlgorithm(value: unknown): TotpItem["algorithm"] { const result = string(value).toUpperCase(); return result === "SHA256" || result === "SHA512" ? result : "SHA1"; }
function documentType(value: unknown): IdentityItem["documentType"] { const result = string(value).toUpperCase(); return result === "ID_CARD" || result === "PASSPORT" || result === "DRIVER_LICENSE" || result === "SOCIAL_SECURITY" ? result : "OTHER"; }
function passkeyAlgorithm(value: unknown): PasskeyItem["algorithm"] { const result = number(value, -7); return result === -257 || result === -37 || result === -8 ? result : -7; }
function sourceMode(value: unknown): PasskeyItem["sourceMode"] { const result = string(value); return result === "bitwarden" || result === "android-metadata-only" ? result : "browser-local"; }
