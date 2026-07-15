import type { CardItem, IdentityItem, LoginItem, PasskeyItem, ProviderReference, SecureNoteItem, VaultItem } from "../../core/model";
import { decryptBitwardenString, decryptBitwardenSymmetricKey, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";

export interface DecodedBitwardenCipher {
  items: VaultItem[];
  warning?: string;
}

export async function decodeBitwardenCipher(raw: Record<string, unknown>, providerId: string, vaultKey: BitwardenSymmetricKey): Promise<DecodedBitwardenCipher> {
  const cipherId = stringValue(raw, "Id", "id");
  if (!cipherId) return { items: [], warning: "Bitwarden Cipher 缺少 ID，已跳过。" };
  const key = await resolveBitwardenCipherKey(raw, vaultKey);
  const type = numberValue(raw, "Type", "type");
  const revision = dateValue(value(raw, "RevisionDate", "revisionDate"));
  const createdAt = dateValue(value(raw, "CreationDate", "creationDate"), revision);
  const name = await decryptBitwardenString(stringValue(raw, "Name", "name"), key);
  const notes = await decryptBitwardenString(stringValue(raw, "Notes", "notes"), key);
  const favorite = booleanValue(raw, "Favorite", "favorite");
  const reference: ProviderReference = { providerId, remoteId: cipherId, remoteFolderId: stringValue(raw, "FolderId", "folderId") || undefined, revision };
  const base = { id: `bitwarden:${providerId}:${cipherId}`, title: name || "未命名 Bitwarden 项目", favorite, notes, createdAt, updatedAt: revision, providerRefs: [reference] };

  if (type === 1) {
    const login = recordValue(raw, "Login", "login") || {};
    const username = await decryptBitwardenString(stringValue(login, "Username", "username"), key);
    const password = await decryptBitwardenString(stringValue(login, "Password", "password"), key);
    const totpSecret = await decryptBitwardenString(stringValue(login, "Totp", "totp"), key);
    const uris = await Promise.all(arrayValue(login, "Uris", "uris").map(async (entry) => decryptBitwardenString(stringValue(record(entry), "Uri", "uri"), key)));
    const customFields = await Promise.all(arrayValue(raw, "Fields", "fields").map(async (entry) => {
      const field = record(entry);
      return {
        name: await decryptBitwardenString(stringValue(field, "Name", "name"), key),
        value: await decryptBitwardenString(stringValue(field, "Value", "value"), key),
        protected: numberValue(field, "Type", "type") === 1
      };
    }));
    const loginItem: LoginItem = {
      ...base,
      kind: "login",
      username,
      password,
      uris: [...new Set(uris.filter(Boolean))],
      totpSecret: totpSecret || undefined,
      customFields
    };
    const passkeys = await decodeFido2Credentials(login, base, reference, key);
    return { items: [loginItem, ...passkeys] };
  }

  if (type === 2) {
    return { items: [{ ...base, kind: "secure-note", content: notes } satisfies SecureNoteItem] };
  }

  if (type === 3) {
    const card = recordValue(raw, "Card", "card") || {};
    const [cardholderName, number, expiryMonth, expiryYear, securityCode, brand] = await Promise.all([
      decryptField(card, key, "CardholderName", "cardholderName"),
      decryptField(card, key, "Number", "number"),
      decryptField(card, key, "ExpMonth", "expMonth"),
      decryptField(card, key, "ExpYear", "expYear"),
      decryptField(card, key, "Code", "code"),
      decryptField(card, key, "Brand", "brand")
    ]);
    return { items: [{ ...base, kind: "card", cardholderName, number, expiryMonth, expiryYear, securityCode, brand: brand || undefined } satisfies CardItem] };
  }

  if (type === 4) {
    const identity = recordValue(raw, "Identity", "identity") || {};
    const fields = await decryptRecordFields(identity, key, [
      "Title", "FirstName", "MiddleName", "LastName", "Address1", "Address2", "City", "State", "PostalCode", "Country", "Company", "Email", "Phone", "Ssn", "PassportNumber", "LicenseNumber"
    ]);
    const fullName = [fields.Title, fields.FirstName, fields.MiddleName, fields.LastName].filter(Boolean).join(" ");
    const documentType: IdentityItem["documentType"] = fields.PassportNumber ? "PASSPORT" : fields.LicenseNumber ? "DRIVER_LICENSE" : fields.Ssn ? "SOCIAL_SECURITY" : "OTHER";
    return {
      items: [{
        ...base,
        kind: "identity",
        documentType,
        documentNumber: fields.PassportNumber || fields.LicenseNumber || fields.Ssn,
        firstName: fields.FirstName,
        middleName: fields.MiddleName,
        lastName: fields.LastName,
        fullName,
        email: fields.Email || undefined,
        phone: fields.Phone || undefined,
        address: { streetAddress: fields.Address1, apartment: fields.Address2, city: fields.City, stateProvince: fields.State, postalCode: fields.PostalCode, country: fields.Country }
      } satisfies IdentityItem]
    };
  }

  return { items: [], warning: `Bitwarden Cipher ${cipherId} 的类型 ${type} 暂不支持。` };
}

export async function resolveBitwardenCipherKey(raw: Record<string, unknown>, vaultKey: BitwardenSymmetricKey): Promise<BitwardenSymmetricKey> {
  const keyCipher = stringValue(raw, "Key", "key");
  return keyCipher ? decryptBitwardenSymmetricKey(keyCipher, vaultKey) : vaultKey;
}

export async function encodeBitwardenCipher(item: VaultItem, encryptionKey: BitwardenSymmetricKey, preservedRaw?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    type: bitwardenType(item),
    name: await encryptBitwardenString(item.title, encryptionKey),
    notes: item.notes ? await encryptBitwardenString(item.notes, encryptionKey) : null,
    favorite: item.favorite,
    reprompt: 0,
    key: stringValue(preservedRaw || {}, "Key", "key") || null,
    organizationId: value(preservedRaw || {}, "OrganizationId", "organizationId") ?? null,
    collectionIds: value(preservedRaw || {}, "CollectionIds", "collectionIds") ?? null,
    folderId: item.providerRefs.find((reference) => reference.remoteFolderId)?.remoteFolderId || null,
    fields: null
  };

  if (item.kind === "login") {
    const preservedLogin = recordValue(preservedRaw || {}, "Login", "login") || {};
    base.login = {
      username: await encryptOptional(item.username, encryptionKey),
      password: await encryptOptional(item.password, encryptionKey),
      totp: await encryptOptional(item.totpSecret || "", encryptionKey),
      uris: await Promise.all(item.uris.map(async (uri) => ({ uri: await encryptBitwardenString(uri, encryptionKey), match: null }))),
      fido2Credentials: value(preservedLogin, "Fido2Credentials", "fido2Credentials") || null
    };
    base.fields = await Promise.all(item.customFields.map(async (field) => ({
      type: field.protected ? 1 : 0,
      name: await encryptOptional(field.name, encryptionKey),
      value: await encryptOptional(field.value, encryptionKey),
      linkedId: null
    })));
  } else if (item.kind === "card") {
    base.card = {
      cardholderName: await encryptOptional(item.cardholderName, encryptionKey),
      number: await encryptOptional(item.number, encryptionKey),
      expMonth: await encryptOptional(item.expiryMonth, encryptionKey),
      expYear: await encryptOptional(item.expiryYear, encryptionKey),
      code: await encryptOptional(item.securityCode, encryptionKey),
      brand: await encryptOptional(item.brand || "", encryptionKey)
    };
  } else if (item.kind === "identity") {
    base.identity = {
      title: null,
      firstName: await encryptOptional(item.firstName, encryptionKey),
      middleName: await encryptOptional(item.middleName, encryptionKey),
      lastName: await encryptOptional(item.lastName, encryptionKey),
      address1: await encryptOptional(item.address?.streetAddress || "", encryptionKey),
      address2: await encryptOptional(item.address?.apartment || "", encryptionKey),
      address3: null,
      city: await encryptOptional(item.address?.city || "", encryptionKey),
      state: await encryptOptional(item.address?.stateProvince || "", encryptionKey),
      postalCode: await encryptOptional(item.address?.postalCode || "", encryptionKey),
      country: await encryptOptional(item.address?.country || "", encryptionKey),
      company: null,
      email: await encryptOptional(item.email || "", encryptionKey),
      phone: await encryptOptional(item.phone || "", encryptionKey),
      ssn: item.documentType === "SOCIAL_SECURITY" ? await encryptOptional(item.documentNumber, encryptionKey) : null,
      passportNumber: item.documentType === "PASSPORT" ? await encryptOptional(item.documentNumber, encryptionKey) : null,
      licenseNumber: item.documentType === "DRIVER_LICENSE" ? await encryptOptional(item.documentNumber, encryptionKey) : null
    };
  } else if (item.kind === "secure-note") {
    base.notes = await encryptOptional(item.content, encryptionKey);
    base.secureNote = { type: 0 };
  }
  return base;
}

