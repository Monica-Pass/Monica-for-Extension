<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { tr } from '../i18n';
import type { VaultItem } from '../core/model';
import { vaultClient } from '../runtime/client';
import { createTransferExport, exportableItems, MAX_IMPORT_BYTES, previewImport, type ExportFormat, type FileImportPreview, type TransferFormat } from '../manager/file-transfer';
import type { VaultExportResult } from '../security/authenticated-export';
import AuthenticatedExportDialog from './AuthenticatedExportDialog.vue';
import SettingsPasswordField from './SettingsPasswordField.vue';
import type { AndroidBackupEncryptionFormat } from '../providers/webdav/android-backup-crypto';

const props = defineProps<{ items: VaultItem[]; mode: 'master-password' | 'device-key' | 'unknown'; helloAvailable: boolean }>();
const emit = defineEmits<{ imported: []; busy: [value: boolean]; backup: []; mdbx: [] }>();
const file = shallowRef<File>(), keyFile = shallowRef<File>();
const sourceFormat = ref<TransferFormat>('auto'), destinationFormat = ref<ExportFormat>('zip');
const password = ref(''), exportPassword = ref(''), exportConfirmation = ref('');
const backupEncryptionFormat = ref<AndroidBackupEncryptionFormat>('v1');
const preview = shallowRef<FileImportPreview>();
const busy = ref(false), error = ref(''), status = ref(''), authenticating = ref(false);
let active = true;
const formats: { value: ExportFormat; label: string; hint: string }[] = [
  { value: 'zip', label: 'Monica ZIP', hint: 'Android 项目备份，可设置文件密码。' },
  { value: 'kdbx', label: 'KeePass KDBX', hint: '加密数据库，需要设置文件密码。' },
  { value: 'json', label: 'Monica JSON', hint: '全部项目，保留插件字段。' },
  { value: 'csv', label: '密码 CSV', hint: '仅登录项：标题、网址、账号、密码、备注、OTP 与分类。' },
  { value: 'aegis', label: 'Aegis JSON', hint: '仅 TOTP / HOTP 验证器，明文文件。' },
  { value: 'stratum', label: 'Stratum JSON', hint: '仅 TOTP / HOTP 验证器，明文文件。' },
  { value: 'otp', label: 'OTP URI', hint: '验证器 URI 列表，包含密钥与 OTP 参数。' },
  { value: 'steam', label: 'Steam maFile', hint: '仅 Steam 账户；多个账户打包为 ZIP。' }
];
const selectedFormat = computed(() => formats.find(format => format.value === destinationFormat.value)!);
const count = computed(() => exportableItems(props.items, destinationFormat.value).length);
const total = computed(() => props.items.filter(item => !item.deletedAt && !item.archivedAt).length);
const protectedFile = computed(() => ['zip', 'kdbx'].includes(destinationFormat.value));
const plaintextExport = computed(() => !protectedFile.value || destinationFormat.value === 'zip' && backupEncryptionFormat.value === 'v1' && !exportPassword.value);
const exportPasswordLabel = computed(() => destinationFormat.value === 'kdbx' ? 'KDBX 文件密码'
  : backupEncryptionFormat.value === 'v2' ? 'ZIP 文件密码（增强 V2 必填）' : '文件密码（留空导出明文 ZIP）');
watch([busy, authenticating], ([processing, verifying]) => emit('busy', processing || verifying));
watch([sourceFormat, password, keyFile], () => { preview.value = undefined; status.value = ''; }, { flush: 'sync' });
watch(destinationFormat, () => { exportPassword.value = exportConfirmation.value = ''; backupEncryptionFormat.value = 'v1'; error.value = ''; });
watch(backupEncryptionFormat, () => { error.value = ''; });
onBeforeUnmount(() => { active = false; password.value = exportPassword.value = exportConfirmation.value = ''; preview.value = undefined; file.value = keyFile.value = undefined; emit('busy', false); });

