import { describe, expect, it } from "vitest";
import { createLoginItem } from "./model";
import { loginMatchScore, matchingLogins, normalizeHost } from "./matching";

describe("login URL matching", () => {
  it("normalizes full URLs and www prefixes", () => {
    expect(normalizeHost("https://www.Example.com/login?q=1")).toBe("example.com");
    expect(normalizeHost("accounts.example.com/path")).toBe("accounts.example.com");
  });

  it("prefers exact hosts and accepts parent-domain matches", () => {
    const exact = createLoginItem({ title: "Exact", password: "x", uris: ["accounts.example.com"] });
    const parent = createLoginItem({ title: "Parent", password: "x", uris: ["example.com"], favorite: true });
    const other = createLoginItem({ title: "Other", password: "x", uris: ["example.net"] });
    expect(loginMatchScore(exact, "https://accounts.example.com/login")).toBe(100);
    expect(loginMatchScore(parent, "https://accounts.example.com/login")).toBe(80);
    expect(matchingLogins([parent, other, exact], "https://accounts.example.com/login").map((item) => item.title)).toEqual(["Exact", "Parent"]);
  });
});
