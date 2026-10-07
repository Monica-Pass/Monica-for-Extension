<script setup lang="ts">
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { tr } from '../i18n';

import { computed, reactive, ref, watch } from "vue";
import type {
  BillingAddressItem,
  CardItem,
  IdentityItem,
  PaymentAccountItem,
  ProviderAccount,
  SecureNoteItem,
  TotpItem,
  VaultItem,
} from "../core/model";
import { generateOtpUri, parseOtpUris } from "../core/totp";
import { normalizeOtpCounter } from "../core/otp-counter";
import { preserveUneditedProjection } from "../core/edited-projection";
import BillingAddressFields from "./BillingAddressFields.vue";
import WalletCardFace from "./WalletCardFace.vue";
import CardFaceImagePicker from "./CardFaceImagePicker.vue";
import { createOtpQrDataUrl, decodeOtpQrImage } from "../core/otp-qr";
import { exportSteamMaFile, parseSteamMaFileBundle } from "../core/steam-mafile";
import { itemKindLabel } from "../manager/item-metadata";

export type EditableVaultKind =
  | "card"
  | "identity"
  | "billing-address"
  | "payment-account"
  | "secure-note"
  | "totp";

const props = defineProps<{
  item?: VaultItem;
  initialKind: EditableVaultKind;
  providers: ProviderAccount[];
  saveItem: (item: VaultItem) => Promise<void>;
}>();
const emit = defineEmits<{ cancel: []; save: [item: VaultItem] }>();

const kind = ref<EditableVaultKind>(
  props.item && isEditableKind(props.item.kind)
    ? props.item.kind
    : props.initialKind,
);
const error = ref("");
const saving = ref(false);
const otpTransferInput = ref("");
const otpQrDataUrl = ref("");
const otpTransferStatus = ref("");
const fields = reactive(emptyFields());

const eligibleProviders = computed(() =>
  props.providers.filter(
    (provider) =>
      provider.enabled && providerSupportsKind(provider, kind.value),
  ),
);

watch(kind, () => {
  if (
    !eligibleProviders.value.some(
      (provider) => provider.id === fields.providerId,
    )
  )
    fields.providerId = defaultProviderId();
});

initialize();
let initialProjection: VaultItem | undefined;
try { initialProjection = props.item ? buildCandidate(fields.title) : undefined; }
catch (cause) { error.value = cause instanceof Error ? cause.message : "原始数据暂不支持编辑，已保留。"; }

function initialize() {
  Object.assign(fields, emptyFields());
  fields.providerId =
    props.item?.providerRefs[0]?.providerId || defaultProviderId();
  if (!props.item) return;
  fields.title = props.item.title;
  fields.notes = props.item.notes;
  fields.favorite = props.item.favorite;
  if (props.item.kind === "card" || props.item.kind === "identity" || props.item.kind === "billing-address") {
    fields.cardFaceEnabled = Boolean(props.item.cardFace);
    fields.cardFaceName = props.item.cardFace?.imageAttachmentName || "";
    fields.cardFaceMode = props.item.cardFace?.displayMode || "ALL";
    fields.cardFaceBrand = props.item.cardFace?.showBrandIcon !== false;
  }
  switch (props.item.kind) {
    case "card":
      Object.assign(fields, {
        cardholderName: props.item.cardholderName,
        number: props.item.number,
        expiryMonth: props.item.expiryMonth,
        expiryYear: props.item.expiryYear,
        securityCode: props.item.securityCode,
        brand: props.item.brand || "",
        billingAddressId: props.item.billingAddressId || "",
        bankName: props.item.bankName || "",
        cardType: props.item.cardType || "CREDIT",
        billingAddress: props.item.billingAddress || "",
        nickname: props.item.nickname || "",
        validFromMonth: props.item.validFromMonth || "",
        validFromYear: props.item.validFromYear || "",
        cardPin: props.item.pin || "",
        iban: props.item.iban || "",
        swiftBic: props.item.swiftBic || "",
        routingNumber: props.item.routingNumber || "",
        cardAccountNumber: props.item.accountNumber || "",
        branchCode: props.item.branchCode || "",
        currency: props.item.currency || "",
        customerServicePhone: props.item.customerServicePhone || "",
        customFields: cloneCustomFields(props.item.customFields),
      });
      break;
    case "identity":
      Object.assign(fields, {
        documentType: props.item.documentType,
        documentTitle: props.item.documentTitle || "",
        documentNumber: props.item.documentNumber,
        firstName: props.item.firstName,
        middleName: props.item.middleName,
        lastName: props.item.lastName,
        fullName: props.item.fullName,
        birthDate: props.item.birthDate || "",
        issuedDate: props.item.issuedDate || "",
        expiryDate: props.item.expiryDate || "",
        issuedBy: props.item.issuedBy || "",
        nationality: props.item.nationality || "",
        additionalInfo: props.item.additionalInfo || "",
        company: props.item.company || "",
        username: props.item.username || "",
        ssn: props.item.ssn || "",
        passportNumber: props.item.passportNumber || "",
        licenseNumber: props.item.licenseNumber || "",
        address3: props.item.address3 || "",
        email: props.item.email || "",
        phone: props.item.phone || "",
        streetAddress: props.item.address?.streetAddress || "",
        apartment: props.item.address?.apartment || "",
        city: props.item.address?.city || "",
        stateProvince: props.item.address?.stateProvince || "",
        postalCode: props.item.address?.postalCode || "",
        country: props.item.address?.country || "",
        customFields: cloneCustomFields(props.item.customFields),
      });
      break;
    case "billing-address":
      Object.assign(fields, {
        fullName: props.item.fullName,
        company: props.item.company,
        streetAddress: props.item.streetAddress,
        apartment: props.item.apartment,
        city: props.item.city,
        stateProvince: props.item.stateProvince,
        postalCode: props.item.postalCode,
        country: props.item.country,
        phone: props.item.phone,
        email: props.item.email,
        isDefault: Boolean(props.item.isDefault),
        customFields: cloneCustomFields(props.item.customFields),
      });
      break;
    case "payment-account":
      Object.assign(fields, {
        paymentType: props.item.paymentType,
        paymentProvider: props.item.provider,
        accountName: props.item.accountName,
        accountHolderName: props.item.accountHolderName,
        email: props.item.email,
        phone: props.item.phone,
        username: props.item.username,
        accountId: props.item.accountId,
        maskedAccountNumber: props.item.maskedAccountNumber,
        linkedCardLast4: props.item.linkedCardLast4 || "",
        routingNumber: props.item.routingNumber,
        iban: props.item.iban,
        swiftBic: props.item.swiftBic,
        website: props.item.website,
        currency: props.item.currency,
        billingAddress: props.item.billingAddress || "",
        paymentNotes: props.item.paymentNotes || "",
        isDefault: Boolean(props.item.isDefault),
        customFields: cloneCustomFields(props.item.customFields),
      });
      break;
    case "secure-note":
      Object.assign(fields, {
        content: props.item.content,
        tags: (props.item.tags || []).join(", "),
        isMarkdown: Boolean(props.item.isMarkdown),
        customFields: cloneCustomFields(props.item.customFields),
      });
      break;
    case "totp":
      Object.assign(fields, {
        secret: props.item.secret,
        issuer: props.item.issuer || "",
        accountName: props.item.accountName || "",
        otpType: props.item.otpType || "TOTP",
        counter: String(props.item.counter ?? 0),
        pin: props.item.pin || "",
        pinLength: String(props.item.pinLength ?? ""),
        link: props.item.link || "",
        associatedApp: props.item.associatedApp || "",
        steamFingerprint: props.item.steamFingerprint || "",
        steamDeviceId: props.item.steamDeviceId || "",
        steamSerialNumber: props.item.steamSerialNumber || "",
        steamSecretEncoding: props.item.steamSharedSecretBase64
          ? "base64"
          : "base32",
        steamSharedSecretBase64: props.item.steamSharedSecretBase64 || "",
        steamId: props.item.steamId || "",
        steamAccessToken: props.item.steamAccessToken || "",
        steamRefreshToken: props.item.steamRefreshToken || "",
        steamLoginSecure: props.item.steamLoginSecure || "",
        steamRevocationCode: props.item.steamRevocationCode || "",
        steamIdentitySecret: props.item.steamIdentitySecret || "",
        steamTokenGid: props.item.steamTokenGid || "",
        steamRawJson: props.item.steamRawJson || "",
        algorithm: props.item.algorithm,
        digits: String(props.item.digits),
        period: String(props.item.period),
      });
      break;
  }
}

