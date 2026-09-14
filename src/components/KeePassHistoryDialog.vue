<script setup lang="ts">
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { tr, locale } from '../i18n';

import { computed, nextTick, onMounted, ref } from "vue";
import type { ProviderAccount, VaultItem } from "../core/model";
import type {
  KeePassHistoryDetail,
  KeePassHistoryFieldValue,
  KeePassHistorySummary
} from "../providers/keepass/keepass-history";
import { vaultClient } from "../runtime/client";

const props = defineProps<{
  item: VaultItem;
  providers: ProviderAccount[];
}>();

const emit = defineEmits<{
  close: [];
  changed: [];
  notice: [message: string];
}>();

const selectedProviderId = ref(props.providers[0]?.id ?? "");
const history = ref<KeePassHistorySummary[]>([]);
const nextCursor = ref<string | undefined>();
const totalCount = ref(0);
const loaded = ref(false);
const busy = ref("");
const error = ref("");
const status = ref("");
const selectedHistoryId = ref("");
const detail = ref<KeePassHistoryDetail>();
const revealedFields = ref<Record<string, KeePassHistoryFieldValue>>({});
const confirmRestore = ref(false);
const dialogRoot = ref<HTMLElement | null>(null);
let retryOperation: { intent: string; operationId: string } | undefined;
let loadGeneration = 0;

const selectedProvider = computed(() => props.providers.find((provider) => provider.id === selectedProviderId.value));
const selectedSummary = computed(() => history.value.find((item) => item.historyId === selectedHistoryId.value));
const restoreBusy = computed(() => busy.value === "restore");

onMounted(() => loadHistory(true));

async function changeProvider() {
  selectedHistoryId.value = "";
  detail.value = undefined;
  revealedFields.value = {};
  confirmRestore.value = false;
  retryOperation = undefined;
  await loadHistory(true);
}

async function loadHistory(reset: boolean) {
  const provider = selectedProvider.value;
  if (!provider) return;
  const generation = ++loadGeneration;
  busy.value = "list";
  error.value = "";
  if (reset) {
    history.value = [];
    nextCursor.value = undefined;
    totalCount.value = 0;
    loaded.value = false;
  }
  try {
    const page = await vaultClient.listKeePassHistory(provider.id, props.item.id, {
      pageSize: 50,
      cursor: reset ? undefined : nextCursor.value
    });
    if (generation !== loadGeneration) return;
    history.value = reset ? page.items : appendUnique(history.value, page.items);
    totalCount.value = page.totalCount;
    nextCursor.value = page.nextCursor;
    loaded.value = true;
    if (selectedHistoryId.value && !history.value.some((item) => item.historyId === selectedHistoryId.value)) {
      clearSelection();
    }
  } catch (cause) {
    if (generation === loadGeneration) error.value = errorMessage(cause);
  } finally {
    if (generation === loadGeneration) busy.value = "";
  }
}

