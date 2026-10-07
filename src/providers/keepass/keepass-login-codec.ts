import * as kdbxweb from "kdbxweb";
import { assertPortablePasswordHistory } from '../../core/password-history';
import type { LoginItem, SecureCustomField, VaultItem } from "../../core/model";
import { parseLosslessJson } from "../../core/lossless-json";
import { assertWritableSshKeyData } from "../../core/ssh-key-data";
import { parsePasswordCoverField } from "../../core/password-cover";
import { keePassTotpFieldsFor, parseKeePassTotpFields } from "./keepass-totp-codec";
import {
  KEEPASS_OTP_FIELD_NAMES,
  isKeePassTotpField,
  isMonicaOwnedField,
  isPasswordEntryOverlayField,
  isPasswordSecretFallbackCandidateField,
  isReservedPasswordProjectionField
} from "./keepass-field-registry";
import { createKeePassFieldPatch, type KeePassFieldPatch } from "./keepass-field-patch";

/**
 * Port of the password-entry half of Android `utils/KeePassKdbxService.kt` (SHA 9930d8d8):
 * `buildEntryFields` / `appendPasswordCompatibilityFields` / `appendKeePassCustomFields` on the write
 * side, `analyzePasswordEntry` / `resolveEntryPassword` on the read side.
 *
 * The single rule that matters most: only the five standard fields are written unconditionally. Every
 * other field is omitted when blank rather than written as an empty string, because to another KeePass
 * client an empty string is a value the user typed, while an absent field is a field that was never set.
 */

export type KeePassEntryFieldValue = string | kdbxweb.ProtectedValue;
export type KeePassEntryFields = ReadonlyMap<string, KeePassEntryFieldValue>;

// Extension transport field. Current Android KeePass mapping retains it as a custom field.
const GROUP_COVER_FIELD = "MonicaGroupCover";

/** Values are read through this rather than `String(value)` so a protected field is not stringified. */
export function keePassFieldText(value: KeePassEntryFieldValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.getText();
}

export function isKeePassFieldProtected(value: KeePassEntryFieldValue | undefined): boolean {
  return value instanceof kdbxweb.ProtectedValue;
}

/** Marker/number readers need normalized text; stored login content must stay exact. */
export function keePassFieldValue(fields: KeePassEntryFields, ...names: string[]): string {
  return keePassFieldContent(fields, ...names).trim();
}

/** Keep original text after checking presence, as Android's field resolver does. */
function keePassFieldContent(fields: KeePassEntryFields, ...names: string[]): string {
  const byKey = new Map<string, KeePassEntryFieldValue>();
  for (const [name, value] of fields) {
    const key = name.trim().toLowerCase();
    if (!byKey.has(key)) byKey.set(key, value);
  }
  for (const name of names) {
    const text = keePassFieldText(byKey.get(name.trim().toLowerCase()));
    if (text.trim()) return text;
  }
  return "";
}

export const KEEPASS_STANDARD_READ_ALIASES = {
  title: ["Title", "Name"],
  username: ["UserName", "Username", "User", "Login"],
  password: ["Password", "Pass", "pwd", "密码", "口令"],
  url: ["URL", "Url", "Website", "URI"],
  notes: ["Notes", "Note", "Comment"]
} as const;

const EXTENDED_READ_ALIASES = {
  appPackageName: ["App Package Name", "AppPackageName", "MonicaAppPackageName", "AndroidAppPackageName", "PackageName"],
  appName: ["App Name", "AppName", "MonicaAppName", "Application", "Application Name"],
  email: ["Email", "E-mail", "Mail"],
  phone: ["Phone", "Phone Number", "Telephone"],
  addressLine: ["Address", "Address Line"],
  city: ["City"],
  state: ["State", "Province"],
  zipCode: ["Postal Code", "PostalCode", "Zip Code", "ZipCode"],
  country: ["Country"],
  ssoProvider: ["SSO Provider", "SsoProvider", "MonicaSsoProvider"],
  ssoRefEntryId: ["MonicaSsoRefEntryId", "SsoRefEntryId", "MonicaSsoRefId"]
} as const;

