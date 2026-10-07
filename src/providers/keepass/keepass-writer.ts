import * as kdbxweb from "kdbxweb";
import { prepareKeePassCustomIcon, applyKeePassCustomIcon } from "./keepass-custom-icon";
import type { VaultItem } from "../../core/model";
import { applyKeePassFieldPatch, type KeePassFieldPatch } from "./keepass-field-patch";
import {
  buildKeePassLoginPatch,
  isKeePassLoginItem,
  keePassFieldValue,
  type KeePassEntryFieldValue,
  type KeePassEntryFields
} from "./keepass-login-codec";
import { buildKeePassPasskeyPatch, isKeePassPasskeyEntry } from "./keepass-passkey-codec";
import { decodeKeePassPathSegments } from "./keepass-path-codec";
import { buildKeePassSecureItemPatch, isKeePassSecureItemEntry, readKeePassSecureItemFields, readKeePassEntryTotp, KEEPASS_SECURE_ITEM_FIELDS } from "./keepass-secure-item-codec";
import { keePassTotpFieldsFor } from "./keepass-totp-codec";
import { isInRecycleBin } from './keepass-groups';

/**
 * Write half of Android `utils/KeePassKdbxService.kt` (SHA 9930d8d8): `addEntryToGroupPath`,
 * `updateEntryInGroup` and the three `build*EntryFieldPatch` call sites.
 *
 * Every write goes through a field patch rather than replacing the entry's field map, so a field
 * written by KeePassXC, a KeePassDX plugin or a future Monica release survives untouched. kdbxweb
 * mutates the live `KdbxEntry`, where Android rebuilds an immutable tree; the resulting field map is
 * identical because `applyKeePassFieldPatch` already computes it as a whole.
 */

/**
 * Which family of fields the item projects onto, which decides the overlay the patch may remove.
 *
 * `existingFields` is what keeps an update from demoting the entry: Android's row id lives in the
 * entry itself, and the browser's `VaultItem` has nowhere to carry it, so it is read back off the
 * entry being updated. A passkey additionally reuses the KeePassDX backup flags and private key,
 * neither of which Monica can invent.
 */
export function keePassPatchFor(
  item: VaultItem,
  existingFields?: KeePassEntryFields
): KeePassFieldPatch<KeePassEntryFieldValue> | undefined {
  if (item.kind === "opaque") throw new Error("未知 KeePass 项目仅可只读查看，不能编辑或跨库新建。");
  if (existingFields) assertKnownKeePassType(existingFields);
  if (item.kind === "passkey") return buildKeePassPasskeyPatch({ item, existingFields });
  if (isKeePassLoginItem(item)) {
    const nativeOtp = existingFields ? keePassFieldValue(existingFields, "otp") : "";
    const parsedOtp = existingFields ? readKeePassEntryTotp(existingFields) : undefined;
    const previousOtp = nativeOtp.includes("://") ? nativeOtp : parsedOtp ? keePassTotpFieldsFor(parsedOtp, parsedOtp.issuer || parsedOtp.accountName).otp : undefined;
    return buildKeePassLoginPatch({ item, existingFields, preserveOtpFields: Boolean(existingFields && item.totpSecret === previousOtp), monicaLocalId: existingId(existingFields, "MonicaLocalId") });
  }
  return buildKeePassSecureItemPatch({
    item,
    existingFields,
    monicaSecureItemId: existingId(existingFields, KEEPASS_SECURE_ITEM_FIELDS.id)
  });
}

