import * as kdbxweb from "kdbxweb";
import type { LoginItem, ProviderReference, ProviderSourceRecord, VaultItem } from "../../core/model";
import type { MonicaItemBase } from "../monica-item-data";
import { buildKeePassCredentialCandidates, keePassInvalidCredentialMessage } from "./keepass-credentials";
import { installKdbxCryptoEngine } from "./keepass-crypto";
import {
  buildKeePassReferenceContext,
  resolveKeePassEntryFields,
  type KeePassReferenceContext,
  type KeePassReferenceEntry
} from "./keepass-field-reference";
import { KeePassOperationError, assertKeePassFileSupported, toKeePassOperationError } from "./keepass-format";
import {
  isKeePassEmptyEntry,
  isKeePassTemplateEntry,
  keePassEntryHasTotpFields,
  keePassFieldValue,
  readKeePassLoginFields,
  type KeePassEntryFields
} from "./keepass-login-codec";
import { isKeePassPasskeyEntry, keePassPasskeyToVaultItem, readKeePassPasskeyFields } from "./keepass-passkey-codec";
import { buildKeePassPathKey, isKeePassRecycleBinPath } from "./keepass-path-codec";
import {
  isKeePassSecureItemEntry,
  keePassSecureItemToVaultItem,
  readKeePassEntryTotp,
  readKeePassSecureItemFields
} from "./keepass-secure-item-codec";
import { keePassTotpFieldsFor, KEEPASS_TOTP_FIELDS } from "./keepass-totp-codec";

/**
 * Port of the read half of Android `utils/KeePassKdbxService.kt` (SHA 9930d8d8): `loadWorkspace`,
 * `collectEntryContexts`, `analyzePasswordEntry`, `entryToSecureItemData` and `readPasskeyEntries`.
 *
 * Android runs three separate passes over the same file, one per item family, each re-deriving the
 * traversal. Here the traversal happens once and each entry is dispatched to exactly one codec, because
 * an item's id is derived from the entry UUID and two items may not share one.
 *
 * The passes are mutually exclusive by construction in every case but one: a passkey entry returns null
 * from `entryToSecureItemData`, an entry with `MonicaItemType` is skipped by the password pass, and a
 * pure passkey is skipped by both others. The exception is an entry carrying KeePass TOTP fields
 * alongside a login — Android emits both a `PasswordEntry` and a TOTP `SecureItem` from it, into two
 * separate tables. That is not expressible here, so such an entry becomes a login whose `totpSecret`
 * carries the credential; only an entry whose TOTP is all it has becomes a standalone authenticator.
 * Nothing is lost either way: the TOTP fields are `keepass-totp`, never Monica-owned, so a write-back
 * preserves them verbatim.
 */

export type KeePassSkipReason = "monica-secure-item" | "pure-passkey" | "template" | "empty" | "unknown-item-type";

export interface KeePassEntryContext {
  entry: kdbxweb.KdbxEntry;
  /** Undefined at the root: Android's root group contributes no path segment. */
  groupPath?: string;
  groupUuid: string;
  isInRecycleBinByMeta: boolean;
}

export interface KeePassSkippedEntry {
  entryUuid: string;
  groupPath?: string;
  reason: KeePassSkipReason;
}

export interface KeePassVaultEntries {
  items: VaultItem[];
  /** Entries no codec claimed. Kept for diagnostics only; the entry itself is never rewritten. */
  skipped: KeePassSkippedEntry[];
  /** Live `KdbxEntry` handles keyed by entry UUID, so a write can patch the original in place. */
  entriesByUuid: Map<string, kdbxweb.KdbxEntry>;
}

export interface KeePassVaultSnapshot extends KeePassVaultEntries {
  database: kdbxweb.Kdbx;
  /** Reported so the UI can name the actual format rather than guessing from the extension. */
  versionMajor: number;
  cipherName?: string;
  hasRecycleBinMeta: boolean;
  warnings: string[];
}

