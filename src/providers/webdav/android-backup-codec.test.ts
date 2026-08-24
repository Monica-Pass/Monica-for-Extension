import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PasskeyItem, SecureNoteItem, VaultItem } from "../../core/model";
const P256_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsloK6aKNvj0CZMYdBdSZs+AUAsFy1t66q4tq5SvyeJahRANCAASlCTbHlIcaKQ2lzoEFhtjkLEO++f3cYq6FMYG7eH3BmuLQPz71FAtWq4z+tIb7oequwhUJL3xos1nA8jFqpkDs";
import { androidFolderKey, deleteAndroidBackupItem, deleteAndroidGeneratorHistoryEntry, deleteAndroidPortableAttachment, listAndroidGeneratorHistory, listAndroidPortableAttachments, listAndroidTimeline, readAndroidBackup, readAndroidPortableAttachment, upsertAndroidPortableAttachment, writeAndroidBackup } from "./android-backup-codec";

function fixtureZip() {
  const password = {
    id: 42,
    title: "Android Login",
    username: "joy@example.com",
    password: "android-secret",
    website: "https://accounts.example.com",
    notes: "fixture",
    isFavorite: true,
    loginType: "PASSWORD",
    appPackageName: "com.example.app",
    appName: "Example App",
    email: "joy@example.com",
    phone: "+8613800000000",
    passkeyBindings: '[{"credentialId":"bound"}]',
    sshKeyData: '{"private":"encrypted"}',
    wifiMetadata: '{"ssid":"Monica"}',
    customIconType: "UPLOADED",
    customIconValue: "example.enc",
    customIconUpdatedAt: 1_700_000_002_000,
    categoryId: 8,
    categoryName: "Work",
    imagePaths: '["image-a.enc"]',
    customFields: [{ title: "tenant", value: "cn", isProtected: false }],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    futureAndroidField: { preserve: true }
  };
  const card = {
    id: 7,
    itemType: "BANK_CARD",
    title: "Visa",
    itemData: JSON.stringify({
      cardholderName: "Joy",
      number: "4111111111111111",
      expMonth: "12",
      expYear: "2030",
      code: "123",
      brand: "Visa",
      pin: "9876",
      futureNestedField: { preserve: true }
    }),
    notes: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  };
  const passkey = {
    credentialId: "cred-id",
    rpId: "example.com",
    rpName: "Example",
    userId: "user-handle",
    userName: "joy",
    userDisplayName: "Joy",
    publicKeyAlgorithm: -7,
    publicKey: "public",
    privateKeyAlias: "monica-passkey-key-ref-v1:device-only",
    createdAt: 1_700_000_000_000,
    lastUsedAt: 1_700_000_000_000,
    signCount: 2
  };
  const note = {
    id: 8,
    title: "Markdown note",
    itemData: JSON.stringify({ content: "# Android note", tags: ["android"], isMarkdown: true }),
    notes: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  };
  const totp = {
    id: 9,
    title: "GitHub OTP",
    itemData: JSON.stringify({ authenticatorKey: "TOTPSECRET", issuer: "GitHub", accountName: "joy", algorithm: "sha256", digits: "8", period: "60", otpType: "HOTP", counter: 4 }),
    notes: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  };
  const document = {
    id: 10,
    itemType: "DOCUMENT",
    title: "Passport",
    itemData: JSON.stringify({ type: "passport", number: "P1234567", name: "Joy Doe", issueDate: "2020-01-01", issuingAuthority: "Example Authority", address1: "1 Main St", state: "CA", passportNumber: "P1234567" }),
    notes: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  };
  const billingAddress = {
    id: 11,
    itemType: "BILLING_ADDRESS",
    title: "Home",
    itemData: JSON.stringify({ name: "Joy Doe", organization: "Monica", addressLine1: "1 Main St", addressLine2: "Unit 2", city: "Shanghai", region: "Shanghai", zipCode: "200000", country: "CN", phoneNumber: "10086", email: "joy@example.com" }),
    notes: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  };
  const paymentAccount = {
    id: 12,
    itemType: "PAYMENT_ACCOUNT",
    title: "Daily bank",
    itemData: JSON.stringify({ type: "bank_account", service: "Example Bank", nickname: "Daily", nameOnAccount: "Joy Doe", userName: "joy-bank", accountIdentifier: "acct-42", accountNumber: "****0042", routingNumber: "021000021", iban: "DE89370400440532013000", swift: "EXAMPLEBIC", url: "https://bank.example", currency: "CNY" }),
    notes: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  };
  return zipSync({
    "folders/_root/passwords/password_42_1700000000000.json": strToU8(JSON.stringify(password)),
    "folders/_root/bank_cards/bank_card_7_1700000000000.json": strToU8(JSON.stringify(card)),
    "folders/_root/passkeys/passkey_cred-id.json": strToU8(JSON.stringify(passkey)),
    "folders/_root/notes/note_8_1700000000000.json": strToU8(JSON.stringify(note)),
    "folders/_root/authenticators/totp_9_1700000000000.json": strToU8(JSON.stringify(totp)),
    "folders/_root/documents/document_10_1700000000000.json": strToU8(JSON.stringify(document)),
    "folders/_root/billing_addresses/billing_address_11_1700000000000.json": strToU8(JSON.stringify(billingAddress)),
    "folders/_root/payment_accounts/payment_account_12_1700000000000.json": strToU8(JSON.stringify(paymentAccount)),
    "future/unknown.bin": Uint8Array.of(1, 2, 3, 4),
    "monica_config/future.json": strToU8('{"must":"survive"}')
  });
}

