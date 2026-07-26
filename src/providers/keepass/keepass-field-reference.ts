import { keePassFieldText, type KeePassEntryFieldValue, type KeePassEntryFields } from "./keepass-login-codec";

/**
 * Port of Android `utils/KeePassFieldReferenceResolver.kt` (SHA 9930d8d8).
 *
 * KeePass lets one entry quote another: `{REF:U@I:5A2B…}` in a `UserName` field means "the UserName of
 * the entry with that UUID". Without this, such an entry imports with the literal `{REF:…}` text as its
 * username and autofill types braces into the login form.
 *
 * `T/U/P/A/N` name the five standard fields, `I` is the UUID and `O` means "any non-standard field".
 * Recursion is bounded at depth 8 and a token already expanded on the path is left as written, so a
 * pair of entries quoting each other terminates instead of looping.
 */

export interface KeePassReferenceEntry {
  uuid: string;
  fields: KeePassEntryFields;
}

export interface KeePassReferenceContext {
  entries: KeePassReferenceEntry[];
  entriesByNormalizedUuid: Map<string, KeePassReferenceEntry[]>;
}

const MAX_DEPTH = 8;
const REFERENCE_PATTERN = /\{REF:([A-Za-z])@([A-Za-z]):([^}]+)\}/gi;
const STANDARD_FIELD_BY_CODE: Record<string, string> = { T: "Title", U: "UserName", P: "Password", A: "URL", N: "Notes" };
const STANDARD_FIELD_NAMES = new Set(Object.values(STANDARD_FIELD_BY_CODE));

export function buildKeePassReferenceContext(entries: Iterable<KeePassReferenceEntry>): KeePassReferenceContext {
  const list = [...entries];
  const entriesByNormalizedUuid = new Map<string, KeePassReferenceEntry[]>();
  for (const entry of list) {
    const key = normalizeUuid(entry.uuid);
    const bucket = entriesByNormalizedUuid.get(key);
    if (bucket) bucket.push(entry);
    else entriesByNormalizedUuid.set(key, [entry]);
  }
  return { entries: list, entriesByNormalizedUuid };
}

/**
 * Returns the entry's fields with every `{REF:…}` expanded. A field with no reference keeps its exact
 * value object, so a `ProtectedValue` is not silently downgraded to a plain string by being resolved.
 */
export function resolveKeePassEntryFields(
  entry: KeePassReferenceEntry,
  context: KeePassReferenceContext | undefined
): Map<string, KeePassEntryFieldValue> {
  const resolved = new Map<string, KeePassEntryFieldValue>();
  for (const [name, value] of entry.fields) {
    const raw = keePassFieldText(value);
    const expanded = resolveKeePassReferenceValue(raw, entry, context);
    resolved.set(name, expanded === raw ? value : expanded);
  }
  return resolved;
}

export function resolveKeePassReferenceValue(
  rawValue: string,
  currentEntry: KeePassReferenceEntry,
  context: KeePassReferenceContext | undefined
): string {
  return resolveInternal(rawValue, currentEntry, context, new Set(), 0);
}

function resolveInternal(
  rawValue: string,
  currentEntry: KeePassReferenceEntry,
  context: KeePassReferenceContext | undefined,
  visited: ReadonlySet<string>,
  depth: number
): string {
  if (!rawValue.trim() || !context || depth >= MAX_DEPTH || !rawValue.toUpperCase().includes("{REF:")) return rawValue;

  return rawValue.replace(REFERENCE_PATTERN, (token, targetCode: string, searchCode: string, searchText: string) => {
    const tokenKey = `${currentEntry.uuid}:${token.toUpperCase()}`;
    if (visited.has(tokenKey)) return token;
    const nextVisited = new Set(visited).add(tokenKey);
    const resolvedSearch = resolveInternal(searchText, currentEntry, context, nextVisited, depth + 1);
    const matched = findReferencedEntry(searchCode.toUpperCase(), resolvedSearch, context, nextVisited, depth + 1);
    if (!matched) return token;
    return resolveReferenceField(matched, targetCode.toUpperCase(), context, nextVisited, depth + 1) ?? token;
  });
}

function findReferencedEntry(
  searchCode: string,
  searchText: string,
  context: KeePassReferenceContext,
  visited: ReadonlySet<string>,
  depth: number
): KeePassReferenceEntry | undefined {
  if (!searchText.trim()) return undefined;
  if (searchCode === "I") return context.entriesByNormalizedUuid.get(normalizeUuid(searchText))?.[0];
  if (!"TUPANO".includes(searchCode)) return undefined;
  return context.entries.find((entry) =>
    searchValuesOf(entry, searchCode, context, visited, depth).some((candidate) => candidate.toLowerCase() === searchText.toLowerCase())
  );
}

function resolveReferenceField(
  entry: KeePassReferenceEntry,
  targetCode: string,
  context: KeePassReferenceContext,
  visited: ReadonlySet<string>,
  depth: number
): string | undefined {
  if (targetCode === "I") return entry.uuid;
  if (targetCode === "O") return otherFieldValues(entry, context, visited, depth)[0];
  const fieldName = STANDARD_FIELD_BY_CODE[targetCode];
  if (!fieldName) return undefined;
  return resolveInternal(rawFieldValue(entry, fieldName), entry, context, visited, depth);
}

function searchValuesOf(
  entry: KeePassReferenceEntry,
  code: string,
  context: KeePassReferenceContext,
  visited: ReadonlySet<string>,
  depth: number
): string[] {
  if (code === "I") return [entry.uuid];
  if (code === "O") return otherFieldValues(entry, context, visited, depth);
  const fieldName = STANDARD_FIELD_BY_CODE[code];
  if (!fieldName) return [];
  return [resolveInternal(rawFieldValue(entry, fieldName), entry, context, visited, depth)].filter((value) => value.trim());
}

/** `O` searches every field that is neither one of the five standard names nor a `_etm_` plugin field. */
function otherFieldValues(
  entry: KeePassReferenceEntry,
  context: KeePassReferenceContext,
  visited: ReadonlySet<string>,
  depth: number
): string[] {
  const values: string[] = [];
  for (const [name, value] of entry.fields) {
    if (STANDARD_FIELD_NAMES.has(name) || name.startsWith("_etm_")) continue;
    const resolved = resolveInternal(keePassFieldText(value), entry, context, visited, depth);
    if (resolved.trim()) values.push(resolved);
  }
  return values;
}

/** Exact key lookup, matching Kotlin's `entry.fields[key]`; the ignore-case pass lives in the codecs. */
function rawFieldValue(entry: KeePassReferenceEntry, name: string): string {
  return keePassFieldText(entry.fields.get(name));
}

/** Kotlin's `trim('{', '}')` strips every leading and trailing brace, not just one. */
export function normalizeUuid(value: string): string {
  return value.trim().replace(/^[{}]+|[{}]+$/g, "").replace(/-/g, "").toLowerCase();
}
