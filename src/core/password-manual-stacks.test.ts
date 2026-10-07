import { expect, it } from "vitest";
import { createLoginItem } from "./model";
import { groupedPasswords } from "./password-groups";
import { passwordDisplayStacks } from "./password-display-stacks";
import { MANUAL_STACK_FIELD, NEVER_STACK_FIELD, passwordProjectStackSetting, putPasswordStackSetting, readPasswordStackSetting } from "./password-manual-stacks";

const field = (name: string, value: string) => ({ name, value, protected: false });
it("uses Android's no-stack precedence and exact nonblank manual identifiers", () => {
  const manual = [field(MANUAL_STACK_FIELD, " group ")];
  expect(readPasswordStackSetting(manual)).toEqual({ kind: "manual", groupId: " group " });
  for (const value of ["1", "", "true"]) expect(readPasswordStackSetting([...manual, field(NEVER_STACK_FIELD, value)])).toEqual({ kind: "never" });
  expect(readPasswordStackSetting([...manual, field(NEVER_STACK_FIELD, "0")])).toEqual({ kind: "manual", groupId: " group " });
});
it("preserves unrelated field bytes, position, attributes and internal project content while replacing only stack metadata", () => {
  const original = [field("ordinary", "  exact\nvalue "), { ...field("monica.content.future", "{unknown:9007199254740995}"), protected: true },
    { ...field(MANUAL_STACK_FIELD, "old"), fieldType: "TEXT" as const }, field(NEVER_STACK_FIELD, "1")];
  const manual = putPasswordStackSetting(original, "stack", "new");
  expect(manual).toEqual([original[0], original[1], { ...original[2], value: "new" }]);
  expect(putPasswordStackSetting(manual, "stack", "new")).toBe(manual);
  const never = putPasswordStackSetting(manual, "never");
  expect(never).toEqual([original[0], original[1], field(NEVER_STACK_FIELD, "1")]);
  expect(putPasswordStackSetting(never, "auto")).toEqual(original.slice(0, 2));
});
it.each(["duplicate", "protected", "future-type"])("preserves %s carriers and refuses destructive normalization", kind => {
  const marker = field(MANUAL_STACK_FIELD, "group");
  const fields = kind === "duplicate" ? [marker, marker] : [{ ...marker, ...(kind === "protected" ? { protected: true } : { fieldType: "BOOLEAN" as const }) }];
  expect(readPasswordStackSetting(fields)).toEqual({ kind: "invalid" });
  expect(() => putPasswordStackSetting(fields, "auto")).toThrow("已保留原始字段");
});
it("manual display overrides automatic rules while retaining complete projects, source separation, never-stack and no-group view", () => {
  const base = createLoginItem({ title: "Same", uris: ["https://example.test"] });
  const marked = { ...base, customFields: [field(MANUAL_STACK_FIELD, "group")] };
  const items = [{ ...marked, id: "a", passwordGroupId: "project" }, { ...base, id: "b", passwordGroupId: "project" },
    { ...marked, id: "c", uris: ["https://other.test"] }, { ...marked, id: "d", providerRefs: [{ providerId: "other" }] },
    { ...marked, id: "e", customFields: [...marked.customFields, field(NEVER_STACK_FIELD, "1")] }, { ...base, id: "f" }];
  const projects = groupedPasswords(items);
  const before = JSON.stringify(items);
  const stacks = passwordDisplayStacks(projects, "website");
  expect(stacks.map(stack => stack.projects.flat().map(item => item.id))).toEqual([["a", "b", "c"], ["d"], ["e"], ["f"]]);
  expect(stacks.map(stack => stack.setting)).toEqual(["manual", "manual", "never", undefined]);
  expect(passwordDisplayStacks(projects, "manual")).toHaveLength(4);
  expect(passwordDisplayStacks(projects, "none")).toHaveLength(5);
  expect(JSON.stringify(items)).toBe(before);
  expect(passwordProjectStackSetting([marked, { ...marked, customFields: [field(MANUAL_STACK_FIELD, "different")] }])).toEqual({ kind: "invalid" });
});
