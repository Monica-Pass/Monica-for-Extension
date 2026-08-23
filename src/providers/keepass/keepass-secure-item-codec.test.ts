import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import {
  buildKeePassSecureItemFields,
  buildKeePassSecureItemPatch,
  isKeePassSecureItemEntry,
  keePassSecureItemToVaultItem,
  readKeePassSecureItemCustomFields,
  readKeePassSecureItemFields
} from "./keepass-secure-item-codec";
import { applyKeePassFieldPatch } from "./keepass-field-patch";
import { keePassFieldText, type KeePassEntryFieldValue } from "./keepass-login-codec";
import type { CardItem, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";
import type { MonicaItemBase } from "../monica-item-data";

/** Assertion semantics translated from the Android secure-item paths in `KeePassKdbxService.kt`. */
function fields(entries: Record<string, string | kdbxweb.ProtectedValue>): Map<string, KeePassEntryFieldValue> {
  return new Map(Object.entries(entries));
}

function secret(value: string): kdbxweb.ProtectedValue {
  return kdbxweb.ProtectedValue.fromString(value);
}

function base(overrides: Partial<MonicaItemBase> = {}): MonicaItemBase {
  return {
    id: "item-1",
    title: "placeholder",
    favorite: false,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    providerRefs: [],
    ...overrides
  } as MonicaItemBase;
}

function card(overrides: Partial<CardItem> = {}): CardItem {
  return {
    ...base(),
    kind: "card",
    title: "Visa",
    cardholderName: "ALICE LIU",
    number: "4111111111111111",
    expiryMonth: "08",
    expiryYear: "2029",
    securityCode: "123",
    customFields: [],
    ...overrides
  } as CardItem;
}

function totp(overrides: Partial<TotpItem> = {}): TotpItem {
  return {
    ...base(),
    kind: "totp",
    title: "GitHub",
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    ...overrides
  } as TotpItem;
}

function note(overrides: Partial<SecureNoteItem> = {}): SecureNoteItem {
  return {
    ...base(),
    kind: "secure-note",
    title: "备忘",
    content: "hello",
    tags: [],
    isMarkdown: false,
    ...overrides
  } as SecureNoteItem;
}

describe("isKeePassSecureItemEntry", () => {
  it("claims only an entry that declares MonicaItemType", () => {
    expect(isKeePassSecureItemEntry(fields({ Title: "Visa", MonicaItemType: "BANK_CARD" }))).toBe(true);
    expect(isKeePassSecureItemEntry(fields({ Title: "GitHub", UserName: "alice" }))).toBe(false);
  });
});

describe("readKeePassSecureItemFields", () => {
  it("decodes the MonicaItemData payload of a note", () => {
    const projection = readKeePassSecureItemFields(
      fields({
        Title: "备忘",
        Notes: "外部可读正文",
        MonicaItemType: "NOTE",
        MonicaItemData: secret(JSON.stringify({ content: "真正文", isMarkdown: true })),
        MonicaIsFavorite: "true",
        MonicaSecureItemId: "42"
      })
    );

    expect(projection).toMatchObject({ itemType: "NOTE", title: "备忘", isFavorite: true, monicaSecureItemId: 42 });
    expect(projection!.itemData).toEqual({ content: "真正文", isMarkdown: true });
  });

  it("skips an entry whose MonicaItemType this build does not know, rather than guessing a type", () => {
    expect(readKeePassSecureItemFields(fields({ Title: "x", MonicaItemType: "CRYPTO_SEED", MonicaItemData: secret("{}") }))).toBeUndefined();
  });

  it("skips a declared secure item that carries no data at all", () => {
    expect(readKeePassSecureItemFields(fields({ Title: "x", MonicaItemType: "DOCUMENT" }))).toBeUndefined();
  });

  it("falls back to Untitled the way Android does", () => {
    const projection = readKeePassSecureItemFields(fields({ MonicaItemType: "NOTE", MonicaItemData: secret('{"content":"x"}') }));

    expect(projection!.title).toBe("Untitled");
  });

  it("treats MonicaIsFavorite with Kotlin toBoolean semantics, so only true is true", () => {
    const read = (value: string) =>
      readKeePassSecureItemFields(fields({ MonicaItemType: "NOTE", MonicaItemData: secret('{"content":"x"}'), MonicaIsFavorite: value }))!.isFavorite;

    expect(read("TRUE")).toBe(true);
    expect(read("1")).toBe(false);
    expect(read("yes")).toBe(false);
  });

  it("reads MonicaImagePaths as a JSON array and as a single bare path", () => {
    const read = (value: string) =>
      readKeePassSecureItemFields(fields({ MonicaItemType: "NOTE", MonicaItemData: secret('{"content":"x"}'), MonicaImagePaths: value }))!.imagePaths;

    expect(read('["a.enc","b.enc","a.enc"]')).toEqual(["a.enc", "b.enc"]);
    expect(read("only.enc")).toEqual(["only.enc"]);
    expect(read("")).toEqual([]);
  });

  it("reconstructs a bank card from the labelled fields when MonicaItemData is absent", () => {
    const projection = readKeePassSecureItemFields(
      fields({
        Title: "Visa",
        MonicaItemType: "BANK_CARD",
        "Card Number": secret("4111111111111111"),
        "Card Holder": "ALICE LIU",
        "Card Expiry": "08/2029",
        "Card CVV": secret("123"),
        "Card Type": "debit card",
        "Recovery code": secret("ABCD")
      })
    );

    expect(projection!.itemData).toMatchObject({
      cardNumber: "4111111111111111",
      cardholderName: "ALICE LIU",
      expiryMonth: "08",
      expiryYear: "2029",
      cvv: "123",
      cardType: "DEBIT"
    });
    expect(projection!.itemData.customFields).toEqual([{ label: "Recovery code", value: "ABCD", type: "HIDDEN" }]);
  });

  it("prefers the explicit Expiry Month/Year over the combined Card Expiry", () => {
    const projection = readKeePassSecureItemFields(
      fields({ MonicaItemType: "BANK_CARD", "Expiry Month": "01", "Expiry Year": "2030", "Card Expiry": "08/2029" })
    );

    expect(projection!.itemData).toMatchObject({ expiryMonth: "01", expiryYear: "2030" });
  });

  it("reads a lone expiry token as the year, since a bare 2027 cannot be a month", () => {
    const projection = readKeePassSecureItemFields(fields({ MonicaItemType: "BANK_CARD", "Card Expiry": "2027" }));

    expect(projection!.itemData).toMatchObject({ expiryMonth: "", expiryYear: "2027" });
  });

  it("skips a BANK_CARD entry with no card content, so an empty template does not import", () => {
    expect(readKeePassSecureItemFields(fields({ Title: "Credit Card", MonicaItemType: "BANK_CARD" }))).toBeUndefined();
  });

  it("does not reconstruct any type other than a bank card", () => {
    expect(readKeePassSecureItemFields(fields({ MonicaItemType: "DOCUMENT", "Document Number": "E12345" }))).toBeUndefined();
  });

  it("imports a KeePassXC otp entry that never heard of Monica", () => {
    const projection = readKeePassSecureItemFields(
      fields({ Title: "GitHub", UserName: "alice", otp: secret("otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&period=60") })
    );

    expect(projection).toMatchObject({ itemType: "TOTP", title: "GitHub" });
    expect(projection!.itemData).toMatchObject({ secret: "JBSWY3DPEHPK3PXP", period: 60, accountName: "alice" });
  });

  it("titles a bare TOTP entry from its issuer when the entry has no Title", () => {
    const projection = readKeePassSecureItemFields(fields({ otp: secret("otpauth://totp/Okta:bob?secret=JBSWY3DPEHPK3PXP") }));

    expect(projection!.title).toBe("Okta");
  });

  it("leaves an ordinary login alone", () => {
    expect(readKeePassSecureItemFields(fields({ Title: "GitHub", UserName: "alice", Password: secret("hunter2") }))).toBeUndefined();
  });
});

describe("keePassSecureItemToVaultItem", () => {
  it("lets the entry own the title, notes and favourite flag", () => {
    const projection = readKeePassSecureItemFields(
      fields({ Title: "工资卡", Notes: "备注", MonicaItemType: "NOTE", MonicaItemData: secret('{"content":"正文"}'), MonicaIsFavorite: "true" })
    );

    const item = keePassSecureItemToVaultItem(projection!, base({ title: "stale", favorite: false })) as SecureNoteItem;

    expect(item).toMatchObject({ kind: "secure-note", title: "工资卡", notes: "备注", favorite: true, content: "正文" });
  });

  it("keeps the caller's imagePaths when the entry carried none", () => {
    const projection = readKeePassSecureItemFields(fields({ MonicaItemType: "NOTE", MonicaItemData: secret('{"content":"x"}') }));

    const item = keePassSecureItemToVaultItem(projection!, base({ imagePaths: ["kept.enc"] }));

    expect(item!.imagePaths).toEqual(["kept.enc"]);
  });

  it("round-trips a card through the labelled fields", () => {
    const written = buildKeePassSecureItemFields({ item: card({ bankName: "招商银行", cardType: "PREPAID" }) })!;

    const item = keePassSecureItemToVaultItem(readKeePassSecureItemFields(written)!, base()) as CardItem;

    expect(item).toMatchObject({
      kind: "card",
      number: "4111111111111111",
      cardholderName: "ALICE LIU",
      expiryMonth: "08",
      expiryYear: "2029",
      securityCode: "123",
      bankName: "招商银行",
      cardType: "PREPAID"
    });
  });

  it("round-trips Android note custom fields through protected MonicaItemData", () => {
    const original = note({
      customFields: [
        { name: "Recovery code", value: "ABCD", protected: true, fieldType: "HIDDEN" },
        { name: "Pinned", value: "true", protected: false, fieldType: "BOOLEAN" }
      ]
    });

    const written = buildKeePassSecureItemFields({ item: original })!;
    const payload = JSON.parse(keePassFieldText(written.get("MonicaItemData")));
    expect(payload.customFields).toEqual([
      { label: "Recovery code", value: "ABCD", type: "HIDDEN" },
      { label: "Pinned", value: "true", type: "BOOLEAN" }
    ]);

    const restored = keePassSecureItemToVaultItem(readKeePassSecureItemFields(written)!, base()) as SecureNoteItem;
    expect(restored.customFields).toEqual(original.customFields);
  });
});

describe("buildKeePassSecureItemFields", () => {
  it("writes the five standard fields plus the Monica metadata, with an empty protected Password", () => {
    const written = buildKeePassSecureItemFields({ item: note() })!;

    expect([...written.keys()].slice(0, 8)).toEqual([
      "Title", "UserName", "Password", "URL", "Notes", "MonicaItemType", "MonicaImagePaths", "MonicaIsFavorite"
    ]);
    expect(written.get("UserName")).toBe("");
    expect(written.get("URL")).toBe("");
    expect(keePassFieldText(written.get("Password"))).toBe("");
    expect(written.get("Password")).toBeInstanceOf(kdbxweb.ProtectedValue);
  });

  it("returns undefined for a kind that has no MonicaItemType", () => {
    expect(buildKeePassSecureItemFields({ item: { ...base(), kind: "login" } as VaultItem })).toBeUndefined();
  });

  it("protects MonicaItemData, which holds the whole payload", () => {
    const written = buildKeePassSecureItemFields({ item: note() })!;

    expect(written.get("MonicaItemData")).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(JSON.parse(keePassFieldText(written.get("MonicaItemData")))).toMatchObject({ content: "hello" });
  });

  it("degrades an inline monica-image reference so KeePassXC does not show a broken link", () => {
    const written = buildKeePassSecureItemFields({ item: note({ content: "see ![封面](monica-image://abc123) here" }) })!;

    expect(written.get("Notes")).toBe("see [封面:abc123] here");
    expect(JSON.parse(keePassFieldText(written.get("MonicaItemData"))).content).toBe("see ![封面](monica-image://abc123) here");
  });

  it("writes a bank card as labelled fields instead of MonicaItemData", () => {
    const written = buildKeePassSecureItemFields({ item: card() })!;

    expect(written.has("MonicaItemData")).toBe(false);
    expect(written.get("Card Number")).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(written.get("Card CVV")).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(written.get("Card Holder")).toBe("ALICE LIU");
    expect(written.get("Card Type")).toBe("CREDIT");
  });

  it("protects the card secrets Android protects and leaves the rest plain", () => {
    const written = buildKeePassSecureItemFields({
      item: card({ pin: "4821", iban: "DE89", swiftBic: "DEUTDEFF", routingNumber: "011", accountNumber: "999", branchCode: "001", currency: "CNY" })
    })!;

    for (const name of ["PIN", "IBAN", "SWIFT/BIC", "Routing Number", "Account Number"]) {
      expect(written.get(name), name).toBeInstanceOf(kdbxweb.ProtectedValue);
    }
    expect(written.get("Branch Code")).toBe("001");
    expect(written.get("Currency")).toBe("CNY");
  });

  it("omits a blank card field instead of writing an empty string", () => {
    const written = buildKeePassSecureItemFields({ item: card({ bankName: "", brand: "  " }) })!;

    expect(written.has("Bank Name")).toBe(false);
    expect(written.has("Brand")).toBe(false);
  });

  it("renders a structured billing address the way Android formats it for display", () => {
    const billingAddress = JSON.stringify({ streetAddress: "1 Main St", apartment: "Apt 2", city: "Hangzhou", stateProvince: "ZJ", postalCode: "310000", country: "CN" });
    const written = buildKeePassSecureItemFields({ item: card({ billingAddress }) })!;

    expect(written.get("Billing Address")).toBe("1 Main St\nApt 2\nHangzhou, ZJ\n310000 CN");
  });

  it("passes a hand-typed billing address through untouched", () => {
    const written = buildKeePassSecureItemFields({ item: card({ billingAddress: "随便写的地址" }) })!;

    expect(written.get("Billing Address")).toBe("随便写的地址");
  });

  it("writes the KeePass TOTP fields for an authenticator, protecting only otp and the seed", () => {
    const written = buildKeePassSecureItemFields({ item: totp({ period: 60 }) })!;

    expect(written.get("otp")).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(written.get("TOTP Seed")).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(written.get("TOTP Settings")).toBe("period=60;digits=6;algorithm=SHA1");
    expect(written.get("OTP Type")).toBe("TOTP");
    expect(written.has("MonicaItemData")).toBe(true);
  });

  it("projects Steam as OTP Type TOTP while MonicaItemData keeps the real type", () => {
    const written = buildKeePassSecureItemFields({ item: totp({ otpType: "STEAM" }) })!;

    expect(written.get("OTP Type")).toBe("TOTP");
    expect(JSON.parse(keePassFieldText(written.get("MonicaItemData"))).otpType).toBe("STEAM");
  });

  it("writes HOTP with its counter", () => {
    const written = buildKeePassSecureItemFields({ item: totp({ otpType: "HOTP", counter: 7 }) })!;

    expect(written.get("OTP Type")).toBe("HOTP");
    expect(written.get("HOTP Counter")).toBe("7");
  });

  it("writes MonicaSecureItemId only when Android assigned one", () => {
    expect(buildKeePassSecureItemFields({ item: note() })!.has("MonicaSecureItemId")).toBe(false);
    expect(buildKeePassSecureItemFields({ item: note(), monicaSecureItemId: 9 })!.get("MonicaSecureItemId")).toBe("9");
  });

  it("keeps a card custom field whose value is blank, because Android only requires a label", () => {
    const written = buildKeePassSecureItemFields({ item: card({ customFields: [{ name: "备注项", value: "", protected: false }] }) })!;

    expect(written.get("备注项")).toBe("");
  });

  it("skips a card custom field that collides with a field already written, or is a plugin field", () => {
    const written = buildKeePassSecureItemFields({
      item: card({
        customFields: [
          { name: "card holder", value: "SHADOW", protected: false },
          { name: "_etm_title_0", value: "x", protected: false }
        ]
      })
    })!;

    expect(written.get("Card Holder")).toBe("ALICE LIU");
    expect(written.has("card holder")).toBe(false);
    expect(written.has("_etm_title_0")).toBe(false);
  });
});

describe("buildKeePassSecureItemPatch", () => {
  it("preserves a plugin field and a third-party field through an edit", () => {
    const existing = fields({
      Title: "old",
      MonicaItemType: "NOTE",
      MonicaItemData: secret('{"content":"old"}'),
      _etm_template: "1",
      "KeePassXC Browser Settings": "{}"
    });

    const updated = applyKeePassFieldPatch(existing, buildKeePassSecureItemPatch({ item: note() })!);

    expect(updated.get("_etm_template")).toBe("1");
    expect(updated.get("KeePassXC Browser Settings")).toBe("{}");
    expect(updated.get("Title")).toBe("备忘");
  });

  it("removes a Monica-owned card field the item no longer carries", () => {
    const existing = fields({ Title: "Visa", MonicaItemType: "BANK_CARD", "Bank Name": "旧银行", Nickname: "旧昵称" });

    const updated = applyKeePassFieldPatch(existing, buildKeePassSecureItemPatch({ item: card() })!);

    expect(updated.has("Bank Name")).toBe(false);
    expect(updated.has("Nickname")).toBe(false);
  });

  it("overwrites a stale otp when an authenticator's secret changes, so no client keeps the old code", () => {
    const existing = fields({
      Title: "GitHub",
      MonicaItemType: "TOTP",
      otp: secret("otpauth://totp/GitHub?secret=OLDSECRETOLDSECRE"),
      "TOTP Seed": secret("OLDSECRETOLDSECRE")
    });

    const updated = applyKeePassFieldPatch(existing, buildKeePassSecureItemPatch({ item: totp() })!);

    expect(keePassFieldText(updated.get("TOTP Seed"))).toBe("JBSWY3DPEHPK3PXP");
    expect(keePassFieldText(updated.get("otp"))).toContain("JBSWY3DPEHPK3PXP");
  });

  /**
   * The TOTP-widened predicate claims `HOTP Counter`, but `KeePassEntryFieldPatch.shouldRemoveManagedField`
   * only removes a field whose registry role is Monica-owned, and the role here is `keepass-totp`. So a
   * counter left by an HOTP entry survives a switch to TOTP on Android too. Asserted rather than fixed:
   * diverging would make the browser delete a field Android keeps.
   */
  it("leaves a stale HOTP Counter behind when switching to TOTP, exactly as Android does", () => {
    const existing = fields({ Title: "GitHub", MonicaItemType: "TOTP", "HOTP Counter": "3" });

    const updated = applyKeePassFieldPatch(existing, buildKeePassSecureItemPatch({ item: totp() })!);

    expect(updated.get("HOTP Counter")).toBe("3");
    expect(updated.get("OTP Type")).toBe("TOTP");
  });

  it("leaves another client's otp alone on a non-TOTP secure item", () => {
    const existing = fields({ Title: "备忘", MonicaItemType: "NOTE", otp: secret("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP") });

    const updated = applyKeePassFieldPatch(existing, buildKeePassSecureItemPatch({ item: note() })!);

    expect(keePassFieldText(updated.get("otp"))).toContain("JBSWY3DPEHPK3PXP");
  });

  it("returns undefined for a kind that is not a secure item", () => {
    expect(buildKeePassSecureItemPatch({ item: { ...base(), kind: "login" } as VaultItem })).toBeUndefined();
  });
});

describe("readKeePassSecureItemCustomFields", () => {
  it("returns the non-reserved fields, keeping their protection", () => {
    const custom = readKeePassSecureItemCustomFields(
      fields({ Title: "Visa", "Card Number": secret("4111"), _etm_template: "1", "Recovery code": secret("ABCD"), Branch: "001", Blank: "" })
    );

    expect(custom).toEqual([
      { name: "Recovery code", value: "ABCD", protected: true, fieldType: "HIDDEN" },
      { name: "Branch", value: "001", protected: false, fieldType: "TEXT" }
    ]);
  });
});
