<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import type { ProviderAccount, VaultItem } from "../core/model";
import type { BitwardenCollectionPage, BitwardenCollectionSummary } from "../providers/bitwarden/bitwarden-collections";
import { vaultClient } from "../runtime/client";

const props = defineProps<{ provider: ProviderAccount; items: VaultItem[] }>();
const emit = defineEmits<{
  close: [];
  changed: [];
  notice: [message: string];
}>();

const collections = ref<BitwardenCollectionSummary[]>([]);
const organizations = ref<BitwardenCollectionPage["organizations"]>([]);
const warnings = ref<string[]>([]);
const nextCursor = ref<string | undefined>();
const loaded = ref(false);
const busy = ref("");
const error = ref("");
const status = ref("");
const search = ref("");
const selectedOrganizationId = ref("");
const selectedItemId = ref("");
const selectedCollectionIds = ref<string[]>([]);
const dialogRoot = ref<HTMLElement | null>(null);
let loadGeneration = 0;

const interactionLocked = computed(() => Boolean(busy.value));
const selectedItem = computed(() => routeItems.value.find((entry) => entry.item.id === selectedItemId.value));
const selectedOrganization = computed(() => organizations.value.find((organization) => organization.organizationId === selectedOrganizationId.value));
const visibleCollections = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  return collections.value.filter((collection) => {
    if (selectedOrganizationId.value && collection.organizationId !== selectedOrganizationId.value) return false;
    return !needle || collection.name.toLocaleLowerCase().includes(needle);
  });
});
const targetableCount = computed(() => visibleCollections.value.filter((collection) => collection.targetable).length);
const routeItems = computed(() => props.items
  .filter((item) => item.kind !== "passkey")
  .flatMap((item) => {
    const reference = item.providerRefs.find((candidate) => candidate.providerId === props.provider.id);
    const remoteId = reference?.remoteId?.split("#fido2:")[0];
    // `undefined` means this was a personal Cipher or an older local projection;
    // an empty array is a valid organization Cipher with no assigned Collection.
    return remoteId && reference?.remoteCollectionIds !== undefined ? [{ item, reference, remoteId }] : [];
  }));

onMounted(() => loadCollections(true));

async function loadCollections(reset: boolean) {
  const generation = ++loadGeneration;
  busy.value = "list";
  if (reset) {
    collections.value = [];
    organizations.value = [];
    warnings.value = [];
    nextCursor.value = undefined;
    loaded.value = false;
  }
  try {
    const page = await vaultClient.listBitwardenCollections(props.provider.id, {
      pageSize: 100,
      cursor: reset ? undefined : nextCursor.value
    });
    if (generation !== loadGeneration) return;
    collections.value = reset ? page.items : appendUnique(collections.value, page.items);
    organizations.value = page.organizations;
    warnings.value = page.warnings;
    nextCursor.value = page.nextCursor;
    loaded.value = true;
    error.value = "";
    if (!selectedOrganizationId.value || !organizations.value.some((organization) => organization.organizationId === selectedOrganizationId.value)) {
      selectedOrganizationId.value = organizations.value[0]?.organizationId || "";
    }
    if (selectedItemId.value && !routeItems.value.some((entry) => entry.item.id === selectedItemId.value)) clearRouteSelection();
    syncSelectedCollections();
  } catch (cause) {
    if (generation === loadGeneration) error.value = errorMessage(cause);
  } finally {
    if (generation === loadGeneration) busy.value = "";
  }
}

function selectOrganization(organizationId: string) {
  selectedOrganizationId.value = organizationId;
  search.value = "";
  syncSelectedCollections();
}

function selectRouteItem(itemId: string) {
  selectedItemId.value = itemId;
  error.value = "";
  status.value = "";
  syncSelectedCollections();
  const reference = selectedItem.value?.reference;
  const firstCollection = reference?.remoteCollectionIds?.map((id) => collections.value.find((collection) => collection.collectionId === id)).find(Boolean);
  if (firstCollection) selectedOrganizationId.value = firstCollection.organizationId;
  void nextTick(() => dialogRoot.value?.querySelector<HTMLElement>("[data-route-collections]")?.focus());
}

