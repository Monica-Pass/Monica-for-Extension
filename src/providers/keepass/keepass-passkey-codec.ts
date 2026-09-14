import * as kdbxweb from "kdbxweb";
import type { PasskeyItem } from "../../core/model";
import { normalizeCredentialId } from "../../passkey/source-policy";
import { normalizeRpId } from "../../passkey/webauthn-core";
import { parsePortablePasskeyPrivateKey } from "../../passkey/private-key-portability";
import type { MonicaItemBase } from "../monica-item-data";
import { KEEPASSDX_PASSKEY_FIELDS, isPasskeyEntryOverlayField } from "./keepass-field-registry";
import { createKeePassFieldPatch, type KeePassFieldPatch } from "./keepass-field-patch";
import {
  keePassFieldValue,
  type KeePassEntryFields,
  type KeePassEntryFieldValue
} from "./keepass-login-codec";

/**
 * Port of the passkey half of Android `utils/KeePassKdbxService.kt` together with
 * `keepass/KeePassPasskeySyncCodec.kt` and `keepass/KeePassDxPasskeyCodec.kt` (SHA 9930d8d8).
 *
 * A passkey is written twice into the same entry, on purpose. `MonicaPasskeyData` is the lossless
 * Monica payload; the `KPEX_PASSKEY_*` fields are KeePassDX's own convention, so the credential also
 * works in KeePassDX. The Monica payload wins on read, and the KPEX fields are the fallback for an
 * entry KeePassDX created.
 */

export const KEEPASS_PASSKEY_FIELDS = {
  credentialId: "MonicaPasskeyCredentialId",
  data: "MonicaPasskeyData",
  mode: "MonicaPasskeyMode"
} as const;

const PASSKEY_TITLE_SUFFIX = " [Passkey]";
const KEEPASS_COMPAT_MODE = "KEEPASS_COMPAT";
const PEM_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PEM_END = "-----END PRIVATE KEY-----";

/** `KeePassDxPasskeyCodec.isPasskey`: any one of these five is enough to call the entry a passkey. */
const KEEPASSDX_REQUIRED_FIELDS = [
  KEEPASSDX_PASSKEY_FIELDS.username,
  KEEPASSDX_PASSKEY_FIELDS.privateKey,
  KEEPASSDX_PASSKEY_FIELDS.credentialId,
  KEEPASSDX_PASSKEY_FIELDS.userHandle,
  KEEPASSDX_PASSKEY_FIELDS.relyingParty
];

export function isKeePassPasskeyEntry(fields: KeePassEntryFields): boolean {
  if (keePassFieldValue(fields, KEEPASS_PASSKEY_FIELDS.credentialId)) return true;
  if (keePassFieldValue(fields, KEEPASS_PASSKEY_FIELDS.data)) return true;
  return KEEPASSDX_REQUIRED_FIELDS.some((name) => keePassFieldValue(fields, name));
}

export interface KeePassPasskeyReadOptions {
  /** `entry.times.creationTime`, used only by the KeePassDX path, which stores no timestamps. */
  createdAt?: string;
  lastUsedAt?: string;
  useCount?: number;
}

export interface KeePassPasskeyProjection {
  title?: string;
  credentialId: string;
  rpId: string;
  rpName: string;
  userHandle: string;
  userName: string;
  userDisplayName: string;
  algorithm: number;
  publicKey: string;
  privateKeyPkcs8?: string;
  signCount: number;
  backupEligible: boolean;
  backupState: boolean;
  discoverable: boolean;
  userVerificationRequired: boolean;
  transports: string[];
  aaguid?: string;
  iconUrl?: string;
  useCount?: number;
  createdAt?: string;
  lastUsedAt?: string;
  notes: string;
  sourceMode: PasskeyItem["sourceMode"];
}

/**
 * `entryToPasskeyEntry`. The Monica payload is tried first and the KeePassDX fields are the fallback,
 * so an entry Monica wrote round-trips losslessly while one KeePassDX wrote still imports.
 */
export function readKeePassPasskeyFields(
  fields: KeePassEntryFields,
  options: KeePassPasskeyReadOptions = {}
): KeePassPasskeyProjection | undefined {
  if (!isKeePassPasskeyEntry(fields)) return undefined;
  const fromMonica = readMonicaPasskeyPayload(fields);
  return fromMonica ?? readKeePassDxPasskey(fields, options);
}

