<script setup lang="ts">
import "@m3e/web/menu";
import type { M3eMenuElement } from "@m3e/web/menu";
import { computed, onBeforeUnmount, ref, useId } from "vue";
import type { LoginItem, TotpItem, VaultItem } from "../core/model";
import { websiteOrigin } from "../core/website-icon";
import { documentLabel, itemIcon, itemKindLabel, maskedSuffix } from "../manager/item-metadata";
import { tr } from "../i18n";
import TotpCodeCell from "./TotpCodeCell.vue";
import WebsiteIcon from "./WebsiteIcon.vue";

const props = defineProps<{
  item: VaultItem;
  providerLabel: string;
  sharedPeriod?: number;
  hasAttachments: boolean;
  hasHistory: boolean;
  consumeOtp: (item: LoginItem | TotpItem) => Promise<void>;
}>();
type TileAction = "open" | "details" | "edit" | "remove" | "attachments" | "history";
const emit = defineEmits<(event: TileAction) => void>();
const uid = useId();
const actionId = `tile-open-${uid}`;
const menuId = `tile-menu-${uid}`;
const menu = ref<M3eMenuElement>();
const trigger = ref<HTMLElement>();

const metadata = computed(() => {
  const item = props.item;
  switch (item.kind) {
    case "card": return {
      subtitle: [...new Set([item.bankName, item.brand].filter(Boolean))].join(" · ") || itemKindLabel(item.kind),
      primary: maskedSuffix(item.number) || "••••", secondary: item.cardholderName,
      accessory: item.expiryMonth && item.expiryYear ? `${item.expiryMonth.padStart(2, "0")} / ${item.expiryYear.slice(-2)}` : ""
    };
    case "identity": return { subtitle: documentLabel(item.documentType), primary: maskedSuffix(item.documentNumber) || "••••", secondary: item.fullName || [item.firstName, item.lastName].filter(Boolean).join(" "), accessory: "" };
    case "billing-address": return { subtitle: itemKindLabel(item.kind), primary: [item.city, item.country].filter(Boolean).join(" · ") || tr('地址信息'), secondary: item.fullName, accessory: "" };
    case "payment-account": return { subtitle: item.provider || item.paymentType || itemKindLabel(item.kind), primary: maskedSuffix(item.maskedAccountNumber || item.linkedCardLast4 || "") || item.accountName || tr('支付账号'), secondary: item.accountHolderName || item.accountName, accessory: item.currency };
    case "totp": return { subtitle: item.accountName || item.issuer || (item.otpType === "STEAM" ? "Steam Guard" : item.otpType || "TOTP"), primary: "", secondary: "", accessory: "" };
    default: return { subtitle: itemKindLabel(item.kind), primary: "", secondary: "", accessory: "" };
  }
});

// Icons reuse the existing origin-only, lazy cache. No account names or OTP
// URIs are ever sent to an icon service; unknown issuers use the local glyph.
const issuerSites: Record<string, string> = {
  github: "https://github.com", gitlab: "https://gitlab.com", google: "https://google.com",
  microsoft: "https://microsoft.com", steam: "https://steamcommunity.com", stripe: "https://stripe.com",
  cloudflare: "https://cloudflare.com", openai: "https://openai.com", amazon: "https://amazon.com"
};
const iconItem = computed(() => {
  const item = props.item;
  return {
    favorite: item.favorite,
    iconOrigin: item.kind === "totp"
      ? websiteOrigin(item.link || "") || issuerSites[(item.issuer || "").trim().toLowerCase()] || (item.otpType === "STEAM" ? issuerSites.steam : websiteOrigin(item.issuer || ""))
      : ""
  };
});

function sizeMenu() {
  if (!menu.value || !trigger.value) return;
  const bounds = trigger.value.getBoundingClientRect();
  const above = bounds.top - 12;
  const below = innerHeight - bounds.bottom - 12;
  menu.value.positionY = below >= above ? "below" : "above";
  menu.value.style.setProperty("--m3e-menu-container-max-height", `${Math.max(44, Math.max(above, below) - 4)}px`);
}

