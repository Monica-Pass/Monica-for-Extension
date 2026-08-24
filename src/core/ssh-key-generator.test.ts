import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeSshMpint, generateSshKeyPair, SSH_DEFAULT_RSA_KEY_SIZE } from "./ssh-key-generator";

function base64UrlSafe(value: string): Uint8Array { return Uint8Array.from(Buffer.from(value.replace(/^ssh-(ed25519|rsa) /, "").split(" ")[0], "base64")); }

interface Cursor { data: Uint8Array; offset: number; }
function readUint32(cursor: Cursor): number { const value = Number(new DataView(cursor.data.buffer, cursor.data.byteOffset + cursor.offset).getUint32(0)); cursor.offset += 4; return value; }
function readBytes(cursor: Cursor, length: number): Uint8Array { const slice = cursor.data.subarray(cursor.offset, cursor.offset + length); cursor.offset += length; return slice; }
function readString(cursor: Cursor): Uint8Array { return readBytes(cursor, readUint32(cursor)); }
function text(value: Uint8Array): string { return new TextDecoder().decode(value); }

function parseOpenSshContainer(pem: string) {
  const body = pem.split("\n").filter((line) => line && !line.startsWith("-----")).join("");
  expect(pem.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
  expect(pem.endsWith("-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
  for (const line of pem.split("\n").filter((line) => line && !line.startsWith("-----"))) expect(line.length).toBeLessThanOrEqual(70);
  const cursor: Cursor = { data: Uint8Array.from(Buffer.from(body, "base64")), offset: 0 };
  expect(text(readBytes(cursor, 15))).toBe("openssh-key-v1\0");
  expect(text(readString(cursor))).toBe("none");
  expect(text(readString(cursor))).toBe("none");
  expect(readString(cursor).length).toBe(0);
  expect(readUint32(cursor)).toBe(1);
  const publicBlob = readString(cursor);
  const privateSection = readString(cursor);
  const privateCursor: Cursor = { data: privateSection, offset: 0 };
  const checkInt = readUint32(privateCursor);
  expect(readUint32(privateCursor)).toBe(checkInt);
  expect(checkInt).not.toBe(0);
  const keyType = text(readString(privateCursor));
  return { cursor, publicBlob, keyType, privateCursor };
}

describe("SSH key generator parity", () => {
  it("encodes SSH mpints like the wire format requires", () => {
    expect([...encodeSshMpint(new Uint8Array([0]))]).toEqual([]);
    expect([...encodeSshMpint(new Uint8Array([1]))]).toEqual([1]);
    expect([...encodeSshMpint(new Uint8Array([0x80]))]).toEqual([0, 0x80]);
    expect([...encodeSshMpint(new Uint8Array([1, 0, 1]))]).toEqual([1, 0, 1]);
    expect([...encodeSshMpint(new Uint8Array([0, 0, 5]))]).toEqual([5]);
  });

  it("generates Ed25519 keys in the unencrypted openssh-key-v1 container", async () => {
    const key = await generateSshKeyPair({ algorithm: "ED25519" });
    expect(key.algorithm).toBe("ED25519");
    expect(key.keySize).toBe(256);
    expect(key.format).toBe("OPENSSH");
    expect(key.comment).toBe("");

    const { cursor, publicBlob, keyType, privateCursor } = parseOpenSshContainer(key.privateKeyOpenSsh);
    expect(keyType).toBe("ssh-ed25519");
    expect(cursor.offset).toBe(cursor.data.length);

    const publicKeyLine = key.publicKeyOpenSsh.split(" ");
    expect(publicKeyLine[0]).toBe("ssh-ed25519");
    expect(base64UrlSafe(key.publicKeyOpenSsh)).toEqual(publicBlob);
    expect(publicBlob.length).toBe(51);
    expect([...publicBlob.subarray(0, 4)]).toEqual([0, 0, 0, 11]);
    expect([...publicBlob.subarray(4, 15)]).toEqual([...new TextEncoder().encode("ssh-ed25519")]);
    const rawPublic = publicBlob.subarray(19);
    expect(rawPublic.length).toBe(32);

    const embeddedPublicField = readString(privateCursor);
    expect([...embeddedPublicField]).toEqual([...rawPublic]);
    const privateKeyMaterial = readString(privateCursor);
    expect(privateKeyMaterial.length).toBe(64);
    expect([...privateKeyMaterial.subarray(32)]).toEqual([...rawPublic]);
    const commentField = readString(privateCursor);
    const remaining = privateCursor.data.subarray(privateCursor.offset);
    expect(commentField.length).toBe(0);
    expect([...remaining]).toEqual(Array.from({ length: remaining.length }, (_, index) => index + 1));

    const expectedFingerprint = "SHA256:" + createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "");
    expect(key.fingerprintSha256).toBe(expectedFingerprint);
  });

  it("generates RSA keys whose factors multiply back to the modulus", async () => {
    const key = await generateSshKeyPair({ algorithm: "RSA", rsaKeySize: 2048 });
    expect(key.algorithm).toBe("RSA");
    expect(key.keySize).toBe(2048);
    expect(key.publicKeyOpenSsh.startsWith("ssh-rsa ")).toBe(true);
    const { publicBlob, keyType, privateCursor } = parseOpenSshContainer(key.privateKeyOpenSsh);
    expect(keyType).toBe("ssh-rsa");

    const publicCursor: Cursor = { data: publicBlob, offset: 0 };
    expect(text(readString(publicCursor))).toBe("ssh-rsa");
    const e = readString(publicCursor);
    const n = readString(publicCursor);
    expect([...e]).toEqual([1, 0, 1]);

    const values = ["n", "e", "d", "iqmp", "p", "q"].map(() => readString(privateCursor));
    expect([...values[0]]).toEqual([...n]);
    expect([...values[1]]).toEqual([...e]);

    const toBigInt = (value: Uint8Array) => BigInt("0x" + Buffer.from(value).toString("hex") || "0");
    expect(toBigInt(values[4]) * toBigInt(values[5])).toBe(toBigInt(values[0]));
  }, 30000);

  it("rejects unsupported RSA sizes and appends trimmed comments", async () => {
    await expect(generateSshKeyPair({ algorithm: "RSA", rsaKeySize: 1024 })).rejects.toThrow("2048");
    const key = await generateSshKeyPair({ algorithm: "ED25519", comment: " monica@browser " });
    expect(key.comment).toBe("monica@browser");
    expect(key.publicKeyOpenSsh.endsWith(" monica@browser")).toBe(true);
  });

  it("keeps Android's default algorithm and RSA size constants", () => {
    expect(SSH_DEFAULT_RSA_KEY_SIZE).toBe(3072);
  });
});
