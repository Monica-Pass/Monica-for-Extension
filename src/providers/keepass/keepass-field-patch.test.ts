import { describe, expect, it } from "vitest";
import { applyKeePassFieldPatch, createKeePassFieldPatch, keePassFieldPatchBaseValues } from "./keepass-field-patch";
import {
  isPasskeyEntryOverlayField,
  isPasswordEntryOverlayField,
  isSecureItemOverlayField
} from "./keepass-field-registry";

/** Assertion semantics translated from Android `KeePassEntryFieldPatchTest.kt`. */
function patchWith(replacements: Record<string, string>, removeManagedField: (name: string) => boolean) {
  const replacementFields = new Map(Object.entries(replacements));
  return createKeePassFieldPatch(replacementFields, removeManagedField, replacementFields.keys());
}

describe("applyKeePassFieldPatch", () => {
  it("preserves TOTP, unknown and plugin fields when a password entry is rewritten", () => {
    const fields = new Map(Object.entries({
      Title: "Old title",
      Password: "old",
      otp: "otpauth://totp/GitHub:user?secret=ABC",
      "Security question": "First pet?",
      _etm_template: "1"
    }));

    const patched = applyKeePassFieldPatch(fields, patchWith({ Title: "New title", Password: "new" }, isPasswordEntryOverlayField));

    expect(Object.fromEntries(patched)).toEqual({
      Title: "New title",
      Password: "new",
      otp: "otpauth://totp/GitHub:user?secret=ABC",
      "Security question": "First pet?",
      _etm_template: "1"
    });
  });

  it("keeps untouched standard fields when only the title and notes change", () => {
    const fields = new Map(Object.entries({
      Title: "Old title",
      UserName: "old-user",
      Password: "old",
      URL: "https://example.com",
      Notes: "old notes",
      "TOTP Seed": "JBSWY3DPEHPK3PXP",
      "TOTP Settings": "period=30;digits=6;algorithm=SHA1",
      "HOTP Counter": "7",
      "Recovery Code": "must-stay-secret",
      "External Unknown Field": "must stay",
      _etm_plugin_state: "must stay too"
    }));

    const patched = applyKeePassFieldPatch(fields, patchWith({ Title: "Renamed title", Notes: "new notes" }, isPasswordEntryOverlayField));

    expect(patched.get("Title")).toBe("Renamed title");
    expect(patched.get("Notes")).toBe("new notes");
    expect(patched.get("UserName")).toBe("old-user");
    expect(patched.get("Password")).toBe("old");
    expect(patched.get("URL")).toBe("https://example.com");
    expect(patched.get("TOTP Seed")).toBe("JBSWY3DPEHPK3PXP");
    expect(patched.get("TOTP Settings")).toBe("period=30;digits=6;algorithm=SHA1");
    expect(patched.get("HOTP Counter")).toBe("7");
    expect(patched.get("Recovery Code")).toBe("must-stay-secret");
    expect(patched.get("External Unknown Field")).toBe("must stay");
    expect(patched.get("_etm_plugin_state")).toBe("must stay too");
  });

  it("does not delete external unknown fields on a secure item", () => {
    const fields = new Map(Object.entries({
      Title: "Old card",
      "Card Number": "4111111111111111",
      "External KeePass field": "must stay"
    }));

    const patched = applyKeePassFieldPatch(
      fields,
      patchWith({ Title: "New card", "Card Number": "5555555555554444" }, isSecureItemOverlayField)
    );

    expect(patched.get("Title")).toBe("New card");
    expect(patched.get("Card Number")).toBe("5555555555554444");
    expect(patched.get("External KeePass field")).toBe("must stay");
  });

  it("replaces passkey compat fields while preserving external plugin state", () => {
    const fields = new Map(Object.entries({
      Title: "Old passkey",
      MonicaPasskeyData: "old-json",
      KPEX_PASSKEY_CREDENTIAL_ID: "old-credential",
      "External plugin state": "must stay"
    }));

    const patched = applyKeePassFieldPatch(
      fields,
      patchWith(
        { Title: "New passkey", MonicaPasskeyData: "new-json", KPEX_PASSKEY_CREDENTIAL_ID: "new-credential" },
        isPasskeyEntryOverlayField
      )
    );

    expect(patched.get("Title")).toBe("New passkey");
    expect(patched.get("MonicaPasskeyData")).toBe("new-json");
    expect(patched.get("KPEX_PASSKEY_CREDENTIAL_ID")).toBe("new-credential");
    expect(patched.get("External plugin state")).toBe("must stay");
  });

  it("drops a Monica-owned overlay field the new projection no longer sets", () => {
    const fields = new Map(Object.entries({ Title: "t", MonicaSsoRefEntryId: "stale", "Security question": "keep" }));

    const patched = applyKeePassFieldPatch(fields, patchWith({ Title: "t2" }, isPasswordEntryOverlayField));

    expect(patched.has("MonicaSsoRefEntryId")).toBe(false);
    expect(patched.get("Security question")).toBe("keep");
  });

  it("never drops a standard field even when the overlay list names it", () => {
    // `Title` and `Password` are in the overlay set but are STANDARD, not Monica-owned, so the second
    // gate in shouldRemoveManagedField keeps them. Only an explicit replacement may change them.
    const fields = new Map(Object.entries({ Title: "keep", Password: "keep-too" }));

    const patched = applyKeePassFieldPatch(fields, patchWith({ Notes: "n" }, isPasswordEntryOverlayField));

    expect(patched.get("Title")).toBe("keep");
    expect(patched.get("Password")).toBe("keep-too");
    expect(patched.get("Notes")).toBe("n");
  });

  it("removes an explicitly named field case-insensitively and keeps the original field order", () => {
    const fields = new Map(Object.entries({ Title: "t", UserName: "u", Notes: "n" }));

    const patched = applyKeePassFieldPatch(fields, createKeePassFieldPatch(new Map(), isPasswordEntryOverlayField, ["  username  "]));

    expect([...patched.keys()]).toEqual(["Title", "Notes"]);
  });

  it("appends a brand new field after the survivors instead of reordering them", () => {
    const fields = new Map(Object.entries({ Title: "t", "Security question": "keep" }));

    const patched = applyKeePassFieldPatch(fields, patchWith({ Notes: "new" }, isPasswordEntryOverlayField));

    expect([...patched.keys()]).toEqual(["Title", "Security question", "Notes"]);
  });

  it("does not mutate the entry it patches", () => {
    const fields = new Map(Object.entries({ Title: "t" }));

    applyKeePassFieldPatch(fields, patchWith({ Title: "t2", Notes: "n" }, isPasswordEntryOverlayField));

    expect(Object.fromEntries(fields)).toEqual({ Title: "t" });
  });
});

describe("keePassFieldPatchBaseValues", () => {
  it("snapshots every touched field with its existing casing and presence", () => {
    const fields = new Map(Object.entries({ Title: "old", MonicaLocalId: "42", "Security question": "keep" }));

    const base = keePassFieldPatchBaseValues(fields, patchWith({ title: "new", Notes: "added" }, isPasswordEntryOverlayField));

    expect(base).toEqual([
      { name: "Title", value: "old", present: true },
      { name: "Notes", present: false },
      { name: "MonicaLocalId", value: "42", present: true }
    ]);
  });

  it("ignores fields the patch never touches", () => {
    const fields = new Map(Object.entries({ Title: "old", otp: "secret" }));

    const base = keePassFieldPatchBaseValues(fields, patchWith({ Title: "new" }, isPasswordEntryOverlayField));

    expect(base.map((value) => value.name)).toEqual(["Title"]);
  });
});