function openWithKeyboard(event: KeyboardEvent) {
  if (event.key !== "ArrowDown") return;
  event.preventDefault();
  sizeMenu();
  if (trigger.value) void menu.value?.show(trigger.value);
}

async function select(action: TileAction) {
  await menu.value?.hide(true);
  trigger.value?.focus({ preventScroll: true });
  emit(action);
}
function menuToggled(event: ToggleEvent) {
  if (event.newState === "open") window.addEventListener("resize", sizeMenu);
  else window.removeEventListener("resize", sizeMenu);
}
onBeforeUnmount(() => {
  window.removeEventListener("resize", sizeMenu);
  void menu.value?.hide();
});
</script>

<template>
  <m3e-card variant="filled" class="vault-tile" :class="`vault-tile--${item.kind}`" :data-item-id="item.id" @click="emit('open')">
    <div class="vault-tile-content">
      <m3e-focus-ring class="vault-tile-focus" :for="actionId" inward />
      <header class="vault-tile-header">
        <m3e-list-action :id="actionId" role="presentation" class="vault-tile-open" v-list-action="tr('查看{0}详情', { 0: item.title })" @click.stop="emit('open')">
          <WebsiteIcon slot="leading" class="vault-tile-icon" :item="iconItem" :fallback="item.kind === 'totp' && item.otpType === 'STEAM' ? 'sports_esports' : itemIcon(item.kind)" />
          <strong :title="item.title">{{ item.title }}</strong>
          <small slot="supporting-text" :title="metadata.subtitle">{{ metadata.subtitle }}</small>
        </m3e-list-action>
        <m3e-icon-button ref="trigger" class="vault-tile-menu-trigger" :aria-label="tr('{0}的更多操作', { 0: item.title })" @click.capture="sizeMenu" @click.stop @keydown="openWithKeyboard">
          <m3e-icon name="more_vert" />
          <m3e-menu-trigger :for="menuId" />
        </m3e-icon-button>
      </header>
      <div v-if="item.kind === 'totp'" class="vault-tile-code" @click.stop>
        <TotpCodeCell :item="item" layout="tile" allow-use :hide-timer="Boolean(sharedPeriod)" :consume-code="consumeOtp" />
      </div>
      <div v-else class="wallet-tile-preview">
        <strong class="wallet-tile-value" :class="{ 'wallet-tile-value--text': item.kind === 'billing-address' }">{{ metadata.primary }}</strong>
        <div class="wallet-tile-person"><span :title="metadata.secondary">{{ metadata.secondary }}</span><span v-if="metadata.accessory" :aria-label="item.kind === 'card' ? tr('有效期 {0}', { 0: metadata.accessory }) : undefined">{{ metadata.accessory }}</span></div>
      </div>
      <footer class="vault-tile-footer"><span :title="providerLabel">{{ providerLabel }}</span></footer>
    </div>
  </m3e-card>
  <m3e-menu :id="menuId" ref="menu" class="vault-tile-menu" position-x="before" :aria-label="tr('{0}的更多操作', { 0: item.title })" @click.stop @toggle="menuToggled">
    <m3e-menu-item @click="select('details')"><m3e-icon slot="icon" name="info" />{{ tr('查看详情') }}</m3e-menu-item>
    <m3e-menu-item @click="select('edit')"><m3e-icon slot="icon" name="edit" />{{ tr('编辑') }}</m3e-menu-item>
    <m3e-menu-item v-if="hasAttachments" @click="select('attachments')"><m3e-icon slot="icon" name="attach_file" />{{ tr('附件') }}</m3e-menu-item>
    <m3e-menu-item v-if="hasHistory" @click="select('history')"><m3e-icon slot="icon" name="history" />{{ tr('KeePass 历史') }}</m3e-menu-item>
    <m3e-menu-item class="vault-tile-remove" @click="select('remove')"><m3e-icon slot="icon" name="delete" />{{ tr('移到回收站') }}</m3e-menu-item>
  </m3e-menu>
</template>
