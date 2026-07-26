import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import { buildKeePassCredentialCandidates, keePassInvalidCredentialMessage } from "./keepass-credentials";
import { buildKeePassFixture } from "./keepass-fixture";

/** Assertion semantics translated from Android `KeePassCredentialSupportTest.kt`. */
const RAW_KEY = new Uint8Array(32).map((_, index) => index + 1);
const XML_KEY_FILE = new TextEncoder().encode(
  `<?xml version="1.0" encoding="utf-8"?>\n<KeyFile><Key><Data>${btoa(String.fromCharCode(...RAW_KEY))}</Data></Key></KeyFile>`
);
const HEX_KEY_FILE = new TextEncoder().encode("00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF");

async function labels(password: string, keyFile?: Uint8Array): Promise<string[]> {
  return (await buildKeePassCredentialCandidates(password, keyFile)).map((candidate) => candidate.label);
}

describe("buildKeePassCredentialCandidates", () => {
  it("builds only a password candidate when there is no key file", async () => {
    expect(await labels("demo")).toEqual(["password-only"]);
  });

  it("extracts the key from a KeePassXC XML key file", async () => {
    expect(await labels("", XML_KEY_FILE)).toEqual(expect.arrayContaining([expect.stringMatching(/^xml-data\//)]));
  });

  it("extracts the key from a 64-character hex text key file", async () => {
    expect(await labels("", HEX_KEY_FILE)).toEqual(expect.arrayContaining([expect.stringMatching(/^hex-text\//)]));
  });

  it("tries both key-only and empty-password+key when the password is blank", async () => {
    const attempted = await labels("", RAW_KEY);

    expect(attempted).toContain("raw/key-only");
    expect(attempted).toContain("raw/empty-password+key");
  });

  it("tries only the combined credential when a password is supplied", async () => {
    const attempted = await labels("demo", RAW_KEY);

    expect(attempted.every((label) => label.endsWith("/password+key"))).toBe(true);
  });

  it("deduplicates variants that decode to the same key material", async () => {
    const attempted = await labels("demo", RAW_KEY);

    expect(new Set(attempted).size).toBe(attempted.length);
    // A 32-byte binary key is not valid UTF-8, so only `raw` and `sha256(raw)` survive.
    expect(attempted).toEqual(["raw/password+key", "sha256(raw)/password+key"]);
  });

  it("does not blow up on a binary key file that is not valid UTF-8", async () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]);

    expect((await labels("demo", binary)).length).toBeGreaterThan(0);
  });

  it("actually opens a database that was created with an empty password and a key file", async () => {
    const bytes = await buildKeePassFixture({ password: null, keyFile: RAW_KEY, entries: [{ title: "keyed" }] });
    const candidates = await buildKeePassCredentialCandidates("", RAW_KEY);

    const opened: string[] = [];
    for (const candidate of candidates) {
      try {
        await kdbxweb.Kdbx.load(bytes.buffer as ArrayBuffer, candidate.credentials);
        opened.push(candidate.label);
      } catch {
        // A candidate that does not match is expected; the loop exists precisely to find the one that does.
      }
    }

    expect(opened).toContain("raw/key-only");
  });
});

describe("keePassInvalidCredentialMessage", () => {
  it("lists what was attempted so the failure is actionable", () => {
    const message = keePassInvalidCredentialMessage(["raw/password+key", "xml-data/password+key"]);

    expect(message).toContain("已尝试");
    expect(message).toContain("raw/password+key");
  });

  it("summarises rather than listing everything when there were many attempts", () => {
    const message = keePassInvalidCredentialMessage(["a", "b", "c", "d", "e", "f"]);

    expect(message).toContain("等6种组合");
  });

  it("falls back to a plain message when nothing was attempted", () => {
    expect(keePassInvalidCredentialMessage([])).toBe("数据库密码或密钥文件不正确。");
  });
});