function existingId(fields: KeePassEntryFields | undefined, name: string): number | undefined {
  if (!fields) return undefined;
  const parsed = Number(keePassFieldValue(fields, name));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface KeePassWriteResult {
  entry: kdbxweb.KdbxEntry;
  created: boolean;
}

export interface PreparedKeePassEntryWrite {
  patch: KeePassFieldPatch<KeePassEntryFieldValue>;
  icon: Uint8Array | null | undefined;
}

/** Validate every write in a project before mutating any entry, history or group. */
export function prepareKeePassEntryWrite(item: VaultItem, existingFields?: KeePassEntryFields): PreparedKeePassEntryWrite {
  const patch = keePassPatchFor(item, existingFields);
  if (!patch) throw new Error(`此条目类型（${item.kind}）无法写入 KeePass 数据库。`);
  return { patch, icon: prepareKeePassCustomIcon(item) };
}

/**
 * Patches an existing entry in place, so its UUID, history, binaries and group membership are kept.
 * `pushHistory` records the pre-edit state the way KeePass clients expect, which is what lets a user
 * recover from a bad sync in KeePassXC.
 */
export function writeKeePassEntry(
  database: kdbxweb.Kdbx,
  entry: kdbxweb.KdbxEntry,
  item: VaultItem,
  prepared = prepareKeePassEntryWrite(item, entry.fields)
): KeePassWriteResult {
  const { patch, icon } = prepared;
  entry.pushHistory();
  applyPatchToEntry(entry, patch);
  applyKeePassCustomIcon(database, entry, icon);
  entry.times.update();
  database.cleanup({ historyRules: true });
  return { entry, created: false };
}

/**
 * `addEntryToGroupPath`. Missing groups along the path are created, matching Android; a blank path
 * means the root group.
 */
export function createKeePassEntry(
  database: kdbxweb.Kdbx,
  item: VaultItem,
  groupPath?: string,
  prepared = prepareKeePassEntryWrite(item)
): KeePassWriteResult {
  const { patch, icon } = prepared;
  const entry = database.createEntry(resolveKeePassGroup(database, groupPath));
  applyPatchToEntry(entry, patch);
  applyKeePassCustomIcon(database, entry, icon);
  return { entry, created: true };
}

/** kdbxweb's field map is mutated in place, so the computed map is rewritten onto it wholesale. */
function applyPatchToEntry(entry: kdbxweb.KdbxEntry, patch: KeePassFieldPatch<KeePassEntryFieldValue>): void {
  const updated = applyKeePassFieldPatch(entry.fields, patch);
  entry.fields.clear();
  for (const [name, value] of updated) {
    // XML normalizes CR and kdbxweb strips tabs/control characters from plain text.
    // KeePass protected strings encode their original UTF-8 bytes outside XML text.
    const xmlWouldChangeText = typeof value === 'string' && /[\u0000-\u0009\u000b-\u001f]/.test(value);
    entry.fields.set(name, xmlWouldChangeText ? kdbxweb.ProtectedValue.fromString(value) : value);
  }
}

/**
 * Moves the entry to the recycle bin rather than deleting it, so Monica Android still shows it in its
 * own trash. `database.remove` handles the bin's creation and the `DeletedObjects` bookkeeping.
 */
export function removeKeePassEntry(database: kdbxweb.Kdbx, entry: kdbxweb.KdbxEntry): void {
  validateKeePassEntryRemoval(database, entry);
  // Android's KeePassRecycleBinPolicy repairs disabled/missing metadata before
  // every soft delete. Kdbx.remove alone permanently removes such entries.
  database.createRecycleBin();
  if (entry.parentGroup && isInRecycleBin(database, entry.parentGroup)) return;
  database.remove(entry);
}

/** Move the existing object, retaining UUID, unknown fields, history and binaries. */
export function restoreKeePassEntry(database: kdbxweb.Kdbx, entry: kdbxweb.KdbxEntry): void {
  validateKeePassEntryRestore(database, entry);
  const previous = entry.previousParentGroup && database.getGroup(entry.previousParentGroup);
  const target = previous && !isInRecycleBin(database, previous) ? previous : database.getDefaultGroup();
  database.move(entry, target);
  entry.previousParentGroup = undefined;
}

export function validateKeePassEntryRemoval(database: kdbxweb.Kdbx, entry: kdbxweb.KdbxEntry): void {
  assertKnownKeePassType(entry.fields);
  const configured = database.meta.recycleBinUuid && database.getGroup(database.meta.recycleBinUuid);
  if (configured === database.getDefaultGroup()) throw new Error('KeePass 回收站错误地指向根目录，原始条目未删除。');
}

export function validateKeePassEntryRestore(database: kdbxweb.Kdbx, entry: kdbxweb.KdbxEntry): void {
  assertKnownKeePassType(entry.fields);
  if (!entry.parentGroup || !isInRecycleBin(database, entry.parentGroup)) throw new Error('KeePass 条目不在原生回收站中，无法恢复。');
}

export function assertKnownKeePassType(fields: KeePassEntryFields): void {
  if (isKeePassSecureItemEntry(fields) && !isKeePassPasskeyEntry(fields) && !readKeePassSecureItemFields(fields)) {
    throw new Error("未知 KeePass 项目仅可只读查看，不能编辑、转换或删除。");
  }
}

/** Each segment is matched by decoded name, since the path key is percent-encoded per segment. */
export function resolveKeePassGroup(database: kdbxweb.Kdbx, groupPath: string | undefined): kdbxweb.KdbxGroup {
  let group = database.getDefaultGroup();
  for (const segment of decodeKeePassPathSegments(groupPath)) {
    const existing = group.groups.find((child) => child.name === segment);
    group = existing ?? database.createGroup(group, segment);
  }
  return group;
}
