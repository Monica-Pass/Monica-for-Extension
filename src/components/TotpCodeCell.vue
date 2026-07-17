<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { TotpItem } from "../core/model";
import { generateSteamCode, steamSecondsRemaining } from "../core/steam-totp";
import { generateTotpWithParameters } from "../core/totp";

const props = defineProps<{ item: TotpItem }>();
const code = ref("•••••");
const remaining = ref(0);
let timer = 0;

async function refresh() {
  try {
    const now = Date.now();
    code.value = props.item.otpType === "STEAM"
      ? await generateSteamCode(props.item.steamSharedSecretBase64 || props.item.secret, now)
      : await generateTotpWithParameters({ secret: props.item.secret, algorithm: props.item.algorithm, digits: props.item.digits, period: props.item.period }, now);
    remaining.value = props.item.otpType === "STEAM" ? steamSecondsRemaining(now) : props.item.period - Math.floor(now / 1000) % props.item.period;
  } catch {
    code.value = "不可用";
    remaining.value = 0;
  }
}

void refresh();
timer = window.setInterval(() => void refresh(), 1000);
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <span class="totp-code-cell"><strong>{{ code }}</strong><small v-if="remaining">{{ remaining }} 秒</small></span>
</template>
