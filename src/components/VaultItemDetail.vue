<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { ProviderAccount, VaultItem } from "../core/model";
import { itemIcon, itemKindLabel, sourceLabel } from "../manager/item-metadata";
import { parseSshKeyMetadata, parseWifiMetadata } from "../core/special-login";

const props = defineProps<{ item: VaultItem; providers: ProviderAccount[] }>();
const emit = defineEmits<{ close: []; edit: [item: VaultItem] }>();

interface DetailField {
  label: string;
  value: string;
  secret?: boolean;
  href?: string;
  mono?: boolean;
}

const revealed = reactive(new Set<string>());
const status = ref("");

const editable = computed(() => !props.item.deletedAt && props.item.kind !== "passkey");
const providerName = computed(() => props.providers.find((provider) => provider.id === props.item.providerRefs[0]?.providerId)?.name || "Monica 本地库");
const stateLabel = computed(() => props.item.deletedAt ? "在回收站" : props.item.archivedAt ? "已归档" : props.item.favorite ? "已收藏" : "正常");

function isHidden(field: DetailField): boolean {
  return Boolean(field.secret) && !revealed.has(field.label);
}

function maskedDisplay(field: DetailField): string {
  const compact = field.value.replace(/\s+/g, "");
  const suffix = compact.slice(-4);
  return suffix ? `•••••••• ${suffix}` : "••••••••";
}

function toggleSecret(field: DetailField) {
  if (revealed.has(field.label)) revealed.delete(field.label);
  else revealed.add(field.label);
}

async function copyField(field: DetailField) {
  try {
    await navigator.clipboard.writeText(field.value);
    status.value = `已复制${field.label}。`;
  } catch {
    status.value = "复制失败，请手动选择内容。";
  }
}

function formatDateTime(value: string | undefined): string {
  return value ? new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "";
}

