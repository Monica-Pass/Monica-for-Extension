<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { VaultItem } from "../core/model";
import { maskedSuffix, itemIcon } from "../manager/item-metadata";
import { readVerifiedAttachment } from "../manager/attachment-reader";
import { vaultClient } from "../runtime/client";
import { tr } from "../i18n";

const props = defineProps<{ item: VaultItem; owner?: VaultItem }>();
const face = computed(() => "cardFace" in props.item ? props.item.cardFace : undefined);
const mode = computed(() => face.value?.displayMode || "ALL");
const content = computed(() => {
  const item = props.item;
  if (item.kind === "card") return { subtitle: item.bankName, identifier: maskedSuffix(item.number), start: item.cardholderName, end: [item.expiryMonth, item.expiryYear].filter(Boolean).join(" / "), brand: item.brand };
  if (item.kind === "identity") return { subtitle: item.issuedBy, identifier: maskedSuffix(item.documentNumber), start: item.fullName || [item.firstName, item.lastName].filter(Boolean).join(" "), end: item.expiryDate, brand: undefined };
  if (item.kind === "billing-address") return { subtitle: item.fullName, identifier: [item.streetAddress, item.apartment].filter(Boolean).join(" "), start: [item.city, item.stateProvince].filter(Boolean).join(" "), end: [item.postalCode, item.country].filter(Boolean).join(" "), brand: undefined };
  return { subtitle: "", identifier: "", start: "", end: "", brand: undefined };
});
const host = ref<HTMLElement>();
const visible = ref(false), imageUrl = ref(""), failed = ref(false), busy = ref(false);
let observer: IntersectionObserver | undefined;
let request: AbortController | undefined;
function clear() { request?.abort(); if (imageUrl.value) URL.revokeObjectURL(imageUrl.value); imageUrl.value = ""; }
watch(() => [visible.value, props.owner || props.item, face.value?.imageAttachmentName] as const, async () => {
  clear(); failed.value = false; busy.value = false;
  const owner = props.owner || props.item, name = face.value?.imageAttachmentName;
  if (!visible.value || !name) return;
  const providerId = owner.providerRefs[0]?.providerId;
  if (!providerId) { failed.value = true; return; }
  const current = request = new AbortController(); busy.value = true;
  try {
    const result = await readVerifiedAttachment(vaultClient, providerId, owner.id, name, undefined, current.signal);
    if (current.signal.aborted) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(result.mediaType)) throw new Error("Unsupported image");
    imageUrl.value = URL.createObjectURL(new Blob([result.bytes], { type: result.mediaType }));
  } catch { if (!current.signal.aborted) failed.value = true; }
  finally { if (!current.signal.aborted) busy.value = false; }
}, { immediate: true });
onMounted(() => {
  observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { visible.value = true; observer?.disconnect(); } }, { rootMargin: "120px" });
  if (host.value) observer.observe(host.value);
});
onBeforeUnmount(() => { observer?.disconnect(); clear(); });
function imageFailed() { clear(); failed.value = true; }
</script>

<template>
  <div ref="host" class="wallet-card-face" :class="{ 'wallet-card-face--image': imageUrl, 'wallet-card-face--address': item.kind === 'billing-address' }" :data-display-mode="mode" :aria-busy="busy">
    <img v-if="imageUrl" :src="imageUrl" :alt="tr('卡面')" @error="imageFailed" />
    <div v-if="imageUrl && mode !== 'HIDDEN'" class="wallet-card-scrim" />
    <header v-if="mode === 'ALL'"><m3e-icon v-if="!content.brand" :name="itemIcon(item.kind)" /><div><strong>{{ item.title }}</strong><small v-if="content.subtitle">{{ content.subtitle }}</small></div></header>
    <div v-if="mode !== 'HIDDEN'" class="wallet-card-identifier">{{ content.identifier }}</div>
    <footer v-if="mode === 'ALL'"><span>{{ content.start }}</span><span>{{ content.end }}</span></footer>
    <span v-if="mode !== 'HIDDEN' && face?.showBrandIcon !== false && content.brand" class="wallet-card-brand">{{ content.brand }}</span>
    <span v-if="failed" class="wallet-card-image-error" role="status"><m3e-icon name="image_not_supported" />{{ tr('附件读取失败。') }}</span>
  </div>
</template>

<style scoped>
.wallet-card-face{position:relative;isolation:isolate;aspect-ratio:1.586;min-width:0;overflow:hidden;border-radius:24px;background:var(--md-sys-color-surface-container-high,var(--app-surface));color:var(--app-text);container:card-face/inline-size}
.wallet-card-face>img,.wallet-card-scrim{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1}
.wallet-card-scrim{background:linear-gradient(180deg,#0006,transparent 35%,#0009)}
.wallet-card-face--image{color:#fff;text-shadow:0 1px 4px #000b}
 .wallet-card-face > header{position:absolute;top:9%;left:6%;right:6%;display:flex;gap:10px;align-items:center}header>div{min-width:0}header strong,header small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}header strong{font:600 clamp(1rem,5cqi,1.35rem)/1.4 var(--font-ui)}header small{font:400 .8125rem/1.5 var(--font-ui)}
.wallet-card-identifier{position:absolute;top:57%;left:6%;right:6%;font:500 clamp(1rem,6cqi,1.5rem)/1.3 var(--font-data);letter-spacing:.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wallet-card-face--address .wallet-card-identifier{font-family:var(--font-ui);letter-spacing:0}
.wallet-card-face > footer{position:absolute;bottom:9%;left:6%;right:6%;display:flex;justify-content:space-between;flex-wrap:nowrap;padding:0;margin:0;border:0;gap:12px;font:500 .8125rem/1.4 var(--font-ui)}footer span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.wallet-card-face:has(.wallet-card-brand) footer{right:27%}
.wallet-card-brand{position:absolute;right:6%;bottom:9%;max-width:20%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 italic 1rem/1.4 var(--font-ui)}
.wallet-card-image-error{position:absolute;top:3px;right:8px;display:flex;align-items:center;gap:4px;font-size:.6875rem;color:var(--app-muted)}.wallet-card-image-error m3e-icon{--m3e-icon-size:14px}
</style>
