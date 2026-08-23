<script setup lang="ts">
import { ref } from "vue";
import { paletteId, palettes, schemePreference, setPalette, setScheme, type SchemePreference, type ThemePaletteId } from "../lib/theme";

const schemes: SchemePreference[] = ["auto", "light", "dark"];
const schemeLabels: Record<SchemePreference, string> = { auto: "跟随系统", light: "浅色", dark: "深色" };
const paletteLabels: Record<ThemePaletteId, string> = { monica: "Monica", ocean: "海洋", forest: "森林", sakura: "樱花", amber: "琥珀" };
const dialogOpen = ref(false);

function updatePalette(value: ThemePaletteId) {
  setPalette(value);
}
</script>

<template>
  <m3e-card variant="filled" class="appearance-card">
    <div slot="content" class="appearance-disclosure">
      <button class="appearance-trigger" type="button" @click="dialogOpen = true">
        <span class="appearance-summary-icon"><m3e-icon name="palette"></m3e-icon></span>
        <span class="appearance-summary-copy"><strong>外观</strong><small>{{ schemeLabels[schemePreference] }} · {{ paletteLabels[paletteId] }}</small></span>
        <m3e-icon class="appearance-chevron" name="chevron_right" aria-hidden="true"></m3e-icon>
      </button>
      <Teleport to="body">
      <div v-if="dialogOpen" class="appearance-modal" role="presentation" @click.self="dialogOpen = false">
      <section class="appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="appearance-dialog-title">
        <div class="appearance-dialog-header">
          <div><h2 id="appearance-dialog-title">外观</h2><p>为 Monica 选择显示模式和配色方案。</p></div>
          <button class="appearance-close" type="button" aria-label="关闭外观设置" @click="dialogOpen = false"><m3e-icon name="close"></m3e-icon></button>
        </div>
        <div class="appearance-controls">
        <fieldset>
          <legend>显示模式</legend>
          <div class="scheme-control" role="group" aria-label="显示模式">
            <button v-for="item in schemes" :key="item" type="button" :class="{ selected: item === schemePreference }" :aria-pressed="item === schemePreference" @click="setScheme(item)">{{ schemeLabels[item] }}</button>
          </div>
        </fieldset>
        <fieldset>
          <legend>配色</legend>
          <div class="palette-list">
          <button
            v-for="item in palettes"
            :key="item.id"
            class="palette-button"
            :class="{ selected: item.id === paletteId }"
            type="button"
            :aria-pressed="item.id === paletteId"
            @click="updatePalette(item.id)"
          >
            <span class="swatch" :style="{ '--swatch': item.color, '--secondary': item.darkColor, '--accent': item.accent }" aria-hidden="true">
              <span></span><span></span><span></span>
            </span>
            <span class="palette-label">{{ paletteLabels[item.id] }}</span>
          </button>
        </div>
        </fieldset>
      </div>
      </section>
      </div>
      </Teleport>
    </div>
  </m3e-card>
</template>

<style scoped>
.appearance-card { --m3e-card-padding: 0; }
.appearance-disclosure { min-width: 0; }
.appearance-trigger { width: 100%; min-height: 72px; display: grid; grid-template-columns: 40px minmax(0, 1fr) 24px; align-items: center; gap: 12px; border: 0; padding: 8px 16px; color: inherit; background: transparent; text-align: left; font: inherit; cursor: pointer; }
.appearance-trigger:hover { background: color-mix(in srgb, var(--md-sys-color-secondary-container, var(--app-selected)) 28%, transparent); }
.appearance-trigger:focus-visible { outline: 3px solid var(--md-sys-color-primary, var(--app-primary)); outline-offset: -3px; }
.appearance-summary-icon { width: 40px; height: 40px; border-radius: 8px; display: grid; place-items: center; color: var(--md-sys-color-on-primary-container, var(--app-text)); background: var(--md-sys-color-primary-container, var(--app-selected)); }
.appearance-summary-icon m3e-icon, .appearance-chevron { --m3e-icon-size: 20px; }
.appearance-summary-copy { min-width: 0; display: grid; gap: 2px; }
.appearance-summary-copy strong, .appearance-summary-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.appearance-summary-copy strong { font-size: 1rem; }
.appearance-summary-copy small { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); font-size: .82rem; }
.appearance-chevron { --m3e-icon-size: 20px; }
.appearance-controls { display: grid; gap: 16px; border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); padding: 16px; }
.appearance-controls fieldset { min-width: 0; margin: 0; border: 0; padding: 0; }
.appearance-controls legend { margin-bottom: 8px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); font-size: .82rem; font-weight: 600; }
.scheme-control { min-height: 44px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 8px; overflow: hidden; }
.scheme-control button { min-width: 0; min-height: 44px; border: 0; border-right: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); padding: 0 8px; color: var(--md-sys-color-on-surface, var(--app-text)); background: transparent; font: inherit; cursor: pointer; }
.scheme-control button:last-child { border-right: 0; }
.scheme-control button.selected { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); font-weight: 600; }
.palette-list { display: grid; gap: 8px; }
.palette-button { width: 100%; min-width: 0; min-height: 56px; grid-template-columns: 32px minmax(0, 1fr) 24px; padding: 0 12px; text-align: left; }
.palette-button::after { content: ""; width: 20px; height: 20px; border: 2px solid var(--md-sys-color-outline, var(--app-outline)); border-radius: 50%; }
.palette-button.selected::after { border: 6px solid var(--md-sys-color-primary, var(--app-primary)); }
.palette-label { overflow: visible; text-overflow: clip; white-space: nowrap; }
.swatch { width: 24px; height: 24px; border-radius: 50%; display: flex; flex: 0 0 24px; overflow: hidden; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-text) 20%, transparent); }
.swatch > span { flex: 1 1 33.333%; height: 100%; }
.swatch > span:first-child { background: var(--swatch); }
.swatch > span:nth-child(2) { background: var(--secondary); }
.swatch > span:last-child { background: var(--accent); }
.palette-button > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette-button:hover { transform: none; }
.appearance-modal { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 16px; background: rgb(0 0 0 / 48%); }
.appearance-dialog { width: min(520px, 100%); max-height: calc(100vh - 32px); overflow: auto; border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 16px; padding: 0; color: var(--md-sys-color-on-surface, var(--app-text)); background: var(--md-sys-color-surface-container, var(--app-surface)); box-shadow: 0 24px 48px rgb(0 0 0 / 32%); }
.appearance-dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 20px 12px; }
.appearance-dialog-header h2, .appearance-dialog-header p { margin: 0; }
.appearance-dialog-header h2 { font-size: 1.25rem; }
.appearance-dialog-header p { margin-top: 4px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); font-size: .9rem; }
.appearance-close { width: 44px; height: 44px; display: grid; place-items: center; border: 0; border-radius: 50%; color: inherit; background: transparent; cursor: pointer; }
.appearance-close:hover { background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.appearance-close m3e-icon { --m3e-icon-size: 20px; }
@media (prefers-reduced-motion: reduce) { .appearance-dialog { scroll-behavior: auto; } }
</style>
