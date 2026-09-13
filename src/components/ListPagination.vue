<script setup lang="ts">
import { computed, nextTick } from "vue";
import { tr } from "../i18n";

const props = withDefaults(defineProps<{ page: number; total: number; pageSize?: number; target?: string }>(), { pageSize: 50 });
const emit = defineEmits<{ change: [page: number] }>();
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
async function change(page: number) {
  emit("change", page);
  await nextTick();
  if (!props.target) return;
  const target = document.getElementById(props.target);
  target?.scrollIntoView({ block: "start" });
  target?.focus({ preventScroll: true });
}
</script>

<template>
  <nav v-if="pages > 1" class="list-pagination" :aria-label="tr('分页')">
    <span class="pagination-range" role="status">{{ tr('显示 {0}–{1} / {2}', { 0: (page - 1) * pageSize + 1, 1: Math.min(page * pageSize, total), 2: total }) }}</span>
    <div class="pagination-controls">
      <button type="button" :disabled="page <= 1" @click="change(page - 1)">{{ tr('上一页') }}</button>
      <select :value="page" :aria-label="tr('页码')" @change="change(Number(($event.target as HTMLSelectElement).value))">
        <option v-for="number in pages" :key="number" :value="number">{{ number }} / {{ pages }}</option>
      </select>
      <button type="button" :disabled="page >= pages" @click="change(page + 1)">{{ tr('下一页') }}</button>
    </div>
  </nav>
</template>

<style>
.list-pagination { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px 24px; padding: 16px 0; min-width: 0; color: var(--app-muted); font-size: .8125rem; }
.pagination-range { overflow-wrap: anywhere; }
.pagination-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.pagination-controls :is(button, select) { min-width: 44px; min-height: var(--app-control-height, 44px); max-width: 100%; border: 1px solid var(--app-outline); border-radius: 999px; background: var(--app-surface); color: var(--app-text); font: inherit; line-height: 1.4; padding: 8px 14px; }
.pagination-controls button { white-space: normal; overflow-wrap: anywhere; cursor: pointer; }
.pagination-controls button:disabled { opacity: .45; cursor: default; }
.pagination-controls :is(button, select):focus-visible { outline: 2px solid var(--app-text); outline-offset: 3px; }
</style>
