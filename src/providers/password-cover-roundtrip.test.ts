import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import { strToU8, zipSync } from "fflate";
import { createLoginItem, type LoginItem } from "../core/model";
import { groupedPasswords } from "../core/password-groups";
import { normalizeImportedVaultItem } from "../manager/import-items";
import { readAndroidBackup, writeAndroidBackup } from "./webdav/android-backup-codec";
import { decodeMdbx2Object, encodeMdbx2Object } from "./mdbx2/mdbx2-item-codec";
import { buildKeePassFixture, keePassCredentials } from "./keepass/keepass-fixture";
import { readKeePassEntries } from "./keepass/keepass-vault";
import { writeKeePassEntry } from "./keepass/keepass-writer";
import { keePassFieldText, readKeePassLoginFields } from "./keepass/keepass-login-codec";
import { decodeBitwardenCipher, encodeBitwardenCipher } from "./bitwarden/bitwarden-cipher-codec";
import { encryptBitwardenString, decryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden/bitwarden-crypto";
import { bitwardenMutationFingerprint } from "./bitwarden/bitwarden-durable-sync";

const key: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(11), macKey: new Uint8Array(32).fill(12) };
const seed = (): LoginItem => createLoginItem({ title: "Synthetic cover", username: "account", password: "fixture-secret", uris: ["https://example.test"] });
const path = "folders/_root/passwords/password_1_0.json";
const backup = (raw: Record<string, unknown>) => readAndroidBackup(zipSync({ [path]: strToU8(JSON.stringify({ id: 1, title: "Synthetic cover", password: "fixture-secret", ...raw })) }), "source");
const native = (payload: Record<string, unknown>): LoginItem => {
  const item = decodeMdbx2Object({ objectId: "cover", collectionId: "folder", objectTypeId: "login", title: "Synthetic cover", payloadSchemaVersion: 1, deleted: false, payloadJson: JSON.stringify(payload) }, { headCommitId: "head", updatedAt: "2026-10-05T00:00:00Z" }, "source").item;
  if (item?.kind !== "login") throw new Error("Expected login");
  return item;
};
const cipher = async (raw: Record<string, unknown>) => (await decodeBitwardenCipher({ ...raw, id: "cover" }, "source", key)).items[0] as LoginItem;
const field = async (value: string, extra: Record<string, unknown> = {}) => ({ name: await encryptBitwardenString("monica_group_cover", key), value: await encryptBitwardenString(value, key), type: 1, linkedId: null, future: { keep: true }, ...extra });