async function selectHistory(summary: KeePassHistorySummary) {
  if (restoreBusy.value) return;
  if (selectedHistoryId.value === summary.historyId) {
    clearSelection();
    return;
  }
  selectedHistoryId.value = summary.historyId;
  detail.value = undefined;
  revealedFields.value = {};
  confirmRestore.value = false;
  retryOperation = undefined;
  error.value = "";
  status.value = "";
  const provider = selectedProvider.value;
  if (!provider) return;
  busy.value = "detail";
  try {
    detail.value = await vaultClient.getKeePassHistoryDetail(provider.id, props.item.id, summary.historyId);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function toggleField(fieldId: string) {
  if (revealedFields.value[fieldId]) {
    const next = { ...revealedFields.value };
    delete next[fieldId];
    revealedFields.value = next;
    return;
  }
  const provider = selectedProvider.value;
  if (!provider || !selectedHistoryId.value) return;
  busy.value = `field:${fieldId}`;
  error.value = "";
  try {
    const field = await vaultClient.revealKeePassHistoryField(provider.id, props.item.id, selectedHistoryId.value, fieldId);
    revealedFields.value = { ...revealedFields.value, [fieldId]: field };
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

async function prepareRestore() {
  if (!detail.value) return;
  confirmRestore.value = true;
  error.value = "";
  status.value = "";
  await nextTick();
  dialogRoot.value?.querySelector<HTMLElement>("[data-confirm-history-restore]")?.focus();
}

async function restoreHistory() {
  const provider = selectedProvider.value;
  const historyId = selectedHistoryId.value;
  if (!provider || !historyId) return;
  const intent = `${provider.id}:${props.item.id}:${historyId}`;
  const operationId = operationIdFor(intent);
  let committed = false;
  busy.value = "restore";
  error.value = "";
  status.value = "";
  try {
    const result = await vaultClient.restoreKeePassHistory(provider.id, props.item.id, operationId, historyId);
    committed = true;
    const sync = await vaultClient.syncProvider(provider.id);
    retryOperation = undefined;
    confirmRestore.value = false;
    clearSelection();
    emit("changed");
    const message = tr('已恢复 KeePass 历史版本，并保留 {0} 个历史状态。需要导出 KDBX 才会永久保存。', { 0: result.historyCount });
    status.value = sync.warnings.length ? `${message} ${sync.warnings.join(" ")}` : message;
    emit("notice", message);
    await loadHistory(true);
    await nextTick();
    dialogRoot.value?.querySelector<HTMLElement>('[data-refresh-history]')?.focus();
  } catch (cause) {
    error.value = committed
      ? tr('历史版本已经恢复，但刷新 Monica 密码库失败。使用同一按钮重试不会重复恢复：{0}', { 0: errorMessage(cause) })
      : errorMessage(cause);
  } finally {
    busy.value = "";
  }
}

function operationIdFor(intent: string): string {
  if (!retryOperation || retryOperation.intent !== intent) {
    retryOperation = { intent, operationId: crypto.randomUUID() };
  }
  return retryOperation.operationId;
}

function clearSelection() {
  selectedHistoryId.value = "";
  detail.value = undefined;
  revealedFields.value = {};
  confirmRestore.value = false;
  retryOperation = undefined;
}

function closeDialog() {
  if (!restoreBusy.value) emit("close");
}

function formatDate(value?: string): string {
  if (!value) return tr('时间未知');
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(locale.value) : tr('时间未知');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function summaryText(item: KeePassHistorySummary): string {
  return tr('{0} 个字段 · {1} 个受保护 · {2} 个附件', { 0: item.fieldCount, 1: item.protectedFieldCount, 2: item.attachmentCount });
}

function appendUnique(current: KeePassHistorySummary[], incoming: KeePassHistorySummary[]): KeePassHistorySummary[] {
  const ids = new Set(current.map((item) => item.historyId));
  return [...current, ...incoming.filter((item) => !ids.has(item.historyId))];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
</script>

<template>
  <div class="modal-backdrop keepass-history-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section ref="dialogRoot" class="editor-dialog keepass-history-dialog" role="dialog" aria-modal="true" :aria-labelledby="'keepass-history-title'">
      <header>
        <div>
          <h2 id="keepass-history-title">{{ tr('KeePass 历史 · {0}', { 0: item.title }) }}</h2>
          <p>{{ tr('历史值按字段逐项读取；恢复前会先保存当前版本，完成后需要导出 KDBX。') }}</p>
        </div>
        <m3e-icon-button data-dialog-close :aria-label="tr('关闭 KeePass 历史')" :disabled="restoreBusy" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <div class="keepass-history-boundary"><m3e-icon name="encrypted"></m3e-icon><span>{{ tr('仅 Monica 管理页能够读取历史。Popup 和网页内容脚本无法访问历史字段、附件信息或恢复操作。') }}</span></div>

      <m3e-form-field v-field-label variant="filled" hide-required-marker v-if="providers.length > 1" class="keepass-history-provider"><label slot="label">{{ tr('历史来源') }}</label><component :is="materialSelectTag" @input="selectedProviderId = ($event.target as HTMLElement &amp; { value: string }).value"  :disabled="Boolean(busy)" @change="changeProvider"><component :is="materialOptionTag" :selected.prop="String(selectedProviderId ?? '') === String(provider.id)" v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</component></component></m3e-form-field>

      <div v-if="error" class="keepass-history-error" role="alert"><m3e-icon name="error"></m3e-icon><span>{{ error }}</span></div>
      <p class="keepass-history-status" aria-live="polite">{{ status }}</p>

      <div class="keepass-history-layout">
        <section class="keepass-history-list-shell" aria-labelledby="keepass-history-list-heading">
          <div class="keepass-history-section-heading">
            <div><strong id="keepass-history-list-heading">{{ tr('历史版本') }}</strong><small>{{ tr('{0} / {1} 个已加载', { 0: history.length, 1: totalCount }) }}</small></div>
            <m3e-icon-button data-refresh-history :aria-label="tr('刷新 KeePass 历史')" :disabled="Boolean(busy)" @click="loadHistory(true)"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button>
          </div>
          <div v-if="busy === 'list' && !loaded" class="keepass-history-empty" role="status"><m3e-icon name="progress_activity"></m3e-icon><span>{{ tr('正在读取历史摘要…') }}</span></div>
          <div v-else-if="loaded && !history.length" class="keepass-history-empty"><m3e-icon name="history_toggle_off"></m3e-icon><span>{{ tr('此 KeePass 条目还没有历史版本。') }}</span></div>
          <ol v-else class="keepass-history-list">
            <li v-for="(historyItem, index) in history" :key="historyItem.historyId">
              <m3e-list-action role="presentation" class="keepass-history-row" :class="{ selected: selectedHistoryId === historyItem.historyId }" v-list-action="{ expanded: selectedHistoryId === historyItem.historyId }" :disabled="restoreBusy" @click="selectHistory(historyItem)">
                <span slot="leading" class="keepass-history-icon" aria-hidden="true"><m3e-icon name="history"></m3e-icon></span>
                <strong>{{ formatDate(historyItem.modifiedAt) }}</strong><span slot="supporting-text" class="keepass-history-copy"><small>{{ index === 0 ? tr('最近的历史版本') : tr('更早版本 {0}', { 0: index + 1 }) }}</small><small>{{ summaryText(historyItem) }}</small></span>
                <m3e-icon slot="trailing" name="chevron_right"></m3e-icon>
              </m3e-list-action>
            </li>
          </ol>
          <div v-if="nextCursor" class="keepass-history-more"><m3e-button variant="text" type="button" :disabled="Boolean(busy)" @click="loadHistory(false)">{{ tr('加载更多历史') }}</m3e-button></div>
        </section>

        <section class="keepass-history-detail-shell" aria-labelledby="keepass-history-detail-heading">
          <div class="keepass-history-section-heading"><div><strong id="keepass-history-detail-heading">{{ tr('版本详情') }}</strong><small>{{ tr('字段值默认隐藏') }}</small></div></div>
          <div v-if="busy === 'detail'" class="keepass-history-empty" role="status"><m3e-icon name="progress_activity"></m3e-icon><span>{{ tr('正在读取版本结构…') }}</span></div>
          <div v-else-if="!detail" class="keepass-history-empty"><m3e-icon name="touch_app"></m3e-icon><span>{{ tr('选择左侧历史版本查看字段和附件摘要。') }}</span></div>
          <div v-else class="keepass-history-detail">
            <dl class="keepass-history-facts">
              <div><dt>{{ tr('修改时间') }}</dt><dd>{{ formatDate(detail.modifiedAt) }}</dd></div>
              <div><dt>{{ tr('标签') }}</dt><dd>{{ tr('{0} 项', { 0: detail.tagCount }) }}</dd></div>
              <div><dt>{{ tr('自定义元数据') }}</dt><dd>{{ tr('{0} 项', { 0: detail.customDataCount }) }}</dd></div>
              <div><dt>AutoType</dt><dd>{{ tr('{0} · {1} 条规则', { 0: detail.autoType.enabled ? tr('启用') : tr('关闭'), 1: detail.autoType.itemCount }) }}</dd></div>
              <div><dt>{{ tr('质量检查') }}</dt><dd>{{ detail.qualityCheck === undefined ? tr('未设置') : detail.qualityCheck ? tr('启用') : tr('关闭') }}</dd></div>
              <div><dt>{{ tr('到期') }}</dt><dd>{{ detail.expires ? formatDate(detail.expiryAt) : tr('永不过期') }}</dd></div>
            </dl>

            <section class="keepass-history-fields" aria-labelledby="keepass-history-fields-heading">
              <h3 id="keepass-history-fields-heading">{{ tr('字段') }}</h3>
              <ul>
                <li v-for="field in detail.fields" :key="field.fieldId">
                  <div class="keepass-history-field-head"><span><strong>{{ field.name }}</strong><small>{{ field.protected ? tr('受保护字段') : tr('普通字段') }} · {{ formatBytes(field.sizeBytes) }}<template v-if="field.nameTruncated">{{ tr('· 名称仅显示摘要') }}</template></small></span><m3e-button variant="text" type="button" :disabled="Boolean(busy) && busy !== `field:${field.fieldId}`" @click="toggleField(field.fieldId)"><m3e-icon slot="icon" :name="revealedFields[field.fieldId] ? 'visibility_off' : field.protected ? 'lock_open' : 'visibility'"></m3e-icon>{{ busy === `field:${field.fieldId}` ? tr('读取中…') : revealedFields[field.fieldId] ? tr('隐藏') : tr('查看') }}</m3e-button></div>
                  <pre v-if="revealedFields[field.fieldId]" class="keepass-history-field-value">{{ revealedFields[field.fieldId].value }}</pre>
                </li>
              </ul>
            </section>

            <section class="keepass-history-attachments" aria-labelledby="keepass-history-attachments-heading">
              <h3 id="keepass-history-attachments-heading">{{ tr('附件摘要') }}</h3>
              <p v-if="!detail.attachments.length">{{ tr('此版本没有附件。') }}</p>
              <ul v-else><li v-for="attachment in detail.attachments" :key="`${attachment.fileName}:${attachment.sizeBytes}`"><m3e-icon name="attach_file"></m3e-icon><span><strong>{{ attachment.fileName }}</strong><small>{{ formatBytes(attachment.sizeBytes) }} · {{ attachment.protected ? tr('受保护') : tr('普通附件') }}<template v-if="attachment.fileNameTruncated">{{ tr('· 名称仅显示摘要') }}</template></small></span></li></ul>
            </section>

            <div v-if="!confirmRestore" class="keepass-history-restore-action"><m3e-button variant="tonal" type="button" :disabled="Boolean(busy)" @click="prepareRestore"><m3e-icon slot="icon" name="restore"></m3e-icon>{{ tr('准备恢复此版本') }}</m3e-button></div>
            <div v-else class="keepass-history-restore-confirmation">
              <m3e-icon name="warning"></m3e-icon>
              <span><strong>{{ tr('恢复 {0} 的版本？', { 0: formatDate(selectedSummary?.modifiedAt) }) }}</strong><small>{{ tr('当前字段、附件、标签、AutoType 和自定义元数据将被替换；当前版本会先加入历史。修改只在内存中，仍需导出 KDBX。') }}</small></span>
              <div><m3e-button variant="text" type="button" :disabled="restoreBusy" @click="confirmRestore = false">{{ tr('取消') }}</m3e-button><m3e-button data-confirm-history-restore class="keepass-history-confirm-restore" variant="tonal" type="button" :disabled="restoreBusy" @click="restoreHistory">{{ restoreBusy ? tr('恢复并同步中…') : tr('确认恢复此版本') }}</m3e-button></div>
            </div>
          </div>
        </section>
      </div>

      <footer><span>{{ tr('字段值仅在本对话框中按需解密。') }}</span><m3e-button variant="text" type="button" :disabled="restoreBusy" @click="closeDialog">{{ tr('关闭') }}</m3e-button></footer>
    </section>
  </div>
</template>

<style scoped>
.keepass-history-dialog { width: min(100%, 980px); max-height: calc(100dvh - 32px); overflow: auto; overflow-x: hidden; border-radius: 16px; }
.keepass-history-dialog :deep(m3e-icon) { --m3e-icon-size: 20px; }
.keepass-history-dialog :deep(m3e-icon-button) { --m3e-icon-button-icon-size: 20px; }
.keepass-history-dialog :deep(m3e-button) { --m3e-button-icon-size: 20px; min-height: 44px; }
.keepass-history-dialog > header, .keepass-history-dialog > header > div { min-width: 0; overflow-x: clip; }
.keepass-history-boundary, .keepass-history-error { min-height: 48px; border-radius: 8px; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.5; }
.keepass-history-boundary { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.keepass-history-error { border: 1px solid var(--md-sys-color-error, var(--app-primary)); color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.keepass-history-provider { display: grid; gap: 6px; margin-bottom: 12px; font-weight: 600; }
.keepass-history-provider select { min-height: 44px; border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; padding: 8px 12px; color: var(--app-text); background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); font: inherit; }
.keepass-history-status { min-height: 24px; margin: 0 0 8px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); line-height: 1.5; }
.keepass-history-layout { min-width: 0; display: grid; grid-template-columns: minmax(280px, 0.82fr) minmax(0, 1.18fr); gap: 12px; align-items: start; }
.keepass-history-list-shell, .keepass-history-detail-shell { min-width: 0; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.keepass-history-section-heading { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 10px 16px; }
.keepass-history-section-heading > div { min-width: 0; display: grid; gap: 2px; }
.keepass-history-section-heading small, .keepass-history-copy small, .keepass-history-field-head small, .keepass-history-attachments small, .keepass-history-restore-confirmation small { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); overflow-wrap: anywhere; }
.keepass-history-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.keepass-history-list > li + li { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.keepass-history-row { min-width: 0; width: 100%; --m3e-list-item-two-line-height: 72px; }
.keepass-history-row > strong { font-weight: 500; overflow-wrap: anywhere; }
.keepass-history-row.selected {  --m3e-list-item-container-color: var(--md-sys-color-secondary-container, var(--app-selected));  }
.keepass-history-row:disabled { cursor: default; opacity: .6; }
.keepass-history-icon { width: 40px; height: 40px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.keepass-history-copy { min-width: 0; display: grid; gap: 2px; }
.keepass-history-copy strong { overflow-wrap: anywhere; }
.keepass-history-more { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; justify-content: center; padding: 4px 12px; }
.keepass-history-empty { min-height: 120px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); text-align: center; line-height: 1.5; }
.keepass-history-empty > m3e-icon { inline-size: 24px; block-size: 24px; flex: 0 0 24px; display: grid; place-items: center; line-height: 1; }
.keepass-history-detail { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.keepass-history-facts { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.keepass-history-facts > div { min-width: 0; display: grid; gap: 2px; padding: 10px 12px; border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.keepass-history-facts > div:nth-child(odd) { border-right: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.keepass-history-facts dt { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); font-size: .875em; }
.keepass-history-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.keepass-history-fields, .keepass-history-attachments { padding: 12px; border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.keepass-history-fields h3, .keepass-history-attachments h3 { margin: 0 0 8px; font-size: 1rem; }
.keepass-history-fields ul, .keepass-history-attachments ul { list-style: none; margin: 0; padding: 0; }
.keepass-history-fields li + li, .keepass-history-attachments li + li { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.keepass-history-field-head { min-height: 56px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.keepass-history-field-head > span, .keepass-history-attachments li > span { min-width: 0; display: grid; gap: 2px; }
.keepass-history-field-head strong, .keepass-history-attachments strong { overflow-wrap: anywhere; }
.keepass-history-field-value { max-height: 180px; margin: 0 0 10px; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: auto; padding: 10px 12px; color: var(--app-text); background: var(--md-sys-color-surface-container-low, var(--app-surface-high)); font: 400 .875rem/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.keepass-history-attachments p { margin: 0; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.keepass-history-attachments li { min-height: 52px; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 10px; }
.keepass-history-restore-action { display: flex; justify-content: flex-end; padding: 12px; }
.keepass-history-restore-confirmation { margin: 12px; border: 1px solid var(--md-sys-color-error, var(--app-primary)); border-radius: 8px; display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: start; gap: 12px; padding: 12px; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.keepass-history-restore-confirmation > span { min-width: 0; display: grid; gap: 4px; line-height: 1.5; }
.keepass-history-restore-confirmation > div { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
.keepass-history-confirm-restore { color: var(--md-sys-color-error, var(--app-primary)); }
.keepass-history-dialog > footer { min-height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 12px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
@media (max-width: 760px) {
  .keepass-history-backdrop { align-items: center; padding: 8px; }
  .keepass-history-dialog { max-height: calc(100dvh - 16px); padding: 16px; }
  .keepass-history-layout { grid-template-columns: minmax(0, 1fr); }
  .keepass-history-list-shell, .keepass-history-detail-shell { max-height: none; }
}
@media (max-width: 420px) {
  .keepass-history-dialog { padding: 12px; }
  .keepass-history-section-heading, .keepass-history-row { padding-inline: 12px; }
  .keepass-history-facts { grid-template-columns: minmax(0, 1fr); }
  .keepass-history-facts > div:nth-child(odd) { border-right: 0; }
  .keepass-history-field-head { align-items: stretch; flex-direction: column; padding-block: 8px; }
  .keepass-history-field-head > m3e-button { width: 100%; }
  .keepass-history-restore-confirmation > div, .keepass-history-dialog > footer { align-items: stretch; flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  .keepass-history-dialog * { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
</style>
