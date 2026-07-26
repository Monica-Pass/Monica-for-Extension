import * as kdbxweb from "kdbxweb";
import type { VaultItem } from "../../core/model";
import { applyKeePassFieldPatch, type KeePassFieldPatch } from "./keepass-field-patch";
import {
  buildKeePassLoginPatch,
  isKeePassLoginItem,
  keePassFieldValue,
  type KeePassEntryFieldValue,
  type KeePassEntryFields
} from "./keepass-login-codec";
import { buildKeePassPasskeyPatch } from "./keepass-passkey-codec";
import { decodeKeePassPathSegments } from "./keepass-path-codec";
import { buildKeePassSecureItemPatch, KEEPASS_SECURE_ITEM_FIELDS } from "./keepass-secure-item-codec";

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
  if (item.kind === "passkey") return buildKeePassPasskeyPatch({ item, existingFields });
  if (isKeePassLoginItem(item)) {
    return buildKeePassLoginPatch({ item, monicaLocalId: existingId(existingFields, "MonicaLocalId") });
  }
  return buildKeePassSecureItemPatch({
    item,
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

/**
 * Patches an existing entry in place, so its UUID, history, binaries and group membership are kept.
 * `pushHistory` records the pre-edit state the way KeePass clients expect, which is what lets a user
 * recover from a bad sync in KeePassXC.
 */
export function writeKeePassEntry(
  database: kdbxweb.Kdbx,
  entry: kdbxweb.KdbxEntry,
  item: VaultItem
): KeePassWriteResult {
  const patch = keePassPatchFor(item, entry.fields);
  if (!patch) throw new Error(`此条目类型（${item.kind}）无法写入 KeePass 数据库。`);

  entry.pushHistory();
  applyPatchToEntry(entry, patch);
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
  groupPath?: string
): KeePassWriteResult {
  const patch = keePassPatchFor(item);
  if (!patch) throw new Error(`此条目类型（${item.kind}）无法写入 KeePass 数据库。`);

  const entry = database.createEntry(resolveKeePassGroup(database, groupPath));
  applyPatchToEntry(entry, patch);
  return { entry, created: true };
}

/** kdbxweb's field map is mutated in place, so the computed map is rewritten onto it wholesale. */
function applyPatchToEntry(entry: kdbxweb.KdbxEntry, patch: KeePassFieldPatch<KeePassEntryFieldValue>): void {
  const updated = applyKeePassFieldPatch(entry.fields, patch);
  entry.fields.clear();
  for (const [name, value] of updated) entry.fields.set(name, value);
}

/**
 * Moves the entry to the recycle bin rather than deleting it, so Monica Android still shows it in its
 * own trash. `database.remove` handles the bin's creation and the `DeletedObjects` bookkeeping.
 */
export function removeKeePassEntry(database: kdbxweb.Kdbx, entry: kdbxweb.KdbxEntry): void {
  database.remove(entry);
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
