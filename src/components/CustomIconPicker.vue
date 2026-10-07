<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import { tr } from '../i18n';
import { brandIcons, brandIconPath, normalizeEmojiIcon, quickEmojiIcons } from '../core/custom-icon';
import type { LoginForm } from '../manager/login-form';
import WebsiteIcon from './WebsiteIcon.vue';
import { activeScheme } from '../lib/theme';
import { bitmapIconDataUrl, KEEPASS_CUSTOM_ICON_TYPE } from '../core/bitmap-icon';
import { uploadedKeePassIcon } from '../manager/keepass-icon-image';
const props = defineProps<{form:LoginForm;keepass?:boolean}>();
let selection = 0;
onBeforeUnmount(() => { selection++; props.form.iconBusy = false; });
const imageInput = ref<HTMLInputElement>();
const open = ref(false), mode = ref<'library'|'emoji'>('library'), query = ref(''), emojiInput = ref(''), error = ref('');
const limit = ref(48);
const choices = computed(() => brandIcons.filter(icon => `${icon.slug} ${icon.label}`.includes(query.value.trim().toLowerCase())));
const iconItem = computed(() => ({kind:'login' as const,customIconType:props.form.customIconType,customIconValue:props.form.customIconValue}));
const current = computed(() => props.form.customIconType === KEEPASS_CUSTOM_ICON_TYPE && bitmapIconDataUrl(props.form.customIconValue) ? tr('数据库图标') : props.form.customIconType === 'EMOJI' ? props.form.customIconValue : props.form.customIconType === 'SIMPLE_ICON' ? props.form.customIconValue : props.form.customIconType && props.form.customIconType !== 'NONE' ? tr('当前图标不可预览，保存时保留') : tr('跟随网站'));
function choose(type:string,value?:string) { selection++; props.form.iconBusy=false; props.form.customIconType=type; props.form.customIconValue=value; error.value=''; }
async function selectImage(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (!file) return;
  const request = ++selection, provider = props.form.providerId, name = props.form.name;
  props.form.iconBusy = true; error.value = '';
  try {
    const value = await uploadedKeePassIcon(file);
    if (request === selection && provider === props.form.providerId && name === props.form.name) choose(KEEPASS_CUSTOM_ICON_TYPE, value);
  } catch (cause) { if (request === selection) error.value = tr(cause instanceof Error ? cause.message : '无法读取图片。'); }
  finally { if (request === selection) props.form.iconBusy = false; }
}
function applyEmoji() { const value=normalizeEmojiIcon(emojiInput.value); if(!value) {error.value=tr('请输入一个有效的 Emoji');return;} choose('EMOJI',value); }
</script>
<template>
  <div class="custom-icon-picker" :class="{ 'is-open': open }">
    <div class="icon-current">
      <WebsiteIcon :item="iconItem" fallback="key" />
      <div><strong>{{ tr('项目图标') }}</strong><small>{{ current }}</small></div>
      <m3e-button type="button" variant="text" :aria-expanded="open" @click="open=!open">{{ open ? tr('完成') : tr('更换图标') }}</m3e-button>
    </div>
    <div v-if="open" class="icon-choices">
      <div class="icon-actions">
        <m3e-button v-if="keepass" type="button" variant="tonal" :disabled="form.iconBusy" @click="imageInput?.click()">{{ tr('从图片选择') }}</m3e-button>
        <input ref="imageInput" type="file" accept="image/png,image/jpeg,image/webp" hidden :aria-label="tr('从图片选择')" @change="selectImage" />
        <m3e-button type="button" variant="tonal" @click="choose('NONE')">{{ tr('跟随网站') }}</m3e-button>
        <m3e-button type="button" :variant="mode==='library'?'filled':'tonal'" @click="mode='library'">{{ tr('图标库') }}</m3e-button>
        <m3e-button type="button" :variant="mode==='emoji'?'filled':'tonal'" @click="mode='emoji';emojiInput=form.customIconType==='EMOJI' ? form.customIconValue || '' : ''">Emoji</m3e-button>
      </div>
      <p v-if="form.iconBusy" role="status">{{ tr('正在处理图片…') }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <template v-if="mode==='library'">
        <m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">{{ tr('搜索图标名称') }}</label><m3e-icon slot="prefix" name="search"/><input v-model="query" :aria-label="tr('搜索图标名称')" autocomplete="off" @input="limit=48" /></m3e-form-field>
        <div class="brand-grid" :aria-label="tr('图标库')">
          <button v-for="icon in choices.slice(0,limit)" :key="icon.slug" type="button" :aria-label="icon.label" :aria-pressed="form.customIconType==='SIMPLE_ICON' && form.customIconValue===icon.slug" @click="choose('SIMPLE_ICON',icon.slug)">
            <img :src="brandIconPath(icon.slug,activeScheme==='dark')" alt="" width="28" height="28" loading="lazy"/><span>{{ icon.label }}</span>
          </button>
        </div>
        <p v-if="!choices.length" role="status">{{ tr('没有匹配的图标') }}</p>
        <m3e-button v-if="choices.length>limit" type="button" variant="text" @click="limit+=48">{{ tr('显示更多') }}</m3e-button>
      </template>
      <template v-else>
        <div class="emoji-grid"><button v-for="emoji in quickEmojiIcons" :key="emoji" type="button" :aria-label="emoji" :aria-pressed="form.customIconType==='EMOJI' && form.customIconValue===emoji" @click="choose('EMOJI',emoji);emojiInput=emoji">{{ emoji }}</button></div>
        <m3e-form-field v-field-label variant="filled" hide-required-marker><label slot="label">Emoji</label><input v-model="emojiInput" aria-label="Emoji" autocomplete="off" maxlength="32" @keydown.enter.prevent="applyEmoji" /></m3e-form-field>
        <m3e-button type="button" variant="tonal" @click="applyEmoji">{{ tr('使用这个 Emoji') }}</m3e-button>
      </template>
    </div>
  </div>
</template>
<style scoped>
.custom-icon-picker { width:100%; min-width:0; }
.icon-current { display:flex; align-items:center; gap:12px; padding:16px; border-radius:24px; background:var(--app-surface-high); }
.is-open .icon-current { border-radius:24px 24px 4px 4px; }
.icon-current>div { display:grid; gap:4px; flex:1; min-width:0; }
.icon-current small { overflow-wrap:anywhere; color:var(--app-muted); }
.icon-choices { display:grid; gap:16px; margin-top:4px; padding:16px; background:var(--app-surface-high); border-radius:4px 4px 24px 24px; }
.icon-actions { display:flex; flex-wrap:wrap; gap:8px; }
.brand-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(76px,1fr)); gap:4px; max-height:288px; overflow:auto; padding:4px; }
.brand-grid button,.emoji-grid button { border:2px solid transparent; border-radius:16px; background:var(--app-surface); color:var(--app-text); cursor:pointer; min-height:48px; }
.brand-grid button { display:grid; justify-items:center; align-content:center; gap:6px; padding:10px 4px; }
.brand-grid img { object-fit:contain; }
.brand-grid span { max-width:100%; font-size:11px; overflow-wrap:anywhere; }
.emoji-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(48px,1fr)); gap:4px; }
.emoji-grid button { font-size:24px; }
button[aria-pressed=true] { border-color:var(--app-primary); background:var(--app-selected); }
button:focus-visible { outline:2px solid var(--app-primary); outline-offset:2px; }
</style>
