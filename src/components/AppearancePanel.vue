<script setup lang="ts">
import { languageLabel, locales, setLocale, t, locale, type Locale } from "../i18n";
import { paletteId, palettes, schemePreference, setPalette, setScheme, type SchemePreference, type ThemePaletteId } from "../lib/theme";

const schemes: SchemePreference[] = ["auto", "light", "dark"];

function updateLocale(event: Event) {
  setLocale((event.target as HTMLSelectElement).value as Locale);
}

function updateScheme(event: Event) {
  setScheme((event.target as HTMLSelectElement).value as SchemePreference);
}

function updatePalette(value: ThemePaletteId) {
  setPalette(value);
}
</script>

<template>
  <m3e-card variant="filled">
    <div slot="content" class="stack">
      <h2>{{ t("settings.appearance") }}</h2>
      <label class="field">
        <span>{{ t("prefs.language") }}</span>
        <select :value="locale" @change="updateLocale">
          <option v-for="item in locales" :key="item" :value="item">{{ languageLabel[item] }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ t("prefs.scheme") }}</span>
        <select :value="schemePreference" @change="updateScheme">
          <option v-for="item in schemes" :key="item" :value="item">{{ t(`scheme.${item}`) }}</option>
        </select>
      </label>
      <div class="field">
        <span>{{ t("prefs.palette") }}</span>
        <div class="palette-grid">
          <button
            v-for="item in palettes"
            :key="item.id"
            class="palette-button"
            :class="{ selected: item.id === paletteId }"
            type="button"
            @click="updatePalette(item.id)"
          >
            <span class="swatch" :style="{ '--swatch': item.color, '--accent': item.accent }"></span>
            {{ t(`palettes.${item.id}`) }}
          </button>
        </div>
      </div>
    </div>
  </m3e-card>
</template>
