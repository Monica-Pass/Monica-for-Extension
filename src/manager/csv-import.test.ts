import { describe, expect, it } from "vitest";
import { parseCsvToVaultItems } from "./csv-import";

describe("csv import", () => {
  it("parses quoted fields, escaped quotes, CRLF, and commas inside quotes", () => {
    const csv = "name,url,username,password\r\n\"My, Account\",\"https://example.com\",joy,\"pass\"\"word\"\r\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "login",
      title: "My, Account",
      username: "joy",
      password: 'pass"word',
      uris: ["https://example.com"]
    });
  });

  it("maps Chrome-style headers", () => {
    const csv = "name,url,username,password,note\nGitHub,https://github.com,octocat,token123,backup account\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items[0]).toMatchObject({
      title: "GitHub", username: "octocat", password: "token123", uris: ["https://github.com"], notes: "backup account"
    });
  });

  it("maps Bitwarden-style headers", () => {
    const csv = "login_uri,login_username,login_password,login_totp\nhttps://bitwarden.com,bwuser,bwpass,JBSWY3DPEHPK3PXP\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items[0]).toMatchObject({
      username: "bwuser", password: "bwpass", uris: ["https://bitwarden.com"], totpSecret: "JBSWY3DPEHPK3PXP"
    });
  });

  it("handles mixed-case headers", () => {
    const csv = "Name,URL,UserName,Password\nSite,https://example.com,user,pass\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items[0]).toMatchObject({
      title: "Site", username: "user", password: "pass", uris: ["https://example.com"]
    });
  });

  it("splits semicolon-separated URLs into multiple URIs", () => {
    const csv = "name,url,username,password\nMulti,https://a.com;https://b.com,user,pass\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items[0]).toMatchObject({ uris: ["https://a.com", "https://b.com"] });
  });

  it("converts favorite column values to boolean", () => {
    const csv = "name,username,password,favorite\nA,u,p,true\nB,u,p,1\nC,u,p,yes\nD,u,p,false\nE,u,p,\nF,u,p,maybe\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items).toHaveLength(6);
    expect(result.items[0]).toMatchObject({ favorite: true });
    expect(result.items[1]).toMatchObject({ favorite: true });
    expect(result.items[2]).toMatchObject({ favorite: true });
    expect(result.items[3]).toMatchObject({ favorite: false });
    expect(result.items[4]).toMatchObject({ favorite: false });
    expect(result.items[5]).toMatchObject({ favorite: false });
  });

  it("produces an item with default title for all-empty rows", () => {
    const csv = "name,url,username,password\n,,,\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ title: "导入项目", username: "", password: "" });
    expect(result.skipped).toBe(0);
  });

  it("returns empty results for empty or header-only input", () => {
    expect(parseCsvToVaultItems("")).toEqual({ items: [], skipped: 0 });
    expect(parseCsvToVaultItems("name,url,username,password\n")).toEqual({ items: [], skipped: 0 });
  });

  it("normalizes rows into login items with all fields", () => {
    const csv = "name,url,username,password,note,totp,favorite\nBank,https://bank.com;https://m.bank.com,john,secret,main account,JBSWY3DPEHPK3PXP,1\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "login",
      title: "Bank",
      username: "john",
      password: "secret",
      uris: ["https://bank.com", "https://m.bank.com"],
      notes: "main account",
      totpSecret: "JBSWY3DPEHPK3PXP",
      favorite: true
    });
  });

  it("uses email column as username when no username column exists", () => {
    const csv = "name,email,password\nSite,john@example.com,pass\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items[0]).toMatchObject({ username: "john@example.com" });
  });

  it("uses first non-empty value when multiple columns map to the same field", () => {
    const csv = "name,url,login_uri,username\nSite,https://first.com,https://second.com,user\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items[0]).toMatchObject({ uris: ["https://first.com"] });
  });

  it("falls back to second URL column when first is empty", () => {
    const csv = "name,url,login_uri,username\nSite,,https://second.com,user\n";
    const result = parseCsvToVaultItems(csv);
    expect(result.items[0]).toMatchObject({ uris: ["https://second.com"] });
  });

  it("passes the now timestamp to the normalizer", () => {
    const csv = "name,username,password\nTest,u,p\n";
    const result = parseCsvToVaultItems(csv, "2024-01-01T00:00:00.000Z");
    expect(result.items[0]).toMatchObject({ createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" });
  });
});