/** `KeePassPasskeySyncCodec.decode`, with `MonicaPasskeyCredentialId` overriding the payload's copy. */
function readMonicaPasskeyPayload(fields: KeePassEntryFields): KeePassPasskeyProjection | undefined {
  const raw = keePassFieldValue(fields, KEEPASS_PASSKEY_FIELDS.data);
  if (!raw) return undefined;
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    payload = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const privateKeyPkcs8 = pkcs8Base64Of(text(payload.privateKeyAlias));
  const credentialId = keePassFieldValue(fields, KEEPASS_PASSKEY_FIELDS.credentialId) || text(payload.credentialId);
  if (!credentialId) return undefined;
  const rpId = text(payload.rpId);
  const userName = text(payload.userName);

  return {
    title: stripPasskeySuffix(keePassFieldValue(fields, "Title")) || undefined,
    credentialId,
    rpId,
    rpName: text(payload.rpName) || rpId,
    userHandle: text(payload.userId),
    userName,
    userDisplayName: text(payload.userDisplayName) || userName,
    algorithm: integer(payload.publicKeyAlgorithm) ?? -7,
    publicKey: text(payload.publicKey),
    privateKeyPkcs8,
    signCount: integer(payload.signCount) ?? 0,
    // Monica registrations set BE/BS; old versions did not serialize these in their payload.
    backupEligible: payload.backupEligible !== false,
    backupState: payload.backupEligible !== false && payload.backupState !== false,
    discoverable: payload.isDiscoverable !== false,
    userVerificationRequired: payload.isUserVerificationRequired !== false,
    transports: splitTransports(text(payload.transports)),
    aaguid: text(payload.aaguid) || undefined,
    iconUrl: text(payload.iconUrl) || undefined,
    useCount: integer(payload.useCount),
    createdAt: epochToIso(integer(payload.createdAt)),
    lastUsedAt: epochToIso(integer(payload.lastUsedAt)),
    notes: keePassFieldValue(fields, "Notes"),
    sourceMode: privateKeyPkcs8 ? "browser-local" : "android-metadata-only"
  };
}

/**
 * `KeePassDxPasskeyCodec.decode`. All five fields are required, exactly as on Android: a credential
 * missing its private key or user handle cannot be asserted, so importing it would only produce a
 * dropdown entry that fails at signing time.
 */
function readKeePassDxPasskey(
  fields: KeePassEntryFields,
  options: KeePassPasskeyReadOptions
): KeePassPasskeyProjection | undefined {
  const userName = keePassFieldValue(fields, KEEPASSDX_PASSKEY_FIELDS.username);
  const privateKeyPem = keePassFieldValue(fields, KEEPASSDX_PASSKEY_FIELDS.privateKey);
  const rawCredentialId = keePassFieldValue(fields, KEEPASSDX_PASSKEY_FIELDS.credentialId);
  const userHandle = keePassFieldValue(fields, KEEPASSDX_PASSKEY_FIELDS.userHandle);
  const relyingParty = keePassFieldValue(fields, KEEPASSDX_PASSKEY_FIELDS.relyingParty);
  if (!userName || !privateKeyPem || !rawCredentialId || !userHandle || !relyingParty) return undefined;

  const privateKeyPkcs8 = pkcs8Base64Of(privateKeyPem);
  if (!privateKeyPkcs8) return undefined;

  const rpId = normalizeRpId(relyingParty) || relyingParty;
  const title = keePassFieldValue(fields, "Title");
  const rpName = stripPasskeySuffix(title) || rpId;

  return {
    title: stripPasskeySuffix(title) || undefined,
    credentialId: normalizeCredentialId(rawCredentialId) || rawCredentialId,
    rpId,
    rpName,
    userHandle,
    userName,
    userDisplayName: userName,
    algorithm: coseAlgorithmOfPkcs8(privateKeyPkcs8),
    publicKey: "",
    privateKeyPkcs8,
    signCount: 0,
    backupEligible: booleanField(keePassFieldValue(fields, KEEPASSDX_PASSKEY_FIELDS.flagBe)),
    backupState: booleanField(keePassFieldValue(fields, KEEPASSDX_PASSKEY_FIELDS.flagBe)) && booleanField(keePassFieldValue(fields, KEEPASSDX_PASSKEY_FIELDS.flagBs)),
    discoverable: true,
    userVerificationRequired: true,
    transports: ["internal"],
    aaguid: undefined,
    iconUrl: undefined,
    useCount: options.useCount,
    createdAt: options.createdAt,
    lastUsedAt: options.lastUsedAt ?? options.createdAt,
    notes: keePassFieldValue(fields, "Notes"),
    sourceMode: "browser-local"
  };
}