const PASSWORD_METADATA_ALIASES = {
  ...EXTENDED_READ_ALIASES,
  creditCardNumber: ['Card Number', 'CardNumber', 'Credit Card Number', 'CreditCardNumber'],
  creditCardHolder: ['Card Holder', 'CardHolder', 'Credit Card Holder', 'CreditCardHolder'],
  creditCardExpiry: ['Card Expiry', 'CardExpiry', 'Expiration Date', 'Expiry Date'],
  creditCardCVV: ['Card CVV', 'CardCVV', 'CVV', 'CVC']
} as const;
const TEXT_METADATA_KEYS = Object.keys(PASSWORD_METADATA_ALIASES).filter(name => name !== 'ssoRefEntryId' && name !== 'ssoProvider') as Array<Exclude<keyof typeof PASSWORD_METADATA_ALIASES, 'ssoRefEntryId' | 'ssoProvider'>>;
const TEXT_METADATA_NAMES = new Set(TEXT_METADATA_KEYS.flatMap(name => [...PASSWORD_METADATA_ALIASES[name]].map(alias => alias.toLowerCase())));

const MONICA_LOCAL_ID = "MonicaLocalId";
const MONICA_LOGIN_TYPE = "MonicaLoginType";
const MONICA_WIFI_DATA = "MonicaWifiData";
const WIFI_SSID = "SSID";
const SSO_PROVIDER = "SSO Provider";
const MONICA_SSO_REF_ENTRY_ID = "MonicaSsoRefEntryId";
const isSsoReferenceName = (name: string) => EXTENDED_READ_ALIASES.ssoRefEntryId.some(alias => alias.toLowerCase() === name.trim().toLowerCase());
const SSH_FIELDS = {
  algorithm: "MonicaSshAlgorithm",
  keySize: "MonicaSshKeySize",
  publicKey: "MonicaSshPublicKey",
  privateKey: "MonicaSshPrivateKey",
  fingerprint: "MonicaSshFingerprint",
  comment: "MonicaSshComment",
  format: "MonicaSshFormat"
} as const;
const SSH_DEFAULT_FORMAT = "OPENSSH";
const SSH_FIELD_NAMES = new Set(Object.values(SSH_FIELDS).map(name => name.toLowerCase()));

/** Guards against an entry whose `Password` holds the word "password" rather than a password. */
const LABEL_TOKENS = new Set(["password", "pass", "pwd", "pin", "密码", "口令"]);

function isLikelyLabelValue(value: string, key?: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (LABEL_TOKENS.has(normalized)) return true;
  return key !== undefined && normalized === key.trim().toLowerCase();
}

/**
 * `resolveEntryPassword`. The last stage promotes an unknown field to the password, but only a
 * *protected* one: a plain custom field named e.g. "Recovery code" is data, not the password, and
 * promoting it would put the wrong secret in the autofill dropdown.
 */
export function resolveKeePassEntryPassword(fields: KeePassEntryFields): string {
  // An explicitly present Password, including empty and label-like secrets, is authoritative.
  for (const [name, value] of fields) if (name.toLowerCase() === "password") return keePassFieldText(value);
  const standard = keePassFieldContent(fields, ...KEEPASS_STANDARD_READ_ALIASES.password);
  if (standard && !isLikelyLabelValue(standard, "Password")) return standard;
  let fallback = standard || "";

  for (const key of ["密码", "口令", "PIN", "pwd", "pass", "password"]) {
    const value = keePassFieldContent(fields, key);
    if (!value) continue;
    if (!isLikelyLabelValue(value, key)) return value;
    if (!fallback) fallback = value;
  }

  for (const [name, value] of fields) {
    if (!isPasswordSecretFallbackCandidateField(name)) continue;
    if (name === GROUP_COVER_FIELD) continue;
    if (TEXT_METADATA_NAMES.has(name.trim().toLowerCase())) continue;
    if (!isKeePassFieldProtected(value)) continue;
    const content = keePassFieldText(value);
    if (!content) continue;
    if (!isLikelyLabelValue(content, name)) return content;
    if (!fallback) fallback = content;
  }

  return fallback;
}

export interface KeePassLoginProjection {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  monicaLocalId?: number;
  loginType: NonNullable<LoginItem["loginType"]>;
  isGroupCover?: boolean;
  wifiMetadata?: string;
  ssoProvider?: string;
  ssoRefEntryId?: number;
  ssoRefLogicalId?: string;
  appPackageName?: string;
  appName?: string;
  email?: string;
  phone?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  creditCardNumber?: string;
  creditCardHolder?: string;
  creditCardExpiry?: string;
  creditCardCVV?: string;
  sshKeyData?: string;
  customFields: SecureCustomField[];
}