export interface KeePassOpenOptions {
  password: string;
  keyFile?: Uint8Array;
  /** Only used to improve the error message for a legacy `.kdb` with no signature. */
  sourceName?: string;
  databaseId: number;
  providerId: string;
}

/**
 * Every credential interpretation is tried before the file is declared locked, because a key file's
 * format cannot be told from its bytes and a wrong guess is indistinguishable from a wrong password.
 * A non-credential failure aborts immediately: retrying a corrupt file with another key wastes an
 * Argon2 derivation per candidate and would report the wrong cause.
 */
export async function openKeePassVault(
  bytes: Uint8Array,
  options: KeePassOpenOptions
): Promise<KeePassVaultSnapshot> {
  installKdbxCryptoEngine();
  const header = assertKeePassFileSupported(bytes, options.sourceName);
  const candidates = await buildKeePassCredentialCandidates(options.password, options.keyFile);

  const attempted: string[] = [];
  let database: kdbxweb.Kdbx | undefined;
  for (const candidate of candidates) {
    attempted.push(candidate.label);
    try {
      database = await kdbxweb.Kdbx.load(bytes.slice().buffer, candidate.credentials);
      break;
    } catch (error) {
      const classified = toKeePassOperationError(error);
      if (classified.code !== "invalid-credential") throw classified;
    }
  }
  if (!database) throw new KeePassOperationError("invalid-credential", keePassInvalidCredentialMessage(attempted));

  const warnings: string[] = [];
  if (header.versionMajor === 3) {
    warnings.push("此数据库为 KDBX 3 格式，保存后仍写回 KDBX 3，不会自动升级。");
  }

  return {
    database,
    versionMajor: header.versionMajor ?? 0,
    cipherName: header.cipherName,
    warnings,
    ...readKeePassEntries(database, options.databaseId, options.providerId)
  };
}

/** Re-reads an already-open database, so a write-back never re-runs the KDF. */
export function readKeePassEntries(
  database: kdbxweb.Kdbx,
  databaseId: number,
  providerId: string
): KeePassVaultEntries & { hasRecycleBinMeta: boolean } {
  const recycleBinUuid = resolveRecycleBinUuid(database);
  const hasRecycleBinMeta = recycleBinUuid !== undefined;
  const contexts: KeePassEntryContext[] = [];
  collectEntriesWithGroupPath(database.getDefaultGroup(), undefined, recycleBinUuid, false, contexts);

  const referenceEntries = contexts.map<KeePassReferenceEntry>((context) => ({
    uuid: context.entry.uuid.toString(),
    fields: context.entry.fields
  }));
  const referenceContext = buildKeePassReferenceContext(referenceEntries);

  const items: VaultItem[] = [];
  const skipped: KeePassSkippedEntry[] = [];
  const entriesByUuid = new Map<string, kdbxweb.KdbxEntry>();

  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index];
    const entryUuid = referenceEntries[index].uuid;
    entriesByUuid.set(entryUuid, context.entry);
    const fields = resolveKeePassEntryFields(referenceEntries[index], referenceContext);
    const decoded = decodeKeePassEntry(context, fields, {
      entryUuid,
      databaseId,
      providerId,
      hasRecycleBinMeta
    });
    if (decoded.item) items.push(decoded.item);
    else if (decoded.reason) skipped.push({ entryUuid, groupPath: context.groupPath, reason: decoded.reason });
  }

  return { items, skipped, entriesByUuid, hasRecycleBinMeta };
}

interface KeePassDecodeOptions {
  entryUuid: string;
  databaseId: number;
  providerId: string;
  hasRecycleBinMeta: boolean;
}

export interface KeePassDecodedEntry {
  item?: VaultItem;
  reason?: KeePassSkipReason;
}

/**
 * `analyzePasswordEntry` precedence, with the two other passes folded in at the points where Android's
 * own passes would have claimed the entry: `MonicaItemType` first, then a passkey carrying nothing else,
 * then a template, then a wholly empty entry. An entry that has passkey fields *and* a username or notes
 * still becomes a login on Android, so it does here too.
 */
