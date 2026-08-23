import type {
  BillingAddressItem,
  CardItem,
  IdentityItem,
  PaymentAccountItem,
  SecureCustomField,
  SecureNoteItem,
  TotpItem,
  VaultItem,
  VaultItemBase
} from "../core/model";

/**
 * The `MonicaItemData` JSON payload, shared by every transport that carries an Android `SecureItem`:
 * the WebDAV backup writes it as `itemData`, KDBX writes it as the `MonicaItemData` entry field, and
 * both hold the exact string Android's `CardWalletDataCodec` / `NoteContentCodec` produced.
 *
 * Android declares no `@SerialName` anywhere, so every key below is the literal Kotlin property name.
 * The read aliases exist for payloads written by older builds, which `parseLegacy*` still accepts.
 */

export const MONICA_ITEM_TYPES = [
  "PASSWORD",
  "TOTP",
  "BANK_CARD",
  "DOCUMENT",
  "BILLING_ADDRESS",
  "PAYMENT_ACCOUNT",
  "NOTE"
] as const;

export type MonicaItemType = (typeof MONICA_ITEM_TYPES)[number];

/** The base every projection is spread onto; `kind` comes from the item type instead. */
export type MonicaItemBase = Omit<VaultItemBase, "kind">;

const ITEM_TYPE_BY_KIND: Partial<Record<VaultItem["kind"], MonicaItemType>> = {
  totp: "TOTP",
  card: "BANK_CARD",
  identity: "DOCUMENT",
  "billing-address": "BILLING_ADDRESS",
  "payment-account": "PAYMENT_ACCOUNT",
  "secure-note": "NOTE"
};

/**
 * Android calls `ItemType.valueOf` and skips the whole entry when it throws, so an unrecognised
 * spelling must never be invented on the write side nor guessed at on the read side.
 */
export function monicaItemTypeOf(value: string): MonicaItemType | undefined {
  const normalized = value.trim();
  return (MONICA_ITEM_TYPES as readonly string[]).includes(normalized) ? (normalized as MonicaItemType) : undefined;
}

export function monicaItemTypeForKind(kind: VaultItem["kind"]): MonicaItemType | undefined {
  return ITEM_TYPE_BY_KIND[kind];
}

export interface MonicaItemDataOptions {
  /** `SecureItem.notes`, which a NOTE payload falls back to when it carries no `content`. */
  fallbackNotes?: string;
}

/**
 * `PASSWORD` returns undefined: a password is never modelled through `MonicaItemData` — it lives in
 * the standard fields — so a payload claiming that type has nothing here to decode.
 */
export function monicaItemDataToVaultItem(
  itemType: MonicaItemType,
  data: Record<string, unknown>,
  base: MonicaItemBase,
  options: MonicaItemDataOptions = {}
): VaultItem | undefined {
  switch (itemType) {
    case "NOTE":
      return {
        ...base,
        kind: "secure-note",
        content: firstString(data, "content") || options.fallbackNotes || "",
        tags: stringArray(data.tags),
        isMarkdown: Boolean(data.isMarkdown),
        customFields: parseSecureCustomFields(data.customFields)
      } satisfies SecureNoteItem;
    case "TOTP": {
      const totp = { ...base, ...decodeTotp(data) } satisfies TotpItem;
      // Both live on the base, but an authenticator payload may also carry them; a payload that
      // omits one must not blank out the value the envelope already supplied.
      return {
        ...totp,
        categoryId: optionalNumber(data.categoryId) ?? totp.categoryId,
        keepassDatabaseId: optionalNumber(data.keepassDatabaseId) ?? totp.keepassDatabaseId
      };
    }
    case "BANK_CARD":
      return { ...base, ...decodeBankCard(data) } satisfies CardItem;
    case "DOCUMENT":
      return { ...base, ...decodeDocument(data) } satisfies IdentityItem;
    case "BILLING_ADDRESS":
      return { ...base, ...decodeBillingAddress(data) } satisfies BillingAddressItem;
    case "PAYMENT_ACCOUNT":
      return { ...base, ...decodePaymentAccount(data) } satisfies PaymentAccountItem;
    case "PASSWORD":
      return undefined;
  }
}

