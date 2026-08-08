import { describe, expect, it } from "vitest";
import {
  keepassManagedPhotoSlotForFileName,
  keepassManagedPhotoSlots
} from "./keepass-managed-photos";

describe("KeePass Android managed secure-item photos", () => {
  it("uses Android's exact bank-card and document binary names", () => {
    expect(keepassManagedPhotoSlots("card").map((slot) => slot.fileName)).toEqual([
      "Monica_BankCard_Front.jpg",
      "Monica_BankCard_Back.jpg"
    ]);
    expect(keepassManagedPhotoSlots("identity").map((slot) => slot.fileName)).toEqual([
      "Monica_Document_Front.jpg",
      "Monica_Document_Back.jpg"
    ]);
  });

  it("maps a reserved name only for its owning item kind", () => {
    expect(keepassManagedPhotoSlotForFileName("card", "Monica_BankCard_Front.jpg")?.id).toBe("front");
    expect(keepassManagedPhotoSlotForFileName("identity", "Monica_BankCard_Front.jpg")).toBeUndefined();
    expect(keepassManagedPhotoSlotForFileName("card", "monica_bankcard_front.jpg")).toBeUndefined();
    expect(keepassManagedPhotoSlots("login")).toEqual([]);
  });

  it("marks managed photos as JPEG uploads for the Android contract", () => {
    for (const kind of ["card", "identity"]) {
      expect(keepassManagedPhotoSlots(kind).every((slot) => slot.mediaType === "image/jpeg")).toBe(true);
    }
  });
});
