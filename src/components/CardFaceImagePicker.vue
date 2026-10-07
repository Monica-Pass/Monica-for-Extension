<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { ProviderAccount, VaultItem } from "../core/model";
import type { ProviderAttachmentSummary } from "../providers/attachments/attachment-contract";
import { materialOptionTag, materialSelectTag } from "../lib/material-controls";
import { cardFaceImageOptions } from "../manager/card-face-images";
import { vaultClient } from "../runtime/client";
import { tr } from "../i18n";
import ProviderAttachmentsDialog from "./ProviderAttachmentsDialog.vue";

const props = defineProps<{ owner?: VaultItem; providers: ProviderAccount[]; modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [name: string] }>();
// Card-face references are scoped to the same provider used by artwork reads.
const provider = computed(() => props.providers.find(p => p.id === props.owner?.providerRefs[0]?.providerId && ["mdbx2", "keepass", "bitwarden", "monica-webdav"].includes(p.kind)));
const options = ref<string[]>([]), busy = ref(false), error = ref(""), managerOpen = ref(false);
const managerButton = ref<HTMLElement>();
let generation = 0;
async function reload() {
  const current = ++generation; options.value = []; error.value = ""; busy.value = false;
  const owner = props.owner, source = provider.value;
  if (!owner || !source) return;
  busy.value = true;
  try {
    const attachments: ProviderAttachmentSummary[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursors.size >= 200 || cursor && cursors.has(cursor)) throw new Error("附件分页异常，未打开。");
      if (cursor) cursors.add(cursor);
      const page = await vaultClient.listProviderAttachments(source.id, owner.id, { pageSize: 50, cursor });
      if (current !== generation) return;
      attachments.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    options.value = cardFaceImageOptions(attachments);
  } catch (cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : tr('附件读取失败。'); }
  finally { if (current === generation) busy.value = false; }
}
watch(() => [props.owner?.id, props.owner?.updatedAt, provider.value?.id], () => { managerOpen.value = false; void reload(); }, { immediate: true });
onBeforeUnmount(() => { generation++; });
function closeManager() { managerOpen.value = false; void reload(); void nextTick(() => managerButton.value?.focus()); }
</script>

<template>
  <div class="card-face-picker">
    <m3e-form-field v-field-label variant="filled">
      <label slot="label">{{ tr('卡面图片') }}</label>
      <component :is="materialSelectTag" :disabled="busy" @input="emit('update:modelValue', ($event.target as HTMLElement & { value: string }).value)">
        <component :is="materialOptionTag" value="" :selected.prop="!modelValue">{{ tr('不使用图片') }}</component>
        <component v-if="modelValue && !options.includes(modelValue)" :is="materialOptionTag" :value="modelValue" :selected.prop="true">{{ modelValue }}</component>
        <component v-for="name in options" :key="name" :is="materialOptionTag" :value="name" :selected.prop="modelValue === name">{{ name }}</component>
      </component>
    </m3e-form-field>
    <p v-if="busy" role="status">{{ tr('正在读取图片列表…') }}</p>
    <p v-else-if="modelValue && !options.includes(modelValue)" role="status">{{ tr('当前图片尚不可用，已保留原有选择。') }}</p>
    <p v-if="error" role="alert">{{ tr(error) }}</p>
    <div v-if="owner && provider" class="card-face-picker-actions">
      <m3e-button ref="managerButton" type="button" variant="tonal" @click="managerOpen = true"><m3e-icon slot="icon" name="image"/>{{ tr('管理图片附件') }}</m3e-button>
      <m3e-button type="button" variant="text" :disabled="busy" @click="reload">{{ tr('刷新') }}</m3e-button>
    </div>
    <p v-else>{{ tr('先保存项目，再添加卡面图片。') }}</p>
    <ProviderAttachmentsDialog v-if="managerOpen && owner && provider" :item="owner" :providers="[provider]" @close="closeManager" />
  </div>
</template>

<style scoped>
.card-face-picker{display:grid;gap:12px;min-width:0}.card-face-picker-actions{display:flex;gap:8px;flex-wrap:wrap}.card-face-picker p{margin:0;color:var(--app-muted);font-size:.8125rem;line-height:1.5;overflow-wrap:anywhere}
</style>