export function readKeePassLoginFields(fields: KeePassEntryFields): KeePassLoginProjection {
  const primary = (name: string, aliases: readonly string[]) => fields.has(name) ? keePassFieldText(fields.get(name)) : keePassFieldContent(fields, ...aliases);
  const title = primary("Title", KEEPASS_STANDARD_READ_ALIASES.title);
  const monicaLoginType = keePassFieldValue(fields, MONICA_LOGIN_TYPE);
  const wifiJson = keePassFieldContent(fields, MONICA_WIFI_DATA);
  const ssid = keePassFieldContent(fields, WIFI_SSID);
  const ssoProvider = keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.ssoProvider);
  const marker = keePassFieldValue(fields, "monica_gpg_type") === "GPG_KEY" ? "GPG_KEY" : keePassFieldValue(fields, "monica_api_key_type") === "API_KEY" ? "API_KEY" : monicaLoginType;
  const { loginType, wifiMetadata } = resolveLoginType({ monicaLoginType: marker, wifiJson, ssid, ssoProvider, title });

  return {
    title,
    username: primary("UserName", KEEPASS_STANDARD_READ_ALIASES.username),
    password: resolveKeePassEntryPassword(fields),
    url: primary("URL", KEEPASS_STANDARD_READ_ALIASES.url),
    notes: primary("Notes", KEEPASS_STANDARD_READ_ALIASES.notes),
    monicaLocalId: optionalInteger(keePassFieldValue(fields, MONICA_LOCAL_ID)),
    loginType,
    isGroupCover: parsePasswordCoverField(keePassFieldText(fields.get(GROUP_COVER_FIELD))),
    wifiMetadata,
    ssoProvider: ssoProvider || undefined,
    ssoRefEntryId: optionalInteger(keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.ssoRefEntryId)),
    ssoRefLogicalId: keePassFieldValue(fields, "MonicaSsoRefLogicalId") || undefined,
    appPackageName: keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.appPackageName) || undefined,
    appName: keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.appName) || undefined,
    email: keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.email) || undefined,
    phone: keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.phone) || undefined,
    addressLine: keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.addressLine) || undefined,
    city: keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.city) || undefined,
    state: keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.state) || undefined,
    zipCode: keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.zipCode) || undefined,
    country: keePassFieldContent(fields, ...EXTENDED_READ_ALIASES.country) || undefined,
    creditCardNumber: keePassFieldContent(fields, "Card Number", "CardNumber", "Credit Card Number", "CreditCardNumber") || undefined,
    creditCardHolder: keePassFieldContent(fields, "Card Holder", "CardHolder", "Credit Card Holder", "CreditCardHolder") || undefined,
    creditCardExpiry: keePassFieldContent(fields, "Card Expiry", "CardExpiry", "Expiration Date", "Expiry Date") || undefined,
    creditCardCVV: keePassFieldContent(fields, "Card CVV", "CardCVV", "CVV", "CVC") || undefined,
    sshKeyData: readSshKeyData(fields),
    customFields: readKeePassCustomFields(fields)
  };
}

/**
 * A bare `SSID` field with no `MonicaLoginType` still means Wi-Fi: that is how KeePass2Android's own
 * WLan template writes it, and Android classifies it that way so those entries are not seen as logins.
 */
function resolveLoginType(input: { monicaLoginType: string; wifiJson: string; ssid: string; ssoProvider: string; title: string }): { loginType: NonNullable<LoginItem["loginType"]>; wifiMetadata?: string } {
  const declared = input.monicaLoginType.toUpperCase();
  if (declared === "GPG_KEY" || declared === "API_KEY") return { loginType: declared, wifiMetadata: undefined };
  if (declared === "WIFI" && input.wifiJson) return { loginType: "WIFI" as const, wifiMetadata: input.wifiJson };
  if (declared === "WIFI") return { loginType: "WIFI" as const, wifiMetadata: wifiJsonFor(input.ssid || input.title) };
  if (input.ssid) return { loginType: "WIFI" as const, wifiMetadata: wifiJsonFor(input.ssid) };
  if (declared === "SSO" || input.ssoProvider) return { loginType: "SSO" as const, wifiMetadata: undefined };
  if (declared === "SSH_KEY") return { loginType: "SSH_KEY" as const, wifiMetadata: undefined };
  if (declared === "BARCODE") return { loginType: "BARCODE" as const, wifiMetadata: undefined };
  return { loginType: "PASSWORD" as const, wifiMetadata: undefined };
}

