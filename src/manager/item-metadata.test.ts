import { describe, expect, it } from "vitest";
import type { VaultItem } from "../core/model";
import { itemIcon, itemKindLabel, itemSafeSummary, itemSearchText, itemSection } from "./item-metadata";

const now = "2026-07-15T00:00:00.000Z";
const base = { id: "id", title: "Title", favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [] };
const items: VaultItem[] = [
  { ...base, kind: "login", username: "joy", password: "secret", uris: ["example.com"], customFields: [] },
  { ...base, kind: "card", cardholderName: "Joy", number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", securityCode: "123", brand: "Visa" },
  { ...base, kind: "identity", documentType: "PASSPORT", documentNumber: "P12345678", firstName: "Joy", middleName: "", lastName: "Lin", fullName: "Joy Lin" },
  { ...base, kind: "billing-address", fullName: "Joy Lin", company: "Monica", streetAddress: "Road", apartment: "", city: "Shanghai", stateProvince: "Shanghai", postalCode: "200000", country: "China", phone: "1", email: "joy@example.com" },
  { ...base, kind: "payment-account", paymentType: "BANK", provider: "Bank", accountName: "Main", accountHolderName: "Joy", email: "", phone: "", username: "", accountId: "", maskedAccountNumber: "****7890", routingNumber: "", iban: "DE89", swiftBic: "", website: "", currency: "EUR" },
  { ...base, kind: "secure-note", content: "private note" },
  { ...base, kind: "totp", secret: "JBSWY3DPEHPK3PXP", issuer: "Example", accountName: "joy", algorithm: "SHA1", digits: 6, period: 30 },
  { ...base, kind: "passkey", credentialId: "credential", rpId: "example.com", rpName: "Example", userHandle: "user", userName: "joy", userDisplayName: "Joy", algorithm: -7, publicKey: "public", signCount: 0, discoverable: true, sourceMode: "browser-local" }
];

describe("manager item metadata", () => {
  it("maps every vault kind to a usable category label and icon", () => {
    expect(items.map((item) => itemSection(item))).toEqual(["passwords", "wallet", "wallet", "wallet", "wallet", "notes", "notes", "passkeys"]);
    for (const item of items) { expect(itemKindLabel(item.kind)).not.toBe(""); expect(itemIcon(item.kind)).not.toBe(""); }
  });

  it("masks card and document numbers in summaries", () => {
    expect(itemSafeSummary(items[1])).toContain("•••• 1111");
    expect(itemSafeSummary(items[1])).not.toContain("4111111111111111");
    expect(itemSafeSummary(items[2])).toContain("•••• 5678");
  });

  it("provides searchable text without login or card secrets", () => {
    expect(itemSearchText(items[0])).toContain("example.com");
    expect(itemSearchText(items[0])).not.toContain("secret");
    expect(itemSearchText(items[1])).not.toContain("4111111111111111");
    expect(itemSafeSummary(items[5])).not.toContain("private note");
    expect(itemSafeSummary(items[4])).not.toContain("****7890");
    expect(itemSafeSummary(items[4])).toContain("•••• 7890");
  });
});
