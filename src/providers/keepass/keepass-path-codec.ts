/**
 * Port of Android `utils/KeePassPathCodec.kt` (SHA 9930d8d8).
 *
 * A group path is stored on the item as a single string so it survives a vault round-trip, but a group
 * name may itself contain `/`. Android percent-encodes each segment before joining, and its `Uri.encode`
 * leaves exactly the same unreserved set as `encodeURIComponent` (`A-Za-z0-9-_.!~*'()`), so the two
 * agree byte for byte. The root group is never part of the path: a blank path means the root.
 */

export const KEEPASS_DISPLAY_PATH_SEPARATOR = " > ";

export function encodeKeePassPathSegment(segment: string): string {
  return encodeURIComponent(segment.trim());
}

export function buildKeePassPathKey(parentPathKey: string | undefined, segmentName: string): string {
  const parent = parentPathKey?.trim() ?? "";
  const segment = encodeKeePassPathSegment(segmentName);
  return parent ? `${parent}/${segment}` : segment;
}

export function decodeKeePassPathSegments(pathKey: string | undefined): string[] {
  if (!pathKey) return [];
  return pathKey
    .split("/")
    .map((segment) => decodeKeePassPathSegment(segment).trim())
    .filter(Boolean);
}

export function decodeKeePassPathForDisplay(pathKey: string | undefined): string {
  const segments = decodeKeePassPathSegments(pathKey);
  return segments.length ? segments.join(KEEPASS_DISPLAY_PATH_SEPARATOR) : pathKey ?? "";
}

/** A group name may legitimately contain `%`, which `decodeURIComponent` would reject. */
function decodeKeePassPathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const RECYCLE_BIN_NAMES = new Set(["recyclebin", "trash", "回收站"]);

/** Only consulted when the database metadata carries no recycle-bin UUID, matching Android. */
export function isKeePassRecycleBinPath(pathKey: string | undefined): boolean {
  return decodeKeePassPathSegments(pathKey).some((segment) =>
    RECYCLE_BIN_NAMES.has(segment.toLowerCase().replace(/\s/g, ""))
  );
}