export async function encodeBitwardenPasskeyCipher(
  item: PasskeyItem,
  encryptionKey: BitwardenSymmetricKey,
  preservedRaw?: Record<string, unknown>,
  operation: "upsert" | "delete" = "upsert"
): Promise<Record<string, unknown>> {
  if (item.algorithm !== -7) throw new Error("当前只能把 ES256 Passkey 保存到 Bitwarden。");
  if (operation === "upsert" && !item.privateKeyPkcs8) throw new Error("Bitwarden Passkey 缺少可同步的 PKCS#8 私钥。");
  if (preservedRaw && numberValue(preservedRaw, "Type", "type") !== 1) throw new Error("Bitwarden Passkey 的父项目不是登录 Cipher。");

  const preservedLogin = recordValue(preservedRaw || {}, "Login", "login") || {};
  const existingCredentials = arrayValue(preservedLogin, "Fido2Credentials", "fido2Credentials").map(record);
  const matched = await Promise.all(existingCredentials.map(async (credential) => ({
    credential,
    credentialId: await decryptBitwardenString(stringValue(credential, "CredentialId", "credentialId"), encryptionKey)
  })));
  const replacement = operation === "upsert" ? await encodeFido2Credential(item, encryptionKey, matched.find((entry) => entry.credentialId === item.credentialId)?.credential) : undefined;
  const fido2Credentials = matched.flatMap((entry) => entry.credentialId === item.credentialId ? (replacement ? [replacement] : []) : [entry.credential]);
  if (replacement && !matched.some((entry) => entry.credentialId === item.credentialId)) fido2Credentials.push(replacement);

  if (!preservedRaw) {
    return {
      type: 1,
      name: await encryptBitwardenString(item.title, encryptionKey),
      notes: await encryptOptional(item.notes, encryptionKey),
      favorite: item.favorite,
      reprompt: 0,
      key: null,
      folderId: item.providerRefs.find((reference) => reference.remoteFolderId)?.remoteFolderId || null,
      fields: null,
      login: {
        username: await encryptOptional(item.userName, encryptionKey),
        password: null,
        totp: null,
        uris: [{ uri: await encryptBitwardenString(`https://${item.rpId}`, encryptionKey), match: null }],
        fido2Credentials
      }
    };
  }

  return {
    type: 1,
    name: value(preservedRaw, "Name", "name") || await encryptBitwardenString(item.title, encryptionKey),
    notes: value(preservedRaw, "Notes", "notes") ?? null,
    favorite: value(preservedRaw, "Favorite", "favorite") === true,
    reprompt: numberValue(preservedRaw, "Reprompt", "reprompt"),
    key: value(preservedRaw, "Key", "key") ?? null,
    organizationId: value(preservedRaw, "OrganizationId", "organizationId") ?? null,
    collectionIds: value(preservedRaw, "CollectionIds", "collectionIds") ?? null,
    folderId: value(preservedRaw, "FolderId", "folderId") ?? null,
    fields: value(preservedRaw, "Fields", "fields") ?? null,
    login: {
      username: value(preservedLogin, "Username", "username") ?? null,
      password: value(preservedLogin, "Password", "password") ?? null,
      totp: value(preservedLogin, "Totp", "totp") ?? null,
      uris: value(preservedLogin, "Uris", "uris") ?? [],
      passwordRevisionDate: value(preservedLogin, "PasswordRevisionDate", "passwordRevisionDate") ?? null,
      autofillOnPageLoad: value(preservedLogin, "AutofillOnPageLoad", "autofillOnPageLoad") ?? null,
      fido2Credentials
    }
  };
}

