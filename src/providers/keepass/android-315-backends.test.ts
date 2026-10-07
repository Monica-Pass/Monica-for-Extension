import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import type { LoginItem, SecureNoteItem } from "../../core/model";
import { parseLosslessJson } from "../../core/lossless-json";
import { buildKeePassLoginFields, keePassFieldText, readKeePassLoginFields } from "./keepass-login-codec";
import { buildKeePassSecureItemFields, readKeePassEntryTotp } from "./keepass-secure-item-codec";
import { createKeePassEntry, keePassPatchFor, removeKeePassEntry, writeKeePassEntry } from "./keepass-writer";
import { readKeePassEntries } from "./keepass-vault";
import { applyKeePassFieldPatch } from "./keepass-field-patch";
import { keePassTotpFieldsFor, parseKeePassTotpFields } from "./keepass-totp-codec";

const base = { id: "synthetic-315", title: "same title", favorite: false, notes: " recovery notes \n", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", providerRefs: [] };
const login: LoginItem = { ...base, kind: "login", username: " account ", password: "", uris: ["https://one.invalid", "https://two.invalid"], customFields: [] };

describe("Android 1.0.315 KeePass data contract", () => {
  it("shows future records with original protected fields and rejects edits, conversion, creation and deletion", () => {
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("synthetic")), "Synthetic 315");
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("Title", "Future synthetic key");
    entry.fields.set("MonicaItemType", "FUTURE_KEY");
    const payload = '{"id":9223372036854775807,"secret":"synthetic","null":null}';
    entry.fields.set("MonicaItemData", kdbxweb.ProtectedValue.fromString(payload));
    const snapshot = readKeePassEntries(db, 315, "synthetic");
    expect(snapshot.items).toHaveLength(1);
    const item = snapshot.items[0];
    expect(item.kind).toBe("opaque");
    if (item.kind !== "opaque") throw new Error("Expected opaque record");
    expect(JSON.parse(item.originalPayload!).fields).toContainEqual({ name: "MonicaItemData", value: payload, protected: true });
    expect(() => writeKeePassEntry(db, entry, { ...item, notes: "changed" })).toThrow();
    expect(() => writeKeePassEntry(db, entry, login)).toThrow(/未知/);
    expect(() => createKeePassEntry(db, item)).toThrow();
    expect(() => removeKeePassEntry(db, entry)).toThrow(/未知/);
    expect(keePassFieldText(entry.fields.get("MonicaItemData"))).toBe(payload);
    expect(entry.history).toHaveLength(0);
  });
  it.each(["GPG_KEY", "API_KEY"] as const)("reads Android %s markers and retains all protected content fields", (loginType) => {
    const content = '{"version":1,"data":{"future":9007199254740993,"empty":null}}';
    const item = { ...login, loginType, customFields: [{ name: "monica.content.wallet.note", value: content, protected: true }, { name: "monica.content.order", value: "OTP,FUTURE,NOTE,BLOCK:synthetic", protected: false }, { name: "monica_gpg_public_0000", value: "public+chunk==", protected: false }] };
    const fields = buildKeePassLoginFields({ item });
    const result = readKeePassLoginFields(fields);
    expect(result).toMatchObject({ loginType, username: " account ", password: "", notes: base.notes, url: item.uris.join("\n") });
    expect(result.customFields).toEqual(expect.arrayContaining(item.customFields));
    expect(fields.get("monica.content.wallet.note")).toBeInstanceOf(kdbxweb.ProtectedValue);
    const updated = applyKeePassFieldPatch(fields, keePassPatchFor({ ...item, title: "edited" }, fields)!);
    expect(keePassFieldText(updated.get("monica.content.wallet.note"))).toBe(content);
  });

  it.each(["TOTP", "HOTP", "STEAM", "YANDEX", "MOTP"] as const)("preserves %s storage parameters without subtype downgrade", (otpType) => {
    const original = { secret: otpType === "MOTP" ? "MiXeD&Secret" : "JBSWY3DPEHPK3PXP", issuer: "issuer:with+colon", accountName: "account&one", period: otpType === "MOTP" ? 10 : 30, digits: otpType === "STEAM" ? 5 : 6, algorithm: "SHA1", otpType, counter: otpType === "HOTP" ? "9007199254740993" : 0, pin: "0042", link: "" };
    const fields = keePassTotpFieldsFor(original, "synthetic");
    const parsed = parseKeePassTotpFields({ otp: fields.otp })!;
    expect(parsed).toMatchObject({ secret: original.secret, issuer: original.issuer, accountName: original.accountName, otpType, counter: original.counter });
    if (otpType === "MOTP" || otpType === "YANDEX") { expect(Object.keys(fields)).toEqual(["otp"]); expect(parsed.pin).toBe("0042"); }
    if (otpType === "STEAM") expect(fields.otp).toContain("encoder=steam");
    if (otpType === "HOTP") expect(fields["HmacOtp-Counter"]).toBe("9007199254740993");
  });

  it("reads native HmacOtp maximum Long and rejects overflow without rounding", () => {
    const fields = new Map([ ["HmacOtp-Secret-Base32", "JBSWY3DPEHPK3PXP"], ["HmacOtp-Counter", "9223372036854775807"] ]);
    expect(readKeePassEntryTotp(fields)).toMatchObject({ otpType: "HOTP", counter: "9223372036854775807" });
    fields.set("HmacOtp-Counter", "9223372036854775808");
    expect(readKeePassEntryTotp(fields)).toBeUndefined();
  });

  it("patches a note while preserving nested unknown JSON, exact numbers, empty/null and field metadata", () => {
    const original = '{"content":"old","tags":["one"],"isMarkdown":true,"customFields":[{"label":"code","value":"0042","type":"HIDDEN","future":{"decimal":1.234567890123456789}}],"future":{"big":9007199254740993,"empty":null,"$serde_json::private::Number":"literal"}}';
    const note: SecureNoteItem = { ...base, kind: "secure-note", content: "new", tags: ["one"], isMarkdown: true, customFields: [{ name: "code", value: "0042", protected: true, fieldType: "HIDDEN" }] };
    const fields = buildKeePassSecureItemFields({ item: note, existingFields: new Map([["MonicaItemData", kdbxweb.ProtectedValue.fromString(original)]]) })!;
    const result = keePassFieldText(fields.get("MonicaItemData"));
    expect(result).toContain('"big":9007199254740993');
    expect(result).toContain('"decimal":1.234567890123456789');
    expect(parseLosslessJson(result)).toMatchObject({ content: "new", future: { empty: null, "$serde_json::private::Number": "literal" } });
  });

  it("removes explicitly deleted content chunks while preserving the remaining source", () => {
    const before = { ...login, customFields: [{ name: "monica.content.block.synthetic", value: "manifest", protected: true }, { name: "monica.content.block.synthetic.0000", value: "fragment", protected: true }] };
    const existing = buildKeePassLoginFields({ item: before });
    existing.set("_etm_plugin", "retain");
    const after = applyKeePassFieldPatch(existing, keePassPatchFor(login, existing)!);
    expect(after.has("monica.content.block.synthetic.0000")).toBe(false);
    expect(after.get("_etm_plugin")).toBe("retain");
  });

  it("retains a Long-sized legacy identity without treating it as a JS number", () => {
    const existing = buildKeePassLoginFields({ item: login });
    existing.set("MonicaLocalId", "9223372036854775807");
    const after = applyKeePassFieldPatch(existing, keePassPatchFor({ ...login, title: "edited" }, existing)!);
    expect(after.get("MonicaLocalId")).toBe("9223372036854775807");
  });

  it("keeps native Android OTP fields byte-for-byte when only username or notes change", () => {
    const uri = "otpauth://totp/Synthetic?secret=JBSWY3DPEHPK3PXP";
    const existing = buildKeePassLoginFields({ item: { ...login, totpSecret: uri } });
    existing.set("TOTP Settings", "period=30;digits=6;algorithm=SHA1");
    const after = applyKeePassFieldPatch(existing, keePassPatchFor({ ...login, username: "changed", totpSecret: uri }, existing)!);
    expect(after.get("TOTP Settings")).toBe("period=30;digits=6;algorithm=SHA1");
    expect(after.get("otp")).toBe(existing.get("otp"));
  });
});