const fields = computed<DetailField[]>(() => {
  const item = props.item;
  switch (item.kind) {
    case "login": {
      const rows: DetailField[] = [];
      const wifi = item.loginType === "WIFI" ? parseWifiMetadata(item.wifiMetadata) : undefined;
      const ssh = item.loginType === "SSH_KEY" ? parseSshKeyMetadata(item.sshKeyData) : undefined;
      if (item.loginType === "WIFI") {
        if (wifi?.ssid) rows.push({ label: "网络名称", value: wifi.ssid });
        if (wifi?.security) rows.push({ label: "安全类型", value: wifi.security });
        if (wifi?.identity) rows.push({ label: "身份", value: wifi.identity });
        if (wifi?.bssid) rows.push({ label: "BSSID", value: wifi.bssid, mono: true });
      }
      if (item.loginType !== "BARCODE" && item.loginType !== "SSH_KEY" && item.username) rows.push({ label: "用户名", value: item.username });
      if (item.password) rows.push({ label: item.loginType === "WIFI" ? "Wi-Fi 密码" : item.loginType === "BARCODE" ? "条码内容" : "密码", value: item.password, secret: true, mono: item.loginType === "BARCODE" });
      if (item.loginType === "SSH_KEY") {
        if (ssh?.algorithm) rows.push({ label: "算法", value: ssh.algorithm });
        if (ssh?.fingerprintSha256) rows.push({ label: "指纹", value: ssh.fingerprintSha256, mono: true });
        if (ssh?.publicKeyOpenSsh) rows.push({ label: "公钥", value: ssh.publicKeyOpenSsh, mono: true });
        if (ssh?.comment) rows.push({ label: "注释", value: ssh.comment });
      }
      if (item.loginType === "SSO") {
        if (item.ssoProvider) rows.push({ label: "SSO 提供商", value: item.ssoProvider });
        if (item.ssoRefEntryId != null) rows.push({ label: "关联条目", value: String(item.ssoRefEntryId) });
      }
      for (const uri of item.uris) rows.push({ label: "网址", value: uri, href: uri });
      if (item.totpSecret) rows.push({ label: "动态验证码", value: "已绑定验证器" });
      if (item.appPackageName) rows.push({ label: "关联应用", value: item.appPackageName });
      for (const field of item.customFields) rows.push({ label: field.name, value: field.value, secret: field.protected, mono: field.fieldType === "HIDDEN" });
      return rows;
    }
    case "card": {
      const rows = [
        item.cardholderName && { label: "持卡人", value: item.cardholderName },
        item.number && { label: "卡号", value: item.number, secret: true, mono: true },
        (item.expiryMonth || item.expiryYear) && { label: "有效期", value: [item.expiryMonth, item.expiryYear].filter(Boolean).join(" / ") },
        item.securityCode && { label: "安全码", value: item.securityCode, secret: true },
        item.brand && { label: "卡组织", value: item.brand },
        item.bankName && { label: "发卡银行", value: item.bankName },
        item.cardType && { label: "卡类型", value: ({ CREDIT: "信用卡", DEBIT: "借记卡", PREPAID: "预付卡" } as Record<string, string>)[item.cardType] || item.cardType },
        item.nickname && { label: "昵称", value: item.nickname },
        (item.validFromMonth || item.validFromYear) && { label: "生效日期", value: [item.validFromMonth, item.validFromYear].filter(Boolean).join(" / ") },
        item.pin && { label: "PIN", value: item.pin, secret: true },
        item.iban && { label: "IBAN", value: item.iban, mono: true },
        item.swiftBic && { label: "SWIFT/BIC", value: item.swiftBic, mono: true },
        item.routingNumber && { label: "路由号", value: item.routingNumber, mono: true },
        item.accountNumber && { label: "账号", value: item.accountNumber, secret: true, mono: true },
        item.branchCode && { label: "分行代码", value: item.branchCode },
        item.currency && { label: "币种", value: item.currency },
        item.customerServicePhone && { label: "客服电话", value: item.customerServicePhone }
      ].filter(Boolean) as DetailField[];
      for (const field of item.customFields || []) rows.push({ label: field.name, value: field.value, secret: field.protected });
      return rows;
    }
    case "identity": {
      const typeLabels = { ID_CARD: "身份证", PASSPORT: "护照", DRIVER_LICENSE: "驾驶证", SOCIAL_SECURITY: "社会保障号", OTHER: "其他证件" } as Record<string, string>;
      const rows = [
        { label: "证件类型", value: typeLabels[item.documentType] || item.documentType },
        item.documentNumber && { label: "证件号码", value: item.documentNumber, secret: true, mono: true },
        item.fullName && { label: "姓名", value: item.fullName },
        (item.firstName || item.middleName || item.lastName) && { label: "姓名分写", value: [item.firstName, item.middleName, item.lastName].filter(Boolean).join(" · ") },
        item.birthDate && { label: "出生日期", value: item.birthDate },
        item.issuedDate && { label: "签发日期", value: item.issuedDate },
        item.expiryDate && { label: "有效期至", value: item.expiryDate },
        item.issuedBy && { label: "签发机关", value: item.issuedBy },
        item.nationality && { label: "国籍", value: item.nationality },
        item.company && { label: "公司", value: item.company },
        item.ssn && { label: "SSN", value: item.ssn, secret: true, mono: true },
        item.passportNumber && { label: "护照号", value: item.passportNumber, secret: true, mono: true },
        item.licenseNumber && { label: "驾照号", value: item.licenseNumber, secret: true, mono: true },
        item.email && { label: "邮箱", value: item.email },
        item.phone && { label: "电话", value: item.phone },
        item.additionalInfo && { label: "补充信息", value: item.additionalInfo }
      ].filter(Boolean) as DetailField[];
      for (const field of item.customFields || []) rows.push({ label: field.name, value: field.value, secret: field.protected });
      return rows;
    }
    case "billing-address": {
      const rows = [
        item.fullName && { label: "姓名", value: item.fullName },
        item.company && { label: "公司", value: item.company },
        item.streetAddress && { label: "街道地址", value: item.streetAddress },
        item.apartment && { label: "公寓/单元", value: item.apartment },
        item.city && { label: "城市", value: item.city },
        item.stateProvince && { label: "省/州", value: item.stateProvince },
        item.postalCode && { label: "邮编", value: item.postalCode, mono: true },
        item.country && { label: "国家/地区", value: item.country },
        item.phone && { label: "电话", value: item.phone },
        item.email && { label: "邮箱", value: item.email }
      ].filter(Boolean) as DetailField[];
      if (item.isDefault) rows.push({ label: "默认地址", value: "是" });
      for (const field of item.customFields || []) rows.push({ label: field.name, value: field.value, secret: field.protected });
      return rows;
    }
    case "payment-account": {
      const rows = [
        item.paymentType && { label: "支付类型", value: item.paymentType },
        item.provider && { label: "服务商", value: item.provider },
        item.accountName && { label: "账户名", value: item.accountName },
        item.accountHolderName && { label: "持有人", value: item.accountHolderName },
        item.username && { label: "用户名", value: item.username },
        item.accountId && { label: "账户 ID", value: item.accountId, mono: true },
        item.maskedAccountNumber && { label: "账号", value: item.maskedAccountNumber, mono: true },
        item.linkedCardLast4 && { label: "关联卡尾号", value: item.linkedCardLast4, mono: true },
        item.routingNumber && { label: "路由号", value: item.routingNumber, mono: true },
        item.iban && { label: "IBAN", value: item.iban, secret: true, mono: true },
        item.swiftBic && { label: "SWIFT/BIC", value: item.swiftBic, mono: true },
        item.website && { label: "网站", value: item.website, href: item.website },
        item.currency && { label: "币种", value: item.currency },
        item.email && { label: "邮箱", value: item.email },
        item.phone && { label: "电话", value: item.phone }
      ].filter(Boolean) as DetailField[];
      if (item.billingAddress) rows.push({ label: "账单地址", value: item.billingAddress, mono: true });
      if (item.paymentNotes) rows.push({ label: "备注", value: item.paymentNotes });
      if (item.isDefault) rows.push({ label: "默认支付", value: "是" });
      for (const field of item.customFields || []) rows.push({ label: field.name, value: field.value, secret: field.protected });
      return rows;
    }
    case "secure-note":
      return [];
    case "totp": {
      const typeLabels = { TOTP: "TOTP", HOTP: "HOTP", STEAM: "Steam Guard", YANDEX: "Yandex Key", MOTP: "mOTP" } as Record<string, string>;
      const rows: DetailField[] = [
        { label: "类型", value: typeLabels[item.otpType || "TOTP"] || item.otpType || "TOTP" },
        item.issuer && { label: "签发方", value: item.issuer },
        item.accountName && { label: "账户", value: item.accountName },
        { label: "密钥", value: item.secret, secret: true, mono: true },
        { label: "算法", value: item.algorithm },
        { label: "位数", value: String(item.digits) },
        item.otpType === "HOTP" ? { label: "计数器", value: String(item.counter ?? 0) } : { label: "周期", value: `${item.period} 秒` },
        item.pin && { label: "PIN", value: item.pin, secret: true }
      ].filter(Boolean) as DetailField[];
      return rows;
    }
    case "passkey": {
      const rows: DetailField[] = [
        item.rpId && { label: "Relying Party", value: item.rpId, mono: true },
        item.rpName && { label: "站点名称", value: item.rpName },
        (item.userName || item.userDisplayName) && { label: "用户", value: item.userName || item.userDisplayName },
        item.credentialId && { label: "凭证 ID", value: item.credentialId, mono: true },
        { label: "算法", value: item.keyAlgorithm || String(item.algorithm) },
        item.transports?.length && { label: "传输方式", value: item.transports.join(" · ") },
        item.aaguid && { label: "AAGUID", value: item.aaguid, mono: true },
        item.createdAt && { label: "创建时间", value: formatDateTime(item.createdAt) },
        item.lastUsedAt && { label: "最近使用", value: formatDateTime(item.lastUsedAt) },
        item.useCount != null && { label: "使用次数", value: String(item.useCount) },
        item.isDiscoverable != null && { label: "可发现凭据", value: item.isDiscoverable ? "是" : "否" },
        item.isUserVerificationRequired != null && { label: "需要用户验证", value: item.isUserVerificationRequired ? "是" : "否" }
      ].filter(Boolean) as DetailField[];
      return rows;
    }
  }
});