export function decodeKeePassEntry(
  context: KeePassEntryContext,
  fields: KeePassEntryFields,
  options: KeePassDecodeOptions
): KeePassDecodedEntry {
  const base = buildItemBase(context, options, fields);

  if (isKeePassSecureItemEntry(fields)) {
    if (isKeePassPasskeyEntry(fields)) return { reason: "monica-secure-item" };
    const projection = readKeePassSecureItemFields(fields);
    if (!projection) return { reason: "unknown-item-type" };
    const item = keePassSecureItemToVaultItem(projection, base);
    return item ? { item } : { reason: "unknown-item-type" };
  }

  if (isKeePassPasskeyEntry(fields)) {
    if (isPureKeePassPasskeyEntry(fields)) {
      const projection = readKeePassPasskeyFields(fields, {
        createdAt: base.createdAt,
        lastUsedAt: isoOf(context.entry.times.lastModTime),
        useCount: context.entry.times.usageCount
      });
      return projection ? { item: keePassPasskeyToVaultItem(projection, base) } : { reason: "pure-passkey" };
    }
    // Carries a username or notes as well, so Android's password pass claims it and the passkey half is
    // preserved on the entry rather than modelled. Splitting it into two items would duplicate it on
    // write-back, since both would then patch the same entry.
    return { item: buildLoginItem(fields, base) };
  }

  if (isKeePassTemplateEntry(fields)) return { reason: "template" };
  if (isKeePassEmptyEntry(fields)) return { reason: "empty" };

  // A bare authenticator: no login half at all, so nothing is lost by modelling it as a TOTP item.
  if (keePassEntryHasTotpFields(fields) && isTotpOnlyEntry(fields)) {
    const projection = readKeePassSecureItemFields(fields);
    const item = projection ? keePassSecureItemToVaultItem(projection, base) : undefined;
    if (item) return { item };
  }

  return { item: buildLoginItem(fields, base) };
}

/** A login that also carries TOTP fields stays a login, so only a blank username and password qualify. */
function isTotpOnlyEntry(fields: KeePassEntryFields): boolean {
  const login = readKeePassLoginFields(fields);
  return !login.username && !login.password;
}

/**
 * An `otpauth://` URI rather than the bare seed, so period, digits, algorithm and counter survive onto
 * the login instead of silently defaulting when the code is generated.
 */
function keePassEntryTotpUri(fields: KeePassEntryFields): string | undefined {
  const totp = readKeePassEntryTotp(fields);
  if (!totp) return undefined;
  return keePassTotpFieldsFor(totp, totp.issuer || totp.accountName)[KEEPASS_TOTP_FIELDS.otp];
}

/** `analyzePasswordEntry`'s PURE_PASSKEY test: passkey fields present and all four others blank. */
function isPureKeePassPasskeyEntry(fields: KeePassEntryFields): boolean {
  const login = readKeePassLoginFields(fields);
  return !login.username && !login.password && !login.url && !login.notes;
}

function buildLoginItem(fields: KeePassEntryFields, base: MonicaItemBase): LoginItem {
  const projection = readKeePassLoginFields(fields);
  return {
    ...base,
    kind: "login",
    title: projection.title || base.title,
    notes: projection.notes,
    username: projection.username,
    password: projection.password,
    uris: projection.url ? [projection.url] : [],
    customFields: projection.customFields,
    // Android would have emitted a second TOTP row for this entry; here the credential rides along on
    // the login instead, since both rows would otherwise claim the same entry-derived id.
    totpSecret: keePassEntryTotpUri(fields),
    loginType: projection.loginType,
    ssoProvider: projection.ssoProvider,
    ssoRefEntryId: projection.ssoRefEntryId,
    appPackageName: projection.appPackageName,
    appName: projection.appName,
    email: projection.email,
    phone: projection.phone,
    addressLine: projection.addressLine,
    city: projection.city,
    state: projection.state,
    zipCode: projection.zipCode,
    country: projection.country,
    sshKeyData: projection.sshKeyData,
    wifiMetadata: projection.wifiMetadata
  };
}

