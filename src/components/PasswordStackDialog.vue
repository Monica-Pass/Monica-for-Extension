<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { tr } from "../i18n";
import type { LoginItem } from "../core/model";
import { passwordDisplaySourceKey } from "../core/password-display-stacks";
import { passwordProjectStackSetting, type PasswordStackAction } from "../core/password-manual-stacks";
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import { vaultClient } from "../runtime/client";

const props = defineProps<{ projects: LoginItem[][]; sourceLabel: (item: LoginItem) => string }>();
const emit = defineEmits<{ close: []; saved: [action: PasswordStackAction] }>();
// Capture the displayed revisions once; concurrent edits require reopening the dialog.
const choices = props.projects.filter(project => project.length).map(project => ({
  id: project[0].id, title: project[0].title, username: project[0].username,
  source: passwordDisplaySourceKey(project[0]), sourceLabel: props.sourceLabel(project[0]),
  setting: passwordProjectStackSetting(project).kind,
  members: project.map(item => ({ id: item.id, updatedAt: item.updatedAt })),
}));
const action = ref<PasswordStackAction>("stack"), selected = ref<string[]>([]), query = ref("");
const busy = ref(false), error = ref("");
let alive = true;
onBeforeUnmount(() => { alive = false; });
const selectedChoices = computed(() => choices.filter(choice => selected.value.includes(choice.id)));
const visible = computed(() => choices.filter(choice => `${choice.title}\n${choice.username}\n${choice.sourceLabel}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const mixedSources = computed(() => action.value === "stack" && new Set(selectedChoices.value.map(choice => choice.source)).size > 1);
const canSave = computed(() => !busy.value && !mixedSources.value && selected.value.length >= (action.value === "stack" ? 2 : 1));
const settingLabel = (kind: string) => tr(({ auto: "自动堆叠", manual: "手动堆叠", never: "永不堆叠", invalid: "内部字段格式不受支持" } as Record<string, string>)[kind]);
function toggle(id: string, checked: boolean) {
  selected.value = checked ? [...new Set([...selected.value, id])] : selected.value.filter(value => value !== id);
  error.value = "";
}
async function save() {
  if (!canSave.value) return;
  busy.value = true; error.value = "";
  const savedAction = action.value;
  try {
    const expected = Object.fromEntries(selectedChoices.value.flatMap(choice => choice.members.map(item => [item.id, item.updatedAt])));
    await vaultClient.setPasswordStack([...selected.value], savedAction, expected);
    if (alive) emit("saved", savedAction);
  } catch (cause) { if (alive) error.value = cause instanceof Error ? tr(cause.message) : String(cause); }
  finally { if (alive) busy.value = false; }
}
</script>
<template>
  <m3e-dialog v-material-dialog open class="material-dialog manual-stack-dialog" :disableClose.prop="busy" :dismissible="!busy" :close-label="tr('关闭')" @closed.self="emit('close')">
    <h2 slot="header">{{ tr('管理密码堆叠') }}</h2>
    <p class="stack-help">{{ tr('选择完整项目，调整列表中的堆叠方式。项目内的密码和内容保持不变。') }}</p>
    <m3e-form-field v-field-label variant="filled" hide-required-marker>
      <label slot="label">{{ tr('堆叠操作') }}</label>
      <component :is="materialSelectTag" :disabled="busy" @input="action = ($event.target as HTMLElement &amp; {value: PasswordStackAction}).value">
        <component :is="materialOptionTag" value="stack" :selected.prop="action === 'stack'">{{ tr('合并为手动堆叠') }}</component>
        <component :is="materialOptionTag" value="never" :selected.prop="action === 'never'">{{ tr('永不堆叠') }}</component>
        <component :is="materialOptionTag" value="auto" :selected.prop="action === 'auto'">{{ tr('恢复自动堆叠') }}</component>
      </component>
    </m3e-form-field>
    <m3e-form-field v-field-label variant="filled" hide-required-marker class="stack-search">
      <m3e-icon slot="leading-icon" name="search" /><label slot="label">{{ tr('搜索项目') }}</label>
      <input v-model="query" type="search" :disabled="busy" autocomplete="off" />
    </m3e-form-field>
    <fieldset class="stack-choices" :disabled="busy">
      <legend class="visually-hidden">{{ tr('选择密码项目') }}</legend>
      <label v-for="choice in visible" :key="choice.id" :data-stack-choice="choice.id" class="stack-choice">
        <input type="checkbox" :checked="selected.includes(choice.id)" :disabled="choice.setting === 'invalid'" :aria-label="tr('选择 {0}', {0: choice.title})" @change="toggle(choice.id, ($event.target as HTMLInputElement).checked)" />
        <span><strong>{{ choice.title }}</strong><small>{{ choice.username || tr('未填写用户名') }} · {{ tr('{0} 条密码', {0: choice.members.length}) }}</small><small>{{ choice.sourceLabel }} · {{ settingLabel(choice.setting) }}</small></span>
      </label>
    </fieldset>
    <p v-if="!visible.length" class="stack-help">{{ tr('没有匹配项目') }}</p>
    <p class="stack-help" aria-live="polite">{{ tr('已选择 {0} 个项目', {0: selected.length}) }}</p>
    <p v-if="mixedSources" class="form-error" role="alert">{{ tr('请在同一个密码源内创建手动堆叠。') }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <footer slot="actions" end>
      <m3e-button variant="text" :disabled="busy" @click="emit('close')">{{ tr('取消') }}</m3e-button>
      <m3e-button variant="filled" :disabled="!canSave" @click="save">{{ busy ? tr('保存中…') : tr('应用到 {0} 个项目', {0: selected.length}) }}</m3e-button>
    </footer>
  </m3e-dialog>
</template>
<style scoped>
.manual-stack-dialog { --m3e-dialog-min-width: min(560px, calc(100vw - 24px)); }
m3e-form-field { display: block; width: 100%; min-width: 0; }.stack-search { margin-block: 12px; }
.stack-help { color: var(--app-muted); line-height: 1.5; overflow-wrap: anywhere; }
.stack-choices { display: grid; gap: 4px; border: 0; margin: 0; padding: 0; min-width: 0; }
.stack-choice { display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--app-bg); border-radius: 4px; min-width: 0; cursor: pointer; }
.stack-choice:first-of-type { border-radius: 20px 20px 4px 4px; }.stack-choice:last-of-type { border-radius: 4px 4px 20px 20px; }.stack-choice:only-of-type { border-radius: 20px; }
.stack-choice:has(:checked) { background: var(--app-selected); }.stack-choice:has(:disabled) { cursor: default; }
.stack-choice input { flex: 0 0 20px; width: 20px; height: 20px; margin: 0; accent-color: var(--app-primary); }
.stack-choice input:focus-visible { outline: 2px solid var(--app-primary); outline-offset: 4px; }
.stack-choice span { display: grid; gap: 3px; min-width: 0; }.stack-choice strong { font-weight: 500; }.stack-choice small { color: var(--app-muted); }
.stack-choice strong, .stack-choice small { overflow-wrap: anywhere; }
footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
</style>
