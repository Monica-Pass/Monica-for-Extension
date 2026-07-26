import { describe, expect, it } from "vitest";
import type { LoginItem, SecureNoteItem, TotpItem } from "../../core/model";
import { decodeMdbxEntry, encodeMdbxPayload, type MdbxEntryRow } from "./mdbx-entry-codec";

function row(overrides: Partial<MdbxEntryRow> = {}): MdbxEntryRow {
  return {
    entryId: "entry-1",
    projectId: "project-1",
    entryType: "password",
    title: "示例站点",
    payload: {},
    deleted: false,
    ...overrides
  };
}

const LOGIN_PAYLOAD = {
  username: "ada",
  password_plain: "hunter2",
  website: "https://example.test\nhttps://login.example.test",
  authenticator_key: "JBSWY3DPEHPK3PXP",
  login_type: "PASSWORD",
  notes: "备注",
  category_id: 4,
  mdbx_folder_id: "folder-9",
  custom_fields: [{ title: "恢复码", value: "abc", is_protected: true, sort_order: 0, hint_from_a_newer_build: "keep me" }],
  quantum_binding_v3: { issued: "2027-01-01", nested: [1, 2, 3] }
};

describe("mdbx entry decode", () => {
  it("maps a login row onto the shared item model", () => {
    const decoded = decodeMdbxEntry(row({ payload: LOGIN_PAYLOAD }), "mdbx-a", 3);

    expect(decoded.unsupportedReason).toBeUndefined();
    expect(decoded.item).toMatchObject({
      id: "mdbx:mdbx-a:entry-1",
      kind: "login",
      title: "示例站点",
      username: "ada",
      password: "hunter2",
      uris: ["https://example.test", "https://login.example.test"],
      totpSecret: "JBSWY3DPEHPK3PXP",
      loginType: "PASSWORD",
      notes: "备注",
      categoryId: 4,
      mdbxDatabaseId: 3,
      mdbxFolderId: "folder-9",
      customFields: [{ name: "恢复码", value: "abc", protected: true }],
      providerRefs: [{ providerId: "mdbx-a", remoteId: "entry-1" }]
    });
  });

  it("keeps a row whose entry_type this build cannot model instead of parsing or dropping it", () => {
    const decoded = decodeMdbxEntry(row({ entryType: "quantum_credential" }), "mdbx-a", 1);

    expect(decoded.item).toBeUndefined();
    expect(decoded.unsupportedReason).toContain("quantum_credential");
  });

  it("reads note and totp bodies out of the nested item_data JSON", () => {
    const note = decodeMdbxEntry(row({ entryType: "note", payload: { item_data: JSON.stringify({ content: "秘密" }) } }), "mdbx-a", 1);
    const totp = decodeMdbxEntry(
      row({ entryType: "totp", payload: { item_data: JSON.stringify({ authenticatorKey: "SECRET", issuer: "Example", algorithm: "sha512", digits: 8 }) } }),
      "mdbx-a",
      1
    );

    expect(note.item).toMatchObject({ kind: "secure-note", content: "秘密" });
    expect(totp.item).toMatchObject({ kind: "totp", secret: "SECRET", issuer: "Example", algorithm: "SHA512", digits: 8, period: 30 });
  });

  it("falls back to safe defaults rather than trusting an out-of-range algorithm or otp type", () => {
    const decoded = decodeMdbxEntry(
      row({ entryType: "totp", payload: { item_data: JSON.stringify({ secret: "S", algorithm: "SHA3-256", otpType: "QUANTUM", digits: "eight" }) } }),
      "mdbx-a",
      1
    );

    expect(decoded.item).toMatchObject({ algorithm: "SHA1", otpType: undefined, digits: 6 });
  });

  it("marks a tombstoned row as deleted so it is not resurrected on write-back", () => {
    expect(decodeMdbxEntry(row({ deleted: true }), "mdbx-a", 1).item?.deletedAt).toBeTruthy();
  });
});

