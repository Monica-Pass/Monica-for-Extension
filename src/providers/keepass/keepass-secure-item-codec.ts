import * as kdbxweb from "kdbxweb";
import type { CardItem, SecureCustomField, TotpItem, VaultItem } from "../../core/model";
import {
  monicaItemDataToVaultItem,
  monicaItemTypeForKind,
  monicaItemTypeOf,
  parseMonicaItemData,
  serializeSecureCustomFields,
  vaultItemToMonicaItemData,
  type MonicaItemBase,
  type MonicaItemType
} from "../monica-item-data";
import { isKeePassTotpField, isSecureItemOverlayField } from "./keepass-field-registry";
import { createKeePassFieldPatch, type KeePassFieldPatch } from "./keepass-field-patch";
import {
  isKeePassFieldProtected,
  keePassFieldText,
  keePassFieldValue,
  type KeePassEntryFields,
  type KeePassEntryFieldValue
} from "./keepass-login-codec";
import { keePassTotpFieldsFor, parseKeePassTotpFields, KEEPASS_TOTP_FIELDS, type KeePassTotpData } from "./keepass-totp-codec";

/**
 * Port of the secure-item half of Android `utils/KeePassKdbxService.kt` (SHA 9930d8d8):
 * `buildSecureItemFields` / `appendBankCardFields` / `appendKeePassTotpFields` /
 * `appendSecureItemCustomFields` on the write side, `entryToSecureItemData` /
 * `buildBankCardItemDataFromEntry` / `extractStructuredSecureItemCustomFields` on the read side.
 *
 * A secure item travels as one encrypted `MonicaItemData` field, with two exceptions Android makes and
 * this port keeps: a bank card is written as discrete labelled fields *instead of* `MonicaItemData` so
 * KeePassXC shows a usable card, and a TOTP item additionally gets the standard KeePass TOTP fields so
 * other clients can generate codes.
 */

export const KEEPASS_SECURE_ITEM_FIELDS = {
  id: "MonicaSecureItemId",
  itemType: "MonicaItemType",
  itemData: "MonicaItemData",
  imagePaths: "MonicaImagePaths",
  isFavorite: "MonicaIsFavorite"
} as const;

const CARD_FIELDS = {
  number: "Card Number",
  holder: "Card Holder",
  expiry: "Card Expiry",
  cvv: "Card CVV",
  expiryMonth: "Expiry Month",
  expiryYear: "Expiry Year",
  bankName: "Bank Name",
  cardType: "Card Type",
  billingAddress: "Billing Address",
  brand: "Brand",
  nickname: "Nickname",
  validFromMonth: "Valid From Month",
  validFromYear: "Valid From Year",
  pin: "PIN",
  iban: "IBAN",
  swiftBic: "SWIFT/BIC",
  routingNumber: "Routing Number",
  accountNumber: "Account Number",
  branchCode: "Branch Code",
  currency: "Currency",
  customerServicePhone: "Customer Service Phone"
} as const;

const CARD_READ_ALIASES = {
  number: [CARD_FIELDS.number, "CardNumber", "Credit Card Number", "CreditCardNumber"],
  holder: [CARD_FIELDS.holder, "CardHolder", "Credit Card Holder", "CreditCardHolder"],
  expiry: [CARD_FIELDS.expiry, "CardExpiry", "Expiration Date", "Expiry Date"],
  cvv: [CARD_FIELDS.cvv, "CardCVV", "CVV", "CVC"]
} as const;

/** `baseSecureItemFieldNames()`, verbatim. */
const BASE_SECURE_ITEM_FIELD_NAMES = [
  "Title",
  "UserName",
  "Password",
  "URL",
  "Notes",
  KEEPASS_SECURE_ITEM_FIELDS.itemType,
  KEEPASS_SECURE_ITEM_FIELDS.itemData,
  KEEPASS_SECURE_ITEM_FIELDS.imagePaths,
  KEEPASS_SECURE_ITEM_FIELDS.isFavorite,
  KEEPASS_SECURE_ITEM_FIELDS.id
];

