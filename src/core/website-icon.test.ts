import { describe, expect, it } from "vitest";
import { loginFallbackIcon, loginWebsiteOrigin, websiteFaviconUrl, websiteOrigin } from "./website-icon";

describe("website icon origins", () => {
  it.each([
    ["https://private-user:private-password@accounts.example.com/login?token=private-token#secret", "https://accounts.example.com"],
    ["  Example.COM/login  ", "https://example.com"],
    ["https://example.com/a path?token=one two", "https://example.com"],
    ["//www.example.com/sign-in", "https://www.example.com"],
    ["https://例子.中国/登录", "https://xn--fsqu00a.xn--fiqs8s"],
    ["http://localhost:8080/login", "http://localhost:8080"],
    ["[::1]:8080/login", "https://[::1]:8080"],
    ["example.com:8443/login", "https://example.com:8443"]
  ])("reduces %s to an origin", (input, expected) => {
    expect(websiteOrigin(input)).toBe(expected);
  });

  it.each([
    "", "otpauth://totp/Example?secret=private-secret", "androidapp://com.example.app", "iosapp://12345",
    "javascript:alert(1)", "data:image/svg+xml,<svg/>", "file:///etc/passwd", "chrome://settings",
    "ssh://user@example.com", "user@example.com", "not a website", "^https://example.com/.*$",
    "https://*.example.com", "https://example.com\\@evil.com", "https://exam\nple.com", "https://"
  ])("does not use non-web or malformed metadata: %s", input => {
    expect(websiteOrigin(input)).toBe("");
  });

  it("uses the first web URI, preserves subdomains, and excludes regex rules", () => {
    expect(loginWebsiteOrigin({ uris: ["androidapp://com.example.app", "otpauth://totp/Secret?secret=secret", "https://accounts.example.com/login", "https://other.example.org"] })).toBe("https://accounts.example.com");
    expect(loginWebsiteOrigin({ uris: ["https://private.example.com"], uriRules: [{ uri: "https://private.example.com", matchType: "regex" }] })).toBe("");
    expect(loginWebsiteOrigin({ uris: [], uriRules: [{ uri: "https://example.com/login", matchType: "exact" }] })).toBe("https://example.com");
    expect(loginWebsiteOrigin({ uris: ["https://example.com"], iconOrigin: "" })).toBe("");
  });

  it("keeps Wi-Fi, SSH, barcode and non-login records on their type icons", () => {
    for (const loginType of ["WIFI", "SSH_KEY", "BARCODE"] as const) {
      expect(loginWebsiteOrigin({ loginType, uris: ["https://example.com"] })).toBe("");
      expect(loginFallbackIcon(loginType)).not.toBe("language");
    }
    expect(loginWebsiteOrigin({ kind: "secure-note", uris: ["https://example.com"] })).toBe("");
  });

  it("only falls back to a public HTTPS origin's fixed favicon path", () => {
    expect(websiteFaviconUrl("https://user:secret@www.example.com/login?token=secret")).toBe("https://www.example.com/favicon.ico");
    for (const origin of ["http://example.com", "https://example.com:8443", "https://127.0.0.1", "https://10.0.0.1", "https://[::1]", "https://8.8.8.8", "https://localhost", "https://host.local", "https://host.internal", "https://example.test", "https://example.invalid", "https://example.onion"]) {
      expect(websiteFaviconUrl(origin), origin).toBe("");
    }
  });
});