function toggleCollection(collection: BitwardenCollectionSummary) {
  if (interactionLocked.value || !collection.targetable || !collection.readable) return;
  if (selectedOrganizationId.value && collection.organizationId !== selectedOrganizationId.value) return;
  const next = new Set(selectedCollectionIds.value);
  if (next.has(collection.collectionId)) next.delete(collection.collectionId);
  else next.add(collection.collectionId);
  selectedCollectionIds.value = [...next];
  error.value = "";
}

async function moveCipher() {
  const selected = selectedItem.value;
  if (!selected) return focusError("请选择要管理 Collection 的组织项目。", dialogRoot.value?.querySelector<HTMLElement>("[data-route-item]"));
  const selectedCollections = selectedCollectionIds.value.map((id) => collections.value.find((collection) => collection.collectionId === id));
  if (selectedCollections.some((collection) => !collection || !collection.targetable)) return focusError("所选 Collection 当前不可写，请刷新权限后重试。", dialogRoot.value?.querySelector<HTMLElement>("[data-route-collections]"));
  busy.value = "move";
  error.value = "";
  status.value = "";
  try {
    const result = await vaultClient.moveBitwardenCipherToCollections(props.provider.id, selected.item.id, selectedCollectionIds.value, selected.reference.revision);
    selectedCollectionIds.value = result.collectionIds || [];
    status.value = result.changed ? `${selected.item.title} 的 Collection 路由已更新。` : "项目已经位于所选 Collection。";
    emit("notice", status.value);
    if (result.changed) emit("changed");
    await loadCollections(true);
    selectedCollectionIds.value = result.collectionIds || [];
  } catch (cause) {
    error.value = `${errorMessage(cause)} 请刷新权限后重试；未确认的操作不会被当作成功。`;
  } finally {
    busy.value = "";
  }
}

function syncSelectedCollections() {
  selectedCollectionIds.value = selectedItem.value?.reference.remoteCollectionIds ? [...selectedItem.value.reference.remoteCollectionIds] : [];
}

function clearRouteSelection() {
  selectedItemId.value = "";
  selectedCollectionIds.value = [];
}

function focusError(message: string, target?: HTMLElement | null) {
  error.value = message;
  void nextTick(() => target?.focus());
}

function appendUnique(current: BitwardenCollectionSummary[], incoming: BitwardenCollectionSummary[]) {
  const next = new Map(current.map((collection) => [collection.collectionId, collection]));
  for (const collection of incoming) next.set(collection.collectionId, collection);
  return [...next.values()];
}

function permissionLabel(collection: BitwardenCollectionSummary): string {
  if (!collection.readable) return "无法读取";
  if (!collection.permissionKnown) return "权限未知";
  if (collection.readOnly) return "只读";
  if (collection.manage) return "可管理";
  return "可编辑";
}