async function submit() {
  if (saving.value) return;
  error.value = "";
  const title = fields.title.trim();
  if (!title) return void (error.value = tr('请输入名称。'));
  if (!props.item && kind.value === "card" && !fields.number.trim())
    return void (error.value = tr('请输入银行卡号。'));
  if (!props.item && kind.value === "identity" && !fields.documentNumber.trim())
    return void (error.value = tr('请输入证件号码。'));
  if (!props.item && kind.value === "billing-address" && !fields.streetAddress.trim())
    return void (error.value = tr('请输入街道地址。'));
  if (
    !props.item && kind.value === "payment-account" &&
    ![fields.accountName, fields.accountId, fields.iban].some((value) =>
      value.trim(),
    )
  )
    return void (error.value = tr('请至少填写账号名称、账号 ID 或 IBAN。'));
  if (!props.item && kind.value === "secure-note" && !fields.content.trim())
    return void (error.value = tr('请输入笔记内容。'));
  if (kind.value === "totp" && !fields.secret.trim())
    return void (error.value = tr('请输入验证码密钥。'));
  saving.value = true;
  try { await props.saveItem(buildItem(title)); }
  catch (failure) { error.value = failure instanceof Error ? tr(failure.message) : tr('保存失败，请重试。'); }
  finally { saving.value = false; }
}

function buildItem(title: string): VaultItem {
  if (props.item && !initialProjection) throw new Error("不能安全建立原数据编辑视图，未改写原项目。");
  const candidate = buildCandidate(title);
  return props.item && initialProjection ? preserveUneditedProjection(props.item, initialProjection, candidate) : candidate;
}

