import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { ApiTokenItem, LoginItem, PasskeyItem, TotpItem, VaultItem } from "../../core/model";
import { parseLosslessJson } from "../../core/lossless-json";
import { androidRecordToItem, deleteAndroidBackupItem, deleteAndroidPortableAttachment, listAndroidPortableAttachments, readAndroidBackup, upsertAndroidPortableAttachment, writeAndroidBackup } from "./android-backup-codec";

const PROVIDER = "android-315-synthetic";
const LOGIN_PATH = "folders/_root/passwords/password_42_1700000000000.json";
const NOTE_PATH = "folders/_root/notes/note_7_1700000000000.json";
const OTP_PATH = "folders/_root/authenticators/totp_8_1700000000000.json";
const base = { id: 42, title: "Synthetic", createdAt: 1700000000000, updatedAt: 1700000001000 };
const login = { ...base, username: "alice", password: "synthetic-password", website: "https://synthetic.invalid", notes: "", loginType: "PASSWORD" };
function archive(entries: Record<string, unknown>) {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([path, value]) => [path, strToU8(typeof value === "string" ? value : JSON.stringify(value))])));
}

describe("Android 1.0.315 backup preservation boundaries", () => {
  it.each(['{broken', '[]', '{"version":99,"entries":[]}', '{"version":2,"entries":null}'])("refuses to replace an unsupported portable manifest: %s", manifest => {
    const document = readAndroidBackup(archive({ [LOGIN_PATH]: login, "attachments_portable/attachments_portable.json": manifest }), PROVIDER);
    const before = strFromU8(document.entries["attachments_portable/attachments_portable.json"]);
    expect(() => upsertAndroidPortableAttachment(document, document.items[0], { fileName: "new", sizeBytes: 1, sha256Hex: "0".repeat(64) }, Uint8Array.of(1))).toThrow(/附件清单/);
    expect(strFromU8(document.entries["attachments_portable/attachments_portable.json"])).toBe(before);
  });

  it.each(["59522", "9007199254740993"])("uses authoritative parent ID %s and keeps password/secure namespaces separate", id => {
    const path = `passwords/password_${id}.json`;
    const cardPath = `bank_cards/item_${id}.json`;
    const attachment = (owner: string, name: string) => `{"${owner}":${id},"fileName":"${name}","sizeBytes":1,"sha256Hex":"${"0".repeat(64)}","payloadPath":"attachments_portable/${name}.bin"}`;
    const document = readAndroidBackup(archive({
      [path]: JSON.stringify(login).replace('"id":42', `"id":${id}`),
      [cardPath]: `{"id":${id},"itemType":"BANK_CARD","itemData":"{}"}`,
      "attachments_portable/attachments_portable.json": `{"version":2,"entries":[${attachment("parentPasswordId", "login")},${attachment("parentSecureItemId", "card")}]}`
    }), PROVIDER, { allowPortableAttachments: true });
    const password = document.items.find(item => item.kind === "login")!;
    const card = document.items.find(item => item.kind === "card")!;
    expect(listAndroidPortableAttachments(document, password).map(asset => asset.fileName)).toEqual(["login"]);
    expect(listAndroidPortableAttachments(document, card).map(asset => asset.fileName)).toEqual(["card"]);
    upsertAndroidPortableAttachment(document, password, { fileName: "new", sizeBytes: 1, sha256Hex: "0".repeat(64) }, Uint8Array.of(1));
    const manifest = strFromU8(document.entries["attachments_portable/attachments_portable.json"]);
    expect(manifest).toContain(`"parentPasswordId":${id}`);
    expect(manifest).not.toContain(`"parentPasswordId":"${id}"`);
    expect(listAndroidPortableAttachments(document, password).map(asset => asset.fileName)).toEqual(["login", "new"]);
  });

  it.each(["totp/item_8.json", "folders/_root/totp/item_8.json", OTP_PATH])("reads the actual Android OTP directory and retains its original path: %s", path => {
    const raw = { ...base, id: 8, itemType: "TOTP", itemData: '{"otpType":"HOTP","secret":"JBSWY3DPEHPK3PXP","counter":9007199254740993}' };
    const document = readAndroidBackup(archive({ [path]: raw }), PROVIDER);
    expect(document.items).toHaveLength(1);
    expect(document.items[0]).toMatchObject({ kind: "totp", otpType: "HOTP", counter: "9007199254740993" });
    const written = unzipSync(writeAndroidBackup(document, [{ ...document.items[0], title: "Edited OTP" }], PROVIDER));
    expect(written[path]).toBeDefined();
    expect(JSON.parse(strFromU8(written[path])).itemData).toContain('"counter":9007199254740993');
    expect(readAndroidBackup(zipSync(written), PROVIDER).items[0].title).toBe("Edited OTP");
  });

  it.each([
    ["folders/_root/future_credentials/new.json", '{ "id":9223372036854775807, "itemType":"FUTURE_KEY", "secret":"synthetic", "empty":"", "null":null }\n'],
    [NOTE_PATH, '{ "id":7, "itemType":"NOTE", broken'],
    [NOTE_PATH, JSON.stringify({ ...base, itemType: "FUTURE_KEY", itemData: "{}" })],
    [LOGIN_PATH, JSON.stringify({ ...login, loginType: "FUTURE_LOGIN" })],
    [OTP_PATH, JSON.stringify({ ...base, itemType: "TOTP", itemData: '{"otpType":"FUTURE_OTP","secret":"synthetic"}' })]
  ])("exposes an opaque record and keeps its exact original bytes: %s", (path, payload) => {
    const document = readAndroidBackup(archive({ [path]: payload }), PROVIDER);
    expect(document.items).toHaveLength(1);
    expect(document.items[0]).toMatchObject({ kind: "opaque", originalPayload: payload });
    const output = unzipSync(writeAndroidBackup(document, document.items, PROVIDER));
    expect(strFromU8(output[path])).toBe(payload);
    expect(() => writeAndroidBackup(document, [{ ...document.items[0], notes: "edit" }], PROVIDER)).toThrow(/原样保留/);
    expect(() => deleteAndroidBackupItem(document, document.items[0].id)).toThrow(/不能删除/);
    expect(() => upsertAndroidPortableAttachment(document, document.items[0], { fileName: "synthetic.txt", sizeBytes: 1, sha256Hex: "0".repeat(64) }, Uint8Array.of(1))).toThrow(/只读/);
    expect(() => deleteAndroidPortableAttachment(document, document.items[0], "synthetic-missing")).toThrow(/只读/);
  });

  it("ignores sync reference metadata when retaining an otherwise unchanged opaque record", () => {
    const path = "folders/_root/future_credentials/new.json";
    const payload = '{"itemType":"FUTURE","id":1}';
    const document = readAndroidBackup(archive({ [path]: payload }), PROVIDER);
    const item = structuredClone(document.items[0]);
    item.providerRefs[0].revision = "2026-09-30T00:00:00.000Z";
    item.providerRefs[0].etag = '"new-etag"';
    expect(strFromU8(unzipSync(writeAndroidBackup(document, [item], PROVIDER))[path])).toBe(payload);
    expect(() => writeAndroidBackup(document, [{ ...item, deletedAt: item.updatedAt }], PROVIDER)).toThrow(/原样保留/);
  });

  it.each([true, 42, [], "[]", "true", "9223372036854775807"])("does not silently replace non-object itemData (%s) with an editable empty note", itemData => {
    const document = readAndroidBackup(archive({ [NOTE_PATH]: { ...base, itemType: "NOTE", itemData } }), PROVIDER);
    expect(document.items[0].kind).toBe("opaque");
  });

  it("handles a future native null payload without throwing in the direct projection API", () => {
    expect(androidRecordToItem("folders/_root/future_keys/new.json", null as unknown as Record<string, unknown>, PROVIDER)).toMatchObject({ kind: "opaque", originalPayload: "null" });
  });

  it("keeps Long IDs, exact decimal/exponent lexemes, literal marker keys, null and empty values on unrelated edits", () => {
    const path = "folders/_root/passwords/password_9223372036854775807_1700000000000.json";
    const payload = JSON.stringify(login).replace('"id":42', '"id":9223372036854775807').replace(/}$/, ',"long":9007199254740993,"decimal":1.2300,"exponent":1e40,"negativeZero":-0,"future":{"$serde_json::private::Number":"literal","null":null,"empty":""}}');
    const document = readAndroidBackup(archive({ [path]: payload }), PROVIDER);
    const item = { ...document.items[0], notes: "changed note" };
    const output = strFromU8(unzipSync(writeAndroidBackup(document, [item], PROVIDER))[path]);
    for (const literal of ['"id":9223372036854775807', '"long":9007199254740993', '"decimal":1.2300', '"exponent":1e40', '"negativeZero":-0', '"$serde_json::private::Number":"literal"', '"null":null', '"empty":""']) expect(output).toContain(literal);
    expect((parseLosslessJson(output) as Record<string, unknown>).notes).toBe("changed note");
  });

  it("preserves unknown custom field metadata and unrecognized entries when a visible field is edited", () => {
    const customFields = [{ title: "visible", value: "old", isProtected: true, future: { literal: null } }, { futureOnly: true }, null];
    const document = readAndroidBackup(archive({ [LOGIN_PATH]: { ...login, customFields } }), PROVIDER);
    const item = structuredClone(document.items[0]) as LoginItem;
    item.customFields[0].value = "new";
    const output = JSON.parse(strFromU8(unzipSync(writeAndroidBackup(document, [item], PROVIDER))[LOGIN_PATH]));
    expect(output.customFields).toEqual([{ ...customFields[0], value: "new" }, customFields[1], null]);
  });

  it("keeps a device-bound Passkey alias on unrelated edits and rejects implicit metadata-only migration", () => {
    const path = "folders/_root/passkeys/passkey_synthetic.json";
    const alias = "monica-passkey-key-ref-v1:device-only";
    const document = readAndroidBackup(archive({ [path]: { ...base, credentialId: "synthetic", rpId: "synthetic.invalid", userId: "alice", publicKeyAlgorithm: -7, privateKeyAlias: alias, signCount: 0 } }), PROVIDER);
    const item = { ...document.items[0], notes: "new recovery note" } as PasskeyItem;
    expect(item.privateKeyPkcs8).toBeUndefined();
    expect(JSON.parse(strFromU8(unzipSync(writeAndroidBackup(document, [item], PROVIDER))[path])).privateKeyAlias).toBe(alias);
    const empty = readAndroidBackup(archive({}), PROVIDER);
    expect(() => writeAndroidBackup(empty, [item], PROVIDER)).toThrow(/私钥/);
    const metadataOnly = readAndroidBackup(writeAndroidBackup(empty, [item], PROVIDER, { allowMetadataOnlyPasskeys: true }), PROVIDER);
    expect(metadataOnly.items[0]).toMatchObject({ kind: "passkey", credentialId: "synthetic" });
    expect((metadataOnly.items[0] as PasskeyItem).privateKeyPkcs8).toBeUndefined();
  });

  it("rejects unsupported API Token rather than silently omitting it from a full backup", () => {
    const empty = readAndroidBackup(archive({}), PROVIDER);
    const source = androidRecordToItem(LOGIN_PATH, login, PROVIDER)!;
    const item: ApiTokenItem = { ...source, kind: "api-token", provider: "synthetic", apiBase: "https://synthetic.invalid", token: "synthetic", customFields: [] };
    expect(() => writeAndroidBackup(empty, [item], PROVIDER)).toThrow(/api-token/);
  });

  it("does not mutate any caller items or source entries when a later item fails after staging categories and bindings", () => {
    const document = readAndroidBackup(archive({
      [LOGIN_PATH]: login,
      [OTP_PATH]: { ...base, id: 8, itemType: "TOTP", itemData: '{"secret":"SYNTHETIC","otpType":"HOTP","counter":0}' }
    }), PROVIDER);
    const items = structuredClone(document.items);
    const password = items.find(item => item.kind === "login") as LoginItem;
    const otp = items.find(item => item.kind === "totp") as TotpItem;
    password.boundTotpItemId = otp.id;
    password.categoryName = "New category";
    items.push({ ...password, id: "new-token", kind: "api-token", provider: "synthetic", apiBase: "https://synthetic.invalid", token: "synthetic", customFields: [] } as ApiTokenItem);
    const before = structuredClone(items);
    const originalEntries = structuredClone(document.entries);
    expect(() => writeAndroidBackup(document, items, PROVIDER)).toThrow();
    expect(items).toEqual(before);
    expect(document.entries).toEqual(originalEntries);
  });

  it("moves a record to trash even when deletion is the only changed field", () => {
    const document = readAndroidBackup(archive({ [LOGIN_PATH]: login }), PROVIDER);
    const item = { ...document.items[0], deletedAt: document.items[0].updatedAt };
    const output = unzipSync(writeAndroidBackup(document, [item], PROVIDER));
    expect(output[LOGIN_PATH]).toBeUndefined();
    expect(JSON.parse(strFromU8(output["trash/trash_passwords.json"]))[0].id).toBe(42);
  });

  it.each(["{}", "null", "42"])("fails closed instead of replacing a non-array trash archive (%s)", corruptTrash => {
    const document = readAndroidBackup(archive({ [LOGIN_PATH]: login, "trash/trash_passwords.json": corruptTrash }), PROVIDER);
    const item = { ...document.items[0], deletedAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" } as VaultItem;
    expect(() => writeAndroidBackup(document, [item], PROVIDER)).toThrow(/无法安全更新/);
    expect(strFromU8(document.entries["trash/trash_passwords.json"])).toBe(corruptTrash);
    expect(document.entries[LOGIN_PATH]).toBeDefined();
  });
});
