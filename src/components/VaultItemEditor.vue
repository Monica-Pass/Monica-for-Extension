<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { BillingAddressItem, CardItem, IdentityItem, PaymentAccountItem, ProviderAccount, SecureNoteItem, TotpItem, VaultItem } from "../core/model";
import { itemKindLabel } from "../manager/item-metadata";

export type EditableVaultKind = "card" | "identity" | "billing-address" | "payment-account" | "secure-note" | "totp";

const props = defineProps<{ item?: VaultItem; initialKind: EditableVaultKind; providers: ProviderAccount[] }>();
const emit = defineEmits<{ cancel: []; save: [item: VaultItem] }>();

const kind = ref<EditableVaultKind>(props.item && isEditableKind(props.item.kind) ? props.item.kind : props.initialKind);
const error = ref("");
const fields = reactive(emptyFields());

const eligibleProviders = computed(() => props.providers.filter((provider) => provider.enabled && providerSupportsKind(provider, kind.value)));

watch(kind, () => {
  if (!eligibleProviders.value.some((provider) => provider.id === fields.providerId)) fields.providerId = defaultProviderId();
});

initialize();

function initialize() {
  Object.assign(fields, emptyFields());
  fields.providerId = props.item?.providerRefs[0]?.providerId || defaultProviderId();
  if (!props.item) return;
  fields.title = props.item.title;
  fields.notes = props.item.notes;
  fields.favorite = props.item.favorite;
  switch (props.item.kind) {
    case "card": Object.assign(fields, { cardholderName: props.item.cardholderName, number: props.item.number, expiryMonth: props.item.expiryMonth, expiryYear: props.item.expiryYear, securityCode: props.item.securityCode, brand: props.item.brand || "", billingAddressId: props.item.billingAddressId || "" }); break;
    case "identity": Object.assign(fields, { documentType: props.item.documentType, documentNumber: props.item.documentNumber, firstName: props.item.firstName, middleName: props.item.middleName, lastName: props.item.lastName, fullName: props.item.fullName, birthDate: props.item.birthDate || "", issuedDate: props.item.issuedDate || "", expiryDate: props.item.expiryDate || "", issuedBy: props.item.issuedBy || "", nationality: props.item.nationality || "", email: props.item.email || "", phone: props.item.phone || "", streetAddress: props.item.address?.streetAddress || "", apartment: props.item.address?.apartment || "", city: props.item.address?.city || "", stateProvince: props.item.address?.stateProvince || "", postalCode: props.item.address?.postalCode || "", country: props.item.address?.country || "" }); break;
    case "billing-address": Object.assign(fields, { fullName: props.item.fullName, company: props.item.company, streetAddress: props.item.streetAddress, apartment: props.item.apartment, city: props.item.city, stateProvince: props.item.stateProvince, postalCode: props.item.postalCode, country: props.item.country, phone: props.item.phone, email: props.item.email }); break;
    case "payment-account": Object.assign(fields, { paymentType: props.item.paymentType, paymentProvider: props.item.provider, accountName: props.item.accountName, accountHolderName: props.item.accountHolderName, email: props.item.email, phone: props.item.phone, username: props.item.username, accountId: props.item.accountId, maskedAccountNumber: props.item.maskedAccountNumber, routingNumber: props.item.routingNumber, iban: props.item.iban, swiftBic: props.item.swiftBic, website: props.item.website, currency: props.item.currency }); break;
    case "secure-note": fields.content = props.item.content; break;
    case "totp": Object.assign(fields, { secret: props.item.secret, issuer: props.item.issuer || "", accountName: props.item.accountName || "", otpType: props.item.otpType || "TOTP", counter: String(props.item.counter ?? 0), pin: props.item.pin || "", link: props.item.link || "", associatedApp: props.item.associatedApp || "", steamFingerprint: props.item.steamFingerprint || "", steamDeviceId: props.item.steamDeviceId || "", steamSerialNumber: props.item.steamSerialNumber || "", steamSharedSecretBase64: props.item.steamSharedSecretBase64 || "", steamRevocationCode: props.item.steamRevocationCode || "", steamIdentitySecret: props.item.steamIdentitySecret || "", steamTokenGid: props.item.steamTokenGid || "", steamRawJson: props.item.steamRawJson || "", algorithm: props.item.algorithm, digits: String(props.item.digits), period: String(props.item.period) }); break;
  }
}

