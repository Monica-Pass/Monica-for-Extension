<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchPostEffect } from "vue";
import { tr, locale } from "../i18n";
import { HOME_MODULES, homeStartupSource, normalizeHomePreferences, type HomeModuleId, type HomePreferences } from "../core/home-preferences";
import type { LoginItem, TotpItem, ProviderAccount, ProviderConflictSummary, VaultItem, VaultItemKind } from "../core/model";
import { buildHomeCatalog, homeSourceIds, matchesHomeSource, suggestedHomeItems, type HomeDestination, type HomeFolderRef } from "../manager/home-catalog";
import { homeItemSummary, itemIcon, itemKindLabel, itemKindSection } from "../manager/item-metadata";
import { useListPagination } from "../lib/list-pagination";
import { vaultClient } from "../runtime/client";
import ListPagination from "./ListPagination.vue";
import HomeCardManager, { type HomePinSelection } from "./HomeCardManager.vue";
import HomeQuickActions from "./HomeQuickActions.vue";
import { homeProviderStatus, type HomeProviderQueue, type HomeProviderStatus } from "../manager/home-provider-status";

const editorDialog = ref<HTMLDialogElement>();

const props = defineProps<{
  items: readonly VaultItem[];
  archived: readonly VaultItem[];
  deleted: readonly VaultItem[];
  providers: readonly ProviderAccount[];
  sourceId: string;
  sourceInitialized: boolean;
  queues: readonly HomeProviderQueue[];
  conflicts: readonly ProviderConflictSummary[];
  syncingProviderId: string;
  consumeOtp: (item: LoginItem | TotpItem) => Promise<void>;
}>();
const emit = defineEmits<{
  open: [destination: HomeDestination];
  detail: [item: VaultItem];
  "update:sourceId": [id: string];
  "source-initialized": [];
}>();

const alive = ref(true);
const preferences = shallowRef<HomePreferences>(normalizeHomePreferences());
const loaded = ref(false);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const saved = ref(false);
const draft = ref<Pick<HomePreferences, "order" | "hidden" | "density" | "startupSource" | "preferredSourceId"> | null>(null);
const customizeButton = ref<HTMLButtonElement>();
const pickerOpen = ref(false);
const sourceRetry = ref<string | null>(null);
const sourceNotice = ref("");
const folderQuery = ref("");
const cardIndex = ref(0);
const busy = computed(() => loading.value || saving.value || !loaded.value);
const kinds: VaultItemKind[] = ["login", "card", "identity", "billing-address", "payment-account", "secure-note", "totp", "passkey"];
const catalog = computed(() => buildHomeCatalog(alive.value ? props.items : [], props.providers, props.sourceId));
const allItemsById = computed(() => new Map((alive.value ? [...props.items, ...props.archived, ...props.deleted] : []).map(item => [item.id, item])));
const recommendations = computed(() => suggestedHomeItems(catalog.value.items));
const density = computed(() => draft.value?.density || preferences.value.density);
const providerById = computed(() => new Map(props.providers.map(provider => [provider.kind === "local" ? "local" : provider.id, provider])));
const sourceStatuses = computed(() => {
  const queues = new Map(props.queues.map(queue => [queue.providerId, queue]));
  const conflicts = new Map<string, number>();
  for (const conflict of props.conflicts) conflicts.set(conflict.providerId, (conflicts.get(conflict.providerId) || 0) + 1);
  return new Map(sources.value.map(source => [source.id, homeProviderStatus(providerById.value.get(source.id), queues.get(source.id), conflicts.get(source.id), props.syncingProviderId === source.id)]));
});
const sourceNames = computed(() => new Map([
  ["local", tr('Monica 本地库')],
  ...props.providers.filter(provider => provider.kind !== "local").map(provider => {
    const email = provider.kind === "bitwarden" && typeof provider.config.email === "string" ? provider.config.email.trim() : "";
    return [provider.id, email ? `${provider.name} · ${email}` : provider.name];
  })
] as [string, string][]));
const sources = computed(() => {
  const result = [{ id: "local", name: sourceName("local"), kind: "local" }];
  for (const provider of props.providers) {
    if (provider.kind !== "local") result.push({ id: provider.id, name: sourceName(provider.id), kind: provider.kind });
  }
  const known = new Set(result.map(source => source.id));
  for (const id of catalog.value.sourceCounts.keys()) {
    if (!known.has(id)) result.push({ id, name: sourceName(id), kind: "external" });
  }
  return result;
});
const visibleModules = computed(() => {
  const layout = draft.value || preferences.value;
  return layout.order.filter(id => !layout.hidden.includes(id));
});
const attentionCount = computed(() => [...sourceStatuses.value.values()].filter(status => status.needsAttention).length);
const editing = computed(() => Boolean(draft.value) || pickerOpen.value);
watchPostEffect(() => {
  if (!editing.value) { editorDialog.value?.close(); return; }
  if (!editorDialog.value?.open) editorDialog.value?.showModal();
  void nextTick(() => document.getElementById(pickerOpen.value ? "home-pin-query" : "home-customize-title")?.focus());
});
const cards = computed(() => preferences.value.suggestFrequent
  ? recommendations.value
  : preferences.value.pinnedItemIds.flatMap(id => {
    const item = allItemsById.value.get(id);
    return item && !item.archivedAt && !item.deletedAt && matchesHomeSource(item, props.sourceId, props.providers) ? [item] : [];
  }));
