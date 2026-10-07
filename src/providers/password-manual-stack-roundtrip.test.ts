import { expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import { strToU8, zipSync } from "fflate";
import { createLoginItem, type LoginItem } from "../core/model";
import { MANUAL_STACK_FIELD, putPasswordStackSetting, readPasswordStackSetting } from "../core/password-manual-stacks";
import { readAndroidBackup, writeAndroidBackup } from "./webdav/android-backup-codec";
import { decodeMdbx2Object, encodeMdbx2Object } from "./mdbx2/mdbx2-item-codec";
import { buildKeePassFixture, keePassCredentials } from "./keepass/keepass-fixture";
import { readKeePassEntries } from "./keepass/keepass-vault";
import { writeKeePassEntry } from "./keepass/keepass-writer";
import { decodeBitwardenCipher, encodeBitwardenCipher } from "./bitwarden/bitwarden-cipher-codec";

const key = { encKey: new Uint8Array(32).fill(21), macKey: new Uint8Array(32).fill(22) };
const seed = (): LoginItem => ({ ...createLoginItem({ title: "Synthetic", password: "fixture-secret" }),
  customFields: [{ name: "ordinary", value: " raw\nvalue ", protected: true }, { name: MANUAL_STACK_FIELD, value: "old", protected: false }] });
const native = (payloadJson: string) => decodeMdbx2Object({ objectId: "stack", collectionId: "folder", objectTypeId: "login", title: "Synthetic",
  payloadSchemaVersion: 1, deleted: false, payloadJson }, { headCommitId: "head", updatedAt: "2026-10-06T00:00:00Z" }, "source").item as LoginItem;

it.each(["stack", "never", "auto"] as const)("updates existing %s stack carriers across encrypted KDBX, Bitwarden, native payload and Android ZIP", async action => {
  const verify = (item: LoginItem) => {
    expect(readPasswordStackSetting(item.customFields)).toEqual(action === "stack" ? { kind: "manual", groupId: "new-stack" } : { kind: action });
    expect(item.customFields).toContainEqual(expect.objectContaining({ name: "ordinary", value: " raw\nvalue ", protected: true }));
    expect(item.password).toBe("fixture-secret");
  };
  const mutate = (item: LoginItem) => ({ ...item, customFields: putPasswordStackSetting(item.customFields, action, "new-stack") });
  const initial = seed();
  let db = await kdbxweb.Kdbx.load((await buildKeePassFixture({ password: "synthetic", entries: [{ title: "Target" }] })).slice().buffer, keePassCredentials("synthetic"));
  writeKeePassEntry(db, db.getDefaultGroup().entries[0], initial);
  writeKeePassEntry(db, db.getDefaultGroup().entries[0], mutate(readKeePassEntries(db, 1, "source").items[0] as LoginItem));
  db = await kdbxweb.Kdbx.load(await db.save(), keePassCredentials("synthetic"));
  verify(readKeePassEntries(db, 1, "new-source").items[0] as LoginItem);
  const raw = { ...await encodeBitwardenCipher(initial, key), id: "stack" };
  const oldCipher = (await decodeBitwardenCipher(raw, "source", key)).items[0] as LoginItem;
  const edited = { ...await encodeBitwardenCipher(mutate(oldCipher), key, raw), id: "stack" };
  verify((await decodeBitwardenCipher(edited, "new-source", key)).items[0] as LoginItem);
  const oldNative = encodeMdbx2Object(initial)!.payloadJson;
  const decoded = native(oldNative);
  verify(native(encodeMdbx2Object(mutate(decoded), JSON.parse(oldNative), decoded)!.payloadJson));
  const doc = readAndroidBackup(zipSync({ "folders/_root/passwords/password_1_0.json": strToU8(JSON.stringify({ id: 1, title: "Synthetic", password: "fixture-secret" })) }), "source");
  const original = readAndroidBackup(writeAndroidBackup(doc, [{ ...initial, id: doc.items[0].id }], "source"), "source");
  const updated = writeAndroidBackup(original, [mutate(original.items[0] as LoginItem)], "source");
  verify(readAndroidBackup(updated, "new-source").items[0] as LoginItem);
});
