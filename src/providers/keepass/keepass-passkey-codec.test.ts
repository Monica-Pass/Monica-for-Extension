import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import {
  KEEPASS_PASSKEY_FIELDS,
  buildKeePassPasskeyFields,
  buildKeePassPasskeyPatch,
  isKeePassPasskeyEntry,
  keePassPasskeyToVaultItem,
  readKeePassPasskeyFields,
  stripPasskeySuffix
} from "./keepass-passkey-codec";
import { applyKeePassFieldPatch } from "./keepass-field-patch";
import { KEEPASSDX_PASSKEY_FIELDS } from "./keepass-field-registry";
import { keePassFieldText, type KeePassEntryFieldValue } from "./keepass-login-codec";
import type { PasskeyItem } from "../../core/model";
import type { MonicaItemBase } from "../monica-item-data";

/**
 * Assertion semantics translated from Android `KeePassPasskeySyncCodec.kt`, `KeePassDxPasskeyCodec.kt`
 * and `PasskeyPrivateKeySupport.kt` (SHA 9930d8d8).
 */

/** A real P-256 PKCS#8 key, so the OID sniffing is exercised against genuine DER rather than a stub. */
const P256_PKCS8 =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsloK6aKNvj0CZMYdBdSZs+AUAsFy1t66q4tq5SvyeJahRANCAASlCTbHlIcaKQ2lzoEFhtjkLEO++f3cYq6FMYG7eH3BmuLQPz71FAtWq4z+tIb7oequwhUJL3xos1nA8jFqpkDs";
/** Only the `PrivateKeyInfo` prefix is needed: the algorithm OID is all `coseAlgorithmOfPkcs8` reads. */
const RSA_PKCS8_HEADER = "MBICAQAwDQYJKoZIhvcNAQEBBQA=";
const ED25519_PKCS8 = "MC4CAQAwBQYDK2VwBCIEIJnQd7TZ/Nw+CYe+uaJUoXpe4i7M98vZBzfdPUtkHyij";

function fields(entries: Record<string, string | kdbxweb.ProtectedValue>): Map<string, KeePassEntryFieldValue> {
  return new Map(Object.entries(entries));
}

function secret(value: string): kdbxweb.ProtectedValue {
  return kdbxweb.ProtectedValue.fromString(value);
}