async function encodeFido2Credential(item: PasskeyItem, key: BitwardenSymmetricKey, preserved?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const unknown = Object.fromEntries(Object.entries(preserved || {}).filter(([name]) => !FIDO2_FIELD_NAMES.has(name.toLowerCase())));
  return {
    ...unknown,
    credentialId: await encryptBitwardenString(item.credentialId, key),
    keyAlgorithm: await encryptBitwardenString("ECDSA", key),
    keyValue: await encryptBitwardenString(item.privateKeyPkcs8 || "", key),
    rpId: await encryptBitwardenString(item.rpId, key),
    rpName: await encryptBitwardenString(item.rpName || item.title, key),
    counter: await encryptBitwardenString(String(Math.max(0, Math.floor(item.signCount))), key),
    userHandle: await encryptBitwardenString(item.userHandle, key),
    userName: await encryptBitwardenString(item.userName, key),
    userDisplayName: await encryptBitwardenString(item.userDisplayName, key),
    discoverable: await encryptBitwardenString(String(item.discoverable), key),
    creationDate: await encryptBitwardenString(item.createdAt, key)
  };
}

const FIDO2_FIELD_NAMES = new Set([
  "credentialid", "keyalgorithm", "keyvalue", "rpid", "rpname", "counter", "userhandle", "username", "userdisplayname", "discoverable", "creationdate"
]);