function buildCandidate(title: string): VaultItem {
  const now = new Date().toISOString();
  const base = {
    ...(props.item || {}),
    id: props.item?.id || crypto.randomUUID(),
    title,
    favorite: fields.favorite,
    notes: fields.notes.trim(),
    createdAt: props.item?.createdAt || now,
    updatedAt: now,
    providerRefs: props.item?.providerRefs || providerRefs(),
    ...(["card","identity","billing-address"].includes(kind.value) ? { cardFace: fields.cardFaceEnabled ? { imageAttachmentName: fields.cardFaceName, displayMode: fields.cardFaceMode, showBrandIcon: fields.cardFaceBrand } : null } : {}),
  };
  switch (kind.value) {
    case "card":
      return {
        ...base,
        kind: "card",
        cardholderName: fields.cardholderName.trim(),
        number: fields.number.replace(/\s+/g, ""),
        expiryMonth: fields.expiryMonth.trim(),
        expiryYear: fields.expiryYear.trim(),
        securityCode: fields.securityCode.trim(),
        brand: optional(fields.brand),
        billingAddressId: optional(fields.billingAddressId),
        bankName: optional(fields.bankName),
        cardType: fields.cardType,
        billingAddress: optional(fields.billingAddress),
        nickname: optional(fields.nickname),
        validFromMonth: optional(fields.validFromMonth),
        validFromYear: optional(fields.validFromYear),
        pin: optional(fields.cardPin),
        iban: optionalCompact(fields.iban),
        swiftBic: optionalCompact(fields.swiftBic),
        routingNumber: optional(fields.routingNumber),
        accountNumber: optional(fields.cardAccountNumber),
        branchCode: optional(fields.branchCode),
        currency: optional(fields.currency.toUpperCase()),
        customerServicePhone: optional(fields.customerServicePhone),
        customFields: cleanCustomFields(),
      } satisfies CardItem;
    case "identity":
      return {
        ...base,
        kind: "identity",
        documentType: fields.documentType,
        documentTitle: fields.documentTitle,
        documentNumber: fields.documentNumber.trim(),
        firstName: fields.firstName.trim(),
        middleName: fields.middleName.trim(),
        lastName: fields.lastName.trim(),
        fullName: fields.fullName,
        birthDate: optional(fields.birthDate),
        issuedDate: optional(fields.issuedDate),
        expiryDate: optional(fields.expiryDate),
        issuedBy: optional(fields.issuedBy),
        nationality: optional(fields.nationality),
        additionalInfo: optional(fields.additionalInfo),
        company: optional(fields.company),
        username: optional(fields.username),
        ssn: optional(fields.ssn),
        passportNumber: optional(fields.passportNumber),
        licenseNumber: optional(fields.licenseNumber),
        address3: optional(fields.address3),
        email: optional(fields.email),
        phone: optional(fields.phone),
        address: {
          streetAddress: fields.streetAddress.trim(),
          apartment: fields.apartment.trim(),
          city: fields.city.trim(),
          stateProvince: fields.stateProvince.trim(),
          postalCode: fields.postalCode.trim(),
          country: fields.country.trim(),
          company: fields.company.trim(),
          email: fields.email.trim(),
          phone: fields.phone.trim(),
        },
        customFields: cleanCustomFields(),
      } satisfies IdentityItem;
    case "billing-address":
      return {
        ...base,
        kind: "billing-address",
        fullName: fields.fullName.trim(),
        company: fields.company.trim(),
        streetAddress: fields.streetAddress.trim(),
        apartment: fields.apartment.trim(),
        city: fields.city.trim(),
        stateProvince: fields.stateProvince.trim(),
        postalCode: fields.postalCode.trim(),
        country: fields.country.trim(),
        phone: fields.phone.trim(),
        email: fields.email.trim(),
        isDefault: fields.isDefault,
        customFields: cleanCustomFields(),
      } satisfies BillingAddressItem;
    case "payment-account":
      return {
        ...base,
        kind: "payment-account",
        paymentType: fields.paymentType.trim(),
        provider: fields.paymentProvider.trim(),
        accountName: fields.accountName.trim(),
        accountHolderName: fields.accountHolderName.trim(),
        email: fields.email.trim(),
        phone: fields.phone.trim(),
        username: fields.username.trim(),
        accountId: fields.accountId.trim(),
        maskedAccountNumber: fields.maskedAccountNumber.trim(),
        linkedCardLast4: optional(fields.linkedCardLast4),
        routingNumber: fields.routingNumber.trim(),
        iban: fields.iban.replace(/\s+/g, ""),
        swiftBic: fields.swiftBic.replace(/\s+/g, ""),
        website: fields.website.trim(),
        currency: fields.currency.trim().toUpperCase(),
        billingAddress: optional(fields.billingAddress),
        paymentNotes: optional(fields.paymentNotes),
        isDefault: fields.isDefault,
        customFields: cleanCustomFields(),
      } satisfies PaymentAccountItem;
    case "secure-note":
      return {
        ...base,
        kind: "secure-note",
        content: fields.content,
        tags: fields.tags
          .split(/[,，\n]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        isMarkdown: fields.isMarkdown,
        customFields: cleanCustomFields(),
      } satisfies SecureNoteItem;
    case "totp":
      return {
        ...base,
        kind: "totp",
        secret:
          fields.otpType === "MOTP" ||
          (fields.otpType === "STEAM" &&
            fields.steamSecretEncoding === "base64")
            ? fields.secret.trim()
            : fields.secret.replace(/\s+/g, "").toUpperCase(),
        issuer: optional(fields.issuer),
        accountName: optional(fields.accountName),
        otpType: fields.otpType,
        counter: normalizeOtpCounter(fields.counter),
        pin: optional(fields.pin),
        pinLength: fields.otpType === "YANDEX" && optional(fields.pinLength) ? clampNumber(fields.pinLength, 4, 4, 16) : undefined,
        link: optional(fields.link),
        associatedApp: optional(fields.associatedApp),
        steamFingerprint: optional(fields.steamFingerprint),
        steamDeviceId: optional(fields.steamDeviceId),
        steamSerialNumber: optional(fields.steamSerialNumber),
        steamSharedSecretBase64:
          fields.otpType === "STEAM" && fields.steamSecretEncoding === "base64"
            ? optional(fields.secret.trim())
            : undefined,
        steamId: optional(fields.steamId),
        steamAccessToken: optional(fields.steamAccessToken),
        steamRefreshToken: optional(fields.steamRefreshToken),
        steamLoginSecure: optional(fields.steamLoginSecure),
        steamRevocationCode: optional(fields.steamRevocationCode),
        steamIdentitySecret: optional(fields.steamIdentitySecret),
        steamTokenGid: optional(fields.steamTokenGid),
        steamRawJson:
          fields.otpType === "STEAM"
            ? optional(mergeSteamRawJson())
            : optional(fields.steamRawJson),
        algorithm: fields.algorithm,
        digits:
          fields.otpType === "STEAM" ? 5 : clampNumber(fields.digits, 6, 1, 10),
        period:
          fields.otpType === "MOTP"
            ? 10
            : clampNumber(fields.period, 30, 5, 300),
      } satisfies TotpItem;
  }
}

function providerRefs() {
  const provider = props.providers.find(
    (candidate) => candidate.id === fields.providerId,
  );
  return provider && provider.kind !== "local"
    ? [{ providerId: provider.id }]
    : [];
}

function defaultProviderId() {
  return (
    eligibleProviders.value.find((provider) => provider.isDefaultSaveTarget)
      ?.id ||
    eligibleProviders.value.find((provider) => provider.kind === "local")?.id ||
    eligibleProviders.value[0]?.id ||
    ""
  );
}

function providerSupportsKind(
  provider: ProviderAccount,
  itemKind: EditableVaultKind,
): boolean {
  if (provider.kind !== "bitwarden") return true;
  return (
    itemKind === "card" || itemKind === "identity" || itemKind === "secure-note"
  );
}

function isEditableKind(value: string): value is EditableVaultKind {
  return (
    value === "card" ||
    value === "identity" ||
    value === "billing-address" ||
    value === "payment-account" ||
    value === "secure-note" ||
    value === "totp"
  );
}
function optional(value: string) {
  return value.trim() || undefined;
}
function optionalCompact(value: string) {
  return value.replace(/\s+/g, "") || undefined;
}
function clampNumber(
  value: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.round(parsed)))
    : fallback;
}

function emptyFields() {
  return {
    cardFaceEnabled: false,
    cardFaceName: "",
    cardFaceMode: "ALL" as "ALL" | "CARD_NUMBER_ONLY" | "HIDDEN",
    cardFaceBrand: true,
    documentTitle: "",
    title: "",
    notes: "",
    favorite: false,
    providerId: "",
    cardholderName: "",
    number: "",
    expiryMonth: "",
    expiryYear: "",
    securityCode: "",
    brand: "",
    billingAddressId: "",
    bankName: "",
    cardType: "CREDIT" as NonNullable<CardItem["cardType"]>,
    billingAddress: "",
    nickname: "",
    validFromMonth: "",
    validFromYear: "",
    cardPin: "",
    cardAccountNumber: "",
    branchCode: "",
    customerServicePhone: "",
    documentType: "OTHER" as IdentityItem["documentType"],
    documentNumber: "",
    firstName: "",
    middleName: "",
    lastName: "",
    fullName: "",
    birthDate: "",
    issuedDate: "",
    expiryDate: "",
    issuedBy: "",
    nationality: "",
    additionalInfo: "",
    ssn: "",
    passportNumber: "",
    licenseNumber: "",
    address3: "",
    company: "",
    streetAddress: "",
    apartment: "",
    city: "",
    stateProvince: "",
    postalCode: "",
    country: "",
    phone: "",
    email: "",
    paymentType: "",
    paymentProvider: "",
    accountName: "",
    accountHolderName: "",
    username: "",
    accountId: "",
    maskedAccountNumber: "",
    linkedCardLast4: "",
    routingNumber: "",
    iban: "",
    swiftBic: "",
    website: "",
    currency: "",
    paymentNotes: "",
    isDefault: false,
    customFields: [] as Array<{
      name: string;
      value: string;
      fieldType: "TEXT" | "HIDDEN" | "BOOLEAN";
      protected: boolean;
    }>,
    content: "",
    tags: "",
    isMarkdown: false,
    secret: "",
    issuer: "",
    otpType: "TOTP" as NonNullable<TotpItem["otpType"]>,
    counter: "0",
    pin: "",
    pinLength: "",
    link: "",
    associatedApp: "",
    steamFingerprint: "",
    steamDeviceId: "",
    steamSerialNumber: "",
    steamSecretEncoding: "base64" as "base32" | "base64",
    steamSharedSecretBase64: "",
    steamId: "",
    steamAccessToken: "",
    steamRefreshToken: "",
    steamLoginSecure: "",
    steamRevocationCode: "",
    steamIdentitySecret: "",
    steamTokenGid: "",
    steamRawJson: "",
    algorithm: "SHA1" as TotpItem["algorithm"],
    digits: "6",
    period: "30",
  };
}