const noteContent = computed(() => props.item.kind === "secure-note" ? props.item.content : "");
const noteTags = computed(() => props.item.kind === "secure-note" ? props.item.tags || [] : []);
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="emit('close')">
    <section class="editor-dialog vault-item-dialog detail-dialog" role="dialog" aria-modal="true" aria-labelledby="vault-detail-title">
      <header>
        <div class="detail-heading">
          <span class="row-icon"><m3e-icon :name="itemIcon(item.kind)"></m3e-icon></span>
          <div>
            <h2 id="vault-detail-title">{{ item.title }}</h2>
            <p>{{ itemKindLabel(item.kind) }} · {{ stateLabel }}<template v-if="item.categoryName"> · {{ item.categoryName }}</template></p>
          </div>
        </div>
        <m3e-icon-button aria-label="关闭详情" @click="emit('close')"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <div class="detail-body">
        <dl v-if="fields.length" class="detail-grid">
          <div v-for="field in fields" :key="field.label" class="detail-row">
            <dt>{{ field.label }}</dt>
            <dd>
              <a v-if="field.href && !isHidden(field)" :href="field.href" target="_blank" rel="noreferrer">{{ field.value }}</a>
              <code v-else-if="field.mono">{{ isHidden(field) ? maskedDisplay(field) : field.value }}</code>
              <span v-else>{{ isHidden(field) ? maskedDisplay(field) : field.value }}</span>
              <span v-if="field.secret || field.value" class="detail-field-actions">
                <m3e-icon-button v-if="field.secret" :aria-label="`${isHidden(field) ? '显示' : '隐藏'}${field.label}`" @click="toggleSecret(field)"><m3e-icon :name="isHidden(field) ? 'visibility' : 'visibility_off'"></m3e-icon></m3e-icon-button>
                <m3e-icon-button v-if="field.value" :aria-label="`复制${field.label}`" @click="copyField(field)"><m3e-icon name="content_copy"></m3e-icon></m3e-icon-button>
              </span>
            </dd>
          </div>
        </dl>

        <div v-if="noteContent" class="detail-note">
          <h3>内容</h3>
          <pre>{{ noteContent }}</pre>
          <div v-if="noteTags.length" class="detail-tags">
            <span v-for="tag in noteTags" :key="tag" class="detail-tag">{{ tag }}</span>
            <span v-if="item.isMarkdown" class="detail-tag detail-tag-markdown">Markdown</span>
          </div>
          <div v-else-if="item.isMarkdown" class="detail-tags"><span class="detail-tag detail-tag-markdown">Markdown</span></div>
        </div>

        <p v-if="item.notes" class="detail-notes-line"><strong>备注：</strong>{{ item.notes }}</p>

        <dl class="detail-grid detail-meta">
          <div class="detail-row"><dt>密码源</dt><dd><span>{{ providerName }}</span></dd></div>
          <div v-if="item.keepassGroupPath" class="detail-row"><dt>KeePass 分组</dt><dd><span>{{ item.keepassGroupPath }}</span></dd></div>
          <div class="detail-row"><dt>创建时间</dt><dd><span>{{ formatDateTime(item.createdAt) }}</span></dd></div>
          <div class="detail-row"><dt>更新时间</dt><dd><span>{{ formatDateTime(item.updatedAt) }}</span></dd></div>
        </dl>

        <p v-if="item.kind === 'passkey' && sourceLabel(item.sourceMode) === 'Android 元数据'" class="supporting">该 Passkey 来自 Android 备份，仅保留元数据；浏览器无法用它完成 WebAuthn 签名。</p>
        <p v-if="status" class="detail-status" aria-live="polite">{{ status }}</p>
      </div>

      <footer class="detail-actions">
        <m3e-button v-if="editable" variant="filled" @click="emit('edit', item)"><m3e-icon slot="icon" name="edit"></m3e-icon>编辑</m3e-button>
        <m3e-button variant="text" @click="emit('close')">关闭</m3e-button>
      </footer>
    </section>
  </div>
</template>
