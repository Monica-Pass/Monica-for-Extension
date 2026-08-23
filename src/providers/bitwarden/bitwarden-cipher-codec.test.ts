import { describe, expect, it } from "vitest";
import type { CardItem, IdentityItem, LoginItem, PasskeyItem, SecureNoteItem, TotpItem } from "../../core/model";
import { resolveLoginOtp } from "../../core/login-otp";
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
        Uris: [
          { Uri: await enc("https://github.com/login"), Match: 3 },
          { Uri: await enc("^https://github\\.com/session"), Match: 4 }
        ],
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
    expect(decoded.items).toHaveLength(3);
    expect(decoded.items[0]).toMatchObject({
      kind: "login",
      username: "joy@example.com",
      password: "secret",
      totpSecret: "JBSWY3DPEHPK3PXP",
      uris: ["https://github.com/login", "^https://github\\.com/session"],
      uriRules: [
        { uri: "https://github.com/login", matchType: "exact" },
        { uri: "^https://github\\.com/session", matchType: "regex" }
      ],
      customFields: [{ name: "Recovery", value: "code", protected: true }],
      bitwardenCustomFieldsVersion: 1
    });
    expect(decoded.items[1]).toMatchObject({ kind: "totp", secret: "JBSWY3DPEHPK3PXP", issuer: "GitHub", accountName: "joy@example.com" });
    expect(decoded.items[2]).toMatchObject({ kind: "passkey", credentialId: "credential-id", rpId: "github.com", privateKeyPkcs8: "pkcs8-material", signCount: 7, sourceMode: "bitwarden" });
  });

  it("projects an Android standalone validator Login into a first-class TOTP item", async () => {
    const raw = {
      Id: "cipher-standalone-totp",
      Type: 1,
      Name: await encryptBitwardenString("GitHub authenticator", KEY),
      Notes: await encryptBitwardenString("", KEY),
      Favorite: false,
      RevisionDate: REVISION,
      CreationDate: REVISION,
      Login: {
        Username: await encryptBitwardenString("joy@example.com", KEY),
        Password: null,
        Totp: await encryptBitwardenString("otpauth://totp/GitHub:joy?secret=JBSWY3DPEHPK3PXP&issuer=GitHub", KEY),
        Uris: []
      }
    };
    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    expect(decoded.items.map((item) => item.kind)).toEqual(["login", "totp"]);
    expect(decoded.items[1] as TotpItem).toMatchObject({
      title: "GitHub authenticator",
      issuer: "GitHub",
      accountName: "joy",
      secret: "JBSWY3DPEHPK3PXP",
      otpType: "TOTP"
    });
  });

  it("tracks Collection routing only for organization Ciphers", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const base = { Type: 1, Name: await enc("Account"), RevisionDate: REVISION, CreationDate: REVISION, Login: { Uris: [] } };
    const personal = await decodeBitwardenCipher({ ...base, Id: "personal", CollectionIds: [] }, "provider-1", KEY);
    const organization = await decodeBitwardenCipher({ ...base, Id: "shared", OrganizationId: "org-1" }, "provider-1", KEY);
    expect(personal.items[0].providerRefs[0]).not.toHaveProperty("remoteCollectionIds");
    expect(organization.items[0].providerRefs[0]).toMatchObject({ remoteCollectionIds: [] });
  });

  it("projects the Bitwarden folder name into the shared Android category field", async () => {
    const raw = {
      Id: "foldered-login", Type: 1, Name: await encryptBitwardenString("Foldered", KEY),
      FolderId: "folder-1", RevisionDate: REVISION, CreationDate: REVISION,
      Login: { Username: null, Password: null, Uris: [] }
    };
    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY, "工作账号");
    expect(decoded.items[0]).toMatchObject({ categoryName: "工作账号", providerRefs: [{ remoteFolderId: "folder-1" }] });
  });

  it("retains a non-ES256 FIDO2 algorithm for the passkey availability policy to reject", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const decoded = await decodeBitwardenCipher({
      Id: "cipher-rsa-passkey", Type: 1, Name: await enc("Example"), Notes: await enc(""), Favorite: false, RevisionDate: REVISION, CreationDate: REVISION,
      Login: { Fido2Credentials: [{ CredentialId: await enc("credential-id"), KeyAlgorithm: await enc("RSA"), KeyValue: await enc("private-key"), RpId: await enc("example.com"), RpName: await enc("Example"), Counter: await enc("0"), UserHandle: await enc("user"), UserName: await enc("joy"), UserDisplayName: await enc("Joy"), Discoverable: await enc("true"), CreationDate: await enc(REVISION) }] }
    }, "provider-1", KEY);
    expect(decoded.items.find((item) => item.kind === "passkey")).toMatchObject({ kind: "passkey", algorithm: -257, sourceMode: "bitwarden" });
  });

  it("fails closed when FIDO2 KeyAlgorithm is empty or unknown", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const base = {
      Type: 1, Name: await enc("Example"), Notes: await enc(""), Favorite: false, RevisionDate: REVISION, CreationDate: REVISION
    };
    const fields = {
      KeyValue: await enc("private-key"), RpId: await enc("example.com"), RpName: await enc("Example"), Counter: await enc("0"),
      UserHandle: await enc("user"), UserName: await enc("joy"), UserDisplayName: await enc("Joy"), Discoverable: await enc("true"), CreationDate: await enc(REVISION)
    };
    const empty = await decodeBitwardenCipher({
      ...base, Id: "cipher-empty-alg",
      Login: { Fido2Credentials: [{ CredentialId: await enc("empty"), KeyAlgorithm: await enc(""), ...fields }] }
    }, "provider-1", KEY);
    const unknown = await decodeBitwardenCipher({
      ...base, Id: "cipher-unknown-alg",
      Login: { Fido2Credentials: [{ CredentialId: await enc("unknown"), KeyAlgorithm: await enc("FUTURE-ALG"), ...fields }] }
    }, "provider-1", KEY);
    expect(empty.items.find((item) => item.kind === "passkey")).toMatchObject({ algorithm: -257 });
    expect(unknown.items.find((item) => item.kind === "passkey")).toMatchObject({ algorithm: -257 });
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

  it("round-trips Secure Note custom fields without dropping unknown fields", async () => {
    const raw = {
      Id: "secure-note-fields",
      Type: 2,
      Name: await encryptBitwardenString("Recovery note", KEY),
      Notes: await encryptBitwardenString("private body", KEY),
      Favorite: false,
      RevisionDate: REVISION,
      CreationDate: REVISION,
      SecureNote: { Type: 0 },
      Fields: [
        { Type: 1, Name: await encryptBitwardenString("Recovery code", KEY), Value: await encryptBitwardenString("ABCD", KEY) },
        { Type: 2, Name: await encryptBitwardenString("Future boolean", KEY), Value: await encryptBitwardenString("true", KEY), Future: "preserve" }
      ]
    };

    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    const note = decoded.items[0] as SecureNoteItem;
    expect(note).toMatchObject({
      kind: "secure-note",
      customFields: [{ name: "Recovery code", value: "ABCD", protected: true }]
    });

    const encoded = await encodeBitwardenCipher({
      ...note,
      customFields: [{ name: "Recovery code", value: "WXYZ", protected: true }]
    }, KEY, raw);
    const fields = encoded.fields as Array<Record<string, unknown>>;
    expect(fields.some((field) => field.Future === "preserve")).toBe(true);
    const editable = fields.find((field) => !field.Future)!;
    await expect(decryptBitwardenString(String(editable.name), KEY)).resolves.toBe("Recovery code");
    await expect(decryptBitwardenString(String(editable.value), KEY)).resolves.toBe("WXYZ");
    expect(editable.type).toBe(1);
  });

  it("round-trips Monica Android Markdown and note tags through encrypted fields", async () => {
    const raw = {
      Id: "markdown-note", Type: 2, Name: await encryptBitwardenString("指南", KEY),
      Notes: await encryptBitwardenString("# 标题", KEY), Favorite: false, RevisionDate: REVISION, CreationDate: REVISION,
      Fields: [
        { Type: 0, Name: await encryptBitwardenString("monica_note_markdown", KEY), Value: await encryptBitwardenString("true", KEY) },
        { Type: 0, Name: await encryptBitwardenString("monica_note_tags", KEY), Value: await encryptBitwardenString('["工作","重要"]', KEY) },
        { Type: 0, Name: await encryptBitwardenString("Owner", KEY), Value: await encryptBitwardenString("Joy", KEY) }
      ]
    };
    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    const note = decoded.items[0] as SecureNoteItem;
    expect(note).toMatchObject({ isMarkdown: true, tags: ["工作", "重要"], customFields: [{ name: "Owner", value: "Joy" }] });
    const encoded = await encodeBitwardenCipher({ ...note, isMarkdown: false, tags: ["更新"] }, KEY, raw);
    const fields = encoded.fields as Array<Record<string, unknown>>;
    const plain = await Promise.all(fields.map(async (field) => [
      await decryptBitwardenString(String(field.name), KEY), await decryptBitwardenString(String(field.value), KEY)
    ]));
    expect(plain).toEqual(expect.arrayContaining([["monica_note_markdown", "false"], ["monica_note_tags", '["更新"]'], ["Owner", "Joy"]]));
  });

  it("imports Monica Android metadata-only Passkeys without marking them usable", async () => {
    const raw = {
      Id: "android-passkey-reference",
      Type: 1,
      Name: await encryptBitwardenString("GitHub [Passkey]", KEY),
      Notes: await encryptBitwardenString("[Monica Passkey Metadata]\ncredentialId: android-credential\nrpId: github.com\nrpName: GitHub\nuserId: android-user\nuserDisplayName: Joy", KEY),
      Favorite: false,
      RevisionDate: REVISION,
      CreationDate: REVISION,
      Login: { Username: await encryptBitwardenString("joy", KEY), Password: null, Uris: [] }
    };
    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    expect(decoded.items.find((item) => item.kind === "passkey")).toMatchObject({
      credentialId: "android-credential",
      rpId: "github.com",
      sourceMode: "android-metadata-only"
    });
    expect(decoded.items.find((item) => item.kind === "passkey")).not.toHaveProperty("privateKeyPkcs8");
  });

  it("accepts plaintext FIDO2 scalar fields returned by self-hosted servers", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const decoded = await decodeBitwardenCipher({
      Id: "cipher-plaintext-fido",
      Type: 1,
      Name: await enc("Self-hosted passkey"),
      Notes: null,
      Login: {
        Username: null,
        Password: null,
        Fido2Credentials: [{
          CredentialId: "plain-credential",
          KeyAlgorithm: "ECDSA",
          KeyValue: "plain-private-key",
          RpId: "example.com",
          RpName: "Example",
          Counter: 3,
          UserHandle: "plain-user",
          UserName: "joy",
          UserDisplayName: "Joy",
          Discoverable: true,
          CreationDate: REVISION
        }]
      }
    }, "provider-1", KEY);
    expect(decoded.items.find((item) => item.kind === "passkey")).toMatchObject({
      credentialId: "plain-credential",
      algorithm: -7,
      signCount: 3,
      rpId: "example.com"
    });
  });

  it("fills incomplete FIDO2 fields from Monica Android metadata", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const decoded = await decodeBitwardenCipher({
      Id: "partial-fido", Type: 1, Name: await enc("GitHub [Passkey]"),
      Notes: await enc("[Monica Passkey Metadata]\ncredentialId: android-id\nrpId: github.com\nrpName: GitHub\nuserId: android-user\nuserName: joy\nuserDisplayName: Joy\npublicKeyAlgorithm: -7\nsignCount: 12\ncreatedAt: 2026-07-14T00:00:00.000Z"),
      RevisionDate: REVISION, CreationDate: REVISION,
      Login: { Fido2Credentials: [{ KeyValue: null, Discoverable: "true" }] }
    }, "provider-1", KEY);
    expect(decoded.items.find((item) => item.kind === "passkey")).toMatchObject({
      credentialId: "android-id", rpId: "github.com", rpName: "GitHub", userHandle: "android-user", userName: "joy", signCount: 12,
      sourceMode: "android-metadata-only"
    });
  });

  it("writes the local archive timestamp into the Bitwarden Cipher", async () => {
    const archivedAt = "2026-07-15T04:00:00.000Z";
    const item: LoginItem = {
      id: "archived-login",
      kind: "login",
      title: "Archived",
      username: "user",
      password: "pass",
      uris: [],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: archivedAt,
      archivedAt,
      providerRefs: []
    };

    const encoded = await encodeBitwardenCipher(item, KEY);

    expect(encoded.archivedDate).toBe(archivedAt);
  });

  it("clears a preserved Bitwarden archive marker when the local item is unarchived", async () => {
    const raw = {
      Id: "archived-login",
      Type: 1,
      Name: await encryptBitwardenString("Archived", KEY),
      ArchivedDate: "2026-07-15T04:00:00.000Z",
      RevisionDate: REVISION,
      CreationDate: REVISION,
      FutureTopLevel: { keep: true },
      Login: { Username: null, Password: null, Uris: [] }
    };
    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);

    const encoded = await encodeBitwardenCipher({ ...decoded.items[0], archivedAt: undefined }, KEY, raw);

    expect(encoded.archivedDate).toBeNull();
    expect(encoded.futureTopLevel).toEqual({ keep: true });
  });

  it("writes every Bitwarden URI match mode without collapsing it to the default", async () => {
    const item: LoginItem = {
      id: "uri-rules",
      kind: "login",
      title: "URI rules",
      username: "",
      password: "",
      uris: ["example.com", "https://example.com/login", "^https://example\\.com"],
      uriRules: [
        { uri: "example.com", matchType: "domain" },
        { uri: "https://example.com/login", matchType: "starts-with" },
        { uri: "^https://example\\.com", matchType: "regex" }
      ],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: []
    };
    const encoded = await encodeBitwardenCipher(item, KEY);
    const encodedUris = (encoded.login as { uris: Array<{ uri: string; match: number }> }).uris;
    expect(encodedUris.map((entry) => entry.match)).toEqual([1, 2, 4]);
    const decoded = await decodeBitwardenCipher({ ...encoded, id: "uri-rules", revisionDate: REVISION, creationDate: REVISION }, "provider-1", KEY);
    expect(decoded.items[0]).toMatchObject({ uriRules: item.uriRules });
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

  it("decodes and edits a native Type 5 SSH Cipher without dropping unknown fields", async () => {
    const raw = {
      Id: "native-ssh",
      Type: 5,
      Name: await encryptBitwardenString("Production SSH", KEY),
      Notes: await encryptBitwardenString("managed by Bitwarden", KEY),
      Favorite: true,
      RevisionDate: REVISION,
      CreationDate: REVISION,
      SshKey: {
        PrivateKey: await encryptBitwardenString("-----BEGIN OPENSSH PRIVATE KEY-----\nnative\n-----END OPENSSH PRIVATE KEY-----", KEY),
        PublicKey: await encryptBitwardenString("ssh-ed25519 AAAAC3Nza native@example", KEY),
        KeyFingerprint: await encryptBitwardenString("SHA256:native", KEY),
        FutureSshField: { version: 2 }
      },
      Fields: [
        { Type: 0, Name: await encryptBitwardenString("Owner", KEY), Value: await encryptBitwardenString("Joy", KEY) },
        { Type: 2, Name: await encryptBitwardenString("Future boolean", KEY), Value: await encryptBitwardenString("true", KEY), Future: "preserve" }
      ],
      FutureTopLevel: ["keep"]
    };

    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    const item = decoded.items[0] as LoginItem;
    expect(decoded.warning).toBeUndefined();
    expect(item).toMatchObject({
      kind: "login",
      loginType: "SSH_KEY",
      bitwardenSshKeyMode: "native",
      username: "",
      password: "",
      customFields: [{ name: "Owner", value: "Joy", protected: false }]
    });
    expect(JSON.parse(item.sshKeyData || "{}")).toMatchObject({
      algorithm: "ED25519",
      keySize: 0,
      publicKeyOpenSsh: "ssh-ed25519 AAAAC3Nza native@example",
      fingerprintSha256: "SHA256:native",
      format: "OPENSSH"
    });

    const editedSsh = {
      ...JSON.parse(item.sshKeyData || "{}"),
      privateKeyOpenSsh: "-----BEGIN OPENSSH PRIVATE KEY-----\nupdated\n-----END OPENSSH PRIVATE KEY-----",
      publicKeyOpenSsh: "ssh-ed25519 AAAAC3Nza updated@example",
      fingerprintSha256: "SHA256:updated"
    };
    const encoded = await encodeBitwardenCipher({ ...item, sshKeyData: JSON.stringify(editedSsh) }, KEY, raw);
    const encodedSsh = encoded.sshKey as Record<string, unknown>;

    expect(encoded.type).toBe(5);
    expect(encoded.login).toBeUndefined();
    expect(encoded.futureTopLevel).toEqual(["keep"]);
    expect(encodedSsh.futureSshField).toEqual({ version: 2 });
    await expect(decryptBitwardenString(String(encodedSsh.privateKey), KEY)).resolves.toContain("updated");
    await expect(decryptBitwardenString(String(encodedSsh.publicKey), KEY)).resolves.toBe("ssh-ed25519 AAAAC3Nza updated@example");
    await expect(decryptBitwardenString(String(encodedSsh.keyFingerprint), KEY)).resolves.toBe("SHA256:updated");
    expect((encoded.fields as Array<Record<string, unknown>>).some((field) => field.Future === "preserve")).toBe(true);
  });

  it("round-trips the Monica Android Type 1 SSH fallback with protected private-key fields", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const future = { Type: 99, Name: await enc("Future SSH"), Value: await enc("opaque"), Future: { keep: true } };
    const raw = {
      Id: "fallback-ssh",
      Type: 1,
      Name: await enc("Fallback SSH"),
      RevisionDate: REVISION,
      CreationDate: REVISION,
      Login: { Username: null, Password: null, Uris: [], Fido2Credentials: [] },
      Fields: [
        { Type: 0, Name: await enc("monica_login_type"), Value: await enc("SSH_KEY") },
        { Type: 0, Name: await enc("monica_ssh_algorithm"), Value: await enc("RSA") },
        { Type: 0, Name: await enc("monica_ssh_key_size"), Value: await enc("4096") },
        { Type: 0, Name: await enc("monica_ssh_public_key"), Value: await enc("ssh-rsa AAAA old") },
        { Type: 1, Name: await enc("monica_ssh_private_key"), Value: await enc("private-old") },
        { Type: 0, Name: await enc("monica_ssh_fingerprint"), Value: await enc("SHA256:old") },
        future
      ]
    };

    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    const item = decoded.items[0] as LoginItem;
    expect(item.bitwardenSshKeyMode).toBe("fallback");
    expect(JSON.parse(item.sshKeyData || "{}")).toMatchObject({ algorithm: "RSA", keySize: 4096, fingerprintSha256: "SHA256:old" });

    const encoded = await encodeBitwardenCipher({
      ...item,
      sshKeyData: JSON.stringify({
        ...JSON.parse(item.sshKeyData || "{}"),
        publicKeyOpenSsh: "ssh-rsa AAAA updated",
        privateKeyOpenSsh: "private-updated",
        fingerprintSha256: "SHA256:updated"
      })
    }, KEY, raw);
    const fields = encoded.fields as Array<Record<string, unknown>>;
    const plain = await Promise.all(fields.map(async (field) => ({
      name: await decryptBitwardenString(String(field.name || field.Name || ""), KEY).catch(() => ""),
      value: await decryptBitwardenString(String(field.value || field.Value || ""), KEY).catch(() => ""),
      type: Number(field.type ?? field.Type)
    })));

    expect(encoded.type).toBe(1);
    expect(encoded.sshKey).toBeUndefined();
    expect(plain).toEqual(expect.arrayContaining([
      { name: "monica_ssh_public_key", value: "ssh-rsa AAAA updated", type: 0 },
      { name: "monica_ssh_private_key", value: "private-updated", type: 1 },
      { name: "monica_ssh_fingerprint", value: "SHA256:updated", type: 0 }
    ]));
    expect(fields).toContain(future);
  });

  it("preserves reprompt, attachments, history, and unknown Cipher keys when only the title changes", async () => {
    const attachments = [{ Id: "attachment-1", FileName: await encryptBitwardenString("report.pdf", KEY), Size: "2048", Key: "attachment-key" }];
    const passwordHistory = [{ Password: await encryptBitwardenString("old-secret", KEY), LastUsedDate: "2026-07-01T00:00:00.000Z" }];
    const raw = {
      Id: "cipher-preserve",
      Type: 1,
      Name: await encryptBitwardenString("Original", KEY),
      Reprompt: 2,
      Attachments: attachments,
      PasswordHistory: passwordHistory,
      SshKey: { PrivateKey: "encrypted-private", PublicKey: "encrypted-public", KeyFingerprint: "SHA256:abc" },
      ArchivedDate: "2026-07-10T00:00:00.000Z",
      DeletedDate: null,
      FutureField: { nested: [1, 2, 3], flag: false },
      RevisionDate: REVISION,
      CreationDate: REVISION,
      Login: { Username: await encryptBitwardenString("user", KEY), Password: await encryptBitwardenString("pass", KEY), Uris: [] }
    };

    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    const encoded = await encodeBitwardenCipher({ ...(decoded.items[0] as LoginItem), title: "Renamed" }, KEY, raw);

    await expect(decryptBitwardenString(encoded.name as string, KEY)).resolves.toBe("Renamed");
    expect(encoded.reprompt).toBe(2);
    expect(encoded.attachments).toEqual(attachments);
    expect(encoded.passwordHistory).toEqual(passwordHistory);
    expect(encoded.sshKey).toEqual(raw.SshKey);
    expect(encoded.archivedDate).toBe("2026-07-10T00:00:00.000Z");
    expect(encoded.deletedDate).toBeNull();
    expect(encoded.futureField).toEqual({ nested: [1, 2, 3], flag: false });
  });

  it("preserves unmatched exact remote occurrences before the adapter is initialized", async () => {
    const remoteFields = [
      { Type: 0, Name: await encryptBitwardenString("Shared", KEY), Value: await encryptBitwardenString("remote-value", KEY) },
      { Type: 1, Name: await encryptBitwardenString("ServerOnly", KEY), Value: await encryptBitwardenString("hidden", KEY) },
      { Type: 4, Name: await encryptBitwardenString("Linked", KEY), Value: null, LinkedId: 100 }
    ];
    const item: LoginItem = {
      id: "fields", kind: "login", title: "Fields", username: "user", password: "pass", uris: [],
      customFields: [{ name: "Shared", value: "local-value", protected: false }, { name: "LocalOnly", value: "local", protected: true }],
      favorite: false, notes: "", createdAt: REVISION, updatedAt: REVISION, providerRefs: []
    };

    const encoded = await encodeBitwardenCipher(item, KEY, { Fields: remoteFields });
    const fields = encoded.fields as Array<Record<string, unknown>>;
    expect(fields).toHaveLength(5);
    expect(fields.slice(0, 3)).toEqual(remoteFields);
    const names = await Promise.all(fields.slice(3).map((field) => decryptBitwardenString(field.name as string, KEY)));
    expect(names).toEqual(["Shared", "LocalOnly"]);
    await expect(decryptBitwardenString(fields[3].value as string, KEY)).resolves.toBe("local-value");
  });

  it("maps Android password system fields without exposing reserved or unsupported fields as user fields", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const raw = {
      Id: "android-system-fields",
      Type: 1,
      Name: await enc("Android fields"),
      RevisionDate: REVISION,
      CreationDate: REVISION,
      Login: { Username: null, Password: null, Uris: [] },
      Fields: [
        { Type: 0, Name: await enc("monica_app_package"), Value: await enc("com.example.app") },
        { Type: 0, Name: await enc("monica_email"), Value: await enc("joy@example.com") },
        { Type: 0, Name: await enc("monica_passkey_bindings"), Value: await enc('[{"credentialId":"bound"}]') },
        { Type: 0, Name: await enc("monica_login_type"), Value: await enc("SSH_KEY") },
        { Type: 0, Name: await enc("Visible"), Value: await enc("text") },
        { Type: 1, Name: await enc("Secret"), Value: await enc("hidden") },
        { Type: 2, Name: await enc("Boolean"), Value: await enc("true") },
        { Type: 0, Name: await enc("Linked"), Value: await enc("linked"), LinkedId: 100 },
        { Type: 0, Name: null, Value: await enc("unnamed") },
        { Type: 99, Name: await enc("Future"), Value: await enc("future") }
      ]
    };

    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);

    expect(decoded.items[0]).toMatchObject({
      kind: "login",
      appPackageName: "com.example.app",
      email: "joy@example.com",
      passkeyBindings: '[{"credentialId":"bound"}]',
      loginType: "SSH_KEY",
      bitwardenCustomFieldsVersion: 1,
      customFields: [
        { name: "Visible", value: "text", protected: false },
        { name: "Secret", value: "hidden", protected: true }
      ]
    });
  });

  it("replaces generated Android system fields while retaining unrelated raw field types", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const oldPackage = { Type: 0, Name: await enc("monica_app_package"), Value: await enc("com.old.app") };
    const oldEmail = { Type: 0, Name: await enc("monica_email"), Value: await enc("old@example.com") };
    const boolean = { Type: 2, Name: await enc("Boolean"), Value: await enc("true"), Future: "keep" };
    const item: LoginItem = {
      id: "system-write",
      kind: "login",
      title: "System write",
      username: "",
      password: "",
      uris: [],
      customFields: [],
      bitwardenCustomFieldsVersion: 1,
      appPackageName: "com.new.app",
      email: "new@example.com",
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: []
    };

    const encoded = await encodeBitwardenCipher(item, KEY, { Fields: [oldPackage, oldEmail, boolean] });
    const fields = encoded.fields as Array<Record<string, unknown>>;

    expect(fields[0]).toEqual(boolean);
    const generated = fields.slice(1);
    const names = await Promise.all(generated.map((field) => decryptBitwardenString(field.name as string, KEY)));
    const values = await Promise.all(generated.map((field) => decryptBitwardenString(field.value as string, KEY)));
    expect(names).toEqual(["monica_app_package", "appPackageName", "monica_email", "email"]);
    expect(values).toEqual(["com.new.app", "com.new.app", "new@example.com", "new@example.com"]);
  });

  it("lets an initialized local list delete and rename exact field occurrences while preserving unsupported raw entries", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const remoteFields = [
      { Type: 0, Name: await enc("Duplicate"), Value: await enc("same") },
      { Type: 0, Name: await enc("Duplicate"), Value: await enc("same") },
      { Type: 1, Name: await enc("DeleteMe"), Value: await enc("old") },
      { Type: 2, Name: await enc("Collision"), Value: await enc("true"), FutureBooleanMetadata: "keep" },
      { Type: 0, Name: await enc("Linked"), Value: await enc("linked"), LinkedId: 42 },
      { Type: 0, Name: null, Value: await enc("unnamed"), Unknown: { nested: true } },
      { Type: 99, Name: await enc("Future"), Value: await enc("future"), Future: [1, 2, 3] }
    ];
    const item: LoginItem = {
      id: "initialized-fields",
      kind: "login",
      title: "Fields",
      username: "user",
      password: "pass",
      uris: [],
      customFields: [
        { name: "Duplicate", value: "same", protected: false },
        { name: "Collision", value: "local text", protected: false },
        { name: "Renamed", value: "old", protected: true }
      ],
      bitwardenCustomFieldsVersion: 1,
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: []
    };

    const encoded = await encodeBitwardenCipher(item, KEY, { Fields: remoteFields });
    const fields = encoded.fields as Array<Record<string, unknown>>;

    expect(fields.slice(0, 4)).toEqual(remoteFields.slice(3));
    const localFields = fields.slice(4);
    const names = await Promise.all(localFields.map((field) => decryptBitwardenString(field.name as string, KEY)));
    const values = await Promise.all(localFields.map((field) => decryptBitwardenString(field.value as string, KEY)));
    expect(names).toEqual(["Duplicate", "Collision", "Renamed"]);
    expect(values).toEqual(["same", "local text", "old"]);
    expect(localFields.map((field) => field.type)).toEqual([0, 0, 1]);
  });

  it("keeps an Android Steam Guard steam:// Totp payload usable and byte-identical on write-back", async () => {
    const sharedSecret = "QUJDREVGR0hJSktMTU5PUFFSU1Q=";
    const raw = {
      Id: "cipher-steam",
      Type: 1,
      Name: await encryptBitwardenString("Steam", KEY),
      RevisionDate: REVISION,
      CreationDate: REVISION,
      Login: { Username: await encryptBitwardenString("joy", KEY), Password: null, Totp: await encryptBitwardenString(`steam://${sharedSecret}`, KEY), Uris: [] }
    };

    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    const login = decoded.items[0] as LoginItem;
    expect(login.totpSecret).toBe(`steam://${sharedSecret}`);
    const code = await resolveLoginOtp(login, [login], 1_700_000_000_000);
    expect(code?.code).toHaveLength(5);

    const encoded = await encodeBitwardenCipher({ ...login, title: "Steam Renamed" }, KEY, raw);
    await expect(decryptBitwardenString((encoded.login as Record<string, string>).totp, KEY)).resolves.toBe(`steam://${sharedSecret}`);
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

  it("preserves unknown Bitwarden Passkey algorithms as unusable metadata", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    const raw = {
      Id: "future-passkey", Type: 1, Name: await enc("Future"), RevisionDate: REVISION, CreationDate: REVISION,
      Login: { Username: null, Password: null, Uris: [], Fido2Credentials: [{
        CredentialId: await enc("future-id"), KeyAlgorithm: await enc("FUTURE-999"), KeyValue: await enc("future-key"),
        RpId: await enc("example.com"), RpName: await enc("Example"), Counter: await enc("0"), UserHandle: await enc("user"),
        UserName: await enc("joy"), UserDisplayName: await enc("Joy"), Discoverable: await enc("true"), CreationDate: await enc(REVISION)
      }] }
    };
    const decoded = await decodeBitwardenCipher(raw, "provider-1", KEY);
    expect(decoded.items.find((item) => item.kind === "passkey")).toMatchObject({ algorithm: -257, keyAlgorithm: "FUTURE-999" });
    await expect(encodeBitwardenPasskeyCipher(decoded.items.find((item): item is PasskeyItem => item.kind === "passkey")!, KEY, raw)).rejects.toThrow("ES256");
  });

  it("preserves parent attachments history and future fields when updating a Passkey", async () => {
    const initial = await encodeBitwardenPasskeyCipher(passkey("preserved-parent", 1), KEY);
    const raw: Record<string, unknown> = {
      ...initial,
      Attachments: [{ Id: "attachment-1", FileName: "2.encrypted", Size: "64", FutureAttachment: true }],
      PasswordHistory: [{ Password: "2.history", LastUsedDate: REVISION }],
      FutureParentField: { nested: [1, 2, 3] },
      Login: { ...(initial.login as Record<string, unknown>), FutureLoginField: "keep" }
    };
    delete raw.login;

    const updated = await encodeBitwardenPasskeyCipher(passkey("preserved-parent", 9), KEY, raw);

    expect(updated.attachments).toEqual(raw.Attachments);
    expect(updated.passwordHistory).toEqual(raw.PasswordHistory);
    expect(updated.futureParentField).toEqual(raw.FutureParentField);
    expect((updated.login as Record<string, unknown>).futureLoginField).toBe("keep");
    const decoded = await decodeBitwardenCipher({ ...updated, id: "cipher", revisionDate: REVISION, creationDate: REVISION }, "provider-1", KEY);
    expect(decoded.items.find((item): item is PasskeyItem => item.kind === "passkey")).toMatchObject({ signCount: 9 });
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
