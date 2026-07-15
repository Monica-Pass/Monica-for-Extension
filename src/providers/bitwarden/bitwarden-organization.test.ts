import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../security/encoding";
import { encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { resolveBitwardenOrganizationKeys } from "./bitwarden-organization";

const USER_KEY: BitwardenSymmetricKey = {
  encKey: Uint8Array.from({ length: 32 }, (_, index) => index),
  macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 32)
};

describe("Bitwarden organization keys", () => {
  it("unwraps valid organization keys and isolates malformed organizations", async () => {
    const { privateKeyPkcs8, organizationCipher } = await organizationKeyFixture();
    const privateKeyCipher = await encryptBitwardenString(bytesToBase64(privateKeyPkcs8), USER_KEY);
    const result = await resolveBitwardenOrganizationKeys({
      Profile: {
        PrivateKey: privateKeyCipher,
        Organizations: [
          { Id: "org-valid", Key: organizationCipher },
          { Id: "org-invalid", Key: "4.AA==" }
        ]
      }
    }, USER_KEY);

    expect(result.keys.get("org-valid")).toEqual({
      encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 64),
      macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 96)
    });
    expect(result.keys.has("org-invalid")).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("org-invalid");
  });

  it("reports a missing private key only when organizations need it", async () => {
    await expect(resolveBitwardenOrganizationKeys({ Profile: { Organizations: [] } }, USER_KEY)).resolves.toEqual({ keys: new Map(), warnings: [] });
    const result = await resolveBitwardenOrganizationKeys({ Profile: { Organizations: [{ Id: "org-1", Key: "4.AA==" }] } }, USER_KEY);
    expect(result.keys.size).toBe(0);
    expect(result.warnings[0]).toContain("私钥");
  });
});

async function organizationKeyFixture() {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-1" }, true, ["encrypt", "decrypt"]);
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const rawOrganizationKey = Uint8Array.from({ length: 64 }, (_, index) => index + 64);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, rawOrganizationKey));
  return { privateKeyPkcs8, organizationCipher: `4.${bytesToBase64(encrypted)}` };
}
