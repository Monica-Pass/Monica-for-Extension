<script setup lang="ts">
import { tr, locale } from '../i18n';

import { computed, reactive, ref } from "vue";
import type { LoginItem, ProviderAccount, TotpItem, VaultItem } from "../core/model";
import { findBoundTotpItem } from "../core/login-otp";
import { itemIcon, itemKindLabel, sourceLabel } from "../manager/item-metadata";
import { parseSshKeyMetadata, parseWifiMetadata } from "../core/special-login";
import TotpCodeCell from "./TotpCodeCell.vue";
import WebsiteIcon from "./WebsiteIcon.vue";

const props = defineProps<{
  item: VaultItem;
  items: VaultItem[];
  providers: ProviderAccount[];
  consumeOtp: (item: LoginItem | TotpItem) => Promise<void>;
}>();
const emit = defineEmits<{ close: []; edit: [item: VaultItem] }>();

interface DetailField {
  id?: string;
  label: string;
  value: string;
  secret?: boolean;
  showLastFour?: boolean;
  href?: string;
  mono?: boolean;
  otp?: boolean;
  custom?: boolean;
  compact?: boolean;
  secondary?: boolean;
}

const revealed = reactive(new Set<string>());
const status = ref("");

const editable = computed(() => !props.item.deletedAt && props.item.kind !== "passkey");
const providerName = computed(() => props.providers.find((provider) => provider.id === props.item.providerRefs[0]?.providerId)?.name || tr('Monica 本地库'));
const stateLabel = computed(() => props.item.deletedAt ? tr('在回收站') : props.item.archivedAt ? tr('已归档') : props.item.favorite ? tr('已收藏') : '');
const detailType = computed(() => props.item.kind === "login" ? ({ WIFI: "Wi-Fi", SSH_KEY: tr('SSH 密钥'), BARCODE: tr('条码') } as Record<string, string>)[props.item.loginType || ""] || itemKindLabel(props.item.kind) : itemKindLabel(props.item.kind));
const detailIcon = computed(() => props.item.kind === "login" ? ({ WIFI: "wifi", SSH_KEY: "terminal", BARCODE: "qr_code_2" } as Record<string, string>)[props.item.loginType || ""] || itemIcon(props.item.kind) : itemIcon(props.item.kind));
const otpSource = computed(() => props.item.kind === "totp" ? props.item : props.item.kind === "login" ? findBoundTotpItem(props.item, props.items) || props.item : undefined);

function isHidden(field: DetailField): boolean {
  return Boolean(field.secret) && !revealed.has(field.id || field.label);
}

function maskedDisplay(field: DetailField): string {
  if (!field.showLastFour) return "••••••••";
  const compact = field.value.replace(/\s+/g, "");
  const suffix = compact.slice(-4);
  return suffix ? `•••••••• ${suffix}` : "••••••••";
}

function toggleSecret(field: DetailField) {
  const key = field.id || field.label;
  if (revealed.has(key)) revealed.delete(key);
  else revealed.add(key);
}

async function copyField(field: DetailField) {
  try {
    await navigator.clipboard.writeText(field.value);
    status.value = tr('已复制{0}。', { 0: field.label });
  } catch {
    status.value = tr('复制失败，请手动选择内容。');
  }
}

function formatDateTime(value: string | undefined): string {
  return value ? new Date(value).toLocaleString(locale.value, { dateStyle: "medium", timeStyle: "short" }) : "";
}

