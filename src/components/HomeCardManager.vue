<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { tr, locale } from "../i18n";
import { MAX_HOME_PINS, type HomePreferences } from "../core/home-preferences";
import type { VaultItem } from "../core/model";
import { homeItemSummary, itemIcon, itemKindLabel } from "../manager/item-metadata";
import { useListPagination } from "../lib/list-pagination";
import ListPagination from "./ListPagination.vue";

const props = defineProps<{
  preferences: HomePreferences;
  items: readonly VaultItem[];
  itemsById: ReadonlyMap<string, VaultItem>;
  recommendations: readonly VaultItem[];
  sourceId: string;
  sourceLabel: (item: VaultItem) => string;
  saving: boolean;
}>();
export type HomePinSelection = Pick<HomePreferences, "pinnedItemIds" | "suggestFrequent">;
const emit = defineEmits<{ save: [selection: HomePinSelection]; close: [] }>();
const selected = ref(props.preferences.suggestFrequent ? props.recommendations.map(item => item.id) : [...props.preferences.pinnedItemIds]);
const suggested = ref(props.preferences.suggestFrequent);
const query = ref("");
const dragged = ref<string>();
const unavailable = computed(() => selected.value.filter(id => {
  const item = props.itemsById.get(id);
  return !item || item.archivedAt || item.deletedAt;
}));
// Rebuild on data/language changes, not on every keystroke. Never index secret fields.
const searchIndex = computed(() => {
  void locale.value;
  const kindLabels = new Map<string, string>();
  const sourceLabels = new Map<string, string>();
  return props.items.map(item => {
    if (!kindLabels.has(item.kind)) kindLabels.set(item.kind, itemKindLabel(item.kind));
    const sourceKey = JSON.stringify(item.providerRefs.map(ref => ref.providerId));
    if (!sourceLabels.has(sourceKey)) sourceLabels.set(sourceKey, props.sourceLabel(item));
    return { item, text: `${item.title} ${homeItemSummary(item)} ${kindLabels.get(item.kind)} ${sourceLabels.get(sourceKey)}`.toLocaleLowerCase() };
  });
});
const results = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return needle ? searchIndex.value.filter(entry => entry.text.includes(needle)).map(entry => entry.item) : props.items;
});
const pagination = useListPagination(() => results.value.length, () => [props.sourceId, query.value], 8);
const dirty = computed(() => suggested.value !== props.preferences.suggestFrequent || (!suggested.value && JSON.stringify(selected.value) !== JSON.stringify(props.preferences.pinnedItemIds)));
onMounted(() => document.getElementById("home-pin-query")?.focus());

function title(id: string) { return props.itemsById.get(id)?.title || tr('不可用的卡片'); }
function subtitle(id: string) {
  const item = props.itemsById.get(id);
  if (!item) return tr('条目已移除或来源暂不可用');
  return [props.sourceLabel(item), item.deletedAt ? tr('在回收站') : item.archivedAt ? tr('已归档') : homeItemSummary(item) || itemKindLabel(item.kind)].join(" · ");
}
function toggle(id: string) {
  if (props.saving) return;
  if (selected.value.includes(id)) selected.value = selected.value.filter(value => value !== id);
  else if (selected.value.length < MAX_HOME_PINS) selected.value = [...selected.value, id];
  else return;
  suggested.value = false;
}
function move(id: string, delta: number) {
  const from = selected.value.indexOf(id), to = from + delta;
  if (props.saving || from < 0 || to < 0 || to >= selected.value.length) return;
  const ordered = [...selected.value];
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  selected.value = ordered;
  suggested.value = false;
  void nextTick(() => {
    const row = [...document.querySelectorAll<HTMLElement>("[data-pin-id]")].find(row => row.dataset.pinId === id);
    (row?.querySelector<HTMLButtonElement>(`[data-pin-move="${delta}"]:not(:disabled)`) || row?.querySelector<HTMLButtonElement>("[data-pin-move]:not(:disabled)"))?.focus();
  });
}
function drop(target: string) {
  const from = selected.value.indexOf(dragged.value || ""), to = selected.value.indexOf(target);
  dragged.value = undefined;
  if (props.saving || from < 0 || to < 0 || from === to) return;
  const ordered = [...selected.value];
  ordered.splice(to, 0, ordered.splice(from, 1)[0]);
  selected.value = ordered;
  suggested.value = false;
}
function useSuggestions() { selected.value = props.recommendations.map(item => item.id); suggested.value = true; }
function clearUnavailable() { selected.value = selected.value.filter(id => !unavailable.value.includes(id)); suggested.value = false; }
</script>

