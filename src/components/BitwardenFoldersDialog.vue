<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import type { ProviderAccount, VaultItem } from "../core/model";
import type { BitwardenFolderMutationResult, BitwardenFolderSummary } from "../providers/bitwarden/bitwarden-folders";
import { vaultClient } from "../runtime/client";

const props = defineProps<{ provider: ProviderAccount; items: VaultItem[] }>();
const emit = defineEmits<{
  close: [];
  changed: [];
  notice: [message: string];
}>();

type FolderMode = "" | "rename" | "delete";

const folders = ref<BitwardenFolderSummary[]>([]);
const nextCursor = ref<string | undefined>();
const loaded = ref(false);
const busy = ref("");
const error = ref("");
const status = ref("");
const search = ref("");
const selectedFolderId = ref("");
const mode = ref<FolderMode>("");
const createOpen = ref(false);
const createName = ref("");
const renameName = ref("");
const moveItemId = ref("");
const moveTargetId = ref("");
const dialogRoot = ref<HTMLElement | null>(null);
const createNameInput = ref<HTMLInputElement | null>(null);
let loadGeneration = 0;

const interactionLocked = computed(() => Boolean(busy.value));
const selectedFolder = computed(() => folders.value.find((folder) => folder.folderId === selectedFolderId.value));
const displayedFolders = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  return needle ? folders.value.filter((folder) => folder.name.toLocaleLowerCase().includes(needle)) : folders.value;
});
const folderById = computed(() => new Map(folders.value.map((folder) => [folder.folderId, folder])));
const moveItems = computed(() => props.items
  .filter((item) => item.kind !== "passkey")
  .flatMap((item) => {
    const reference = item.providerRefs.find((candidate) => candidate.providerId === props.provider.id);
    const remoteId = reference?.remoteId?.split("#fido2:")[0];
    return remoteId ? [{ item, reference, remoteId }] : [];
  }));
const selectedMoveItem = computed(() => moveItems.value.find((entry) => entry.item.id === moveItemId.value));
const selectedMoveFolder = computed(() => moveTargetId.value ? folderById.value.get(moveTargetId.value) : undefined);

onMounted(() => loadFolders(true));

async function loadFolders(reset: boolean) {
  const generation = ++loadGeneration;
  busy.value = "list";
  if (reset) {
    folders.value = [];
    nextCursor.value = undefined;
    loaded.value = false;
  }
  try {
    const page = await vaultClient.listBitwardenFolders(props.provider.id, {
      pageSize: 100,
      cursor: reset ? undefined : nextCursor.value
    });
    if (generation !== loadGeneration) return;
    folders.value = reset ? page.items : appendUnique(folders.value, page.items);
    nextCursor.value = page.nextCursor;
    loaded.value = true;
    error.value = "";
    if (selectedFolderId.value && !folders.value.some((folder) => folder.folderId === selectedFolderId.value)) clearSelection();
    if (moveTargetId.value && !folders.value.some((folder) => folder.folderId === moveTargetId.value)) moveTargetId.value = "";
  } catch (cause) {
    if (generation === loadGeneration) error.value = errorMessage(cause);
  } finally {
    if (generation === loadGeneration) busy.value = "";
  }
}

async function openCreate() {
  createOpen.value = true;
  createName.value = "";
  mode.value = "";
  error.value = "";
  await nextTick();
  createNameInput.value?.focus();
}

function selectFolder(folder: BitwardenFolderSummary) {
  selectedFolderId.value = selectedFolderId.value === folder.folderId ? "" : folder.folderId;
  mode.value = "";
  renameName.value = folder.readable ? folder.name : "";
  error.value = "";
}

async function showMode(next: FolderMode) {
  if (!selectedFolder.value) return;
  mode.value = next;
  error.value = "";
  if (next === "rename" && selectedFolder.value.readable) renameName.value = selectedFolder.value.name;
  await nextTick();
  const selector = next === "delete" ? "[data-confirm-folder-delete]" : `[data-folder-mode="${next}"] input`;
  dialogRoot.value?.querySelector<HTMLElement>(selector)?.focus();
}

async function createFolder() {
  const name = createName.value.trim();
  if (!name) return focusError("请输入文件夹名称。", createNameInput.value);
  await runMutation("create", () => vaultClient.createBitwardenFolder(props.provider.id, name), (result) => result.folder ? `${result.folder.name} 已创建。` : "文件夹已创建。");
  if (!error.value) {
    createOpen.value = false;
    createName.value = "";
  }
}