function wifiJsonFor(ssid: string): string {
  return JSON.stringify({ ssid });
}

function readSshKeyData(fields: KeePassEntryFields): string | undefined {
  const algorithm = keePassFieldContent(fields, SSH_FIELDS.algorithm);
  const publicKey = keePassFieldContent(fields, SSH_FIELDS.publicKey);
  const privateKey = keePassFieldContent(fields, SSH_FIELDS.privateKey);
  const fingerprint = keePassFieldContent(fields, SSH_FIELDS.fingerprint);
  const comment = keePassFieldContent(fields, SSH_FIELDS.comment);
  const parsedSize = optionalInteger(keePassFieldValue(fields, SSH_FIELDS.keySize));
  const keySize = parsedSize !== undefined && parsedSize >= 0 ? parsedSize : 0;
  if (![...fields.keys()].some(name => SSH_FIELD_NAMES.has(name.trim().toLowerCase()))) return undefined;
  return JSON.stringify({
    algorithm,
    keySize,
    publicKeyOpenSsh: publicKey,
    privateKeyOpenSsh: privateKey,
    fingerprintSha256: fingerprint,
    comment,
    format: keePassFieldContent(fields, SSH_FIELDS.format) || SSH_DEFAULT_FORMAT
  });
}

/** Exactly the unknown-role fields with a non-blank value, matching `extractKeePassCustomFieldsFor…`. */
export function readKeePassCustomFields(fields: KeePassEntryFields): SecureCustomField[] {
  const custom: SecureCustomField[] = [];
  for (const [name, value] of fields) {
    const key = name.trim();
    if (!key || isReservedPasswordProjectionField(key) || TEXT_METADATA_NAMES.has(key.toLowerCase())) continue;
    const text = keePassFieldText(value);
    if (key === GROUP_COVER_FIELD && parsePasswordCoverField(text) !== undefined) continue;
    if (isSsoReferenceName(key) && optionalInteger(text) !== undefined) continue;
    custom.push({ name: key, value: text, protected: isKeePassFieldProtected(value) });
  }
  return custom;
}

export interface KeePassLoginWriteInput {
  item: LoginItem;
  existingFields?: KeePassEntryFields;
  preserveOtpFields?: boolean;
  /** Android's `MonicaLocalId`; absent for an item the browser created. */
  monicaLocalId?: number;
}

/**
 * `buildEntryFields`. The five standard fields are always emitted; everything else is omitted when
 * blank so a clean entry does not acquire a wall of empty fields in KeePassXC.
 */