function cloneCustomFields(
  value: CardItem["customFields"] | IdentityItem["customFields"],
) {
  return (value || []).map((field) => ({
    ...field,
    fieldType:
      field.fieldType ||
      (field.protected ? ("HIDDEN" as const) : ("TEXT" as const)),
  }));
}
function cleanCustomFields() {
  return fields.customFields
    .map((field) => ({
      ...field,
      name: field.name,
      value: field.value,
      fieldType: field.fieldType,
      protected: field.fieldType === "HIDDEN",
    }))
    .filter((field) => field.name);
}
function addCustomField() {
  fields.customFields.push({
    name: "",
    value: "",
    fieldType: "TEXT",
    protected: false,
  });
}
function removeCustomField(index: number) {
  fields.customFields.splice(index, 1);
}

function mergeSteamRawJson(): string {
  return exportSteamMaFile({
    ...(props.item?.kind === "totp" ? props.item : {}), id: props.item?.id || "draft", kind: "totp", title: fields.title, notes: fields.notes, favorite: fields.favorite,
    createdAt: props.item?.createdAt || "", updatedAt: props.item?.updatedAt || "", providerRefs: props.item?.providerRefs || [],
    secret: fields.secret, steamSharedSecretBase64: fields.steamSecretEncoding === "base64" ? fields.secret : undefined, algorithm: fields.algorithm, digits: Number(fields.digits), period: Number(fields.period),
    accountName: fields.accountName, steamId: fields.steamId, steamDeviceId: fields.steamDeviceId, steamIdentitySecret: fields.steamIdentitySecret,
    steamRevocationCode: fields.steamRevocationCode, steamTokenGid: fields.steamTokenGid, steamAccessToken: fields.steamAccessToken, steamRefreshToken: fields.steamRefreshToken,
    steamLoginSecure: fields.steamLoginSecure, steamRawJson: fields.steamRawJson
  });
}

function applyOtpTransfer() {
  otpTransferStatus.value = "";
  try {
    const results = parseOtpUris(otpTransferInput.value);
    if (results.length !== 1)
      throw new Error(tr('二维码包含 {0} 个验证器，请逐项导入。', { 0: results.length }));
    const value = results[0].parameters;
    Object.assign(fields, {
      secret: value.secret,
      issuer: value.issuer || "",
      accountName: value.accountName || "",
      otpType: value.otpType || "TOTP",
      counter: String(value.counter || 0),
      pin: value.pin || "",
      pinLength: String(value.pinLength ?? ""),
      algorithm: value.algorithm,
      digits: String(value.digits),
      period: String(value.period),
      steamSecretEncoding: value.secretEncoding || "base32",
    });
    otpTransferStatus.value = tr('OTP URI 已解析，请核对后保存。');
  } catch (failure) {
    otpTransferStatus.value =
      failure instanceof Error ? failure.message : tr('无法解析 OTP URI。');
  }
}

async function importOtpQr(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    otpTransferInput.value = await decodeOtpQrImage(file);
    applyOtpTransfer();
  } catch (failure) {
    otpTransferStatus.value =
      failure instanceof Error ? failure.message : tr('无法识别二维码。');
  }
  (event.target as HTMLInputElement).value = "";
}

async function exportOtpQr() {
  try {
    const item = buildItem(fields.title.trim() || "OTP");
    if (item.kind !== "totp") return;
    const uri = generateOtpUri(
      {
        secret: item.secret,
        algorithm: item.algorithm,
        digits: item.digits,
        period: item.period,
        otpType: item.otpType,
        counter: item.counter,
        pin: item.pin,
        pinLength: item.pinLength,
        issuer: item.issuer,
        accountName: item.accountName,
        secretEncoding:
          item.otpType === "STEAM" && item.steamSharedSecretBase64
            ? "base64"
            : "base32",
      },
      [item.issuer, item.accountName].filter(Boolean).join(":") || item.title,
    );
    otpTransferInput.value = uri;
    otpQrDataUrl.value = await createOtpQrDataUrl(uri);
    otpTransferStatus.value = tr('二维码已在本机生成。');
  } catch (failure) {
    otpTransferStatus.value =
      failure instanceof Error ? failure.message : tr('无法生成二维码。');
  }
}

async function importMaFile(event: Event) {
  const files = [...((event.target as HTMLInputElement).files || [])];
  const file = files[0];
  if (!file) return;
  try {
    const contents = await Promise.all(files.map(async (entry) => ({ name: entry.name, content: await entry.text() })));
    const maFileContent = contents.find((entry) => /\.mafile(?:\.json)?$/i.test(entry.name))?.content || contents.find((entry) => !/manifest\.json$/i.test(entry.name))?.content || "";
    const password = maFileContent.trim().startsWith("{") ? "" : (window.prompt(tr('请输入 Android 加密 maFile 密码')) || "");
    const value = await parseSteamMaFileBundle(contents, password);
    Object.assign(fields, {
      title: fields.title || value.accountName,
      accountName: value.accountName,
      secret: value.sharedSecretBase64,
      steamSecretEncoding: "base64",
      steamSharedSecretBase64: value.sharedSecretBase64,
      steamId: value.steamId || "",
      steamDeviceId: value.deviceId || "",
      steamIdentitySecret: value.identitySecret || "",
      steamRevocationCode: value.revocationCode || "",
      steamTokenGid: value.tokenGid || "",
      steamAccessToken: value.accessToken || "",
      steamRefreshToken: value.refreshToken || "",
      steamLoginSecure: value.steamLoginSecure || "",
      steamRawJson: value.rawJson,
    });
    otpTransferStatus.value = tr('maFile 已解析，未知字段会保留。');
  } catch (failure) {
    otpTransferStatus.value =
      failure instanceof Error ? failure.message : tr('无法导入 maFile。');
  }
  (event.target as HTMLInputElement).value = "";
}

