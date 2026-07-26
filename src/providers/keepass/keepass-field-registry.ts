/**
 * 1:1 port of Android `keepass/KeePassFieldRegistry.kt` (SHA 9930d8d8).
 *
 * The classification here decides which entry fields Monica may overwrite and which must survive a
 * write-back untouched. Diverging from Android would silently delete another client's data, so every
 * name below is copied verbatim rather than derived.
 */

export type KeePassFieldRole =
  | "standard"
  | "monica-password"
  | "monica-secure-item"
  | "monica-passkey"
  | "keepass-totp"
  | "keepass-passkey"
  | "keepass-plugin"
  | "unknown";

/** `KeePassDxPasskeyCodec.kt:12-19`. KeePassDX's own passkey field names. */
export const KEEPASSDX_PASSKEY_FIELDS = {
  username: "KPEX_PASSKEY_USERNAME",
  privateKey: "KPEX_PASSKEY_PRIVATE_KEY_PEM",
  credentialId: "KPEX_PASSKEY_CREDENTIAL_ID",
  userHandle: "KPEX_PASSKEY_USER_HANDLE",
  relyingParty: "KPEX_PASSKEY_RELYING_PARTY",
  flagBe: "KPEX_PASSKEY_FLAG_BE",
  flagBs: "KPEX_PASSKEY_FLAG_BS",
  passkey: "Passkey"
} as const;

const PASSKEY_FIELD_NAMES = Object.values(KEEPASSDX_PASSKEY_FIELDS);

const passwordEntryOverlayFields = [
  "Title", "UserName", "Password", "URL", "Notes",
  "MonicaLocalId",
  "MonicaConflictCopy",
  "App Package Name", "App Name",
  "Email", "Phone",
  "Address", "City", "State", "Postal Code", "Country",
  "Card Number", "Card Holder", "Card Expiry", "Card CVV",
  "SSO Provider", "MonicaSsoRefEntryId",
  "MonicaLoginType", "SSID", "MonicaWifiData",
  "MonicaSshAlgorithm", "MonicaSshKeySize", "MonicaSshPublicKey",
  "MonicaSshPrivateKey", "MonicaSshFingerprint", "MonicaSshComment", "MonicaSshFormat"
];

const secureItemOverlayFields = [
  "Title", "UserName", "Password", "URL", "Notes",
  "MonicaSecureItemId",
  "MonicaConflictCopy",
  "MonicaItemType",
  "MonicaItemData",
  "MonicaImagePaths",
  "MonicaIsFavorite",
  "Card Number", "CardNumber", "Credit Card Number", "CreditCardNumber",
  "Card Holder", "CardHolder", "Credit Card Holder", "CreditCardHolder",
  "Card Expiry", "CardExpiry", "Expiration Date", "Expiry Date",
  "Card CVV", "CardCVV", "CVV", "CVC",
  "Expiry Month", "Expiry Year",
  "Bank Name",
  "Card Type",
  "Billing Address",
  "Brand",
  "Nickname",
  "Valid From Month",
  "Valid From Year",
  "PIN",
  "IBAN",
  "SWIFT/BIC",
  "Routing Number",
  "Account Number",
  "Branch Code",
  "Currency",
  "Customer Service Phone"
];

const passkeyEntryOverlayFields = [
  "Title", "UserName", "Password", "URL", "Notes",
  "MonicaConflictCopy",
  "MonicaPasskeyCredentialId",
  "MonicaPasskeyData",
  "MonicaPasskeyMode",
  ...PASSKEY_FIELD_NAMES
];

const standardFields = [
  "Title", "Name",
  "UserName", "Username", "User", "Login",
  "Password", "Pass", "pass", "pwd", "PWD", "密码", "口令",
  "URL", "Url", "Website", "URI",
  "Notes", "Note", "Comment"
];

const monicaPasswordFields = [
  "MonicaLocalId",
  "MonicaConflictCopy",
  "App Package Name", "AppPackageName", "MonicaAppPackageName",
  "App Name", "AppName", "MonicaAppName",
  "Email", "E-mail", "Mail",
  "Phone", "Phone Number", "Telephone",
  "Address", "Address Line",
  "City", "State", "Province", "Postal Code", "PostalCode", "Zip Code", "ZipCode", "Country",
  "Card Number", "CardNumber", "Credit Card Number", "CreditCardNumber",
  "Card Holder", "CardHolder", "Credit Card Holder", "CreditCardHolder",
  "Card Expiry", "CardExpiry", "Expiration Date", "Expiry Date",
  "Card CVV", "CardCVV", "CVV", "CVC",
  "Expiry Month", "Expiry Year",
  "SSO Provider", "SsoProvider", "MonicaSsoProvider", "MonicaSsoRefEntryId",
  "SSID", "MonicaWifiData", "MonicaLoginType",
  "MonicaSshAlgorithm", "MonicaSshKeySize", "MonicaSshPublicKey",
  "MonicaSshPrivateKey", "MonicaSshFingerprint", "MonicaSshComment", "MonicaSshFormat"
];