export function buildKeePassLoginFields(input: KeePassLoginWriteInput): Map<string, KeePassEntryFieldValue> {
  assertPortablePasswordHistory(input.item);
  const { item } = input;
  assertWritableSshKeyData(item.sshKeyData);
  const fields = new Map<string, KeePassEntryFieldValue>();
  fields.set("Title", item.title);
  fields.set("UserName", item.username);
  fields.set("Password", kdbxweb.ProtectedValue.fromString(item.password));
  fields.set("URL", item.uris.join("\n"));
  fields.set("Notes", item.notes);
  if (input.monicaLocalId !== undefined && input.monicaLocalId > 0) {
    fields.set(MONICA_LOCAL_ID, String(input.monicaLocalId));
  } else if (input.existingFields?.has(MONICA_LOCAL_ID)) {
    fields.set(MONICA_LOCAL_ID, input.existingFields.get(MONICA_LOCAL_ID)!);
  }

  const plain = (name: string, value: string | undefined) => {
    if (value?.trim()) fields.set(name, value);
  };
  const secret = (name: string, value: string | undefined) => {
    if (value?.trim()) fields.set(name, kdbxweb.ProtectedValue.fromString(value));
  };

  plain("App Package Name", item.appPackageName);
  plain("App Name", item.appName);
  plain("Email", item.email);
  plain("Phone", item.phone);
  plain("Address", item.addressLine);
  plain("City", item.city);
  plain("State", item.state);
  plain("Postal Code", item.zipCode);
  plain("Country", item.country);
  secret("Card Number", item.creditCardNumber);
  plain("Card Holder", item.creditCardHolder);
  plain("Card Expiry", item.creditCardExpiry);
  secret("Card CVV", item.creditCardCVV);

  if (item.loginType === "SSO") {
    fields.set(MONICA_LOGIN_TYPE, "SSO");
    plain(SSO_PROVIDER, item.ssoProvider);
    if (item.ssoRefEntryId !== undefined) plain(MONICA_SSO_REF_ENTRY_ID, String(item.ssoRefEntryId));
    plain("MonicaSsoRefLogicalId", item.ssoRefLogicalId);
  }

  if (item.loginType === "WIFI") {
    fields.set(MONICA_LOGIN_TYPE, "WIFI");
    const ssid = wifiSsidOf(item.wifiMetadata) || item.title;
    plain(WIFI_SSID, ssid);
    plain(MONICA_WIFI_DATA, item.wifiMetadata);
  }

  if (item.loginType === "SSH_KEY") fields.set(MONICA_LOGIN_TYPE, "SSH_KEY");
  if (item.loginType === "BARCODE") fields.set(MONICA_LOGIN_TYPE, "BARCODE");
  // A valid existing marker is a custom field: append it in the user's order
  // with its original protection instead of preempting it with a plain value.
  if (item.loginType === "GPG_KEY" && !item.customFields?.some(field => field.name === "monica_gpg_type" && field.value === "GPG_KEY")) fields.set("monica_gpg_type", "GPG_KEY");
  if (item.loginType === "API_KEY" && !item.customFields?.some(field => field.name === "monica_api_key_type" && field.value === "API_KEY")) fields.set("monica_api_key_type", "API_KEY");
  if (item.totpSecret && !input.preserveOtpFields) {
    const otp = parseKeePassTotpFields({ otp: item.totpSecret, issuer: item.title, accountName: item.username });
    if (!otp) throw new Error("OTP 格式无法安全写入 KeePass，原条目保持不变。");
    for (const [name, value] of Object.entries(keePassTotpFieldsFor(otp, item.title))) {
      fields.set(name, name === "otp" || name === "TOTP Seed" || /^(TimeOtp|HmacOtp)-Secret/.test(name) ? kdbxweb.ProtectedValue.fromString(value) : value);
    }
    // A source URI may carry future parameters; the internal carrier stays exact.
    if (item.totpSecret.includes("://")) fields.set("otp", kdbxweb.ProtectedValue.fromString(item.totpSecret));
  }
  writeSshFields(fields, item.sshKeyData, plain, secret);
  if (item.isGroupCover !== undefined) {
    const original = input.existingFields?.get(GROUP_COVER_FIELD);
    if (original !== undefined && parsePasswordCoverField(keePassFieldText(original)) === undefined
      || item.customFields.some(field => field.name.trim() === GROUP_COVER_FIELD && parsePasswordCoverField(field.value) === undefined)) {
      throw new Error("封面字段版本未知，无法安全修改。请保留原始数据。");
    }
    fields.set(GROUP_COVER_FIELD, String(item.isGroupCover));
  }
  appendCustomFields(fields, item.customFields);
  return fields;
}

function writeSshFields(
  fields: Map<string, KeePassEntryFieldValue>,
  sshKeyData: string | undefined,
  plain: (name: string, value: string | undefined) => void,
  secret: (name: string, value: string | undefined) => void
): void {
  const ssh = parseJsonObject(sshKeyData);
  if (!ssh) return;
  plain(SSH_FIELDS.algorithm, stringOf(ssh.algorithm));
  const keySize = Number(ssh.keySize);
  if (Number.isSafeInteger(keySize) && keySize > 0) fields.set(SSH_FIELDS.keySize, String(keySize));
  plain(SSH_FIELDS.publicKey, stringOf(ssh.publicKeyOpenSsh));
  secret(SSH_FIELDS.privateKey, stringOf(ssh.privateKeyOpenSsh));
  plain(SSH_FIELDS.fingerprint, stringOf(ssh.fingerprintSha256));
  plain(SSH_FIELDS.comment, stringOf(ssh.comment));
  plain(SSH_FIELDS.format, stringOf(ssh.format));
}