/** `bankCardSecureItemFieldNames()`, verbatim: every alias, not just the ones Monica writes. */
const BANK_CARD_SECURE_ITEM_FIELD_NAMES = [
  ...CARD_READ_ALIASES.number,
  ...CARD_READ_ALIASES.holder,
  ...CARD_READ_ALIASES.expiry,
  ...CARD_READ_ALIASES.cvv,
  CARD_FIELDS.expiryMonth,
  CARD_FIELDS.expiryYear,
  CARD_FIELDS.bankName,
  CARD_FIELDS.cardType,
  CARD_FIELDS.billingAddress,
  CARD_FIELDS.brand,
  CARD_FIELDS.nickname,
  CARD_FIELDS.validFromMonth,
  CARD_FIELDS.validFromYear,
  CARD_FIELDS.pin,
  CARD_FIELDS.iban,
  CARD_FIELDS.swiftBic,
  CARD_FIELDS.routingNumber,
  CARD_FIELDS.accountNumber,
  CARD_FIELDS.branchCode,
  CARD_FIELDS.currency,
  CARD_FIELDS.customerServicePhone
];

const RESERVED_CARD_FIELD_KEYS = new Set(
  [...BASE_SECURE_ITEM_FIELD_NAMES, ...BANK_CARD_SECURE_ITEM_FIELD_NAMES].map((name) => name.toLowerCase())
);

export interface KeePassSecureItemProjection {
  itemType: MonicaItemType;
  /** The decoded `MonicaItemData`; for a bank card, reconstructed from the discrete fields. */
  itemData: Record<string, unknown>;
  title: string;
  notes: string;
  imagePaths: string[];
  isFavorite: boolean;
  /** Android's row id, present only on an entry Android itself wrote. */
  monicaSecureItemId?: number;
}

/** An entry carrying `MonicaItemType` is a secure item, so the password sync must skip it. */
export function isKeePassSecureItemEntry(fields: KeePassEntryFields): boolean {
  return Boolean(keePassFieldValue(fields, KEEPASS_SECURE_ITEM_FIELDS.itemType));
}

/**
 * `entryToSecureItemData`. Returns undefined for anything that is not a secure item, including an
 * entry whose `MonicaItemType` this build does not recognise: Android's `ItemType.valueOf` throws
 * there and the entry is skipped rather than coerced into the nearest known type.
 */
export function readKeePassSecureItemFields(fields: KeePassEntryFields): KeePassSecureItemProjection | undefined {
  const title = keePassFieldValue(fields, "Title");
  const notes = keePassFieldValue(fields, "Notes");
  const monicaSecureItemId = optionalInteger(keePassFieldValue(fields, KEEPASS_SECURE_ITEM_FIELDS.id));
  const typeRaw = keePassFieldValue(fields, KEEPASS_SECURE_ITEM_FIELDS.itemType);

  if (typeRaw) {
    const itemType = monicaItemTypeOf(typeRaw);
    if (!itemType) return undefined;
    const stored = keePassFieldValue(fields, KEEPASS_SECURE_ITEM_FIELDS.itemData);
    const itemData = stored ? parseMonicaItemData(stored) : reconstructSecureItemData(itemType, fields);
    if (!itemData) return undefined;
    return {
      itemType,
      itemData,
      title: title || "Untitled",
      notes,
      imagePaths: decodeImagePaths(keePassFieldValue(fields, KEEPASS_SECURE_ITEM_FIELDS.imagePaths)),
      isFavorite: keePassFieldValue(fields, KEEPASS_SECURE_ITEM_FIELDS.isFavorite).toLowerCase() === "true",
      monicaSecureItemId
    };
  }

  // No `MonicaItemType`: an entry written by another client that only carries TOTP fields still
  // imports as an authenticator, which is how a KeePassXC `otp` field reaches Monica at all.
  const totp = readKeePassEntryTotp(fields);
  if (!totp) return undefined;

  return {
    itemType: "TOTP",
    itemData: { ...totp, otpType: totp.otpType },
    title: title || totp.issuer || totp.accountName || "Untitled",
    notes,
    imagePaths: [],
    isFavorite: false,
    monicaSecureItemId
  };
}