function currentAndroidRecordsFixture() {
  const secureOuter = {
    notes: "android-only-note",
    isFavorite: true,
    imagePaths: '["image-a.enc"]',
    keepassDatabaseId: null,
    keepassGroupPath: null,
    bitwardenVaultId: null,
    bitwardenFolderId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    categoryName: "Work"
  };
  const password = {
    id: 101,
    title: "Current login",
    username: "joy",
    password: "old-password",
    website: "https://current.example",
    notes: "login note",
    isFavorite: true,
    categoryId: 8,
    categoryName: "Work",
    appPackageName: "com.example.current",
    appName: "Current App",
    email: "joy@example.com",
    phone: "+8613800000000",
    keepassDatabaseId: null,
    keepassGroupPath: null,
    bitwardenVaultId: null,
    bitwardenFolderId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    authenticatorKey: "LOGINOTP",
    passkeyBindings: '[{"credentialId":"bound"}]',
    sshKeyData: '{"private":"encrypted"}',
    loginType: "PASSWORD",
    ssoProvider: "",
    ssoRefEntryId: null,
    customIconType: "UPLOADED",
    customIconValue: "icon-current.enc",
    customIconUpdatedAt: 1_700_000_002_000,
    wifiMetadata: '{"ssid":"Monica"}',
    customFields: [{ title: "tenant", value: "cn", isProtected: false }]
  };
  const totpData = {
    secret: "CURRENTOTP",
    issuer: "GitHub",
    accountName: "joy",
    period: 30,
    digits: 6,
    algorithm: "SHA1",
    otpType: "HOTP",
    counter: 17,
    pin: "2468",
    link: "https://github.com",
    associatedApp: "com.github.android",
    customIconType: "SIMPLE_ICON",
    customIconValue: "github",
    customIconUpdatedAt: 1_700_000_002_000,
    boundPasswordId: 101,
    categoryId: 8,
    keepassDatabaseId: null,
    steamFingerprint: "fingerprint",
    steamDeviceId: "android:device",
    steamSerialNumber: "serial",
    steamSharedSecretBase64: "shared",
    steamRevocationCode: "R12345",
    steamIdentitySecret: "identity",
    steamTokenGid: "gid",
    steamRawJson: "{\"steam\":true}"
  };
  const cardData = {
    cardNumber: "4111111111111111",
    cardholderName: "Joy",
    expiryMonth: "12",
    expiryYear: "2030",
    cvv: "123",
    bankName: "Monica Bank",
    cardType: "CREDIT",
    billingAddress: '{"streetAddress":"1 Main St"}',
    brand: "Visa",
    nickname: "Daily",
    validFromMonth: "01",
    validFromYear: "2024",
    pin: "9876",
    iban: "DE89370400440532013000",
    swiftBic: "MONICABIC",
    routingNumber: "021000021",
    accountNumber: "000042",
    branchCode: "001",
    currency: "CNY",
    customerServicePhone: "95555",
    customFields: [{ label: "limit", value: "10000", type: "TEXT" }]
  };
  const documentData = {
    documentType: "PASSPORT",
    documentNumber: "P1234567",
    fullName: "Joy Doe",
    issuedDate: "2024-01-01",
    expiryDate: "2034-01-01",
    issuedBy: "Authority",
    nationality: "CN",
    additionalInfo: "info",
    title: "Ms",
    firstName: "Joy",
    middleName: "M",
    lastName: "Doe",
    address1: "1 Main St",
    address2: "Unit 2",
    address3: "Building A",
    city: "Shanghai",
    stateProvince: "Shanghai",
    postalCode: "200000",
    country: "CN",
    company: "Monica",
    email: "joy@example.com",
    phone: "10086",
    ssn: "SSN",
    username: "joy-id",
    passportNumber: "P1234567",
    licenseNumber: "DL123",
    customFields: [{ label: "visa", value: "valid", type: "HIDDEN" }]
  };
  const billingData = {
    fullName: "Joy Doe",
    company: "Monica",
    streetAddress: "1 Main St",
    apartment: "Unit 2",
    city: "Shanghai",
    stateProvince: "Shanghai",
    postalCode: "200000",
    country: "CN",
    phone: "10086",
    email: "joy@example.com",
    isDefault: true,
    customFields: [{ label: "gate", value: "east", type: "TEXT" }]
  };
  const paymentData = {
    paymentType: "BANK_ACCOUNT",
    provider: "Monica Bank",
    accountName: "Daily",
    accountHolderName: "Joy Doe",
    email: "joy@example.com",
    phone: "10086",
    username: "joy-bank",
    accountId: "account-42",
    maskedAccountNumber: "****0042",
    linkedCardLast4: "1111",
    routingNumber: "021000021",
    iban: "DE89370400440532013000",
    swiftBic: "MONICABIC",
    billingAddress: '{"streetAddress":"1 Main St"}',
    website: "https://bank.example",
    currency: "CNY",
    notes: "payment-only-note",
    isDefault: true,
    customFields: [{ label: "branch", value: "001", type: "TEXT" }]
  };
  const noteData = {
    content: "old content",
    tags: ["android", "work"],
    isMarkdown: true,
    customFields: [
      { label: "Recovery code", value: "ABCD", type: "HIDDEN" },
      { label: "Pinned", value: "true", type: "BOOLEAN" }
    ],
    futureNoteField: { preserve: true }
  };
  const passkey = {
    credentialId: "current-passkey",
    rpId: "example.com",
    rpName: "Example",
    userId: "user-handle",
    userName: "joy",
    userDisplayName: "Joy",
    publicKeyAlgorithm: -7,
    publicKey: "public-key",
    privateKeyAlias: "monica-passkey-key-ref-v1:device-only",
    createdAt: 1_700_000_000_000,
    lastUsedAt: 1_700_000_001_000,
    useCount: 9,
    iconUrl: "https://example.com/icon.png",
    isDiscoverable: true,
    isUserVerificationRequired: true,
    transports: "internal,hybrid",
    aaguid: "00000000-0000-0000-0000-000000000000",
    signCount: 5,
    notes: "old passkey note",
    boundPasswordId: 101,
    passkeyMode: "LEGACY",
    categoryName: "Work"
  };
  const raws = {
    password,
    totp: { id: 102, itemType: "TOTP", title: "Current OTP", itemData: JSON.stringify(totpData), ...secureOuter },
    card: { id: 103, itemType: "BANK_CARD", title: "Current card", itemData: JSON.stringify(cardData), ...secureOuter },
    document: { id: 104, itemType: "DOCUMENT", title: "Current document", itemData: JSON.stringify(documentData), ...secureOuter },
    billing: { id: 105, itemType: "BILLING_ADDRESS", title: "Current address", itemData: JSON.stringify(billingData), ...secureOuter },
    payment: { id: 106, itemType: "PAYMENT_ACCOUNT", title: "Current payment", itemData: JSON.stringify(paymentData), ...secureOuter },
    note: { id: 107, itemType: "NOTE", title: "Current note", itemData: JSON.stringify(noteData), ...secureOuter },
    passkey
  };
  const paths = {
    password: "folders/Work/passwords/password_101_1700000000000.json",
    totp: "folders/Work/authenticators/totp_102_1700000000000.json",
    card: "folders/Work/bank_cards/bank_card_103_1700000000000.json",
    document: "folders/Work/documents/document_104_1700000000000.json",
    billing: "folders/Work/billing_addresses/billing_address_105_1700000000000.json",
    payment: "folders/Work/payment_accounts/payment_account_106_1700000000000.json",
    note: "folders/Work/notes/note_107_1700000000000.json",
    passkey: "folders/Work/passkeys/passkey_current-passkey.json"
  };
  const entries = Object.fromEntries(Object.entries(paths).map(([key, path]) => [path, strToU8(JSON.stringify(raws[key as keyof typeof raws]))]));
  return { zip: zipSync(entries), paths, raws, nested: { totpData, cardData, documentData, billingData, paymentData, noteData } };
}