function bitwardenType(item: VaultItem): number {
  if (item.kind === "login") return 1;
  if (item.kind === "secure-note") return 2;
  if (item.kind === "card") return 3;
  if (item.kind === "identity") return 4;
  throw new Error(`此 Monica 项目类型暂不能保存到 Bitwarden：${item.kind}`);
}

async function decodeFido2Credentials(
  login: Record<string, unknown>,
  base: { id: string; title: string; favorite: boolean; notes: string; createdAt: string; updatedAt: string },
  cipherReference: ProviderReference,
  key: BitwardenSymmetricKey
): Promise<PasskeyItem[]> {
  return Promise.all(arrayValue(login, "Fido2Credentials", "fido2Credentials").map(async (entry, index) => {
    const fido = record(entry);
    const decrypted = await decryptRecordFields(fido, key, ["CredentialId", "KeyAlgorithm", "KeyValue", "RpId", "RpName", "Counter", "UserHandle", "UserName", "UserDisplayName", "Discoverable", "CreationDate"]);
    const credentialId = decrypted.CredentialId || `unknown-${index}`;
    const algorithm = normalizePasskeyAlgorithm(decrypted.KeyAlgorithm);
    return {
      ...base,
      id: `${base.id}:passkey:${credentialId}`,
      kind: "passkey",
      title: decrypted.RpName || base.title,
      credentialId,
      rpId: decrypted.RpId,
      rpName: decrypted.RpName,
      userHandle: decrypted.UserHandle,
      userName: decrypted.UserName,
      userDisplayName: decrypted.UserDisplayName,
      algorithm,
      publicKey: "",
      privateKeyPkcs8: decrypted.KeyValue || undefined,
      signCount: Number(decrypted.Counter) || 0,
      discoverable: decrypted.Discoverable.toLowerCase() !== "false",
      sourceMode: "bitwarden",
      createdAt: dateValue(decrypted.CreationDate, base.createdAt),
      providerRefs: [{ ...cipherReference, remoteId: `${cipherReference.remoteId}#fido2:${credentialId}` }]
    } satisfies PasskeyItem;
  }));
}

async function decryptRecordFields(raw: Record<string, unknown>, key: BitwardenSymmetricKey, names: string[]): Promise<Record<string, string>> {
  const pairs = await Promise.all(names.map(async (name) => [name, await decryptField(raw, key, name, lowerFirst(name))] as const));
  return Object.fromEntries(pairs);
}

function decryptField(raw: Record<string, unknown>, key: BitwardenSymmetricKey, ...names: string[]): Promise<string> {
  return decryptBitwardenString(stringValue(raw, ...names), key);
}

function encryptOptional(value: string, key: BitwardenSymmetricKey): Promise<string | null> {
  return value ? encryptBitwardenString(value, key) : Promise.resolve(null);
}

function normalizePasskeyAlgorithm(value: string): PasskeyItem["algorithm"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "rsa" || normalized === "rs256") return -257;
  if (normalized === "ps256") return -37;
  if (normalized === "eddsa" || normalized === "ed25519") return -8;
  return -7;
}

function dateValue(raw: unknown, fallback = new Date().toISOString()): string {
  if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  return fallback;
}

function lowerFirst(value: string): string {
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}

function value(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (name in raw) return raw[name];
  return undefined;
}

function stringValue(raw: Record<string, unknown>, ...names: string[]): string {
  const result = value(raw, ...names);
  return typeof result === "string" ? result : result == null ? "" : String(result);
}

function numberValue(raw: Record<string, unknown>, ...names: string[]): number {
  const result = Number(value(raw, ...names));
  return Number.isFinite(result) ? result : 0;
}

function booleanValue(raw: Record<string, unknown>, ...names: string[]): boolean {
  return value(raw, ...names) === true;
}

function recordValue(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown> | undefined {
  const result = value(raw, ...names);
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
}

function arrayValue(raw: Record<string, unknown>, ...names: string[]): unknown[] {
  const result = value(raw, ...names);
  return Array.isArray(result) ? result : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
