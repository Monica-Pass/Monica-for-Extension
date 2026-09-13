import { createEmptyVaultState, type VaultItem } from "../../../src/core/model";
import { deriveVaultKey, encryptVaultState } from "../../../src/security/vault-crypto";
import type { EncryptedVaultBackup } from "../../../src/security/secure-vault-service";

export const homePassword = "Synthetic home layout master password";
const now = "2026-09-01T08:00:00.000Z";
const base = { favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], categoryId: 7, categoryName: "Accounts" };
const local = [{ providerId: "home-local-source" }];
const work = [{ providerId: "work-db", remoteId: "synthetic-work-item" }];
const personal = [{ providerId: "personal-db", remoteId: "synthetic-personal-item" }];
const login = { ...base, kind: "login" as const, username: "design@example.test", password: "private-password-sentinel", uris: ["https://accounts.example.test", "otpauth://totp/test?secret=private-uri-secret-sentinel"], customFields: [] };
export const homeItems: VaultItem[] = [
  { ...login, id: "home-login-local", title: "Proton Mail", providerRefs: local, favorite: true, boundTotpItemId: "home-otp" },
  { ...login, id: "home-login-work", title: "GitHub · Monica Studio", providerRefs: work },
  { ...login, id: "home-login-personal", title: "Figma · Personal", providerRefs: personal },
  { ...base, id: "home-card", kind: "card", title: "Everyday Visa", favorite: true, providerRefs: local, categoryId: 8, categoryName: "Everyday", cardholderName: "MONICA DESIGN", number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", securityCode: "937", brand: "Visa" },
  { ...base, id: "home-identity", kind: "identity", title: "Travel passport", providerRefs: work, categoryId: 3, categoryName: "Travel", documentType: "PASSPORT", documentNumber: "SYNTHETIC9876", fullName: "MONICA DESIGN", firstName: "MONICA", middleName: "", lastName: "DESIGN", nationality: "Example", birthDate: "1990-01-01", issuedDate: "2025-01-01", expiryDate: "2035-01-01", issuedBy: "Example authority" },
  { ...base, id: "home-address", kind: "billing-address", title: "Studio billing", providerRefs: personal, categoryId: 5, categoryName: "Home", fullName: "Monica Design", company: "Studio", streetAddress: "128 Example Avenue", apartment: "801", city: "Example City", stateProvince: "Example", postalCode: "100000", country: "Example", phone: "", email: "billing@example.test", isDefault: false },
  { ...base, id: "home-payment", kind: "payment-account", title: "Wise · Travel", providerRefs: personal, categoryId: 3, categoryName: "Travel", paymentType: "BANK", provider: "Example bank", accountName: "Travel", accountHolderName: "MONICA DESIGN", username: "monica", email: "billing@example.test", phone: "", accountId: "synthetic-account", maskedAccountNumber: "**** 4321", routingNumber: "", iban: "", swiftBic: "", website: "", currency: "EUR", paymentNotes: "" },
  { ...base, id: "home-note", kind: "secure-note", title: "Recovery notes", favorite: true, providerRefs: work, categoryId: 4, categoryName: "Projects", content: "private-note-content-sentinel", tags: ["work"] },
  { ...base, id: "home-otp", kind: "totp", title: "Studio authenticator", providerRefs: local, secret: "JBSWY3DPEHPK3PXP", issuer: "Studio", accountName: "design@example.test", digits: 6, period: 30, algorithm: "SHA1", otpType: "TOTP" },
  { ...base, id: "home-passkey", kind: "passkey", title: "Notion Passkey", providerRefs: work, categoryId: 4, categoryName: "Projects", credentialId: "c3ludGhldGlj", rpId: "passkey.example.test", rpName: "Studio", userHandle: "dXNlcg", userName: "design@example.test", algorithm: -7, publicKey: "", signCount: 0, discoverable: true, sourceMode: "android-metadata-only" },
  { ...login, id: "home-archived", title: "Previous workspace", providerRefs: work, archivedAt: now },
  { ...login, id: "home-deleted", title: "Retired account", providerRefs: personal, deletedAt: now }
];

let backup: Promise<EncryptedVaultBackup> | undefined;
export function homeBackup(syncIssue = false): Promise<EncryptedVaultBackup> {
  if (!syncIssue && backup) return backup;
  const created = (async () => {
    const state = createEmptyVaultState(now);
    state.providers[0].id = "home-local-source";
    state.settings.defaultProviderId = "home-local-source";
    state.providers.push(
      { id: "work-db", kind: "monica-webdav", name: "Monica Studio", enabled: false, isDefaultSaveTarget: false, config: {} },
      { id: "personal-db", kind: "monica-webdav", name: "Personal", enabled: false, isDefaultSaveTarget: false, config: {} },
      { id: "empty-db", kind: "bitwarden", name: "New workspace", enabled: false, isDefaultSaveTarget: false, config: {} }
    );
    if (syncIssue) {
      state.providers[1].lastError = "https://private-error-user:private-error-secret@example.test?token=private-error-token";
      state.providers[1].lastSyncAt = "2026-09-12T08:30:00.000Z";
    }
    state.items = homeItems;
    const { key, kdf } = await deriveVaultKey(homePassword);
    return { magic: "MONICA_EXTENSION_BACKUP", version: 1, exportedAt: now, envelope: await encryptVaultState(state, key, kdf) };
  })();
  if (!syncIssue) backup = created;
  return created;
}