function decodeTotp(data: Record<string, unknown>): Omit<TotpItem, keyof MonicaItemBase> {
  const rawOtpType = stringValue(data.otpType);
  const otpType = rawOtpType ? normalizeOtpType(rawOtpType) : undefined;
  const steamSharedSecret = firstString(data, "steamSharedSecretBase64");
  const steamSession = parseSteamSession(firstString(data, "steamRawJson"));
  const secret = firstString(data, "secret", "authenticatorKey");
  return {
    kind: "totp",
    secret: otpType === "STEAM" || steamSharedSecret ? steamSharedSecret || secret : secret,
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
  };
}

function decodeBankCard(data: Record<string, unknown>): Omit<CardItem, keyof MonicaItemBase> {
  return {
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
    validFromMonth: optionalString(firstString(data, "validFromMonth", "fromMonth")),
    validFromYear: optionalString(firstString(data, "validFromYear", "fromYear")),
    pin: optionalString(firstString(data, "pin")),
    iban: optionalString(firstString(data, "iban")),
    swiftBic: optionalString(firstString(data, "swiftBic")),
    routingNumber: optionalString(firstString(data, "routingNumber")),
    accountNumber: optionalString(firstString(data, "accountNumber")),
    branchCode: optionalString(firstString(data, "branchCode")),
    currency: optionalString(firstString(data, "currency")),
    customerServicePhone: optionalString(firstString(data, "customerServicePhone")),
    customFields: parseSecureCustomFields(data.customFields)
  };
}

function decodeDocument(data: Record<string, unknown>): Omit<IdentityItem, keyof MonicaItemBase> {
  const firstName = firstString(data, "firstName");
  const middleName = firstString(data, "middleName");
  const lastName = firstString(data, "lastName");
  const nameFromParts = [firstName, middleName, lastName].filter(Boolean).join(" ");
  return {
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
    licenseNumber: optionalString(firstString(data, "licenseNumber", "driverLicense")),
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
  };
}

function decodeBillingAddress(data: Record<string, unknown>): Omit<BillingAddressItem, keyof MonicaItemBase> {
  return {
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
  };
}

function decodePaymentAccount(data: Record<string, unknown>): Omit<PaymentAccountItem, keyof MonicaItemBase> {
  return {
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
    linkedCardLast4: optionalString(firstString(data, "linkedCardLast4", "cardLast4", "last4")),
    routingNumber: firstString(data, "routingNumber"),
    iban: firstString(data, "iban"),
    swiftBic: firstString(data, "swiftBic", "swift", "bic"),
    website: firstString(data, "website", "url", "uri"),
    currency: firstString(data, "currency"),
    billingAddress: optionalString(firstString(data, "billingAddress")),
    paymentNotes: optionalString(firstString(data, "notes", "memo")),
    isDefault: Boolean(data.isDefault),
    customFields: parseSecureCustomFields(data.customFields)
  };
}

/**
 * Rebuilds the payload from the item and merges it over `original`, so a key written by a newer
 * Android build survives an edit made here. Kotlin's `CardWalletDataCodec` serializes with
 * `encodeDefaults = true`, so every modelled key is emitted; `NoteContentCodec` uses a bare `Json`,
 * which omits defaults, and that difference is reproduced rather than smoothed over.
 */
export function vaultItemToMonicaItemData(item: VaultItem, original?: string): string | undefined {
  const built = buildMonicaItemData(item);
  if (!built) return undefined;
  return JSON.stringify({ ...parseMonicaItemData(original), ...built });
}

