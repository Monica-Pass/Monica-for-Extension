<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { tr } from "../i18n";
const props = defineProps<{ tokens: string[]; label: (token: string) => string }>();
const emit = defineEmits<{ move: [token: string, target: string, after: boolean] }>();
const list = ref<HTMLElement>();
const source = ref(""); const target = ref(""); const after = ref(false); const status = ref("");
watch(() => props.tokens.join("\u0000"), () => { status.value = tr('已调整内容顺序。'); });
let pointer: number | undefined, startY = 0, x = 0, y = 0, moved = false, frame = 0;
let handle: HTMLElement | undefined, scroller: HTMLElement | undefined;
function cancel() {
  cancelAnimationFrame(frame); frame = 0;
  const active = pointer; pointer = undefined;
  if (active !== undefined && handle?.hasPointerCapture(active)) handle.releasePointerCapture(active);
  source.value = target.value = ""; moved = false; handle = scroller = undefined;
}
function destination() {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-order-token]");
  if (!row || !list.value?.contains(row)) { target.value = ""; return; }
  target.value = row.dataset.orderToken || "";
  const rect = row.getBoundingClientRect(); after.value = y > rect.top + rect.height / 2;
}
function animate() {
  if (pointer === undefined) return;
  if (moved && scroller) {
    const rect = scroller.getBoundingClientRect();
    if (y < rect.top + 36) scroller.scrollBy(0, -10);
    else if (y > rect.bottom - 36) scroller.scrollBy(0, 10);
    destination();
  }
  frame = requestAnimationFrame(animate);
}
function begin(event: PointerEvent, token: string) {
  if (!event.isPrimary || event.button !== 0) return;
  cancel();
  handle = event.currentTarget as HTMLElement;
  handle.focus(); pointer = event.pointerId; startY = y = event.clientY; x = event.clientX; source.value = token;
  handle.setPointerCapture(pointer);
  for (let node = list.value?.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) { scroller = node; break; }
  }
  frame = requestAnimationFrame(animate);
}
function drag(event: PointerEvent) {
  if (event.pointerId !== pointer) return;
  x = event.clientX; y = event.clientY;
  moved ||= Math.abs(y - startY) > 4;
  if (moved) destination();
}
function commit(token: string, destinationToken: string, placement: boolean) {
  if (!props.tokens.includes(token) || !props.tokens.includes(destinationToken) || token === destinationToken) return;
  emit("move", token, destinationToken, placement);
}
function end(event: PointerEvent) {
  if (event.pointerId !== pointer) return;
  if (moved && target.value) commit(source.value, target.value, after.value);
  cancel();
}
function step(token: string, direction: number) {
  cancel(); const index = props.tokens.indexOf(token), next = index + direction;
  if (index >= 0 && next >= 0 && next < props.tokens.length) commit(token, props.tokens[next], direction > 0);
}
onBeforeUnmount(cancel);
</script>

<template>
  <p class="editor-hint">{{ tr('拖动手柄调整顺序，也可使用上下方向键。') }}</p>
  <div ref="list" class="content-order-list">
    <div v-for="(token,index) in tokens" :key="token" :data-order-token="token" class="content-order-row" :class="{ 'order-source': source===token, 'order-before': target===token && source!==token && !after, 'order-after': target===token && source!==token && after }">
      <button type="button" class="content-drag-handle" :aria-label="tr('拖动排序：{0}', {0:label(token)})" @pointerdown.prevent="begin($event,token)" @pointermove="drag" @pointerup="end" @pointercancel="cancel" @lostpointercapture="cancel" @keydown.up.prevent="step(token,-1)" @keydown.down.prevent="step(token,1)" @keydown.esc.stop.prevent="cancel"><m3e-icon name="drag_indicator" /></button>
      <span>{{ label(token) }}</span>
      <m3e-icon-button type="button" :disabled="index===0" :aria-label="`上移${label(token)}`" @click="step(token,-1)"><m3e-icon name="expand_less" /></m3e-icon-button>
      <m3e-icon-button type="button" :disabled="index===tokens.length-1" :aria-label="`下移${label(token)}`" @click="step(token,1)"><m3e-icon name="expand_more" /></m3e-icon-button>
    </div>
  </div>
  <span class="order-status" role="status" aria-live="polite">{{ status }}</span>
</template>

<style scoped>
.content-order-list{display:grid;gap:4px}.content-order-row{display:flex;align-items:center;gap:4px;min-height:48px;padding:4px 8px;border-radius:4px;background:var(--md-sys-color-surface-container);position:relative}.content-order-row:first-child{border-start-start-radius:24px;border-start-end-radius:24px}.content-order-row:last-child{border-end-start-radius:24px;border-end-end-radius:24px}.content-order-row>span{flex:1;min-width:0;overflow-wrap:anywhere}.content-drag-handle{display:grid;place-items:center;flex:0 0 40px;min-height:44px;border:0;border-radius:12px;background:transparent;color:var(--md-sys-color-on-surface-variant);cursor:grab;touch-action:none;user-select:none}.content-drag-handle:focus-visible{outline:2px solid var(--md-sys-color-primary);outline-offset:2px}.order-source{background:var(--md-sys-color-secondary-container)}.order-source .content-drag-handle{cursor:grabbing}.order-before::before,.order-after::after{content:"";position:absolute;left:8px;right:8px;height:3px;background:var(--md-sys-color-primary);pointer-events:none}.order-before::before{top:-3px}.order-after::after{bottom:-3px}.order-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
</style>
