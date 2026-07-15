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
      cardNumber: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2030",
      cvv: "123",
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
  return zipSync({
    "folders/_root/passwords/password_42_1700000000000.json": strToU8(JSON.stringify(password)),
    "folders/_root/bank_cards/bank_card_7_1700000000000.json": strToU8(JSON.stringify(card)),
    "folders/_root/passkeys/passkey_cred-id.json": strToU8(JSON.stringify(passkey)),
    "future/unknown.bin": Uint8Array.of(1, 2, 3, 4),
    "monica_config/future.json": strToU8('{"must":"survive"}')
  });
}

describe("Android backup ZIP codec", () => {
  it("maps Android login card and metadata-only passkey records", () => {
    const document = readAndroidBackup(fixtureZip(), "provider-1");
    expect(document.warnings).toEqual([]);
    expect(document.items.map((item) => item.kind)).toEqual(["login", "card", "passkey"]);
    expect(document.items.find((item) => item.kind === "login")).toMatchObject({ username: "joy@example.com", password: "android-secret" });
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
    expect(readAndroidBackup(written, "provider-1").items.find((item) => item.kind === "login")).toMatchObject({ password: "updated-secret" });
  });
});
