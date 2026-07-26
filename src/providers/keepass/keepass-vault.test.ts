import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import {
  buildKeePassFixture,
  keePassCredentials,
  withCipherUuid,
  type KeePassFixtureEntry,
  type KeePassFixtureOptions
} from "./keepass-fixture";
import { KeePassOperationError } from "./keepass-format";
import { openKeePassVault, readKeePassEntries } from "./keepass-vault";
import { KEEPASS_PASSKEY_FIELDS } from "./keepass-passkey-codec";
import { KEEPASSDX_PASSKEY_FIELDS } from "./keepass-field-registry";
import { installKdbxCryptoEngine } from "./keepass-crypto";
import type { CardItem, LoginItem, PasskeyItem, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";

/**
 * Model-level assertions for the read pipeline of Android `KeePassKdbxService.kt` (SHA 9930d8d8).
 * Fixtures are built here with kdbxweb: the Android repository is read-only for this work, so no
 * fixture may be produced by modifying or running it.
 */

const PASSWORD = "fixture master password";
const P256_PKCS8 =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsloK6aKNvj0CZMYdBdSZs+AUAsFy1t66q4tq5SvyeJahRANCAASlCTbHlIcaKQ2lzoEFhtjkLEO++f3cYq6FMYG7eH3BmuLQPz71FAtWq4z+tIb7oequwhUJL3xos1nA8jFqpkDs";

function pem(pkcs8Base64: string): string {
  const body = (pkcs8Base64.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

async function openFixture(entries: KeePassFixtureEntry[], overrides: Partial<KeePassFixtureOptions> = {}) {
  const bytes = await buildKeePassFixture({ entries, ...overrides });
  return openKeePassVault(bytes, { password: PASSWORD, databaseId: 7, providerId: "kp-1" });
}

function itemOfKind<K extends VaultItem["kind"]>(items: VaultItem[], kind: K): Extract<VaultItem, { kind: K }> {
  const found = items.find((item) => item.kind === kind);
  expect(found, `no ${kind} item in [${items.map((item) => `${item.kind}:${item.title}`).join(", ")}]`).toBeDefined();
  return found as Extract<VaultItem, { kind: K }>;
}

describe("openKeePassVault", () => {
  it("opens a KDBX 4 database and decodes an ordinary login", async () => {
    const snapshot = await openFixture([
      { title: "GitHub", fields: { UserName: "alice", URL: "https://github.com", Notes: "备注" }, protectedFields: { Password: "hunter2" } }
    ]);

    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    expect(login).toMatchObject({
      title: "GitHub",
      username: "alice",
      password: "hunter2",
      uris: ["https://github.com"],
      notes: "备注",
      loginType: "PASSWORD",
      keepassDatabaseId: 7
    });
    expect(login.id).toBe(`keepass:kp-1:${login.keepassEntryUuid}`);
    expect(login.providerRefs[0]).toMatchObject({ providerId: "kp-1", remoteId: login.keepassEntryUuid });
  });

  it("opens a KDBX 3 database and warns that it stays on version 3", async () => {
    const snapshot = await openFixture([{ title: "GitHub", fields: { UserName: "alice" } }], { version: 3 });

    expect(snapshot.versionMajor).toBe(3);
    expect(snapshot.warnings.join()).toContain("KDBX 3");
    expect(itemOfKind(snapshot.items, "login").title).toBe("GitHub");
  });

  it("opens an AES-KDF database, which is what KeePass 2.x writes by default", async () => {
    const snapshot = await openFixture([{ title: "GitHub" }], { kdf: "aes" });

    expect(itemOfKind(snapshot.items, "login").title).toBe("GitHub");
  });

  it("opens a database whose only credential is a key file", async () => {
    const keyFile = new Uint8Array(32).fill(9);
    const bytes = await buildKeePassFixture({ password: null, keyFile, entries: [{ title: "GitHub", fields: { UserName: "alice" } }] });

    const snapshot = await openKeePassVault(bytes, { password: "", keyFile, databaseId: 1, providerId: "kp-1" });

    expect(itemOfKind(snapshot.items, "login").username).toBe("alice");
  });

  it("names every credential combination it tried when none opened the file", async () => {
    const bytes = await buildKeePassFixture({ entries: [{ title: "GitHub" }] });

    await expect(openKeePassVault(bytes, { password: "wrong", databaseId: 1, providerId: "kp-1" })).rejects.toMatchObject({
      code: "invalid-credential"
    });
  });

  /** Twofish must be named explicitly rather than surfacing as a vague decryption failure. */
  it("refuses a Twofish database with an actionable message before touching kdbxweb", async () => {
    const bytes = withCipherUuid(await buildKeePassFixture({ entries: [{ title: "GitHub" }] }), "rWjyn1dvS7mjatR6+WU0bA==");

    const error = await openKeePassVault(bytes, { password: PASSWORD, databaseId: 1, providerId: "kp-1" }).catch((e) => e);

    expect(error).toBeInstanceOf(KeePassOperationError);
    expect(error.code).toBe("cipher-unsupported");
    expect(error.message).toContain("Twofish");
  });

  it("refuses a legacy .kdb before spending a KDF derivation on it", async () => {
    const bytes = new Uint8Array([0x03, 0xd9, 0xa2, 0x9a, 0x65, 0xfb, 0x4b, 0xb5, 0, 0, 0, 0]);

    await expect(openKeePassVault(bytes, { password: "", databaseId: 1, providerId: "kp-1" })).rejects.toMatchObject({
      code: "legacy-kdb-unsupported"
    });
  });
});

describe("group traversal", () => {
  it("leaves the root group's entries with no path, since a blank path means the root", async () => {
    const snapshot = await openFixture([{ title: "Root Entry", fields: { UserName: "a" } }]);

    expect(itemOfKind(snapshot.items, "login").keepassGroupPath).toBeUndefined();
  });

  it("records a nested group as a percent-encoded path key", async () => {
    const snapshot = await openFixture([{ title: "Work", group: "工作/组", fields: { UserName: "a" } }]);

    expect(itemOfKind(snapshot.items, "login").keepassGroupPath).toBe(encodeURIComponent("工作/组"));
  });

  it("records the group uuid alongside the path", async () => {
    const snapshot = await openFixture([{ title: "Work", group: "Work", fields: { UserName: "a" } }]);

    const login = itemOfKind(snapshot.items, "login");
    const group = snapshot.database.getDefaultGroup().groups.find((child) => child.name === "Work");
    expect(login.keepassGroupUuid).toBe(group!.uuid.toString());
  });
});

describe("recycle bin", () => {
  async function withRecycleBin(enabled: boolean) {
    installKdbxCryptoEngine();
    const bytes = await buildKeePassFixture({
      entries: [
        { title: "Live", fields: { UserName: "live" } },
        { title: "Trashed", group: "Recycle Bin", fields: { UserName: "trashed" } }
      ]
    });
    const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
    const bin = database.getDefaultGroup().groups.find((group) => group.name === "Recycle Bin")!;
    database.meta.recycleBinEnabled = enabled;
    database.meta.recycleBinUuid = enabled ? bin.uuid : undefined;
    return readKeePassEntries(database, 7, "kp-1");
  }

  it("marks an entry inside the declared bin deleted rather than dropping it", async () => {
    const entries = await withRecycleBin(true);

    expect(entries.hasRecycleBinMeta).toBe(true);
    expect(entries.items.find((item) => item.title === "Trashed")!.deletedAt).toBeTruthy();
    expect(entries.items.find((item) => item.title === "Live")!.deletedAt).toBeUndefined();
  });

  /** `resolveRecycleBinFlag` only consults the name when the metadata declares no bin at all. */
  it("falls back to the group name when the database declares no bin", async () => {
    const entries = await withRecycleBin(false);

    expect(entries.hasRecycleBinMeta).toBe(false);
    expect(entries.items.find((item) => item.title === "Trashed")!.deletedAt).toBeTruthy();
  });

  it("treats a nested group under the bin as deleted too", async () => {
    installKdbxCryptoEngine();
    const bytes = await buildKeePassFixture({ entries: [{ title: "Deep", group: "Bin", fields: { UserName: "x" } }] });
    const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
    const bin = database.getDefaultGroup().groups.find((group) => group.name === "Bin")!;
    const nested = database.createGroup(bin, "Nested");
    const entry = database.createEntry(nested);
    entry.fields.set("Title", "Nested Entry");
    entry.fields.set("UserName", "y");
    database.meta.recycleBinEnabled = true;
    database.meta.recycleBinUuid = bin.uuid;

    const entries = readKeePassEntries(database, 7, "kp-1");

    expect(entries.items.find((item) => item.title === "Nested Entry")!.deletedAt).toBeTruthy();
  });
});

describe("entry dispatch precedence", () => {
  it("decodes a Monica secure note rather than a login", async () => {
    const snapshot = await openFixture([
      { title: "备忘", fields: { MonicaItemType: "NOTE" }, protectedFields: { MonicaItemData: '{"content":"正文"}' } }
    ]);

    expect(snapshot.items).toHaveLength(1);
    expect(itemOfKind(snapshot.items, "secure-note") as SecureNoteItem).toMatchObject({ title: "备忘", content: "正文" });
  });

  it("decodes a bank card written as labelled fields", async () => {
    const snapshot = await openFixture([
      {
        title: "Visa",
        fields: { MonicaItemType: "BANK_CARD", "Card Holder": "ALICE LIU", "Card Expiry": "08/2029" },
        protectedFields: { "Card Number": "4111111111111111", "Card CVV": "123" }
      }
    ]);

    expect(itemOfKind(snapshot.items, "card") as CardItem).toMatchObject({
      number: "4111111111111111",
      cardholderName: "ALICE LIU",
      expiryMonth: "08",
      expiryYear: "2029",
      securityCode: "123"
    });
  });

  it("imports a KeePassXC otp entry that never heard of Monica", async () => {
    const snapshot = await openFixture([
      { title: "GitHub", protectedFields: { otp: "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&period=60" } }
    ]);

    expect(itemOfKind(snapshot.items, "totp") as TotpItem).toMatchObject({ secret: "JBSWY3DPEHPK3PXP", period: 60 });
  });

  /**
   * Android emits both a `PasswordEntry` and a TOTP `SecureItem` from this one entry, into two separate
   * tables. Here both items would derive the same id from the entry UUID, so the credential rides along
   * on the login instead. The `otp` field itself is `keepass-totp`, never Monica-owned, so a write-back
   * still preserves it verbatim for KeePassXC.
   */
  it("keeps a login that also carries otp as a login, with the credential on totpSecret", async () => {
    const snapshot = await openFixture([
      {
        title: "GitHub",
        fields: { UserName: "alice" },
        protectedFields: { Password: "hunter2", otp: "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&period=60" }
      }
    ]);

    expect(snapshot.items).toHaveLength(1);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    expect(login).toMatchObject({ username: "alice", password: "hunter2" });
    expect(login.totpSecret).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(login.totpSecret).toContain("period=60");
  });

  it("decodes a passkey entry that carries nothing but its credential", async () => {
    const snapshot = await openFixture([
      {
        title: "GitHub [Passkey]",
        fields: { [KEEPASSDX_PASSKEY_FIELDS.username]: "alice", [KEEPASSDX_PASSKEY_FIELDS.relyingParty]: "github.com" },
        protectedFields: {
          [KEEPASSDX_PASSKEY_FIELDS.privateKey]: pem(P256_PKCS8),
          [KEEPASSDX_PASSKEY_FIELDS.credentialId]: "Y3JlZC1vbmU",
          [KEEPASSDX_PASSKEY_FIELDS.userHandle]: "dXNlci1oYW5kbGU"
        }
      }
    ]);

    expect(itemOfKind(snapshot.items, "passkey") as PasskeyItem).toMatchObject({
      rpId: "github.com",
      userName: "alice",
      credentialId: "Y3JlZC1vbmU",
      passkeyMode: "KEEPASS_COMPAT"
    });
  });

  /**
   * `analyzePasswordEntry` only skips a passkey entry as PURE_PASSKEY when username, password, url and
   * notes are all blank. One that also carries a username is a login on Android, so it is one here.
   */
  it("treats a passkey entry that also carries a login as a login", async () => {
    const snapshot = await openFixture([
      {
        title: "GitHub",
        fields: { UserName: "alice", [KEEPASSDX_PASSKEY_FIELDS.relyingParty]: "github.com" },
        protectedFields: { Password: "hunter2" }
      }
    ]);

    expect(snapshot.items).toHaveLength(1);
    expect(itemOfKind(snapshot.items, "login")).toMatchObject({ username: "alice", password: "hunter2" });
  });

  /** `entryToSecureItemData` returns null for a passkey entry, so one entry never yields two items. */
  it("yields nothing for an entry declaring both a secure item and a passkey", async () => {
    const snapshot = await openFixture([
      {
        title: "混合",
        fields: { MonicaItemType: "NOTE", [KEEPASS_PASSKEY_FIELDS.credentialId]: "Y3JlZA" },
        protectedFields: { MonicaItemData: '{"content":"x"}' }
      }
    ]);

    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.skipped[0]).toMatchObject({ reason: "monica-secure-item" });
  });

  it("skips a KeePass2Android template instead of importing a junk login", async () => {
    const snapshot = await openFixture([{ title: "Credit Card", fields: { _etm_template: "1" } }]);

    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.skipped[0]).toMatchObject({ reason: "template" });
  });

  it("skips an entry with all five standard fields empty", async () => {
    const snapshot = await openFixture([{ title: "" }]);

    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.skipped[0]).toMatchObject({ reason: "empty" });
  });

  it("skips an entry whose MonicaItemType this build does not know, rather than guessing", async () => {
    const snapshot = await openFixture([
      { title: "未来", fields: { MonicaItemType: "CRYPTO_SEED" }, protectedFields: { MonicaItemData: "{}" } }
    ]);

    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.skipped[0]).toMatchObject({ reason: "unknown-item-type" });
  });
});

