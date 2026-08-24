import * as kdbxweb from "kdbxweb";
import type { LoginItem, SecureCustomField, VaultItem } from "../../core/model";
import {
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

/** Values are read through this rather than `String(value)` so a protected field is not stringified. */
export function keePassFieldText(value: KeePassEntryFieldValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.getText();
}

export function isKeePassFieldProtected(value: KeePassEntryFieldValue | undefined): boolean {
  return value instanceof kdbxweb.ProtectedValue;
}

/** Case-insensitive, first non-blank wins — `getFieldValueIgnoreCase` in Android. */
export function keePassFieldValue(fields: KeePassEntryFields, ...names: string[]): string {
  const byKey = new Map<string, KeePassEntryFieldValue>();
  for (const [name, value] of fields) {
    const key = name.trim().toLowerCase();
    if (!byKey.has(key)) byKey.set(key, value);
  }
  for (const name of names) {
    const text = keePassFieldText(byKey.get(name.trim().toLowerCase())).trim();
    if (text) return text;
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

const MONICA_LOCAL_ID = "MonicaLocalId";
const MONICA_LOGIN_TYPE = "MonicaLoginType";
const MONICA_WIFI_DATA = "MonicaWifiData";
const WIFI_SSID = "SSID";
const SSO_PROVIDER = "SSO Provider";
const MONICA_SSO_REF_ENTRY_ID = "MonicaSsoRefEntryId";
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
  const standard = keePassFieldValue(fields, ...KEEPASS_STANDARD_READ_ALIASES.password);
  if (standard && !isLikelyLabelValue(standard, "Password")) return standard;
  let fallback = standard || "";

  for (const key of ["密码", "口令", "PIN", "pwd", "pass", "password"]) {
    const value = keePassFieldValue(fields, key);
    if (!value) continue;
    if (!isLikelyLabelValue(value, key)) return value;
    if (!fallback) fallback = value;
  }

  for (const [name, value] of fields) {
    if (!isPasswordSecretFallbackCandidateField(name)) continue;
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
  wifiMetadata?: string;
  ssoProvider?: string;
  ssoRefEntryId?: number;
  appPackageName?: string;
  appName?: string;
  email?: string;
  phone?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  sshKeyData?: string;
  customFields: SecureCustomField[];
}

export function readKeePassLoginFields(fields: KeePassEntryFields): KeePassLoginProjection {
  const title = keePassFieldValue(fields, ...KEEPASS_STANDARD_READ_ALIASES.title);
  const monicaLoginType = keePassFieldValue(fields, MONICA_LOGIN_TYPE);
  const wifiJson = keePassFieldValue(fields, MONICA_WIFI_DATA);
  const ssid = keePassFieldValue(fields, WIFI_SSID);
  const ssoProvider = keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.ssoProvider);
  const { loginType, wifiMetadata } = resolveLoginType({ monicaLoginType, wifiJson, ssid, ssoProvider, title });

  return {
    title,
    username: keePassFieldValue(fields, ...KEEPASS_STANDARD_READ_ALIASES.username),
    password: resolveKeePassEntryPassword(fields),
    url: keePassFieldValue(fields, ...KEEPASS_STANDARD_READ_ALIASES.url),
    notes: keePassFieldValue(fields, ...KEEPASS_STANDARD_READ_ALIASES.notes),
    monicaLocalId: optionalInteger(keePassFieldValue(fields, MONICA_LOCAL_ID)),
    loginType,
    wifiMetadata,
    ssoProvider: ssoProvider || undefined,
    ssoRefEntryId: optionalInteger(keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.ssoRefEntryId)),
    appPackageName: keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.appPackageName) || undefined,
    appName: keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.appName) || undefined,
    email: keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.email) || undefined,
    phone: keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.phone) || undefined,
    addressLine: keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.addressLine) || undefined,
    city: keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.city) || undefined,
    state: keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.state) || undefined,
    zipCode: keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.zipCode) || undefined,
    country: keePassFieldValue(fields, ...EXTENDED_READ_ALIASES.country) || undefined,
    sshKeyData: readSshKeyData(fields),
    customFields: readKeePassCustomFields(fields)
  };
}