function buildMonicaItemData(item: VaultItem): Record<string, unknown> | undefined {
  switch (item.kind) {
    case "secure-note":
      return {
        content: item.content,
        ...(item.tags?.length ? { tags: item.tags } : {}),
        ...(item.isMarkdown ? { isMarkdown: true } : {}),
        ...((item.customFields?.length || 0) > 0 ? { customFields: serializeSecureCustomFields(item.customFields) } : {})
      };
    case "totp":
      return {
        secret: item.secret,
        issuer: item.issuer || "",
        accountName: item.accountName || "",
        period: item.period,
        digits: item.digits,
        algorithm: item.algorithm,
        otpType: item.otpType || "TOTP",
        counter: item.counter ?? 0,
        pin: item.pin || "",
        link: item.link || "",
        associatedApp: item.associatedApp || "",
        customIconType: item.customIconType || "NONE",
        customIconValue: item.customIconValue ?? null,
        customIconUpdatedAt: item.customIconUpdatedAt ?? 0,
        boundPasswordId: item.boundPasswordId ?? null,
        categoryId: item.categoryId ?? null,
        keepassDatabaseId: item.keepassDatabaseId ?? null,
        steamFingerprint: item.steamFingerprint || "",
        steamDeviceId: item.steamDeviceId || "",
        steamSerialNumber: item.steamSerialNumber || "",
        steamSharedSecretBase64: item.steamSharedSecretBase64 || "",
        steamRevocationCode: item.steamRevocationCode || "",
        steamIdentitySecret: item.steamIdentitySecret || "",
        steamTokenGid: item.steamTokenGid || "",
        steamRawJson: item.steamRawJson || ""
      };
    case "card":
      return {
        cardNumber: item.number,
        cardholderName: item.cardholderName,
        expiryMonth: item.expiryMonth,
        expiryYear: item.expiryYear,
        cvv: item.securityCode,
        bankName: item.bankName || "",
        cardType: item.cardType || "CREDIT",
        billingAddress: item.billingAddress || "",
        brand: item.brand || "",
        nickname: item.nickname || "",
        validFromMonth: item.validFromMonth || "",
        validFromYear: item.validFromYear || "",
        pin: item.pin || "",
        iban: item.iban || "",
        swiftBic: item.swiftBic || "",
        routingNumber: item.routingNumber || "",
        accountNumber: item.accountNumber || "",
        branchCode: item.branchCode || "",
        currency: item.currency || "",
        customerServicePhone: item.customerServicePhone || "",
        customFields: serializeSecureCustomFields(item.customFields)
      };
    case "identity":
      return {
        documentType: item.documentType,
        documentNumber: item.documentNumber,
        fullName: item.fullName,
        issuedDate: item.issuedDate || "",
        expiryDate: item.expiryDate || "",
        issuedBy: item.issuedBy || "",
        nationality: item.nationality || "",
        additionalInfo: item.additionalInfo || "",
        birthDate: item.birthDate || "",
        title: item.title,
        firstName: item.firstName,
        middleName: item.middleName,
        lastName: item.lastName,
        address1: item.address?.streetAddress || "",
        address2: item.address?.apartment || "",
        address3: item.address3 || "",
        city: item.address?.city || "",
        stateProvince: item.address?.stateProvince || "",
        postalCode: item.address?.postalCode || "",
        country: item.address?.country || "",
        company: item.company || "",
        email: item.email || "",
        phone: item.phone || "",
        ssn: item.ssn || "",
        username: item.username || "",
        passportNumber: item.passportNumber || "",
        licenseNumber: item.licenseNumber || "",
        customFields: serializeSecureCustomFields(item.customFields)
      };
    case "billing-address":
      return {
        fullName: item.fullName,
        company: item.company,
        streetAddress: item.streetAddress,
        apartment: item.apartment,
        city: item.city,
        stateProvince: item.stateProvince,
        postalCode: item.postalCode,
        country: item.country,
        phone: item.phone,
        email: item.email,
        isDefault: Boolean(item.isDefault),
        customFields: serializeSecureCustomFields(item.customFields)
      };
    case "payment-account":
      return {
        paymentType: item.paymentType,
        provider: item.provider,
        accountName: item.accountName,
        accountHolderName: item.accountHolderName,
        email: item.email,
        phone: item.phone,
        username: item.username,
        accountId: item.accountId,
        maskedAccountNumber: item.maskedAccountNumber,
        linkedCardLast4: item.linkedCardLast4 || "",
        routingNumber: item.routingNumber,
        iban: item.iban,
        swiftBic: item.swiftBic,
        billingAddress: item.billingAddress || "",
        website: item.website,
        currency: item.currency,
        notes: item.paymentNotes || "",
        isDefault: Boolean(item.isDefault),
        customFields: serializeSecureCustomFields(item.customFields)
      };
    default:
      return undefined;
  }
}

export function parseMonicaItemData(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseSecureCustomFields(value: unknown): SecureCustomField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const name = firstString(raw, "label", "title", "name").trim();
    if (!name) return [];
    const rawType = firstString(raw, "type").toUpperCase();
    const fieldType: NonNullable<SecureCustomField["fieldType"]> = rawType === "HIDDEN" || rawType === "BOOLEAN" ? rawType : "TEXT";
    return [{ name, value: firstString(raw, "value"), protected: fieldType === "HIDDEN", fieldType }];
  });
}