const currentCard = computed(() => cards.value[cardIndex.value]);
const filteredFolders = computed(() => {
  const needle = folderQuery.value.trim().toLocaleLowerCase();
  return needle ? catalog.value.folders.filter(folder => `${folderLabel(folder)} ${sourceName(folder.sourceId)}`.toLocaleLowerCase().includes(needle)) : catalog.value.folders;
});
const archivedCount = computed(() => props.archived.filter(item => matchesHomeSource(item, props.sourceId, props.providers)).length);
const deletedCount = computed(() => props.deleted.filter(item => matchesHomeSource(item, props.sourceId, props.providers)).length);
const folderPagination = useListPagination(() => filteredFolders.value.length, () => [props.sourceId, folderQuery.value], 6);
const sourcePagination = useListPagination(() => sources.value.length, () => props.providers, 6);

watch(() => props.sourceId, () => { cardIndex.value = 0; folderQuery.value = ""; });
watch(cards, value => { cardIndex.value = Math.min(cardIndex.value, Math.max(0, value.length - 1)); });
watch(sources, value => {
  if (loaded.value && props.sourceId !== "all" && !value.some(source => source.id === props.sourceId)) {
    emit("update:sourceId", "all");
    sourceNotice.value = tr('原数据库已不可用，已显示全部数据库。');
  }
});
onMounted(loadPreferences);
onBeforeUnmount(() => {
  editorDialog.value?.close();
  alive.value = false;
  pickerOpen.value = false;
  folderQuery.value = "";
  sourceRetry.value = null;
  preferences.value = normalizeHomePreferences();
  draft.value = null;
  // Release previously evaluated arrays even if a settings request is still completing.
  void catalog.value; void allItemsById.value; void cards.value; void recommendations.value; void filteredFolders.value;
});

async function loadPreferences() {
  loading.value = true;
  error.value = "";
  try {
    const value = await vaultClient.getHomePreferences();
    if (!alive.value) return;
    preferences.value = normalizeHomePreferences(value);
    if (!props.sourceInitialized) {
      const source = homeStartupSource(preferences.value, sources.value.map(source => source.id));
      emit("update:sourceId", source.id);
      emit("source-initialized");
      if (source.missing) sourceNotice.value = tr('原数据库已不可用，已显示全部数据库。');
    }
    loaded.value = true;
  } catch (cause) {
    if (alive.value) error.value = cause instanceof Error ? cause.message : tr('无法读取首页设置。');
  } finally {
    if (alive.value) loading.value = false;
  }
}

async function persist(value: Partial<HomePreferences>): Promise<boolean> {
  if (busy.value) return false;
  saving.value = true;
  saved.value = false;
  error.value = "";
  try {
    const result = await vaultClient.setHomePreferences(sourceRetry.value === null ? value : { ...value, lastSourceId: sourceRetry.value });
    if (!alive.value) return false;
    preferences.value = normalizeHomePreferences(result);
    if (sourceRetry.value === preferences.value.lastSourceId) sourceRetry.value = null;
    saved.value = true;
    return true;
  } catch (cause) {
    if (alive.value) error.value = cause instanceof Error ? cause.message : tr('首页设置未保存，请重试。');
    return false;
  } finally {
    if (alive.value) saving.value = false;
  }
}

