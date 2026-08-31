import { describe, expect, it } from "vitest";
import { parsePortablePasskeyPrivateKey } from "./private-key-portability";

const P256_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsloK6aKNvj0CZMYdBdSZs+AUAsFy1t66q4tq5SvyeJahRANCAASlCTbHlIcaKQ2lzoEFhtjkLEO++f3cYq6FMYG7eH3BmuLQPz71FAtWq4z+tIb7oequwhUJL3xos1nA8jFqpkDs";
const P384_PKCS8 = "MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDDw4m0xJM1l3eOQ1/VpJm5AqtdhUDlapdRomk8CWzOwTBIZYSktEnXXOuUFU2C1H+6hZANiAARMksW8+EocjATwLf+/obwO/a9pXdoT2aLPxLxOZWyTRv+kUx60c93rFiRYX8owc4J3hYVIpITtpKcyrHJnYI5Wus0Zuhe72uG9m9PjqsQ+hR8K3FVRsMSXMr5+QDQdgfs=";

describe("portable Passkey private keys", () => {
  it("accepts a real P-256 PKCS#8 value and normalizes URL-safe base64", () => {
    const urlSafe = P256_PKCS8.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(parsePortablePasskeyPrivateKey(urlSafe)).toEqual({ pkcs8Base64: P256_PKCS8, algorithm: -7 });
  });

  it("rejects EC keys whose curve is not P-256", () => {
    expect(parsePortablePasskeyPrivateKey(P384_PKCS8)).toBeUndefined();
  });

  it.each(["", "not-a-private-key", "monica-passkey-key-ref-v1:device-only"])("rejects non-portable material %s", (value) => {
    expect(parsePortablePasskeyPrivateKey(value)).toBeUndefined();
  });
});