function pem(pkcs8Base64: string): string {
  const body = (pkcs8Base64.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

function base(overrides: Partial<MonicaItemBase> = {}): MonicaItemBase {
  return {
    id: "item-1",
    title: "placeholder",
    favorite: false,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    providerRefs: [],
    ...overrides
  } as MonicaItemBase;
}

function passkey(overrides: Partial<PasskeyItem> = {}): PasskeyItem {
  return {
    ...base(),
    kind: "passkey",
    title: "GitHub",
    credentialId: "Y3JlZC1vbmU",
    rpId: "github.com",
    rpName: "GitHub",
    userHandle: "dXNlci1oYW5kbGU",
    userName: "alice",
    userDisplayName: "Alice Liu",
    algorithm: -7,
    publicKey: "cHVibGlj",
    privateKeyPkcs8: P256_PKCS8,
    signCount: 3,
    discoverable: true,
    userVerificationRequired: true,
    transports: ["internal", "hybrid"],
    sourceMode: "browser-local",
    ...overrides
  } as PasskeyItem;
}

/** The five KeePassDX fields that `KeePassDxPasskeyCodec.decode` requires all of. */
function keePassDxEntry(overrides: Record<string, string | kdbxweb.ProtectedValue> = {}) {
  return fields({
    Title: "GitHub [Passkey]",
    [KEEPASSDX_PASSKEY_FIELDS.username]: "alice",
    [KEEPASSDX_PASSKEY_FIELDS.privateKey]: secret(pem(P256_PKCS8)),
    [KEEPASSDX_PASSKEY_FIELDS.credentialId]: secret("Y3JlZC1vbmU"),
    [KEEPASSDX_PASSKEY_FIELDS.userHandle]: secret("dXNlci1oYW5kbGU"),
    [KEEPASSDX_PASSKEY_FIELDS.relyingParty]: "github.com",
    ...overrides
  });
}

describe("isKeePassPasskeyEntry", () => {
  it("claims an entry carrying either Monica passkey field", () => {
    expect(isKeePassPasskeyEntry(fields({ [KEEPASS_PASSKEY_FIELDS.credentialId]: "abc" }))).toBe(true);
    expect(isKeePassPasskeyEntry(fields({ [KEEPASS_PASSKEY_FIELDS.data]: secret("{}") }))).toBe(true);
  });

  it("claims a KeePassDX entry on any one of the five fields, not all five", () => {
    expect(isKeePassPasskeyEntry(fields({ [KEEPASSDX_PASSKEY_FIELDS.relyingParty]: "github.com" }))).toBe(true);
    expect(isKeePassPasskeyEntry(fields({ [KEEPASSDX_PASSKEY_FIELDS.userHandle]: secret("x") }))).toBe(true);
  });

  it("does not claim the bare KPEX_PASSKEY marker field, which carries no credential", () => {
    expect(isKeePassPasskeyEntry(fields({ Title: "GitHub", [KEEPASSDX_PASSKEY_FIELDS.passkey]: "" }))).toBe(false);
  });

  it("leaves an ordinary login alone", () => {
    expect(isKeePassPasskeyEntry(fields({ Title: "GitHub", UserName: "alice", Password: secret("hunter2") }))).toBe(false);
  });
});

describe("readKeePassPasskeyFields", () => {
  it("decodes the Monica payload with Kotlin property names", () => {
    const projection = readKeePassPasskeyFields(
      fields({
        Notes: "备注",
        [KEEPASS_PASSKEY_FIELDS.data]: secret(
          JSON.stringify({
            credentialId: "Y3JlZC1vbmU",
            rpId: "github.com",
            rpName: "GitHub",
            userId: "dXNlci1oYW5kbGU",
            userName: "alice",
            userDisplayName: "Alice Liu",
            publicKeyAlgorithm: -7,
            publicKey: "cHVibGlj",
            privateKeyAlias: P256_PKCS8,
            signCount: 5,
            transports: "internal,hybrid",
            aaguid: "aa-guid",
            useCount: 2,
            createdAt: 1767225600000,
            lastUsedAt: 1767312000000
          })
        )
      })
    );

    expect(projection).toMatchObject({
      credentialId: "Y3JlZC1vbmU",
      rpId: "github.com",
      rpName: "GitHub",
      userHandle: "dXNlci1oYW5kbGU",
      userName: "alice",
      userDisplayName: "Alice Liu",
      algorithm: -7,
      publicKey: "cHVibGlj",
      signCount: 5,
      transports: ["internal", "hybrid"],
      aaguid: "aa-guid",
      useCount: 2,
      notes: "备注",
      sourceMode: "browser-local"
    });
    expect(projection!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(projection!.lastUsedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("prefers the Monica payload over the KeePassDX fields on the same entry", () => {
    const projection = readKeePassPasskeyFields(
      keePassDxEntry({
        [KEEPASS_PASSKEY_FIELDS.data]: secret(
          JSON.stringify({ credentialId: "bW9uaWNh", rpId: "monica.example", userName: "monica-user" })
        )
      })
    );

    expect(projection).toMatchObject({ credentialId: "bW9uaWNh", rpId: "monica.example", userName: "monica-user" });
  });

  it("lets MonicaPasskeyCredentialId override the id inside the payload", () => {
    const projection = readKeePassPasskeyFields(
      fields({
        [KEEPASS_PASSKEY_FIELDS.credentialId]: "b3ZlcnJpZGU",
        [KEEPASS_PASSKEY_FIELDS.data]: secret(JSON.stringify({ credentialId: "aW5zaWRl", rpId: "github.com" }))
      })
    );

    expect(projection!.credentialId).toBe("b3ZlcnJpZGU");
  });

  it("falls back to the KeePassDX fields when the Monica payload is unparseable", () => {
    const projection = readKeePassPasskeyFields(keePassDxEntry({ [KEEPASS_PASSKEY_FIELDS.data]: secret("not json") }));

    expect(projection).toMatchObject({ rpId: "github.com", userName: "alice" });
  });

  it("degrades sourceMode when the payload carries no private key, since it cannot be asserted here", () => {
    const projection = readKeePassPasskeyFields(
      fields({ [KEEPASS_PASSKEY_FIELDS.data]: secret(JSON.stringify({ credentialId: "Y3JlZA", rpId: "github.com" })) })
    );

    expect(projection!.privateKeyPkcs8).toBeUndefined();
    expect(projection!.sourceMode).toBe("android-metadata-only");
  });

  it("defaults the flags Android defaults, so an absent field never reads as disabled", () => {
    const projection = readKeePassPasskeyFields(
      fields({ [KEEPASS_PASSKEY_FIELDS.data]: secret(JSON.stringify({ credentialId: "Y3JlZA" })) })
    );

    expect(projection).toMatchObject({
      algorithm: -7,
      signCount: 0,
      discoverable: true,
      userVerificationRequired: true,
      transports: ["internal"]
    });
  });

  it("honours an explicitly false discoverable or userVerificationRequired", () => {
    const projection = readKeePassPasskeyFields(
      fields({
        [KEEPASS_PASSKEY_FIELDS.data]: secret(
          JSON.stringify({ credentialId: "Y3JlZA", isDiscoverable: false, isUserVerificationRequired: false })
        )
      })
    );

    expect(projection).toMatchObject({ discoverable: false, userVerificationRequired: false });
  });

  it("skips a payload with no credential id at all rather than inventing one", () => {
    expect(readKeePassPasskeyFields(fields({ [KEEPASS_PASSKEY_FIELDS.data]: secret('{"rpId":"github.com"}') }))).toBeUndefined();
  });

  it("names the relying party after its id when the payload has no rpName", () => {
    const projection = readKeePassPasskeyFields(
      fields({ [KEEPASS_PASSKEY_FIELDS.data]: secret(JSON.stringify({ credentialId: "Y3JlZA", rpId: "github.com" })) })
    );

    expect(projection!.rpName).toBe("github.com");
  });

  it("reads a KeePassDX credential nothing Monica wrote", () => {
    const projection = readKeePassPasskeyFields(keePassDxEntry(), { createdAt: "2026-02-01T00:00:00.000Z", useCount: 4 });

    expect(projection).toMatchObject({
      credentialId: "Y3JlZC1vbmU",
      rpId: "github.com",
      rpName: "GitHub",
      userHandle: "dXNlci1oYW5kbGU",
      userName: "alice",
      userDisplayName: "alice",
      algorithm: -7,
      publicKey: "",
      signCount: 0,
      discoverable: true,
      userVerificationRequired: true,
      transports: ["internal"],
      sourceMode: "browser-local",
      createdAt: "2026-02-01T00:00:00.000Z",
      lastUsedAt: "2026-02-01T00:00:00.000Z",
      useCount: 4
    });
    expect(projection!.privateKeyPkcs8).toBe(P256_PKCS8);
  });

  /**
   * `KeePassDxPasskeyCodec.decode` requires all five. A credential missing its private key or user
   * handle cannot be asserted, so importing it would only produce a dropdown entry that fails at
   * signing time.
   */
  it.each(Object.entries(KEEPASSDX_PASSKEY_FIELDS).filter(([key]) =>
    ["username", "privateKey", "credentialId", "userHandle", "relyingParty"].includes(key)
  ))("rejects a KeePassDX credential missing %s", (_key, name) => {
    const entry = keePassDxEntry();
    entry.delete(name);

    expect(readKeePassPasskeyFields(entry)).toBeUndefined();
  });

  it("rejects a KeePassDX credential whose private key is not decodable base64", () => {
    expect(readKeePassPasskeyFields(keePassDxEntry({ [KEEPASSDX_PASSKEY_FIELDS.privateKey]: secret("!!!") }))).toBeUndefined();
  });

  it("strips the [Passkey] title suffix to recover the relying party name", () => {
    expect(readKeePassPasskeyFields(keePassDxEntry({ Title: "My Bank [Passkey]" }))!.rpName).toBe("My Bank");
    expect(readKeePassPasskeyFields(keePassDxEntry({ Title: "" }))!.rpName).toBe("github.com");
  });

  it("normalizes a KeePassDX relying party that was stored as a URL", () => {
    expect(readKeePassPasskeyFields(keePassDxEntry({ [KEEPASSDX_PASSKEY_FIELDS.relyingParty]: "GitHub.com." }))!.rpId).toBe("github.com");
  });

  it("reads the COSE algorithm out of the PKCS#8 OID, since a browser has no KeyFactory", () => {
    const algorithmOf = (pkcs8: string) =>
      readKeePassPasskeyFields(keePassDxEntry({ [KEEPASSDX_PASSKEY_FIELDS.privateKey]: secret(pem(pkcs8)) }))!.algorithm;

    expect(algorithmOf(P256_PKCS8)).toBe(-7);
    expect(algorithmOf(RSA_PKCS8_HEADER)).toBe(-257);
    expect(algorithmOf(ED25519_PKCS8)).toBe(-8);
  });

  it("accepts a base64url private key and re-pads it for crypto.subtle", () => {
    const urlSafe = P256_PKCS8.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const projection = readKeePassPasskeyFields(keePassDxEntry({ [KEEPASSDX_PASSKEY_FIELDS.privateKey]: secret(urlSafe) }));

    expect(projection!.privateKeyPkcs8).toBe(P256_PKCS8);
  });
});

describe("keePassPasskeyToVaultItem", () => {
  it("lets the entry own the title and notes and marks the item KEEPASS_COMPAT", () => {
    const projection = readKeePassPasskeyFields(
      fields({
        Notes: "备注",
        [KEEPASS_PASSKEY_FIELDS.data]: secret(JSON.stringify({ credentialId: "Y3JlZA", rpId: "github.com", rpName: "GitHub" }))
      })
    );

    const item = keePassPasskeyToVaultItem(projection!, base({ title: "stale", notes: "stale" }));

    expect(item).toMatchObject({ kind: "passkey", title: "GitHub", notes: "备注", passkeyMode: "KEEPASS_COMPAT" });
  });

  /** A KeePassDX entry stores no timestamps, so nothing may overwrite the envelope's creation date. */
  it("keeps the caller's createdAt when the entry carried none", () => {
    const projection = readKeePassPasskeyFields(fields({ [KEEPASS_PASSKEY_FIELDS.data]: secret('{"credentialId":"Y3JlZA"}') }));

    expect(keePassPasskeyToVaultItem(projection!, base()).createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("titles the item after the rp id when the credential has no readable name", () => {
    const projection = readKeePassPasskeyFields(fields({ [KEEPASS_PASSKEY_FIELDS.data]: secret('{"credentialId":"Y3JlZA","rpId":"github.com"}') }));

    expect(keePassPasskeyToVaultItem(projection!, base()).title).toBe("github.com");
  });

  it("round-trips a Monica passkey through the fields it writes", () => {
    const written = buildKeePassPasskeyFields({ item: passkey({ notes: "备注", useCount: 9, aaguid: "aa-guid" }) });

    const item = keePassPasskeyToVaultItem(readKeePassPasskeyFields(written)!, base());

    expect(item).toMatchObject({
      credentialId: "Y3JlZC1vbmU",
      rpId: "github.com",
      rpName: "GitHub",
      userHandle: "dXNlci1oYW5kbGU",
      userName: "alice",
      userDisplayName: "Alice Liu",
      algorithm: -7,
      publicKey: "cHVibGlj",
      privateKeyPkcs8: P256_PKCS8,
      signCount: 3,
      discoverable: true,
      userVerificationRequired: true,
      transports: ["internal", "hybrid"],
      aaguid: "aa-guid",
      useCount: 9,
      notes: "备注"
    });
  });
});

describe("buildKeePassPasskeyFields", () => {
  it("appends the [Passkey] suffix KeePassDX expects and writes Password as a protected empty string", () => {
    const written = buildKeePassPasskeyFields({ item: passkey() });

    expect(written.get("Title")).toBe("GitHub [Passkey]");
    expect(written.get("UserName")).toBe("alice");
    expect(written.get("URL")).toBe("https://github.com");
    expect(keePassFieldText(written.get("Password"))).toBe("");
    expect(written.get("Password")).toBeInstanceOf(kdbxweb.ProtectedValue);
  });

  it("leaves the URL blank rather than writing a bare https:// for a credential with no rp id", () => {
    expect(buildKeePassPasskeyFields({ item: passkey({ rpId: "" }) }).get("URL")).toBe("");
  });

  it("protects the payload and the KeePassDX secrets, and leaves the rest plain", () => {
    const written = buildKeePassPasskeyFields({ item: passkey() });

    for (const name of [
      KEEPASS_PASSKEY_FIELDS.data,
      KEEPASSDX_PASSKEY_FIELDS.privateKey,
      KEEPASSDX_PASSKEY_FIELDS.credentialId,
      KEEPASSDX_PASSKEY_FIELDS.userHandle
    ]) {
      expect(written.get(name), name).toBeInstanceOf(kdbxweb.ProtectedValue);
    }
    expect(written.get(KEEPASS_PASSKEY_FIELDS.credentialId)).toBe("Y3JlZC1vbmU");
    expect(written.get(KEEPASS_PASSKEY_FIELDS.mode)).toBe("KEEPASS_COMPAT");
    expect(written.get(KEEPASSDX_PASSKEY_FIELDS.relyingParty)).toBe("github.com");
  });

  it("writes the Monica payload with the Kotlin property names, so Android deserializes it", () => {
    const written = buildKeePassPasskeyFields({ item: passkey({ useCount: 9, aaguid: "aa-guid" }) });

    expect(JSON.parse(keePassFieldText(written.get(KEEPASS_PASSKEY_FIELDS.data)))).toEqual({
      credentialId: "Y3JlZC1vbmU",
      rpId: "github.com",
      rpName: "GitHub",
      userId: "dXNlci1oYW5kbGU",
      userName: "alice",
      userDisplayName: "Alice Liu",
      publicKeyAlgorithm: -7,
      publicKey: "cHVibGlj",
      privateKeyAlias: P256_PKCS8,
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      lastUsedAt: Date.parse("2026-01-01T00:00:00.000Z"),
      useCount: 9,
      iconUrl: null,
      isDiscoverable: true,
      isUserVerificationRequired: true,
      transports: "internal,hybrid",
      aaguid: "aa-guid",
      signCount: 3,
      notes: "",
      passkeyMode: "KEEPASS_COMPAT"
    });
  });

  it("writes the private key as PEM in 64-character lines", () => {
    const written = buildKeePassPasskeyFields({ item: passkey() });
    const lines = keePassFieldText(written.get(KEEPASSDX_PASSKEY_FIELDS.privateKey)).split("\n");

    expect(lines[0]).toBe("-----BEGIN PRIVATE KEY-----");
    expect(lines[lines.length - 1]).toBe("-----END PRIVATE KEY-----");
    expect(lines.slice(1, -1).every((line) => line.length <= 64)).toBe(true);
  });

  it("reuses the existing private key when the item carries only metadata", () => {
    const written = buildKeePassPasskeyFields({
      item: passkey({ privateKeyPkcs8: undefined, sourceMode: "android-metadata-only" }),
      existingFields: keePassDxEntry()
    });

    expect(keePassFieldText(written.get(KEEPASSDX_PASSKEY_FIELDS.privateKey))).toBe(pem(P256_PKCS8));
  });

  /**
   * Monica has no notion of credential backup, so neither flag may be invented: whatever KeePassDX
   * recorded is carried through and only a fresh entry falls back to "false".
   */
  it("carries the KeePassDX backup flags through an edit instead of resetting them", () => {
    const written = buildKeePassPasskeyFields({
      item: passkey(),
      existingFields: keePassDxEntry({ [KEEPASSDX_PASSKEY_FIELDS.flagBe]: "true", [KEEPASSDX_PASSKEY_FIELDS.flagBs]: "true" })
    });

    expect(written.get(KEEPASSDX_PASSKEY_FIELDS.flagBe)).toBe("true");
    expect(written.get(KEEPASSDX_PASSKEY_FIELDS.flagBs)).toBe("true");
  });

  it("defaults the backup flags to false on a fresh entry", () => {
    const written = buildKeePassPasskeyFields({ item: passkey() });

    expect(written.get(KEEPASSDX_PASSKEY_FIELDS.flagBe)).toBe("false");
    expect(written.get(KEEPASSDX_PASSKEY_FIELDS.flagBs)).toBe("false");
  });

  it("falls back to the display name when the credential has no user name", () => {
    const written = buildKeePassPasskeyFields({ item: passkey({ userName: "" }) });

    expect(written.get("UserName")).toBe("Alice Liu");
    expect(written.get(KEEPASSDX_PASSKEY_FIELDS.username)).toBe("Alice Liu");
  });

  it("writes internal as the transport when the credential declares none", () => {
    const written = buildKeePassPasskeyFields({ item: passkey({ transports: [] }) });

    expect(JSON.parse(keePassFieldText(written.get(KEEPASS_PASSKEY_FIELDS.data))).transports).toBe("internal");
  });
});

describe("buildKeePassPasskeyPatch", () => {
  it("preserves a plugin field and a third-party field through an edit", () => {
    const existing = fields({
      Title: "old [Passkey]",
      [KEEPASS_PASSKEY_FIELDS.data]: secret("{}"),
      _etm_template: "1",
      "KeePassXC Browser Settings": "{}"
    });

    const updated = applyKeePassFieldPatch(existing, buildKeePassPasskeyPatch({ item: passkey() }));

    expect(updated.get("_etm_template")).toBe("1");
    expect(updated.get("KeePassXC Browser Settings")).toBe("{}");
    expect(updated.get("Title")).toBe("GitHub [Passkey]");
  });

  it("overwrites a stale credential id in both conventions, so no client keeps the old one", () => {
    const existing = keePassDxEntry({ [KEEPASS_PASSKEY_FIELDS.credentialId]: "b2xk" });

    const updated = applyKeePassFieldPatch(existing, buildKeePassPasskeyPatch({ item: passkey({ credentialId: "bmV3" }) }));

    expect(updated.get(KEEPASS_PASSKEY_FIELDS.credentialId)).toBe("bmV3");
    expect(keePassFieldText(updated.get(KEEPASSDX_PASSKEY_FIELDS.credentialId))).toBe("bmV3");
  });
});

describe("stripPasskeySuffix", () => {
  it("removes only a trailing suffix", () => {
    expect(stripPasskeySuffix("GitHub [Passkey]")).toBe("GitHub");
    expect(stripPasskeySuffix("[Passkey] GitHub")).toBe("[Passkey] GitHub");
    expect(stripPasskeySuffix("GitHub")).toBe("GitHub");
  });
});