async function renameFolder() {
  const folder = selectedFolder.value;
  const name = renameName.value.trim();
  if (!folder) return;
  if (!folder.readable) return focusError("此文件夹名称无法解密，不能安全重命名。", dialogRoot.value?.querySelector<HTMLInputElement>('[data-folder-mode="rename"] input'));
  if (!name) return focusError("请输入新的文件夹名称。", dialogRoot.value?.querySelector<HTMLInputElement>('[data-folder-mode="rename"] input'));
  await runMutation("rename", () => vaultClient.renameBitwardenFolder(props.provider.id, folder.folderId, name, folder.revision), () => `${folder.name} 已重命名为 ${name}。`);
}

async function deleteFolder() {
  const folder = selectedFolder.value;
  if (!folder) return;
  await runMutation("delete", () => vaultClient.deleteBitwardenFolder(props.provider.id, folder.folderId, folder.revision), () => `${folder.name} 已删除；其中项目已回到无文件夹。`);
}

async function moveCipher() {
  const selected = selectedMoveItem.value;
  if (!selected) return focusError("请选择要移动的项目。", dialogRoot.value?.querySelector<HTMLElement>("[data-move-item]"));
  const target = selectedMoveFolder.value;
  if (target && !target.readable) return focusError("目标文件夹名称无法解密，不能安全移动。", dialogRoot.value?.querySelector<HTMLElement>("[data-move-target]"));
  const currentFolderId = selected.reference.remoteFolderId || "";
  const targetId = moveTargetId.value || undefined;
  if (currentFolderId === (targetId || "")) {
    status.value = "项目已经位于所选位置。";
    return;
  }
  await runMutation("move", () => vaultClient.moveBitwardenCipherToFolder(
    props.provider.id,
    selected.item.id,
    targetId,
    selected.reference.revision,
    target?.revision
  ), () => `${selected.item.title} 已移动到 ${target?.name || "无文件夹"}。`);
}

async function runMutation(
  action: string,
  mutate: () => Promise<{ changed: boolean }>,
  successMessage: (result: BitwardenFolderMutationResult) => string
) {
  busy.value = action;
  error.value = "";
  status.value = "";
  try {
    const result = await mutate();
    mode.value = "";
    createOpen.value = false;
    status.value = successMessage(result);
    emit("notice", status.value);
    if (result.changed) emit("changed");
    await loadFolders(true);
  } catch (cause) {
    error.value = `${errorMessage(cause)} 请刷新后重试；未确认的操作不会被当作成功。`;
  } finally {
    busy.value = "";
  }
}

function clearSelection() {
  selectedFolderId.value = "";
  mode.value = "";
}

function focusError(message: string, target?: HTMLElement | null) {
  error.value = message;
  void nextTick(() => target?.focus());
}