/**
 * The recycle bin becomes `deletedAt` rather than a dropped entry: Android keeps those rows and shows
 * them in its own trash, so discarding them here would make the browser lose data the phone still has.
 */
function buildItemBase(
  context: KeePassEntryContext,
  options: KeePassDecodeOptions,
  fields: KeePassEntryFields
): MonicaItemBase {
  const createdAt = isoOf(context.entry.times.creationTime) ?? EPOCH;
  const updatedAt = isoOf(context.entry.times.lastModTime) ?? createdAt;
  const inRecycleBin = resolveRecycleBinFlag(context, options.hasRecycleBinMeta);
  const providerRefs: ProviderReference[] = [
    { providerId: options.providerId, remoteId: options.entryUuid, revision: String(context.entry.times.usageCount ?? "") || undefined }
  ];

  return {
    id: `keepass:${options.providerId}:${options.entryUuid}`,
    title: keePassFieldValue(fields, "Title") || "未命名 KeePass 条目",
    favorite: false,
    notes: "",
    createdAt,
    updatedAt,
    ...(inRecycleBin ? { deletedAt: updatedAt } : {}),
    keepassDatabaseId: options.databaseId,
    keepassGroupPath: context.groupPath,
    keepassEntryUuid: options.entryUuid,
    keepassGroupUuid: context.groupUuid,
    providerRefs
  };
}

/** `resolveRecycleBinFlag`: the name heuristic only applies when the metadata declares no bin at all. */
function resolveRecycleBinFlag(context: KeePassEntryContext, hasRecycleBinMeta: boolean): boolean {
  if (hasRecycleBinMeta) return context.isInRecycleBinByMeta;
  return isKeePassRecycleBinPath(context.groupPath);
}

/** `resolveRecycleBinUuid`: a disabled bin yields no uuid, which turns off meta-based detection. */
function resolveRecycleBinUuid(database: kdbxweb.Kdbx): string | undefined {
  if (database.meta.recycleBinEnabled === false) return undefined;
  const uuid = database.meta.recycleBinUuid;
  if (!uuid || uuid.empty) return undefined;
  return uuid.toString();
}

/** `collectEntriesWithGroupPath`: the root contributes no segment, so a blank path means the root. */
function collectEntriesWithGroupPath(
  group: kdbxweb.KdbxGroup,
  currentPathKey: string | undefined,
  recycleBinUuid: string | undefined,
  parentInRecycleBin: boolean,
  out: KeePassEntryContext[]
): void {
  const inRecycleBin = parentInRecycleBin || (recycleBinUuid !== undefined && group.uuid.toString() === recycleBinUuid);
  const groupUuid = group.uuid.toString();
  for (const entry of group.entries) {
    out.push({ entry, groupPath: currentPathKey, groupUuid, isInRecycleBinByMeta: inRecycleBin });
  }
  for (const child of group.groups) {
    collectEntriesWithGroupPath(child, buildKeePassPathKey(currentPathKey, child.name ?? ""), recycleBinUuid, inRecycleBin, out);
  }
}

/**
 * A verbatim copy of every field of an entry no codec modelled, so a browser edit elsewhere in the file
 * cannot silently drop it. Protection is recorded per field; the value itself is only read here, never
 * rewritten, and the record never leaves the background context.
 */
export function keePassSourceRecordFor(
  entry: kdbxweb.KdbxEntry,
  providerId: string
): ProviderSourceRecord {
  const payload = JSON.stringify({
    uuid: entry.uuid.toString(),
    fields: [...entry.fields].map(([name, value]) => ({
      name,
      protected: value instanceof kdbxweb.ProtectedValue,
      value: value instanceof kdbxweb.ProtectedValue ? value.getText() : value
    })),
    tags: entry.tags,
    binaryNames: [...entry.binaries.keys()]
  });
  return {
    providerId,
    remoteId: entry.uuid.toString(),
    format: "keepass-entry",
    encoding: "json",
    payload,
    contentHash: ""
  };
}

const EPOCH = new Date(0).toISOString();

function isoOf(value: Date | undefined): string | undefined {
  if (!value) return undefined;
  const time = value.getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
