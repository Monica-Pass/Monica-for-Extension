<script setup lang="ts">
import { materialSelectTag, materialOptionTag, restoreMaterialSelection } from "../lib/material-controls";
import { ref } from "vue";
import { localeOptions, localePreference, setLocale, tr, type LocalePreference } from "../i18n";

defineProps<{ label?: string }>();

const busy = ref(false);
const error = ref(false);
async function change(event: Event) {
  busy.value = true;
  error.value = false;
  try { await setLocale((event.target as HTMLSelectElement).value as LocalePreference); }
  catch { error.value = true; }
  finally {
    restoreMaterialSelection(event.target as HTMLElement, localePreference.value);
    busy.value = false;
  }
}
</script>

<template>
  <m3e-form-field v-field-label variant="filled" hide-required-marker hide-subscript="never" class="language-picker">
    <label slot="label">{{ label || tr('语言') }}</label>
    <component :is="materialSelectTag"  :aria-label="tr('界面语言')" :aria-busy="busy" :disabled="busy" @change="change">
      <component :is="materialOptionTag" :selected.prop="String(localePreference ?? '') === String('system')" value="system">{{ tr('跟随浏览器') }}</component>
      <component :is="materialOptionTag" :selected.prop="String(localePreference ?? '') === String(option.value)" v-for="option in localeOptions" :key="option.value" :value="option.value" :lang="option.value">{{ option.label }}</component>
    </component>
    <small slot="hint" v-if="error" class="language-error" role="status">{{ tr('无法加载所选语言，请重试。') }}</small>
  </m3e-form-field>
</template>