function exportMaFile() {
  const item = buildItem(
    fields.title.trim() || fields.accountName.trim() || "Steam",
  );
  if (item.kind !== "totp") return;
  const blob = new Blob([exportSteamMaFile(item)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${item.steamId || item.accountName || "steam"}.maFile`;
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <m3e-dialog v-material-dialog open class="material-dialog material-editor-dialog" :disableClose.prop="saving" :dismissible="!saving" :close-label="tr('关闭')" @closed.self="emit('cancel')">
<h2 slot="header" id="vault-item-editor-title">
            {{
              item ? tr('编辑{0}', { 0: itemKindLabel(kind) }) : tr('添加{0}', { 0: itemKindLabel(kind) })
            }}
          </h2>
<form id="vault-item-form" class="material-editor-form editor-form editor-with-actions" @submit.prevent="submit">
        <div class="editor-fields vault-item-form structured-editor"><section class="editor-section editor-basics" :aria-label="tr('基本信息')"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field editor-title-field"><label slot="label">{{ tr('名称 *') }}</label><input v-model="fields.title" autofocus autocomplete="off" /></m3e-form-field><div class="editor-meta-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker v-if="!item" class="field"
          ><label slot="label">{{ tr('项目类型') }}</label><component :is="materialSelectTag" @input="kind = ($event.target as HTMLElement &amp; { value: string }).value" >
            <component :is="materialOptionTag" :selected.prop="String(kind ?? '') === String('card')" value="card">{{ tr('银行卡') }}</component>
            <component :is="materialOptionTag" :selected.prop="String(kind ?? '') === String('identity')" value="identity">{{ tr('证件') }}</component>
            <component :is="materialOptionTag" :selected.prop="String(kind ?? '') === String('billing-address')" value="billing-address">{{ tr('账单地址') }}</component>
            <component :is="materialOptionTag" :selected.prop="String(kind ?? '') === String('payment-account')" value="payment-account">{{ tr('支付账号') }}</component>
            <component :is="materialOptionTag" :selected.prop="String(kind ?? '') === String('secure-note')" value="secure-note">{{ tr('安全笔记') }}</component>
            <component :is="materialOptionTag" :selected.prop="String(kind ?? '') === String('totp')" value="totp">{{ tr('动态验证码') }}</component>
          </component></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker hide-subscript="never" class="field"
          ><label slot="label">{{ tr('保存到') }}</label><component :is="materialSelectTag" @input="fields.providerId = ($event.target as HTMLElement &amp; { value: string }).value"  :disabled="Boolean(item)">
            <component :is="materialOptionTag" :selected.prop="String(fields.providerId ?? '') === String(provider.id)"
              v-for="provider in eligibleProviders"
              :key="provider.id"
              :value="provider.id"
            >
              {{ provider.kind === 'local' ? tr('Monica 本地库') : provider.name }}
            </component></component><small slot="hint"
            v-if="
              kind === 'billing-address' ||
              kind === 'payment-account' ||
              kind === 'totp'
            "
            >{{ tr('Bitwarden 不支持该独立记录类型，因此不会显示为目标。') }}</small
          ></m3e-form-field></div></section><section v-if="kind === 'card'" class="editor-section"><h3>{{ tr('银行卡信息') }}</h3><div class="editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('持卡人') }}</label><input
              v-model="fields.cardholderName"
              autocomplete="cc-name" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('卡组织') }}</label><input v-model="fields.brand" autocomplete="cc-type" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
            ><label slot="label">{{ tr('银行卡号 *') }}</label><input
              v-model="fields.number"
              inputmode="numeric"
              autocomplete="cc-number" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('到期月') }}</label><input
              v-model="fields.expiryMonth"
              inputmode="numeric"
              autocomplete="cc-exp-month" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('到期年') }}</label><input
              v-model="fields.expiryYear"
              inputmode="numeric"
              autocomplete="cc-exp-year" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('安全码') }}</label><input
              v-model="fields.securityCode"
              type="password"
              inputmode="numeric"
              autocomplete="cc-csc" /></m3e-form-field></div><m3e-expansion-panel class="editor-disclosure field-wide" :open="false"><span slot="header"><span>{{ tr('更多银行卡信息') }}</span></span><div class="editor-disclosure-body editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('银行') }}</label><input v-model="fields.bankName" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('卡类型') }}</label><component :is="materialSelectTag" @input="fields.cardType = ($event.target as HTMLElement &amp; { value: string }).value" >
              <component :is="materialOptionTag" :selected.prop="String(fields.cardType ?? '') === String('CREDIT')" value="CREDIT">{{ tr('信用卡') }}</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.cardType ?? '') === String('DEBIT')" value="DEBIT">{{ tr('借记卡') }}</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.cardType ?? '') === String('PREPAID')" value="PREPAID">{{ tr('预付卡') }}</component>
            </component></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('昵称') }}</label><input v-model="fields.nickname" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">PIN</label><input
              v-model="fields.cardPin"
              type="password"
              inputmode="numeric" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('生效月') }}</label><input
              v-model="fields.validFromMonth"
              inputmode="numeric" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('生效年') }}</label><input v-model="fields.validFromYear" inputmode="numeric" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">IBAN</label><input v-model="fields.iban" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">SWIFT/BIC</label><input v-model="fields.swiftBic" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('路由号码') }}</label><input v-model="fields.routingNumber" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('账户号码') }}</label><input v-model="fields.cardAccountNumber" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('分行代码') }}</label><input v-model="fields.branchCode" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('币种') }}</label><input v-model="fields.currency" maxlength="3" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('客服电话') }}</label><input v-model="fields.customerServicePhone" type="tel" /></m3e-form-field>
<BillingAddressFields v-model="fields.billingAddress" /></div></m3e-expansion-panel></section>
<section v-if="kind === 'identity'" class="editor-section"><h3>{{ tr('身份信息') }}</h3><div class="editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('证件类型') }}</label><component :is="materialSelectTag" @input="fields.documentType = ($event.target as HTMLElement &amp; { value: string }).value" >
              <component :is="materialOptionTag" :selected.prop="String(fields.documentType ?? '') === String('ID_CARD')" value="ID_CARD">{{ tr('身份证') }}</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.documentType ?? '') === String('PASSPORT')" value="PASSPORT">{{ tr('护照') }}</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.documentType ?? '') === String('DRIVER_LICENSE')" value="DRIVER_LICENSE">{{ tr('驾驶证') }}</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.documentType ?? '') === String('SOCIAL_SECURITY')" value="SOCIAL_SECURITY">{{ tr('社会保障号') }}</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.documentType ?? '') === String('OTHER')" value="OTHER">{{ tr('其他证件') }}</component>
            </component></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('证件号码 *') }}</label><input v-model="fields.documentNumber" autocomplete="off" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('完整姓名') }}</label><input v-model="fields.fullName" autocomplete="name" /></m3e-form-field></div><m3e-expansion-panel class="editor-disclosure field-wide" :open="false"><span slot="header"><span>{{ tr('更多身份信息') }}</span></span><div class="editor-disclosure-body editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('名') }}</label><input
              v-model="fields.firstName"
              autocomplete="given-name" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('中间名') }}</label><input
              v-model="fields.middleName"
              autocomplete="additional-name" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('姓') }}</label><input
              v-model="fields.lastName"
              autocomplete="family-name" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('出生日期') }}</label><input
              v-model="fields.birthDate"
              type="date"
              autocomplete="bday" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('国籍') }}</label><input
              v-model="fields.nationality"
              autocomplete="country-name" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('签发日期') }}</label><input v-model="fields.issuedDate" type="date" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('到期日期') }}</label><input v-model="fields.expiryDate" type="date" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('签发机关') }}</label><input v-model="fields.issuedBy" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('邮箱') }}</label><input
              v-model="fields.email"
              type="email"
              autocomplete="email" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('电话') }}</label><input
              v-model="fields.phone"
              type="tel"
              autocomplete="tel" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
            ><label slot="label">{{ tr('街道地址') }}</label><input
              v-model="fields.streetAddress"
              autocomplete="street-address" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('城市') }}</label><input
              v-model="fields.city"
              autocomplete="address-level2" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('省/州') }}</label><input
              v-model="fields.stateProvince"
              autocomplete="address-level1" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('邮编') }}</label><input
              v-model="fields.postalCode"
              autocomplete="postal-code" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('国家') }}</label><input
              v-model="fields.country"
              autocomplete="country-name" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('公司') }}</label><input v-model="fields.company" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('用户名') }}</label><input v-model="fields.username" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('社会保障号') }}</label><input v-model="fields.ssn" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('护照号码') }}</label><input v-model="fields.passportNumber" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('驾驶证号码') }}</label><input v-model="fields.licenseNumber" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('地址第三行') }}</label><input v-model="fields.address3" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
            ><label slot="label">{{ tr('其他信息') }}</label><textarea
              v-model="fields.additionalInfo"
              rows="3"
            ></textarea></m3e-form-field></div></m3e-expansion-panel></section>
<section v-if="kind === 'billing-address'" class="editor-section"><h3>{{ tr('地址信息') }}</h3><div class="editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('收件人') }}</label><input v-model="fields.fullName" autocomplete="name" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('公司') }}</label><input
              v-model="fields.company"
              autocomplete="organization" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
            ><label slot="label">{{ tr('街道地址 *') }}</label><input
              v-model="fields.streetAddress"
              autocomplete="street-address" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('公寓/房间') }}</label><input
              v-model="fields.apartment"
              autocomplete="address-line2" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('城市') }}</label><input
              v-model="fields.city"
              autocomplete="address-level2" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('省/州') }}</label><input
              v-model="fields.stateProvince"
              autocomplete="address-level1" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('邮编') }}</label><input
              v-model="fields.postalCode"
              autocomplete="postal-code" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('国家') }}</label><input
              v-model="fields.country"
              autocomplete="country-name" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('电话') }}</label><input
              v-model="fields.phone"
              type="tel"
              autocomplete="tel" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('邮箱') }}</label><input
              v-model="fields.email"
              type="email"
              autocomplete="email" /></m3e-form-field></div></section>
<section v-if="kind === 'payment-account'" class="editor-section"><h3>{{ tr('支付信息') }}</h3><div class="editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('支付类型') }}</label><input
              v-model="fields.paymentType"
              placeholder="BANK / PAYPAL / ALIPAY" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('服务商') }}</label><input v-model="fields.paymentProvider" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('账号名称') }}</label><input v-model="fields.accountName" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('账户持有人') }}</label><input v-model="fields.accountHolderName" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('账号 ID') }}</label><input v-model="fields.accountId" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('显示账号') }}</label><input
              v-model="fields.maskedAccountNumber"
              placeholder="**** 7890" /></m3e-form-field></div><m3e-expansion-panel class="editor-disclosure field-wide" :open="false"><span slot="header"><span>{{ tr('更多支付信息') }}</span></span><div class="editor-disclosure-body editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('路由号码') }}</label><input v-model="fields.routingNumber" inputmode="numeric" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">IBAN</label><input v-model="fields.iban" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">SWIFT/BIC</label><input v-model="fields.swiftBic" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('币种') }}</label><input v-model="fields.currency" maxlength="3" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('用户名') }}</label><input v-model="fields.username" autocomplete="username" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('邮箱') }}</label><input
              v-model="fields.email"
              type="email"
              autocomplete="email" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('电话') }}</label><input
              v-model="fields.phone"
              type="tel"
              autocomplete="tel" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('网站') }}</label><input
              v-model="fields.website"
              type="url"
              autocomplete="url" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('关联卡尾号') }}</label><input
              v-model="fields.linkedCardLast4"
              maxlength="4"
              inputmode="numeric" /></m3e-form-field>
<label v-choice-label class="favorite-row"
            ><m3e-checkbox :checked.prop="fields.isDefault" @input="fields.isDefault = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span
              >{{ tr('设为默认支付账户') }}</span
            ></label
          >
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
            ><label slot="label">{{ tr('账单地址 JSON') }}</label><textarea
              v-model="fields.billingAddress"
              rows="3"
            ></textarea></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
            ><label slot="label">{{ tr('支付账户备注') }}</label><textarea v-model="fields.paymentNotes" rows="3"></textarea></m3e-form-field></div></m3e-expansion-panel></section>
<section v-if="kind === 'secure-note'" class="editor-section"><h3>{{ tr('笔记内容') }}</h3><div class="editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
            ><label slot="label">{{ tr('笔记内容 *') }}</label><textarea v-model="fields.content" rows="12"></textarea></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
            ><label slot="label">{{ tr('标签') }}</label><input v-model="fields.tags" :placeholder="tr('工作, 项目')" /></m3e-form-field>
<label v-choice-label class="favorite-row field-wide"
            ><m3e-checkbox :checked.prop="fields.isMarkdown" @input="fields.isMarkdown = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span
              >{{ tr('使用 Markdown') }}</span
            ></label
          ></div></section>
<section v-if="kind === 'totp'" class="editor-section"><h3>{{ tr('验证器信息') }}</h3><div class="editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('验证码类型') }}</label><component :is="materialSelectTag" @input="fields.otpType = ($event.target as HTMLElement &amp; { value: string }).value" >
              <component :is="materialOptionTag" :selected.prop="String(fields.otpType ?? '') === String('TOTP')" value="TOTP">TOTP</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.otpType ?? '') === String('HOTP')" value="HOTP">HOTP</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.otpType ?? '') === String('STEAM')" value="STEAM">Steam Guard</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.otpType ?? '') === String('YANDEX')" value="YANDEX">Yandex</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.otpType ?? '') === String('MOTP')" value="MOTP">mOTP</component>
            </component></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker v-if="fields.otpType === 'STEAM'" class="field"
            ><label slot="label">{{ tr('Steam 密钥编码') }}</label><component :is="materialSelectTag" @input="fields.steamSecretEncoding = ($event.target as HTMLElement &amp; { value: string }).value" >
              <component :is="materialOptionTag" :selected.prop="String(fields.steamSecretEncoding ?? '') === String('base64')" value="base64">Base64（maFile / Android）</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.steamSecretEncoding ?? '') === String('base32')" value="base32">Base32（OTP URI）</component>
            </component></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker hide-subscript="never" class="field field-wide"
            ><label slot="label"
              >{{
                fields.otpType === "STEAM"
                  ? "Steam Shared Secret"
                  : fields.otpType === "MOTP"
                    ? tr('mOTP 原始密钥')
                    : tr('Base32 密钥')
              }}
              *</label><input
              v-model="fields.secret"
              type="password"
              autocomplete="off"
            /><small slot="hint">{{ tr('密钥只保存在加密密码库中；二维码在本机生成。') }}</small></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('签发方') }}</label><input v-model="fields.issuer" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
            ><label slot="label">{{ tr('账户') }}</label><input v-model="fields.accountName"
          /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker v-if="fields.otpType === 'HOTP'" class="field"
            ><label slot="label">{{ tr('计数器') }}</label><input v-model="fields.counter" type="text" inputmode="numeric" pattern="[0-9]+" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker
            v-if="fields.otpType === 'MOTP' || fields.otpType === 'YANDEX'"
            class="field"
            ><label slot="label">PIN {{ fields.otpType === "YANDEX" ? tr('（4-16 位数字）') : "" }}</label><input
              v-model="fields.pin"
              type="password"
              inputmode="numeric"
              autocomplete="off"
          /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker v-if="fields.otpType === 'YANDEX'" class="field"
            ><label slot="label">{{ tr('PIN 长度') }}</label><input v-model="fields.pinLength" type="number" min="4" max="16" inputmode="numeric"
          /></m3e-form-field></div><m3e-expansion-panel class="editor-disclosure field-wide" :open="false"><span slot="header"><span>{{ tr('导入与导出验证器') }}</span></span><div class="editor-disclosure-body editor-field-grid"><fieldset class="editor-fieldset field-wide otp-transfer">
            <legend>{{ tr('二维码与 URI') }}</legend>
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
              ><label slot="label">OTP URI</label><textarea
                v-model="otpTransferInput"
                rows="3"
                :placeholder="tr('otpauth://、motp:// 或 migration URI')"
              ></textarea>
            </m3e-form-field>
            <div class="otp-transfer-actions">
              <m3e-button
                variant="tonal"
                type="button"
                @click="applyOtpTransfer"
                ><m3e-icon slot="icon" name="input"></m3e-icon>{{ tr('解析 URI') }}</m3e-button
              ><label class="file-action"
                ><m3e-icon name="qr_code_scanner"></m3e-icon
                ><span>{{ tr('识别二维码图片') }}</span
                ><input
                  type="file"
                  accept="image/*"
                  @change="importOtpQr" /></label
              ><m3e-button variant="text" type="button" @click="exportOtpQr"
                ><m3e-icon slot="icon" name="qr_code_2"></m3e-icon
                >{{ tr('生成二维码') }}</m3e-button
              >
            </div>
            <img
              v-if="otpQrDataUrl"
              class="otp-qr-preview"
              :src="otpQrDataUrl"
              :alt="tr('当前验证器的 OTP 二维码')"
              width="240"
              height="240"
            />
            <p v-if="otpTransferStatus" class="supporting" aria-live="polite">
              {{ otpTransferStatus }}
            </p>
          </fieldset></div></m3e-expansion-panel><m3e-expansion-panel class="editor-disclosure field-wide" :open="false"><span slot="header"><span>{{ tr('验证器高级设置') }}</span></span><div class="editor-disclosure-body editor-field-grid"><m3e-form-field v-field-label variant="filled" hide-required-marker
            v-if="fields.otpType !== 'STEAM' && fields.otpType !== 'MOTP'"
            class="field"
            ><label slot="label">{{ tr('算法') }}</label><component :is="materialSelectTag" @input="fields.algorithm = ($event.target as HTMLElement &amp; { value: string }).value" >
              <component :is="materialOptionTag" :selected.prop="String(fields.algorithm ?? '') === String('SHA1')">SHA1</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.algorithm ?? '') === String('SHA256')">SHA256</component>
              <component :is="materialOptionTag" :selected.prop="String(fields.algorithm ?? '') === String('SHA512')">SHA512</component>
            </component></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker
            v-if="fields.otpType !== 'STEAM' && fields.otpType !== 'MOTP'"
            class="field"
            ><label slot="label">{{ tr('位数') }}</label><input
              v-model="fields.digits"
              type="number"
              min="1"
              max="10" /></m3e-form-field>
<m3e-form-field v-field-label variant="filled" hide-required-marker
            v-if="fields.otpType === 'TOTP' || fields.otpType === 'YANDEX'"
            class="field"
            ><label slot="label">{{ tr('周期（秒）') }}</label><input v-model="fields.period" type="number" min="5" max="300"
          /></m3e-form-field>
<template v-if="fields.otpType === 'STEAM'"
            ><div class="steam-file-actions field-wide">
              <label class="file-action"
                ><m3e-icon name="upload_file"></m3e-icon><span>{{ tr('导入 maFile') }}</span
                ><input
                  type="file"
                  accept="application/json,.maFile,.json"
                  multiple
                  @change="importMaFile" /></label
              ><m3e-button variant="tonal" type="button" @click="exportMaFile"
                ><m3e-icon slot="icon" name="download"></m3e-icon>{{ tr('导出 maFile') }}</m3e-button
              >
            </div>
            <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
              ><label slot="label">SteamID64</label><input v-model="fields.steamId" inputmode="numeric" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
              ><label slot="label">{{ tr('Steam 设备 ID') }}</label><input v-model="fields.steamDeviceId" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
              ><label slot="label">{{ tr('Steam 指纹') }}</label><input v-model="fields.steamFingerprint" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
              ><label slot="label">{{ tr('Steam 序列号') }}</label><input v-model="fields.steamSerialNumber" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
              ><label slot="label">{{ tr('撤销代码') }}</label><input v-model="fields.steamRevocationCode" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
              ><label slot="label">Identity Secret</label><input
                v-model="fields.steamIdentitySecret"
                type="password" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"
              ><label slot="label">Token GID</label><input v-model="fields.steamTokenGid" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
              ><label slot="label">Access Token</label><textarea
                v-model="fields.steamAccessToken"
                rows="2"
                autocomplete="off"
              ></textarea></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
              ><label slot="label">Refresh Token</label><textarea
                v-model="fields.steamRefreshToken"
                rows="2"
                autocomplete="off"
              ></textarea></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
              ><label slot="label">Steam Login Secure</label><input
                v-model="fields.steamLoginSecure"
                type="password"
                autocomplete="off" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker hide-subscript="never" class="field field-wide"
              ><label slot="label">{{ tr('原始 Steam JSON') }}</label><textarea v-model="fields.steamRawJson" rows="4"></textarea
              ><small slot="hint"
                >{{ tr('未知字段保持原样，用于 Monica Android 与 maFile 写回。') }}</small
              ></m3e-form-field></template
          ></div></m3e-expansion-panel></section>
<section v-if="['card','identity','billing-address'].includes(kind)" class="editor-section"><h3>卡面与附件</h3><WalletCardFace :item="buildCandidate(fields.title)" :owner="props.item" /><label v-choice-label><m3e-checkbox :checked.prop="fields.cardFaceEnabled" @input="fields.cardFaceEnabled=($event.target as any).checked"/><span>使用卡面图片</span></label><template v-if="fields.cardFaceEnabled"><CardFaceImagePicker v-model="fields.cardFaceName" :owner="props.item" :providers="props.providers" /><m3e-form-field v-field-label variant="filled"><label slot="label">卡面显示模式</label><component :is="materialSelectTag" @input="fields.cardFaceMode=($event.target as any).value"><component :is="materialOptionTag" v-for="mode in ['ALL','CARD_NUMBER_ONLY','HIDDEN']" :key="mode" :value="mode" :selected.prop="fields.cardFaceMode===mode">{{({ALL:'显示全部',CARD_NUMBER_ONLY:'只显示卡号',HIDDEN:'隐藏信息'} as any)[mode]}}</component></component></m3e-form-field><label v-choice-label><m3e-checkbox :checked.prop="fields.cardFaceBrand" @input="fields.cardFaceBrand=($event.target as any).checked"/><span>显示卡组织图标</span></label></template></section>
<section v-if="kind==='identity'" class="editor-section"><m3e-form-field v-field-label variant="filled"><label slot="label">人物称谓</label><input v-model="fields.documentTitle" autocomplete="off"/></m3e-form-field></section>
<section class="editor-section editor-extras" :aria-label="tr('补充信息')"><h3>{{ tr('补充信息') }}</h3><m3e-expansion-panel
          v-if="
            kind === 'card' ||
            kind === 'identity' ||
            kind === 'billing-address' ||
            kind === 'payment-account' ||
            kind === 'secure-note'
          "
          class="editor-disclosure" :open="fields.customFields.length > 0"
        >
          <span slot="header"><span>{{ tr('自定义字段') }}<small>{{ fields.customFields.length || tr('可选') }}</small></span></span><div class="editor-disclosure-body">
          <div class="custom-field-list">
            <div
              v-for="(custom, index) in fields.customFields"
              :key="index"
              class="custom-field-row"
            >
              <m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('自定义字段 {0} 名称', { 0: index + 1 }) }}</label><input
                v-model="custom.name"
                :aria-label="tr('自定义字段 {0} 名称', { 0: index + 1 })"
                :placeholder="tr('字段名称')"
              /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('自定义字段 {0} 值', { 0: index + 1 }) }}</label><input
                v-model="custom.value"
                :type="custom.fieldType === 'HIDDEN' ? 'password' : 'text'"
                :aria-label="tr('自定义字段 {0} 值', { 0: index + 1 })"
                :placeholder="tr('字段值')"
              /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('自定义字段 {0} 类型', { 0: index + 1 }) }}</label><component :is="materialSelectTag" @input="custom.fieldType = ($event.target as HTMLElement &amp; { value: string }).value"

                :aria-label="tr('自定义字段 {0} 类型', { 0: index + 1 })"
              >
                <component :is="materialOptionTag" :selected.prop="String(custom.fieldType ?? '') === String('TEXT')" value="TEXT">{{ tr('文本') }}</component>
                <component :is="materialOptionTag" :selected.prop="String(custom.fieldType ?? '') === String('HIDDEN')" value="HIDDEN">{{ tr('隐藏') }}</component>
                <component :is="materialOptionTag" :selected.prop="String(custom.fieldType ?? '') === String('BOOLEAN')" value="BOOLEAN">{{ tr('布尔') }}</component></component></m3e-form-field><m3e-icon-button
                type="button"
                :aria-label="tr('删除自定义字段 {0}', { 0: index + 1 })"
                @click="removeCustomField(index)"
                ><m3e-icon name="delete"></m3e-icon
              ></m3e-icon-button>
            </div>
          </div>
          <m3e-button variant="text" type="button" @click="addCustomField"
            ><m3e-icon slot="icon" name="add"></m3e-icon>{{ tr('添加字段') }}</m3e-button
          >
        </div></m3e-expansion-panel><div v-if="item?.imagePaths?.length" class="boundary-row field-wide">
          <m3e-icon name="image"></m3e-icon
          ><span
            >{{ tr('{0} 个 Android 图片引用已保留；图片字节继续保存在同步信封中。', { 0: item.imagePaths.length }) }}</span
          >
        </div><m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"
          ><label slot="label">{{ tr('备注') }}</label><textarea v-model="fields.notes" rows="3"></textarea>
        </m3e-form-field><label v-choice-label class="favorite-row field-wide"
          ><m3e-checkbox :checked.prop="fields.favorite" @input="fields.favorite = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span
            >{{ tr('收藏并优先显示') }}</span
          ></label
        ></section></div>

      </form>
<footer slot="actions" end class="field-wide"><p v-if="error" class="form-error editor-footer-status" role="alert">{{ error }}</p>
          <m3e-button variant="text" type="button" :disabled="saving" @click="emit('cancel')"
            >{{ tr('取消') }}</m3e-button
          ><m3e-button form="vault-item-form" variant="filled" type="submit" :disabled="saving">{{ saving ? tr('正在保存…') : tr('加密保存') }}</m3e-button>
        </footer>
</m3e-dialog>
</template>