describe("field references", () => {
  it("resolves a {REF:} alias so autofill never types braces into the login form", async () => {
    installKdbxCryptoEngine();
    const bytes = await buildKeePassFixture({
      entries: [{ title: "GitHub", fields: { UserName: "alice" }, protectedFields: { Password: "hunter2" } }]
    });
    const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
    const source = database.getDefaultGroup().entries[0];
    const alias = database.createEntry(database.getDefaultGroup());
    alias.fields.set("Title", "GitHub 别名");
    alias.fields.set("UserName", `{REF:U@I:${source.uuid.toString()}}`);
    alias.fields.set("Password", kdbxweb.ProtectedValue.fromString(`{REF:P@I:${source.uuid.toString()}}`));

    const entries = readKeePassEntries(database, 7, "kp-1");

    const resolved = entries.items.find((item) => item.title === "GitHub 别名") as LoginItem;
    expect(resolved.username).toBe("alice");
    expect(resolved.password).toBe("hunter2");
  });
});

describe("readKeePassEntries", () => {
  it("hands back a live entry handle per uuid, so a write can patch the original in place", async () => {
    const snapshot = await openFixture([{ title: "GitHub", fields: { UserName: "alice" } }]);

    const login = itemOfKind(snapshot.items, "login");
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!);
    expect(entry).toBeDefined();
    expect(entry!.fields.get("UserName")).toBe("alice");
  });

  it("keeps the entry's own timestamps rather than inventing them at import time", async () => {
    const snapshot = await openFixture([{ title: "GitHub", fields: { UserName: "alice" } }]);

    const login = itemOfKind(snapshot.items, "login");
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;
    expect(login.createdAt).toBe(entry.times.creationTime!.toISOString());
  });

  it("walks every group, so a deep entry is not lost", async () => {
    const snapshot = await openFixture([
      { title: "Root", fields: { UserName: "a" } },
      { title: "Nested", group: "Work", fields: { UserName: "b" } },
      { title: "Other", group: "Personal", fields: { UserName: "c" } }
    ]);

    expect(snapshot.items.map((item) => item.title).sort()).toEqual(["Nested", "Other", "Root"]);
  });
});
