import { expect, it } from "vitest";
import { preserveUneditedProjection } from "./edited-projection";
it("preserves source-only nested fields during a known edit, while honoring explicit removals", () => {
  const source = { address: { street: "old", fullName: "Independent name", future: { a: null } }, note: null };
  const baseline = { address: { street: "old" }, note: "", optional: "" };
  const edited = { address: { street: "new" }, note: "", optional: "" };
  expect(preserveUneditedProjection(source, baseline, edited as unknown as typeof source)).toEqual({ address: { street: "new", fullName: "Independent name", future: { a: null } }, note: null });
  expect(preserveUneditedProjection({ a: "x", future: true }, { a: "x" }, {})).toEqual({ future: true });
});