function submit() {
  error.value = "";
  const title = fields.title.trim();
  if (!title) return void (error.value = "请输入名称。");
  if (kind.value === "card" && !fields.number.trim()) return void (error.value = "请输入银行卡号。");
  if (kind.value === "identity" && !fields.documentNumber.trim()) return void (error.value = "请输入证件号码。");
  if (kind.value === "billing-address" && !fields.streetAddress.trim()) return void (error.value = "请输入街道地址。");
  if (kind.value === "payment-account" && ![fields.accountName, fields.accountId, fields.iban].some((value) => value.trim())) return void (error.value = "请至少填写账号名称、账号 ID 或 IBAN。");
  if (kind.value === "secure-note" && !fields.content.trim()) return void (error.value = "请输入笔记内容。");
  if (kind.value === "totp" && !fields.secret.trim()) return void (error.value = "请输入验证码密钥。");
  emit("save", buildItem(title));
}

function buildItem(title: string): VaultItem {
  const now = new Date().toISOString();
  const base = { id: props.item?.id || crypto.randomUUID(), title, favorite: fields.favorite, notes: fields.notes.trim(), createdAt: props.item?.createdAt || now, updatedAt: now, providerRefs: props.item?.providerRefs || providerRefs() };
  switch (kind.value) {
    case "card": return { ...base, kind: "card", cardholderName: fields.cardholderName.trim(), number: fields.number.replace(/\s+/g, ""), expiryMonth: fields.expiryMonth.trim(), expiryYear: fields.expiryYear.trim(), securityCode: fields.securityCode.trim(), brand: fields.brand.trim() || undefined, billingAddressId: fields.billingAddressId || undefined } satisfies CardItem;
    case "identity": return { ...base, kind: "identity", documentType: fields.documentType, documentNumber: fields.documentNumber.trim(), firstName: fields.firstName.trim(), middleName: fields.middleName.trim(), lastName: fields.lastName.trim(), fullName: fields.fullName.trim() || [fields.firstName, fields.middleName, fields.lastName].filter(Boolean).join(" "), birthDate: optional(fields.birthDate), issuedDate: optional(fields.issuedDate), expiryDate: optional(fields.expiryDate), issuedBy: optional(fields.issuedBy), nationality: optional(fields.nationality), email: optional(fields.email), phone: optional(fields.phone), address: { streetAddress: fields.streetAddress.trim(), apartment: fields.apartment.trim(), city: fields.city.trim(), stateProvince: fields.stateProvince.trim(), postalCode: fields.postalCode.trim(), country: fields.country.trim() } } satisfies IdentityItem;
    case "billing-address": return { ...base, kind: "billing-address", fullName: fields.fullName.trim(), company: fields.company.trim(), streetAddress: fields.streetAddress.trim(), apartment: fields.apartment.trim(), city: fields.city.trim(), stateProvince: fields.stateProvince.trim(), postalCode: fields.postalCode.trim(), country: fields.country.trim(), phone: fields.phone.trim(), email: fields.email.trim() } satisfies BillingAddressItem;
    case "payment-account": return { ...base, kind: "payment-account", paymentType: fields.paymentType.trim(), provider: fields.paymentProvider.trim(), accountName: fields.accountName.trim(), accountHolderName: fields.accountHolderName.trim(), email: fields.email.trim(), phone: fields.phone.trim(), username: fields.username.trim(), accountId: fields.accountId.trim(), maskedAccountNumber: fields.maskedAccountNumber.trim(), routingNumber: fields.routingNumber.trim(), iban: fields.iban.replace(/\s+/g, ""), swiftBic: fields.swiftBic.replace(/\s+/g, ""), website: fields.website.trim(), currency: fields.currency.trim().toUpperCase() } satisfies PaymentAccountItem;
    case "secure-note": return { ...base, kind: "secure-note", content: fields.content } satisfies SecureNoteItem;
    case "totp": return { ...base, kind: "totp", secret: fields.otpType === "STEAM" ? fields.secret.trim() : fields.secret.replace(/\s+/g, "").toUpperCase(), issuer: optional(fields.issuer), accountName: optional(fields.accountName), otpType: fields.otpType, counter: clampNumber(fields.counter, 0, 0, Number.MAX_SAFE_INTEGER), pin: optional(fields.pin), link: optional(fields.link), associatedApp: optional(fields.associatedApp), steamFingerprint: optional(fields.steamFingerprint), steamDeviceId: optional(fields.steamDeviceId), steamSerialNumber: optional(fields.steamSerialNumber), steamSharedSecretBase64: fields.otpType === "STEAM" ? optional(fields.secret.trim()) : undefined, steamRevocationCode: optional(fields.steamRevocationCode), steamIdentitySecret: optional(fields.steamIdentitySecret), steamTokenGid: optional(fields.steamTokenGid), steamRawJson: optional(fields.steamRawJson), algorithm: fields.algorithm, digits: fields.otpType === "STEAM" ? 5 : clampNumber(fields.digits, 6, 6, 10), period: clampNumber(fields.period, 30, 5, 300) } satisfies TotpItem;
  }
}

