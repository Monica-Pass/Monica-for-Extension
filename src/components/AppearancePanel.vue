<script setup lang="ts">
import { tr } from '../i18n';
import { paletteId, palettes, schemePreference, setPalette, setScheme, type SchemePreference, type ThemePaletteId } from '../lib/theme';

const schemes: SchemePreference[] = ['auto', 'light', 'dark'];
const schemeLabels: Record<SchemePreference, string> = { get auto() { return tr('跟随系统'); }, get light() { return tr('浅色'); }, get dark() { return tr('深色'); } };
const paletteLabels: Record<ThemePaletteId, string> = { nothing: 'Nothing', monica: 'Monica', get ocean() { return tr('海洋'); }, get forest() { return tr('森林'); }, get sakura() { return tr('樱花'); }, get amber() { return tr('琥珀'); } };
</script>

<template>
  <m3e-card variant="filled" class="appearance-card">
    <div slot="content">
      <m3e-action-list>
        <m3e-list-action class="appearance-trigger">
          <m3e-dialog-trigger for="appearance-dialog" />
          <span slot="leading" class="appearance-summary-icon"><m3e-icon name="palette" /></span>
          {{ tr('外观') }}
          <span slot="supporting-text">{{ schemeLabels[schemePreference] }} · {{ paletteLabels[paletteId] }}</span>
          <m3e-icon slot="trailing" name="chevron_right" aria-hidden="true" />
        </m3e-list-action>
      </m3e-action-list>
      <m3e-dialog v-material-dialog id="appearance-dialog" class="appearance-dialog" dismissible :close-label="tr('关闭外观设置')">
        <span slot="header">{{ tr('外观') }}</span>
        <p class="appearance-description">{{ tr('为 Monica 选择显示模式和配色方案。') }}</p>
        <div class="appearance-controls">
          <section aria-labelledby="appearance-scheme-label">
            <h3 id="appearance-scheme-label">{{ tr('显示模式') }}</h3>
            <m3e-segmented-button class="scheme-control" aria-labelledby="appearance-scheme-label">
              <m3e-button-segment v-for="item in schemes" :key="item" :value="item" :checked.prop="item === schemePreference" :autofocus.prop="item === schemePreference" @input="setScheme(item)">{{ schemeLabels[item] }}</m3e-button-segment>
            </m3e-segmented-button>
          </section>
          <section aria-labelledby="appearance-palette-label">
            <h3 id="appearance-palette-label">{{ tr('配色') }}</h3>
            <m3e-radio-group class="palette-list" aria-labelledby="appearance-palette-label">
              <label v-choice-label v-for="item in palettes" :key="item.id" class="palette-option" :class="{ selected: item.id === paletteId }">
                <span class="swatch" :style="{ '--swatch': item.color, '--secondary': item.darkColor, '--accent': item.accent }" aria-hidden="true"><span /><span /><span /></span>
                <span class="palette-label">{{ paletteLabels[item.id] }}</span>
                <m3e-radio :value="item.id" :checked.prop="item.id === paletteId" @input="setPalette(item.id)" />
              </label>
            </m3e-radio-group>
          </section>
        </div>
      </m3e-dialog>
    </div>
  </m3e-card>
</template>

<style scoped>
.appearance-card { --m3e-card-padding: 0; }
.appearance-summary-icon { width: 48px; height: 48px; border-radius: 16px; display: grid; place-items: center; color: var(--md-sys-color-on-primary-container); background: var(--md-sys-color-primary-container); }
.appearance-dialog { --m3e-dialog-min-width: min(480px, calc(100vw - 32px)); --m3e-dialog-max-width: min(520px, calc(100vw - 32px)); }
.appearance-description { margin: 0 0 24px; color: var(--md-sys-color-on-surface-variant); }
.appearance-controls { display: grid; gap: 24px; }
.appearance-controls section { min-width: 0; }
.appearance-controls h3 { margin: 0 0 12px; font-size: .875rem; font-weight: 500; color: var(--md-sys-color-on-surface-variant); }
.scheme-control { width: 100%; }
.scheme-control m3e-button-segment { flex: 1; min-width: 0; }
.palette-list { display: grid; gap: 4px; }
.palette-option { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 56px; padding: 4px 12px; border-radius: 16px; cursor: pointer; }
.palette-option.selected { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.palette-label { overflow-wrap: anywhere; }
.swatch { width: 28px; height: 28px; border-radius: 50%; display: flex; overflow: hidden; }
.swatch > span { flex: 1; height: 100%; }
.swatch > span:first-child { background: var(--swatch); }
.swatch > span:nth-child(2) { background: var(--secondary); }
.swatch > span:last-child { background: var(--accent); }
</style>
