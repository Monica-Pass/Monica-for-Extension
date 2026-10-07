<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { LoginItem } from '../core/model';
import { tr, locale } from '../i18n';
const props = defineProps<{ item: LoginItem; localOnly: boolean; remove?: (item: LoginItem, index: number) => Promise<void> }>();
const open = ref(false), revealed = ref<number[]>([]), pending = ref(false), confirmIndex = ref<number>(), status = ref('');
const rows = computed(() => (props.item.passwordHistory || []).map((entry, index) => ({ ...entry, index }))
  .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt) || a.index - b.index));
watch(() => [props.item.id, props.item.updatedAt, JSON.stringify(props.item.passwordHistory)], (current, previous) => {
  revealed.value = []; status.value = '';
  // Sync can acknowledge a new revision without changing any historical row.
  // Keep the selected row in that case; a changed list requires a new choice.
  if (current[0] !== previous[0] || current[2] !== previous[2]) confirmIndex.value = undefined;
});
function toggleOpen() { open.value = !open.value; revealed.value = []; confirmIndex.value = undefined; }
function date(value: string) { return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale.value) : value; }
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); status.value = tr('已复制历史密码。'); }
  catch { status.value = tr('复制失败，请手动选择内容。'); }
}
async function deleteEntry(index: number) {
  if (!props.remove || pending.value) return;
  pending.value = true;
  try { await props.remove(props.item, index); confirmIndex.value = undefined; status.value = tr('已删除此条密码历史。'); }
  catch (error) { status.value = error instanceof Error ? error.message : tr('删除历史失败，请重试。'); }
  finally { pending.value = false; }
}
</script>

<template>
  <section class="detail-section password-history">
    <m3e-button variant="text" class="history-heading" :aria-expanded="open" @click="toggleOpen"><m3e-icon slot="icon" name="history" />{{ tr('密码历史') }} · {{ rows.length }}</m3e-button>
    <div v-if="open" class="history-content">
      <p v-if="item.passwordHistoryIncomplete" class="supporting">{{ tr('部分历史无法显示，已保留在原密码源。') }}</p>
      <p v-if="localOnly" class="supporting">{{ tr('此密码源的历史仅保存在当前浏览器。') }}</p>
      <p v-if="!rows.length" class="supporting">{{ tr('暂无密码历史') }}</p>
      <ol v-else class="history-list">
        <li v-for="(entry, position) in rows" :key="entry.index" class="history-row">
          <time :datetime="entry.lastUsedAt">{{ date(entry.lastUsedAt) }}</time>
          <code>{{ revealed.includes(entry.index) ? entry.password : '••••••••' }}</code>
          <div class="history-actions">
            <m3e-icon-button :aria-label="tr(revealed.includes(entry.index) ? '隐藏历史密码 {0}' : '显示历史密码 {0}', { 0: position + 1 })" @click="revealed = revealed.includes(entry.index) ? revealed.filter(i => i !== entry.index) : [...revealed, entry.index]"><m3e-icon :name="revealed.includes(entry.index) ? 'visibility_off' : 'visibility'" /></m3e-icon-button>
            <m3e-icon-button :aria-label="tr('复制历史密码 {0}', { 0: position + 1 })" @click="copy(entry.password)"><m3e-icon name="content_copy" /></m3e-icon-button>
            <m3e-icon-button v-if="remove && !item.deletedAt" :disabled="pending" :aria-label="tr('删除历史密码 {0}', { 0: position + 1 })" @click="confirmIndex = entry.index"><m3e-icon name="delete" /></m3e-icon-button>
          </div>
          <div v-if="confirmIndex === entry.index" class="history-confirm">
            <p>{{ tr('删除这条历史？当前密码保持不变。') }}</p>
            <m3e-button variant="text" :disabled="pending" @click="confirmIndex = undefined">{{ tr('取消') }}</m3e-button>
            <m3e-button variant="tonal" :disabled="pending" @click="deleteEntry(entry.index)">{{ tr('删除这条历史') }}</m3e-button>
          </div>
        </li>
      </ol>
    </div>
    <p v-if="status" role="status">{{ status }}</p>
  </section>
</template>

<style scoped>
.history-heading { max-width: 100%; }
.history-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.history-row { padding: 12px; border-radius: 4px; background: var(--md-sys-color-surface-container-low); min-width: 0; }
.history-row:first-child { border-start-start-radius: 24px; border-start-end-radius: 24px; }
.history-row:last-child { border-end-start-radius: 24px; border-end-end-radius: 24px; }
.history-row time { display: block; color: var(--md-sys-color-on-surface-variant); font-size: 12px; }
.history-row code { display: block; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; padding: 8px 0; }
.history-actions, .history-confirm { display: flex; gap: 4px; flex-wrap: wrap; }
.history-actions m3e-icon-button { min-width: 48px; min-height: 48px; }
.history-confirm p { flex-basis: 100%; }
</style>
