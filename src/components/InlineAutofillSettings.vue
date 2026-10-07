<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { tr } from "../i18n";
import { INLINE_AUTOFILL_ENABLED_KEY, inlineAutofillEnabled, readInlineAutofillEnabled, setInlineAutofillEnabled } from "../autofill/inline-preferences";

const enabled = ref(true);
const ready = ref(false);
const saving = ref(false);
const error = ref(false);
const saved = ref(false);
let revision = 0;
function changed(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== "local" || !changes[INLINE_AUTOFILL_ENABLED_KEY]) return;
  revision++;
  enabled.value = inlineAutofillEnabled(changes[INLINE_AUTOFILL_ENABLED_KEY].newValue);
}
onMounted(async () => {
  chrome.storage.onChanged.addListener(changed);
  const current = revision;
  try {
    const value = await readInlineAutofillEnabled();
    if (current === revision) enabled.value = value;
    ready.value = true;
  } catch { error.value = true; }
});
onUnmounted(() => chrome.storage.onChanged.removeListener(changed));
async function toggle() {
  if (!ready.value || saving.value) return;
  const next = !enabled.value;
  saving.value = true;
  error.value = false;
  saved.value = false;
  try {
    await setInlineAutofillEnabled(next);
    enabled.value = next;
    saved.value = true;
  } catch { error.value = true; }
  finally { saving.value = false; }
}
</script>

<template>
  <section class="inline-autofill-setting" aria-labelledby="inline-autofill-label">
    <div class="inline-autofill-setting-row">
      <div><strong id="inline-autofill-label">{{ tr('表单旁自动填充') }}</strong><p id="inline-autofill-description">{{ tr('聚焦登录表单时，在输入框旁显示匹配的登录项。') }}</p></div>
      <m3e-switch :checked.prop="enabled" @beforeinput.prevent="toggle" aria-labelledby="inline-autofill-label" aria-describedby="inline-autofill-description" :disabled="!ready" :aria-busy="saving"></m3e-switch>
    </div>
    <small>{{ tr('关闭后仍可从工具栏插件填写。') }}</small>
    <p v-if="error" class="form-error" role="alert">{{ tr('未能保存自动填充设置，请重试。') }}</p>
    <p v-else-if="saved" class="inline-autofill-saved" role="status">{{ tr('已保存') }}</p>
  </section>
</template>

<style scoped>
.inline-autofill-setting { padding: 16px; border-bottom: 1px solid var(--app-outline); }
.inline-autofill-setting-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; }
.inline-autofill-setting strong { font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
.inline-autofill-setting p { margin: 6px 0; font-size: .875rem; line-height: 1.6; overflow-wrap: anywhere; }
.inline-autofill-setting p:not(.form-error), .inline-autofill-setting small { color: var(--app-muted); }
.inline-autofill-setting small { display: block; font-size: .75rem; line-height: 1.6; margin-top: 8px; overflow-wrap: anywhere; }
</style>
