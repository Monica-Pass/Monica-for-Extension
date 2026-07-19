import { strFromU8, strToU8, zipSync } from "fflate";
import type { BillingAddressItem, CardItem, IdentityItem, LoginItem, PasskeyItem, PaymentAccountItem, ProviderReference, SecureCustomField, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";
import { inspectZipArchive, safeUnzipSync, validateUncompressedZipEntries } from "./zip-safety";

export interface AndroidBackupRecord {
  path: string;
  raw: Record<string, unknown>;
  itemId: string;
  item: VaultItem;
}

export interface AndroidBackupDocument {
  entries: Record<string, Uint8Array>;
  items: VaultItem[];
  records: Map<string, AndroidBackupRecord>;
  warnings: string[];
}

const JSON_PATH = /^folders\/([^/]+)\/(passwords|authenticators|bank_cards|documents|billing_addresses|payment_accounts|notes|passkeys)\/[^/]+\.json$/i;

export function readAndroidBackup(zipBytes: Uint8Array, providerId: string): AndroidBackupDocument {
  const entries = safeUnzipSync(zipBytes);
  const items: VaultItem[] = [];
  const records = new Map<string, AndroidBackupRecord>();
  const warnings: string[] = [];

  for (const [path, bytes] of Object.entries(entries)) {
    if (!JSON_PATH.test(path)) continue;
    try {
      const raw = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
      const item = androidRecordToItem(path, raw, providerId);
      if (!item) continue;
      items.push(item);
      records.set(item.id, { path, raw, itemId: item.id, item: cloneVaultItem(item) });
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : "无法解析"}`);
    }
  }
  restoreAndroidOtpBindings(items);
  for (const item of items) {
    const record = records.get(item.id);
    if (record) record.item = cloneVaultItem(item);
  }
  return { entries, items, records, warnings };
}

function restoreAndroidOtpBindings(items: VaultItem[]): void {
  const loginsByProviderAndId = new Map<string, LoginItem>();
  for (const item of items) {
    if (item.kind !== "login") continue;
    for (const reference of item.providerRefs) {
      const match = reference.remoteId?.match(/\/password_(-?\d+)_\d+\.json$/i);
      if (match) loginsByProviderAndId.set(`${reference.providerId}:${match[1]}`, item);
    }
  }
  for (const item of items) {
    if (item.kind !== "totp" || item.boundPasswordId == null) continue;
    for (const reference of item.providerRefs) {
      const login = loginsByProviderAndId.get(`${reference.providerId}:${item.boundPasswordId}`);
      if (login && !login.boundTotpItemId) login.boundTotpItemId = item.id;
    }
  }
}

export function writeAndroidBackup(document: AndroidBackupDocument, items: VaultItem[], providerId: string): Uint8Array {
  const entries = { ...document.entries };
  for (const item of items) {
    const existing = document.records.get(item.id);
    if (item.deletedAt) {
      if (existing) delete entries[existing.path];
      continue;
    }
    if (existing && sameWritableItem(item, existing.item)) continue;
    const target = serializeAndroidItem(item, existing?.raw, existing?.item);
    if (!target) continue;
    const remotePath = existing?.path || providerPath(item, target.id);
    entries[remotePath] = strToU8(JSON.stringify(target.raw));
    ensureProviderReference(item, providerId, remotePath);
  }
  validateUncompressedZipEntries(entries);
  const output = zipSync(entries, { level: 6 });
  inspectZipArchive(output);
  return output;
}

export function deleteAndroidBackupItem(document: AndroidBackupDocument, itemId: string): void {
  const record = document.records.get(itemId);
  if (!record) return;
  delete document.entries[record.path];
  document.records.delete(itemId);
  document.items = document.items.filter((item) => item.id !== itemId);
}

function androidRecordToItem(path: string, raw: Record<string, unknown>, providerId: string): VaultItem | null {
  const match = path.match(JSON_PATH);
  if (!match) return null;
  const kindFolder = match[2].toLowerCase();
  const base = baseFields(path, raw, providerId);

  if (kindFolder === "passwords") {
    return {
      ...base,
      kind: "login",
      username: stringValue(raw.username),
      password: stringValue(raw.password),
      uris: splitUris(stringValue(raw.website)),
      uriRules: splitUris(stringValue(raw.website)).map((uri) => ({ uri, matchType: "base-domain" })),
      totpSecret: stringValue(raw.authenticatorKey) || undefined,
      customFields: Array.isArray(raw.customFields)
        ? raw.customFields.map((field) => {
            const value = field as Record<string, unknown>;
            return { name: stringValue(value.title), value: stringValue(value.value), protected: Boolean(value.isProtected) };
          })
        : [],
      loginType: normalizeLoginType(raw.loginType),
      ssoProvider: optionalString(raw.ssoProvider),
      ssoRefEntryId: optionalNumber(raw.ssoRefEntryId),
      appPackageName: optionalString(raw.appPackageName),
      appName: optionalString(raw.appName),
      email: optionalString(raw.email),
      phone: optionalString(raw.phone),
      addressLine: optionalString(raw.addressLine),
      city: optionalString(raw.city),
      state: optionalString(raw.state),
      zipCode: optionalString(raw.zipCode),
      country: optionalString(raw.country),
      passkeyBindings: optionalString(raw.passkeyBindings),
      sshKeyData: optionalString(raw.sshKeyData),
      wifiMetadata: optionalString(raw.wifiMetadata),
      barcodeData: optionalString(raw.barcodeData),
      customIconType: optionalString(raw.customIconType),
      customIconValue: optionalString(raw.customIconValue),
      customIconUpdatedAt: optionalNumber(raw.customIconUpdatedAt)
    } satisfies LoginItem;
  }

  if (kindFolder === "notes") {
    const data = parseNestedJson(raw.itemData);
    return { ...base, kind: "secure-note", content: firstString(data, "content") || stringValue(raw.itemData) || stringValue(raw.notes), tags: parseStringArray(data.tags) || [], isMarkdown: Boolean(data.isMarkdown) } satisfies SecureNoteItem;
  }

  if (kindFolder === "authenticators") {
    const data = parseNestedJson(raw.itemData);
    const rawOtpType = stringValue(data.otpType);
    const otpType = rawOtpType ? normalizeOtpType(rawOtpType) : undefined;
    const steamSharedSecret = firstString(data, "steamSharedSecretBase64");
    const steamSession = parseSteamSession(firstString(data, "steamRawJson"));
    return {
      ...base,
      kind: "totp",
      secret: otpType === "STEAM" || steamSharedSecret ? steamSharedSecret || firstString(data, "secret", "authenticatorKey") : firstString(data, "secret", "authenticatorKey"),
      issuer: firstString(data, "issuer") || undefined,
      accountName: firstString(data, "accountName") || undefined,
      otpType: otpType || (steamSharedSecret ? "STEAM" : undefined),
      counter: optionalNumber(data.counter),
      pin: optionalString(firstString(data, "pin")),
      link: optionalString(firstString(data, "link")),
      associatedApp: optionalString(firstString(data, "associatedApp")),
      customIconType: optionalString(firstString(data, "customIconType")),
      customIconValue: optionalString(firstString(data, "customIconValue")),
      customIconUpdatedAt: optionalNumber(data.customIconUpdatedAt),
      boundPasswordId: optionalNumber(data.boundPasswordId),
      categoryId: optionalNumber(data.categoryId),
      keepassDatabaseId: optionalNumber(data.keepassDatabaseId),
      steamFingerprint: optionalString(firstString(data, "steamFingerprint")),
      steamDeviceId: optionalString(firstString(data, "steamDeviceId")),
      steamSerialNumber: optionalString(firstString(data, "steamSerialNumber")),
      steamSharedSecretBase64: optionalString(steamSharedSecret),
      steamId: steamSession.steamId,
      steamAccessToken: steamSession.accessToken,
      steamRefreshToken: steamSession.refreshToken,
      steamLoginSecure: steamSession.loginSecure,
      steamRevocationCode: optionalString(firstString(data, "steamRevocationCode")),
      steamIdentitySecret: optionalString(firstString(data, "steamIdentitySecret")),
      steamTokenGid: optionalString(firstString(data, "steamTokenGid")),
      steamRawJson: optionalString(firstString(data, "steamRawJson")),
      algorithm: normalizeTotpAlgorithm(data.algorithm),
      digits: numberValue(data.digits, 6),
      period: numberValue(data.period, 30)
    } satisfies TotpItem;
  }

  if (kindFolder === "passkeys") {
    return {
      ...base,
      kind: "passkey",
      credentialId: stringValue(raw.credentialId),
      rpId: stringValue(raw.rpId),
      rpName: stringValue(raw.rpName),
      userHandle: stringValue(raw.userId),
      userName: stringValue(raw.userName),
      userDisplayName: stringValue(raw.userDisplayName),
      algorithm: normalizePasskeyAlgorithm(raw.publicKeyAlgorithm),
      publicKey: stringValue(raw.publicKey),
      signCount: numberValue(raw.signCount, 0),
      discoverable: raw.isDiscoverable !== false,
      sourceMode: "android-metadata-only"
    } satisfies PasskeyItem;
  }

  const data = parseNestedJson(raw.itemData);
  if (kindFolder === "bank_cards") {
    return {
      ...base,
      kind: "card",
      cardholderName: firstString(data, "cardholderName"),
      number: firstString(data, "cardNumber", "number"),
      expiryMonth: firstString(data, "expiryMonth", "expMonth"),
      expiryYear: firstString(data, "expiryYear", "expYear"),
      securityCode: firstString(data, "cvv", "code"),
      brand: optionalString(firstString(data, "brand")),
      bankName: optionalString(firstString(data, "bankName")),
      cardType: normalizeCardType(data.cardType),
      billingAddress: optionalString(firstString(data, "billingAddress")),
      nickname: optionalString(firstString(data, "nickname")),
      validFromMonth: optionalString(firstString(data, "validFromMonth")),
      validFromYear: optionalString(firstString(data, "validFromYear")),
      pin: optionalString(firstString(data, "pin")),
      iban: optionalString(firstString(data, "iban")),
      swiftBic: optionalString(firstString(data, "swiftBic")),
      routingNumber: optionalString(firstString(data, "routingNumber")),
      accountNumber: optionalString(firstString(data, "accountNumber")),
      branchCode: optionalString(firstString(data, "branchCode")),
      currency: optionalString(firstString(data, "currency")),
      customerServicePhone: optionalString(firstString(data, "customerServicePhone")),
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies CardItem;
  }
  if (kindFolder === "documents") {
    const firstName = firstString(data, "firstName");
    const middleName = firstString(data, "middleName");
    const lastName = firstString(data, "lastName");
    const nameFromParts = [firstName, middleName, lastName].filter(Boolean).join(" ");
    return {
      ...base,
      kind: "identity",
      documentType: normalizeDocumentType(firstString(data, "documentType", "type")),
      documentNumber: firstString(data, "documentNumber", "number", "passportNumber", "licenseNumber", "driverLicense", "ssn"),
      firstName,
      middleName,
      lastName,
      fullName: nameFromParts || firstString(data, "fullName", "name"),
      birthDate: optionalString(firstString(data, "birthDate")),
      issuedDate: optionalString(firstString(data, "issuedDate", "issueDate")),
      expiryDate: optionalString(firstString(data, "expiryDate")),
      issuedBy: optionalString(firstString(data, "issuedBy", "issuingAuthority")),
      nationality: optionalString(firstString(data, "nationality")),
      additionalInfo: optionalString(firstString(data, "additionalInfo")),
      company: optionalString(firstString(data, "company")),
      username: optionalString(firstString(data, "username")),
      ssn: optionalString(firstString(data, "ssn")),
      passportNumber: optionalString(firstString(data, "passportNumber")),
      licenseNumber: optionalString(firstString(data, "licenseNumber")),
      address3: optionalString(firstString(data, "address3")),
      email: optionalString(firstString(data, "email")),
      phone: optionalString(firstString(data, "phone", "phoneNumber")),
      address: {
        streetAddress: firstString(data, "address1", "streetAddress", "addressLine1"),
        apartment: firstString(data, "address2", "apartment", "addressLine2"),
        city: firstString(data, "city"),
        stateProvince: firstString(data, "stateProvince", "state", "province", "region"),
        postalCode: firstString(data, "postalCode", "zip", "zipCode"),
        country: firstString(data, "country"),
        company: firstString(data, "company"),
        email: firstString(data, "email"),
        phone: firstString(data, "phone", "phoneNumber")
      },
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies IdentityItem;
  }
  if (kindFolder === "billing_addresses") {
    return {
      ...base,
      kind: "billing-address",
      fullName: firstString(data, "fullName", "name"),
      company: firstString(data, "company", "organization"),
      streetAddress: firstString(data, "streetAddress", "address1", "addressLine1"),
      apartment: firstString(data, "apartment", "address2", "addressLine2"),
      city: firstString(data, "city"),
      stateProvince: firstString(data, "stateProvince", "state", "province", "region"),
      postalCode: firstString(data, "postalCode", "zip", "zipCode"),
      country: firstString(data, "country"),
      phone: firstString(data, "phone", "phoneNumber"),
      email: firstString(data, "email"),
      isDefault: Boolean(data.isDefault),
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies BillingAddressItem;
  }
  if (kindFolder === "payment_accounts") {
    return {
      ...base,
      kind: "payment-account",
      paymentType: normalizePaymentAccountType(firstString(data, "paymentType", "accountType", "type")),
      provider: firstString(data, "provider", "service", "brand", "network"),
      accountName: firstString(data, "accountName", "name", "nickname", "title"),
      accountHolderName: firstString(data, "accountHolderName", "holderName", "fullName", "nameOnAccount"),
      email: firstString(data, "email"),
      phone: firstString(data, "phone", "phoneNumber"),
      username: firstString(data, "username", "userName", "login"),
      accountId: firstString(data, "accountId", "accountIdentifier", "id"),
      maskedAccountNumber: firstString(data, "maskedAccountNumber", "maskedNumber", "accountNumber"),
      linkedCardLast4: optionalString(firstString(data, "linkedCardLast4")),
      routingNumber: firstString(data, "routingNumber"),
      iban: firstString(data, "iban"),
      swiftBic: firstString(data, "swiftBic", "swift", "bic"),
      website: firstString(data, "website", "url", "uri"),
      currency: firstString(data, "currency"),
      billingAddress: optionalString(firstString(data, "billingAddress")),
      paymentNotes: optionalString(firstString(data, "notes")),
      isDefault: Boolean(data.isDefault),
      customFields: parseSecureCustomFields(data.customFields)
    } satisfies PaymentAccountItem;
  }
  return null;
}

function baseFields(path: string, raw: Record<string, unknown>, providerId: string) {
  const createdAt = dateValue(raw.createdAt);
  const updatedAt = dateValue(raw.updatedAt, createdAt);
  return {
    id: `android:${providerId}:${path}`,
    title: stringValue(raw.title) || stringValue(raw.rpName) || "未命名项目",
    favorite: Boolean(raw.isFavorite),
    notes: stringValue(raw.notes),
    createdAt,
    updatedAt,
    deletedAt: Boolean(raw.isDeleted) ? dateValue(raw.deletedAt, updatedAt) : undefined,
    archivedAt: Boolean(raw.isArchived) ? dateValue(raw.archivedAt, updatedAt) : undefined,
    categoryId: optionalNumber(raw.categoryId),
    categoryName: optionalString(raw.categoryName),
    sortOrder: optionalNumber(raw.sortOrder),
    imagePaths: parseStringArray(raw.imagePaths),
    boundNoteId: optionalNumber(raw.boundNoteId),
    replicaGroupId: optionalString(raw.replicaGroupId ?? raw.replica_group_id),
    keepassDatabaseId: optionalNumber(raw.keepassDatabaseId),
    keepassGroupPath: optionalString(raw.keepassGroupPath),
    keepassEntryUuid: optionalString(raw.keepassEntryUuid ?? raw.keepass_entry_uuid),
    keepassGroupUuid: optionalString(raw.keepassGroupUuid ?? raw.keepass_group_uuid),
    mdbxDatabaseId: optionalNumber(raw.mdbxDatabaseId ?? raw.mdbx_database_id),
    mdbxFolderId: optionalString(raw.mdbxFolderId ?? raw.mdbx_folder_id),
    providerRefs: [{ providerId, remoteId: path }] as ProviderReference[]
  };
}

function serializeAndroidItem(item: VaultItem, original?: Record<string, unknown>, originalItem?: VaultItem): { id: number | string; raw: Record<string, unknown> } | null {
  const originalId = original?.id;
  const id: number | string = typeof originalId === "number" || typeof originalId === "string" ? originalId : numericId(item);
  const raw: Record<string, unknown> = { ...(original || {}) };
  const isNew = !original || !originalItem;
  const setChanged = (key: string, value: unknown, current: unknown, previous: unknown) => {
    if (isNew || !sameValue(current, previous)) raw[key] = value;
  };
  const setNested = (updates: Record<string, unknown>, key: string, value: unknown, current: unknown, previous: unknown) => {
    if (isNew || !sameValue(current, previous)) updates[key] = value;
  };
  const applyCommon = (expectedKind: VaultItem["kind"], itemType?: string) => {
    const previous = originalItem?.kind === expectedKind ? originalItem : undefined;
    if (isNew) {
      raw.id = id;
      if (itemType) raw.itemType = itemType;
    }
    setChanged("title", item.title, item.title, previous?.title);
    setChanged("notes", item.notes, item.notes, previous?.notes);
    setChanged("isFavorite", item.favorite, item.favorite, previous?.favorite);
    setChanged("sortOrder", item.sortOrder || 0, item.sortOrder, previous?.sortOrder);
    setChanged("categoryId", item.categoryId ?? null, item.categoryId, previous?.categoryId);
    setChanged("categoryName", item.categoryName ?? null, item.categoryName, previous?.categoryName);
    setChanged("imagePaths", JSON.stringify(item.imagePaths || []), item.imagePaths || [], previous?.imagePaths || []);
    setChanged("isDeleted", Boolean(item.deletedAt), item.deletedAt, previous?.deletedAt);
    setChanged("deletedAt", item.deletedAt ? Date.parse(item.deletedAt) : null, item.deletedAt, previous?.deletedAt);
    setChanged("isArchived", Boolean(item.archivedAt), item.archivedAt, previous?.archivedAt);
    setChanged("archivedAt", item.archivedAt ? Date.parse(item.archivedAt) : null, item.archivedAt, previous?.archivedAt);
    setChanged("boundNoteId", item.boundNoteId ?? null, item.boundNoteId, previous?.boundNoteId);
    setChanged("replicaGroupId", item.replicaGroupId ?? null, item.replicaGroupId, previous?.replicaGroupId);
    setChanged("keepassDatabaseId", item.keepassDatabaseId ?? null, item.keepassDatabaseId, previous?.keepassDatabaseId);
    setChanged("keepassGroupPath", item.keepassGroupPath ?? null, item.keepassGroupPath, previous?.keepassGroupPath);
    setChanged("keepassEntryUuid", item.keepassEntryUuid ?? null, item.keepassEntryUuid, previous?.keepassEntryUuid);
    setChanged("keepassGroupUuid", item.keepassGroupUuid ?? null, item.keepassGroupUuid, previous?.keepassGroupUuid);
    setChanged("mdbxDatabaseId", item.mdbxDatabaseId ?? null, item.mdbxDatabaseId, previous?.mdbxDatabaseId);
    setChanged("mdbxFolderId", item.mdbxFolderId ?? null, item.mdbxFolderId, previous?.mdbxFolderId);
    setChanged("createdAt", Date.parse(item.createdAt) || Date.now(), item.createdAt, previous?.createdAt);
    setChanged("updatedAt", Date.parse(item.updatedAt) || Date.now(), item.updatedAt, previous?.updatedAt);
    return previous;
  };
  const applyNested = (updates: Record<string, unknown>) => {
    if (Object.keys(updates).length > 0) raw.itemData = mergeNestedItemData(original?.itemData, updates);
  };

  switch (item.kind) {
    case "login": {
      const previous = applyCommon("login") as LoginItem | undefined;
      setChanged("username", item.username, item.username, previous?.username);
      setChanged("password", item.password, item.password, previous?.password);
      setChanged("website", item.uris.join("\n"), item.uris, previous?.uris);
      setChanged("authenticatorKey", item.totpSecret || "", item.totpSecret || "", previous?.totpSecret || "");
      setChanged("loginType", item.loginType || "PASSWORD", item.loginType || "PASSWORD", previous?.loginType || "PASSWORD");
      setChanged("ssoProvider", item.ssoProvider || "", item.ssoProvider || "", previous?.ssoProvider || "");
      setChanged("ssoRefEntryId", item.ssoRefEntryId ?? null, item.ssoRefEntryId, previous?.ssoRefEntryId);
      for (const key of ["appPackageName", "appName", "email", "phone", "addressLine", "city", "state", "zipCode", "country", "passkeyBindings", "sshKeyData", "wifiMetadata", "barcodeData", "customIconType", "customIconValue"] as const) {
        setChanged(key, item[key] || "", item[key] || "", previous?.[key] || "");
      }
      setChanged("customIconUpdatedAt", item.customIconUpdatedAt || 0, item.customIconUpdatedAt, previous?.customIconUpdatedAt);
      const customFields = item.customFields.map((field) => ({ title: field.name, value: field.value, isProtected: field.protected }));
      setChanged("customFields", customFields, item.customFields, previous?.customFields);
      return { id, raw };
    }
    case "secure-note": {
      const previous = applyCommon("secure-note", "NOTE") as SecureNoteItem | undefined;
      const updates: Record<string, unknown> = {};
      setNested(updates, "content", item.content, item.content, previous?.content);
      setNested(updates, "tags", item.tags || [], item.tags || [], previous?.tags || []);
      setNested(updates, "isMarkdown", Boolean(item.isMarkdown), Boolean(item.isMarkdown), Boolean(previous?.isMarkdown));
      applyNested(updates);
      return { id, raw };
    }
    case "totp": {
      const previous = applyCommon("totp", "TOTP") as TotpItem | undefined;
      const updates: Record<string, unknown> = {};
      const setOptionalNested = (key: string, value: unknown, current: unknown, previousValue: unknown) => {
        if (current !== undefined || previousValue !== undefined) setNested(updates, key, value, current, previousValue);
      };
      setNested(updates, "secret", item.secret, item.secret, previous?.secret);
      setNested(updates, "issuer", item.issuer || "", item.issuer || "", previous?.issuer || "");
      setNested(updates, "accountName", item.accountName || "", item.accountName || "", previous?.accountName || "");
      setOptionalNested("otpType", item.otpType, item.otpType, previous?.otpType);
      setOptionalNested("counter", item.counter, item.counter, previous?.counter);
      setOptionalNested("pin", item.pin, item.pin, previous?.pin);
      setOptionalNested("link", item.link, item.link, previous?.link);
      setOptionalNested("associatedApp", item.associatedApp, item.associatedApp, previous?.associatedApp);
      setOptionalNested("customIconType", item.customIconType, item.customIconType, previous?.customIconType);
      setOptionalNested("customIconValue", item.customIconValue, item.customIconValue, previous?.customIconValue);
      setOptionalNested("customIconUpdatedAt", item.customIconUpdatedAt, item.customIconUpdatedAt, previous?.customIconUpdatedAt);
      setOptionalNested("boundPasswordId", item.boundPasswordId, item.boundPasswordId, previous?.boundPasswordId);
      setOptionalNested("categoryId", item.categoryId, item.categoryId, previous?.categoryId);
      setOptionalNested("keepassDatabaseId", item.keepassDatabaseId, item.keepassDatabaseId, previous?.keepassDatabaseId);
      setOptionalNested("steamFingerprint", item.steamFingerprint, item.steamFingerprint, previous?.steamFingerprint);
      setOptionalNested("steamDeviceId", item.steamDeviceId, item.steamDeviceId, previous?.steamDeviceId);
      setOptionalNested("steamSerialNumber", item.steamSerialNumber, item.steamSerialNumber, previous?.steamSerialNumber);
      setOptionalNested("steamSharedSecretBase64", item.steamSharedSecretBase64, item.steamSharedSecretBase64, previous?.steamSharedSecretBase64);
      setOptionalNested("steamRevocationCode", item.steamRevocationCode, item.steamRevocationCode, previous?.steamRevocationCode);
      setOptionalNested("steamIdentitySecret", item.steamIdentitySecret, item.steamIdentitySecret, previous?.steamIdentitySecret);
      setOptionalNested("steamTokenGid", item.steamTokenGid, item.steamTokenGid, previous?.steamTokenGid);
      setOptionalNested("steamRawJson", item.steamRawJson, item.steamRawJson, previous?.steamRawJson);
      setNested(updates, "algorithm", item.algorithm, item.algorithm, previous?.algorithm);
      setNested(updates, "digits", item.digits, item.digits, previous?.digits);
      setNested(updates, "period", item.period, item.period, previous?.period);
      applyNested(updates);
      return { id, raw };
    }
    case "card": {
      const previous = applyCommon("card", "BANK_CARD") as CardItem | undefined;
      const updates: Record<string, unknown> = {};
      setNested(updates, "cardholderName", item.cardholderName, item.cardholderName, previous?.cardholderName);
      setNested(updates, "cardNumber", item.number, item.number, previous?.number);
      setNested(updates, "expiryMonth", item.expiryMonth, item.expiryMonth, previous?.expiryMonth);
      setNested(updates, "expiryYear", item.expiryYear, item.expiryYear, previous?.expiryYear);
      setNested(updates, "cvv", item.securityCode, item.securityCode, previous?.securityCode);
      setNested(updates, "brand", item.brand || "", item.brand || "", previous?.brand || "");
      for (const key of ["bankName", "billingAddress", "nickname", "validFromMonth", "validFromYear", "pin", "iban", "swiftBic", "routingNumber", "accountNumber", "branchCode", "currency", "customerServicePhone"] as const) {
        setNested(updates, key, item[key] || "", item[key] || "", previous?.[key] || "");
      }
      setNested(updates, "cardType", item.cardType || "CREDIT", item.cardType || "CREDIT", previous?.cardType || "CREDIT");
      setNested(updates, "customFields", serializeSecureCustomFields(item.customFields), item.customFields || [], previous?.customFields || []);
      applyNested(updates);
      return { id, raw };
    }
    case "identity": {
      const previous = applyCommon("identity", "DOCUMENT") as IdentityItem | undefined;
      const updates: Record<string, unknown> = {};
      setNested(updates, "documentType", item.documentType, item.documentType, previous?.documentType);
      setNested(updates, "documentNumber", item.documentNumber, item.documentNumber, previous?.documentNumber);
      setNested(updates, "firstName", item.firstName, item.firstName, previous?.firstName);
      setNested(updates, "middleName", item.middleName, item.middleName, previous?.middleName);
      setNested(updates, "lastName", item.lastName, item.lastName, previous?.lastName);
      setNested(updates, "fullName", item.fullName, item.fullName, previous?.fullName);
      setNested(updates, "birthDate", item.birthDate || "", item.birthDate || "", previous?.birthDate || "");
      setNested(updates, "issuedDate", item.issuedDate || "", item.issuedDate || "", previous?.issuedDate || "");
      setNested(updates, "expiryDate", item.expiryDate || "", item.expiryDate || "", previous?.expiryDate || "");
      setNested(updates, "issuedBy", item.issuedBy || "", item.issuedBy || "", previous?.issuedBy || "");
      setNested(updates, "nationality", item.nationality || "", item.nationality || "", previous?.nationality || "");
      for (const key of ["additionalInfo", "company", "username", "ssn", "passportNumber", "licenseNumber", "address3"] as const) {
        setNested(updates, key, item[key] || "", item[key] || "", previous?.[key] || "");
      }
      setNested(updates, "email", item.email || "", item.email || "", previous?.email || "");
      setNested(updates, "phone", item.phone || "", item.phone || "", previous?.phone || "");
      setNested(updates, "address1", item.address?.streetAddress || "", item.address?.streetAddress || "", previous?.address?.streetAddress || "");
      setNested(updates, "address2", item.address?.apartment || "", item.address?.apartment || "", previous?.address?.apartment || "");
      setNested(updates, "city", item.address?.city || "", item.address?.city || "", previous?.address?.city || "");
      setNested(updates, "stateProvince", item.address?.stateProvince || "", item.address?.stateProvince || "", previous?.address?.stateProvince || "");
      setNested(updates, "postalCode", item.address?.postalCode || "", item.address?.postalCode || "", previous?.address?.postalCode || "");
      setNested(updates, "country", item.address?.country || "", item.address?.country || "", previous?.address?.country || "");
      setNested(updates, "customFields", serializeSecureCustomFields(item.customFields), item.customFields || [], previous?.customFields || []);
      applyNested(updates);
      return { id, raw };
    }
    case "billing-address": {
      const previous = applyCommon("billing-address", "BILLING_ADDRESS") as BillingAddressItem | undefined;
      const updates: Record<string, unknown> = {};
      for (const key of ["fullName", "company", "streetAddress", "apartment", "city", "stateProvince", "postalCode", "country", "phone", "email"] as const) {
        setNested(updates, key, item[key], item[key], previous?.[key]);
      }
      setNested(updates, "isDefault", Boolean(item.isDefault), Boolean(item.isDefault), Boolean(previous?.isDefault));
      setNested(updates, "customFields", serializeSecureCustomFields(item.customFields), item.customFields || [], previous?.customFields || []);
      applyNested(updates);
      return { id, raw };
    }
    case "payment-account": {
      const previous = applyCommon("payment-account", "PAYMENT_ACCOUNT") as PaymentAccountItem | undefined;
      const updates: Record<string, unknown> = {};
      for (const key of ["paymentType", "provider", "accountName", "accountHolderName", "email", "phone", "username", "accountId", "maskedAccountNumber", "routingNumber", "iban", "swiftBic", "website", "currency"] as const) {
        setNested(updates, key, item[key], item[key], previous?.[key]);
      }
      for (const key of ["linkedCardLast4", "billingAddress"] as const) setNested(updates, key, item[key] || "", item[key] || "", previous?.[key] || "");
      setNested(updates, "notes", item.paymentNotes || "", item.paymentNotes || "", previous?.paymentNotes || "");
      setNested(updates, "isDefault", Boolean(item.isDefault), Boolean(item.isDefault), Boolean(previous?.isDefault));
      setNested(updates, "customFields", serializeSecureCustomFields(item.customFields), item.customFields || [], previous?.customFields || []);
      applyNested(updates);
      return { id, raw };
    }
    case "passkey": {
      const previous = originalItem?.kind === "passkey" ? originalItem : undefined;
      setChanged("credentialId", item.credentialId, item.credentialId, previous?.credentialId);
      setChanged("rpId", item.rpId, item.rpId, previous?.rpId);
      setChanged("rpName", item.rpName, item.rpName, previous?.rpName);
      setChanged("userId", item.userHandle, item.userHandle, previous?.userHandle);
      setChanged("userName", item.userName, item.userName, previous?.userName);
      setChanged("userDisplayName", item.userDisplayName, item.userDisplayName, previous?.userDisplayName);
      setChanged("publicKeyAlgorithm", item.algorithm, item.algorithm, previous?.algorithm);
      setChanged("publicKey", item.publicKey, item.publicKey, previous?.publicKey);
      setChanged("createdAt", Date.parse(item.createdAt) || Date.now(), item.createdAt, previous?.createdAt);
      setChanged("signCount", item.signCount, item.signCount, previous?.signCount);
      setChanged("isDiscoverable", item.discoverable, item.discoverable, previous?.discoverable);
      setChanged("notes", item.notes, item.notes, previous?.notes);
      if (isNew) {
        raw.privateKeyAlias = "";
        raw.lastUsedAt = Date.parse(item.updatedAt) || Date.now();
        raw.useCount = 0;
        raw.iconUrl = null;
        raw.isUserVerificationRequired = true;
        raw.transports = "internal";
        raw.aaguid = "";
        raw.boundPasswordId = null;
        raw.passkeyMode = item.sourceMode === "bitwarden" ? "BW_COMPAT" : "LEGACY";
        raw.categoryName = null;
      }
      return { id: item.credentialId, raw };
    }
  }
}

function sameWritableItem(left: VaultItem, right: VaultItem): boolean {
  const { providerRefs: _leftProviderRefs, deletedAt: _leftDeletedAt, ...leftPayload } = left;
  const { providerRefs: _rightProviderRefs, deletedAt: _rightDeletedAt, ...rightPayload } = right;
  return sameValue(leftPayload, rightPayload);
}

function cloneVaultItem(item: VaultItem): VaultItem {
  return JSON.parse(JSON.stringify(item)) as VaultItem;
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function providerPath(item: VaultItem, id: number | string): string {
  const millis = Date.parse(item.createdAt) || Date.now();
  const mapping: Record<VaultItem["kind"], [string, string]> = {
    login: ["passwords", "password"],
    "secure-note": ["notes", "note"],
    totp: ["authenticators", "totp"],
    card: ["bank_cards", "bank_card"],
    identity: ["documents", "document"],
    "billing-address": ["billing_addresses", "billing_address"],
    "payment-account": ["payment_accounts", "payment_account"],
    passkey: ["passkeys", "passkey"]
  };
  const [folder, prefix] = mapping[item.kind];
  const safeId = String(id).replace(/\//g, "_");
  if (item.kind === "passkey") return `folders/_root/${folder}/${prefix}_${safeId}.json`;
  return `folders/_root/${folder}/${prefix}_${safeId}_${millis}.json`;
}

function ensureProviderReference(item: VaultItem, providerId: string, remoteId: string) {
  if (item.providerRefs.some((reference) => reference.providerId === providerId && reference.remoteId === remoteId)) return;
  item.providerRefs.push({ providerId, remoteId });
}

function numericId(item: VaultItem): number {
  let hash = 0;
  for (const char of item.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return Date.parse(item.createdAt) * 1000 + (hash % 1000);
}

function splitUris(value: string): string[] {
  return [...new Set(value.split(/[\r\n,;]+/).map((part) => part.trim()).filter(Boolean))];
}

function parseStringArray(value: unknown): string[] | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return []; } })() : value;
  if (!Array.isArray(parsed)) return undefined;
  const values = parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
  return values.length ? values : undefined;
}

function parseNestedJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mergeNestedItemData(original: unknown, updates: Record<string, unknown>): string {
  return JSON.stringify({ ...parseNestedJson(original), ...updates });
}

function firstString(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(data[key]);
    if (value) return value;
  }
  return "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
function optionalString(value: unknown): string | undefined {
  return stringValue(value) || undefined;
}
function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function dateValue(value: unknown, fallback = new Date().toISOString()): string {
  const millis = numberValue(value, Number.NaN);
  if (Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}
function normalizeTotpAlgorithm(value: unknown): TotpItem["algorithm"] {
  const normalized = stringValue(value).toUpperCase();
  return normalized === "SHA256" || normalized === "SHA512" ? normalized : "SHA1";
}

function normalizeCardType(value: unknown): NonNullable<CardItem["cardType"]> {
  const normalized = stringValue(value).trim().toUpperCase();
  return normalized === "DEBIT" || normalized === "PREPAID" ? normalized : "CREDIT";
}

function parseSecureCustomFields(value: unknown): SecureCustomField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const name = firstString(raw, "label", "title", "name").trim();
    if (!name) return [];
    const rawType = firstString(raw, "type").toUpperCase();
    const fieldType: NonNullable<SecureCustomField["fieldType"]> = rawType === "HIDDEN" || rawType === "BOOLEAN" ? rawType : "TEXT";
    return [{ name, value: firstString(raw, "value"), protected: fieldType === "HIDDEN", fieldType }];
  });
}

function serializeSecureCustomFields(value: SecureCustomField[] | undefined): Array<{ label: string; value: string; type: string }> {
  return (value || []).filter((field) => field.name.trim()).map((field) => ({ label: field.name.trim(), value: field.value, type: field.fieldType || (field.protected ? "HIDDEN" : "TEXT") }));
}
function normalizeOtpType(value: unknown): NonNullable<TotpItem["otpType"]> {
  const normalized = stringValue(value).trim().toUpperCase();
  return normalized === "HOTP" || normalized === "STEAM" || normalized === "YANDEX" || normalized === "MOTP" ? normalized : "TOTP";
}

function normalizeLoginType(value: unknown): NonNullable<LoginItem["loginType"]> {
  const normalized = stringValue(value).trim().toUpperCase();
  if (normalized === "SSH") return "SSH_KEY";
  return normalized === "SSO" || normalized === "WIFI" || normalized === "SSH_KEY" || normalized === "BARCODE" ? normalized : "PASSWORD";
}

function parseSteamSession(rawJson: string): { steamId?: string; accessToken?: string; refreshToken?: string; loginSecure?: string } {
  if (!rawJson.trim()) return {};
  try {
    const root = JSON.parse(rawJson) as Record<string, unknown>;
    const session = (root.Session || root.session) as Record<string, unknown> | undefined;
    const loginSecure = firstString(root, "steamLoginSecure", "steam_login_secure") || firstString(session || {}, "SteamLoginSecure", "steamLoginSecure");
    const accessToken = firstString(root, "access_token", "accessToken", "oauth_token", "OAuthToken") || firstString(session || {}, "AccessToken", "access_token", "OAuthToken", "oauth_token") || loginSecure.split("||").slice(1).join("||");
    const refreshToken = firstString(root, "refresh_token", "refreshToken") || firstString(session || {}, "RefreshToken", "refresh_token");
    const steamId = firstString(root, "steamid", "steam_id", "SteamID", "steam64", "steam_id64", "steamID64") || firstString(session || {}, "SteamID", "steamid", "steam_id") || loginSecure.split("||")[0];
    return { steamId: optionalString(steamId), accessToken: optionalString(accessToken), refreshToken: optionalString(refreshToken), loginSecure: optionalString(loginSecure) };
  } catch {
    return {};
  }
}
function normalizePasskeyAlgorithm(value: unknown): PasskeyItem["algorithm"] {
  const algorithm = numberValue(value, -7);
  return algorithm === -257 || algorithm === -37 || algorithm === -8 ? algorithm : -7;
}
function normalizeDocumentType(value: unknown): IdentityItem["documentType"] {
  const normalized = stringValue(value).trim().toUpperCase().replace(/[ -]/g, "_");
  if (normalized === "PASSPORT") return "PASSPORT";
  if (normalized === "DRIVER_LICENSE" || normalized === "DRIVERLICENSE" || normalized === "LICENSE") return "DRIVER_LICENSE";
  if (normalized === "SOCIAL_SECURITY" || normalized === "SOCIALSECURITY" || normalized === "SSN") return "SOCIAL_SECURITY";
  if (normalized === "ID_CARD" || normalized === "IDCARD" || normalized === "IDENTITY") return "ID_CARD";
  return "OTHER";
}
function normalizePaymentAccountType(value: unknown): string {
  const normalized = stringValue(value).trim().toLowerCase().replace(/[ -]/g, "_");
  if (normalized === "bank" || normalized === "bank_account" || normalized === "account") return "BANK_ACCOUNT";
  if (normalized === "payment_app" || normalized === "app" || normalized === "mobile_payment" || normalized === "mobile_wallet") return "PAYMENT_APP";
  if (normalized === "bnpl" || normalized === "buy_now_pay_later" || normalized === "pay_later") return "BUY_NOW_PAY_LATER";
  if (normalized === "crypto" || normalized === "crypto_wallet" || normalized === "wallet_crypto") return "CRYPTO_WALLET";
  if (normalized === "other") return "OTHER";
  return "DIGITAL_WALLET";
}
