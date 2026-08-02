<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import type { ProviderAccount } from "../core/model";
import type { KeePassGroupMutationResult, KeePassGroupSummary } from "../providers/keepass/keepass-groups";
import { vaultClient } from "../runtime/client";

const props = defineProps<{ provider: ProviderAccount }>();
const emit = defineEmits<{
  close: [];
  changed: [];
  notice: [message: string];
}>();

type GroupMode = "" | "rename" | "move" | "delete" | "restore";

const groups = ref<KeePassGroupSummary[]>([]);
const nextCursor = ref<string | undefined>();
const rootName = ref("KeePass");
const recycleBinEnabled = ref(true);
const loaded = ref(false);
const busy = ref("");
const error = ref("");
const status = ref("");
const tab = ref<"active" | "recycle">("active");
const search = ref("");
const selectedGroupId = ref("");
const mode = ref<GroupMode>("");
const createOpen = ref(false);
const createName = ref("");
const createParentGroupId = ref("");
const renameName = ref("");
const moveParentGroupId = ref("");
const restoreParentGroupId = ref("");
const dialogRoot = ref<HTMLElement | null>(null);
const createNameInput = ref<HTMLInputElement | null>(null);
let retryOperation: { intent: string; operationId: string } | undefined;
let loadGeneration = 0;

const interactionLocked = computed(() => Boolean(busy.value));
const selectedGroup = computed(() => groups.value.find((group) => group.groupId === selectedGroupId.value));
const activeGroups = computed(() => groups.value.filter((group) => !group.inRecycleBin));
const recycledGroups = computed(() => groups.value.filter((group) => group.inRecycleBin));
const groupById = computed(() => new Map(groups.value.map((group) => [group.groupId, group])));
const targetGroups = computed(() => activeGroups.value.filter((candidate) => {
  const selected = selectedGroup.value;
  if (!selected || candidate.groupId === selected.groupId) return !selected;
  return !isLoadedDescendant(candidate.groupId, selected.groupId);
}));
const displayedGroups = computed(() => {
  const source = tab.value === "active" ? activeGroups.value : recycledGroups.value;
  const needle = search.value.trim().toLocaleLowerCase();
  return needle
    ? source.filter((group) => `${group.name}\n${group.displayPath}`.toLocaleLowerCase().includes(needle))
    : source;
});

onMounted(() => loadGroups(true));

async function loadGroups(reset: boolean) {
  const generation = ++loadGeneration;
  busy.value = "list";
  if (reset) {
    groups.value = [];
    nextCursor.value = undefined;
    loaded.value = false;
  }
  try {
    const page = await vaultClient.listKeePassGroups(props.provider.id, {
      includeRecycleBin: true,
      pageSize: 100,
      cursor: reset ? undefined : nextCursor.value
    });
    if (generation !== loadGeneration) return;
    groups.value = reset ? page.items : appendUniqueGroups(groups.value, page.items);
    nextCursor.value = page.nextCursor;
    rootName.value = page.rootName;
    recycleBinEnabled.value = page.recycleBinEnabled;
    loaded.value = true;
    error.value = "";
    if (selectedGroupId.value && !groups.value.some((group) => group.groupId === selectedGroupId.value)) clearSelection();
  } catch (cause) {
    if (generation === loadGeneration) error.value = errorMessage(cause);
  } finally {
    if (generation === loadGeneration) busy.value = "";
  }
}

async function openCreate() {
  createOpen.value = true;
  createName.value = "";
  createParentGroupId.value = selectedGroup.value && !selectedGroup.value.inRecycleBin ? selectedGroup.value.groupId : "";
  error.value = "";
  await nextTick();
  createNameInput.value?.focus();
}

function selectGroup(group: KeePassGroupSummary) {
  selectedGroupId.value = selectedGroupId.value === group.groupId ? "" : group.groupId;
  mode.value = "";
  retryOperation = undefined;
  error.value = "";
}

async function showMode(nextMode: GroupMode) {
  const group = selectedGroup.value;
  if (!group) return;
  mode.value = nextMode;
  retryOperation = undefined;
  error.value = "";
  if (nextMode === "rename") renameName.value = group.nameTruncated ? "" : group.name;
  if (nextMode === "move") moveParentGroupId.value = group.parentGroupId || "";
  if (nextMode === "restore") restoreParentGroupId.value = "";
  await nextTick();
  const selector = nextMode === "delete" ? "[data-confirm-group-delete]" : `[data-group-mode="${nextMode}"] input, [data-group-mode="${nextMode}"] select`;
  dialogRoot.value?.querySelector<HTMLElement>(selector)?.focus();
}

