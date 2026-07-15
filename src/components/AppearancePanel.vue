<script setup lang="ts">
import { paletteId, palettes, schemePreference, setPalette, setScheme, type SchemePreference, type ThemePaletteId } from "../lib/theme";

const schemes: SchemePreference[] = ["auto", "light", "dark"];
const schemeLabels: Record<SchemePreference, string> = { auto: "跟随系统", light: "浅色", dark: "深色" };
const paletteLabels: Record<ThemePaletteId, string> = { monica: "Monica", ocean: "海洋", forest: "森林", sakura: "樱花", amber: "琥珀" };

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
      <h2>外观</h2>
      <label class="field">
        <span>显示模式</span>
        <select :value="schemePreference" @change="updateScheme">
          <option v-for="item in schemes" :key="item" :value="item">{{ schemeLabels[item] }}</option>
        </select>
      </label>
      <div class="field">
        <span>配色</span>
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
            {{ paletteLabels[item.id] }}
          </button>
        </div>
      </div>
    </div>
  </m3e-card>
</template>
