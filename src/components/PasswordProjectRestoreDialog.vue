<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { LoginItem } from '../core/model';
import { passwordProjectGroups } from '../core/password-project-view';
import { projectRestoreRequest, saveProjectRestore } from '../manager/project-restore';
import { vaultClient } from '../runtime/client';
import { tr } from '../i18n';

const props = defineProps<{ items: LoginItem[]; anchorItemId: string; sourceName: string; keepassProject?: LoginItem[] }>();
const emit = defineEmits<{ close: []; completed: []; changed: []; pending: [] }>();
const request = props.keepassProject ? projectRestoreRequest(props.items, props.anchorItemId, true, props.keepassProject)
  : projectRestoreRequest(props.items, props.anchorItemId);
const busy = ref(false), error = ref(''), attempted = ref(false), unstaged = ref(false);
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
const groups = computed(() => passwordProjectGroups(props.items));
async function restore() {
  if (busy.value) return;
  busy.value = true; error.value = ''; attempted.value = true;
  try {
    const result = await saveProjectRestore(vaultClient, request);
    if (disposed) return;
    if (result.status === 'completed') emit('completed');
    else error.value = tr('操作尚未完成，可以继续重试。');
  } catch (cause) {
    if (disposed) return;
    error.value = cause instanceof Error ? tr(cause.message) : tr('恢复失败，请重试。');
    unstaged.value = (cause as { code?: string })?.code === 'password-project-restore-not-staged';
  } finally { if (!disposed) { busy.value = false; emit('changed'); } }
}
</script>
<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="!busy && emit('close')">
    <section class="editor-dialog project-restore-dialog" role="dialog" aria-modal="true" aria-labelledby="project-restore-title" :aria-busy="busy" data-project-restore-dialog>
      <header><h2 id="project-restore-title">{{ tr('恢复整个密码项目') }}</h2><m3e-icon-button data-dialog-close :aria-label="tr('关闭确认对话框')" :disabled="busy" @click="emit('close')"><m3e-icon name="close" /></m3e-icon-button></header>
      <div class="restore-project-row"><m3e-icon name="key" /><div><strong>{{ items[0].title }}</strong><small>{{ sourceName }}</small></div></div>
      <p>{{ tr(keepassProject ? '恢复此项目回收站中的 {0} 个密码。' : '恢复本次删除的 {0} 个密码。', {0: items.length}) }}</p>
      <div class="restore-members" data-restore-members>
        <div v-for="(group, index) in groups || []" :key="group.id" class="restore-project-row"><m3e-icon name="person" /><div><strong>{{ group.label || tr('凭据组 {0}', {0: index + 1}) }}</strong><small>{{ tr('{0} 个密码', {0: group.rows.length}) }}</small></div></div>
        <div v-if="!groups" class="restore-project-row"><m3e-icon name="password" /><span>{{ tr('{0} 个密码', {0: items.length}) }}</span></div>
      </div>
      <p class="restore-explanation">{{ tr(keepassProject ? '包含此项目较早删除的成员。原始内容、分组和附件会保留；确认后加入同步队列。' : '原始内容、分组和附件会保留；较早删除的成员不包含在本次恢复中。') }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="busy" role="status">{{ tr('正在核对操作结果…') }}</p>
      <m3e-button v-if="error" variant="text" :disabled="busy" data-restore-pending @click="emit('pending')">{{ unstaged || keepassProject ? tr('打开密码源') : tr('查看待处理操作') }}</m3e-button>
      <footer><m3e-button variant="text" data-dialog-close autofocus :disabled="busy" @click="emit('close')">{{ attempted ? tr('关闭') : tr('取消') }}</m3e-button><m3e-button variant="filled" :disabled="busy" data-confirm-project-restore @click="restore">{{ busy ? tr('正在处理…') : attempted ? tr('重试这次恢复') : tr('确认整组恢复') }}</m3e-button></footer>
    </section>
  </div>
</template>
<style scoped>
.project-restore-dialog { width: min(100%, 520px); display: grid; gap: 20px; }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
header h2 { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.restore-members { display: grid; gap: 4px; }
.restore-project-row { display: flex; align-items: center; gap: 16px; min-height: 64px; padding: 16px; box-sizing: border-box; border-radius: 24px; background: var(--md-sys-color-surface-container-low); min-width: 0; }
.restore-members .restore-project-row { border-radius: 4px; }
.restore-members .restore-project-row:first-child { border-radius: 24px 24px 4px 4px; }
.restore-members .restore-project-row:last-child { border-radius: 4px 4px 24px 24px; }
.restore-members .restore-project-row:only-child { border-radius: 24px; }
.restore-project-row > div { display: grid; gap: 4px; min-width: 0; }
.restore-project-row m3e-icon { color: var(--md-sys-color-primary); flex-shrink: 0; }
strong, small, p { overflow-wrap: anywhere; margin: 0; }
small, .restore-explanation { color: var(--md-sys-color-on-surface-variant); }
.form-error { white-space: pre-wrap; }
.project-restore-dialog m3e-button, .project-restore-dialog m3e-icon-button { min-height: 48px; }
footer { justify-content: flex-end; }
@media (max-width: 600px) { footer { flex-direction: column-reverse; align-items: stretch; } footer m3e-button { width: 100%; } }
</style>