function providerRefs() {
  const provider = props.providers.find((candidate) => candidate.id === fields.providerId);
  return provider && provider.kind !== "local" ? [{ providerId: provider.id }] : [];
}

function defaultProviderId() {
  return eligibleProviders.value.find((provider) => provider.isDefaultSaveTarget)?.id || eligibleProviders.value.find((provider) => provider.kind === "local")?.id || eligibleProviders.value[0]?.id || "";
}

function providerSupportsKind(provider: ProviderAccount, itemKind: EditableVaultKind): boolean {
  if (provider.kind !== "bitwarden") return true;
  return itemKind === "card" || itemKind === "identity" || itemKind === "secure-note";
}

function isEditableKind(value: string): value is EditableVaultKind { return value === "card" || value === "identity" || value === "billing-address" || value === "payment-account" || value === "secure-note" || value === "totp"; }
function optional(value: string) { return value.trim() || undefined; }
function clampNumber(value: string, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback; }

function emptyFields() {
  return {
    title: "", notes: "", favorite: false, providerId: "",
    cardholderName: "", number: "", expiryMonth: "", expiryYear: "", securityCode: "", brand: "", billingAddressId: "",
    documentType: "OTHER" as IdentityItem["documentType"], documentNumber: "", firstName: "", middleName: "", lastName: "", fullName: "", birthDate: "", issuedDate: "", expiryDate: "", issuedBy: "", nationality: "",
    company: "", streetAddress: "", apartment: "", city: "", stateProvince: "", postalCode: "", country: "", phone: "", email: "",
    paymentType: "", paymentProvider: "", accountName: "", accountHolderName: "", username: "", accountId: "", maskedAccountNumber: "", routingNumber: "", iban: "", swiftBic: "", website: "", currency: "",
    content: "", secret: "", issuer: "", otpType: "TOTP" as NonNullable<TotpItem["otpType"]>, counter: "0", pin: "", link: "", associatedApp: "", steamFingerprint: "", steamDeviceId: "", steamSerialNumber: "", steamSharedSecretBase64: "", steamRevocationCode: "", steamIdentitySecret: "", steamTokenGid: "", steamRawJson: "", algorithm: "SHA1" as TotpItem["algorithm"], digits: "6", period: "30"
  };
}
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="emit('cancel')">
    <section class="editor-dialog vault-item-dialog" role="dialog" aria-modal="true" aria-labelledby="vault-item-editor-title">
      <header><div><h2 id="vault-item-editor-title">{{ item ? `编辑${itemKindLabel(kind)}` : `添加${itemKindLabel(kind)}` }}</h2><p>保存时整个密码库会重新加密；敏感字段不会写入浏览器普通存储。</p></div><m3e-icon-button aria-label="关闭" @click="emit('cancel')"><m3e-icon name="close"></m3e-icon></m3e-icon-button></header>
      <form class="editor-form vault-item-form" @submit.prevent="submit">
        <label v-if="!item" class="field field-wide"><span>项目类型</span><select v-model="kind"><option value="card">银行卡</option><option value="identity">证件</option><option value="billing-address">账单地址</option><option value="payment-account">支付账号</option><option value="secure-note">安全笔记</option><option value="totp">动态验证码</option></select></label>
        <label class="field field-wide"><span>名称 *</span><input v-model="fields.title" autofocus autocomplete="off" /></label>

        <template v-if="kind === 'card'"><label class="field"><span>持卡人</span><input v-model="fields.cardholderName" autocomplete="cc-name" /></label><label class="field"><span>卡组织</span><input v-model="fields.brand" autocomplete="cc-type" /></label><label class="field field-wide"><span>银行卡号 *</span><input v-model="fields.number" inputmode="numeric" autocomplete="cc-number" /></label><label class="field"><span>到期月</span><input v-model="fields.expiryMonth" inputmode="numeric" autocomplete="cc-exp-month" /></label><label class="field"><span>到期年</span><input v-model="fields.expiryYear" inputmode="numeric" autocomplete="cc-exp-year" /></label><label class="field"><span>安全码</span><input v-model="fields.securityCode" type="password" inputmode="numeric" autocomplete="cc-csc" /></label></template>

        <template v-else-if="kind === 'identity'"><label class="field"><span>证件类型</span><select v-model="fields.documentType"><option value="ID_CARD">身份证</option><option value="PASSPORT">护照</option><option value="DRIVER_LICENSE">驾驶证</option><option value="SOCIAL_SECURITY">社会保障号</option><option value="OTHER">其他证件</option></select></label><label class="field"><span>证件号码 *</span><input v-model="fields.documentNumber" autocomplete="off" /></label><label class="field"><span>名</span><input v-model="fields.firstName" autocomplete="given-name" /></label><label class="field"><span>中间名</span><input v-model="fields.middleName" autocomplete="additional-name" /></label><label class="field"><span>姓</span><input v-model="fields.lastName" autocomplete="family-name" /></label><label class="field"><span>完整姓名</span><input v-model="fields.fullName" autocomplete="name" /></label><label class="field"><span>出生日期</span><input v-model="fields.birthDate" type="date" autocomplete="bday" /></label><label class="field"><span>国籍</span><input v-model="fields.nationality" autocomplete="country-name" /></label><label class="field"><span>签发日期</span><input v-model="fields.issuedDate" type="date" /></label><label class="field"><span>到期日期</span><input v-model="fields.expiryDate" type="date" /></label><label class="field"><span>签发机关</span><input v-model="fields.issuedBy" /></label><label class="field"><span>邮箱</span><input v-model="fields.email" type="email" autocomplete="email" /></label><label class="field"><span>电话</span><input v-model="fields.phone" type="tel" autocomplete="tel" /></label><label class="field field-wide"><span>街道地址</span><input v-model="fields.streetAddress" autocomplete="street-address" /></label><label class="field"><span>城市</span><input v-model="fields.city" autocomplete="address-level2" /></label><label class="field"><span>省/州</span><input v-model="fields.stateProvince" autocomplete="address-level1" /></label><label class="field"><span>邮编</span><input v-model="fields.postalCode" autocomplete="postal-code" /></label><label class="field"><span>国家</span><input v-model="fields.country" autocomplete="country-name" /></label></template>

        <template v-else-if="kind === 'billing-address'"><label class="field"><span>收件人</span><input v-model="fields.fullName" autocomplete="name" /></label><label class="field"><span>公司</span><input v-model="fields.company" autocomplete="organization" /></label><label class="field field-wide"><span>街道地址 *</span><input v-model="fields.streetAddress" autocomplete="street-address" /></label><label class="field"><span>公寓/房间</span><input v-model="fields.apartment" autocomplete="address-line2" /></label><label class="field"><span>城市</span><input v-model="fields.city" autocomplete="address-level2" /></label><label class="field"><span>省/州</span><input v-model="fields.stateProvince" autocomplete="address-level1" /></label><label class="field"><span>邮编</span><input v-model="fields.postalCode" autocomplete="postal-code" /></label><label class="field"><span>国家</span><input v-model="fields.country" autocomplete="country-name" /></label><label class="field"><span>电话</span><input v-model="fields.phone" type="tel" autocomplete="tel" /></label><label class="field"><span>邮箱</span><input v-model="fields.email" type="email" autocomplete="email" /></label></template>

        <template v-else-if="kind === 'payment-account'"><label class="field"><span>支付类型</span><input v-model="fields.paymentType" placeholder="BANK / PAYPAL / ALIPAY" /></label><label class="field"><span>服务商</span><input v-model="fields.paymentProvider" /></label><label class="field"><span>账号名称</span><input v-model="fields.accountName" /></label><label class="field"><span>账户持有人</span><input v-model="fields.accountHolderName" /></label><label class="field"><span>账号 ID</span><input v-model="fields.accountId" /></label><label class="field"><span>显示账号</span><input v-model="fields.maskedAccountNumber" placeholder="**** 7890" /></label><label class="field"><span>路由号码</span><input v-model="fields.routingNumber" inputmode="numeric" /></label><label class="field"><span>IBAN</span><input v-model="fields.iban" /></label><label class="field"><span>SWIFT/BIC</span><input v-model="fields.swiftBic" /></label><label class="field"><span>币种</span><input v-model="fields.currency" maxlength="3" /></label><label class="field"><span>用户名</span><input v-model="fields.username" autocomplete="username" /></label><label class="field"><span>邮箱</span><input v-model="fields.email" type="email" autocomplete="email" /></label><label class="field"><span>电话</span><input v-model="fields.phone" type="tel" autocomplete="tel" /></label><label class="field"><span>网站</span><input v-model="fields.website" type="url" autocomplete="url" /></label></template>

        <template v-else-if="kind === 'secure-note'"><label class="field field-wide"><span>笔记内容 *</span><textarea v-model="fields.content" rows="10"></textarea></label></template>

        <template v-else><label class="field"><span>验证码类型</span><select v-model="fields.otpType"><option value="TOTP">TOTP</option><option value="HOTP">HOTP</option><option value="STEAM">Steam Guard</option><option value="YANDEX">Yandex</option><option value="MOTP">mOTP</option></select></label><label class="field field-wide"><span>{{ fields.otpType === 'STEAM' ? 'Steam Shared Secret（Base64）' : '验证码密钥' }} *</span><input v-model="fields.secret" type="password" autocomplete="off" /><small>{{ fields.otpType === 'STEAM' ? 'Steam Guard 使用 Base64 Shared Secret，并生成 5 位专用字符验证码。' : '支持 Base32 密钥；空格会在保存时移除。' }}</small></label><label class="field"><span>签发方</span><input v-model="fields.issuer" /></label><label class="field"><span>账户</span><input v-model="fields.accountName" /></label><label v-if="fields.otpType === 'HOTP'" class="field"><span>计数器</span><input v-model="fields.counter" type="number" min="0" /></label><label class="field"><span>算法</span><select v-model="fields.algorithm"><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></label><label v-if="fields.otpType !== 'STEAM'" class="field"><span>位数</span><input v-model="fields.digits" type="number" min="6" max="10" /></label><label class="field"><span>周期（秒）</span><input v-model="fields.period" type="number" min="5" max="300" /></label><template v-if="fields.otpType === 'STEAM'"><label class="field"><span>Steam 设备 ID</span><input v-model="fields.steamDeviceId" /></label><label class="field"><span>Steam 指纹</span><input v-model="fields.steamFingerprint" /></label><label class="field"><span>Steam 序列号</span><input v-model="fields.steamSerialNumber" /></label><label class="field"><span>撤销代码</span><input v-model="fields.steamRevocationCode" /></label><label class="field"><span>Identity Secret</span><input v-model="fields.steamIdentitySecret" type="password" /></label><label class="field"><span>Token GID</span><input v-model="fields.steamTokenGid" /></label><label class="field field-wide"><span>原始 Steam JSON</span><textarea v-model="fields.steamRawJson" rows="4"></textarea><small>保留 Monica Android 的原始数据，便于无损导出。</small></label></template></template>

        <label class="field field-wide"><span>备注</span><textarea v-model="fields.notes" rows="3"></textarea></label>
        <label class="field field-wide"><span>保存到</span><select v-model="fields.providerId" :disabled="Boolean(item)"><option v-for="provider in eligibleProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select><small v-if="kind === 'billing-address' || kind === 'payment-account' || kind === 'totp'">Bitwarden 不支持该独立记录类型，因此不会显示为目标。</small></label>
        <label class="favorite-row field-wide"><input v-model="fields.favorite" type="checkbox" /><span>收藏并优先显示</span></label>
        <p v-if="error" class="form-error field-wide" role="alert">{{ error }}</p>
        <footer class="field-wide"><m3e-button variant="text" type="button" @click="emit('cancel')">取消</m3e-button><m3e-button variant="filled" type="submit">加密保存</m3e-button></footer>
      </form>
    </section>
  </div>
</template>