const fields = computed<DetailField[]>(() => {
  const item = props.item;
  switch (item.kind) {
    case "api-token": return [
      { label: tr('服务商'), value: item.provider },
      { label: tr('API 密钥'), value: item.token, secret: true, mono: true },
      ...(item.apiBase ? [{ label: tr('API 地址'), value: item.apiBase, href: item.apiBase }] : []),
      ...item.customFields.map(field => ({ label: field.name, value: field.value, secret: field.protected, custom: true }))
    ];
    case "login": {
      const rows: DetailField[] = [];
      const wifi = item.loginType === "WIFI" ? parseWifiMetadata(item.wifiMetadata) : undefined;
      const ssh = item.loginType === "SSH_KEY" ? parseSshKeyMetadata(item.sshKeyData) : undefined;
      if (item.loginType === "WIFI") {
        if (wifi?.ssid) rows.push({ label: tr('网络名称'), value: wifi.ssid });
        if (wifi?.security) rows.push({ label: tr('安全类型'), value: wifi.security });
        if (wifi?.bssid) rows.push({ secondary: true, label: "BSSID", value: wifi.bssid, mono: true });
        if (wifi) rows.push({ secondary: true, label: tr('隐藏网络'), value: wifi.hiddenNetwork ? tr('是') : tr('否') });
      }
      if (item.loginType !== "BARCODE" && item.loginType !== "SSH_KEY" && item.username) rows.push({ label: tr('用户名'), value: item.username });
      if (item.password) rows.push({ label: item.loginType === "WIFI" ? tr('Wi-Fi 密码') : item.loginType === "BARCODE" ? tr('条码内容') : tr('密码'), value: item.password, secret: true, mono: item.loginType === "BARCODE" });
      if (item.loginType === "SSH_KEY") {
        if (ssh?.algorithm) rows.push({ secondary: true, label: tr('算法'), value: ssh.algorithm });
        if (ssh?.keySize) rows.push({ secondary: true, label: tr('密钥位数'), value: String(ssh.keySize) });
        if (ssh?.fingerprintSha256) rows.push({ secondary: true, label: tr('指纹'), value: ssh.fingerprintSha256, mono: true });
        if (ssh?.publicKeyOpenSsh) rows.push({ label: tr('公钥'), value: ssh.publicKeyOpenSsh, mono: true });
        if (ssh?.privateKeyOpenSsh) rows.push({ label: tr('OpenSSH 私钥'), value: ssh.privateKeyOpenSsh, secret: true, mono: true });
        if (ssh?.comment) rows.push({ secondary: true, label: tr('注释'), value: ssh.comment });
      }
      if (item.loginType === "SSO") {
        if (item.ssoProvider) rows.push({ label: tr('SSO 提供商'), value: item.ssoProvider });
        if (item.ssoRefEntryId != null) rows.push({ secondary: true, label: tr('关联条目'), value: String(item.ssoRefEntryId) });
      }
      if (item.totpSecret || item.boundTotpItemId || otpSource.value?.kind === "totp") rows.push({ label: tr('动态验证码'), value: "", otp: true });
      for (const uri of item.uris) rows.push({ label: tr('网址'), value: uri, href: uri });
      if (item.appPackageName) rows.push({ secondary: true, label: tr('关联应用'), value: item.appPackageName });
      for (const field of item.customFields) rows.push({ label: field.name, value: field.value, secret: field.protected, mono: field.fieldType === "HIDDEN", custom: true });
      return rows;
    }
    case "card": {
      const rows = [
        item.cardholderName && { label: tr('持卡人'), value: item.cardholderName },
        item.number && { label: tr('卡号'), value: item.number, secret: true, showLastFour: true, mono: true },
        (item.expiryMonth || item.expiryYear) && { label: tr('有效期'), value: [item.expiryMonth, item.expiryYear].filter(Boolean).join(" / ") },
        item.securityCode && { label: tr('安全码'), value: item.securityCode, secret: true, compact: true },
        item.brand && { label: tr('卡组织'), value: item.brand },
        item.bankName && { secondary: true, label: tr('发卡银行'), value: item.bankName },
        item.cardType && { secondary: true, label: tr('卡类型'), value: ({ CREDIT: tr('信用卡'), DEBIT: tr('借记卡'), PREPAID: tr('预付卡') } as Record<string, string>)[item.cardType] || item.cardType },
        item.nickname && { secondary: true, label: tr('昵称'), value: item.nickname },
        (item.validFromMonth || item.validFromYear) && { secondary: true, label: tr('生效日期'), value: [item.validFromMonth, item.validFromYear].filter(Boolean).join(" / ") },
        item.pin && { secondary: true, label: "PIN", value: item.pin, secret: true, compact: true },
        item.iban && { secondary: true, label: "IBAN", value: item.iban, mono: true },
        item.swiftBic && { secondary: true, label: "SWIFT/BIC", value: item.swiftBic, mono: true },
        item.routingNumber && { secondary: true, label: tr('路由号'), value: item.routingNumber, mono: true },
        item.accountNumber && { secondary: true, label: tr('账号'), value: item.accountNumber, secret: true, showLastFour: true, mono: true },
        item.branchCode && { secondary: true, label: tr('分行代码'), value: item.branchCode },
        item.currency && { secondary: true, label: tr('币种'), value: item.currency },
        item.customerServicePhone && { secondary: true, label: tr('客服电话'), value: item.customerServicePhone }
      ].filter(Boolean) as DetailField[];
      for (const field of item.customFields || []) rows.push({ label: field.name, value: field.value, secret: field.protected, custom: true });
      return rows;
    }
    case "identity": {
      const typeLabels = { ID_CARD: tr('身份证'), PASSPORT: tr('护照'), DRIVER_LICENSE: tr('驾驶证'), SOCIAL_SECURITY: tr('社会保障号'), OTHER: tr('其他证件') } as Record<string, string>;
      const rows = [
        { label: tr('证件类型'), value: typeLabels[item.documentType] || item.documentType },
        item.documentNumber && { label: tr('证件号码'), value: item.documentNumber, secret: true, showLastFour: true, mono: true },
        item.fullName && { label: tr('姓名'), value: item.fullName },
        (item.firstName || item.middleName || item.lastName) && { secondary: true, label: tr('姓名分写'), value: [item.firstName, item.middleName, item.lastName].filter(Boolean).join(" · ") },
        item.birthDate && { secondary: true, label: tr('出生日期'), value: item.birthDate },
        item.issuedDate && { secondary: true, label: tr('签发日期'), value: item.issuedDate },
        item.expiryDate && { label: tr('有效期至'), value: item.expiryDate },
        item.issuedBy && { secondary: true, label: tr('签发机关'), value: item.issuedBy },
        item.nationality && { secondary: true, label: tr('国籍'), value: item.nationality },
        item.company && { secondary: true, label: tr('公司'), value: item.company },
        item.ssn && { secondary: true, label: "SSN", value: item.ssn, secret: true, mono: true },
        item.passportNumber && { secondary: true, label: tr('护照号'), value: item.passportNumber, secret: true, mono: true },
        item.licenseNumber && { secondary: true, label: tr('驾照号'), value: item.licenseNumber, secret: true, mono: true },
        item.email && { secondary: true, label: tr('邮箱'), value: item.email },
        item.phone && { secondary: true, label: tr('电话'), value: item.phone },
        item.additionalInfo && { secondary: true, label: tr('补充信息'), value: item.additionalInfo }
      ].filter(Boolean) as DetailField[];
      for (const field of item.customFields || []) rows.push({ label: field.name, value: field.value, secret: field.protected, custom: true });
      return rows;
    }
    case "billing-address": {
      const rows = [
        item.fullName && { label: tr('姓名'), value: item.fullName },
        item.company && { label: tr('公司'), value: item.company },
        item.streetAddress && { label: tr('街道地址'), value: item.streetAddress },
        item.apartment && { label: tr('公寓/单元'), value: item.apartment },
        item.city && { label: tr('城市'), value: item.city },
        item.stateProvince && { label: tr('省/州'), value: item.stateProvince },
        item.postalCode && { label: tr('邮编'), value: item.postalCode, mono: true },
        item.country && { label: tr('国家/地区'), value: item.country },
        item.phone && { label: tr('电话'), value: item.phone },
        item.email && { label: tr('邮箱'), value: item.email }
      ].filter(Boolean) as DetailField[];
      if (item.isDefault) rows.push({ label: tr('默认地址'), value: tr('是') });
      for (const field of item.customFields || []) rows.push({ label: field.name, value: field.value, secret: field.protected, custom: true });
      return rows;
    }
    case "payment-account": {
      const rows = [
        item.paymentType && { label: tr('支付类型'), value: item.paymentType },
        item.provider && { label: tr('服务商'), value: item.provider },
        item.accountName && { label: tr('账户名'), value: item.accountName },
        item.accountHolderName && { label: tr('持有人'), value: item.accountHolderName },
        item.username && { secondary: true, label: tr('用户名'), value: item.username },
        item.accountId && { label: tr('账户 ID'), value: item.accountId, mono: true },
        item.maskedAccountNumber && { label: tr('账号'), value: item.maskedAccountNumber, mono: true },
        item.linkedCardLast4 && { secondary: true, label: tr('关联卡尾号'), value: item.linkedCardLast4, mono: true },
        item.routingNumber && { secondary: true, label: tr('路由号'), value: item.routingNumber, mono: true },
        item.iban && { secondary: true, label: "IBAN", value: item.iban, secret: true, mono: true },
        item.swiftBic && { secondary: true, label: "SWIFT/BIC", value: item.swiftBic, mono: true },
        item.website && { secondary: true, label: tr('网站'), value: item.website, href: item.website },
        item.currency && { secondary: true, label: tr('币种'), value: item.currency },
        item.email && { secondary: true, label: tr('邮箱'), value: item.email },
        item.phone && { secondary: true, label: tr('电话'), value: item.phone }
      ].filter(Boolean) as DetailField[];
      if (item.billingAddress) rows.push({ secondary: true, label: tr('账单地址'), value: item.billingAddress, mono: true });
      if (item.paymentNotes) rows.push({ secondary: true, label: tr('备注'), value: item.paymentNotes });
      if (item.isDefault) rows.push({ secondary: true, label: tr('默认支付'), value: tr('是') });
      for (const field of item.customFields || []) rows.push({ label: field.name, value: field.value, secret: field.protected, custom: true });
      return rows;
    }
    case "secure-note":
      return (item.customFields || []).map(field => ({ label: field.name, value: field.value, secret: field.protected, custom: true }));
    case "totp": {
      const typeLabels = { TOTP: "TOTP", HOTP: "HOTP", STEAM: "Steam Guard", YANDEX: "Yandex Key", MOTP: "mOTP" } as Record<string, string>;
      const rows: DetailField[] = [
        { label: tr('动态验证码'), value: "", otp: true },
        { label: tr('类型'), value: typeLabels[item.otpType || "TOTP"] || item.otpType || "TOTP" },
        item.issuer && { label: tr('签发方'), value: item.issuer },
        item.accountName && { label: tr('账户'), value: item.accountName },
        { secondary: true, label: tr('密钥'), value: item.secret, secret: true, mono: true },
        { secondary: true, label: tr('算法'), value: item.algorithm },
        { secondary: true, label: tr('位数'), value: String(item.digits) },
        item.otpType === "HOTP" ? { secondary: true, label: tr('计数器'), value: String(item.counter ?? 0) } : { secondary: true, label: tr('周期'), value: tr('{0} 秒', { 0: item.period }) },
        item.pin && { secondary: true, label: "PIN", value: item.pin, secret: true }
      ].filter(Boolean) as DetailField[];
      return rows;
    }
    case "passkey": {
      const rows: DetailField[] = [
        item.rpId && { label: "Relying Party", value: item.rpId, mono: true },
        item.rpName && { label: tr('站点名称'), value: item.rpName },
        (item.userName || item.userDisplayName) && { label: tr('用户'), value: item.userName || item.userDisplayName },
        item.credentialId && { secondary: true, label: tr('凭证 ID'), value: item.credentialId, mono: true },
        { secondary: true, label: tr('算法'), value: item.keyAlgorithm || String(item.algorithm) },
        item.transports?.length && { secondary: true, label: tr('传输方式'), value: item.transports.join(" · ") },
        item.aaguid && { secondary: true, label: "AAGUID", value: item.aaguid, mono: true },
        item.lastUsedAt && { label: tr('最近使用'), value: formatDateTime(item.lastUsedAt) },
        item.useCount != null && { label: tr('使用次数'), value: String(item.useCount) },
        item.discoverable != null && { secondary: true, label: tr('可发现凭据'), value: item.discoverable ? tr('是') : tr('否') },
        item.userVerificationRequired != null && { secondary: true, label: tr('需要用户验证'), value: item.userVerificationRequired ? tr('是') : tr('否') }
      ].filter(Boolean) as DetailField[];
      return rows;
    }
  }
});

