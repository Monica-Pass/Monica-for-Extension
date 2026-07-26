import { describe, expect, it } from "vitest";
import {
  assertKeePassFileSupported,
  detectKeePassContainerFormat,
  KeePassOperationError,
  readKeePassHeader,
  toKeePassOperationError
} from "./keepass-format";
import { buildKeePassFixture, withCipherUuid } from "./keepass-fixture";

const TWOFISH_UUID = "rWjyn1dvS7mjatR6+WU0bA==";

/** `KeePassFormatInspector.kt` assertion semantics, extended with cipher detection. */
describe("detectKeePassContainerFormat", () => {
  it("recognises a real KDBX file from its signature", async () => {
    expect(detectKeePassContainerFormat(await buildKeePassFixture())).toBe("kdbx");
  });

  it("recognises both legacy .kdb signatures", () => {
    expect(detectKeePassContainerFormat(new Uint8Array([0x03, 0xd9, 0xa2, 0x9a, 0x65, 0xfb, 0x4b, 0xb5]))).toBe("kdb-legacy");
    expect(detectKeePassContainerFormat(new Uint8Array([0x03, 0xd9, 0xa2, 0x9a, 0x66, 0xfb, 0x4b, 0xb5]))).toBe("kdb-legacy");
  });

  it("falls back to the file extension when the bytes say nothing", () => {
    expect(detectKeePassContainerFormat(new Uint8Array([1, 2, 3]), "Passwords.KDB")).toBe("kdb-legacy");
    expect(detectKeePassContainerFormat(new Uint8Array([1, 2, 3]), "Passwords.kdbx")).toBe("unknown");
    expect(detectKeePassContainerFormat(new Uint8Array([1, 2, 3]))).toBe("unknown");
  });

  it("trusts the signature over a misleading extension", async () => {
    expect(detectKeePassContainerFormat(await buildKeePassFixture(), "exported.kdb")).toBe("kdbx");
  });
});

describe("readKeePassHeader", () => {
  it("reads the version and cipher of a KDBX 4 file", async () => {
    const info = readKeePassHeader(await buildKeePassFixture({ version: 4 }));

    expect(info.format).toBe("kdbx");
    expect(info.versionMajor).toBe(4);
    expect(info.cipherName).toBe("AES-256");
  });

  it("reads a KDBX 3 file, whose header field sizes are 16-bit", async () => {
    const info = readKeePassHeader(await buildKeePassFixture({ version: 3, kdf: "aes" }));

    expect(info.versionMajor).toBe(3);
    expect(info.cipherName).toBe("AES-256");
  });
});

describe("assertKeePassFileSupported", () => {
  it("accepts KDBX 3 and KDBX 4", async () => {
    expect(assertKeePassFileSupported(await buildKeePassFixture({ version: 4 })).versionMajor).toBe(4);
    expect(assertKeePassFileSupported(await buildKeePassFixture({ version: 3, kdf: "aes" })).versionMajor).toBe(3);
  });

  it("names Twofish explicitly instead of failing later as a decryption error", async () => {
    const bytes = withCipherUuid(await buildKeePassFixture(), TWOFISH_UUID);

    expect(() => assertKeePassFileSupported(bytes)).toThrow(KeePassOperationError);
    try {
      assertKeePassFileSupported(bytes);
      expect.unreachable();
    } catch (error) {
      const failure = error as KeePassOperationError;
      expect(failure.code).toBe("cipher-unsupported");
      expect(failure.message).toContain("Twofish");
      expect(failure.message).toContain("AES-256");
    }
  });

  it("rejects an unknown cipher without pretending the password was wrong", async () => {
    const bytes = withCipherUuid(await buildKeePassFixture(), "AAAAAAAAAAAAAAAAAAAAAA==");

    expect(() => assertKeePassFileSupported(bytes)).toThrow(/不支持的加密算法/);
  });

  it("tells the user how to convert a legacy .kdb file", () => {
    try {
      assertKeePassFileSupported(new Uint8Array([0x03, 0xd9, 0xa2, 0x9a, 0x65, 0xfb, 0x4b, 0xb5]));
      expect.unreachable();
    } catch (error) {
      const failure = error as KeePassOperationError;
      expect(failure.code).toBe("legacy-kdb-unsupported");
      expect(failure.message).toContain(".kdbx");
    }
  });

  it("rejects a file that is not a KeePass database at all", () => {
    expect(() => assertKeePassFileSupported(new Uint8Array([1, 2, 3, 4]))).toThrow(/不是 KeePass/);
  });
});

describe("toKeePassOperationError", () => {
  it("maps a kdbxweb InvalidKey onto a credential error", () => {
    const error = toKeePassOperationError(Object.assign(new Error("Invalid key"), { code: "InvalidKey" }));

    expect(error.code).toBe("invalid-credential");
    expect(error.message).toContain("密钥文件");
  });

  it("maps a corrupt file onto a format error", () => {
    const error = toKeePassOperationError(Object.assign(new Error("bad header"), { code: "FileCorrupt" }));

    expect(error.code).toBe("format-unsupported");
  });

  it("maps an Argon2 memory failure onto a KDF error", () => {
    expect(toKeePassOperationError(new Error("argon2: not enough memory")).code).toBe("kdf-memory-insufficient");
  });

  it("passes an already-classified error through untouched", () => {
    const original = new KeePassOperationError("cipher-unsupported", "…");

    expect(toKeePassOperationError(original)).toBe(original);
  });

  it("unwraps a nested cause before classifying", () => {
    const wrapped = Object.assign(new Error("open failed"), {
      cause: Object.assign(new Error("Invalid key"), { code: "InvalidKey" })
    });

    expect(toKeePassOperationError(wrapped).code).toBe("invalid-credential");
  });
});