/** Android's key is `label`, not `name`; emitting the extension's own spelling would lose the field. */
export function serializeSecureCustomFields(value: SecureCustomField[] | undefined): Array<{ label: string; value: string; type: string }> {
  return (value || [])
    .filter((field) => field.name.trim())
    .map((field) => ({ label: field.name.trim(), value: field.value, type: field.fieldType || (field.protected ? "HIDDEN" : "TEXT") }));
}

export function normalizeTotpAlgorithm(value: unknown): TotpItem["algorithm"] {
  const normalized = stringValue(value).toUpperCase();
  return normalized === "SHA256" || normalized === "SHA512" ? normalized : "SHA1";
}

export function normalizeOtpType(value: unknown): NonNullable<TotpItem["otpType"]> {
  const normalized = stringValue(value).trim().toUpperCase();
  return normalized === "HOTP" || normalized === "STEAM" || normalized === "YANDEX" || normalized === "MOTP" ? normalized : "TOTP";
}

export function normalizeCardType(value: unknown): NonNullable<CardItem["cardType"]> {
  const normalized = stringValue(value).trim().toUpperCase();
  return normalized === "DEBIT" || normalized === "PREPAID" ? normalized : "CREDIT";
}

export function normalizeDocumentType(value: unknown): IdentityItem["documentType"] {
  const normalized = stringValue(value).trim().toUpperCase().replace(/[ -]/g, "_");
  if (normalized === "PASSPORT") return "PASSPORT";
  if (normalized === "DRIVER_LICENSE" || normalized === "DRIVERLICENSE" || normalized === "LICENSE") return "DRIVER_LICENSE";
  if (normalized === "SOCIAL_SECURITY" || normalized === "SOCIALSECURITY" || normalized === "SSN") return "SOCIAL_SECURITY";
  if (normalized === "ID_CARD" || normalized === "IDCARD" || normalized === "IDENTITY") return "ID_CARD";
  return "OTHER";
}

export function normalizePaymentAccountType(value: unknown): string {
  const normalized = stringValue(value).trim().toLowerCase().replace(/[ -]/g, "_");
  if (normalized === "bank" || normalized === "bank_account" || normalized === "account") return "BANK_ACCOUNT";
  if (normalized === "payment_app" || normalized === "app" || normalized === "mobile_payment" || normalized === "mobile_wallet") return "PAYMENT_APP";
  if (normalized === "bnpl" || normalized === "buy_now_pay_later" || normalized === "pay_later") return "BUY_NOW_PAY_LATER";
  if (normalized === "crypto" || normalized === "crypto_wallet" || normalized === "wallet_crypto") return "CRYPTO_WALLET";
  if (normalized === "other") return "OTHER";
  return "DIGITAL_WALLET";
}

export function parseSteamSession(rawJson: string): { steamId?: string; accessToken?: string; refreshToken?: string; loginSecure?: string } {
  if (!rawJson.trim()) return {};
  try {
    const root = JSON.parse(rawJson) as Record<string, unknown>;
    const session = (root.Session || root.session) as Record<string, unknown> | undefined;
    const loginSecure = firstString(root, "steamLoginSecure", "steam_login_secure") || firstString(session || {}, "SteamLoginSecure", "steamLoginSecure");
    const accessToken =
      firstString(root, "access_token", "accessToken", "oauth_token", "OAuthToken") ||
      firstString(session || {}, "AccessToken", "access_token", "OAuthToken", "oauth_token") ||
      loginSecure.split("||").slice(1).join("||");
    const refreshToken = firstString(root, "refresh_token", "refreshToken") || firstString(session || {}, "RefreshToken", "refresh_token");
    const steamId =
      firstString(root, "steamid", "steam_id", "SteamID", "steam64", "steam_id64", "steamID64") ||
      firstString(session || {}, "SteamID", "steamid", "steam_id") ||
      loginSecure.split("||")[0];
    return {
      steamId: optionalString(steamId),
      accessToken: optionalString(accessToken),
      refreshToken: optionalString(refreshToken),
      loginSecure: optionalString(loginSecure)
    };
  } catch {
    return {};
  }
}

export function firstString(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(data[key]);
    if (value) return value;
  }
  return "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
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