/**
 * The entry owns the title and notes. `createdAt` only overrides the base when the payload carried a
 * timestamp, so an entry KeePassDX wrote does not get a creation date invented for it.
 */
export function keePassPasskeyToVaultItem(
  projection: KeePassPasskeyProjection,
  base: MonicaItemBase
): PasskeyItem {
  return {
    ...base,
    kind: "passkey",
    title: projection.title || projection.rpName || projection.rpId,
    notes: projection.notes,
    createdAt: projection.createdAt ?? base.createdAt,
    credentialId: projection.credentialId,
    rpId: projection.rpId,
    rpName: projection.rpName,
    userHandle: projection.userHandle,
    userName: projection.userName,
    userDisplayName: projection.userDisplayName,
    algorithm: projection.algorithm,
    publicKey: projection.publicKey,
    privateKeyPkcs8: projection.privateKeyPkcs8,
    signCount: projection.signCount,
    backupEligible: projection.backupEligible,
    backupState: projection.backupState,
    discoverable: projection.discoverable,
    userVerificationRequired: projection.userVerificationRequired,
    transports: projection.transports,
    aaguid: projection.aaguid,
    iconUrl: projection.iconUrl,
    useCount: projection.useCount,
    lastUsedAt: projection.lastUsedAt,
    passkeyMode: "KEEPASS_COMPAT",
    sourceMode: projection.sourceMode
  };
}

export interface KeePassPasskeyWriteInput {
  item: PasskeyItem;
  /** The entry being updated, whose `KPEX_PASSKEY_FLAG_*` and private key are reused when unchanged. */
  existingFields?: KeePassEntryFields;
}

/**
 * `buildPasskeyFields`. The title carries the ` [Passkey]` suffix Android appends and KeePassDX
 * expects, and `Password` is written as a protected empty string so the entry never looks like a login.
 */
export function buildKeePassPasskeyFields(input: KeePassPasskeyWriteInput): Map<string, KeePassEntryFieldValue> {
  const { item } = input;
  const existing = (name: string) => (input.existingFields ? keePassFieldValue(input.existingFields, name) : "");
  const backupEligible = item.backupEligible ?? (existing(KEEPASSDX_PASSKEY_FIELDS.flagBe) ? booleanField(existing(KEEPASSDX_PASSKEY_FIELDS.flagBe)) : true);
  const backupState = backupEligible && (item.backupState ?? (existing(KEEPASSDX_PASSKEY_FIELDS.flagBs) ? booleanField(existing(KEEPASSDX_PASSKEY_FIELDS.flagBs)) : true));
  const readableTitle = stripPasskeySuffix(item.title) || item.rpName || item.rpId || "Passkey";
  const fields = new Map<string, KeePassEntryFieldValue>();

  fields.set("Title", `${readableTitle}${PASSKEY_TITLE_SUFFIX}`);
  fields.set("UserName", item.userName || item.userDisplayName);
  fields.set("Password", kdbxweb.ProtectedValue.fromString(""));
  fields.set("URL", passkeyUrlFor(item.rpId));
  fields.set("Notes", item.notes);
  fields.set(KEEPASS_PASSKEY_FIELDS.credentialId, item.credentialId);
  fields.set(KEEPASS_PASSKEY_FIELDS.mode, KEEPASS_COMPAT_MODE);
  fields.set(KEEPASS_PASSKEY_FIELDS.data, kdbxweb.ProtectedValue.fromString(buildMonicaPasskeyPayload({ ...item, backupEligible, backupState }, existing(KEEPASS_PASSKEY_FIELDS.data))));

  const privateKeyPem = item.privateKeyPkcs8
    ? pkcs8ToPem(item.privateKeyPkcs8)
    : existing(KEEPASSDX_PASSKEY_FIELDS.privateKey);
  const webAuthnId = normalizeCredentialId(item.credentialId) || item.credentialId;

  fields.set(KEEPASSDX_PASSKEY_FIELDS.passkey, "");
  fields.set(KEEPASSDX_PASSKEY_FIELDS.username, item.userName || item.userDisplayName);
  fields.set(KEEPASSDX_PASSKEY_FIELDS.privateKey, kdbxweb.ProtectedValue.fromString(privateKeyPem));
  fields.set(KEEPASSDX_PASSKEY_FIELDS.credentialId, kdbxweb.ProtectedValue.fromString(webAuthnId));
  fields.set(
    KEEPASSDX_PASSKEY_FIELDS.userHandle,
    kdbxweb.ProtectedValue.fromString(item.userHandle || existing(KEEPASSDX_PASSKEY_FIELDS.userHandle))
  );
  fields.set(
    KEEPASSDX_PASSKEY_FIELDS.relyingParty,
    normalizeRpId(item.rpId) || item.rpId || existing(KEEPASSDX_PASSKEY_FIELDS.relyingParty)
  );
  // Explicit registration flags take precedence. Legacy imports retain their existing KPEX flags.
  fields.set(KEEPASSDX_PASSKEY_FIELDS.flagBe, String(backupEligible));
  fields.set(KEEPASSDX_PASSKEY_FIELDS.flagBs, String(backupState));
  return fields;
}

