import { keePassFieldRoleOf, normalizeKeePassFieldName } from "./keepass-field-registry";

/**
 * 1:1 port of Android `keepass/KeePassEntryFieldPatch.kt` (SHA 9930d8d8).
 *
 * This is the compatibility linchpin for KDBX write-back. A KeePass entry may carry fields written by
 * KeePassXC, KeePassDX plugins, TOTP tooling or a future Monica release. Monica may only replace the
 * fields it declares as its own for the given entry shape; everything else has to survive byte-for-byte,
 * including its original name casing and position in the field order.
 *
 * The value type is generic so the rule can be tested without constructing a `KdbxEntry`: callers pass
 * `string | ProtectedValue` from kdbxweb, tests pass plain strings.
 */
export interface KeePassFieldPatch<V> {
  /** Written last, so a replacement always wins over a same-named survivor. */
  replacementFields: ReadonlyMap<string, V>;
  /**
   * Decides whether a *Monica-owned* field of this entry shape should be dropped when absent from the
   * replacement set. Pass one of the registry's `is*OverlayField` predicates.
   */
  removeManagedField: (name: string) => boolean;
  /** Explicit removals, matched case-insensitively. Blank names are ignored. */
  removeFieldNames: ReadonlySet<string>;
}

export function createKeePassFieldPatch<V>(
  replacementFields: ReadonlyMap<string, V>,
  removeManagedField: (name: string) => boolean,
  removeFieldNames: Iterable<string> = []
): KeePassFieldPatch<V> {
  const names = new Set<string>();
  for (const name of removeFieldNames) {
    const trimmed = name.trim();
    if (trimmed) names.add(trimmed);
  }
  return { replacementFields, removeManagedField, removeFieldNames: names };
}

/**
 * A field is only removable when the caller's overlay predicate claims it *and* the registry agrees it
 * is Monica-owned. Without the second test an overlay list that happens to contain `Title` or `otp`
 * would delete another client's data.
 */
function shouldRemoveManagedField<V>(patch: KeePassFieldPatch<V>, name: string): boolean {
  if (!patch.removeManagedField(name)) return false;
  const role = keePassFieldRoleOf(name);
  return role === "monica-password" || role === "monica-secure-item" || role === "monica-passkey";
}

/** Returns a new field map; the input is never mutated. Insertion order follows Android's `LinkedHashMap`. */
export function applyKeePassFieldPatch<V>(fields: ReadonlyMap<string, V>, patch: KeePassFieldPatch<V>): Map<string, V> {
  const removeKeys = new Set<string>();
  for (const name of patch.removeFieldNames) removeKeys.add(normalizeKeePassFieldName(name));

  const updated = new Map<string, V>();
  for (const [name, value] of fields) {
    const removed = removeKeys.has(normalizeKeePassFieldName(name)) || shouldRemoveManagedField(patch, name);
    if (!removed) updated.set(name, value);
  }
  for (const [name, value] of patch.replacementFields) updated.set(name, value);
  return updated;
}

export interface KeePassFieldBaseValue<V> {
  /** The name as it exists in the entry today, so a later apply matches the original casing. */
  name: string;
  value?: V;
  present: boolean;
}

/**
 * Snapshots every field this patch is about to touch, before it touches it. The sync path compares this
 * against the live entry to detect a concurrent remote edit instead of blindly overwriting one.
 */
export function keePassFieldPatchBaseValues<V>(
  fields: ReadonlyMap<string, V>,
  patch: KeePassFieldPatch<V>
): KeePassFieldBaseValue<V>[] {
  const explicitRemoveKeys = new Set<string>();
  for (const name of patch.removeFieldNames) explicitRemoveKeys.add(normalizeKeePassFieldName(name));

  const touched = new Set<string>();
  for (const name of patch.replacementFields.keys()) touched.add(name);
  for (const name of patch.removeFieldNames) touched.add(name);
  for (const name of fields.keys()) {
    if (patch.removeManagedField(name) || explicitRemoveKeys.has(normalizeKeePassFieldName(name))) touched.add(name);
  }

  const existingByKey = new Map<string, [string, V]>();
  for (const [name, value] of fields) existingByKey.set(normalizeKeePassFieldName(name), [name, value]);

  const seen = new Set<string>();
  const result: KeePassFieldBaseValue<V>[] = [];
  for (const raw of touched) {
    const name = raw.trim();
    if (!name) continue;
    const key = normalizeKeePassFieldName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = existingByKey.get(key);
    result.push(existing ? { name: existing[0], value: existing[1], present: true } : { name, present: false });
  }
  return result;
}