describe("mdbx payload preservation", () => {
  it("carries an unknown key from a newer build through an edit that only touches the username", () => {
    const original = { ...LOGIN_PAYLOAD };
    const previous = decodeMdbxEntry(row({ payload: original }), "mdbx-a", 1).item as LoginItem;

    const payload = encodeMdbxPayload({ ...previous, username: "grace" }, original, previous);

    expect(payload.quantum_binding_v3).toEqual(LOGIN_PAYLOAD.quantum_binding_v3);
    expect(payload.username).toBe("grace");
  });

  it("leaves an untouched field byte-identical instead of rewriting it in our own shape", () => {
    const original = { ...LOGIN_PAYLOAD };
    const previous = decodeMdbxEntry(row({ payload: original }), "mdbx-a", 1).item as LoginItem;

    const payload = encodeMdbxPayload({ ...previous, username: "grace" }, original, previous);

    expect(payload.custom_fields).toBe(original.custom_fields);
    expect(payload.password_plain).toBe("hunter2");
    expect(payload.website).toBe(LOGIN_PAYLOAD.website);
  });

  it("does not invent keys the original row never had", () => {
    const original = { username: "ada", password_plain: "hunter2" };
    const previous = decodeMdbxEntry(row({ payload: original }), "mdbx-a", 1).item as LoginItem;

    const payload = encodeMdbxPayload({ ...previous, username: "grace" }, original, previous);

    expect(Object.keys(payload).sort()).toEqual(["password_plain", "username"]);
  });

  it("merges into item_data so unknown nested keys survive a note edit", () => {
    const original = { item_data: JSON.stringify({ content: "旧内容", renderer: "markdown-v4", attachments: ["a"] }) };
    const previous = decodeMdbxEntry(row({ entryType: "note", payload: original }), "mdbx-a", 1).item as SecureNoteItem;

    const payload = encodeMdbxPayload({ ...previous, content: "新内容" }, original, previous);

    expect(JSON.parse(payload.item_data as string)).toEqual({ content: "新内容", renderer: "markdown-v4", attachments: ["a"] });
  });

  it("merges into item_data so unknown nested keys survive a totp edit", () => {
    const original = { item_data: JSON.stringify({ authenticatorKey: "OLD", digits: 6, period: 30, algorithm: "SHA1", vendorRecovery: { token: "x" } }) };
    const previous = decodeMdbxEntry(row({ entryType: "totp", payload: original }), "mdbx-a", 1).item as TotpItem;

    const payload = encodeMdbxPayload({ ...previous, secret: "NEW" }, original, previous);

    expect(JSON.parse(payload.item_data as string)).toEqual({ authenticatorKey: "NEW", digits: 6, period: 30, algorithm: "SHA1", vendorRecovery: { token: "x" } });
  });

  it("leaves item_data untouched when nothing inside it changed", () => {
    const original = { item_data: JSON.stringify({ authenticatorKey: "SAME", digits: 6, period: 30, algorithm: "SHA1", trailing: "  spacing  " }) };
    const previous = decodeMdbxEntry(row({ entryType: "totp", payload: original }), "mdbx-a", 1).item as TotpItem;

    const payload = encodeMdbxPayload({ ...previous, title: "换个标题" }, original, previous);

    expect(payload.item_data).toBe(original.item_data);
  });

  it("writes the full field set for a brand new entry", () => {
    const item: LoginItem = {
      id: "local-1",
      kind: "login",
      title: "新条目",
      favorite: false,
      notes: "",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      username: "ada",
      password: "pw",
      uris: ["https://example.test"],
      customFields: [{ name: "F", value: "V", protected: false }],
      providerRefs: []
    };

    const payload = encodeMdbxPayload(item);

    expect(payload).toMatchObject({
      kind: "password",
      username: "ada",
      password_plain: "pw",
      website: "https://example.test",
      custom_fields: [{ title: "F", value: "V", is_protected: false, sort_order: 0 }]
    });
  });
});