/**
 * `parseStandardTotpFromEntry`. Every convention Android reads is consulted, with the entry's own
 * title, username and URL supplying the issuer, account name and link the bare fields do not carry.
 */
export function readKeePassEntryTotp(fields: KeePassEntryFields): KeePassTotpData | undefined {
  return parseKeePassTotpFields({
    otp: keePassFieldValue(fields, KEEPASS_TOTP_FIELDS.otp),
    seed: keePassFieldValue(fields, KEEPASS_TOTP_FIELDS.seed, "TOTPSeed"),
    settings: keePassFieldValue(fields, KEEPASS_TOTP_FIELDS.settings, "TOTPSettings"),
    period: keePassFieldValue(fields, KEEPASS_TOTP_FIELDS.period, "TOTPPeriod"),
    digits: keePassFieldValue(fields, KEEPASS_TOTP_FIELDS.digits, "TOTPDigits"),
    algorithm: keePassFieldValue(fields, KEEPASS_TOTP_FIELDS.algorithm, "TOTPAlgorithm"),
    counter: keePassFieldValue(fields, KEEPASS_TOTP_FIELDS.hotpCounter, "HOTPCounter"),
    type: keePassFieldValue(fields, KEEPASS_TOTP_FIELDS.otpType, "OTPType", "TOTP Type", "TOTPType"),
    issuer: keePassFieldValue(fields, "Title"),
    accountName: keePassFieldValue(fields, "UserName"),
    link: keePassFieldValue(fields, "URL")
  });
}

/**
 * The entry owns the title, notes and favourite flag, so they override whatever the caller's base
 * carried; `imagePaths` only overrides when the entry actually has some, since another client's edit
 * would not have written the field at all.
 */
export function keePassSecureItemToVaultItem(
  projection: KeePassSecureItemProjection,
  base: MonicaItemBase
): VaultItem | undefined {
  return monicaItemDataToVaultItem(
    projection.itemType,
    projection.itemData,
    {
      ...base,
      title: projection.title,
      notes: projection.notes,
      favorite: projection.isFavorite,
      imagePaths: projection.imagePaths.length ? projection.imagePaths : base.imagePaths
    },
    { fallbackNotes: projection.notes }
  );
}

/** `buildStructuredSecureItemDataFromEntry`: only a bank card can be rebuilt from labelled fields. */
function reconstructSecureItemData(
  itemType: MonicaItemType,
  fields: KeePassEntryFields
): Record<string, unknown> | undefined {
  return itemType === "BANK_CARD" ? reconstructBankCardData(fields) : undefined;
}