const noteContent = computed(() => props.item.kind === "secure-note" ? props.item.content : "");
const noteTags = computed(() => props.item.kind === "secure-note" ? props.item.tags || [] : []);
const fieldSections = computed(() => {
  const indexed = fields.value.map((field, index) => ({
    ...field,
    id: `${props.item.id}-${index}`,
    wide: Boolean((field.secret && !field.compact) || field.href || field.otp || field.value.length > 28 || field.value.includes("\n"))
  }));
  return [
    { id: "primary", title: tr('主要信息'), collapsible: false, fields: indexed.filter(field => !field.custom && !field.secondary) },
    { id: "secondary", title: tr('更多信息'), collapsible: true, fields: indexed.filter(field => !field.custom && field.secondary) },
    { id: "custom", title: tr('自定义字段'), collapsible: true, fields: indexed.filter(field => field.custom) }
  ].filter(section => section.fields.length).map(section => {
    // Keep short fields in pairs without leaving a half-empty row before a wide value.
    let unpaired: (typeof indexed)[number] | undefined;
    for (const field of section.fields) {
      if (field.wide) {
        if (unpaired) unpaired.wide = true;
        unpaired = undefined;
      } else unpaired = unpaired ? undefined : field;
    }
    if (unpaired) unpaired.wide = true;
    return section;
  });
});
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="emit('close')">
    <section class="editor-dialog vault-item-dialog detail-dialog" :data-item-kind="item.kind" role="dialog" aria-modal="true" aria-labelledby="vault-detail-title">
        <header class="detail-header">
          <div class="detail-heading">
            <WebsiteIcon class="row-icon" :item="item" :fallback="detailIcon" />
            <div class="detail-title-block">
              <p class="detail-eyebrow">{{ detailType }}</p>
              <h2 id="vault-detail-title">{{ item.title }}</h2>
              <div v-if="stateLabel || item.categoryName" class="detail-badges"><span v-if="stateLabel">{{ stateLabel }}</span><span v-if="item.categoryName">{{ item.categoryName }}</span></div>
            </div>
          </div>
          <m3e-icon-button :aria-label="tr('关闭详情')" @click="emit('close')"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
        </header>

      <div class="detail-scroll">
        <div class="detail-body">
          <div class="detail-main">
            <section v-if="item.kind === 'secure-note'" class="detail-section detail-note" aria-labelledby="detail-content-title">
              <div class="detail-section-heading"><h3 id="detail-content-title" class="detail-section-title">{{ tr('内容') }}</h3><m3e-icon-button v-if="noteContent" :aria-label="tr('复制{0}', { 0: tr('内容') })" @click="copyField({ label: tr('内容'), value: noteContent })"><m3e-icon name="content_copy"></m3e-icon></m3e-icon-button></div>
              <pre v-if="noteContent">{{ noteContent }}</pre>
              <p v-else class="detail-empty">{{ tr('暂无内容') }}</p>
              <div v-if="noteTags.length || item.isMarkdown" class="detail-tags">
                <span v-for="tag in noteTags" :key="tag" class="detail-tag">{{ tag }}</span>
                <span v-if="item.isMarkdown" class="detail-tag detail-tag-markdown">Markdown</span>
              </div>
            </section>

            <component :is="section.collapsible ? 'm3e-expansion-panel' : 'section'" v-for="section in fieldSections" :key="section.id" class="detail-section" :class="{ 'detail-disclosure': section.collapsible }" :aria-labelledby="`detail-${section.id}-title`">
              <span slot="header" v-if="section.collapsible"><span><span :id="`detail-${section.id}-title`">{{ section.title }}</span><small>{{ section.fields.length }}</small></span></span>
              <h3 v-else :id="`detail-${section.id}-title`" class="detail-section-title">{{ section.title }}</h3>
              <dl class="detail-grid">
                <div v-for="field in section.fields" :key="field.id" class="detail-row" :class="{ 'detail-row-wide': field.wide, 'detail-row-otp': field.otp }">
                  <dt>{{ field.label }}</dt>
                  <dd>
                    <TotpCodeCell v-if="field.otp && otpSource" :item="otpSource" class="detail-otp" allow-use show-copy-icon :consume-code="item.deletedAt ? undefined : consumeOtp" />
                    <a v-else-if="field.href && !isHidden(field)" class="detail-field-value" :href="field.href" target="_blank" rel="noreferrer">{{ field.value }}</a>
                    <code v-else-if="field.mono || field.secret" class="detail-field-value">{{ isHidden(field) ? maskedDisplay(field) : field.value }}</code>
                    <span v-else class="detail-field-value">{{ isHidden(field) ? maskedDisplay(field) : field.value }}</span>
                    <span v-if="field.secret || field.value" class="detail-field-actions">
                      <m3e-icon-button v-if="field.secret" :aria-label="`${isHidden(field) ? tr('显示') : tr('隐藏')}${field.label}`" @click="toggleSecret(field)"><m3e-icon :name="isHidden(field) ? 'visibility' : 'visibility_off'"></m3e-icon></m3e-icon-button>
                      <m3e-icon-button v-if="field.value" :aria-label="tr('复制{0}', { 0: field.label })" @click="copyField(field)"><m3e-icon name="content_copy"></m3e-icon></m3e-icon-button>
                    </span>
                  </dd>
                </div>
              </dl>
            </component>

            <section v-if="item.notes" class="detail-section detail-notes" aria-labelledby="detail-notes-title">
              <h3 id="detail-notes-title" class="detail-section-title">{{ tr('备注') }}</h3>
              <p class="detail-notes-line">{{ item.notes }}</p>
            </section>
            <p v-if="!fieldSections.length && item.kind !== 'secure-note' && !item.notes" class="detail-empty">{{ tr('暂无内容') }}</p>
            <p v-if="item.kind === 'passkey' && sourceLabel(item.sourceMode) === tr('Android 元数据')" class="supporting detail-context-note">{{ tr('该 Passkey 来自 Android 备份，仅保留元数据；浏览器无法用它完成 WebAuthn 签名。') }}</p>
          </div>

          <aside class="detail-sidebar" aria-labelledby="detail-metadata-title">
            <h3 id="detail-metadata-title" class="detail-section-title">{{ tr('来源与记录') }}</h3>
            <dl class="detail-grid detail-meta">
              <div class="detail-row"><dt>{{ tr('密码源') }}</dt><dd><span>{{ providerName }}</span></dd></div>
              <div v-if="item.keepassGroupPath" class="detail-row"><dt>{{ tr('KeePass 分组') }}</dt><dd><span>{{ item.keepassGroupPath }}</span></dd></div>
              <div class="detail-row"><dt>{{ tr('创建时间') }}</dt><dd><time :datetime="item.createdAt">{{ formatDateTime(item.createdAt) }}</time></dd></div>
              <div class="detail-row"><dt>{{ tr('更新时间') }}</dt><dd><time :datetime="item.updatedAt">{{ formatDateTime(item.updatedAt) }}</time></dd></div>
            </dl>
          </aside>
        </div>
      </div>

      <footer class="detail-actions">
        <p v-if="status" class="detail-status" aria-live="polite">{{ status }}</p>
        <div class="detail-action-buttons">
          <m3e-button variant="text" @click="emit('close')">{{ tr('关闭') }}</m3e-button>
          <m3e-button v-if="editable" variant="filled" @click="emit('edit', item)"><m3e-icon slot="icon" name="edit"></m3e-icon>{{ tr('编辑') }}</m3e-button>
        </div>
      </footer>
    </section>
  </div>
</template>
