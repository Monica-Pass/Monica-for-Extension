import { expect, it } from "vitest";
import { createLoginItem, type LoginItem } from "./model";
import { groupedPasswords } from "./password-groups";
import { passwordCoverPeers, passwordDisplayStacks, passwordWebsiteLabel } from "./password-display-stacks";
import { normalizeHomePreferences } from "./home-preferences";

const row = (id: string, props: Partial<LoginItem> = {}): LoginItem => ({ ...createLoginItem({ title: "Same title", uris: ["https://example.test/login"] }), id, ...props });

it("groups whole projects for display while preserving members, credential ordering, and source boundaries", () => {
  const rows = [row("a", { passwordGroupId: "project", sortOrder: 0 }), row("b", { passwordGroupId: "project", sortOrder: 1 }),
    row("c", { isGroupCover: true }), row("d", { providerRefs: [{ providerId: "other" }] }), row("e", { mdbxDatabaseId: 2 })];
  const projects = groupedPasswords(rows);
  const before = JSON.stringify(rows);
  const stacks = passwordDisplayStacks(projects, "website");
  expect(stacks.map(stack => stack.projects.map(project => project.map(item => item.id)))).toEqual([[["a", "b"], ["c"]], [["d"]], [["e"]]]);
  expect(stacks[0].representative.id).toBe("c");
  expect(stacks[0].passwordCount).toBe(3);
  expect(JSON.stringify(rows)).toBe(before);
  expect(passwordDisplayStacks(projects, "none")).toHaveLength(4);
});

it.each([
  ["https://WWW.example.test:443/login?next=x", "strict", "example.test"],
  ["https://accounts.example.test/", "strict", "accounts.example.test"],
  ["accounts.example.test", "relaxed", "example.test"],
  ["https://a.example.co.uk", "relaxed", "example.co.uk"],
  ["127.0.0.1:8080/login", "relaxed", "127.0.0.1"],
  ["http://[::1]:8080", "relaxed", "[::1]"]
] as const)("uses the display domain of %s in %s mode", (uri, mode, expected) => {
  expect(passwordWebsiteLabel(uri, mode)).toBe(expected);
});

it("does not merge missing website labels or same-named folders with different identities", () => {
  const empty = [row("a", { uris: [] }), row("b", { uris: [] })];
  expect(passwordDisplayStacks(groupedPasswords(empty), "website")).toHaveLength(2);
  const folders = [row("a", { categoryName: "Work", categoryId: 1 }), row("b", { categoryName: "Work", categoryId: 2 })];
  expect(passwordDisplayStacks(groupedPasswords(folders), "folder")).toHaveLength(2);
});

it("uses Android's first nonempty note line, app-name fallback, and smart priority", () => {
  const item = row("a", { notes: "\n  Work  \nsecond", appName: "", appPackageName: "test.application" });
  for (const mode of ["note", "smart"] as const) expect(passwordDisplayStacks([[item]], mode)[0].label).toBe("Work");
  expect(passwordDisplayStacks([[item]], "app")[0].label).toBe("test.application");
  expect(passwordDisplayStacks([[item]], "title")[0].label).toBe("Same title");
});

it("uses exact website strings and active source scope for cover clearing, separately from normalized display groups", () => {
  const a = row("a");
  const rows = [a, row("same"), row("path", { uris: ["https://example.test/other"] }), row("source", { providerRefs: [{ providerId: "other" }] }),
    row("deleted", { deletedAt: "2026-10-05" }), row("archived", { archivedAt: "2026-10-05" })];
  expect(passwordCoverPeers(a, rows).map(item => item.id)).toEqual(["a", "same"]);
  expect(passwordDisplayStacks(groupedPasswords(rows.slice(0, 3)), "website")[0].projects).toHaveLength(3);
  const empty = row("empty", { uris: [] });
  expect(passwordCoverPeers(empty, [empty, row("other-empty", { uris: [] })]).map(item => item.id)).toEqual(["empty"]);
});

it("migrates missing display preferences and retains only supported values", () => {
  expect(normalizeHomePreferences()).toMatchObject({ passwordStackMode: "none", passwordWebsiteMatch: "strict" });
  expect(normalizeHomePreferences({ passwordStackMode: "website", passwordWebsiteMatch: "relaxed" })).toMatchObject({ passwordStackMode: "website", passwordWebsiteMatch: "relaxed" });
  expect(normalizeHomePreferences({ passwordStackMode: "unknown", passwordWebsiteMatch: {} })).toMatchObject({ passwordStackMode: "none", passwordWebsiteMatch: "strict" });
});