/** `buildBankCardItemDataFromEntry`. Keys are the `BankCardData` property names, not the field labels. */
function reconstructBankCardData(fields: KeePassEntryFields): Record<string, unknown> | undefined {
  const [fallbackMonth, fallbackYear] = splitCardExpiry(keePassFieldValue(fields, ...CARD_READ_ALIASES.expiry));
  const data = {
    cardNumber: keePassFieldValue(fields, ...CARD_READ_ALIASES.number),
    cardholderName: keePassFieldValue(fields, ...CARD_READ_ALIASES.holder),
    expiryMonth: keePassFieldValue(fields, CARD_FIELDS.expiryMonth) || fallbackMonth,
    expiryYear: keePassFieldValue(fields, CARD_FIELDS.expiryYear) || fallbackYear,
    cvv: keePassFieldValue(fields, ...CARD_READ_ALIASES.cvv),
    bankName: keePassFieldValue(fields, CARD_FIELDS.bankName),
    cardType: parseKeePassCardType(keePassFieldValue(fields, CARD_FIELDS.cardType)),
    billingAddress: keePassFieldValue(fields, CARD_FIELDS.billingAddress),
    brand: keePassFieldValue(fields, CARD_FIELDS.brand),
    nickname: keePassFieldValue(fields, CARD_FIELDS.nickname),
    validFromMonth: keePassFieldValue(fields, CARD_FIELDS.validFromMonth),
    validFromYear: keePassFieldValue(fields, CARD_FIELDS.validFromYear),
    pin: keePassFieldValue(fields, CARD_FIELDS.pin),
    iban: keePassFieldValue(fields, CARD_FIELDS.iban),
    swiftBic: keePassFieldValue(fields, CARD_FIELDS.swiftBic),
    routingNumber: keePassFieldValue(fields, CARD_FIELDS.routingNumber),
    accountNumber: keePassFieldValue(fields, CARD_FIELDS.accountNumber),
    branchCode: keePassFieldValue(fields, CARD_FIELDS.branchCode),
    currency: keePassFieldValue(fields, CARD_FIELDS.currency),
    customerServicePhone: keePassFieldValue(fields, CARD_FIELDS.customerServicePhone),
    customFields: serializeSecureCustomFields(readKeePassSecureItemCustomFields(fields))
  };

  const populated = [
    data.cardNumber, data.cardholderName, data.expiryMonth, data.expiryYear, data.cvv,
    data.bankName, data.billingAddress, data.brand, data.nickname, data.pin, data.iban,
    data.swiftBic, data.routingNumber, data.accountNumber, data.branchCode, data.currency,
    data.customerServicePhone
  ].some(Boolean);
  return populated || data.customFields.length ? data : undefined;
}

/** `extractStructuredSecureItemCustomFields`: every non-reserved, non-`_etm_`, non-blank field. */
export function readKeePassSecureItemCustomFields(fields: KeePassEntryFields): SecureCustomField[] {
  const custom: SecureCustomField[] = [];
  for (const [name, value] of fields) {
    const key = name.trim();
    if (!key || key.startsWith("_etm_")) continue;
    if (RESERVED_CARD_FIELD_KEYS.has(key.toLowerCase())) continue;
    const text = keePassFieldText(value);
    if (!text) continue;
    const isProtected = isKeePassFieldProtected(value);
    custom.push({ name: key, value: text, protected: isProtected, fieldType: isProtected ? "HIDDEN" : "TEXT" });
  }
  return custom;
}

export interface KeePassSecureItemWriteInput {
  item: VaultItem;
  /** Android's `SecureItem.id`; absent for an item the browser created. */
  monicaSecureItemId?: number;
}

/**
 * `buildSecureItemFields`. Returns undefined for a kind that has no `MonicaItemType` — a login or a
 * passkey — because those go through their own codecs.
 */
export function buildKeePassSecureItemFields(
  input: KeePassSecureItemWriteInput
): Map<string, KeePassEntryFieldValue> | undefined {
  const { item } = input;
  const itemType = monicaItemTypeForKind(item.kind);
  if (!itemType) return undefined;

  const itemData = vaultItemToMonicaItemData(item) ?? "";
  const fields = new Map<string, KeePassEntryFieldValue>();
  fields.set("Title", item.title);
  fields.set("UserName", "");
  fields.set("Password", kdbxweb.ProtectedValue.fromString(""));
  fields.set("URL", "");
  fields.set("Notes", item.kind === "secure-note" ? toExternalReadableContent(item.content) : item.notes);
  fields.set(KEEPASS_SECURE_ITEM_FIELDS.itemType, itemType);
  fields.set(KEEPASS_SECURE_ITEM_FIELDS.imagePaths, encodeImagePaths(item.imagePaths));
  fields.set(KEEPASS_SECURE_ITEM_FIELDS.isFavorite, String(Boolean(item.favorite)));

  if (item.kind === "card") {
    appendBankCardFields(fields, item);
  } else {
    fields.set(KEEPASS_SECURE_ITEM_FIELDS.itemData, kdbxweb.ProtectedValue.fromString(itemData));
    if (item.kind === "totp") appendTotpFields(fields, item);
  }

  if (input.monicaSecureItemId !== undefined && input.monicaSecureItemId > 0) {
    fields.set(KEEPASS_SECURE_ITEM_FIELDS.id, String(input.monicaSecureItemId));
  }
  return fields;
}

