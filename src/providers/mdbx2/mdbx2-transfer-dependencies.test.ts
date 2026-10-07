import { expect, it } from "vitest";
import { createLoginItem, type SecureNoteItem } from "../../core/model";
import { completeTransferComponents, mdbx2TransferDependencies } from "./mdbx2-transfer-dependencies";

const first = { ...createLoginItem({ title: "Account A" }), id: "a", boundNoteEntryId: "note:shared", passwordGroupId: "group" };
const sibling = { ...createLoginItem({ title: "Account B" }), id: "b", passwordGroupId: "group" };
const other = { ...createLoginItem({ title: "Independent" }), id: "c", boundNoteEntryId: "note:shared" };
const note: SecureNoteItem = { id: "n", kind: "secure-note", title: "Note", notes: "", content: "body", favorite: false,
  createdAt: first.createdAt, updatedAt: first.updatedAt, providerRefs: [], replicaGroupId: "note:shared" };
const items = [first, sibling, other, note];

it("expands SSO chains once for copy and includes incoming websites for move", () => {
  const account = {...first,id:'account',passwordGroupId:undefined,boundNoteEntryId:undefined,replicaGroupId:'password:account'};
  const website = {...account,id:'website',replicaGroupId:'password:website',ssoRefLogicalId:'password:account'};
  const otherWebsite = {...website,id:'other',replicaGroupId:'password:other'};
  const chain = {...website,id:'chain',ssoRefLogicalId:'password:website'};
  const all=[account,website,otherWebsite,chain];
  expect(mdbx2TransferDependencies(['chain'],all,'copy').selectedIds).toEqual(['account','website','chain']);
  expect(mdbx2TransferDependencies(['account'],all,'move').selectedIds).toEqual(['account','website','other','chain']);
});

it("copy includes a password's group and shared note without copying other referring passwords", () => {
  expect(mdbx2TransferDependencies(["a"], items, "copy").selectedIds).toEqual(["a", "b", "n"]);
  expect(mdbx2TransferDependencies(["n"], items, "copy").selectedIds).toEqual(["n"]);
  expect(mdbx2TransferDependencies(["a", "c"], items, "copy").components).toHaveLength(1);
});

it("move expands incoming note references and their complete password groups to a fixed point", () => {
  const result = mdbx2TransferDependencies(["n"], items, "move");
  expect(result.selectedIds).toEqual(["a", "b", "c", "n"]);
  expect(new Set(result.components[0])).toEqual(new Set(result.selectedIds));
});

it("never connects same-title or same-ID notes in a different vault and retains ambiguity for rejection", () => {
  const foreign = { ...note, id: "foreign", providerRefs: [{ providerId: "elsewhere" }] };
  expect(mdbx2TransferDependencies([foreign.id], [...items, foreign], "move").selectedIds).toEqual([foreign.id]);
  const duplicate = { ...note, id: "duplicate" };
  expect(mdbx2TransferDependencies(["a"], [...items, duplicate], "copy").selectedIds).toContain("duplicate");
  expect(mdbx2TransferDependencies(["a"], [...items, { ...duplicate, deletedAt: first.createdAt }], "copy").selectedIds).not.toContain("duplicate");
});

it("isolates a failed dependency group while leaving independent work eligible", () => {
  const groups = completeTransferComponents([["a", "b", "n"], ["c"]], [first, other, note], entry => entry.id);
  expect(groups.map(group => group.complete)).toEqual([false, true]);
  expect(groups[0].entries.map(item => item.id)).toEqual(["a", "n"]);
});