function selectFile(event: Event, key = false) {
  const input = event.target as HTMLInputElement, chosen = input.files?.[0]; input.value = '';
  preview.value = undefined; error.value = status.value = '';
  if (!chosen) return;
  if (key) keyFile.value = chosen;
  else { file.value = chosen; password.value = ''; keyFile.value = undefined; }
}
async function read() {
  if (busy.value || !file.value) return;
  busy.value = true; error.value = status.value = ''; preview.value = undefined;
  try {
    if (file.value.size > MAX_IMPORT_BYTES) throw new Error('文件为空或超过 64 MB。');
    if (keyFile.value && keyFile.value.size > 1024 * 1024) throw new Error('密钥文件超过 1 MB。');
    const result = await previewImport({ name: file.value.name, bytes: new Uint8Array(await file.value.arrayBuffer()), format: sourceFormat.value,
      password: password.value, keyFile: keyFile.value ? new Uint8Array(await keyFile.value.arrayBuffer()) : undefined });
    if (active) { password.value = ''; keyFile.value = undefined; preview.value = result; }
  } catch (cause) { if (active) error.value = cause instanceof Error ? tr(cause.message) : tr('读取失败，请检查文件格式和密码。'); }
  finally { busy.value = false; }
}
async function commit() {
  if (busy.value || !preview.value) return;
  busy.value = true; error.value = '';
  try {
    const count = preview.value.items.length;
    await vaultClient.importItems(preview.value.items);
    if (active) { preview.value = undefined; file.value = undefined; status.value = tr('已加密导入 {0} 个密码库项目。', { 0: count }); emit('imported'); }
  } catch { if (active) error.value = tr('导入失败，当前密码库未完成写入，请重新解锁后重试。'); }
  finally { busy.value = false; }
}
function startExport() {
  error.value = status.value = '';
  if (protectedFile.value && exportPassword.value !== exportConfirmation.value) { error.value = tr('两次输入的文件密码不一致。'); return; }
  if (destinationFormat.value === 'kdbx' && !exportPassword.value) { error.value = tr('请设置 KDBX 文件密码。'); return; }
  if (destinationFormat.value === 'zip' && backupEncryptionFormat.value === 'v2' && !exportPassword.value) { error.value = tr('增强 V2 ZIP 导出必须设置文件密码。'); return; }
  authenticating.value = true;
}
function closeAuthentication() {
  authenticating.value = false;
  exportPassword.value = exportConfirmation.value = '';
}
async function finishExport(result: VaultExportResult) {
  if (!active || result.format !== 'plaintext' || busy.value) return;
  busy.value = true;
  const format = destinationFormat.value, secret = exportPassword.value, encryptionFormat = backupEncryptionFormat.value;
  exportPassword.value = exportConfirmation.value = '';
  try {
    const output = await createTransferExport(result.items, format, secret, encryptionFormat);
    const lifecycle = await vaultClient.status();
    if (!active) return;
    if (lifecycle !== 'unlocked') { error.value = tr('密码库已锁定，请先解锁 Monica。'); return; }
    const url = URL.createObjectURL(new Blob([output.bytes as BlobPart], { type: 'application/octet-stream' }));
    try {
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = `monica-${format}-${new Date().toISOString().slice(0, 10)}.${output.extension}`;
      anchor.click();
      status.value = tr('已导出 {0} 个项目，请妥善保管文件。', { 0: output.count });
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  } catch (cause) { if (active) error.value = cause instanceof Error ? tr(cause.message) : tr('导出失败，请重试。'); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="transfer-settings">
    <section class="transfer-section" aria-labelledby="transfer-import-title">
      <header class="transfer-heading"><span class="transfer-icon"><m3e-icon name="upload" /></span><div><h2 id="transfer-import-title">{{ tr('导入文件') }}</h2><p>{{ tr('先读取预览，再导入到 Monica 本地库。已有项目保持不变。') }}</p></div></header>
      <div class="format-guide">
        <div><m3e-icon name="archive" /><span><strong>Monica ZIP · KeePass KDBX</strong><small>{{ tr('支持文件密码；KDBX 可使用密钥文件') }}</small></span></div>
        <div><m3e-icon name="table_chart" /><span><strong>JSON · CSV</strong><small>{{ tr('Monica、Bitwarden、KeePass、Chrome、Proton Pass') }}</small></span></div>
        <div><m3e-icon name="security" /><span><strong>Aegis · Stratum · Steam</strong><small>{{ tr('加密或明文验证器备份、OTP URI、明文 maFile') }}</small></span></div>
      </div>
      <fieldset :disabled="busy" class="transfer-fields">
        <label class="file-action"><m3e-icon name="upload_file" /><span>{{ file?.name || tr('选择导入文件') }}</span><input data-transfer-file type="file" accept=".json,.csv,.zip,.kdbx,.txt,.html,.htm,.mafile,.bin,.backup" @change="selectFile($event)" /></label>
        <label class="transfer-select"><span>{{ tr('导入格式') }}</span><select v-model="sourceFormat"><option value="auto">{{ tr('自动识别') }}</option><option v-for="format in formats" :key="format.value" :value="format.value">{{ tr(format.label) }}</option></select></label>
        <template v-if="file">
          <SettingsPasswordField v-model="password" :label="tr('文件密码（如有）')" autocomplete="off" />
          <label v-if="sourceFormat === 'kdbx' || /\.kdbx$/i.test(file.name)" class="file-action"><m3e-icon name="key" /><span>{{ keyFile?.name || tr('选择密钥文件（可选）') }}</span><input data-transfer-key type="file" @change="selectFile($event, true)" /></label>
          <m3e-button variant="tonal" :disabled="busy" @click="read">{{ busy ? tr('正在处理…') : tr('读取并预览') }}</m3e-button>
        </template>
      </fieldset>
      <div v-if="preview" class="transfer-preview" data-transfer-preview role="status">
        <strong>{{ tr('可导入 {0} 个项目', { 0: preview.items.length }) }}</strong>
        <p>{{ tr('导入到 Monica 本地库，新增独立副本。') }}</p>
        <p v-if="preview.skipped">{{ tr('跳过 {0} 个不支持、已归档或已删除的项目。', { 0: preview.skipped }) }}</p>
        <p v-for="warning in preview.warnings" :key="warning">{{ tr(warning) }}</p>
        <m3e-button variant="filled" :disabled="busy" @click="commit">{{ tr('导入 {0} 个项目', { 0: preview.items.length }) }}</m3e-button>
      </div>
    </section>
    <section class="transfer-section" aria-labelledby="transfer-export-title">
      <header class="transfer-heading"><span class="transfer-icon"><m3e-icon name="download" /></span><div><h2 id="transfer-export-title">{{ tr('导出文件') }}</h2><p>{{ tr('选择适合接收应用的格式。每次导出都需要验证身份。') }}</p></div></header>
      <fieldset :disabled="busy || authenticating" class="transfer-fields">
        <label class="transfer-select"><span>{{ tr('导出格式') }}</span><select v-model="destinationFormat" data-transfer-export-format><option v-for="format in formats" :key="format.value" :value="format.value">{{ tr(format.label) }}</option></select></label>
        <p class="supporting">{{ tr(selectedFormat.hint) }}</p>
        <p class="transfer-scope">{{ tr('此格式将导出 {0} / {1} 个项目。', { 0: count, 1: total }) }} {{ tr('不含回收站、附件文件与连接配置。') }}</p>
        <template v-if="destinationFormat === 'zip'">
          <label class="transfer-select"><span>{{ tr('ZIP 加密格式') }}</span><select v-model="backupEncryptionFormat" data-transfer-encryption-format><option value="v1">V1 · 100k</option><option value="v2">V2 · 600k</option></select></label>
          <p class="supporting" data-transfer-encryption-summary>{{ tr(backupEncryptionFormat === 'v2' ? '增强 V2（600,000 次）' : '兼容 V1（100,000 次）') }}</p>
          <p v-if="backupEncryptionFormat === 'v2'" class="supporting">{{ tr('增强 V2 需要支持此格式的接收端；旧备份保持不变。') }}</p>
        </template>
        <template v-if="protectedFile"><SettingsPasswordField v-model="exportPassword" :label="tr(exportPasswordLabel)" autocomplete="new-password" /><SettingsPasswordField v-if="exportPassword" v-model="exportConfirmation" :label="tr('确认文件密码')" autocomplete="new-password" /></template>
        <p v-if="plaintextExport" class="settings-safety-note">{{ tr('明文文件包含密码等敏感信息，请保存到可信位置。') }}<template v-if="destinationFormat === 'csv'"> {{ tr('CSV 保留原始字段值，请勿在电子表格中执行公式。') }}</template></p>
        <m3e-button variant="filled" :disabled="busy || !count" @click="startExport"><m3e-icon slot="icon" name="fingerprint" />{{ busy ? tr('正在处理…') : tr('验证身份并导出') }}</m3e-button>
      </fieldset>
    </section>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p><p v-if="status" class="transfer-status" role="status">{{ status }}</p>
    <button class="transfer-backup" @click="emit('mdbx')"><m3e-icon name="database" /><span><strong>{{ tr('打开 MDBX 密码库') }}</strong><small>{{ tr('导入独立 MDBX 或完整备份 ZIP，作为新的密码源。原始文件不会被修改。') }}</small></span><m3e-icon name="chevron_right" /></button>
    <button class="transfer-backup" @click="emit('backup')"><m3e-icon name="encrypted" /><span><strong>{{ tr('加密备份与恢复') }}</strong><small>{{ tr('恢复插件状态（条目与密码源配置）。独立 MDBX 数据库需要单独的 MDBX 备份。') }}</small></span><m3e-icon name="chevron_right" /></button>
    <AuthenticatedExportDialog v-if="authenticating" format="plaintext" :mode="mode" :hello-available="helloAvailable" :count="count" :title="tr('验证身份并导出')" :description="tr('此格式将导出 {0} / {1} 个项目。', { 0: count, 1: total }) + ' ' + tr(selectedFormat.hint)" @close="closeAuthentication" @exported="finishExport" />
  </div>
</template>

<style scoped>
.transfer-settings { display: grid; gap: 24px; }
.transfer-section { display: grid; gap: 18px; min-width: 0; }
.transfer-section + .transfer-section { border-top: 1px solid var(--md-sys-color-outline-variant); padding-top: 24px; }
.transfer-heading { display: flex; gap: 14px; align-items: flex-start; }
.transfer-heading p { margin: 6px 0 0; color: var(--md-sys-color-on-surface-variant); line-height: 1.6; font-size: .875rem; }
.transfer-icon { width: 44px; height: 44px; border-radius: 16px; display: grid; place-items: center; flex-shrink: 0; background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.format-guide { display: grid; gap: 3px; border-radius: 20px; overflow: hidden; }
.format-guide > div, .transfer-backup { display: flex; gap: 14px; padding: 16px; background: var(--md-sys-color-surface-container); align-items: center; }
.format-guide span, .transfer-backup span { display: grid; gap: 5px; min-width: 0; flex: 1; }
small { color: var(--md-sys-color-on-surface-variant); line-height: 1.5; }
.transfer-fields { border: 0; padding: 0; margin: 0; display: grid; gap: 14px; min-width: 0; }
.transfer-fields > m3e-button { justify-self: start; }
.transfer-select { display: grid; gap: 8px; font-size: .875rem; }
.transfer-select select { width: 100%; min-height: 52px; padding: 12px 16px; border: 1px solid var(--md-sys-color-outline); border-radius: 12px; font: inherit; background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface); }
.transfer-preview { border-radius: 20px; padding: 20px; background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.transfer-preview p, .transfer-scope { font-size: .875rem; line-height: 1.6; }
.transfer-backup { border: 0; border-radius: 20px; color: inherit; font: inherit; text-align: start; cursor: pointer; }
.transfer-status { color: var(--md-sys-color-primary); }
.transfer-backup:focus-visible, select:focus-visible { outline: 2px solid var(--md-sys-color-primary); outline-offset: 3px; }
@media (max-width: 480px) { .transfer-fields > m3e-button { width: 100%; } }
</style>
