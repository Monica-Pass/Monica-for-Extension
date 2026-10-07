<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { loginFallbackIcon, loginWebsiteOrigin, websiteOrigin, type WebsiteIconItem } from "../core/website-icon";
import { websiteIconCache } from "../lib/website-icon-cache";
import { brandIconPath, normalizeEmojiIcon } from '../core/custom-icon';
import { activeScheme } from '../lib/theme';
import { bitmapIconDataUrl, KEEPASS_CUSTOM_ICON_TYPE } from '../core/bitmap-icon';

const props = defineProps<{ item?: WebsiteIconItem; url?: string; fallback?: string }>();
const iconElement = ref<HTMLElement>();
const visible = ref(false);
const source = ref("");
const loaded = ref(false);
const emoji = computed(() => props.item?.customIconType === 'EMOJI' ? normalizeEmojiIcon(props.item.customIconValue) : undefined);
const brand = computed(() => props.item?.customIconType === 'SIMPLE_ICON' ? brandIconPath(props.item.customIconValue, activeScheme.value === 'dark') : undefined);
const bitmap = computed(() => props.item?.customIconType === KEEPASS_CUSTOM_ICON_TYPE ? bitmapIconDataUrl(props.item.customIconValue) : undefined);
const origin = computed(() => props.item?.customIconType && props.item.customIconType !== 'NONE' ? '' : props.item ? loginWebsiteOrigin(props.item) : websiteOrigin(props.url || ""));
const fallbackIcon = computed(() => {
  const typeIcon = loginFallbackIcon(props.item?.loginType);
  return typeIcon !== "language" ? typeIcon : props.fallback || typeIcon;
});
let observer: IntersectionObserver | undefined;

onMounted(() => {
  if (!iconElement.value || !globalThis.IntersectionObserver) { visible.value = true; return; }
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) {
      visible.value = true;
      observer?.disconnect();
    }
  }, { rootMargin: "120px" });
  observer.observe(iconElement.value);
});
onBeforeUnmount(() => observer?.disconnect());

watch([origin, visible, brand, bitmap], async ([nextOrigin, isVisible, brandPath, bitmapUrl], _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  source.value = "";
  loaded.value = false;
  if (!isVisible) return;
  if (bitmapUrl) { source.value = bitmapUrl; return; }
  if (brandPath) { source.value = new URL(brandPath, document.baseURI).href; return; }
  if (!nextOrigin) return;
  const icon = await websiteIconCache.load(nextOrigin, controller.signal);
  if (!controller.signal.aborted) source.value = icon;
}, { immediate: true });

function imageLoaded(event: Event) {
  if ((event.target as HTMLImageElement).src === source.value) loaded.value = true;
}
function imageFailed(event: Event) {
  if ((event.target as HTMLImageElement).src === source.value) { source.value = ""; loaded.value = false; }
}
</script>

<template>
  <span ref="iconElement" class="website-icon" aria-hidden="true" :class="{ 'website-icon--loaded': loaded, 'website-icon--custom': Boolean(emoji || brand || bitmap) }">
    <span v-if="emoji" class="website-icon__emoji">{{ emoji }}</span>
    <m3e-icon v-else-if="!loaded" class="website-icon__fallback" :name="fallbackIcon" />
    <img v-if="source" :key="source" class="website-icon__image" :class="{ 'is-loaded': loaded }" :src="source" alt="" width="24" height="24" decoding="async" referrerpolicy="no-referrer" @load="imageLoaded" @error="imageFailed" />
    <span v-if="item?.favorite" class="website-icon__favorite"><m3e-icon name="star" /></span>
  </span>
</template>

<style scoped>
.website-icon { position: relative; flex: 0 0 auto; display: grid; place-items: center; }
.website-icon__fallback, .website-icon__image { grid-area: 1 / 1; }
.website-icon__emoji { font-size: 26px; line-height: 1; grid-area: 1 / 1; }
.website-icon__image { width: 24px; height: 24px; object-fit: contain; border-radius: 4px; opacity: 0; }
.website-icon__image.is-loaded { opacity: 1; }
.website-icon__favorite { position: absolute; inset-inline-end: -3px; bottom: -3px; display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: var(--app-surface); color: var(--app-primary); }
.website-icon__favorite m3e-icon { --m3e-icon-size: 12px; font-variation-settings: "FILL" 1; }
</style>