export function buildKeePassPasskeyPatch(
  input: KeePassPasskeyWriteInput
): KeePassFieldPatch<KeePassEntryFieldValue> {
  const replacementFields = buildKeePassPasskeyFields(input);
  return createKeePassFieldPatch(replacementFields, isPasskeyEntryOverlayField, [...replacementFields.keys()]);
}

/** `KeePassPasskeySyncCodec.Payload`: Kotlin property names, `encodeDefaults = true`. */
function buildMonicaPasskeyPayload(item: PasskeyItem, existing = ""): string {
  let original: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) original = parsed as Record<string, unknown>;
  } catch { /* A new entry has no previous payload. */ }
  return JSON.stringify({
    ...original,
    credentialId: item.credentialId,
    rpId: item.rpId,
    rpName: item.rpName,
    userId: item.userHandle,
    userName: item.userName,
    userDisplayName: item.userDisplayName,
    publicKeyAlgorithm: item.algorithm,
    publicKey: item.publicKey,
    privateKeyAlias: item.privateKeyPkcs8 ?? original.privateKeyAlias ?? "",
    createdAt: isoToEpoch(item.createdAt),
    lastUsedAt: isoToEpoch(item.lastUsedAt ?? item.createdAt),
    useCount: item.useCount ?? 0,
    iconUrl: item.iconUrl ?? null,
    isDiscoverable: item.discoverable,
    isUserVerificationRequired: item.userVerificationRequired !== false,
    transports: (item.transports?.length ? item.transports : ["internal"]).join(","),
    aaguid: item.aaguid ?? "",
    signCount: item.signCount,
    backupEligible: item.backupEligible !== false,
    backupState: item.backupEligible !== false && item.backupState !== false,
    notes: item.notes,
    passkeyMode: KEEPASS_COMPAT_MODE
  });
}

function passkeyUrlFor(rpId: string): string {
  if (!rpId.trim()) return "";
  return rpId.includes("://") ? rpId : `https://${rpId}`;
}

function booleanField(value: string): boolean {
  return /^(true|1|yes)$/i.test(value.trim());
}

export function stripPasskeySuffix(title: string): string {
  return title.endsWith(PASSKEY_TITLE_SUFFIX) ? title.slice(0, -PASSKEY_TITLE_SUFFIX.length) : title;
}

/**
 * `PasskeyPrivateKeySupport.extractPkcs8Bytes`, reduced to what a browser needs: strip the PEM armour
 * if present, then re-encode as standard base64 so `crypto.subtle.importKey` accepts it. A key that is
 * neither yields undefined rather than a string that would fail at signing time.
 */
function pkcs8Base64Of(keyMaterial: string): string | undefined {
  return parsePortablePasskeyPrivateKey(keyMaterial)?.pkcs8Base64;
}

/** `PasskeyPrivateKeySupport.pkcs8ToPem`: base64 in 64-character lines, no trailing newline. */
function pkcs8ToPem(pkcs8Base64: string): string {
  const body = (pkcs8Base64.match(/.{1,64}/g) ?? []).join("\n");
  return `${PEM_BEGIN}\n${body}\n${PEM_END}`;
}

/**
 * `decodePkcs8Bytes` decides the COSE algorithm by asking each `KeyFactory` in turn; a browser has no
 * synchronous equivalent, so the algorithm OID is read out of the PKCS#8 `AlgorithmIdentifier`.
 * The shared parser rejects malformed keys and EC curves other than P-256.
 */
function coseAlgorithmOfPkcs8(pkcs8Base64: string): number {
  return parsePortablePasskeyPrivateKey(pkcs8Base64)?.algorithm ?? 0;
}

function splitTransports(value: string): string[] {
  const transports = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return transports.length ? transports : ["internal"];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function epochToIso(millis: number | undefined): string | undefined {
  return millis && millis > 0 ? new Date(millis).toISOString() : undefined;
}

function isoToEpoch(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
