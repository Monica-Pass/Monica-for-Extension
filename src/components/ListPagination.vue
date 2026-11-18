<script setup lang="ts">
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { computed, nextTick } from "vue";
import { tr } from "../i18n";

const props = withDefaults(defineProps<{ page: number; total: number; pageSize?: number; target?: string }>(), { pageSize: 50 });
const emit = defineEmits<{ change: [page: number] }>();
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
async function change(page: number) {
  emit("change", page);
  await nextTick();
  if (!props.target) return;
  const target = document.getElementById(props.target);
  target?.scrollIntoView({ block: "start" });
  target?.focus({ preventScroll: true });
}
function jump(event: Event) {
  const input = event.target as HTMLInputElement;
  const requested = Number(input.value);
  if (!input.value.trim() || !Number.isInteger(requested)) { input.value = String(props.page); return; }
  const page = Math.max(1, Math.min(pageCount.value, requested));
  input.value = String(page);
  if (page !== props.page) void change(page);
}
</script>

<template>
  <nav v-if="pageCount > 1" class="list-pagination" :aria-label="tr('分页')">
    <span class="pagination-range" role="status">{{ tr('显示 {0}–{1} / {2}', { 0: (page - 1) * pageSize + 1, 1: Math.min(page * pageSize, total), 2: total }) }}</span>
    <div class="pagination-controls">
      <m3e-button variant="text" type="button" :disabled="page <= 1" @click="change(page - 1)">{{ tr('上一页') }}</m3e-button>
      <m3e-form-field v-if="pageCount <= 20" v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('页码') }}</label><component :is="materialSelectTag"  :aria-label="tr('页码')" @change="change(Number(($event.target as HTMLSelectElement).value))">
        <component :is="materialOptionTag" :selected.prop="String(page ?? '') === String(number)" v-for="number in pageCount" :key="number" :value="String(number)">{{ number }} / {{ pageCount }}</component>
      </component></m3e-form-field>
      <m3e-form-field v-else v-field-label class="page-jump" variant="filled" hide-required-marker>
        <label slot="label">{{ tr('页码') }}</label>
        <input type="number" inputmode="numeric" min="1" :max="pageCount" step="1" :value="page" :aria-label="tr('页码')" @change="jump" @keydown.enter.prevent="jump" />
        <span slot="trailing" aria-hidden="true">/ {{ pageCount }}</span>
      </m3e-form-field>
      <m3e-button variant="text" type="button" :disabled="page >= pageCount" @click="change(page + 1)">{{ tr('下一页') }}</m3e-button>
    </div>
  </nav>
</template>

<style>
.list-pagination { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px 24px; padding: 16px 0; min-width: 0; color: var(--app-muted); font-size: .8125rem; }
.pagination-range { overflow-wrap: anywhere; }
.pagination-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.pagination-controls .page-jump { width: 10rem; min-width: 0; max-width: 100%; }
.page-jump input { width: 100%; min-width: 44px; min-height: 44px; }
.pagination-controls :is(button, select) { min-width: 44px; min-height: var(--app-control-height, 44px); max-width: 100%; border: 1px solid var(--app-outline); border-radius: 999px; background: var(--app-surface); color: var(--app-text); font: inherit; line-height: 1.4; padding: 8px 14px; }
.pagination-controls button { white-space: normal; overflow-wrap: anywhere; cursor: pointer; }
.pagination-controls button:disabled { opacity: .45; cursor: default; }
.pagination-controls :is(button, select):focus-visible { outline: 2px solid var(--app-text); outline-offset: 3px; }
</style>