function appendUnique(current: BitwardenFolderSummary[], incoming: BitwardenFolderSummary[]) {
  const next = new Map(current.map((folder) => [folder.folderId, folder]));
  for (const folder of incoming) next.set(folder.folderId, folder);
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
  <div class="modal-backdrop bitwarden-folders-backdrop" role="presentation" @mousedown.self="closeDialog">
    <section ref="dialogRoot" class="editor-dialog bitwarden-folders-dialog" role="dialog" aria-modal="true" aria-labelledby="bitwarden-folders-title">
      <header>
        <div>
          <h2 id="bitwarden-folders-title">Bitwarden 文件夹 · {{ provider.name }}</h2>
          <p>名称按 Bitwarden 用户密钥加密；组织项目不放入个人文件夹，Collection 会在后续权限界面中管理。</p>
        </div>
        <m3e-icon-button data-dialog-close aria-label="关闭 Bitwarden 文件夹管理" :disabled="interactionLocked" @click="closeDialog"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>

      <div class="bitwarden-folders-boundary"><m3e-icon name="encrypted"></m3e-icon><span>仅管理页可以读取文件夹名称和项目路由；Popup、内容脚本和网页无法调用这些接口。</span></div>

      <div class="bitwarden-folders-toolbar">
        <label><span class="sr-only">搜索 Bitwarden 文件夹</span><m3e-icon name="search"></m3e-icon><input v-model="search" type="search" autocomplete="off" placeholder="搜索文件夹" /></label>
        <m3e-button variant="filled" type="button" :disabled="interactionLocked" @click="openCreate"><m3e-icon slot="icon" name="create_new_folder"></m3e-icon>新建文件夹</m3e-button>
      </div>

      <form v-if="createOpen" class="bitwarden-folder-create" @submit.prevent="createFolder">
        <span class="bitwarden-folder-form-icon"><m3e-icon name="create_new_folder"></m3e-icon></span>
        <label><span>文件夹名称</span><input ref="createNameInput" v-model="createName" autocomplete="off" maxlength="256" :disabled="interactionLocked" /></label>
        <div><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="createOpen = false">取消</m3e-button><m3e-button variant="tonal" type="submit" :disabled="interactionLocked">{{ busy === 'create' ? '创建中…' : '创建' }}</m3e-button></div>
      </form>

      <div v-if="error" class="bitwarden-folders-error" role="alert"><m3e-icon name="error"></m3e-icon><span>{{ error }}</span></div>
      <p class="bitwarden-folders-status" aria-live="polite">{{ status }}</p>

      <section class="bitwarden-folders-list-shell" aria-labelledby="bitwarden-folders-list-title">
        <div class="bitwarden-folders-list-heading"><div><strong id="bitwarden-folders-list-title">个人文件夹</strong><small>{{ displayedFolders.length }} 个已加载<template v-if="nextCursor"> · 尚有更多</template></small></div><m3e-icon-button aria-label="刷新 Bitwarden 文件夹" :disabled="interactionLocked" @click="loadFolders(true)"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button></div>
        <div v-if="busy === 'list' && !loaded" class="bitwarden-folders-empty" role="status"><m3e-icon name="progress_activity"></m3e-icon><span>正在读取加密文件夹摘要…</span></div>
        <div v-else-if="loaded && !displayedFolders.length" class="bitwarden-folders-empty"><m3e-icon name="folder_off"></m3e-icon><span>{{ search ? '没有匹配的文件夹。' : '当前密码库还没有个人文件夹。' }}</span></div>
        <ul v-else class="bitwarden-folders-list">
          <li v-for="folder in displayedFolders" :key="folder.folderId">
            <button class="bitwarden-folder-row" type="button" :class="{ selected: selectedFolderId === folder.folderId }" :aria-expanded="selectedFolderId === folder.folderId" @click="selectFolder(folder)">
              <span class="bitwarden-folder-icon" :class="{ unreadable: !folder.readable }"><m3e-icon :name="folder.readable ? 'folder' : 'folder_off'"></m3e-icon></span>
              <span class="bitwarden-folder-copy"><strong>{{ folder.name }}</strong><small>{{ folder.cipherCount }} 个项目<template v-if="!folder.readable"> · 名称无法解密</template></small></span>
              <m3e-icon name="expand_more"></m3e-icon>
            </button>
            <div v-if="selectedFolderId === folder.folderId" class="bitwarden-folder-detail">
              <p v-if="!folder.readable" class="bitwarden-folder-warning"><m3e-icon name="warning"></m3e-icon><span>此文件夹不能安全编辑。请使用拥有相同 Vault key 的 Bitwarden 客户端修复后再同步。</span></p>
              <div v-if="!mode" class="bitwarden-folder-actions"><m3e-button variant="text" type="button" :disabled="interactionLocked || !folder.readable" @click="showMode('rename')"><m3e-icon slot="icon" name="edit"></m3e-icon>重命名</m3e-button><m3e-button class="bitwarden-folder-delete-action" variant="text" type="button" :disabled="interactionLocked" @click="showMode('delete')"><m3e-icon slot="icon" name="delete"></m3e-icon>删除</m3e-button></div>
              <form v-else-if="mode === 'rename'" data-folder-mode="rename" class="bitwarden-folder-action-form" @submit.prevent="renameFolder"><label><span>新名称</span><input v-model="renameName" autocomplete="off" maxlength="256" :disabled="interactionLocked" /><small>保存前会再次检查文件夹 RevisionDate，过期选择会停止写入。</small></label><div><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="mode = ''">取消</m3e-button><m3e-button variant="tonal" type="submit" :disabled="interactionLocked">{{ busy === 'rename' ? '保存中…' : '保存名称' }}</m3e-button></div></form>
              <div v-else class="bitwarden-folder-delete-confirmation"><m3e-icon name="warning"></m3e-icon><span><strong>删除“{{ folder.name }}”？</strong><small>{{ folder.cipherCount ? `${folder.cipherCount} 个项目会回到无文件夹；Cipher、附件、Passkey 和未知字段不会删除。` : '文件夹为空；此操作不可恢复。' }}</small></span><div><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="mode = ''">取消</m3e-button><m3e-button data-confirm-folder-delete class="bitwarden-folder-confirm-delete" variant="tonal" type="button" :disabled="interactionLocked" @click="deleteFolder">{{ busy === 'delete' ? '删除中…' : '确认删除' }}</m3e-button></div></div>
            </div>
          </li>
        </ul>
        <div v-if="nextCursor" class="bitwarden-folders-more"><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="loadFolders(false)">加载更多文件夹</m3e-button></div>
      </section>

      <section class="bitwarden-folder-routing" aria-labelledby="bitwarden-folder-routing-title">
        <div class="bitwarden-folders-list-heading"><div><strong id="bitwarden-folder-routing-title">项目归类</strong><small>只显示个人 Cipher；组织项目请使用 Collection。</small></div><m3e-icon name="drive_file_move"></m3e-icon></div>
        <form class="bitwarden-folder-move-form" @submit.prevent="moveCipher">
          <label><span>项目</span><select data-move-item v-model="moveItemId" :disabled="interactionLocked"><option value="">选择项目</option><option v-for="entry in moveItems" :key="entry.item.id" :value="entry.item.id">{{ entry.item.title }}</option></select></label>
          <label><span>目标文件夹</span><select data-move-target v-model="moveTargetId" :disabled="interactionLocked"><option value="">无文件夹</option><option v-for="folder in folders" :key="folder.folderId" :value="folder.folderId" :disabled="!folder.readable">{{ folder.name }}{{ folder.readable ? '' : '（无法解密）' }}</option></select></label>
          <m3e-button variant="tonal" type="submit" :disabled="interactionLocked || !moveItemId">{{ busy === 'move' ? '移动中…' : '移动项目' }}</m3e-button>
        </form>
      </section>

      <footer><span>移动与文件夹变更会写回 Bitwarden；冲突时保持原路由并要求刷新。</span><m3e-button variant="text" type="button" :disabled="interactionLocked" @click="closeDialog">关闭</m3e-button></footer>
    </section>
  </div>
</template>

<style scoped>
.bitwarden-folders-dialog { width: min(100%, 780px); overflow-x: hidden; }
.bitwarden-folders-dialog :deep(m3e-icon) { --m3e-icon-size: 20px; }
.bitwarden-folders-dialog :deep(m3e-icon-button) { --m3e-icon-button-icon-size: 20px; }
.bitwarden-folders-dialog :deep(m3e-button) { --m3e-button-icon-size: 20px; min-height: 44px; }
.bitwarden-folders-dialog > header, .bitwarden-folders-dialog > header > div { min-width: 0; overflow-x: clip; }
.bitwarden-folders-boundary, .bitwarden-folders-error, .bitwarden-folder-warning { min-height: 48px; border-radius: 8px; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.5; }
.bitwarden-folders-boundary { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.bitwarden-folders-error, .bitwarden-folder-warning { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.bitwarden-folders-error { border: 1px solid var(--md-sys-color-error, var(--app-primary)); }
.bitwarden-folders-toolbar { min-width: 0; display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.bitwarden-folders-toolbar label { min-width: 0; min-height: 44px; flex: 1 1 auto; border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 8px; padding: 0 12px; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.bitwarden-folders-toolbar input { min-width: 0; min-height: 42px; border: 0; outline: 0; color: var(--app-text); background: transparent; font: inherit; }
.bitwarden-folder-create { border: 1px solid var(--md-sys-color-primary, var(--app-primary)); border-radius: 8px; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: end; gap: 12px; padding: 12px; margin-bottom: 12px; background: var(--md-sys-color-primary-container, var(--app-selected)); }
.bitwarden-folder-form-icon, .bitwarden-folder-icon { width: 40px; height: 40px; border-radius: 8px; display: grid; place-items: center; color: var(--app-primary); background: var(--md-sys-color-surface-container-high, var(--app-surface-high)); }
.bitwarden-folder-icon.unreadable { color: var(--md-sys-color-error, var(--app-primary)); }
.bitwarden-folder-create label, .bitwarden-folder-action-form label, .bitwarden-folder-move-form label { min-width: 0; display: grid; gap: 6px; font-weight: 600; }
.bitwarden-folder-create input, .bitwarden-folder-action-form input, .bitwarden-folder-move-form select { width: 100%; min-width: 0; min-height: 44px; border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; padding: 8px 12px; color: var(--app-text); background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); font: inherit; }
.bitwarden-folder-create > div, .bitwarden-folder-action-form > div, .bitwarden-folder-delete-confirmation > div { display: flex; justify-content: flex-end; gap: 8px; }
.bitwarden-folders-status { min-height: 24px; margin: 0 0 8px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.bitwarden-folders-list-shell, .bitwarden-folder-routing { border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.bitwarden-folder-routing { margin-top: 12px; }
.bitwarden-folders-list-heading { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 10px 16px; }
.bitwarden-folders-list-heading > div, .bitwarden-folder-copy, .bitwarden-folder-delete-confirmation > span { min-width: 0; display: grid; gap: 2px; }
.bitwarden-folders-list-heading small, .bitwarden-folder-copy small, .bitwarden-folder-detail small, .bitwarden-folder-action-form small, .bitwarden-folder-delete-confirmation small, .bitwarden-folder-move-form small { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); overflow-wrap: anywhere; }
.bitwarden-folders-list, .bitwarden-folder-routing { list-style: none; margin: 0; padding: 0; }
.bitwarden-folders-list { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.bitwarden-folders-list > li + li { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.bitwarden-folder-row { width: 100%; min-height: 72px; border: 0; display: grid; grid-template-columns: 40px minmax(0, 1fr) 24px; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; color: var(--app-text); background: transparent; text-align: left; font: inherit; cursor: pointer; }
.bitwarden-folder-row:hover, .bitwarden-folder-row.selected { background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.bitwarden-folder-row:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-primary) 45%, transparent); outline-offset: -3px; }
.bitwarden-folder-copy strong { overflow-wrap: anywhere; }
.bitwarden-folder-detail { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: grid; gap: 12px; padding: 12px 16px; background: var(--md-sys-color-surface-container-low, var(--app-surface)); }
.bitwarden-folder-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.bitwarden-folder-delete-action, .bitwarden-folder-confirm-delete { color: var(--md-sys-color-error, var(--app-primary)); }
.bitwarden-folder-action-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 12px; }
.bitwarden-folder-delete-confirmation { border: 1px solid var(--md-sys-color-error, var(--app-primary)); border-radius: 8px; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.bitwarden-folders-empty { min-height: 104px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); text-align: center; }
.bitwarden-folders-more { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); display: flex; justify-content: center; padding: 4px 12px; }
.bitwarden-folder-move-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: end; gap: 12px; padding: 0 16px 16px; }
.bitwarden-folders-dialog > footer { min-height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 12px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 700px) {
  .bitwarden-folders-backdrop { align-items: center; padding: 8px; }
  .bitwarden-folders-dialog { max-height: calc(100dvh - 16px); border-radius: 16px; padding: 16px; }
  .bitwarden-folders-toolbar { align-items: stretch; flex-direction: column; }
  .bitwarden-folders-toolbar > m3e-button { width: 100%; }
  .bitwarden-folder-create, .bitwarden-folder-action-form, .bitwarden-folder-delete-confirmation, .bitwarden-folder-move-form { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
  .bitwarden-folder-create > span, .bitwarden-folder-create > div, .bitwarden-folder-action-form > div, .bitwarden-folder-delete-confirmation > div, .bitwarden-folder-move-form > m3e-button { grid-column: 1 / -1; }
  .bitwarden-folder-delete-confirmation > div, .bitwarden-folder-actions { flex-direction: column; align-items: stretch; }
  .bitwarden-folders-dialog > footer { align-items: stretch; flex-direction: column; }
}
@media (max-width: 420px) {
  .bitwarden-folders-dialog { padding: 12px; }
  .bitwarden-folder-row, .bitwarden-folders-list-heading, .bitwarden-folder-detail { padding-inline: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .bitwarden-folders-dialog * { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
</style>