const monicaSecureItemFields = [
  "MonicaSecureItemId",
  "MonicaConflictCopy",
  "MonicaItemType",
  "MonicaItemData",
  "MonicaImagePaths",
  "MonicaIsFavorite",
  "Bank Name",
  "Card Type",
  "Billing Address",
  "Brand",
  "Nickname",
  "Valid From Month",
  "Valid From Year",
  "PIN",
  "IBAN",
  "SWIFT/BIC",
  "Routing Number",
  "Account Number",
  "Branch Code",
  "Currency",
  "Customer Service Phone"
];

const monicaPasskeyFields = [
  "MonicaPasskeyCredentialId",
  "MonicaPasskeyData",
  "MonicaPasskeyMode",
  "MonicaConflictCopy"
];

const keepassTotpFields = [
  "otp",
  "TOTP Seed",
  "TOTPSeed",
  "TOTP Settings",
  "TOTPSettings",
  "TOTP Period",
  "TOTP Digits",
  "TOTP Algorithm",
  "OTP Type",
  "TOTP Type",
  "HOTP Counter"
];

/** `name.trim().lowercase(Locale.ROOT)`. `toLowerCase` is already locale-invariant in JS. */
export function normalizeKeePassFieldName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeKeePassFieldName));
}

const standardFieldKeys = normalizedSet(standardFields);
const monicaPasswordFieldKeys = normalizedSet(monicaPasswordFields);
const monicaSecureItemFieldKeys = normalizedSet(monicaSecureItemFields);
const monicaPasskeyFieldKeys = normalizedSet(monicaPasskeyFields);
const keepassTotpFieldKeys = normalizedSet(keepassTotpFields);
const keepassPasskeyFieldKeys = normalizedSet(PASSKEY_FIELD_NAMES);
const passwordEntryOverlayFieldKeys = normalizedSet(passwordEntryOverlayFields);
const secureItemOverlayFieldKeys = normalizedSet(secureItemOverlayFields);
const passkeyEntryOverlayFieldKeys = normalizedSet(passkeyEntryOverlayFields);

/** Order matters: the first matching set wins, exactly as in the Kotlin `when` block. */
export function keePassFieldRoleOf(name: string): KeePassFieldRole {
  const key = normalizeKeePassFieldName(name);
  if (!key) return "unknown";
  if (key.startsWith("_etm_")) return "keepass-plugin";
  if (standardFieldKeys.has(key)) return "standard";
  if (monicaPasswordFieldKeys.has(key)) return "monica-password";
  if (monicaSecureItemFieldKeys.has(key)) return "monica-secure-item";
  if (monicaPasskeyFieldKeys.has(key)) return "monica-passkey";
  if (keepassTotpFieldKeys.has(key)) return "keepass-totp";
  if (keepassPasskeyFieldKeys.has(key)) return "keepass-passkey";
  return "unknown";
}

export function isMonicaOwnedField(name: string): boolean {
  const role = keePassFieldRoleOf(name);
  return role === "monica-password" || role === "monica-secure-item" || role === "monica-passkey";
}

/**
 * Everything Monica does not own is preserved, including standard fields, TOTP fields, KeePassDX
 * passkey fields, `_etm_*` plugin state and any field this build has never heard of.
 */
export function isPreservedByDefault(name: string): boolean {
  return !isMonicaOwnedField(name);
}

export function isReservedPasswordProjectionField(name: string): boolean {
  return keePassFieldRoleOf(name) !== "unknown";
}

export function isPasswordEntryOverlayField(name: string): boolean {
  const key = normalizeKeePassFieldName(name);
  return key !== "" && passwordEntryOverlayFieldKeys.has(key);
}

export function isSecureItemOverlayField(name: string): boolean {
  const key = normalizeKeePassFieldName(name);
  return key !== "" && secureItemOverlayFieldKeys.has(key);
}

export function isPasskeyEntryOverlayField(name: string): boolean {
  const key = normalizeKeePassFieldName(name);
  return key !== "" && passkeyEntryOverlayFieldKeys.has(key);
}

export function isKeePassTotpField(name: string): boolean {
  return keePassFieldRoleOf(name) === "keepass-totp";
}

/** Only a field nobody claims may be promoted to the login secret when `Password` is empty. */
export function isPasswordSecretFallbackCandidateField(name: string): boolean {
  return keePassFieldRoleOf(name) === "unknown";
}