/**
 * A bare `SSID` field with no `MonicaLoginType` still means Wi-Fi: that is how KeePass2Android's own
 * WLan template writes it, and Android classifies it that way so those entries are not seen as logins.
 */
function resolveLoginType(input: { monicaLoginType: string; wifiJson: string; ssid: string; ssoProvider: string; title: string }) {
  const declared = input.monicaLoginType.toUpperCase();
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
  const algorithm = keePassFieldValue(fields, SSH_FIELDS.algorithm);
  const publicKey = keePassFieldValue(fields, SSH_FIELDS.publicKey);
  const privateKey = keePassFieldValue(fields, SSH_FIELDS.privateKey);
  const fingerprint = keePassFieldValue(fields, SSH_FIELDS.fingerprint);
  const comment = keePassFieldValue(fields, SSH_FIELDS.comment);
  const keySize = optionalInteger(keePassFieldValue(fields, SSH_FIELDS.keySize)) ?? 0;
  if (!algorithm && !publicKey && !privateKey && !fingerprint && !comment && !keySize) return undefined;
  return JSON.stringify({
    algorithm,
    keySize,
    publicKeyOpenSsh: publicKey,
    privateKeyOpenSsh: privateKey,
    fingerprintSha256: fingerprint,
    comment,
    format: keePassFieldValue(fields, SSH_FIELDS.format) || SSH_DEFAULT_FORMAT
  });
}

/** Exactly the unknown-role fields with a non-blank value, matching `extractKeePassCustomFieldsFor…`. */
export function readKeePassCustomFields(fields: KeePassEntryFields): SecureCustomField[] {
  const custom: SecureCustomField[] = [];
  for (const [name, value] of fields) {
    const key = name.trim();
    if (!key || isReservedPasswordProjectionField(key)) continue;
    const text = keePassFieldText(value);
    if (!text) continue;
    custom.push({ name: key, value: text, protected: isKeePassFieldProtected(value) });
  }
  return custom;
}

export interface KeePassLoginWriteInput {
  item: LoginItem;
  /** Android's `MonicaLocalId`; absent for an item the browser created. */
  monicaLocalId?: number;
}

/**
 * `buildEntryFields`. The five standard fields are always emitted; everything else is omitted when
 * blank so a clean entry does not acquire a wall of empty fields in KeePassXC.
 */
export function buildKeePassLoginFields(input: KeePassLoginWriteInput): Map<string, KeePassEntryFieldValue> {
  const { item } = input;
  const fields = new Map<string, KeePassEntryFieldValue>();
  fields.set("Title", item.title);
  fields.set("UserName", item.username);
  fields.set("Password", kdbxweb.ProtectedValue.fromString(item.password));
  fields.set("URL", item.uris[0] ?? "");
  fields.set("Notes", item.notes);
  if (input.monicaLocalId !== undefined && input.monicaLocalId > 0) {
    fields.set(MONICA_LOCAL_ID, String(input.monicaLocalId));
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

  if (item.loginType === "SSO") {
    fields.set(MONICA_LOGIN_TYPE, "SSO");
    plain(SSO_PROVIDER, item.ssoProvider);
    if (item.ssoRefEntryId !== undefined) plain(MONICA_SSO_REF_ENTRY_ID, String(item.ssoRefEntryId));
  }

  if (item.loginType === "WIFI") {
    fields.set(MONICA_LOGIN_TYPE, "WIFI");
    const ssid = wifiSsidOf(item.wifiMetadata) || item.title;
    plain(WIFI_SSID, ssid);
    plain(MONICA_WIFI_DATA, item.wifiMetadata);
  }

  if (item.loginType === "SSH_KEY") fields.set(MONICA_LOGIN_TYPE, "SSH_KEY");
  if (item.loginType === "BARCODE") fields.set(MONICA_LOGIN_TYPE, "BARCODE");
  writeSshFields(fields, item.sshKeyData, plain, secret);
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
    if (!name || !field.value || name.toLowerCase().startsWith("_etm_")) continue;
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
  const removeFieldNames = [
    ...replacementFields.keys(),
    ...(input.item.customFields ?? []).map((field) => field.name.trim())
  ];
  return createKeePassFieldPatch(replacementFields, isPasswordEntryOverlayField, removeFieldNames);
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
    const parsed = JSON.parse(value);
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