describe("password display-cover transport", () => {
  it.each([true, false, undefined])("preserves %s through a fresh encrypted KDBX, Bitwarden cipher, native payload and Android ZIP", async isGroupCover => {
    const start = { ...seed(), isGroupCover };
    const bytes = await buildKeePassFixture({ password: "synthetic", entries: [{ title: "Target" }] });
    let db = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials("synthetic"));
    writeKeePassEntry(db, db.getDefaultGroup().entries[0], start);
    db = await kdbxweb.Kdbx.load(await db.save(), keePassCredentials("synthetic"));
    const kp = readKeePassEntries(db, 1, "reopened").items[0] as LoginItem;
    expect(kp.isGroupCover).toBe(isGroupCover);
    const bw = await cipher(await encodeBitwardenCipher(kp, key));
    expect(bw.isGroupCover).toBe(isGroupCover);
    const mdbx = native(JSON.parse(encodeMdbx2Object(bw)!.payloadJson));
    expect(mdbx.isGroupCover).toBe(isGroupCover);
    const doc = backup({});
    const zip = readAndroidBackup(writeAndroidBackup(doc, [{ ...mdbx, id: doc.items[0].id }], "source"), "reopened");
    expect((zip.items[0] as LoginItem).isGroupCover).toBe(isGroupCover);
    expect(zip.items[0]).toMatchObject({ password: "fixture-secret", username: "account" });
    expect(normalizeImportedVaultItem(JSON.parse(JSON.stringify(zip.items[0])))).toMatchObject({ isGroupCover });
  });

  it.each([true, false, undefined, null, "true", 1, { version: 2 }])("retains exact Android ZIP cover %j on unrelated edits", value => {
    const doc = backup(value === undefined ? {} : { isGroupCover: value });
    const item = doc.items[0] as LoginItem;
    expect(item.isGroupCover).toBe(typeof value === "boolean" ? value : undefined);
    const next = readAndroidBackup(writeAndroidBackup(doc, [{ ...item, title: "Renamed" }], "source"), "reopened");
    const raw = next.records.get(next.items[0].id)!.raw;
    expect(raw.isGroupCover).toEqual(value);
    expect(Object.prototype.hasOwnProperty.call(raw, "isGroupCover")).toBe(value !== undefined);
  });

  it.each([true, false, undefined, null, "true", 1, { version: 2 }])("retains exact native cover %j on unrelated edits", value => {
    const payload = { kind: "password", monica_entry_id: "password:cover", ...(value !== undefined ? { is_group_cover: value } : {}) };
    const original = native(payload);
    expect(original.isGroupCover).toBe(typeof value === "boolean" ? value : undefined);
    const updated = JSON.parse(encodeMdbx2Object({ ...original, title: "Renamed" }, payload, original)!.payloadJson);
    expect(updated).toEqual(payload);
  });

  it("unpins ZIP/native flags explicitly and rejects replacing unknown payloads", () => {
    const doc = backup({ isGroupCover: true });
    const original = doc.items[0] as LoginItem;
    const cleared = readAndroidBackup(writeAndroidBackup(doc, [{ ...original, isGroupCover: false }], "source"), "reopened");
    expect((cleared.items[0] as LoginItem).isGroupCover).toBe(false);
    const payload = { kind: "password", is_group_cover: true };
    expect(native(JSON.parse(encodeMdbx2Object({ ...native(payload), isGroupCover: false }, payload, native(payload))!.payloadJson)).isGroupCover).toBe(false);
    const future = backup({ isGroupCover: { version: 2 } });
    expect(() => writeAndroidBackup(future, [{ ...future.items[0] as LoginItem, isGroupCover: true }], "source")).toThrow("封面字段版本未知");
    const unknown = { kind: "password", is_group_cover: "future" };
    expect(() => encodeMdbx2Object({ ...native(unknown), isGroupCover: true }, unknown, native(unknown))).toThrow("封面字段版本未知");
  });

  it.each([3, 4] as const)("keeps protection and history through cover rename, unpin and removal in KDBX %s", async version => {
    const bytes = await buildKeePassFixture({ password: "synthetic", version, entries: [{ title: "Cover", fields: { Future: "keep" }, protectedFields: { Password: "fixture-secret", MonicaGroupCover: "true" } }] });
    let db = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials("synthetic"));
    const read = () => readKeePassEntries(db, 1, "source").items[0] as LoginItem;
    for (const cover of [true, false, undefined]) {
      writeKeePassEntry(db, db.getDefaultGroup().entries[0], { ...read(), title: "Renamed", isGroupCover: cover });
      db = await kdbxweb.Kdbx.load(await db.save(), keePassCredentials("synthetic"));
      expect(read().isGroupCover).toBe(cover);
      const entry = db.getDefaultGroup().entries[0];
      if (cover !== undefined) expect(entry.fields.get("MonicaGroupCover")).toBeInstanceOf(kdbxweb.ProtectedValue);
      else expect(entry.fields.has("MonicaGroupCover")).toBe(false);
      expect(entry.fields.get("Future")).toBe("keep");
      expect(read().password).toBe("fixture-secret");
    }
    expect(db.getDefaultGroup().entries[0].history.some(entry => keePassFieldText(entry.fields.get("MonicaGroupCover")) === "true")).toBe(true);
  });

  it("preserves unfamiliar KeePass cover text and refuses to replace it with a boolean", async () => {
    const bytes = await buildKeePassFixture({ password: "synthetic", entries: [{ title: "Future", protectedFields: { MonicaGroupCover: "{future:2}" } }] });
    const db = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials("synthetic"));
    const entry = db.getDefaultGroup().entries[0];
    const original = readKeePassEntries(db, 1, "source").items[0] as LoginItem;
    expect(original.isGroupCover).toBeUndefined();
    expect(original.password).toBe("");
    expect(original.customFields).toContainEqual({ name: "MonicaGroupCover", value: "{future:2}", protected: true });
    writeKeePassEntry(db, entry, { ...original, title: "Renamed" });
    expect(keePassFieldText(entry.fields.get("MonicaGroupCover"))).toBe("{future:2}");
    const size = entry.history.length;
    expect(() => writeKeePassEntry(db, entry, { ...original, isGroupCover: true })).toThrow("封面字段版本未知");
    expect(entry.history).toHaveLength(size);
    expect(readKeePassLoginFields(entry.fields).isGroupCover).toBeUndefined();
  });

  it("keeps a KeePass cover on unrelated edits from older snapshots that lack the projection", async () => {
    const bytes = await buildKeePassFixture({ password: "synthetic", entries: [{ title: "Legacy", protectedFields: { MonicaGroupCover: "true" } }] });
    const db = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials("synthetic"));
    const entry = db.getDefaultGroup().entries[0];
    writeKeePassEntry(db, entry, { ...seed(), title: "Legacy renamed" });
    expect(readKeePassLoginFields(entry.fields).isGroupCover).toBe(true);
    expect(entry.fields.get("MonicaGroupCover")).toBeInstanceOf(kdbxweb.ProtectedValue);
  });

  it("preserves Bitwarden duplicate cover values and future metadata, then changes or removes only recognized flags", async () => {
    const raw = await encodeBitwardenCipher(seed(), key);
    const managed = [await field("false"), await field("true")];
    const unsupported = [await field("future"), await field("true", { type: 2 }), await field("false", { linkedId: 100 }), await field("future", { value: "unreadable" })];
    raw.fields = [...managed, ...unsupported];
    const original = await cipher(raw);
    expect(original.isGroupCover).toBe(true);
    const renamed = await encodeBitwardenCipher({ ...original, title: "Renamed" }, key, raw);
    expect(renamed.fields).toEqual(expect.arrayContaining([...managed, ...unsupported]));
    expect(renamed.fields).toHaveLength(6);
    const updated = await encodeBitwardenCipher({ ...original, isGroupCover: false }, key, raw);
    expect((await cipher(updated)).isGroupCover).toBe(false);
    expect(updated.fields).toEqual(expect.arrayContaining(unsupported));
    const preservedValues = new Set(unsupported.map(value => JSON.stringify(value)));
    const known = (updated.fields as Record<string, unknown>[]).filter(value => !preservedValues.has(JSON.stringify(value)));
    expect(known).toHaveLength(2);
    for (const output of known) {
      expect(output.type).toBe(1);
      expect(output.future).toEqual({ keep: true });
      expect(await decryptBitwardenString(output.value as string, key)).toBe("false");
    }
    const removed = await encodeBitwardenCipher({ ...await cipher(updated), isGroupCover: undefined }, key, updated);
    expect((await cipher(removed)).isGroupCover).toBeUndefined();
    expect(removed.fields).toEqual(expect.arrayContaining(unsupported));
    expect(removed.fields).toHaveLength(4);
  });

  it("does not erase a Bitwarden flag when an older cached model lacks its projection", async () => {
    const raw = await encodeBitwardenCipher({ ...seed(), isGroupCover: true }, key);
    for (const bitwardenCustomFieldsVersion of [undefined, 1] as const) {
      expect((await cipher(await encodeBitwardenCipher({ ...seed(), title: "Legacy rename", bitwardenCustomFieldsVersion }, key, raw))).isGroupCover).toBe(true);
    }
  });

  it("includes explicit cover changes in the Bitwarden durable acknowledgement fingerprint", async () => {
    const item = seed();
    const before = await bitwardenMutationFingerprint({ ...item, isGroupCover: true });
    expect(await bitwardenMutationFingerprint({ ...item, isGroupCover: false })).not.toBe(before);
    expect(await bitwardenMutationFingerprint({ ...item, isGroupCover: undefined })).not.toBe(before);
  });

  it.each(["true", 1, {}, []])("retains an incompatible snapshot flag %j as readonly opaque data", isGroupCover => {
    const raw = { ...seed(), isGroupCover };
    const imported = normalizeImportedVaultItem(raw);
    expect(imported?.kind).toBe("opaque");
    if (imported?.kind !== "opaque") throw new Error("Expected opaque import");
    expect(JSON.parse(imported.originalPayload!).isGroupCover).toEqual(isGroupCover);
  });

  it("never creates, changes or reorders explicit password project membership from a display-cover flag", () => {
    const a = { ...seed(), id: "a", passwordGroupId: "project", sortOrder: 1 };
    const b = { ...seed(), id: "b", passwordGroupId: "project", sortOrder: 2, isGroupCover: true };
    const independent = { ...seed(), id: "c", isGroupCover: true };
    expect(groupedPasswords([a, b, independent]).map(group => group.map(item => item.id))).toEqual([["a", "b"], ["c"]]);
  });
});
