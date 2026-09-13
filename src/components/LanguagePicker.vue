<script setup lang="ts">
import { ref } from "vue";
import { localeOptions, localePreference, setLocale, tr, type LocalePreference } from "../i18n";

const busy = ref(false);
const error = ref(false);
async function change(event: Event) {
  busy.value = true;
  error.value = false;
  try { await setLocale((event.target as HTMLSelectElement).value as LocalePreference); }
  catch { error.value = true; }
  finally {
    (event.target as HTMLSelectElement).value = localePreference.value;
    busy.value = false;
  }
}
</script>

<template>
  <label class="language-picker">
    <span>{{ tr('语言') }}</span>
    <select :value="localePreference" :aria-label="tr('界面语言')" :aria-busy="busy" :disabled="busy" @change="change">
      <option value="system">{{ tr('跟随浏览器') }}</option>
      <option v-for="option in localeOptions" :key="option.value" :value="option.value" :lang="option.value">{{ option.label }}</option>
    </select>
    <small v-if="error" class="language-error" role="status">{{ tr('无法加载所选语言，请重试。') }}</small>
  </label>
</template>