/**
 * `buildSecureItemEntryFieldPatch`. A TOTP item widens the managed set to the KeePass TOTP fields:
 * they are the item's own projection here, so a secret that changed must not leave a stale `otp`
 * behind for another client to keep generating codes from.
 */
export function buildKeePassSecureItemPatch(
  input: KeePassSecureItemWriteInput
): KeePassFieldPatch<KeePassEntryFieldValue> | undefined {
  const replacementFields = buildKeePassSecureItemFields(input);
  if (!replacementFields) return undefined;
  const removeManagedField =
    input.item.kind === "totp"
      ? (name: string) => isSecureItemOverlayField(name) || isKeePassTotpField(name)
      : isSecureItemOverlayField;
  return createKeePassFieldPatch(replacementFields, removeManagedField, [...replacementFields.keys()]);
}

/**
 * `appendBankCardFields`. Every field is omit-if-blank, and the secrets are protected exactly as
 * Android protects them: number, CVV, PIN, IBAN, SWIFT/BIC and the two account identifiers.
 */
function appendBankCardFields(fields: Map<string, KeePassEntryFieldValue>, item: CardItem): void {
  const plain = (name: string, value: string | undefined) => {
    if (value?.trim()) fields.set(name, value);
  };
  const secret = (name: string, value: string | undefined) => {
    if (value?.trim()) fields.set(name, kdbxweb.ProtectedValue.fromString(value));
  };

  secret(CARD_FIELDS.number, item.number);
  plain(CARD_FIELDS.holder, item.cardholderName);
  plain(CARD_FIELDS.expiryMonth, item.expiryMonth);
  plain(CARD_FIELDS.expiryYear, item.expiryYear);
  secret(CARD_FIELDS.cvv, item.securityCode);
  plain(CARD_FIELDS.bankName, item.bankName);
  plain(CARD_FIELDS.cardType, item.cardType || "CREDIT");
  plain(CARD_FIELDS.billingAddress, formatBillingAddressForDisplay(item.billingAddress));
  plain(CARD_FIELDS.brand, item.brand);
  plain(CARD_FIELDS.nickname, item.nickname);
  plain(CARD_FIELDS.validFromMonth, item.validFromMonth);
  plain(CARD_FIELDS.validFromYear, item.validFromYear);
  secret(CARD_FIELDS.pin, item.pin);
  secret(CARD_FIELDS.iban, item.iban);
  secret(CARD_FIELDS.swiftBic, item.swiftBic);
  secret(CARD_FIELDS.routingNumber, item.routingNumber);
  secret(CARD_FIELDS.accountNumber, item.accountNumber);
  plain(CARD_FIELDS.branchCode, item.branchCode);
  plain(CARD_FIELDS.currency, item.currency);
  plain(CARD_FIELDS.customerServicePhone, item.customerServicePhone);
  appendSecureItemCustomFields(fields, item.customFields);
}

/**
 * `appendSecureItemCustomFields`. Unlike the password path this keeps a field whose value is blank:
 * Android's `isValid()` only requires a label, and dropping it would delete the user's empty field.
 */