function moduleLabel(id: HomeModuleId): string {
  return ({ frequent: tr('常用卡片'), favorites: tr('收藏夹'), types: tr('按类型浏览'), folders: tr('分类与文件夹'), databases: tr('数据库'), lifecycle: tr('归档与回收站') })[id];
}

function expanded(id: HomeModuleId): boolean {
  return id === "favorites" ? preferences.value.favoritesExpanded : !preferences.value.collapsedModules.includes(id);
}
function toggleExpanded(id: HomeModuleId) {
  if (id === "favorites") return persist({ favoritesExpanded: !preferences.value.favoritesExpanded });
  return persist({ collapsedModules: expanded(id) ? [...preferences.value.collapsedModules, id] : preferences.value.collapsedModules.filter(value => value !== id) });
}
function moduleCount(id: HomeModuleId): number {
  return ({ frequent: cards.value.length, favorites: catalog.value.favorites.length, types: catalog.value.items.length, folders: catalog.value.folders.length, databases: sources.value.length, lifecycle: archivedCount.value + deletedCount.value })[id];
}
function closeEditor() {
  if (saving.value) return;
  if (draft.value) closeCustomization();
  else if (pickerOpen.value) togglePicker();
}

function sourceName(id: string): string { return sourceNames.value.get(id) || tr('外部密码源'); }
function sourceKind(kind: string): string {
  return ({ local: tr('浏览器本地'), "monica-webdav": "Monica Android · WebDAV", bitwarden: "Bitwarden", keepass: "KeePass", mdbx2: "MDBX2" } as Record<string, string>)[kind] || tr('外部密码源');
}
function itemSources(item: VaultItem): string { return homeSourceIds(item, props.providers).map(sourceName).join(" · "); }
function folderLabel(folder: HomeFolderRef): string { return folder.label || (folder.type === "uncategorized" ? tr('未分类') : tr('未命名文件夹')); }
function open(destination: HomeDestination) { emit("open", { sourceId: props.sourceId, ...destination }); }
function changeCard(delta: number) { if (cards.value.length) cardIndex.value = (cardIndex.value + delta + cards.value.length) % cards.value.length; }

async function changeSource(id: string) {
  if (busy.value) return;
  sourceNotice.value = "";
  sourceRetry.value = id;
  emit("update:sourceId", id);
  if (await persist({ lastSourceId: id })) sourceRetry.value = null;
}
function syncLabel(status?: HomeProviderStatus): string {
  switch (status?.state) {
    case "local": return tr('保存在此浏览器');
    case "syncing": return tr('正在同步…');
    case "conflict": return tr('{0} 个冲突待处理', { 0: status.count || 0 });
    case "confirmation": return tr('远端变化需要确认');
    case "error": return tr('同步需要处理');
    case "paused": return tr('已停用');
    case "pending": return tr('{0} 项等待同步', { 0: status.count || 0 });
    case "file": return tr('本地文件');
    case "synced": return tr('已同步');
    case "never": return tr('尚未同步');
    default: return tr('来源暂不可用');
  }
}
function syncTime(id: string): string {
  const timestamp = providerById.value.get(id)?.lastSyncAt;
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "";
  return tr('上次同步：{0}', { 0: new Date(timestamp).toLocaleString(locale.value, { dateStyle: "short", timeStyle: "short" }) });
}