async function createGroup() {
  const name = createName.value.trim();
  if (!name) return focusError("请输入分组名称。", createNameInput.value);
  await runMutation(
    `create:${createParentGroupId.value || "root"}:${name}`,
    "create",
    (operationId) => vaultClient.createKeePassGroup(props.provider.id, operationId, name, createParentGroupId.value || undefined),
    (result) => result.changed ? `${name} 已创建。` : `${result.group.name} 已经存在，没有重复创建。`
  );
  if (!error.value) {
    createOpen.value = false;
    createName.value = "";
  }
}

async function renameGroup() {
  const group = selectedGroup.value;
  const name = renameName.value.trim();
  if (!group) return;
  if (!name) return focusError("请输入新的分组名称。", dialogRoot.value?.querySelector<HTMLInputElement>('[data-group-mode="rename"] input'));
  await runMutation(
    `rename:${group.groupId}:${name}`,
    "rename",
    (operationId) => vaultClient.renameKeePassGroup(props.provider.id, operationId, group.groupId, name),
    (result) => result.changed ? `${group.name} 已重命名为 ${name}。` : `${group.name} 已经使用该名称。`
  );
}

async function moveGroup() {
  const group = selectedGroup.value;
  if (!group) return;
  const targetLabel = moveParentGroupId.value
    ? groups.value.find((candidate) => candidate.groupId === moveParentGroupId.value)?.displayPath || "所选分组"
    : rootName.value;
  await runMutation(
    `move:${group.groupId}:${moveParentGroupId.value || "root"}`,
    "move",
    (operationId) => vaultClient.moveKeePassGroup(props.provider.id, operationId, group.groupId, moveParentGroupId.value || undefined),
    (result) => result.changed ? `${group.name} 已移动到 ${targetLabel}。` : `${group.name} 已经位于 ${targetLabel}。`
  );
}

async function deleteGroup() {
  const group = selectedGroup.value;
  if (!group) return;
  await runMutation(
    `delete:${group.groupId}`,
    "delete",
    (operationId) => vaultClient.deleteKeePassGroup(props.provider.id, operationId, group.groupId),
    `${group.name} 已移入 KeePass 回收站。`
  );
  if (!error.value) tab.value = "recycle";
}

async function restoreGroup() {
  const group = selectedGroup.value;
  if (!group) return;
  await runMutation(
    `restore:${group.groupId}:${restoreParentGroupId.value || "previous"}`,
    "restore",
    (operationId) => vaultClient.restoreKeePassGroup(props.provider.id, operationId, group.groupId, restoreParentGroupId.value || undefined),
    `${group.name} 已恢复。`
  );
  if (!error.value) tab.value = "active";
}

async function runMutation(
  intent: string,
  action: string,
  mutate: (operationId: string) => Promise<KeePassGroupMutationResult>,
  successMessage: string | ((result: KeePassGroupMutationResult) => string)
): Promise<KeePassGroupMutationResult | undefined> {
  const operationId = operationIdFor(intent);
  busy.value = action;
  error.value = "";
  status.value = "";
  try {
    const result = await mutate(operationId);
    const message = typeof successMessage === "function" ? successMessage(result) : successMessage;
    retryOperation = undefined;
    mode.value = "";
    status.value = message;
    if (result.changed) {
      emit("notice", `${message} 需要导出 KDBX 文件才能永久保存。`);
      emit("changed");
    } else {
      emit("notice", message);
    }
    await loadGroups(true);
    return result;
  } catch (cause) {
    error.value = `${errorMessage(cause)} 修正输入后会使用新的操作标识；原输入可安全重试。`;
    return undefined;
  } finally {
    busy.value = "";
  }
}

function operationIdFor(intent: string): string {
  if (retryOperation?.intent === intent) return retryOperation.operationId;
  retryOperation = { intent, operationId: crypto.randomUUID() };
  return retryOperation.operationId;
}

function clearSelection() {
  selectedGroupId.value = "";
  mode.value = "";
  retryOperation = undefined;
}