<template>
  <section id="home-card-picker" class="home-inline-panel home-card-picker" :aria-label="tr('管理卡片')" @keydown.esc.stop="!saving && emit('close')">
    <header class="home-section-heading"><div><h3 id="home-card-picker-title">{{ tr('选择常用卡片') }}</h3></div><button type="button" class="home-icon-button" :disabled="saving" :aria-label="tr('关闭卡片选择')" @click="emit('close')"><m3e-icon name="close" aria-hidden="true" /></button></header>
    <div class="home-pin-columns">
      <p class="home-panel-description">{{ tr('多选并调整顺序，保存后生效。移除卡片不会删除条目。') }}</p>
      <div class="home-pin-selected">
        <h4>{{ tr('已选择 {0} / {1}', { 0: selected.length, 1: MAX_HOME_PINS }) }}</h4>
        <p class="home-caption">{{ suggested ? tr('自动推荐；调整后改为手动固定。') : tr('按下方顺序显示，可拖动或使用上下按钮。') }}</p>
        <ol class="home-pin-order" :aria-label="tr('卡片顺序')">
          <li v-for="(id, index) in selected" :key="id" :data-pin-id="id" @dragover.prevent @drop.prevent="drop(id)">
            <span class="home-pin-drag" :draggable="!saving" :title="tr('拖动排序')" aria-hidden="true" @dragstart="dragged = id" @dragend="dragged = undefined">⠿</span>
            <span class="home-row-copy"><strong :title="title(id)">{{ title(id) }}</strong><small :title="subtitle(id)">{{ subtitle(id) }}</small></span>
            <div class="home-reorder-actions">
              <button type="button" class="home-icon-button" data-pin-move="-1" :disabled="saving || index === 0" :aria-label="tr('上移{0}', { 0: title(id) })" @click="move(id, -1)"><m3e-icon name="expand_less" aria-hidden="true" /></button>
              <button type="button" class="home-icon-button" data-pin-move="1" :disabled="saving || index === selected.length - 1" :aria-label="tr('下移{0}', { 0: title(id) })" @click="move(id, 1)"><m3e-icon name="expand_more" aria-hidden="true" /></button>
              <button type="button" class="home-icon-button" :disabled="saving" :aria-label="tr('移除卡片{0}', { 0: title(id) })" @click="toggle(id)"><m3e-icon name="close" aria-hidden="true" /></button>
            </div>
          </li>
        </ol>
        <p v-if="!selected.length" class="home-empty">{{ tr('尚未选择卡片') }}</p>
        <button v-if="unavailable.length" type="button" class="home-button" :disabled="saving" @click="clearUnavailable">{{ tr('移除 {0} 张不可用卡片', { 0: unavailable.length }) }}</button>
        <div class="home-panel-tools"><button type="button" class="home-button home-button-quiet" :disabled="saving || suggested" @click="useSuggestions">{{ tr('使用推荐卡片') }}</button><button type="button" class="home-button home-button-quiet" :disabled="saving || (!suggested && !selected.length)" @click="selected = []; suggested = false">{{ tr('清空常用卡片') }}</button></div>
      </div>
      <div>
        <label class="home-search"><m3e-icon name="search" aria-hidden="true" /><input id="home-pin-query" v-model="query" type="search" :aria-label="tr('搜索可添加的卡片')" :placeholder="tr('搜索可添加的卡片')" /></label>
        <p class="home-caption home-picker-scope">{{ tr('按顶部数据库范围浏览。已选卡片包含所有数据库。') }}</p>
        <div id="home-picker-results" class="home-picker-results" tabindex="-1">
          <label v-for="(item, index) in pagination.slice(results)" :key="item.id" class="home-picker-item">
            <input type="checkbox" :checked="selected.includes(item.id)" :disabled="saving || (!selected.includes(item.id) && selected.length >= MAX_HOME_PINS)" :aria-label="tr('固定{0}', { 0: item.title })" :aria-describedby="`home-candidate-${index}`" @change="toggle(item.id)" />
            <m3e-icon :name="itemIcon(item.kind)" aria-hidden="true" /><span class="home-row-copy"><strong :title="item.title">{{ item.title }}</strong><small :id="`home-candidate-${index}`" :title="`${sourceLabel(item)} · ${homeItemSummary(item) || itemKindLabel(item.kind)}`">{{ sourceLabel(item) }} · {{ homeItemSummary(item) || itemKindLabel(item.kind) }}</small></span>
          </label>
          <p v-if="!results.length" class="home-empty">{{ tr('没有匹配项目') }}</p>
        </div>
        <ListPagination :page="pagination.page.value" :total="results.length" :page-size="8" target="home-picker-results" @change="pagination.change" />
      </div>
    </div>
    <footer class="home-panel-actions">
      <div><button type="button" class="home-button" :disabled="saving" @click="emit('close')">{{ tr('取消') }}</button><button type="button" class="home-button home-button-primary" :disabled="saving || !dirty" @click="emit('save', { pinnedItemIds: suggested ? [] : [...selected], suggestFrequent: suggested })">{{ tr('保存卡片') }}</button></div>
    </footer>
  </section>
</template>
