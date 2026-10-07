import { expect, it } from "vitest";
import { applyBoundNoteChoice, boundNoteCandidates, boundNoteLogicalId, resolveBoundNote } from "./bound-notes";
import type { LoginItem, SecureNoteItem } from "./model";
const base = { title: "Same title", favorite: false, notes: "", createdAt: "2026-10-01", updatedAt: "2026-10-01", providerRefs: [{ providerId: "vault-a" }] };
const login: LoginItem = { ...base, id: "password", kind: "login", username: "demo", password: "secret", uris: [], customFields: [], boundNoteId: 22, boundNoteEntryId: "note:stable" };
const note: SecureNoteItem = { ...base, id: "browser-note", kind: "secure-note", content: "Full note", replicaGroupId: "note:stable" };
it("resolves stable IDs within the vault, never numeric Room IDs or matching titles", () => {
  const elsewhere = { ...note, id: "elsewhere", providerRefs: [{ providerId: "vault-b" }] };
  expect(resolveBoundNote(login, [elsewhere, note])).toBe(note);
  expect(resolveBoundNote(login, [elsewhere, { ...note, replicaGroupId: "note:different" }])).toBeUndefined();
  expect(resolveBoundNote({ ...login, boundNoteEntryId: undefined }, [note])).toBeUndefined();
});
it("refuses ambiguous replicas, deleted notes and different database scopes", () => {
  expect(boundNoteCandidates(login, [note, { ...note, id: "duplicate" }])).toEqual([]);
  expect(boundNoteCandidates(login, [{ ...note, deletedAt: "2026-10-02" }, { ...note, mdbxDatabaseId: 9 }])).toEqual([]);
  expect(() => applyBoundNoteChoice(login, "note:stable", [{ ...note, providerRefs: [] }])).toThrow();
});
it("replacement and unlink clear stale Room identity but preserve other content", () => {
  expect(applyBoundNoteChoice(login, "note:stable", [note])).toEqual({ ...login, boundNoteId: undefined });
  expect(applyBoundNoteChoice(login, "", [])).toEqual({ ...login, boundNoteEntryId: undefined, boundNoteId: undefined });
  expect(login.boundNoteId).toBe(22);
  expect(boundNoteLogicalId({ ...note, replicaGroupId: "other:123" })).toBe("note:browser-note");
});
