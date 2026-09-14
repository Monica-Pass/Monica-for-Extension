<script setup lang="ts">
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { computed, ref } from "vue";
import { tr } from "../i18n";
import type { LoginUriMatchType, ProviderAccount, TotpItem } from "../core/model";
import type { LoginForm } from "../manager/login-form";

const props = defineProps<{
  form: LoginForm;
  editing: boolean;
  providers: ProviderAccount[];
  totpItems: TotpItem[];
  sshFormatHint: string;
  nativeBitwardenSsh: boolean;
  qrDataUrl: string;
  qrError: string;
}>();
const emit = defineEmits<{ applyRaw: []; copyPayload: []; generateQr: []; clearQr: [] }>();
const barcodeMode = defineModel<"qr" | "code128">("barcodeMode", { required: true });
const reveal = ref(false);
const revealSsh = ref(false);
const form = props.form;
// Editing a binding must not collapse the fields while the user is replacing it.
const twoFactorOpen = ref(Boolean(form.boundTotpItemId || form.totpSecret));
const webLogin = computed(() => form.loginType === "PASSWORD" || form.loginType === "SSO");
const entryType = computed({ get: () => webLogin.value ? "PASSWORD" : form.loginType, set: (value: LoginForm["loginType"]) => { form.loginType = value; reveal.value = false; emit("clearQr"); } });
const matchTypes: LoginUriMatchType[] = ["base-domain", "domain", "starts-with", "exact", "regex", "never"];
const matchLabel = (type: LoginUriMatchType) => ({ "base-domain": tr('基础域名'), domain: tr('完整主机名'), "starts-with": tr('以此开头'), exact: tr('完全匹配'), regex: tr('正则表达式'), never: tr('从不匹配') })[type];
const ssoProviders = ["GOOGLE", "APPLE", "MICROSOFT", "GITHUB", "FACEBOOK", "TWITTER", "WECHAT", "QQ", "WEIBO", "OTHER"];
</script>

