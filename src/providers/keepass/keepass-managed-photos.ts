/**
 * Android reserves four KDBX Binary names for the two-sided photos belonging to secure items.
 * Keep this table independent from the generic attachment codec so unknown and user-created
 * binaries remain ordinary attachments.
 */

export type KeePassManagedPhotoKind = "card" | "identity";
export type KeePassManagedPhotoSlotId = "front" | "back";

export interface KeePassManagedPhotoSlot {
  readonly id: KeePassManagedPhotoSlotId;
  readonly label: string;
  readonly fileName: string;
  readonly mediaType: "image/jpeg";
}
const MANAGED_PHOTO_SLOTS: Readonly<Record<KeePassManagedPhotoKind, readonly KeePassManagedPhotoSlot[]>> = {
  card: Object.freeze([
    Object.freeze({ id: "front", label: "正面照片", fileName: "Monica_BankCard_Front.jpg", mediaType: "image/jpeg" as const }),
    Object.freeze({ id: "back", label: "背面照片", fileName: "Monica_BankCard_Back.jpg", mediaType: "image/jpeg" as const })
  ]),
  identity: Object.freeze([
    Object.freeze({ id: "front", label: "正面照片", fileName: "Monica_Document_Front.jpg", mediaType: "image/jpeg" as const }),
    Object.freeze({ id: "back", label: "背面照片", fileName: "Monica_Document_Back.jpg", mediaType: "image/jpeg" as const })
  ])
};

/** Returns the Android-managed slots for a secure-item kind. */
export function keepassManagedPhotoSlots(kind: string): readonly KeePassManagedPhotoSlot[] {
  return kind in MANAGED_PHOTO_SLOTS
    ? MANAGED_PHOTO_SLOTS[kind as KeePassManagedPhotoKind]
    : [];
}

/** Resolves a reserved file name without accepting a case-folded or unrelated binary. */
export function keepassManagedPhotoSlotForFileName(
  kind: string,
  fileName: string
): KeePassManagedPhotoSlot | undefined {
  return keepassManagedPhotoSlots(kind).find((slot) => slot.fileName === fileName);
}
