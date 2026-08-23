import { describe, expect, it } from "vitest";
import { parsePortablePasskeyPrivateKey } from "./private-key-portability";

const P256_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsloK6aKNvj0CZMYdBdSZs+AUAsFy1t66q4tq5SvyeJahRANCAASlCTbHlIcaKQ2lzoEFhtjkLEO++f3cYq6FMYG7eH3BmuLQPz71FAtWq4z+tIb7oequwhUJL3xos1nA8jFqpkDs";

describe("portable Passkey private keys", () => {
  it("accepts a real P-256 PKCS#8 value and normalizes URL-safe base64", () => {
    const urlSafe = P256_PKCS8.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(parsePortablePasskeyPrivateKey(urlSafe)).toEqual({ pkcs8Base64: P256_PKCS8, algorithm: -7 });
  });

  it.each(["", "not-a-private-key", "monica-passkey-key-ref-v1:device-only"])("rejects non-portable material %s", (value) => {
    expect(parsePortablePasskeyPrivateKey(value)).toBeUndefined();
  });
});
