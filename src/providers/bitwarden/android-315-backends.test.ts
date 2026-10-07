import { describe, expect, it } from "vitest";
import type { CardItem, IdentityItem, LoginItem, SecureNoteItem } from "../../core/model";
import { BitwardenClient, type BitwardenSessionConfig } from "./bitwarden-client";
import { parseLosslessJson } from "../../core/lossless-json";
import { decodeBitwardenCipher, encodeBitwardenCipher } from "./bitwarden-cipher-codec";
import { encryptBitwardenString, decryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";

const key: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(4), macKey: new Uint8Array(32).fill(8) };
const enc = (text: string) => encryptBitwardenString(text, key);
const base = { id: "synthetic-315", type: 1, revisionDate: "2026-09-30T00:00:00.000Z", creationDate: "2026-09-29T00:00:00.000Z", favorite: false };
const custom = async (name: string, value: string, type = 0) => ({ name: await enc(name), value: await enc(value), type, linkedId: null });
const plainFields = async (raw: Record<string, unknown>) => Promise.all((raw.fields as Record<string, unknown>[]).map(async (field) => ({ name: await decryptBitwardenString((field.name || field.Name) as string, key), value: await decryptBitwardenString((field.value ?? field.Value) as string, key), raw: field })));

describe("Android 1.0.315 Bitwarden data contract", () => {
  it("exposes a future native Cipher as readonly data without guessing its encrypted future fields", async () => {
    const raw = { ...base, type: 99, name: await enc("Future synthetic record"), notes: await enc("Known notes"), fields: [await custom("known field", "synthetic secret", 1)], futureEncryptedPayload: "unrecognized-ciphertext", future: parseLosslessJson('{"big":9007199254740993,"empty":null}') };
    const decoded = await decodeBitwardenCipher(raw, "provider", key);
    expect(decoded.unsupported).toBe(true);
    expect(decoded.items).toHaveLength(1);
    const item = decoded.items[0];
    expect(item).toMatchObject({ kind: "opaque", nativeType: "bitwarden:99", title: "Future synthetic record" });
    if (item.kind !== "opaque") throw new Error("Expected opaque");
    expect(item.originalPayload).toContain('"big":9007199254740993');
    expect(JSON.parse(item.originalPayload!).cipher.futureEncryptedPayload).toBe(raw.futureEncryptedPayload);
    expect(JSON.parse(item.originalPayload!).readableFields).toEqual([{ name: "known field", value: "synthetic secret", protected: true, type: 1 }]);
    await expect(encodeBitwardenCipher({ ...item, notes: "changed" }, key, raw)).rejects.toThrow(/未知/);
    const fakeLogin: LoginItem = { ...item, kind: "login", username: "", password: "", uris: [], customFields: [] };
    await expect(encodeBitwardenCipher(fakeLogin, key, raw)).rejects.toThrow(/未知/);
  });
  it.each(["GPG_KEY", "API_KEY"] as const)("preserves %s and protected content bundles when editing only title", async (type) => {
    const bundle = '{"version":1,"data":{"future":9007199254740993,"empty":null},"assets":[{"name":"wallet-synthetic","size":2}]}';
    const fields = [await custom(type === "GPG_KEY" ? "monica_gpg_type" : "monica_api_key_type", type), { ...await custom("monica.content.wallet.note", bundle, 1), future: parseLosslessJson('{"big":9007199254740993,"decimal":1.234567890123456789}') }, await custom("monica.content.order", "OTP,FUTURE,NOTE"), await custom("monica_gpg_public_0000", "chunk+")];
    const raw = { ...base, name: await enc("original"), notes: null, fields, login: { username: await enc(""), password: await enc(""), totp: await enc("otpauth://hotp/account?secret=JBSWY3PXP&counter=9007199254740993"), uris: [{ uri: await enc("https://synthetic.invalid"), match: null, future: { mode: 42 } }] } };
    const item = (await decodeBitwardenCipher(raw, "provider", key)).items[0] as LoginItem;
    expect(item.loginType).toBe(type);
    const result = await encodeBitwardenCipher({ ...item, title: "edited" }, key, raw);
    const after = await plainFields(result);
    const wallet = after.find((field) => field.name === "monica.content.wallet.note")!;
    expect(wallet.value).toBe(bundle);
    expect(wallet.raw.value).toBe(fields[1].value);
    expect(JSON.stringify(wallet.raw.future)).toBe('{"big":9007199254740993,"decimal":1.234567890123456789}');
    expect(result.notes).toBeNull();
    expect((result.login as Record<string, unknown>).password).toBe(raw.login.password);
    expect((result.login as Record<string, unknown>).uris).toEqual(raw.login.uris);
  });

  it("roundtrips all Android card fields, boolean custom values and future card-face metadata", async () => {
    const pairs = { "Bank Name": "bank", "Card Type": "DEBIT", "Billing Address": "street\ncity", Nickname: "name", "Valid From Month": "01", "Valid From Year": "2020", PIN: "0004", IBAN: "GB00", "SWIFT/BIC": "BIC", "Routing Number": "0012", "Account Number": "000123", "Branch Code": "0002", Currency: "EUR", "Customer Service Phone": "+00123", "Monica Card Face": '{"imageAttachmentName":"monica_card_face_synthetic.jpg","displayMode":"HIDDEN","showBrandIcon":false,"future":{"big":9007199254740993}}' };
    const fields = await Promise.all(Object.entries(pairs).map(([name, text]) => custom(name, text)));
    fields.push(await custom("enabled", "false", 2), await custom("empty", ""));
    const raw = { ...base, type: 3, name: await enc("Card"), fields, card: { cardholderName: await enc("name"), number: await enc("00001234"), expMonth: await enc("01"), expYear: await enc("2035"), code: await enc("003"), brand: null } };
    const item = (await decodeBitwardenCipher(raw, "provider", key)).items[0] as CardItem;
    expect(item).toMatchObject({ kind: "card", bankName: "bank", pin: "0004", accountNumber: "000123", cardFace: { showBrandIcon: false, displayMode: "HIDDEN" } });
    expect(item.customFields).toContainEqual({ name: "enabled", value: "false", protected: false, fieldType: "BOOLEAN" });
    const result = await encodeBitwardenCipher({ ...item, bankName: "new bank" }, key, raw);
    const after = await plainFields(result);
    for (const [name, expected] of Object.entries(pairs)) expect(after.find((field) => field.name === name)?.value).toBe(name === "Bank Name" ? "new bank" : expected);
    expect(after.find((field) => field.name === "enabled")?.raw.type).toBe(2);
    expect(after.find((field) => field.name === "empty")?.value).toBe("");
    expect((result.card as Record<string, unknown>).number).toBe(raw.card.number);
  });

  it("keeps all document identifiers and title prefix while editing the displayed document number", async () => {
    const raw = { ...base, type: 4, name: await enc("Document"), fields: [await custom("monica_document_type", "PASSPORT"), await custom("monica_issue_date", "2020-01-02"), await custom("monica_additional_info", "all info")], identity: { title: await enc("Dr"), firstName: await enc("A"), middleName: await enc("B"), lastName: await enc("C"), company: await enc("Company"), username: await enc("profile"), ssn: await enc("0001"), passportNumber: await enc("P01"), licenseNumber: await enc("L01"), address3: await enc("floor 3") } };
    const item = (await decodeBitwardenCipher(raw, "provider", key)).items[0] as IdentityItem;
    expect(item).toMatchObject({ documentTitle: "Dr", fullName: "A B C", company: "Company", username: "profile", ssn: "0001", licenseNumber: "L01", issuedDate: "2020-01-02", address3: "floor 3" });
    const result = await encodeBitwardenCipher({ ...item, documentNumber: "P02" }, key, raw);
    const identity = result.identity as Record<string, string>;
    expect(await decryptBitwardenString(identity.passportNumber, key)).toBe("P02");
    expect(identity.ssn).toBe(raw.identity.ssn);
    expect(identity.licenseNumber).toBe(raw.identity.licenseNumber);
    expect(identity.title).toBe(raw.identity.title);
  });

  it("retains unreadable/unknown custom fields instead of replacing decryption failure with empty data", async () => {
    const corrupt = { name: await enc("unreadable"), value: "2.corrupt|value|mac", type: 0, future: { preserve: true } };
    const raw = { ...base, name: await enc("Login"), fields: [corrupt, await custom("known", "value")], login: { username: null, password: null } };
    const item = (await decodeBitwardenCipher(raw, "provider", key)).items[0] as LoginItem;
    expect(item.customFields?.some((field) => field.name === "unreadable")).toBe(false);
    const result = await encodeBitwardenCipher({ ...item, title: "edited" }, key, raw);
    expect(result.fields).toContainEqual(corrupt);
  });

  it("preserves note field metadata, unknown tag data and boolean fields without truncating", async () => {
    const raw = { ...base, type: 2, name: await enc("Note"), notes: await enc("body"), fields: [await custom("monica_note_tags", '["tag",{"future":9007199254740993}]'), await custom("monica_note_markdown", "future-mode"), { ...await custom("email", "note@example.invalid"), future: { marker: true } }, await custom("enabled", "false", 2)] };
    const item = (await decodeBitwardenCipher(raw, "provider", key)).items[0] as SecureNoteItem;
    expect(item.tags).toBeUndefined();
    expect(item.isMarkdown).toBeUndefined();
    expect(item.customFields?.find((field) => field.name === "enabled")?.fieldType).toBe("BOOLEAN");
    const result = await encodeBitwardenCipher({ ...item, content: "new body" }, key, raw);
    const fields = await plainFields(result);
    expect(fields.find((field) => field.name === "monica_note_tags")?.raw.value).toBe(raw.fields[0].value);
    expect(fields.find((field) => field.name === "monica_note_markdown")?.value).toBe("future-mode");
    expect(fields.find((field) => field.name === "email")?.raw.future).toEqual({ marker: true });
  });

  it("keeps unsafe numeric lexemes at the bounded HTTP response boundary", async () => {
    const json = '{"Ciphers":[],"Future":{"big":9007199254740993,"decimal":1.234567890123456789,"$serde_json::private::Number":"literal"}}';
    const fetcher = (async () => new Response(json, { status: 200 })) as typeof fetch;
    const client = new BitwardenClient(fetcher);
    const session = { apiUrl: "https://synthetic.invalid/api", identityUrl: "https://synthetic.invalid/identity", accessToken: "synthetic", expiresAt: Date.now() + 3600000 } as BitwardenSessionConfig;
    const result = await client.sync(session);
    expect(JSON.stringify(result.payload)).toBe(json);
  });
});
