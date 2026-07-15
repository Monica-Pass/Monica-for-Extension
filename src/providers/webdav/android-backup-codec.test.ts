import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
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

describe("Android backup ZIP codec", () => {
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
});
