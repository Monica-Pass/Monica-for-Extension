import { describe, expect, it } from "vitest";
import { createLoginItem, type LoginUriRule } from "./model";
import { loginMatchScore, matchingLogins, normalizeHost } from "./matching";

describe("login URL matching", () => {
  it("normalizes full URLs and www prefixes", () => {
    expect(normalizeHost("https://www.Example.com/login?q=1")).toBe("example.com");
    expect(normalizeHost("accounts.example.com/path")).toBe("accounts.example.com");
  });

  it("uses public and private suffix rules for base-domain matching", () => {
    expect(score("company.co.uk", "base-domain", "https://login.company.co.uk")).toBe(80);
    expect(score("company.co.uk", "base-domain", "https://attacker.co.uk")).toBe(0);
    expect(score("alice.github.io", "base-domain", "https://signin.alice.github.io")).toBe(80);
    expect(score("alice.github.io", "base-domain", "https://bob.github.io")).toBe(0);
  });

  it("implements Android and Bitwarden URI match modes", () => {
    expect(score("example.com", "domain", "https://login.example.com/path")).toBe(90);
    expect(score("login.example.com", "domain", "https://example.com/path")).toBe(0);
    expect(score("https://example.com/auth", "starts-with", "https://example.com/auth/callback?ok=1")).toBe(120);
    expect(score("https://example.com/auth", "exact", "https://example.com/auth")).toBe(140);
    expect(score("https://example.com/auth", "exact", "https://example.com/auth?next=1")).toBe(0);
    expect(score("^https://(?:www\\.)?example\\.com/login", "regex", "https://example.com/login?next=1")).toBe(115);
    expect(score("example.com", "never", "https://example.com")).toBe(0);
  });

  it("rejects invalid or potentially catastrophic regular expressions", () => {
    expect(score("(", "regex", "https://example.com")).toBe(0);
    expect(score("(a+)+$", "regex", `https://example.com/${"a".repeat(500)}!`)).toBe(0);
  });

  it("prefers stronger rules and excludes archived credentials", () => {
    const exact = login("Exact", [{ uri: "https://accounts.example.com/login", matchType: "exact" }]);
    const parent = login("Parent", [{ uri: "example.com", matchType: "base-domain" }], true);
    const archived = { ...login("Archived", [{ uri: "accounts.example.com", matchType: "domain" }]), archivedAt: "2026-07-19T00:00:00.000Z" };
    expect(matchingLogins([parent, archived, exact], "https://accounts.example.com/login").map((item) => item.title)).toEqual(["Exact", "Parent"]);
  });

  it("keeps schema-v1 string URLs compatible", () => {
    const item = createLoginItem({ title: "Legacy", password: "x", uris: ["example.com"] });
    delete item.uriRules;
    expect(loginMatchScore(item, "https://accounts.example.com/login")).toBe(80);
  });

  it("never offers Android special records to ordinary web login forms", () => {
    for (const loginType of ["WIFI", "SSH_KEY", "BARCODE"] as const) {
      const item = login(loginType, [{ uri: "example.com", matchType: "base-domain" }]);
      item.loginType = loginType;
      expect(loginMatchScore(item, "https://example.com/login")).toBe(0);
    }
  });
});

function score(uri: string, matchType: LoginUriRule["matchType"], pageUrl: string): number {
  return loginMatchScore(login("Rule", [{ uri, matchType }]), pageUrl);
}

function login(title: string, uriRules: LoginUriRule[], favorite = false) {
  const item = createLoginItem({ title, favorite });
  item.uris = uriRules.map((rule) => rule.uri);
  item.uriRules = uriRules;
  return item;
}
