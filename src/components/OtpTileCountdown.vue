<script setup lang="ts">
import "@m3e/web/progress-indicator";
import { computed, onBeforeUnmount, ref } from "vue";
import { subscribeForegroundClock } from "../lib/foreground-clock";
import { tr } from "../i18n";

const props = defineProps<{ period: number }>();
const now = ref<number | null>(null);
const stopClock = subscribeForegroundClock(value => { now.value = value; });
const remaining = computed(() => now.value === null ? 0 : props.period - Math.floor(now.value / 1000) % props.period);
onBeforeUnmount(stopClock);
</script>

<template>
  <div v-if="now !== null" class="tile-countdown">
    <m3e-linear-progress-indicator variant="wavy" :value.prop="remaining" :max.prop="period" :aria-label="tr('验证码刷新倒计时')" :aria-valuetext="tr('{0} 秒', { 0: remaining })" />
    <span>{{ tr('{0} 秒', { 0: remaining }) }}</span>
  </div>
</template>