function focusError(message: string, target?: HTMLElement | null) {
  error.value = message;
  void nextTick(() => target?.focus());
}

function isLoadedDescendant(candidateId: string, ancestorId: string): boolean {
  let current = groupById.value.get(candidateId);
  const seen = new Set<string>();
  while (current?.parentGroupId && !seen.has(current.parentGroupId)) {
    if (current.parentGroupId === ancestorId) return true;
    seen.add(current.parentGroupId);
    current = groupById.value.get(current.parentGroupId);
  }
  return false;
}

function appendUniqueGroups(current: KeePassGroupSummary[], incoming: KeePassGroupSummary[]): KeePassGroupSummary[] {
  const next = new Map(current.map((group) => [group.groupId, group]));
  for (const group of incoming) next.set(group.groupId, group);
  return [...next.values()];
}

function closeDialog() {
  if (!interactionLocked.value) emit("close");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
</script>

<template>
  <div class="modal-backdrop keepass-groups-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section ref="dialogRoot" class="editor-dialog keepass-groups-dialog" role="dialog" aria-modal="true" aria-labelledby="keepass-groups-title">
      <header>
        <div>
          <h2 id="keepass-groups-title">KeePass 分组 · {{ provider.name }}</h2>
          <p>分组层级保存在当前 KDBX 会话中；完成后需要导出文件。UUID、条目、历史、附件和未知元数据保持在原生分组树中。</p>
        </div>
        <m3e-icon-button data-dialog-close aria-label="关闭 KeePass 分组管理" :disabled="interactionLocked" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <div class="keepass-groups-boundary"><m3e-icon name="encrypted"></m3e-icon><span>分组接口仅允许管理页调用；Popup 与网页内容脚本无法读取 KDBX 分组名称或结构。</span></div>

      <div class="keepass-groups-tabs" role="tablist" aria-label="KeePass 分组范围">
        <button type="button" role="tab" :aria-selected="tab === 'active'" :class="{ active: tab === 'active' }" @click="tab = 'active'; clearSelection()"><m3e-icon name="folder"></m3e-icon><span>分组</span><small>{{ activeGroups.length }}</small></button>
        <button type="button" role="tab" :aria-selected="tab === 'recycle'" :class="{ active: tab === 'recycle' }" @click="tab = 'recycle'; clearSelection()"><m3e-icon name="delete"></m3e-icon><span>回收站</span><small>{{ recycledGroups.filter((group) => !group.isRecycleBin).length }}</small></button>
      </div>

      <div class="keepass-groups-toolbar">
        <label><span class="sr-only">搜索 KeePass 分组</span><m3e-icon name="search"></m3e-icon><input v-model="search" type="search" autocomplete="off" placeholder="搜索分组路径" /></label>
        <m3e-button v-if="tab === 'active'" variant="filled" type="button" :disabled="interactionLocked" @click="openCreate"><m3e-icon slot="icon" name="create_new_folder"></m3e-icon>新建分组</m3e-button>
      </div>

      <form v-if="createOpen" class="keepass-group-create" @submit.prevent="createGroup">
        <span class="keepass-group-form-icon"><m3e-icon name="create_new_folder"></m3e-icon></span>
        <label><span>分组名称</span><input ref="createNameInput" v-model="createName" autocomplete="off" :disabled="interactionLocked" /></label>
        <label><span>父分组</span><select v-model="createParentGroupId" :disabled="interactionLocked"><option value="">{{ rootName }} 根目录</option><option v-for="group in activeGroups" :key="group.groupId" :value="group.groupId">{{ group.displayPath }}</option></select></label>
        <div><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="createOpen = false; retryOperation = undefined">取消</m3e-button><m3e-button variant="tonal" type="submit" :disabled="interactionLocked">{{ busy === 'create' ? '创建中…' : '创建' }}</m3e-button></div>
      </form>

      <div v-if="!recycleBinEnabled" class="keepass-groups-warning" role="status"><m3e-icon name="warning"></m3e-icon><span>此 KDBX 关闭了回收站。浏览器仍允许查看和整理分组，但会拒绝不可恢复的分组删除。</span></div>
      <div v-if="error" class="keepass-groups-error" role="alert"><m3e-icon name="error"></m3e-icon><span>{{ error }}</span></div>
      <p class="keepass-groups-status" aria-live="polite">{{ status }}</p>

      <section class="keepass-groups-list-shell" aria-labelledby="keepass-groups-list-title">
        <div class="keepass-groups-list-heading"><div><strong id="keepass-groups-list-title">{{ tab === 'active' ? '当前分组' : '回收站分组树' }}</strong><small>{{ displayedGroups.length }} 个已加载<template v-if="nextCursor"> · 尚有更多</template></small></div><m3e-icon-button aria-label="刷新 KeePass 分组" :disabled="interactionLocked" @click="loadGroups(true)"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button></div>
        <div v-if="busy === 'list' && !loaded" class="keepass-groups-empty" role="status"><m3e-icon name="progress_activity"></m3e-icon><span>正在读取 KDBX 分组摘要…</span></div>
        <div v-else-if="loaded && !displayedGroups.length" class="keepass-groups-empty"><m3e-icon :name="tab === 'active' ? 'folder_off' : 'delete_sweep'"></m3e-icon><span>{{ search ? '没有匹配的分组。' : tab === 'active' ? '数据库根目录下还没有分组。' : 'KeePass 回收站中没有可恢复的分组。' }}</span></div>
        <ul v-else class="keepass-groups-list">
          <li v-for="group in displayedGroups" :key="group.groupId">
            <button class="keepass-group-row" type="button" :class="{ selected: selectedGroupId === group.groupId }" :aria-expanded="selectedGroupId === group.groupId" @click="selectGroup(group)">
              <span class="keepass-group-icon" :class="{ recycle: group.inRecycleBin }"><m3e-icon :name="group.isRecycleBin ? 'delete' : group.inRecycleBin ? 'folder_delete' : 'folder'"></m3e-icon></span>
              <span class="keepass-group-copy"><strong>{{ group.name }}</strong><small>{{ group.displayPath }}</small><small>{{ group.entryCount }} 个直接条目 · {{ group.childGroupCount }} 个子分组<template v-if="group.nameTruncated || group.displayPathTruncated"> · 名称过长，仅显示摘要</template></small></span>
              <span v-if="group.isRecycleBin" class="keepass-group-state">系统回收站</span><span v-else-if="group.canRestore" class="keepass-group-state">可恢复</span>
              <m3e-icon name="expand_more"></m3e-icon>
            </button>

            <div v-if="selectedGroupId === group.groupId" class="keepass-group-detail">
              <template v-if="group.isRecycleBin"><p>此分组由 KDBX 元数据指定为回收站。分组树会原样显示，系统回收站自身不能重命名、移动或删除。</p></template>
              <template v-else-if="group.canRestore">
                <div v-if="mode !== 'restore'" class="keepass-group-actions"><m3e-button variant="tonal" type="button" :disabled="interactionLocked" @click="showMode('restore')"><m3e-icon slot="icon" name="restore_from_trash"></m3e-icon>恢复完整分组树</m3e-button></div>
                <form v-else data-group-mode="restore" class="keepass-group-action-form" @submit.prevent="restoreGroup">
                  <label><span>恢复位置</span><select v-model="restoreParentGroupId" :disabled="interactionLocked"><option value="">原父分组；不存在时使用根目录</option><option v-for="target in targetGroups" :key="target.groupId" :value="target.groupId">{{ target.displayPath }}</option></select><small>条目、历史、附件、UUID 与子分组一起恢复。</small></label>
                  <div><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="mode = ''">取消</m3e-button><m3e-button variant="tonal" type="submit" :disabled="interactionLocked">{{ busy === 'restore' ? '恢复中…' : '确认恢复' }}</m3e-button></div>
                </form>
              </template>
              <template v-else-if="!group.inRecycleBin">
                <div v-if="!mode" class="keepass-group-actions"><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="showMode('rename')"><m3e-icon slot="icon" name="edit"></m3e-icon>重命名</m3e-button><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="showMode('move')"><m3e-icon slot="icon" name="drive_file_move"></m3e-icon>移动</m3e-button><m3e-button class="keepass-group-delete-action" variant="text" type="button" :disabled="interactionLocked || !recycleBinEnabled" @click="showMode('delete')"><m3e-icon slot="icon" name="delete"></m3e-icon>移入回收站</m3e-button></div>
                <form v-else-if="mode === 'rename'" data-group-mode="rename" class="keepass-group-action-form" @submit.prevent="renameGroup"><label><span>新名称</span><input v-model="renameName" autocomplete="off" :disabled="interactionLocked" /><small>同级名称按 Monica Android 规则进行不区分大小写的冲突检查。</small></label><div><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="mode = ''">取消</m3e-button><m3e-button variant="tonal" type="submit" :disabled="interactionLocked">{{ busy === 'rename' ? '保存中…' : '保存名称' }}</m3e-button></div></form>
                <form v-else-if="mode === 'move'" data-group-mode="move" class="keepass-group-action-form" @submit.prevent="moveGroup"><label><span>目标父分组</span><select v-model="moveParentGroupId" :disabled="interactionLocked"><option value="">{{ rootName }} 根目录</option><option v-for="target in targetGroups" :key="target.groupId" :value="target.groupId">{{ target.displayPath }}</option></select><small>自身和已加载的子孙分组从列表中排除；后台仍会再次校验完整树。</small></label><div><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="mode = ''">取消</m3e-button><m3e-button variant="tonal" type="submit" :disabled="interactionLocked">{{ busy === 'move' ? '移动中…' : '确认移动' }}</m3e-button></div></form>
                <div v-else-if="mode === 'delete'" class="keepass-group-delete-confirmation"><m3e-icon name="warning"></m3e-icon><span><strong>将“{{ group.name }}”移入 KeePass 回收站？</strong><small>整个子树会一起移动，条目、历史、附件和未知字段保持原样。导出 KDBX 后修改才会永久保存。</small></span><div><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="mode = ''">取消</m3e-button><m3e-button data-confirm-group-delete class="keepass-group-confirm-delete" variant="tonal" type="button" :disabled="interactionLocked" @click="deleteGroup">{{ busy === 'delete' ? '处理中…' : '确认移入回收站' }}</m3e-button></div></div>
              </template>
              <p v-else>此分组属于回收站内的子树。恢复最外层分组后，完整层级会一起返回。</p>
            </div>
          </li>
        </ul>
        <div v-if="nextCursor" class="keepass-groups-more"><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="loadGroups(false)">加载更多分组</m3e-button></div>
      </section>

      <footer><span>所有修改当前只存在于内存会话。</span><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="closeDialog">关闭</m3e-button></footer>
    </section>
  </div>
</template>

<style scoped>
.keepass-groups-dialog { width: min(100%, 780px); overflow-x: hidden; }
.keepass-groups-dialog :deep(m3e-icon) { --m3e-icon-size: 20px; }
.keepass-groups-dialog :deep(m3e-icon-button) { --m3e-icon-button-icon-size: 20px; }
.keepass-groups-dialog :deep(m3e-button) { --m3e-button-icon-size: 20px; min-height: 44px; }
.keepass-groups-dialog > header, .keepass-groups-dialog > header > div { min-width: 0; overflow-x: clip; }
.keepass-groups-boundary, .keepass-groups-warning, .keepass-groups-error { min-height: 48px; border-radius: 8px; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.5; }
.keepass-groups-boundary { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.keepass-groups-warning, .keepass-groups-error { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.keepass-groups-error { border: 1px solid var(--md-sys-color-error, var(--app-primary)); }
.keepass-groups-tabs { border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: hidden; margin-bottom: 12px; }
.keepass-groups-tabs button { min-width: 0; min-height: 48px; border: 0; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 8px 14px; color: var(--app-text); background: transparent; font: inherit; cursor: pointer; }
.keepass-groups-tabs button + button { border-left: 1px solid var(--md-sys-color-outline, var(--app-outline)); }
.keepass-groups-tabs button.active { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.keepass-groups-tabs button:focus-visible, .keepass-group-row:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.keepass-groups-tabs small { font-variant-numeric: tabular-nums; }
.keepass-groups-toolbar { min-width: 0; display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.keepass-groups-toolbar label { min-width: 0; min-height: 44px; flex: 1 1 auto; border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 8px; padding: 0 12px; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.keepass-groups-toolbar input { min-width: 0; min-height: 42px; border: 0; outline: 0; color: var(--app-text); background: transparent; font: inherit; }
.keepass-group-create { border: 1px solid var(--md-sys-color-primary, var(--app-primary)); border-radius: 8px; display: grid; grid-template-columns: 40px repeat(2, minmax(0, 1fr)); align-items: end; gap: 12px; padding: 12px; margin-bottom: 12px; background: var(--md-sys-color-primary-container, var(--app-selected)); }
.keepass-group-form-icon, .keepass-group-icon { width: 40px; height: 40px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.keepass-group-icon.recycle { color: var(--md-sys-color-error, var(--app-primary)); }
.keepass-group-create label, .keepass-group-action-form label { min-width: 0; display: grid; gap: 6px; font-weight: 600; }
.keepass-group-create input, .keepass-group-create select, .keepass-group-action-form input, .keepass-group-action-form select { width: 100%; min-width: 0; min-height: 44px; border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; padding: 8px 12px; color: var(--app-text); background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); font: inherit; }
.keepass-group-create > div, .keepass-group-action-form > div, .keepass-group-delete-confirmation > div { grid-column: 2 / -1; display: flex; justify-content: flex-end; gap: 8px; }
.keepass-groups-status { min-height: 24px; margin: 0 0 8px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.keepass-groups-list-shell { border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.keepass-groups-list-heading { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 10px 16px; }
.keepass-groups-list-heading > div, .keepass-group-copy, .keepass-group-delete-confirmation > span { min-width: 0; display: grid; gap: 2px; }
.keepass-groups-list-heading small, .keepass-group-copy small, .keepass-group-detail p, .keepass-group-action-form small, .keepass-group-delete-confirmation small { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); overflow-wrap: anywhere; }
.keepass-groups-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.keepass-groups-list > li + li { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.keepass-group-row { width: 100%; min-height: 72px; border: 0; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto 24px; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; color: var(--app-text); background: transparent; text-align: left; font: inherit; cursor: pointer; }
.keepass-group-row:hover, .keepass-group-row.selected { background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.keepass-group-copy strong { overflow-wrap: anywhere; }
.keepass-group-state { max-width: 120px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); text-align: right; overflow-wrap: anywhere; }
.keepass-group-detail { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; gap: 12px; padding: 12px 16px; background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.keepass-group-detail p { margin: 0; line-height: 1.5; }
.keepass-group-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.keepass-group-delete-action, .keepass-group-confirm-delete { color: var(--md-sys-color-error, var(--app-primary)); }
.keepass-group-action-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 12px; }
.keepass-group-action-form > div { grid-column: auto; }
.keepass-group-delete-confirmation { border: 1px solid var(--md-sys-color-error, var(--app-primary)); border-radius: 8px; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.keepass-groups-empty { min-height: 104px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); text-align: center; }
.keepass-groups-more { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; justify-content: center; padding: 4px 12px; }
.keepass-groups-dialog > footer { min-height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 12px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 700px) {
  .keepass-groups-backdrop { align-items: center; padding: 8px; }
  .keepass-groups-dialog { max-height: calc(100dvh - 16px); border-radius: 16px; padding: 16px; }
  .keepass-groups-toolbar { align-items: stretch; flex-direction: column; }
  .keepass-groups-toolbar > m3e-button { width: 100%; }
  .keepass-group-create { grid-template-columns: 40px minmax(0, 1fr); align-items: stretch; }
  .keepass-group-create label, .keepass-group-create > div { grid-column: 1 / -1; }
  .keepass-group-row { grid-template-columns: 40px minmax(0, 1fr) 24px; }
  .keepass-group-state { grid-column: 2; max-width: none; text-align: left; }
  .keepass-group-action-form, .keepass-group-delete-confirmation { grid-template-columns: 32px minmax(0, 1fr); align-items: stretch; }
  .keepass-group-action-form label, .keepass-group-action-form > div { grid-column: 1 / -1; }
  .keepass-group-delete-confirmation > div { grid-column: 1 / -1; align-items: stretch; flex-direction: column; }
  .keepass-group-actions { align-items: stretch; flex-direction: column; }
  .keepass-groups-dialog > footer { align-items: stretch; flex-direction: column; }
}
@media (max-width: 420px) {
  .keepass-groups-dialog { padding: 12px; }
  .keepass-groups-tabs { grid-template-columns: minmax(0, 1fr); }
  .keepass-groups-tabs button + button { border-left: 0; border-top: 1px solid var(--md-sys-color-outline, var(--app-outline)); }
  .keepass-group-row, .keepass-groups-list-heading, .keepass-group-detail { padding-inline: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .keepass-groups-dialog * { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
</style>
