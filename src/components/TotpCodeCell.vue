<script setup lang="ts">
import { tr } from '../i18n';

import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { LoginItem, TotpItem } from "../core/model";
import { parametersFromItem } from "../core/login-otp";
import { otpSecondsRemaining } from "../core/totp";
import { createOtpDisplayCache } from "../core/otp-display-cache";
import { subscribeForegroundClock } from "../lib/foreground-clock";

const props = withDefaults(defineProps<{
  item: LoginItem | TotpItem;
  allowUse?: boolean;
  showCopyIcon?: boolean;
  layout?: "inline" | "tile";
  hideTimer?: boolean;
  consumeCode?: (item: LoginItem | TotpItem) => Promise<void>;
}>(), { allowUse: false, showCopyIcon: false, layout: "inline", hideTimer: false });
const code = ref("•••••");
const nextCode = ref("");
const remaining = ref(0);
const copyState = ref("");
const available = ref(false);
const unavailable = ref(false);
const copying = ref(false);
function formatCode(value: string): string {
  if (props.layout !== "tile" || !/^\d{6,10}$/.test(value) || value.length % 2) return value;
  const middle = value.length / 2;
  return `${value.slice(0, middle)} ${value.slice(middle)}`;
}
const displayCode = computed(() => unavailable.value ? tr('不可用') : formatCode(code.value));
const parameters = computed(() => {
  try { return parametersFromItem(props.item); }
  catch { return undefined; }
});
const cache = createOtpDisplayCache();
const nextCache = createOtpDisplayCache();
let stopClock: (() => void) | undefined;
let copyTimer: number | undefined;
let revision = 0;
let disposed = false;

async function refresh(now = Date.now()) {
  const request = ++revision;
  try {
    const source = parameters.value;
    if (!source) throw new Error("Missing OTP parameters");
    const seconds = otpSecondsRemaining(source, now);
    // Preview the next time window without consuming a code or changing storage.
    // Separate bounded caches avoid calculating either code on every clock tick.
    const [value, preview] = await Promise.all([
      cache.get(source, now),
      props.layout === "tile" && source.otpType !== "HOTP"
        ? nextCache.get(source, now + seconds * 1000).catch(() => "") : ""
    ]);
    if (disposed || request !== revision) return;
    code.value = value;
    nextCode.value = preview;
    remaining.value = seconds;
    available.value = true;
    unavailable.value = false;
  } catch {
    if (disposed || request !== revision) return;
    unavailable.value = true;
    nextCode.value = "";
    remaining.value = 0;
    available.value = false;
  }
}

async function useCode() {
  if (copying.value) return;
  copying.value = true;
  let copied = false;
  try {
    await refresh();
    if (disposed || !available.value) return;
    const isHotp = parameters.value?.otpType === "HOTP";
    if (isHotp && !props.consumeCode) return;
    const source = props.item;
    await navigator.clipboard.writeText(code.value);
    copied = true;
    // Keep copying disabled until the source counter has been saved and refreshed.
    if (isHotp) await props.consumeCode!(source);
    if (disposed) return;
    copyState.value = tr('已复制');
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { copyState.value = ""; }, 1600);
  } catch {
    if (!disposed) copyState.value = copied ? tr('验证码已复制，但计数器更新失败。') : tr('复制失败');
  } finally {
    copying.value = false;
  }
}

watch([parameters, () => props.layout], () => {
  stopClock?.();
  stopClock = undefined;
  revision++;
  cache.clear();
  nextCache.clear();
  available.value = false;
  unavailable.value = false;
  code.value = "•••••";
  nextCode.value = "";
  if (!parameters.value || parameters.value.otpType === "HOTP") void refresh();
  else stopClock = subscribeForegroundClock((now) => {
    if (now === null) {
      revision++;
      cache.clear();
      nextCache.clear();
      code.value = "•••••";
      nextCode.value = "";
      remaining.value = 0;
      available.value = false;
    } else void refresh(now);
  });
}, { immediate: true });
onBeforeUnmount(() => {
  disposed = true;
  revision++;
  stopClock?.();
  window.clearTimeout(copyTimer);
  cache.clear();
  nextCache.clear();
});
</script>

<template>
  <span class="totp-code-cell" :class="{ 'totp-code-cell--tile': layout === 'tile', 'otp-expiring': remaining > 0 && remaining <= 5, 'otp-code-long': code.length > 8 }">
    <m3e-button class="otp-copy-button" variant="text" v-if="allowUse" type="button" :disabled="!available || copying || (parameters?.otpType === 'HOTP' && !consumeCode)" :aria-label="parameters?.otpType === 'HOTP' ? tr('复制验证码并将计数器加一') : tr('复制验证码')" @click="useCode"><strong>{{ displayCode }}</strong><m3e-icon slot="icon" v-if="showCopyIcon" name="content_copy" aria-hidden="true"></m3e-icon></m3e-button>
    <strong v-else>{{ displayCode }}</strong>
    <span v-if="layout === 'tile' && nextCode" class="otp-next-code"><span>{{ tr('下一组') }}</span><strong>{{ formatCode(nextCode) }}</strong></span>
    <small v-if="remaining && !hideTimer" class="otp-remaining">{{ tr('{0} 秒', { 0: remaining }) }}</small>
    <small v-else-if="parameters?.otpType === 'HOTP'">{{ tr('计数 {0}', { 0: parameters.counter || 0 }) }}</small>
    <small class="otp-copy-status" aria-live="polite">{{ copyState }}</small>
  </span>
</template>
