import { describe, expect, it } from "vitest";
import {
  MAX_SITE_POLICY_HOSTS,
  isAutofillBlocked,
  isSaveBlocked,
  normalizeSitePolicy,
  normalizeSitePolicyHost
} from "./site-policy";

describe("autofill site policy", () => {
  it("stores only normalized hostnames", () => {
    expect(normalizeSitePolicyHost(" HTTPS://Login.Example.COM./account?q=secret ")).toBe("login.example.com");
    expect(normalizeSitePolicyHost("bücher.example")).toBe("xn--bcher-kva.example");
  });

  it("rejects unsafe, ambiguous and public-suffix targets", () => {
    for (const value of ["", "https://", "chrome://settings", "javascript:alert(1)", "co.uk", "com", "127.0.0.1", "localhost", "a".repeat(64) + ".example.com"]) {
      expect(() => normalizeSitePolicyHost(value)).toThrow();
    }
  });

  it("blocks an exact host and its subdomains without crossing registrable domains", () => {
    const policy = normalizeSitePolicy({ blockedHosts: ["example.com"], saveBlockedHosts: ["login.example.net"] });
    expect(isAutofillBlocked("https://example.com", policy)).toBe(true);
    expect(isAutofillBlocked("https://accounts.example.com", policy)).toBe(true);
    expect(isAutofillBlocked("https://example.com.attacker.test", policy)).toBe(false);
    expect(isSaveBlocked("https://login.example.net/password", policy)).toBe(true);
    expect(isSaveBlocked("https://example.net", policy)).toBe(false);
  });

  it("deduplicates entries and enforces the encrypted settings budget", () => {
    expect(normalizeSitePolicy({ blockedHosts: ["EXAMPLE.com", "example.com."], saveBlockedHosts: [] }).blockedHosts).toEqual(["example.com"]);
    expect(() => normalizeSitePolicy({
      blockedHosts: Array.from({ length: MAX_SITE_POLICY_HOSTS + 1 }, (_, index) => "host-" + index + ".example.com"),
      saveBlockedHosts: []
    })).toThrow(/不能超过/);
  });

  it("fails closed for malformed or non-web page URLs", () => {
    const policy = normalizeSitePolicy({ blockedHosts: ["example.com"], saveBlockedHosts: [] });
    expect(isAutofillBlocked("not a URL", policy)).toBe(true);
    expect(isAutofillBlocked("chrome-extension://abc/index.html", policy)).toBe(true);
  });
});