describe("Android backup ZIP codec", () => {
  it("indexes and verifies portable attachments for the matching Android password", async () => {
    const payload = new TextEncoder().encode("hello attachment");
    const digest = await crypto.subtle.digest("SHA-256", payload);
    const sha256Hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const zip = zipSync({
      "folders/_root/passwords/password_42_0.json": strToU8(JSON.stringify({ id: 42, title: "Test", username: "u" })),
      "attachments_portable/attachments_portable.json": strToU8(JSON.stringify({ version: 2, entries: [{ parentPasswordId: 42, fileName: "a.txt", mimeType: "text/plain", sizeBytes: payload.byteLength, sha256Hex, payloadPath: "attachments_portable/abc.bin" }] })),
      "attachments_portable/abc.bin": payload
    });
    const document = readAndroidBackup(zip, "webdav");
    const [item] = document.items;
    const [attachment] = listAndroidPortableAttachments(document, item);
    expect(attachment.fileName).toBe("a.txt");
    await expect(readAndroidPortableAttachment(document, attachment)).resolves.toEqual(payload);
  });

  it("preserves but does not expose portable payloads when the caller disallows plaintext attachments", () => {
    const zip = zipSync({
      "folders/_root/passwords/password_42_0.json": strToU8(JSON.stringify({ id: 42, title: "Test" })),
      "attachments_portable/attachments_portable.json": strToU8(JSON.stringify({ version: 2, entries: [{ parentPasswordId: 42, fileName: "secret.bin", mimeType: "application/octet-stream", sizeBytes: 1, sha256Hex: "0".repeat(64), payloadPath: "attachments_portable/secret.bin", createdAt: 1, updatedAt: 1 }] })),
      "attachments_portable/secret.bin": Uint8Array.of(1)
    });
    const document = readAndroidBackup(zip, "webdav", { allowPortableAttachments: false });
    expect(listAndroidPortableAttachments(document, document.items[0])).toEqual([]);
    expect(document.entries["attachments_portable/secret.bin"]).toEqual(Uint8Array.of(1));
    expect(document.warnings.join(" ")).toContain("未加密");
  });

  it("ignores path traversal entries and rejects digest mismatches", async () => {
    const payload = new TextEncoder().encode("bad");
    const zip = zipSync({
      "attachments_portable/attachments_portable.json": strToU8(JSON.stringify({ version: 2, entries: [{ parentSecureItemId: 42, fileName: "x", sizeBytes: payload.byteLength, sha256Hex: "0".repeat(64), payloadPath: "attachments_portable/../secret.bin" }] })),
      "attachments_portable/secret.bin": payload
    });
    const document = readAndroidBackup(zip, "webdav");
    expect(listAndroidPortableAttachments(document, { id: "item", providerRefs: [] } as never)).toEqual([]);
  });

  it("writes and removes portable payloads without dropping unknown manifest entries", async () => {
    const zip = zipSync({
      "folders/_root/passwords/password_42_0.json": strToU8(JSON.stringify({ id: 42, title: "Test" })),
      "attachments_portable/attachments_portable.json": strToU8(JSON.stringify({ version: 2, future: { keep: true }, entries: [{ futureField: "preserve", payloadPath: "attachments_portable/future.bin" }] })),
      "attachments_portable/future.bin": Uint8Array.of(1)
    });
    const document = readAndroidBackup(zip, "webdav");
    const item = document.items[0];
    const payload = new TextEncoder().encode("new");
    const digest = await crypto.subtle.digest("SHA-256", payload);
    const entry = upsertAndroidPortableAttachment(document, item, { fileName: "new.txt", sizeBytes: payload.byteLength, sha256Hex: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("") }, payload);
    const manifest = JSON.parse(strFromU8(document.entries["attachments_portable/attachments_portable.json"]));
    expect(manifest.future).toEqual({ keep: true });
    expect(manifest.entries).toEqual(expect.arrayContaining([expect.objectContaining({ payloadPath: "attachments_portable/future.bin" }), expect.objectContaining({ fileName: "new.txt" })]));
    expect(deleteAndroidPortableAttachment(document, item, entry.attachmentId)).toBe(true);
    expect(document.entries[entry.payloadPath]).toBeUndefined();
    expect(JSON.parse(strFromU8(document.entries["attachments_portable/attachments_portable.json"])).entries).toEqual([expect.objectContaining({ payloadPath: "attachments_portable/future.bin" })]);
  });

  it("rejects replacing another item's portable attachment", async () => {
    const payload = new TextEncoder().encode("secret");
    const digest = await crypto.subtle.digest("SHA-256", payload);
    const sha256Hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const zip = zipSync({
      "folders/_root/passwords/password_42_0.json": strToU8(JSON.stringify({ id: 42, title: "One" })),
      "folders/_root/passwords/password_43_0.json": strToU8(JSON.stringify({ id: 43, title: "Two" })),
      "attachments_portable/attachments_portable.json": strToU8(JSON.stringify({ version: 2, entries: [{ parentPasswordId: 42, fileName: "one.txt", mimeType: "text/plain", sizeBytes: payload.byteLength, sha256Hex, payloadPath: "attachments_portable/one.bin", createdAt: 1, updatedAt: 1 }] })),
      "attachments_portable/one.bin": payload
    });
    const document = readAndroidBackup(zip, "webdav");
    const otherItem = document.items.find((item) => item.title === "Two")!;
    expect(() => upsertAndroidPortableAttachment(document, otherItem, { attachmentId: "android-portable:attachments_portable/one.bin", fileName: "attack.txt", sizeBytes: payload.byteLength, sha256Hex }, payload)).toThrow("不属于当前项目");
  });

  it("removes owned portable payloads when deleting an Android item", async () => {
    const payload = Uint8Array.of(1, 2, 3);
    const digest = await crypto.subtle.digest("SHA-256", payload);
    const sha256Hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const zip = zipSync({
      "folders/_root/passwords/password_42_0.json": strToU8(JSON.stringify({ id: 42, title: "Delete" })),
      "attachments_portable/attachments_portable.json": strToU8(JSON.stringify({ version: 2, entries: [{ parentPasswordId: 42, fileName: "delete.bin", mimeType: "application/octet-stream", sizeBytes: payload.byteLength, sha256Hex, payloadPath: "attachments_portable/delete.bin", createdAt: 1, updatedAt: 1 }] })),
      "attachments_portable/delete.bin": payload
    });
    const document = readAndroidBackup(zip, "webdav");
    deleteAndroidBackupItem(document, document.items[0].id);
    expect(document.entries["attachments_portable/delete.bin"]).toBeUndefined();
    expect(JSON.parse(strFromU8(document.entries["attachments_portable/attachments_portable.json"])).entries).toEqual([]);
  });

  it("imports Android trash arrays as deleted vault items", () => {
    const zip = zipSync({
      "trash/trash_passwords.json": strToU8(JSON.stringify([{ id: 42, title: "Deleted login", username: "joy", password: "secret", website: "https://example.com", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, deletedAt: 1_700_000_002_000, future: true }])),
      "trash/trash_secure_items.json": strToU8(JSON.stringify([{ id: 43, title: "Deleted note", itemType: "NOTE", itemData: JSON.stringify({ content: "body" }), createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, deletedAt: 1_700_000_002_000 }]))
    });
    const document = readAndroidBackup(zip, "webdav");
    expect(document.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "login", title: "Deleted login", deletedAt: "2023-11-14T22:13:22.000Z" }),
      expect.objectContaining({ kind: "secure-note", title: "Deleted note", content: "body", deletedAt: "2023-11-14T22:13:22.000Z" })
    ]));
  });

  it("moves an active Android item to trash and restores it without dropping unknown fields", () => {
    const zip = zipSync({
      "folders/_root/passwords/password_42_0.json": strToU8(JSON.stringify({ id: 42, title: "Login", username: "joy", password: "secret", future: { keep: true }, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000 }))
    });
    const document = readAndroidBackup(zip, "webdav");
    const deleted = { ...document.items[0], deletedAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" } as VaultItem;
    const deletedZip = writeAndroidBackup(document, [deleted], "webdav");
    const deletedEntries = unzipSync(deletedZip);
    expect(deletedEntries["folders/_root/passwords/password_42_0.json"]).toBeUndefined();
    const trash = JSON.parse(strFromU8(deletedEntries["trash/trash_passwords.json"]));
    expect(trash).toEqual([expect.objectContaining({ id: 42, future: { keep: true }, deletedAt: Date.parse(deleted.deletedAt!) })]);

    const trashedDocument = readAndroidBackup(deletedZip, "webdav");
    const restored = { ...trashedDocument.items[0], deletedAt: undefined, updatedAt: "2026-08-24T00:01:00.000Z" } as VaultItem;
    const restoredEntries = unzipSync(writeAndroidBackup(trashedDocument, [restored], "webdav"));
    expect(JSON.parse(strFromU8(restoredEntries["trash/trash_passwords.json"]))).toEqual([]);
    const activePath = Object.keys(restoredEntries).find((path) => /\/passwords\//.test(path))!;
    expect(JSON.parse(strFromU8(restoredEntries[activePath]))).toEqual(expect.objectContaining({ id: 42, future: { keep: true }, isDeleted: false }));
  });
  it("round-trips the checked-in forward-compatible Android fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/android/forward-compatible-record.json", import.meta.url), "utf8")) as {
      path: string;
      record: Record<string, unknown>;
      unknownEntryPath: string;
      unknownEntryBase64: string;
    };
    const recordBytes = strToU8(JSON.stringify(fixture.record));
    const unknownBytes = Uint8Array.from(Buffer.from(fixture.unknownEntryBase64, "base64"));
    const document = readAndroidBackup(zipSync({ [fixture.path]: recordBytes, [fixture.unknownEntryPath]: unknownBytes }), "provider-fixture");

    expect(document.items).toHaveLength(1);
    const output = unzipSync(writeAndroidBackup(document, document.items, "provider-fixture"));
    expect(output[fixture.path]).toEqual(recordBytes);
    expect(output[fixture.unknownEntryPath]).toEqual(unknownBytes);
  });

  it("derives Steam session credentials from Monica Android steamRawJson without flattening them into itemData", () => {
    const path = "folders/_root/authenticators/totp_steam_1700000000000.json";
    const steamRawJson = JSON.stringify({ steamid: "76561198000000000", access_token: "access-token", refresh_token: "refresh-token", steamLoginSecure: "76561198000000000||access-token" });
    const raw = { id: 901, itemType: "TOTP", title: "Steam", itemData: JSON.stringify({ secret: "shared", issuer: "Steam", accountName: "joy", otpType: "STEAM", digits: 5, period: 30, algorithm: "SHA1", steamSharedSecretBase64: "shared", steamIdentitySecret: "identity", steamDeviceId: "android:device", steamRawJson }), notes: "", isFavorite: false, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
    const document = readAndroidBackup(zipSync({ [path]: strToU8(JSON.stringify(raw)) }), "provider-steam");
    expect(document.items[0]).toMatchObject({ kind: "totp", otpType: "STEAM", steamId: "76561198000000000", steamAccessToken: "access-token", steamRefreshToken: "refresh-token", steamLoginSecure: "76561198000000000||access-token" });
    const output = unzipSync(writeAndroidBackup(document, document.items, "provider-steam"));
    expect(JSON.parse(strFromU8(output[path]))).toEqual(raw);
  });

  it("maps all Android vault record kinds and legacy field aliases", () => {
    const document = readAndroidBackup(fixtureZip(), "provider-1");
    expect(document.warnings).toEqual([]);
    expect(document.items.map((item) => item.kind).sort()).toEqual(["billing-address", "card", "identity", "login", "passkey", "payment-account", "secure-note", "totp"]);
    expect(document.items.find((item) => item.kind === "login")).toMatchObject({
      username: "joy@example.com",
      password: "android-secret",
      loginType: "PASSWORD",
      appPackageName: "com.example.app",
      appName: "Example App",
      email: "joy@example.com",
      phone: "+8613800000000",
      passkeyBindings: '[{"credentialId":"bound"}]',
      sshKeyData: '{"private":"encrypted"}',
      wifiMetadata: '{"ssid":"Monica"}',
      customIconType: "UPLOADED",
      customFields: [{ name: "tenant", value: "cn", protected: false }]
    });
    expect(document.items.find((item) => item.kind === "secure-note")).toMatchObject({ content: "# Android note" });
    expect(document.items.find((item) => item.kind === "totp")).toMatchObject({ secret: "TOTPSECRET", algorithm: "SHA256", digits: 8, period: 60 });
    expect(document.items.find((item) => item.kind === "card")).toMatchObject({ number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", securityCode: "123" });
    expect(document.items.find((item) => item.kind === "identity")).toMatchObject({ documentType: "PASSPORT", documentNumber: "P1234567", fullName: "Joy Doe", issuedDate: "2020-01-01", issuedBy: "Example Authority", address: { stateProvince: "CA" } });
    expect(document.items.find((item) => item.kind === "billing-address")).toMatchObject({ fullName: "Joy Doe", company: "Monica", streetAddress: "1 Main St", apartment: "Unit 2", stateProvince: "Shanghai", postalCode: "200000", phone: "10086" });
    expect(document.items.find((item) => item.kind === "payment-account")).toMatchObject({ paymentType: "BANK_ACCOUNT", provider: "Example Bank", accountName: "Daily", accountHolderName: "Joy Doe", username: "joy-bank", accountId: "acct-42", maskedAccountNumber: "****0042", swiftBic: "EXAMPLEBIC", website: "https://bank.example" });
    const passkey = document.items.find((item) => item.kind === "passkey");
    expect(passkey).toMatchObject({ sourceMode: "android-metadata-only" });
    expect(passkey && "privateKeyPkcs8" in passkey).toBe(false);
  });

  it("updates supported records while preserving unknown entries and fields", () => {
    const document = readAndroidBackup(fixtureZip(), "provider-1");
    const items = document.items.map((item) => (item.kind === "login" ? { ...item, password: "updated-secret", updatedAt: "2026-07-15T00:00:00.000Z" } : item));
    const written = writeAndroidBackup(document, items, "provider-1");
    const entries = unzipSync(written);
    expect(entries["future/unknown.bin"]).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(strFromU8(entries["monica_config/future.json"])).toBe('{"must":"survive"}');
    const passwordRaw = JSON.parse(strFromU8(entries["folders/_root/passwords/password_42_1700000000000.json"]));
    expect(passwordRaw).toMatchObject({ password: "updated-secret", futureAndroidField: { preserve: true } });
    const cardRaw = JSON.parse(strFromU8(entries["folders/_root/bank_cards/bank_card_7_1700000000000.json"]));
    expect(JSON.parse(cardRaw.itemData)).toMatchObject({ pin: "9876", futureNestedField: { preserve: true } });
    const passkeyRaw = JSON.parse(strFromU8(entries["folders/_root/passkeys/passkey_cred-id.json"]));
    expect(passkeyRaw.privateKeyAlias).toBe("monica-passkey-key-ref-v1:device-only");
    const noteRaw = JSON.parse(strFromU8(entries["folders/_root/notes/note_8_1700000000000.json"]));
    expect(JSON.parse(noteRaw.itemData)).toMatchObject({ content: "# Android note", tags: ["android"], isMarkdown: true });
    const totpRaw = JSON.parse(strFromU8(entries["folders/_root/authenticators/totp_9_1700000000000.json"]));
    expect(JSON.parse(totpRaw.itemData)).toMatchObject({ otpType: "HOTP", counter: 4 });
    const documentRaw = JSON.parse(strFromU8(entries["folders/_root/documents/document_10_1700000000000.json"]));
    expect(JSON.parse(documentRaw.itemData)).toMatchObject({ passportNumber: "P1234567", issuingAuthority: "Example Authority" });
    expect(readAndroidBackup(written, "provider-1").items.find((item) => item.kind === "login")).toMatchObject({ password: "updated-secret" });
  });

  it("keeps the exact JSON bytes for recognized records that were not changed", () => {
    const originalJson = '{\n  "updatedAt": 1700000001000,\n  "id": 42,\n  "title": "Android Login",\n  "username": "joy@example.com",\n  "password": "android-secret",\n  "website": "https://accounts.example.com",\n  "notes": "fixture",\n  "isFavorite": true,\n  "createdAt": 1700000000000,\n  "categoryName": null,\n  "futureAndroidField": { "preserve": true }\n}\n';
    const path = "folders/_root/passwords/password_42_1700000000000.json";
    const input = zipSync({
      [path]: strToU8(originalJson),
      "images/android-binary.enc": Uint8Array.of(0, 255, 17, 34)
    });

    const document = readAndroidBackup(input, "provider-1");
    const output = unzipSync(writeAndroidBackup(document, document.items, "provider-1"));

    expect(strFromU8(output[path])).toBe(originalJson);
    expect(output["images/android-binary.enc"]).toEqual(Uint8Array.of(0, 255, 17, 34));
  });

  it("patches only changed fields and preserves unrelated Android values and JSON types", () => {
    const originalItemData = '{"authenticatorKey":"LEGACYSECRET","issuer":"GitHub","digits":"8","period":"60","otpType":"HOTP","counter":4,"future":{"nested":[1,true,null]}}';
    const path = "folders/work/authenticators/totp_9_1700000000000.json";
    const raw = {
      id: 9,
      title: "GitHub OTP",
      itemData: originalItemData,
      notes: "keep me",
      isFavorite: false,
      imagePaths: "[\"icon.enc\"]",
      categoryName: "work",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      futureOuter: [1, { keep: true }]
    };
    const document = readAndroidBackup(zipSync({ [path]: strToU8(JSON.stringify(raw)) }), "provider-1");
    const items = document.items.map((item) => ({
      ...item,
      title: "GitHub OTP renamed",
      ...(item.kind === "totp" ? { issuer: "GitLab" } : {}),
      updatedAt: "2026-07-15T02:03:04.000Z"
    }));

    const output = unzipSync(writeAndroidBackup(document, items, "provider-1"));
    const written = JSON.parse(strFromU8(output[path]));

    expect({ ...written, itemData: undefined }).toEqual({
      ...raw,
      itemData: undefined,
      title: "GitHub OTP renamed",
      updatedAt: Date.parse("2026-07-15T02:03:04.000Z")
    });
    expect(JSON.parse(written.itemData)).toEqual({
      authenticatorKey: "LEGACYSECRET",
      issuer: "GitLab",
      digits: "8",
      period: "60",
      otpType: "HOTP",
      counter: 4,
      future: { nested: [1, true, null] }
    });
  });

  it("writes new Passkey metadata with Android's current filename and JSON shape", () => {
    const passkey: PasskeyItem = {
      id: "browser-passkey",
      kind: "passkey",
      title: "Example",
      favorite: false,
      notes: "metadata only",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      providerRefs: [],
      credentialId: "abc/def",
      rpId: "example.com",
      rpName: "Example",
      userHandle: "user-handle",
      userName: "joy",
      userDisplayName: "Joy",
      algorithm: -7,
      publicKey: "public-key",
      privateKeyPkcs8: "must-not-enter-android-backup",
      signCount: 0,
      discoverable: true,
      sourceMode: "browser-local"
    };
    const document = { entries: {}, items: [], records: new Map(), warnings: [] };

    const output = unzipSync(writeAndroidBackup(document, [passkey], "provider-1"));
    const path = "folders/_root/passkeys/passkey_abc_def.json";
    const raw = JSON.parse(strFromU8(output[path]));

    expect(raw).toMatchObject({
      credentialId: "abc/def",
      rpId: "example.com",
      privateKeyAlias: "",
      passkeyMode: "BW_COMPAT"
    });
    expect(raw).not.toHaveProperty("id");
    expect(raw).not.toHaveProperty("title");
    expect(raw).not.toHaveProperty("updatedAt");
    expect(raw).not.toHaveProperty("privateKeyPkcs8");
  });

  it("imports and writes portable ES256 keys only inside an encrypted backup boundary", () => {
    const path = "folders/_root/passkeys/passkey_portable.json";
    const raw = {
      credentialId: "portable", rpId: "example.com", rpName: "Example", userId: "user", userName: "joy", userDisplayName: "Joy",
      publicKeyAlgorithm: -7, publicKey: "public", privateKeyAlias: P256_PKCS8, signCount: 0, isDiscoverable: true, createdAt: 1_700_000_000_000
    };
    const zip = zipSync({ [path]: strToU8(JSON.stringify(raw)) });
    const plain = readAndroidBackup(zip, "plain").items[0];
    expect(plain).toMatchObject({ sourceMode: "android-metadata-only" });
    expect(plain).not.toHaveProperty("privateKeyPkcs8");
    const encrypted = readAndroidBackup(zip, "encrypted", { allowPortablePasskeys: true });
    expect(encrypted.items[0]).toMatchObject({ sourceMode: "browser-local", privateKeyPkcs8: P256_PKCS8 });

    const output = unzipSync(writeAndroidBackup({ entries: {}, items: [], records: new Map(), warnings: [] }, encrypted.items, "encrypted", { allowPortablePasskeys: true }));
    expect(JSON.parse(strFromU8(output[path])).privateKeyAlias).toBe(P256_PKCS8);
  });

  it("round-trips every current Android record shape while preserving Android-only fields", () => {
    const fixture = currentAndroidRecordsFixture();
    const document = readAndroidBackup(fixture.zip, "provider-current");
    expect(document.items).toHaveLength(8);
    expect(document.items.find((item) => item.kind === "totp")).toMatchObject({
      otpType: "HOTP",
      counter: 17,
      steamFingerprint: "fingerprint",
      steamDeviceId: "android:device",
      steamSerialNumber: "serial",
      steamSharedSecretBase64: "shared",
      steamRevocationCode: "R12345",
      steamIdentitySecret: "identity",
      steamTokenGid: "gid",
      steamRawJson: "{\"steam\":true}"
    });
    expect(document.items.find((item) => item.kind === "card")).toMatchObject({ bankName: "Monica Bank", cardType: "CREDIT", nickname: "Daily", iban: "DE89370400440532013000", customFields: [{ name: "limit", value: "10000", fieldType: "TEXT" }] });
    expect(document.items.find((item) => item.kind === "identity")).toMatchObject({ additionalInfo: "info", company: "Monica", ssn: "SSN", passportNumber: "P1234567", licenseNumber: "DL123", address3: "Building A", customFields: [{ name: "visa", value: "valid", fieldType: "HIDDEN" }] });
    expect(document.items.find((item) => item.kind === "billing-address")).toMatchObject({ isDefault: true, customFields: [{ name: "gate", value: "east", fieldType: "TEXT" }] });
    expect(document.items.find((item) => item.kind === "payment-account")).toMatchObject({ linkedCardLast4: "1111", billingAddress: '{"streetAddress":"1 Main St"}', paymentNotes: "payment-only-note", isDefault: true, customFields: [{ name: "branch", value: "001", fieldType: "TEXT" }] });
    expect(document.items.find((item) => item.kind === "secure-note")).toMatchObject({
      tags: ["android", "work"],
      isMarkdown: true,
      customFields: [
        { name: "Recovery code", value: "ABCD", protected: true, fieldType: "HIDDEN" },
        { name: "Pinned", value: "true", protected: false, fieldType: "BOOLEAN" }
      ]
    });
    expect(document.items.find((item) => item.kind === "passkey")).toMatchObject({
      lastUsedAt: new Date(1_700_000_001_000).toISOString(),
      useCount: 9,
      iconUrl: "https://example.com/icon.png",
      userVerificationRequired: true,
      transports: ["internal", "hybrid"],
      aaguid: "00000000-0000-0000-0000-000000000000",
      boundPasswordId: 101,
      passkeyMode: "LEGACY"
    });
    const changed = document.items.map((item) => {
      if (item.kind === "login") return { ...item, password: "new-password" };
      if (item.kind === "totp") return { ...item, issuer: "GitLab" };
      if (item.kind === "card") return { ...item, number: "5555555555554444" };
      if (item.kind === "identity") return { ...item, documentNumber: "P7654321" };
      if (item.kind === "billing-address") return { ...item, city: "Hangzhou" };
      if (item.kind === "payment-account") return { ...item, provider: "New Monica Bank" };
      if (item.kind === "secure-note") return {
        ...item,
        content: "new content",
        customFields: [
          { name: "Recovery code", value: "WXYZ", protected: true, fieldType: "HIDDEN" as const },
          { name: "Pinned", value: "false", protected: false, fieldType: "BOOLEAN" as const }
        ]
      };
      return { ...item, notes: "new passkey note" };
    });
    const output = unzipSync(writeAndroidBackup(document, changed, "provider-current"));
    const written = Object.fromEntries(Object.entries(fixture.paths).map(([key, path]) => [key, JSON.parse(strFromU8(output[path]))]));

    expect(written.password).toEqual({ ...fixture.raws.password, password: "new-password" });
    expect({ ...written.totp, itemData: undefined }).toEqual({ ...fixture.raws.totp, itemData: undefined });
    expect(JSON.parse(written.totp.itemData)).toEqual({ ...fixture.nested.totpData, issuer: "GitLab" });
    expect({ ...written.card, itemData: undefined }).toEqual({ ...fixture.raws.card, itemData: undefined });
    expect(JSON.parse(written.card.itemData)).toEqual({ ...fixture.nested.cardData, cardNumber: "5555555555554444" });
    expect({ ...written.document, itemData: undefined }).toEqual({ ...fixture.raws.document, itemData: undefined });
    expect(JSON.parse(written.document.itemData)).toEqual({ ...fixture.nested.documentData, documentNumber: "P7654321" });
    expect({ ...written.billing, itemData: undefined }).toEqual({ ...fixture.raws.billing, itemData: undefined });
    expect(JSON.parse(written.billing.itemData)).toEqual({ ...fixture.nested.billingData, city: "Hangzhou" });
    expect({ ...written.payment, itemData: undefined }).toEqual({ ...fixture.raws.payment, itemData: undefined });
    expect(JSON.parse(written.payment.itemData)).toEqual({ ...fixture.nested.paymentData, provider: "New Monica Bank" });
    expect({ ...written.note, itemData: undefined }).toEqual({ ...fixture.raws.note, itemData: undefined });
    expect(JSON.parse(written.note.itemData)).toEqual({
      ...fixture.nested.noteData,
      content: "new content",
      customFields: [
        { label: "Recovery code", value: "WXYZ", type: "HIDDEN" },
        { label: "Pinned", value: "false", type: "BOOLEAN" }
      ]
    });
    expect(written.passkey).toEqual({ ...fixture.raws.passkey, notes: "new passkey note", privateKeyAlias: "" });
  });

  it("keeps duplicate Android numeric IDs distinct and preserves malformed future records", () => {
    const firstPath = "folders/A/passwords/password_7_1700000000000.json";
    const secondPath = "folders/B/passwords/password_7_1700000001000.json";
    const malformedPath = "folders/C/passwords/password_future.json";
    const first = '{"id":7,"title":"First","username":"a","password":"one","website":"","notes":"","isFavorite":false,"createdAt":1700000000000,"updatedAt":1700000000000}';
    const second = '{"id":7,"title":"Second","username":"b","password":"two","website":"","notes":"","isFavorite":false,"createdAt":1700000001000,"updatedAt":1700000001000}';
    const malformed = '{"futureFormat":true,"payload":';
    const document = readAndroidBackup(zipSync({
      [firstPath]: strToU8(first),
      [secondPath]: strToU8(second),
      [malformedPath]: strToU8(malformed)
    }), "provider-duplicates");

    expect(document.items).toHaveLength(2);
    expect(new Set(document.items.map((item) => item.id)).size).toBe(2);
    expect(document.warnings).toHaveLength(1);

    const output = unzipSync(writeAndroidBackup(document, document.items, "provider-duplicates"));
    expect(strFromU8(output[firstPath])).toBe(first);
    expect(strFromU8(output[secondPath])).toBe(second);
    expect(strFromU8(output[malformedPath])).toBe(malformed);
  });

  it("detects in-place item edits without mutating the preserved Android baseline", () => {
    const document = readAndroidBackup(fixtureZip(), "provider-in-place");
    const login = document.items.find((item) => item.kind === "login");
    if (!login || login.kind !== "login") throw new Error("Missing login fixture");
    login.password = "in-place-secret";

    const output = unzipSync(writeAndroidBackup(document, document.items, "provider-in-place"));
    const raw = JSON.parse(strFromU8(output["folders/_root/passwords/password_42_1700000000000.json"]));

    expect(raw.password).toBe("in-place-secret");
    expect(raw.futureAndroidField).toEqual({ preserve: true });
  });

  it("uses Monica Android category folder keys for new records", () => {
    expect(androidFolderKey("  工作 / 重要  ")).toBe("工作___重要");
    expect(androidFolderKey("___")).toBe("_root");
    const document = readAndroidBackup(zipSync({ "future/keep.bin": Uint8Array.of(1) }), "provider-category");
    const now = "2026-08-24T00:00:00.000Z";
    const note = {
      id: "new-note", kind: "secure-note", title: "分类笔记", content: "正文", favorite: false, notes: "",
      categoryName: "工作 / 重要", createdAt: now, updatedAt: now, providerRefs: [{ providerId: "provider-category" }]
    } satisfies SecureNoteItem;
    const output = unzipSync(writeAndroidBackup(document, [note], "provider-category"));
    expect(Object.keys(output).some((path) => /^folders\/工作___重要\/notes\/note_[^/]+_1787529600000\.json$/.test(path))).toBe(true);
    expect(JSON.parse(strFromU8(output["categories.json"]))).toEqual([
      { id: expect.any(Number), name: "工作 / 重要", sortOrder: 0 }
    ]);
    expect(output["future/keep.bin"]).toEqual(Uint8Array.of(1));
  });

  it("hydrates Android trash categories from categories.json", () => {
    const categories = [
      { id: 8, name: "工作", sortOrder: 2, futureCategoryField: { keep: true } },
      { id: 9, name: "个人", sortOrder: 4 }
    ];
    const trash = [{
      id: 55,
      itemType: "NOTE",
      title: "已删除笔记",
      itemData: JSON.stringify({ content: "正文" }),
      categoryId: 8,
      deletedAt: 1_700_000_100_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_050_000
    }];
    const document = readAndroidBackup(zipSync({
      "categories.json": strToU8(JSON.stringify(categories)),
      "trash/trash_secure_items.json": strToU8(JSON.stringify(trash))
    }), "provider-trash-category");

    expect(document.items[0]).toMatchObject({ categoryId: 8, categoryName: "工作", deletedAt: new Date(1_700_000_100_000).toISOString() });
    const output = unzipSync(writeAndroidBackup(document, document.items, "provider-trash-category"));
    expect(output["categories.json"]).toEqual(strToU8(JSON.stringify(categories)));
  });

  it("appends new Android categories without rewriting existing category objects", () => {
    const originalCategories = [
      { id: 8, name: "Work", sortOrder: 7, color: "future-color", future: { keep: true } },
      { id: 21, name: "Archive", sortOrder: 11 }
    ];
    const fixture = currentAndroidRecordsFixture();
    const archive = unzipSync(fixture.zip);
    archive["categories.json"] = strToU8(JSON.stringify(originalCategories));
    const document = readAndroidBackup(zipSync(archive), "provider-new-category");
    const changed = document.items.map((item) => item.kind === "login" ? { ...item, categoryName: "Personal", categoryId: 8 } : item);

    const output = unzipSync(writeAndroidBackup(document, changed, "provider-new-category"));
    const categories = JSON.parse(strFromU8(output["categories.json"]));
    expect(categories.slice(0, 2)).toEqual(originalCategories);
    expect(categories[2]).toEqual({ id: 22, name: "Personal", sortOrder: 12 });
    const movedPath = fixture.paths.password.replace("folders/Work/", "folders/Personal/");
    expect(JSON.parse(strFromU8(output[movedPath]))).toMatchObject({ categoryId: 22, categoryName: "Personal" });
  });

  it("does not overwrite a malformed category manifest", () => {
    const malformed = strToU8('{"future":true');
    const document = readAndroidBackup(zipSync({
      "categories.json": malformed,
      "folders/_root/passwords/password_1_0.json": strToU8(JSON.stringify({ id: 1, title: "Login", createdAt: 1, updatedAt: 1 }))
    }), "provider-malformed-category");
    expect(document.warnings.join(" ")).toContain("categories.json");

    expect(() => writeAndroidBackup(document, [{ ...document.items[0], categoryName: "New" }], "provider-malformed-category"))
      .toThrow(/categories\.json 无法安全更新/);
    const unchanged = unzipSync(writeAndroidBackup(document, document.items, "provider-malformed-category"));
    expect(unchanged["categories.json"]).toEqual(malformed);
  });

  it("moves an edited record between Android category folders without duplicating it", () => {
    const fixture = currentAndroidRecordsFixture();
    const document = readAndroidBackup(fixture.zip, "provider-category-move");
    const changed = document.items.map((item) => item.kind === "login" ? { ...item, categoryName: "Personal Vault" } : item);
    const output = unzipSync(writeAndroidBackup(document, changed, "provider-category-move"));
    const oldPath = fixture.paths.password;
    const newPath = oldPath.replace("folders/Work/", "folders/Personal_Vault/");
    expect(output[oldPath]).toBeUndefined();
    expect(output[newPath]).toBeDefined();
    expect(JSON.parse(strFromU8(output[newPath]))).toMatchObject({ categoryName: "Personal Vault", password: "old-password" });
  });

  it("reads Android password history and appends the previous password on change", () => {
    const loginPath = "folders/_root/passwords/password_42_1700000000000.json";
    const loginRaw = { id: 42, title: "Account", username: "joy", password: "current", website: "https://example.com", notes: "", isFavorite: false, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000 };
    const historyRaw = [
      { entryId: 42, password: "older", lastUsedAt: 1_699_000_000_000, future: { keep: true } },
      { entryId: 999, password: "unmatched", lastUsedAt: 1_698_000_000_000, unknownOwner: true }
    ];
    const originalHistoryBytes = strToU8(JSON.stringify(historyRaw));
    const document = readAndroidBackup(zipSync({ [loginPath]: strToU8(JSON.stringify(loginRaw)), "password_history.json": originalHistoryBytes }), "provider-history");
    const login = document.items[0];
    expect(login).toMatchObject({ kind: "login", passwordHistory: [{ password: "older", lastUsedAt: new Date(1_699_000_000_000).toISOString() }] });
    const unchanged = unzipSync(writeAndroidBackup(document, document.items, "provider-history"));
    expect(unchanged["password_history.json"]).toEqual(originalHistoryBytes);

    const changed = document.items.map((item) => item.kind === "login" ? { ...item, password: "new-password", updatedAt: "2026-08-24T00:00:00.000Z" } : item);
    const output = unzipSync(writeAndroidBackup(document, changed, "provider-history"));
    const history = JSON.parse(strFromU8(output["password_history.json"])) as Array<Record<string, unknown>>;
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: 42, password: "older", future: { keep: true } }),
      expect.objectContaining({ entryId: 42, password: "current", lastUsedAt: 1_700_000_001_000 }),
      expect.objectContaining({ entryId: 999, password: "unmatched", unknownOwner: true })
    ]));
  });

  it("reads Android timeline summaries without exposing change values", () => {
    const timeline = [{
      id: 7,
      itemType: "PASSWORD",
      itemId: 42,
      itemTitle: "PASSWORD#42",
      operationType: "UPDATE",
      changesJson: JSON.stringify([{ fieldName: "密码", oldValue: "old-secret", newValue: "new-secret" }]),
      deviceId: "private-device-id",
      deviceName: "Android Phone",
      timestamp: 1_700_000_002_000,
      isReverted: true,
      future: { keep: true }
    }];
    const document = readAndroidBackup(zipSync({ "timeline_history.json": strToU8(JSON.stringify(timeline)) }), "provider-timeline");
    const summaries = listAndroidTimeline(document);

    expect(summaries).toEqual([{ id: "7", itemType: "PASSWORD", itemId: 42, itemTitle: "PASSWORD#42", operationType: "UPDATE", deviceName: "Android Phone", timestamp: 1_700_000_002_000, reverted: true, changedFields: ["密码"] }]);
    expect(JSON.stringify(summaries)).not.toContain("secret");
    expect(JSON.stringify(summaries)).not.toContain("private-device-id");
    const output = unzipSync(writeAndroidBackup(document, [], "provider-timeline"));
    expect(output["timeline_history.json"]).toEqual(strToU8(JSON.stringify(timeline)));
  });

  it("reads Android generator history and preserves unchanged bytes", () => {
    const path = "Monica_20260824_120000_generated_history.json";
    const history = [
      { password: "generated-secret", timestamp: 1_700_000_003_000, packageName: "com.example.app", domain: "example.com", username: "joy", type: "AUTOFILL", future: { keep: true } },
      { password: "246810", timestamp: 1_700_000_002_000, type: "PIN" }
    ];
    const bytes = strToU8(JSON.stringify(history));
    const document = readAndroidBackup(zipSync({ [path]: bytes }), "provider-generator-history");

    expect(listAndroidGeneratorHistory(document)).toEqual([
      { id: `${path}:0:1700000003000`, password: "generated-secret", timestamp: 1_700_000_003_000, packageName: "com.example.app", domain: "example.com", username: "joy", type: "AUTOFILL" },
      { id: `${path}:1:1700000002000`, password: "246810", timestamp: 1_700_000_002_000, packageName: "", domain: "", username: "", type: "PIN" }
    ]);
    const output = unzipSync(writeAndroidBackup(document, [], "provider-generator-history"));
    expect(output[path]).toEqual(bytes);
  });

  it("deletes one Android generator history entry without normalizing retained fields", () => {
    const path = "Monica_20260824_120000_generated_history.json";
    const history = [
      { password: "remove-me", timestamp: 1_700_000_003_000, type: "SYMBOL" },
      { password: "keep-me", timestamp: 1_700_000_002_000, type: "PASSWORD", packageName: null, future: ["unchanged"] }
    ];
    const document = readAndroidBackup(zipSync({ [path]: strToU8(JSON.stringify(history)) }), "provider-generator-delete");

    expect(deleteAndroidGeneratorHistoryEntry(document, `${path}:0:1700000003000`)).toBe(true);
    expect(deleteAndroidGeneratorHistoryEntry(document, "missing")).toBe(false);
    const output = unzipSync(writeAndroidBackup(document, [], "provider-generator-delete"));
    expect(JSON.parse(strFromU8(output[path]))).toEqual([history[1]]);
  });

  it("preserves malformed Android generator history and refuses to edit it", () => {
    const path = "Monica_20260824_120000_generated_history.json";
    const bytes = strToU8('{"future":true');
    const document = readAndroidBackup(zipSync({ [path]: bytes }), "provider-generator-malformed");

    expect(document.warnings.join(" ")).toContain("generated_history.json");
    expect(listAndroidGeneratorHistory(document)).toEqual([]);
    expect(deleteAndroidGeneratorHistoryEntry(document, `${path}:0:1`)).toBe(false);
    const output = unzipSync(writeAndroidBackup(document, [], "provider-generator-malformed"));
    expect(output[path]).toEqual(bytes);
  });

  it("preserves oversized Android generator history without exposing it", () => {
    const path = "Monica_20260824_120000_generated_history.json";
    const bytes = strToU8(JSON.stringify(Array.from({ length: 1_001 }, () => null)));
    const document = readAndroidBackup(zipSync({ [path]: bytes }, { level: 0 }), "provider-generator-oversized");

    expect(document.warnings.join(" ")).toContain("过大");
    expect(listAndroidGeneratorHistory(document)).toEqual([]);
    expect(document.entries[path]).toEqual(bytes);
    expect(unzipSync(writeAndroidBackup(document, [], "provider-generator-oversized"))[path]).toEqual(bytes);
  });

  it("round-trips edited Android Wi-Fi SSH and barcode records without losing future fields", () => {
    const base = { username: "", website: "", notes: "", isFavorite: false, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, future: { keep: true } };
    const wifiPath = "folders/_root/passwords/password_1_1700000000000.json";
    const sshPath = "folders/_root/passwords/password_2_1700000000000.json";
    const barcodePath = "folders/_root/passwords/password_3_1700000000000.json";
    const document = readAndroidBackup(zipSync({
      [wifiPath]: strToU8(JSON.stringify({ ...base, id: 1, title: "Lab Wi-Fi", password: "wifi-secret", loginType: "WIFI", wifiMetadata: '{"ssid":"Lab","security":"WPA3","futureWifi":7}' })),
      [sshPath]: strToU8(JSON.stringify({ ...base, id: 2, title: "SSH", password: "", loginType: "SSH_KEY", sshKeyData: '{"algorithm":"ED25519","publicKeyOpenSsh":"ssh-ed25519 AAAA","privateKeyOpenSsh":"PRIVATE","fingerprintSha256":"SHA256:x","futureSsh":8}' })),
      [barcodePath]: strToU8(JSON.stringify({ ...base, id: 3, title: "Member", password: "OLD-CODE", loginType: "BARCODE" }))
    }), "provider-special-roundtrip");

    const changed = document.items.map((item) => {
      if (item.kind !== "login") return item;
      if (item.loginType === "WIFI") return { ...item, wifiMetadata: '{"ssid":"Lab","security":"WPA3","hiddenNetwork":true,"futureWifi":7}' };
      if (item.loginType === "SSH_KEY") return { ...item, sshKeyData: '{"algorithm":"ED25519","publicKeyOpenSsh":"ssh-ed25519 AAAA","privateKeyOpenSsh":"PRIVATE","fingerprintSha256":"SHA256:x","comment":"edited","futureSsh":8}' };
      if (item.loginType === "BARCODE") return { ...item, password: "NEW-CODE" };
      return item;
    });
    const output = unzipSync(writeAndroidBackup(document, changed, "provider-special-roundtrip"));

    expect(JSON.parse(strFromU8(output[wifiPath]))).toMatchObject({ loginType: "WIFI", password: "wifi-secret", future: { keep: true }, wifiMetadata: expect.stringContaining('"futureWifi":7') });
    expect(JSON.parse(strFromU8(output[sshPath]))).toMatchObject({ loginType: "SSH_KEY", future: { keep: true }, sshKeyData: expect.stringContaining('"futureSsh":8') });
    expect(JSON.parse(strFromU8(output[barcodePath]))).toMatchObject({ loginType: "BARCODE", password: "NEW-CODE", future: { keep: true } });
  });
});