function appendSecureItemCustomFields(
  fields: Map<string, KeePassEntryFieldValue>,
  customFields: SecureCustomField[] | undefined
): void {
  const used = new Set([...fields.keys()].map((name) => name.trim().toLowerCase()));
  for (const field of customFields ?? []) {
    const name = field.name.trim();
    if (!name || name.startsWith("_etm_")) continue;
    if (used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    const hidden = field.fieldType === "HIDDEN" || (field.fieldType === undefined && field.protected);
    fields.set(name, hidden ? kdbxweb.ProtectedValue.fromString(field.value) : field.value);
  }
}

/**
 * `appendKeePassTotpFields`. `otp` and `TOTP Seed` are protected; the rest are plain. Steam, Yandex
 * and mOTP are projected as `OTP Type: TOTP` because that is all a KeePass client can generate — the
 * real type stays in `MonicaItemData`, so a round-trip through Monica does not downgrade the item.
 */
function appendTotpFields(fields: Map<string, KeePassEntryFieldValue>, item: TotpItem): void {
  const projected = keePassTotpFieldsFor(
    {
      secret: item.secret,
      issuer: item.issuer ?? "",
      accountName: item.accountName ?? "",
      period: item.period,
      digits: item.digits,
      algorithm: item.algorithm,
      otpType: item.otpType === "HOTP" ? "HOTP" : "TOTP",
      counter: item.counter ?? 0,
      link: item.link ?? ""
    },
    item.title
  );
  for (const [name, value] of Object.entries(projected)) {
    const isSecret = name === KEEPASS_TOTP_FIELDS.otp || name === KEEPASS_TOTP_FIELDS.seed;
    fields.set(name, isSecret ? kdbxweb.ProtectedValue.fromString(value) : value);
  }
}

/**
 * `BillingAddress.formatForDisplay()`, applied only when the stored value is the structured JSON
 * Monica writes. Anything else is a string the user typed and is passed through untouched.
 */
function formatBillingAddressForDisplay(value: string | undefined): string {
  if (!value?.trim()) return "";
  let parsed: Record<string, unknown>;
  try {
    const candidate = JSON.parse(value) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return value;
    parsed = candidate as Record<string, unknown>;
  } catch {
    return value;
  }
  const text = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "");
  const lines = [
    text("streetAddress"),
    text("apartment"),
    [text("city"), text("stateProvince")].filter(Boolean).join(", "),
    [text("postalCode"), text("country")].filter(Boolean).join(" ")
  ].filter(Boolean);
  return lines.join("\n") || value;
}

/**
 * `NoteContentCodec.toExternalReadableContent`. A `monica-image://` reference is meaningless outside
 * Monica, so it degrades to `[alt:id]` rather than leaving a broken image link in KeePassXC.
 */
function toExternalReadableContent(content: string): string {
  if (!content.trim()) return content;
  return content.replace(/!\[([^\]]*)\]\(monica-image:\/\/([^)\s]+)\)/g, (_match, alt: string, id: string) => {
    const label = alt.trim() || "Image";
    const imageId = id.trim();
    return imageId ? `[${label}:${imageId}]` : `[${label}]`;
  });
}

/** `NoteContentCodec.decodeImagePaths`: a value that is not a JSON array is a single path. */
function decodeImagePaths(value: string): string[] {
  if (!value.trim()) return [];
  let paths: string[];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return value.startsWith("[") ? [] : [value.trim()];
    paths = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    if (value.startsWith("[")) return [];
    paths = [value];
  }
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

/** Blank rather than `[]` when there are no paths, matching the empty column Android writes. */
function encodeImagePaths(paths: string[] | undefined): string {
  const normalized = [...new Set((paths ?? []).map((path) => path.trim()).filter(Boolean))];
  return normalized.length ? JSON.stringify(normalized) : "";
}

/** `splitCardExpiry`: a single token is a year, since "2027" alone cannot be a month. */
function splitCardExpiry(raw: string): [string, string] {
  const normalized = raw.trim();
  if (!normalized) return ["", ""];
  const parts = normalized.split(/[/\-. ]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return ["", normalized];
  return [parts[0], parts[1]];
}

function parseKeePassCardType(raw: string): NonNullable<CardItem["cardType"]> {
  switch (raw.trim().toUpperCase().replace(/ /g, "_")) {
    case "DEBIT":
    case "DEBIT_CARD":
      return "DEBIT";
    case "PREPAID":
    case "PREPAID_CARD":
      return "PREPAID";
    default:
      return "CREDIT";
  }
}

function optionalInteger(value: string): number | undefined {
  if (!/^[+-]?\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
