import { describe, expect, it } from "vitest";
import type { CardItem, IdentityItem, LoginItem, SecureNoteItem } from "../../core/model";
import { decodeBitwardenCipher, encodeBitwardenCipher } from "./bitwarden-cipher-codec";
import { decryptBitwardenString, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";

const KEY: BitwardenSymmetricKey = {
  encKey: Uint8Array.from({ length: 32 }, (_, index) => index),
  macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 32)
};
const REVISION = "2026-07-15T03:00:00.000Z";

describe("Bitwarden Cipher codec", () => {
  it("maps login, TOTP, custom fields, and FIDO2 credentials", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const raw = {
      Id: "cipher-login",
      Type: 1,
      Name: await enc("GitHub"),
      Notes: await enc("work"),
      Favorite: true,
      RevisionDate: REVISION,
      CreationDate: "2026-07-14T00:00:00.000Z",
      Login: {
        Username: await enc("joy@example.com"),
        Password: await enc("secret"),
        Totp: await enc("JBSWY3DPEHPK3PXP"),
        Uris: [{ Uri: await enc("https://github.com/login") }],
        Fido2Credentials: [{
          CredentialId: await enc("credential-id"),
          KeyAlgorithm: await enc("ECDSA"),
          KeyValue: await enc("pkcs8-material"),
          RpId: await enc("github.com"),
          RpName: await enc("GitHub"),
          Counter: await enc("7"),
          UserHandle: await enc("user-handle"),
          UserName: await enc("joy"),
          UserDisplayName: await enc("Joy"),
          Discoverable: await enc("true"),
          CreationDate: await enc("2026-07-14T01:00:00.000Z")
        }]
      },
      Fields: [{ Type: 1, Name: await enc("Recovery"), Value: await enc("code") }]
    };

    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    expect(decoded.items).toHaveLength(2);
    expect(decoded.items[0]).toMatchObject({ kind: "login", username: "joy@example.com", password: "secret", totpSecret: "JBSWY3DPEHPK3PXP", uris: ["https://github.com/login"], customFields: [{ name: "Recovery", value: "code", protected: true }] });
    expect(decoded.items[1]).toMatchObject({ kind: "passkey", credentialId: "credential-id", rpId: "github.com", privateKeyPkcs8: "pkcs8-material", signCount: 7, sourceMode: "bitwarden" });
  });

  it("round-trips supported personal Cipher types", async () => {
    const base = { favorite: false, notes: "notes", createdAt: REVISION, updatedAt: REVISION, providerRefs: [{ providerId: "provider-1" }] };
    const items: Array<LoginItem | CardItem | IdentityItem | SecureNoteItem> = [
      { ...base, id: "login", kind: "login", title: "Login", username: "user", password: "pass", uris: ["https://example.com"], totpSecret: "OTP", customFields: [] },
      { ...base, id: "card", kind: "card", title: "Visa", cardholderName: "Joy", number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", securityCode: "123", brand: "Visa" },
      { ...base, id: "identity", kind: "identity", title: "Passport", documentType: "PASSPORT", documentNumber: "P123", firstName: "Joy", middleName: "", lastName: "Test", fullName: "Joy Test", email: "joy@example.com", phone: "123", address: { city: "Shanghai" } },
      { ...base, id: "note", kind: "secure-note", title: "Note", content: "private note" }
    ];
    for (const [index, item] of items.entries()) {
      const encoded = await encodeBitwardenCipher(item, KEY);
      const decoded = await decodeBitwardenCipher({ ...encoded, id: `cipher-${index}`, revisionDate: REVISION, creationDate: REVISION }, "provider-1", KEY);
      expect(decoded.items[0]).toMatchObject({ kind: item.kind, title: item.title });
    }
  });

  it("keeps encrypted FIDO2 credentials when editing the parent login", async () => {
    const preservedFido = [{ CredentialId: await encryptBitwardenString("credential", KEY) }];
    const item: LoginItem = {
      id: "login",
      kind: "login",
      title: "Edited",
      username: "user",
      password: "pass",
      uris: ["example.com"],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: []
    };
    const encoded = await encodeBitwardenCipher(item, KEY, { Key: null, Login: { Fido2Credentials: preservedFido } });
    expect((encoded.login as Record<string, unknown>).fido2Credentials).toEqual(preservedFido);
    await expect(decryptBitwardenString((encoded.login as Record<string, string>).username, KEY)).resolves.toBe("user");
  });
});