function closeDialog() {
  if (!interactionLocked.value) emit("close");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
</script>

<template>
  <div class="modal-backdrop bitwarden-collections-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section ref="dialogRoot" class="editor-dialog bitwarden-collections-dialog" role="dialog" aria-modal="true" aria-labelledby="bitwarden-collections-title">
      <header>
        <div>
          <h2 id="bitwarden-collections-title">Bitwarden Collection · {{ provider.name }}</h2>
          <p>组织项目使用 Collection 路由；个人 Cipher 仍由文件夹管理。名称和权限无法验证时保持只读。</p>
        </div>
        <m3e-icon-button data-dialog-close aria-label="关闭 Bitwarden Collection 管理" :disabled="interactionLocked" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <div class="bitwarden-collections-boundary"><m3e-icon name="encrypted"></m3e-icon><span>只有管理页能读取组织名称和 Collection 权限；Popup、内容脚本和网页不会接触这些数据。</span></div>

      <div v-if="warnings.length" class="bitwarden-collections-warning" role="status"><m3e-icon name="warning"></m3e-icon><div><strong>兼容性提示</strong><p v-for="warning in warnings" :key="warning">{{ warning }}</p></div></div>
      <div v-if="error" class="bitwarden-collections-error" role="alert"><m3e-icon name="error"></m3e-icon><span>{{ error }}</span></div>
      <p class="bitwarden-collections-status" aria-live="polite">{{ status }}</p>

      <div class="bitwarden-collections-toolbar">
        <label class="bitwarden-collections-search"><span class="sr-only">搜索 Collection</span><m3e-icon name="search"></m3e-icon><input v-model="search" type="search" autocomplete="off" placeholder="搜索 Collection" /></label>
        <m3e-icon-button aria-label="刷新组织 Collection" :disabled="interactionLocked" @click="loadCollections(true)"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button>
      </div>

      <div class="bitwarden-collections-layout">
        <aside class="bitwarden-organization-panel" aria-labelledby="bitwarden-organizations-title">
          <div class="bitwarden-collections-heading"><div><strong id="bitwarden-organizations-title">组织</strong><small>{{ organizations.length }} 个组织</small></div><m3e-icon name="business"></m3e-icon></div>
          <div v-if="busy === 'list' && !loaded" class="bitwarden-collections-empty" role="status"><m3e-icon name="progress_activity"></m3e-icon><span>正在读取…</span></div>
          <div v-else-if="!organizations.length" class="bitwarden-collections-empty"><m3e-icon name="business_off"></m3e-icon><span>没有可用组织。</span></div>
          <div v-else class="bitwarden-organization-list">
            <button v-for="organization in organizations" :key="organization.organizationId" type="button" class="bitwarden-organization-row" :class="{ selected: organization.organizationId === selectedOrganizationId }" :aria-pressed="organization.organizationId === selectedOrganizationId" @click="selectOrganization(organization.organizationId)">
              <span class="bitwarden-organization-icon"><m3e-icon name="business"></m3e-icon></span>
              <span><strong>{{ organization.name }}</strong><small>{{ organization.fullAccess ? '完全访问' : organization.type }} · {{ organization.keyAvailable ? '密钥可用' : '密钥缺失' }}</small></span>
              <m3e-icon name="chevron_right"></m3e-icon>
            </button>
          </div>
        </aside>

        <section class="bitwarden-collection-panel" aria-labelledby="bitwarden-collection-list-title">
          <div class="bitwarden-collections-heading"><div><strong id="bitwarden-collection-list-title">{{ selectedOrganization?.name || 'Collection' }}</strong><small>{{ visibleCollections.length }} 个已加载<template v-if="nextCursor"> · 尚有更多</template></small></div><span class="bitwarden-collection-count">{{ targetableCount }} 个可路由</span></div>
          <div v-if="loaded && !visibleCollections.length" class="bitwarden-collections-empty"><m3e-icon name="folder_off"></m3e-icon><span>{{ search ? '没有匹配的 Collection。' : '当前组织没有可显示的 Collection。' }}</span></div>
          <div v-else class="bitwarden-collection-list" data-route-collections tabindex="-1">
            <label v-for="collection in visibleCollections" :key="collection.collectionId" class="bitwarden-collection-row" :class="{ selected: selectedCollectionIds.includes(collection.collectionId), unavailable: !collection.targetable }">
              <input type="checkbox" :checked="selectedCollectionIds.includes(collection.collectionId)" :disabled="interactionLocked || !collection.targetable" :aria-label="`选择 Collection ${collection.name}`" @change="toggleCollection(collection)" />
              <span class="bitwarden-collection-icon"><m3e-icon :name="collection.targetable ? 'folder_shared' : 'lock'"></m3e-icon></span>
              <span class="bitwarden-collection-copy"><strong>{{ collection.name }}</strong><small>{{ permissionLabel(collection) }}<template v-if="collection.hidePasswords"> · 隐藏密码</template><template v-if="collection.assigned === true"> · 已分配</template></small></span>
              <span class="bitwarden-collection-state" :class="collection.targetable ? 'state-ok' : 'state-muted'">{{ collection.targetable ? '可写' : '不可写' }}</span>
            </label>
          </div>
          <div v-if="nextCursor" class="bitwarden-collections-more"><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="loadCollections(false)">加载更多 Collection</m3e-button></div>
        </section>
      </div>

      <section class="bitwarden-collection-routing" aria-labelledby="bitwarden-collection-routing-title">
        <div class="bitwarden-collections-heading"><div><strong id="bitwarden-collection-routing-title">项目路由</strong><small>只显示已识别为组织 Cipher 的项目；空选表示清除 Collection（需组织权限）。</small></div><m3e-icon name="drive_file_move"></m3e-icon></div>
        <div class="bitwarden-collection-route-form">
          <label><span>组织项目</span><select data-route-item v-model="selectedItemId" :disabled="interactionLocked" @change="selectRouteItem(selectedItemId)"><option value="">选择项目</option><option v-for="entry in routeItems" :key="entry.item.id" :value="entry.item.id">{{ entry.item.title }}</option></select></label>
          <div class="bitwarden-collection-selection" aria-live="polite"><span class="bitwarden-collection-selection-icon"><m3e-icon name="checklist"></m3e-icon></span><span><strong>{{ selectedCollectionIds.length }} 个 Collection 已选择</strong><small>{{ selectedItem ? `当前项目：${selectedItem.item.title}` : '选择项目后勾选右侧 Collection' }}</small></span></div>
          <m3e-button variant="tonal" type="button" :disabled="interactionLocked || !selectedItem" @click="moveCipher"><m3e-icon slot="icon" name="save"></m3e-icon>{{ busy === 'move' ? '保存中…' : '保存路由' }}</m3e-button>
        </div>
      </section>

      <footer><span>服务器返回缺少新 Revision、项目不可见或权限不完整时，插件不会修改本地路由。</span><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="closeDialog">关闭</m3e-button></footer>
    </section>
  </div>
</template>

<style scoped>
.bitwarden-collections-dialog { width: min(100%, 920px); max-height: min(900px, calc(100dvh - 32px)); overflow: auto; }
.bitwarden-collections-dialog :deep(m3e-icon) { --m3e-icon-size: 20px; }
.bitwarden-collections-dialog :deep(m3e-icon-button) { --m3e-icon-button-icon-size: 20px; }
.bitwarden-collections-dialog :deep(m3e-button) { --m3e-button-icon-size: 20px; min-height: 44px; }
.bitwarden-collections-dialog > header, .bitwarden-collections-dialog > header > div { min-width: 0; overflow-x: clip; }
.bitwarden-collections-boundary, .bitwarden-collections-warning, .bitwarden-collections-error { min-height: 48px; border-radius: 8px; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: start; gap: 10px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.5; }
.bitwarden-collections-boundary { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.bitwarden-collections-warning { color: var(--md-sys-color-on-tertiary-container, var(--app-text)); background: var(--md-sys-color-tertiary-container, var(--app-surface-high)); }
.bitwarden-collections-warning p { margin: 2px 0 0; }
.bitwarden-collections-error { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); border: 1px solid var(--md-sys-color-error, var(--app-primary)); }
.bitwarden-collections-status { min-height: 24px; margin: 0 0 8px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.bitwarden-collections-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.bitwarden-collections-search { min-width: 0; min-height: 44px; flex: 1; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.bitwarden-collections-search input { min-width: 0; min-height: 42px; border: 0; outline: 0; color: var(--app-text); background: transparent; font: inherit; }
.bitwarden-collections-layout { display: grid; grid-template-columns: minmax(220px, .78fr) minmax(0, 1.5fr); gap: 12px; }
.bitwarden-organization-panel, .bitwarden-collection-panel, .bitwarden-collection-routing { min-width: 0; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.bitwarden-collections-heading { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 10px 16px; }
.bitwarden-collections-heading > div { min-width: 0; display: grid; gap: 2px; }
.bitwarden-collections-heading small, .bitwarden-organization-row small, .bitwarden-collection-copy small, .bitwarden-collection-selection small { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); overflow-wrap: anywhere; }
.bitwarden-collection-count { color: var(--md-sys-color-primary, var(--app-primary)); font-size: .875rem; font-weight: 650; white-space: nowrap; }
.bitwarden-organization-list, .bitwarden-collection-list { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.bitwarden-organization-row { width: 100%; min-height: 72px; border: 0; border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; grid-template-columns: 36px minmax(0, 1fr) 20px; align-items: center; gap: 10px; padding: 10px 12px; color: var(--app-text); background: transparent; text-align: left; font: inherit; cursor: pointer; }
.bitwarden-organization-row:last-child { border-bottom: 0; }
.bitwarden-organization-row:hover, .bitwarden-organization-row.selected { background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.bitwarden-organization-row:focus-visible, .bitwarden-collection-row:focus-within { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.bitwarden-organization-row > span:nth-child(2), .bitwarden-collection-copy, .bitwarden-collection-selection { min-width: 0; display: grid; gap: 2px; }
.bitwarden-organization-icon, .bitwarden-collection-icon, .bitwarden-collection-selection-icon { width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.bitwarden-collection-row { min-height: 68px; display: grid; grid-template-columns: 24px 36px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); cursor: pointer; }
.bitwarden-collection-row:last-child { border-bottom: 0; }
.bitwarden-collection-row.selected { background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.bitwarden-collection-row.unavailable { cursor: not-allowed; opacity: .72; }
.bitwarden-collection-row input { width: 20px; height: 20px; margin: 0; accent-color: var(--app-primary); }
.bitwarden-collection-copy strong { overflow-wrap: anywhere; }
.bitwarden-collection-state { min-height: 28px; display: inline-flex; align-items: center; padding: 0 8px; border-radius: 999px; font-size: .75rem; font-weight: 650; white-space: nowrap; }
.state-ok { color: var(--md-sys-color-on-primary-container, var(--app-text)); background: var(--md-sys-color-primary-container, var(--app-selected)); }
.state-muted { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.bitwarden-collections-empty { min-height: 116px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); text-align: center; }
.bitwarden-collections-more { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; justify-content: center; padding: 4px 12px; }
.bitwarden-collection-routing { margin-top: 12px; }
.bitwarden-collection-route-form { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(180px, .9fr) auto; align-items: end; gap: 12px; padding: 0 16px 16px; }
.bitwarden-collection-route-form label { min-width: 0; display: grid; gap: 6px; font-weight: 600; }
.bitwarden-collection-route-form select { width: 100%; min-width: 0; min-height: 44px; border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; padding: 8px 12px; color: var(--app-text); background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); font: inherit; }
.bitwarden-collection-selection { min-height: 44px; grid-template-columns: 36px minmax(0, 1fr); align-items: center; }
.bitwarden-collections-dialog > footer { min-height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 12px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 760px) {
  .bitwarden-collections-backdrop { align-items: center; padding: 8px; }
  .bitwarden-collections-dialog { max-height: calc(100dvh - 16px); border-radius: 16px; padding: 16px; }
  .bitwarden-collections-layout, .bitwarden-collection-route-form { grid-template-columns: minmax(0, 1fr); }
  .bitwarden-collection-route-form > m3e-button { width: 100%; }
}
@media (max-width: 420px) {
  .bitwarden-collections-dialog { padding: 12px; }
  .bitwarden-collections-heading, .bitwarden-collection-row, .bitwarden-organization-row { padding-inline: 12px; }
  .bitwarden-collection-row { grid-template-columns: 24px 32px minmax(0, 1fr); }
  .bitwarden-collection-state { grid-column: 3; justify-self: start; }
}
@media (prefers-reduced-motion: reduce) {
  .bitwarden-collections-dialog * { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
</style>