<template>
  <section class="editor-section editor-basics" :aria-label="tr('基本信息')">
    <m3e-form-field v-field-label variant="filled" hide-required-marker class="field editor-title-field"><label slot="label">{{ tr('名称 *') }}</label><input v-model="form.name" autofocus autocomplete="off" :placeholder="tr('为这个项目起个名称')" /></m3e-form-field>
    <div class="editor-meta-grid">
      <m3e-form-field v-field-label variant="filled" hide-required-marker v-if="!editing" class="field"><label slot="label">{{ tr('项目类型') }}</label><component :is="materialSelectTag" @input="entryType = ($event.target as HTMLElement &amp; { value: string }).value" ><component :is="materialOptionTag" :selected.prop="String(entryType ?? '') === String('PASSWORD')" value="PASSWORD">{{ tr('密码') }}</component><component :is="materialOptionTag" :selected.prop="String(entryType ?? '') === String('WIFI')" value="WIFI">Wi-Fi</component><component :is="materialOptionTag" :selected.prop="String(entryType ?? '') === String('SSH_KEY')" value="SSH_KEY">{{ tr('SSH 密钥') }}</component><component :is="materialOptionTag" :selected.prop="String(entryType ?? '') === String('BARCODE')" value="BARCODE">{{ tr('条码') }}</component></component></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('保存到') }}</label><component :is="materialSelectTag" @input="form.providerId = ($event.target as HTMLElement &amp; { value: string }).value"  :disabled="editing"><component :is="materialOptionTag" :selected.prop="String(form.providerId ?? '') === String(provider.id)" v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.kind === 'local' ? tr('Monica 本地库') : provider.name }}</component></component></m3e-form-field>
    </div>
  </section>

  <section v-if="webLogin" class="editor-section" :aria-label="tr('账号信息')">
    <h3>{{ tr('账号信息') }}</h3>
    <div class="editor-field-grid">
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('用户名') }}</label><input v-model="form.username" autocomplete="off" placeholder="name@example.com" /></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('密码') }}</label><input v-model="form.password" :aria-label="tr('密码')" :type="reveal ? 'text' : 'password'" autocomplete="new-password" /><m3e-button slot="suffix" variant="text" type="button" toggle :selected.prop="reveal" @beforeinput.prevent @click="reveal = !reveal">{{ reveal ? tr('隐藏') : tr('显示') }}</m3e-button></m3e-form-field>
    </div>
    <div class="editor-websites">
      <span class="editor-field-label">{{ tr('匹配网站（可选）') }}</span>
      <div v-for="(rule, index) in form.uriRules" :key="index" class="uri-rule-row">
        <m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('网址 {0}', { 0: index + 1 }) }}</label><input v-model="rule.uri" :aria-label="tr('网址 {0}', { 0: index + 1 })" placeholder="https://example.com" autocomplete="off" /></m3e-form-field>
        <m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('网址 {0} 匹配方式', { 0: index + 1 }) }}</label><component :is="materialSelectTag" @input="rule.matchType = ($event.target as HTMLElement &amp; { value: string }).value"  :aria-label="tr('网址 {0} 匹配方式', { 0: index + 1 })"><component :is="materialOptionTag" :selected.prop="String(rule.matchType ?? '') === String(type)" v-for="type in matchTypes" :key="type" :value="type">{{ matchLabel(type) }}</component></component></m3e-form-field>
        <m3e-icon-button type="button" :aria-label="tr('删除网址 {0}', { 0: index + 1 })" @click="form.uriRules.splice(index, 1)"><m3e-icon name="close" /></m3e-icon-button>
      </div>
      <m3e-button variant="text" class="editor-text-action" type="button" @click="form.uriRules.push({ uri: '', matchType: 'base-domain' })"><m3e-icon slot="icon" name="add" />{{ tr('添加网址') }}</m3e-button>
    </div>
    <p class="editor-hint">{{ tr('用户名、密码和网址均可留空。') }}</p>
  </section>

  <section v-else-if="form.loginType === 'WIFI'" class="editor-section" :aria-label="tr('Wi-Fi 配置')">
    <h3>{{ tr('Wi-Fi 配置') }}</h3>
    <div class="editor-field-grid">
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">SSID</label><input v-model="form.wifi.ssid" autocomplete="off" /></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('安全类型') }}</label><component :is="materialSelectTag" @input="form.wifi.security = ($event.target as HTMLElement &amp; { value: string }).value" ><component :is="materialOptionTag" :selected.prop="String(form.wifi.security ?? '') === String('NONE')" value="NONE">{{ tr('开放网络') }}</component><component :is="materialOptionTag" :selected.prop="String(form.wifi.security ?? '') === String('WEP')" value="WEP">WEP</component><component :is="materialOptionTag" :selected.prop="String(form.wifi.security ?? '') === String('WPA_WPA2')" value="WPA_WPA2">WPA/WPA2</component><component :is="materialOptionTag" :selected.prop="String(form.wifi.security ?? '') === String('WPA2_WPA3')" value="WPA2_WPA3">WPA2/WPA3</component><component :is="materialOptionTag" :selected.prop="String(form.wifi.security ?? '') === String('WPA3')" value="WPA3">WPA3</component><component :is="materialOptionTag" :selected.prop="String(form.wifi.security ?? '') === String('WPA2_ENTERPRISE')" value="WPA2_ENTERPRISE">{{ tr('WPA2 企业') }}</component><component :is="materialOptionTag" :selected.prop="String(form.wifi.security ?? '') === String('WPA3_ENTERPRISE')" value="WPA3_ENTERPRISE">{{ tr('WPA3 企业') }}</component></component></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"><label slot="label">{{ tr('Wi-Fi 密码') }}</label><input v-model="form.wifiPassword" :aria-label="tr('Wi-Fi 密码')" :type="reveal ? 'text' : 'password'" autocomplete="new-password" /><m3e-button slot="suffix" variant="text" type="button" toggle :selected.prop="reveal" @beforeinput.prevent @click="reveal = !reveal">{{ reveal ? tr('隐藏') : tr('显示') }}</m3e-button></m3e-form-field>
    </div>
    <m3e-expansion-panel class="editor-disclosure"><span slot="header"><span>{{ tr('更多网络设置') }}</span></span><div class="editor-disclosure-body editor-field-grid">
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('企业身份（Identity）') }}</label><input v-model="form.username" autocomplete="off" /></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">BSSID</label><input v-model="form.wifi.bssid" autocomplete="off" /></m3e-form-field>
      <label v-choice-label class="favorite-row field-wide"><m3e-checkbox :checked.prop="form.wifi.hiddenNetwork" @input="form.wifi.hiddenNetwork = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span>{{ tr('隐藏网络') }}</span></label>
      <m3e-expansion-panel class="special-advanced field-wide"><span slot="header">{{ tr('Android 原始元数据') }}</span><m3e-form-field v-field-label variant="filled" hide-required-marker hide-subscript="never" class="field"><label slot="label">JSON</label><textarea v-model="form.wifiMetadataRaw" rows="6" spellcheck="false" /><small slot="hint">{{ tr('代理、静态 IP、EAP 和未来字段保留在此对象中；应用后同步到上方已知字段。') }}</small></m3e-form-field><m3e-button variant="tonal" type="button" @click="emit('applyRaw')">{{ tr('应用原始元数据') }}</m3e-button></m3e-expansion-panel>
    </div></m3e-expansion-panel>
  </section>

  <section v-else-if="form.loginType === 'SSH_KEY'" class="editor-section" :aria-label="tr('SSH 密钥')">
    <h3>{{ tr('SSH 密钥') }}</h3>
    <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('OpenSSH 公钥') }}</label><textarea v-model="form.sshKey.publicKeyOpenSsh" rows="3" spellcheck="false" autocomplete="off" /></m3e-form-field>
    <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label"><span>{{ tr('OpenSSH 私钥') }}</span></label><m3e-button slot="suffix" variant="text" type="button" class="editor-text-action" toggle :selected.prop="revealSsh" @beforeinput.prevent @click="revealSsh = !revealSsh">{{ revealSsh ? tr('隐藏') : tr('显示') }}</m3e-button><textarea v-model="form.sshKey.privateKeyOpenSsh" :aria-label="tr('OpenSSH 私钥')" :class="{ 'concealed-secret': !revealSsh }" rows="5" spellcheck="false" autocomplete="off" /></m3e-form-field>
    <m3e-expansion-panel class="editor-disclosure"><span slot="header"><span>{{ tr('密钥信息与高级设置') }}</span></span><div class="editor-disclosure-body editor-field-grid">
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('算法') }}</label><input v-model="form.sshKey.algorithm" list="ssh-algorithms" autocomplete="off" :readonly="nativeBitwardenSsh" /><datalist id="ssh-algorithms"><option value="ED25519" /><option value="RSA" /></datalist></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('密钥位数') }}</label><input v-model.number="form.sshKey.keySize" type="number" min="0" step="1" inputmode="numeric" /></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"><label slot="label">{{ tr('SHA-256 指纹') }}</label><input v-model="form.sshKey.fingerprintSha256" autocomplete="off" /></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('注释') }}</label><input v-model="form.sshKey.comment" autocomplete="off" /></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('格式') }}</label><input v-model="form.sshKey.format" autocomplete="off" /></m3e-form-field>
      <p v-if="sshFormatHint" class="editor-hint field-wide">{{ sshFormatHint }}</p>
      <m3e-expansion-panel class="special-advanced field-wide"><span slot="header">{{ tr('Android 原始元数据') }}</span><m3e-form-field v-field-label variant="filled" hide-required-marker hide-subscript="never" class="field"><label slot="label">JSON</label><textarea v-model="form.sshKeyDataRaw" rows="6" spellcheck="false" /><small slot="hint">{{ tr('未知字段逐项保留；应用后同步到上方已知字段。') }}</small></m3e-form-field><m3e-button variant="tonal" type="button" @click="emit('applyRaw')">{{ tr('应用原始元数据') }}</m3e-button></m3e-expansion-panel>
    </div></m3e-expansion-panel>
  </section>

  <section v-else-if="form.loginType === 'BARCODE'" class="editor-section"><h3>{{ tr('条码内容') }}</h3><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('条码内容') }}</label><textarea v-model="form.barcodeContent" rows="4" autocomplete="off" spellcheck="false" /></m3e-form-field></section>

  <section class="editor-section editor-extras" :aria-label="tr('补充信息')">
    <h3>{{ tr('补充信息') }}</h3>
    <m3e-expansion-panel v-if="webLogin" class="editor-disclosure" :open.prop="twoFactorOpen" @opened.self="twoFactorOpen = true" @closed.self="twoFactorOpen = false"><span slot="header"><span>{{ tr('两步验证') }}<small>{{ form.boundTotpItemId || form.totpSecret ? tr('已配置') : tr('可选') }}</small></span></span><div class="editor-disclosure-body editor-field-grid">
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('绑定独立验证器') }}</label><component :is="materialSelectTag" @input="form.boundTotpItemId = ($event.target as HTMLElement &amp; { value: string }).value" ><component :is="materialOptionTag" :selected.prop="String(form.boundTotpItemId ?? '') === String('')" value="">{{ tr('不绑定独立项目') }}</component><component :is="materialOptionTag" :selected.prop="String(form.boundTotpItemId ?? '') === String(item.id)" v-for="item in totpItems" :key="item.id" :value="item.id">{{ item.title }} · {{ item.otpType || 'TOTP' }}</component></component></m3e-form-field>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('内嵌验证码密钥') }}</label><input v-model="form.totpSecret" type="password" :disabled="Boolean(form.boundTotpItemId)" autocomplete="new-password" :placeholder="tr('Base32 或 otpauth URI')" /></m3e-form-field>
      <p class="editor-hint field-wide">{{ tr('独立验证器优先；可在登录项详情查看和复制验证码。') }}</p>
    </div></m3e-expansion-panel>
    <m3e-expansion-panel v-if="webLogin" class="editor-disclosure" :open="form.loginType === 'SSO'"><span slot="header"><span>{{ tr('登录方式') }}<small>{{ form.loginType === 'SSO' ? tr('第三方登录') : tr('密码登录') }}</small></span></span><div class="editor-disclosure-body editor-field-grid">
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field field-wide"><label slot="label">{{ tr('登录方式') }}</label><component :is="materialSelectTag" @input="form.loginType = ($event.target as HTMLElement &amp; { value: string }).value" ><component :is="materialOptionTag" :selected.prop="String(form.loginType ?? '') === String('PASSWORD')" value="PASSWORD">{{ tr('密码登录') }}</component><component :is="materialOptionTag" :selected.prop="String(form.loginType ?? '') === String('SSO')" value="SSO">{{ tr('第三方登录（SSO）') }}</component></component></m3e-form-field>
      <template v-if="form.loginType === 'SSO'"><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('SSO 提供商') }}</label><input v-model="form.ssoProvider" list="sso-providers" autocomplete="off" placeholder="GOOGLE" /><datalist id="sso-providers"><option v-for="provider in ssoProviders" :key="provider" :value="provider" /></datalist></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{ tr('引用条目 ID') }}</label><input v-model="form.ssoRefEntryId" inputmode="numeric" :placeholder="tr('可选')" /></m3e-form-field><p class="editor-hint field-wide">{{ tr('用于记录通过 Google、Apple 等账号登录的网站，与 Android 的第三方登录设置一致。') }}</p></template>
    </div></m3e-expansion-panel>
    <m3e-expansion-panel class="editor-disclosure" :open="form.customFields.length > 0"><span slot="header"><span>{{ tr('自定义字段') }}<small>{{ form.customFields.length || tr('可选') }}</small></span></span><div class="editor-disclosure-body">
      <div v-for="(field, index) in form.customFields" :key="index" class="custom-field-row"><m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('自定义字段 {0} 名称', { 0: index + 1 }) }}</label><input v-model="field.name" :aria-label="tr('自定义字段 {0} 名称', { 0: index + 1 })" :placeholder="tr('字段名称')" /></m3e-form-field><m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('自定义字段 {0} 值', { 0: index + 1 }) }}</label><input v-model="field.value" :type="field.protected ? 'password' : 'text'" :aria-label="tr('自定义字段 {0} 值', { 0: index + 1 })" :placeholder="tr('字段值')" autocomplete="off" /></m3e-form-field><label v-choice-label class="compact-check"><m3e-checkbox :checked.prop="field.protected" @input="field.protected = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span>{{ tr('隐藏') }}</span></label><m3e-icon-button type="button" :aria-label="tr('删除自定义字段 {0}', { 0: index + 1 })" @click="form.customFields.splice(index, 1)"><m3e-icon name="close" /></m3e-icon-button></div>
      <m3e-button variant="text" class="editor-text-action" type="button" @click="form.customFields.push({ name: '', value: '', protected: false })"><m3e-icon slot="icon" name="add" />{{ tr('添加字段') }}</m3e-button>
    </div></m3e-expansion-panel>
    <m3e-expansion-panel v-if="!webLogin" class="editor-disclosure"><span slot="header"><span>{{ form.loginType === 'BARCODE' ? tr('复制与条码') : tr('复制与二维码') }}</span></span><div class="editor-disclosure-body special-transfer">
      <m3e-radio-group v-if="form.loginType === 'BARCODE'" class="barcode-render-modes" :aria-label="tr('条码显示方式')"><label v-choice-label><m3e-radio :checked.prop="barcodeMode === 'qr'" @input="barcodeMode = 'qr'"   value="qr" @change="emit('clearQr')" /><span>QR</span></label><label v-choice-label><m3e-radio :checked.prop="barcodeMode === 'code128'" @input="barcodeMode = 'code128'"   value="code128" @change="emit('clearQr')" /><span>Code 128</span></label></m3e-radio-group>
      <div class="special-transfer-actions"><m3e-button variant="tonal" type="button" @click="emit('copyPayload')"><m3e-icon slot="icon" name="content_copy" />{{ tr('复制') }}</m3e-button><m3e-button variant="text" type="button" @click="emit('generateQr')"><m3e-icon slot="icon" name="qr_code_2" />{{ form.loginType === 'BARCODE' && barcodeMode === 'code128' ? tr('生成条码') : tr('生成二维码') }}</m3e-button></div>
      <img v-if="qrDataUrl" :class="{ 'barcode-linear-preview': form.loginType === 'BARCODE' && barcodeMode === 'code128' }" :src="qrDataUrl" :alt="form.loginType === 'BARCODE' ? `BARCODE ${barcodeMode === 'code128' ? tr('Code 128 条码') : tr('QR 二维码')}` : tr('{0} 二维码', { 0: form.loginType })" width="240" :height="form.loginType === 'BARCODE' && barcodeMode === 'code128' ? 96 : 240" />
      <p v-if="qrError" class="form-error" role="alert">{{ qrError }}</p>
    </div></m3e-expansion-panel>
    <m3e-form-field v-field-label variant="filled" hide-required-marker class="field editor-notes"><label slot="label">{{ tr('备注') }}</label><textarea v-model="form.notes" rows="3" :placeholder="tr('可选备注')" /></m3e-form-field>
    <label v-choice-label class="favorite-row"><m3e-checkbox :checked.prop="form.favorite" @input="form.favorite = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span>{{ tr('收藏并优先显示') }}</span></label>
    <m3e-expansion-panel class="editor-disclosure" :open="form.allowLockedAutofill || form.archived"><span slot="header"><span>{{ tr('更多选项') }}</span></span><div class="editor-disclosure-body">
      <label v-choice-label v-if="form.loginType === 'PASSWORD' && !form.archived" class="locked-autofill-option"><m3e-checkbox :checked.prop="form.allowLockedAutofill" @input="form.allowLockedAutofill = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span><strong>{{ tr('允许免解锁填写') }}</strong><small>{{ tr('在此浏览器保存独立加密副本。锁定后，使用此浏览器的人仍可点击填写该账号的用户名和密码；验证码和 Passkey 仍需解锁。') }}</small></span></label>
      <label v-choice-label class="favorite-row"><m3e-checkbox :checked.prop="form.archived" @input="form.archived = ($event.target as HTMLElement &amp; { checked: boolean }).checked"   /><span>{{ tr('归档并停止自动填充') }}</span></label>
    </div></m3e-expansion-panel>
  </section>
</template>