function customize() {
  if (busy.value) return;
  saved.value = false;
  draft.value = { order: [...preferences.value.order], hidden: [...preferences.value.hidden], density: preferences.value.density, startupSource: preferences.value.startupSource, preferredSourceId: preferences.value.preferredSourceId };
  void nextTick(() => document.getElementById("home-customize-title")?.focus());
}
function toggleModule(id: HomeModuleId) {
  if (!draft.value || busy.value) return;
  draft.value.hidden = draft.value.hidden.includes(id) ? draft.value.hidden.filter(module => module !== id) : [...draft.value.hidden, id];
}
function moveModule(id: HomeModuleId, delta: number) {
  if (!draft.value || busy.value) return;
  const order = [...draft.value.order];
  const index = order.indexOf(id), target = index + delta;
  if (target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  draft.value.order = order;
  void nextTick(() => (document.querySelector<HTMLButtonElement>(`[data-move-module="${id}"][data-direction="${delta}"]:not(:disabled)`) || document.querySelector<HTMLButtonElement>(`[data-move-module="${id}"]:not(:disabled)`))?.focus());
}
function closeCustomization() {
  draft.value = null;
  void nextTick(() => customizeButton.value?.focus());
}
async function saveLayout() {
  if (draft.value && await persist({ ...draft.value, order: [...draft.value.order], hidden: [...draft.value.hidden] })) closeCustomization();
}
function resetLayout() { if (draft.value) draft.value = { ...draft.value, order: [...HOME_MODULES], hidden: [], density: "compact" }; }
function togglePicker() {
  if (saving.value) return;
  pickerOpen.value = !pickerOpen.value;
  void nextTick(() => document.getElementById(pickerOpen.value ? "home-pin-query" : "home-manage-cards")?.focus());
}
async function savePins(selection: HomePinSelection) {
  if (await persist(selection)) togglePicker();
}
</script>

<template>
  <div class="vault-home" :data-density="density" :aria-busy="loading || saving">
    <div class="home-toolbar">
      <label class="home-source-select"><span>{{ tr('当前数据库') }}</span><select :aria-label="tr('当前数据库')" :value="sourceId" :disabled="busy" @change="changeSource(($event.target as HTMLSelectElement).value)">
        <option value="all">{{ tr('全部数据库') }}</option>
        <option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option>
      </select></label>
      <div class="home-toolbar-actions">
        <button ref="customizeButton" type="button" class="home-button" :disabled="busy || pickerOpen" :aria-expanded="Boolean(draft)" aria-controls="home-customization" @click="draft ? closeCustomization() : customize()"><m3e-icon name="tune" aria-hidden="true" />{{ tr('自定义首页') }}</button>
      </div>
    </div>
    <p v-if="!editing && (loading || saving || saved)" class="home-status" role="status">{{ loading ? tr('正在读取首页…') : saving ? tr('正在保存…') : tr('首页设置已保存') }}</p>
    <div v-if="error && !editing" class="home-error" role="alert"><p>{{ error }}</p><button v-if="!loaded" type="button" class="home-button" :disabled="loading" @click="loadPreferences">{{ tr('重试') }}</button><button v-else-if="sourceRetry !== null" type="button" class="home-button" :disabled="busy" @click="changeSource(sourceRetry)">{{ tr('重试') }}</button></div>
    <p v-if="sourceNotice" class="home-status" role="status">{{ sourceNotice }}</p>

    <div v-if="!loading" class="home-modules">
      <section v-for="id in visibleModules" :key="id" :data-home-module="id" :data-expanded="expanded(id)" class="home-module" :aria-labelledby="`home-module-${id}`">
        <header v-if="id !== 'lifecycle'" class="home-section-heading">
          <h2 :id="`home-module-${id}`"><button type="button" class="home-disclosure" :data-home-toggle="id" :disabled="busy" :aria-expanded="expanded(id)" :aria-controls="id === 'favorites' ? 'home-favorites' : `home-content-${id}`" @click="toggleExpanded(id)"><m3e-icon :name="expanded(id) ? 'expand_more' : 'chevron_right'" aria-hidden="true" />{{ moduleLabel(id) }}<span class="home-count">{{ moduleCount(id) }}</span></button></h2>
          <button v-if="id === 'frequent'" id="home-manage-cards" type="button" class="home-button home-button-quiet" :disabled="busy || Boolean(draft)" :aria-expanded="pickerOpen" aria-controls="home-card-picker" @click="togglePicker"><m3e-icon name="add" aria-hidden="true" />{{ tr('管理卡片') }}</button>
          <button v-else-if="id === 'favorites' && catalog.favorites.length" type="button" class="home-button home-button-quiet" @click="open({ section: 'vault', favorite: true })">{{ tr('全部收藏') }}<m3e-icon name="chevron_right" aria-hidden="true" /></button>
          <label v-else-if="id === 'folders' && catalog.folders.length > 6 && expanded(id)" class="home-search home-folder-search"><m3e-icon name="search" aria-hidden="true" /><input v-model="folderQuery" type="search" :aria-label="tr('搜索文件夹')" :placeholder="tr('搜索文件夹')" /></label>
          <div v-else-if="id === 'databases'" class="home-database-tools"><span v-if="attentionCount" class="home-attention-summary" role="status">{{ tr('同步需要处理') }} <span class="home-count">{{ attentionCount }}</span></span><button type="button" class="home-button home-button-quiet" @click="open({ section: 'providers' })">{{ tr('管理数据库') }}<m3e-icon name="chevron_right" aria-hidden="true" /></button></div>
        </header>
        <h2 v-else :id="`home-module-${id}`" class="home-visually-hidden">{{ moduleLabel(id) }}</h2>

        <div v-if="expanded(id) || id === 'lifecycle'" :id="id === 'favorites' ? 'home-favorites' : `home-content-${id}`" class="home-module-content">
          <template v-if="id === 'frequent'">
            <div v-if="currentCard" class="home-deck">
              <div class="home-card-surface">
                <button type="button" class="home-featured-card" :aria-label="tr('查看{0}详情', { 0: currentCard.title })" @click="emit('detail', currentCard)">
                  <span class="home-featured-meta"><span class="home-featured-kind"><m3e-icon :name="itemIcon(currentCard.kind)" aria-hidden="true" />{{ itemKindLabel(currentCard.kind) }}</span><m3e-icon v-if="currentCard.favorite" name="star" :aria-label="tr('已收藏')" /></span>
                  <span class="home-featured-copy"><strong class="home-featured-title" :title="currentCard.title">{{ currentCard.title }}</strong><span class="home-featured-summary" :title="homeItemSummary(currentCard)">{{ homeItemSummary(currentCard) }}</span></span>
                  <span class="home-featured-footer"><span :title="itemSources(currentCard)">{{ itemSources(currentCard) }}</span><m3e-icon name="arrow_forward" aria-hidden="true" /></span>
                </button>
                <HomeQuickActions :item="currentCard" :items="items" :consume-otp="consumeOtp" />
              </div>
            </div>
            <div v-else class="home-card-empty"><m3e-icon name="cards" aria-hidden="true" /><p>{{ tr('当前范围还没有常用卡片。') }}</p><span>{{ tr('从密码库中选择想要快速访问的项目。') }}</span></div>
            <div v-if="cards.length" class="home-card-controls">
              <button type="button" class="home-icon-button" :disabled="cards.length < 2" :aria-label="tr('上一张卡片')" @click="changeCard(-1)"><m3e-icon class="home-chevron-back" name="chevron_right" aria-hidden="true" /></button>
              <span class="home-card-position" role="status">{{ tr('第 {0} 张，共 {1} 张', { 0: cardIndex + 1, 1: cards.length }) }}</span>
              <button type="button" class="home-icon-button" :disabled="cards.length < 2" :aria-label="tr('下一张卡片')" @click="changeCard(1)"><m3e-icon name="chevron_right" aria-hidden="true" /></button>
            </div>
          </template>

          <div v-else-if="id === 'favorites'" class="home-row-grid home-group">
            <button v-for="item in catalog.favorites.slice(0, 6)" :key="item.id" type="button" class="home-item-row" :aria-label="tr('查看{0}详情', { 0: item.title })" @click="emit('detail', item)"><span class="home-item-icon"><m3e-icon :name="itemIcon(item.kind)" aria-hidden="true" /></span><span class="home-row-copy"><strong :title="item.title">{{ item.title }}</strong><small :title="[homeItemSummary(item), sourceId === 'all' ? itemSources(item) : ''].filter(Boolean).join(' · ')">{{ [homeItemSummary(item), sourceId === 'all' ? itemSources(item) : ''].filter(Boolean).join(' · ') }}</small></span><m3e-icon name="chevron_right" aria-hidden="true" /></button>
            <p v-if="!catalog.favorites.length" class="home-empty">{{ tr('收藏的项目会显示在这里。') }}</p>
          </div>

          <div v-else-if="id === 'types'" class="home-type-grid home-group"><button v-for="kind in kinds" :key="kind" type="button" class="home-type-button" :data-home-kind="kind" :aria-label="tr('{0}，{1} 项', { 0: itemKindLabel(kind), 1: catalog.kinds.get(kind) || 0 })" @click="open({ section: itemKindSection(kind), kind })"><m3e-icon :name="itemIcon(kind)" aria-hidden="true" /><span>{{ itemKindLabel(kind) }}</span><span class="home-count">{{ catalog.kinds.get(kind) || 0 }}</span></button></div>

          <template v-else-if="id === 'folders'">
            <div id="home-folder-results" class="home-row-grid home-group" tabindex="-1"><button v-for="folder in folderPagination.slice(filteredFolders)" :key="folder.key" type="button" class="home-item-row" :data-folder-source="folder.sourceId" @click="open({ section: 'vault', sourceId: folder.sourceId, folder })"><m3e-icon name="folder" aria-hidden="true" /><span class="home-row-copy"><strong :title="folderLabel(folder)">{{ folderLabel(folder) }}</strong><small v-if="sourceId === 'all'" :title="sourceName(folder.sourceId)">{{ sourceName(folder.sourceId) }}</small></span><span class="home-count">{{ folder.count }}</span><m3e-icon name="chevron_right" aria-hidden="true" /></button><p v-if="!filteredFolders.length" class="home-empty">{{ tr('当前范围没有分类或文件夹。') }}</p></div>
            <ListPagination :page="folderPagination.page.value" :total="filteredFolders.length" :page-size="6" target="home-folder-results" @change="folderPagination.change" />
          </template>

          <template v-else-if="id === 'databases'">
            <div id="home-source-results" class="home-row-grid home-source-grid" tabindex="-1">
              <div v-for="source in sourcePagination.slice(sources)" :key="source.id" class="home-source-entry home-group">
                <button type="button" class="home-item-row home-source-row" :data-home-source="source.id" @click="open({ section: 'vault', sourceId: source.id })">
                  <m3e-icon :name="source.kind === 'local' ? 'storage' : 'database'" aria-hidden="true" />
                  <span class="home-row-copy"><strong :title="source.name">{{ source.name }}</strong><small>{{ sourceKind(source.kind) }}</small><small class="home-sync-state" :data-state="sourceStatuses.get(source.id)?.state" :class="{ 'home-needs-attention': sourceStatuses.get(source.id)?.needsAttention }">{{ syncLabel(sourceStatuses.get(source.id)) }}</small><small v-if="syncTime(source.id)" class="home-sync-time">{{ syncTime(source.id) }}</small></span>
                  <span class="home-count">{{ catalog.sourceCounts.get(source.id) || 0 }}</span><m3e-icon name="chevron_right" aria-hidden="true" />
                </button>
                <button v-if="sourceStatuses.get(source.id)?.needsAttention" type="button" class="home-button home-source-action" :aria-label="tr('处理{0}的同步状态', { 0: source.name })" @click="open({ section: 'providers', providerId: source.id })">{{ tr('查看并处理') }}<m3e-icon name="arrow_forward" aria-hidden="true" /></button>
              </div>
            </div>
            <ListPagination :page="sourcePagination.page.value" :total="sources.length" :page-size="6" target="home-source-results" @change="sourcePagination.change" />
          </template>

          <div v-else-if="id === 'lifecycle'" class="home-row-grid home-lifecycle-grid home-group"><button type="button" class="home-item-row" data-home-lifecycle="archive" @click="open({ section: 'archive' })"><m3e-icon name="archive" aria-hidden="true" /><span class="home-row-copy"><strong>{{ tr('归档') }}</strong></span><span class="home-count">{{ archivedCount }}</span><m3e-icon name="chevron_right" aria-hidden="true" /></button><button type="button" class="home-item-row" data-home-lifecycle="trash" @click="open({ section: 'trash' })"><m3e-icon name="delete" aria-hidden="true" /><span class="home-row-copy"><strong>{{ tr('回收站') }}</strong></span><span class="home-count">{{ deletedCount }}</span><m3e-icon name="chevron_right" aria-hidden="true" /></button></div>
        </div>
      </section>
    </div>
    <div v-if="!visibleModules.length" class="home-empty-layout"><m3e-icon name="tune" aria-hidden="true" /><h2>{{ tr('首页由你安排') }}</h2><p>{{ tr('打开自定义首页，选择想显示的模块。') }}</p><button v-if="!draft" type="button" class="home-button" :disabled="busy" @click="customize">{{ tr('选择模块') }}</button></div>
    <button type="button" class="home-button home-browse-all" :disabled="loading" @click="open({ section: 'vault' })"><m3e-icon name="list" aria-hidden="true" />{{ tr('浏览全部') }}<span class="home-count">{{ catalog.items.length }}</span><m3e-icon name="chevron_right" aria-hidden="true" /></button>

    <dialog ref="editorDialog" class="home-editor-dialog" aria-modal="true" :aria-labelledby="draft ? 'home-customize-title' : 'home-card-picker-title'" @cancel.prevent="closeEditor">
      <p v-if="error" class="home-editor-error" role="alert">{{ error }}</p>
      <p v-if="saving" class="home-editor-status" role="status">{{ tr('正在保存…') }}</p>
      <section v-if="draft" id="home-customization" class="home-inline-panel" aria-labelledby="home-customize-title" @keydown.esc.stop.prevent="!saving && closeCustomization()">
        <header class="home-section-heading"><div><h2 id="home-customize-title" tabindex="-1">{{ tr('自定义首页') }}</h2></div><button type="button" class="home-icon-button" :disabled="saving" :aria-label="tr('关闭')" @click="closeCustomization"><m3e-icon name="close" aria-hidden="true" /></button></header>
        <div class="home-panel-body">
          <p class="home-panel-description">{{ tr('选择显示的模块，调整首页布局。') }}</p>
          <div class="home-preference-fields">
            <label class="home-source-select"><span>{{ tr('首页密度') }}</span><select :aria-label="tr('首页密度')" v-model="draft.density" :disabled="busy"><option value="compact">{{ tr('紧凑') }}</option><option value="comfortable">{{ tr('舒适') }}</option></select></label>
            <label class="home-source-select"><span>{{ tr('打开首页时') }}</span><select :aria-label="tr('打开首页时')" v-model="draft.startupSource" :disabled="busy"><option value="last">{{ tr('记住上次使用的数据库') }}</option><option value="all">{{ tr('全部数据库') }}</option><option value="fixed">{{ tr('指定数据库') }}</option></select></label>
            <label v-if="draft.startupSource === 'fixed'" class="home-source-select"><span>{{ tr('默认数据库') }}</span><select :aria-label="tr('默认数据库')" v-model="draft.preferredSourceId" :disabled="busy"><option v-if="!sources.some(source => source.id === draft?.preferredSourceId)" :value="draft.preferredSourceId">{{ tr('来源暂不可用') }}</option><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option></select></label>
          </div>
          <p class="home-caption">{{ tr('默认数据库在下次解锁或重新打开管理页时生效。') }}</p>
          <ol class="home-module-settings">
            <li v-for="(id, index) in draft.order" :key="id" :data-layout-module="id">
              <label><input type="checkbox" :checked="!draft.hidden.includes(id)" :disabled="busy" @change="toggleModule(id)" /><span>{{ moduleLabel(id) }}</span></label>
              <div class="home-reorder-actions">
                <button type="button" class="home-icon-button" :data-move-module="id" data-direction="-1" :disabled="busy || index === 0" :aria-label="tr('上移{0}', { 0: moduleLabel(id) })" @click="moveModule(id, -1)"><m3e-icon name="expand_less" aria-hidden="true" /></button>
                <button type="button" class="home-icon-button" :data-move-module="id" data-direction="1" :disabled="busy || index === draft.order.length - 1" :aria-label="tr('下移{0}', { 0: moduleLabel(id) })" @click="moveModule(id, 1)"><m3e-icon name="expand_more" aria-hidden="true" /></button>
              </div>
            </li>
          </ol>
          <div class="home-panel-tools"><button type="button" class="home-button home-button-quiet" :disabled="busy" @click="resetLayout">{{ tr('恢复默认布局') }}</button></div>
        </div>
        <footer class="home-panel-actions"><div><button type="button" class="home-button" :disabled="saving" @click="closeCustomization">{{ tr('取消') }}</button><button type="button" class="home-button home-button-primary" :disabled="busy" @click="saveLayout">{{ tr('保存布局') }}</button></div></footer>
      </section>
      <HomeCardManager v-if="pickerOpen" :preferences="preferences" :items="catalog.items" :items-by-id="allItemsById" :recommendations="recommendations" :source-id="sourceId" :source-label="itemSources" :saving="saving" @save="savePins" @close="togglePicker" />
    </dialog>
  </div>
</template>
