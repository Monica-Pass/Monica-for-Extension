import { describe, expect, it } from "vitest";
import type { CardItem, IdentityItem, LoginItem, PasskeyItem, SecureNoteItem } from "../../core/model";
import { decodeBitwardenCipher, encodeBitwardenCipher, encodeBitwardenPasskeyCipher } from "./bitwarden-cipher-codec";
import { decryptBitwardenString, encryptBitwardenBytes, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";

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

  it("round-trips supported personal and organization Cipher types", async () => {
    const base = { favorite: false, notes: "notes", createdAt: REVISION, updatedAt: REVISION, providerRefs: [{ providerId: "provider-1" }] };
    const items: Array<LoginItem | CardItem | IdentityItem | SecureNoteItem> = [
      { ...base, id: "login", kind: "login", title: "Login", username: "user", password: "pass", uris: ["https://example.com"], totpSecret: "OTP", customFields: [] },
      { ...base, id: "card", kind: "card", title: "Visa", cardholderName: "Joy", number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", securityCode: "123", brand: "Visa" },
      { ...base, id: "identity", kind: "identity", title: "Passport", documentType: "PASSPORT", documentNumber: "P123", firstName: "Joy", middleName: "", lastName: "Test", fullName: "Joy Test", email: "joy@example.com", phone: "123", address: { city: "Shanghai" } },
      { ...base, id: "note", kind: "secure-note", title: "Note", content: "private note" }
    ];
    for (const [index, item] of items.entries()) {
      const encoded = await encodeBitwardenCipher(item, KEY);
      const decoded = await decodeBitwardenCipher({ ...encoded, id: `cipher-${index}`, organizationId: "org-1", revisionDate: REVISION, creationDate: REVISION }, "provider-1", KEY);
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

  it("decodes organization Ciphers with item keys and preserves shared ownership metadata", async () => {
    const itemKey: BitwardenSymmetricKey = {
      encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 64),
      macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 96)
    };
    const rawItemKey = new Uint8Array(64);
    rawItemKey.set(itemKey.encKey);
    rawItemKey.set(itemKey.macKey, 32);
    const raw = {
      Id: "shared-cipher",
      OrganizationId: "org-1",
      CollectionIds: ["collection-1"],
      Key: await encryptBitwardenBytes(rawItemKey, KEY),
      Type: 1,
      Name: await encryptBitwardenString("Shared Login", itemKey),
      RevisionDate: REVISION,
      CreationDate: REVISION,
      Login: {
        Username: await encryptBitwardenString("shared-user", itemKey),
        Password: await encryptBitwardenString("shared-secret", itemKey),
        Uris: []
      }
    };

    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    expect(decoded.warning).toBeUndefined();
    expect(decoded.items[0]).toMatchObject({ kind: "login", title: "Shared Login", username: "shared-user", password: "shared-secret" });
    const encoded = await encodeBitwardenCipher({ ...(decoded.items[0] as LoginItem), password: "updated" }, itemKey, raw);
    expect(encoded).toMatchObject({ organizationId: "org-1", collectionIds: ["collection-1"] });
    await expect(decryptBitwardenString((encoded.login as Record<string, string>).password, itemKey)).resolves.toBe("updated");
  });

  it("creates a login Cipher containing a Bitwarden-compatible FIDO2 credential", async () => {
    const encoded = await encodeBitwardenPasskeyCipher(passkey("new-credential", 0), KEY);
    const decoded = await decodeBitwardenCipher({ ...encoded, id: "created", revisionDate: REVISION, creationDate: REVISION }, "provider-1", KEY);

    expect(decoded.items).toHaveLength(2);
    expect(decoded.items[0]).toMatchObject({ kind: "login", title: "Example Passkey", username: "joy@example.com", uris: ["https://example.com"] });
    expect(decoded.items[1]).toMatchObject({
      kind: "passkey",
      credentialId: "new-credential",
      privateKeyPkcs8: "pkcs8-material-new-credential",
      signCount: 0,
      sourceMode: "bitwarden"
    });
  });

  it("updates one FIDO2 credential and retains its sibling", async () => {
    const original = await encodeBitwardenPasskeyCipher(passkey("first", 1), KEY);
    const withSibling = await encodeBitwardenPasskeyCipher(passkey("sibling", 4), KEY, original);
    const updated = await encodeBitwardenPasskeyCipher(passkey("first", 9), KEY, withSibling);
    const decoded = await decodeBitwardenCipher({ ...updated, id: "cipher", revisionDate: REVISION, creationDate: REVISION }, "provider-1", KEY);
    const passkeys = decoded.items.filter((item): item is PasskeyItem => item.kind === "passkey");

    expect(passkeys.map((item) => [item.credentialId, item.signCount])).toEqual([["first", 9], ["sibling", 4]]);
  });

  it("deletes one FIDO2 credential without deleting the parent login or siblings", async () => {
    const original = await encodeBitwardenPasskeyCipher(passkey("first", 1), KEY);
    const withSibling = await encodeBitwardenPasskeyCipher(passkey("sibling", 4), KEY, original);
    const updated = await encodeBitwardenPasskeyCipher(passkey("first", 1), KEY, withSibling, "delete");
    const decoded = await decodeBitwardenCipher({ ...updated, id: "cipher", revisionDate: REVISION, creationDate: REVISION }, "provider-1", KEY);

    expect(decoded.items).toHaveLength(2);
    expect(decoded.items[0]).toMatchObject({ kind: "login", title: "Example Passkey" });
    expect(decoded.items[1]).toMatchObject({ kind: "passkey", credentialId: "sibling", signCount: 4 });
  });
});

function passkey(credentialId: string, signCount: number): PasskeyItem {
  return {
    id: `passkey-${credentialId}`,
    kind: "passkey",
    title: "Example Passkey",
    favorite: false,
    notes: "",
    createdAt: REVISION,
    updatedAt: REVISION,
    providerRefs: [{ providerId: "provider-1" }],
    credentialId,
    rpId: "example.com",
    rpName: "Example",
    userHandle: "dXNlci1oYW5kbGU",
    userName: "joy@example.com",
    userDisplayName: "Joy",
    algorithm: -7,
    publicKey: "spki-material",
    privateKeyPkcs8: `pkcs8-material-${credentialId}`,
    signCount,
    discoverable: true,
    sourceMode: "bitwarden"
  };
}
