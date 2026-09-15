<script setup lang="ts">
import type { TotpItem } from "../core/model";
import { tr } from "../i18n";
import SteamNetworkActions from "./SteamNetworkActions.vue";

defineProps<{ item: TotpItem }>();
const emit = defineEmits<{ close: []; details: [] }>();
</script>

<template>
  <m3e-dialog v-material-dialog open dismissible class="material-dialog steam-account-dialog" :close-label="tr('关闭 Steam 账号')" @closed.self="emit('close')">
    <div slot="header" class="steam-dialog-heading"><m3e-icon name="sports_esports" /><div><h2>{{ item.title }}</h2><p v-if="item.accountName">{{ item.accountName }}</p></div></div>
    <SteamNetworkActions :key="item.id" :item="item" compact-header />
    <footer slot="actions"><m3e-button variant="text" @click="emit('details')">{{ tr('查看详情') }}</m3e-button><m3e-button variant="text" @click="emit('close')">{{ tr('关闭') }}</m3e-button></footer>
  </m3e-dialog>
</template>