/** Skips blanks, `_etm_` plugin fields and names already used, case-insensitively, as Android does. */
function appendCustomFields(fields: Map<string, KeePassEntryFieldValue>, customFields: SecureCustomField[] | undefined): void {
  const used = new Set([...fields.keys()].map((name) => name.trim().toLowerCase()));
  for (const field of customFields ?? []) {
    const name = field.name.trim();
    if (SSH_FIELD_NAMES.has(name.toLowerCase())) continue;
    if (TEXT_METADATA_NAMES.has(name.toLowerCase())) continue;
    if (isSsoReferenceName(name) && optionalInteger(field.value) !== undefined) continue;
    if (name === GROUP_COVER_FIELD && parsePasswordCoverField(field.value) !== undefined) continue;
    if (!name || name.toLowerCase().startsWith("_etm_")) continue;
    if (used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    fields.set(name, field.protected ? kdbxweb.ProtectedValue.fromString(field.value) : field.value);
  }
}

/**
 * `buildPasswordEntryFieldPatch`. Custom-field titles go into `removeFieldNames` even when their value
 * is now blank, which is what makes clearing a custom field delete it rather than leave an empty one.
 */
export function buildKeePassLoginPatch(input: KeePassLoginWriteInput): KeePassFieldPatch<KeePassEntryFieldValue> {
  const replacementFields = buildKeePassLoginFields(input);
  const originalCover = input.existingFields?.get(GROUP_COVER_FIELD);
  const previousCover = parsePasswordCoverField(keePassFieldText(originalCover));
  const coverRemovals = previousCover !== undefined ? [GROUP_COVER_FIELD] : [];
  // Older encrypted snapshots predate this projection. Only explicit model edits clear it.
  if (originalCover !== undefined && !Object.prototype.hasOwnProperty.call(input.item, "isGroupCover")) {
    replacementFields.set(GROUP_COVER_FIELD, originalCover);
  }
  if (originalCover !== undefined && previousCover !== undefined && input.item.isGroupCover !== undefined) {
    replacementFields.set(GROUP_COVER_FIELD, previousCover === input.item.isGroupCover ? originalCover
      : isKeePassFieldProtected(originalCover) ? kdbxweb.ProtectedValue.fromString(String(input.item.isGroupCover)) : String(input.item.isGroupCover));
  }
  const sshRemovals: string[] = [];
  if (input.existingFields) {
    const previous = parseJsonObject(readSshKeyData(input.existingFields));
    const current = parseJsonObject(input.item.sshKeyData);
    const properties = { algorithm: 'algorithm', keySize: 'keySize', publicKey: 'publicKeyOpenSsh', privateKey: 'privateKeyOpenSsh', fingerprint: 'fingerprintSha256', comment: 'comment', format: 'format' } as const;
    for (const [key, name] of Object.entries(SSH_FIELDS) as Array<[keyof typeof SSH_FIELDS, string]>) {
      const originals = [...input.existingFields].filter(([original]) => original.trim().toLowerCase() === name.toLowerCase());
      const value = replacementFields.get(name);
      const unchanged = current && previous && current[properties[key]] === previous[properties[key]];
      if (unchanged && originals.length) replacementFields.delete(name);
      for (const [original, raw] of originals) {
        const size = key === 'keySize' ? optionalInteger(keePassFieldText(raw)) : undefined;
        const unknownSize = key === 'keySize' && (size === undefined || size < 0);
        sshRemovals.push(original);
        if (unchanged || unknownSize && value === undefined) replacementFields.set(original, key === 'privateKey' && !isKeePassFieldProtected(raw) ? kdbxweb.ProtectedValue.fromString(keePassFieldText(raw)) : raw);
        else if (value !== undefined) {
          const protectedValue = isKeePassFieldProtected(value) || originals.some(([, old]) => isKeePassFieldProtected(old));
          const replacement = protectedValue ? kdbxweb.ProtectedValue.fromString(keePassFieldText(value)) : value;
          replacementFields.set(name, replacement);
          replacementFields.set(original, replacement);
        }
      }
    }
  }
  const metadataRemovals: string[] = [];
  if (input.existingFields) {
    for (const property of TEXT_METADATA_KEYS) {
      const aliases = PASSWORD_METADATA_ALIASES[property];
      const names = new Set(aliases.map(name => name.toLowerCase()));
      const originals = [...input.existingFields].filter(([name]) => names.has(name.trim().toLowerCase()));
      metadataRemovals.push(...originals.map(([name]) => name));
      const unchanged = keePassFieldContent(input.existingFields, ...aliases) === (input.item[property] || '');
      const current = replacementFields.get(aliases[0]);
      if (unchanged && originals.length) {
        replacementFields.delete(aliases[0]);
        for (const [name, value] of originals) replacementFields.set(name, value);
      } else if (current !== undefined && originals.length) {
        const hidden = isKeePassFieldProtected(current) || originals.some(([, value]) => isKeePassFieldProtected(value));
        const value = hidden ? kdbxweb.ProtectedValue.fromString(keePassFieldText(current)) : current;
        replacementFields.set(aliases[0], value);
        for (const [name] of originals) replacementFields.set(name, value);
      }
    }
  }
  const referenceFields = [...input.existingFields ?? []].filter(([name]) => isSsoReferenceName(name));
  const previousReference = input.existingFields ? optionalInteger(keePassFieldValue(input.existingFields, ...EXTENDED_READ_ALIASES.ssoRefEntryId)) : undefined;
  const unchangedReference = input.item.loginType === "SSO" && previousReference !== undefined && previousReference === input.item.ssoRefEntryId;
  if (unchangedReference) replacementFields.delete(MONICA_SSO_REF_ENTRY_ID);
  for (const [name, value] of referenceFields) {
    // Keep legacy spelling/protection on unrelated edits. Unknown numeric data
    // is not an editable relation and must survive the managed-field cleanup.
    if (unchangedReference || optionalInteger(keePassFieldText(value)) === undefined && !replacementFields.has(name)) replacementFields.set(name, value);
  }
  const removeFieldNames = [
    ...coverRemovals,
    ...sshRemovals,
    ...metadataRemovals,
    ...referenceFields.filter(([, value]) => optionalInteger(keePassFieldText(value)) !== undefined).map(([name]) => name),
    ...replacementFields.keys(),
    ...(!input.preserveOtpFields && input.item.totpSecret !== undefined ? KEEPASS_OTP_FIELD_NAMES : []),
    ...(input.item.customFields ?? []).map((field) => field.name.trim()),
    ...(input.existingFields ? readKeePassCustomFields(input.existingFields).map((field) => field.name) : [])
  ];
  return createKeePassFieldPatch(replacementFields, (name) => isPasswordEntryOverlayField(name) || Boolean(!input.preserveOtpFields && input.item.totpSecret && isKeePassTotpField(name)), removeFieldNames);
}

/**
 * `isEnhancedEntryTemplate`. A KeePass2Android template entry looks like an entry with a title and
 * nothing else; importing it would create a junk login named "Credit Card" in the user's vault.
 */
export function isKeePassTemplateEntry(fields: KeePassEntryFields): boolean {
  const template = keePassFieldValue(fields, "_etm_template");
  if (!template || template === "0" || template.toLowerCase() === "false") return false;
  if (!keePassFieldValue(fields, ...KEEPASS_STANDARD_READ_ALIASES.title)) return false;
  for (const alias of ["username", "password", "url", "notes"] as const) {
    if (keePassFieldValue(fields, ...KEEPASS_STANDARD_READ_ALIASES[alias])) return false;
  }
  for (const [name, value] of fields) {
    if (name.trim().toLowerCase().startsWith("_etm_")) continue;
    if (isReservedPasswordProjectionField(name)) continue;
    if (keePassFieldText(value).trim()) return false;
  }
  return true;
}

export function isKeePassEmptyEntry(fields: KeePassEntryFields): boolean {
  return (Object.keys(KEEPASS_STANDARD_READ_ALIASES) as (keyof typeof KEEPASS_STANDARD_READ_ALIASES)[]).every(
    (alias) => !keePassFieldValue(fields, ...KEEPASS_STANDARD_READ_ALIASES[alias])
  );
}

export function keePassEntryHasTotpFields(fields: KeePassEntryFields): boolean {
  for (const [name, value] of fields) {
    if (isKeePassTotpField(name) && keePassFieldText(value).trim()) return true;
  }
  return false;
}

/** Fields a browser edit must leave alone: everything the registry does not consider Monica-owned. */
export function keePassPreservedFieldNames(fields: KeePassEntryFields): string[] {
  return [...fields.keys()].filter((name) => !isMonicaOwnedField(name));
}

export function isKeePassLoginItem(item: VaultItem): item is LoginItem {
  return item.kind === "login";
}

function wifiSsidOf(wifiMetadata: string | undefined): string {
  const parsed = parseJsonObject(wifiMetadata);
  return parsed ? stringOf(parsed.ssid) : "";
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = parseLosslessJson(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalInteger(value: string): number | undefined {
  if (!/^[+-]?\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
