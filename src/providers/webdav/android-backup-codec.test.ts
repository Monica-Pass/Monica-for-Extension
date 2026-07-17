import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { PasskeyItem } from "../../core/model";
import { readAndroidBackup, writeAndroidBackup } from "./android-backup-codec";

function fixtureZip() {
  const password = {
    id: 42,
    title: "Android Login",
    username: "joy@example.com",
    password: "android-secret",
    website: "https://accounts.example.com",
    notes: "fixture",
    isFavorite: true,
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
  const noteData = { content: "old content", tags: ["android", "work"], isMarkdown: true };
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
    expect(document.items.find((item) => item.kind === "login")).toMatchObject({ username: "joy@example.com", password: "android-secret" });
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
      passkeyMode: "LEGACY"
    });
    expect(raw).not.toHaveProperty("id");
    expect(raw).not.toHaveProperty("title");
    expect(raw).not.toHaveProperty("updatedAt");
    expect(raw).not.toHaveProperty("privateKeyPkcs8");
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
    const changed = document.items.map((item) => {
      if (item.kind === "login") return { ...item, password: "new-password" };
      if (item.kind === "totp") return { ...item, issuer: "GitLab" };
      if (item.kind === "card") return { ...item, number: "5555555555554444" };
      if (item.kind === "identity") return { ...item, documentNumber: "P7654321" };
      if (item.kind === "billing-address") return { ...item, city: "Hangzhou" };
      if (item.kind === "payment-account") return { ...item, provider: "New Monica Bank" };
      if (item.kind === "secure-note") return { ...item, content: "new content" };
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
    expect(JSON.parse(written.note.itemData)).toEqual({ ...fixture.nested.noteData, content: "new content" });
    expect(written.passkey).toEqual({ ...fixture.raws.passkey, notes: "new passkey note" });
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
});
