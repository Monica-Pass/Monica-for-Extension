import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import { buildKeePassFixture, keePassCredentials, type KeePassFixtureEntry } from "./keepass-fixture";
import { installKdbxCryptoEngine } from "./keepass-crypto";
import { keePassFieldText } from "./keepass-login-codec";
import { openKeePassVault, readKeePassEntries } from "./keepass-vault";
import { createKeePassEntry, removeKeePassEntry, resolveKeePassGroup, writeKeePassEntry } from "./keepass-writer";
import type { CardItem, LoginItem, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";

/**
 * Write-back assertions for the handoff's central requirement: a browser edit of one field may not
 * disturb any other field, and a field this build has never heard of must survive verbatim. Fixtures
 * are built in-extension with kdbxweb; the Android repository is read-only for this work.
 */

const PASSWORD = "fixture master password";

async function openFixture(entries: KeePassFixtureEntry[]) {
  const bytes = await buildKeePassFixture({ entries });
  return openKeePassVault(bytes, { password: PASSWORD, databaseId: 7, providerId: "kp-1" });
}

function fieldText(entry: kdbxweb.KdbxEntry, name: string): string {
  return keePassFieldText(entry.fields.get(name));
}

function itemOfKind<K extends VaultItem["kind"]>(items: VaultItem[], kind: K): Extract<VaultItem, { kind: K }> {
  const found = items.find((item) => item.kind === kind);
  expect(found, `no ${kind} item in [${items.map((item) => item.kind).join(", ")}]`).toBeDefined();
  return found as Extract<VaultItem, { kind: K }>;
}

function baseItem(overrides: Partial<LoginItem> = {}): LoginItem {
  return {
    id: "item-1",
    kind: "login",
    title: "GitHub",
    favorite: false,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    providerRefs: [],
    username: "alice",
    password: "hunter2",
    uris: ["https://github.com"],
    customFields: [],
    ...overrides
  } as LoginItem;
}

describe("writeKeePassEntry", () => {
  /**
   * The whole point of the field patch: a plugin field, another client's settings blob and a name this
   * build has never seen are all outside Monica's overlay, so an edit of the password leaves them alone.
   */
  it("preserves plugin, third-party and unknown fields through a login edit", async () => {
    const snapshot = await openFixture([
      {
        title: "GitHub",
        fields: {
          UserName: "alice",
          _etm_title_Security: "Security",
          "KeePassXC-Browser Settings": '{"skip":true}',
          "Some Future Field": "未来值"
        },
        protectedFields: { Password: "hunter2" }
      }
    ]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;

    writeKeePassEntry(snapshot.database, entry, { ...login, password: "new-secret" });

    expect(fieldText(entry, "Password")).toBe("new-secret");
    expect(fieldText(entry, "_etm_title_Security")).toBe("Security");
    expect(fieldText(entry, "KeePassXC-Browser Settings")).toBe('{"skip":true}');
    expect(fieldText(entry, "Some Future Field")).toBe("未来值");
  });

  /**
   * `otp` is role `keepass-totp`, never Monica-owned, so the double gate in `applyKeePassFieldPatch`
   * refuses to drop it even though the login codec's overlay never mentions it. This is what lets the
   * bridge fold a KeePassXC authenticator onto the login instead of modelling a second item.
   */
  it("leaves a KeePassXC otp field untouched when the login half is edited", async () => {
    const otpUri = "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&period=60";
    const snapshot = await openFixture([
      { title: "GitHub", fields: { UserName: "alice" }, protectedFields: { Password: "hunter2", otp: otpUri } }
    ]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;

    writeKeePassEntry(snapshot.database, entry, { ...login, username: "bob" });

    expect(fieldText(entry, "UserName")).toBe("bob");
    expect(fieldText(entry, "otp")).toBe(otpUri);
  });

  it("keeps the entry uuid, binaries and group so the entry is patched rather than replaced", async () => {
    const snapshot = await openFixture([
      {
        title: "GitHub",
        fields: { UserName: "alice" },
        binaries: { "attachment.txt": new Uint8Array([1, 2, 3]) },
        tags: ["work"]
      }
    ]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;
    const uuid = entry.uuid.toString();
    const parent = entry.parentGroup;

    writeKeePassEntry(snapshot.database, entry, { ...login, title: "GitHub 新" });

    expect(entry.uuid.toString()).toBe(uuid);
    expect(entry.parentGroup).toBe(parent);
    expect([...entry.binaries.keys()]).toEqual(["attachment.txt"]);
    expect(entry.tags).toEqual(["work"]);
  });

  /** KeePassXC shows the pre-edit state as history, which is what lets a user undo a bad sync. */
  it("pushes the pre-edit state onto the entry history", async () => {
    const snapshot = await openFixture([{ title: "GitHub", fields: { UserName: "alice" } }]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;

    writeKeePassEntry(snapshot.database, entry, { ...login, username: "bob" });

    expect(entry.history.length).toBe(1);
    expect(keePassFieldText(entry.history[0].fields.get("UserName"))).toBe("alice");
  });

  /** Android's row id lives only in the entry, so an update must read it back rather than drop it. */
  it("carries MonicaLocalId through an update of an Android-created login", async () => {
    const snapshot = await openFixture([
      { title: "GitHub", fields: { UserName: "alice", MonicaLocalId: "42" }, protectedFields: { Password: "x" } }
    ]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;

    writeKeePassEntry(snapshot.database, entry, { ...login, username: "bob" });

    expect(fieldText(entry, "MonicaLocalId")).toBe("42");
  });

  it("carries MonicaSecureItemId through an update of an Android-created note", async () => {
    const snapshot = await openFixture([
      {
        title: "备忘",
        fields: { MonicaItemType: "NOTE", MonicaSecureItemId: "9" },
        protectedFields: { MonicaItemData: '{"content":"正文"}' }
      }
    ]);
    const note = itemOfKind(snapshot.items, "secure-note") as SecureNoteItem;
    const entry = snapshot.entriesByUuid.get(note.keepassEntryUuid!)!;

    writeKeePassEntry(snapshot.database, entry, { ...note, content: "新正文" });

    expect(fieldText(entry, "MonicaSecureItemId")).toBe("9");
    expect(fieldText(entry, "MonicaItemData")).toContain("新正文");
  });

  /** A password must never land in the file as plaintext, whichever codec wrote it. */
  it("writes secrets as protected values", async () => {
    const snapshot = await openFixture([{ title: "GitHub", fields: { UserName: "alice" } }]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;

    writeKeePassEntry(snapshot.database, entry, { ...login, password: "s3cret" });

    expect(entry.fields.get("Password")).toBeInstanceOf(kdbxweb.ProtectedValue);
  });

  /** Clearing a custom field has to delete it; leaving an empty one would look like a typed value. */
  it("removes a custom field the user cleared", async () => {
    const snapshot = await openFixture([
      { title: "GitHub", fields: { UserName: "alice", "Security question": "母亲的姓" } }
    ]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;
    expect(login.customFields?.some((field) => field.name === "Security question")).toBe(true);

    writeKeePassEntry(snapshot.database, entry, {
      ...login,
      customFields: (login.customFields ?? []).map((field) =>
        field.name === "Security question" ? { ...field, value: "" } : field
      )
    });

    expect(entry.fields.has("Security question")).toBe(false);
  });

  it("refuses an item kind that projects onto no KeePass entry shape", async () => {
    const snapshot = await openFixture([{ title: "GitHub", fields: { UserName: "alice" } }]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;

    expect(() =>
      writeKeePassEntry(snapshot.database, entry, { ...baseItem(), kind: "unsupported" } as unknown as VaultItem)
    ).toThrow(/无法写入/);
  });
});

describe("createKeePassEntry", () => {
  it("lands a new entry in the group the percent-encoded path names, creating it when missing", async () => {
    const snapshot = await openFixture([{ title: "Root", fields: { UserName: "a" } }]);

    const { entry, created } = createKeePassEntry(
      snapshot.database,
      baseItem({ title: "新条目" }),
      `${encodeURIComponent("工作/组")}/${encodeURIComponent("子组")}`
    );

    expect(created).toBe(true);
    expect(entry.parentGroup!.name).toBe("子组");
    expect(entry.parentGroup!.parentGroup!.name).toBe("工作/组");
    expect(fieldText(entry, "Title")).toBe("新条目");
  });

  it("reuses an existing group rather than creating a duplicate", async () => {
    const snapshot = await openFixture([{ title: "Nested", group: "Work", fields: { UserName: "a" } }]);

    createKeePassEntry(snapshot.database, baseItem(), "Work");

    const matches = snapshot.database.getDefaultGroup().groups.filter((group) => group.name === "Work");
    expect(matches).toHaveLength(1);
    expect(matches[0].entries).toHaveLength(2);
  });

  it("puts an entry with a blank path in the root group", async () => {
    const snapshot = await openFixture([{ title: "Root", fields: { UserName: "a" } }]);

    const { entry } = createKeePassEntry(snapshot.database, baseItem());

    expect(entry.parentGroup).toBe(snapshot.database.getDefaultGroup());
  });

  it("writes a card as the labelled fields KeePassXC can show", async () => {
    const snapshot = await openFixture([{ title: "Root", fields: { UserName: "a" } }]);
    const card: CardItem = {
      ...baseItem(),
      kind: "card",
      title: "Visa",
      number: "4111111111111111",
      cardholderName: "ALICE LIU",
      expiryMonth: "08",
      expiryYear: "2029",
      securityCode: "123"
    } as unknown as CardItem;

    const { entry } = createKeePassEntry(snapshot.database, card);

    expect(fieldText(entry, "MonicaItemType")).toBe("BANK_CARD");
    expect(fieldText(entry, "Card Number")).toBe("4111111111111111");
    expect(fieldText(entry, "Card Holder")).toBe("ALICE LIU");
    expect(entry.fields.get("Card Number")).toBeInstanceOf(kdbxweb.ProtectedValue);
  });
});

describe("removeKeePassEntry", () => {
  it("moves the entry into the recycle bin so Android still shows it in its own trash", async () => {
    const snapshot = await openFixture([{ title: "GitHub", fields: { UserName: "alice" } }]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;

    removeKeePassEntry(snapshot.database, entry);

    const reread = readKeePassEntries(snapshot.database, 7, "kp-1");
    const trashed = reread.items.find((item) => item.keepassEntryUuid === login.keepassEntryUuid);
    expect(trashed?.deletedAt).toBeTruthy();
    expect(snapshot.database.getDefaultGroup().entries).toHaveLength(0);
  });
});

describe("round trip through save and reload", () => {
  /** The end-to-end guarantee: an edit made in the browser is what another client reads back. */
  it("reloads the edited login and every field the edit did not touch", async () => {
    installKdbxCryptoEngine();
    const snapshot = await openFixture([
      {
        title: "GitHub",
        fields: { UserName: "alice", "Some Future Field": "未来值" },
        protectedFields: { Password: "hunter2", otp: "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP" }
      }
    ]);
    const login = itemOfKind(snapshot.items, "login") as LoginItem;
    const entry = snapshot.entriesByUuid.get(login.keepassEntryUuid!)!;
    writeKeePassEntry(snapshot.database, entry, { ...login, password: "new-secret", title: "GitHub 新" });

    const saved = new Uint8Array(await snapshot.database.save());
    const reloaded = await kdbxweb.Kdbx.load(saved.slice().buffer, keePassCredentials(PASSWORD));
    const reread = readKeePassEntries(reloaded, 7, "kp-1");

    const rebuilt = reread.items.find((item) => item.keepassEntryUuid === login.keepassEntryUuid) as LoginItem;
    expect(rebuilt).toMatchObject({ title: "GitHub 新", username: "alice", password: "new-secret" });
    expect(rebuilt.customFields?.find((field) => field.name === "Some Future Field")?.value).toBe("未来值");
    expect(rebuilt.totpSecret).toContain("JBSWY3DPEHPK3PXP");
  });

  it("reloads a TOTP item created in the browser as a TOTP item", async () => {
    installKdbxCryptoEngine();
    const snapshot = await openFixture([{ title: "Root", fields: { UserName: "a" } }]);
    const totp: TotpItem = {
      ...baseItem(),
      kind: "totp",
      title: "GitHub",
      secret: "JBSWY3DPEHPK3PXP",
      period: 60,
      digits: 6,
      algorithm: "SHA1"
    } as unknown as TotpItem;
    createKeePassEntry(snapshot.database, totp, "Work");

    const saved = new Uint8Array(await snapshot.database.save());
    const reloaded = await kdbxweb.Kdbx.load(saved.slice().buffer, keePassCredentials(PASSWORD));
    const reread = readKeePassEntries(reloaded, 7, "kp-1");

    const rebuilt = reread.items.find((item) => item.kind === "totp") as TotpItem;
    expect(rebuilt).toMatchObject({ title: "GitHub", secret: "JBSWY3DPEHPK3PXP", period: 60 });
    expect(rebuilt.keepassGroupPath).toBe("Work");
  });
});

describe("resolveKeePassGroup", () => {
  it("matches by decoded name, since each path segment is percent-encoded on its own", async () => {
    const snapshot = await openFixture([{ title: "Nested", group: "工作/组", fields: { UserName: "a" } }]);

    const group = resolveKeePassGroup(snapshot.database, encodeURIComponent("工作/组"));

    expect(group.name).toBe("工作/组");
    expect(snapshot.database.getDefaultGroup().groups.filter((child) => child.name === "工作/组")).toHaveLength(1);
  });
});
