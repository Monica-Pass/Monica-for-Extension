<script setup lang="ts">
import "@m3e/web/list";
import WebsiteIcon from "../components/WebsiteIcon.vue";
import { tr } from "../i18n";
import type { LoginMatchSummary } from "../runtime/messages";
import { computed } from 'vue';
import { formatAutofillCredential } from '../autofill/credential-identity';

const props = withDefaults(defineProps<{
  item: LoginMatchSummary;
  canFill: boolean;
  busy: boolean;
  filling: boolean;
  copyActions?: boolean;
  showTotp?: boolean;
  fallback?: string;
}>(), { copyActions: false, showTotp: true, fallback: "language" });

const credentialLabel = computed(() => formatAutofillCredential(props.item.credentialIdentity, tr));

const emit = defineEmits<{
  fill: [item: LoginMatchSummary];
  copy: [item: LoginMatchSummary, field: "username" | "password"];
}>();

function fill() {
  if (props.canFill && !props.busy) emit("fill", props.item);
}
</script>

<template>
  <div class="credential-card login-row" role="listitem" :aria-busy="filling">
    <!-- Copy controls are siblings of the fill action, never nested buttons.
         An unavailable fill action becomes readable, noninteractive content. -->
    <component
      :is="canFill ? 'm3e-list-action' : 'm3e-list-item'"
      v-list-action="[tr('填充到当前页面'), item.title, item.username || tr('无用户名'), credentialLabel].filter(Boolean).join(' · ')"
      class="login-row-main"
      role="presentation"
      :disabled="canFill && busy"
      :title="canFill ? tr('填充到当前页面') : copyActions ? tr('当前页面不可填充，可用右侧复制') : undefined"
      @click="fill"
    >
      <WebsiteIcon slot="leading" class="credential-icon" :item="item" :fallback="fallback" />
      <span class="popup-item-title" :title="item.title">{{ item.title }}</span>
      <span slot="supporting-text" class="popup-item-subtitle">
        <span class="popup-item-account">
          <span class="popup-item-username" :title="item.username || tr('无用户名')">{{ item.username || tr('无用户名') }}</span>
          <span v-if="credentialLabel" class="popup-credential-identity">{{ credentialLabel }}</span>
        </span>
        <m3e-icon v-if="showTotp && item.hasTotp" class="popup-totp-icon" name="timer" :title="tr('含验证码')" :aria-label="tr('含验证码')" />
      </span>
      <span v-if="!copyActions" slot="trailing" class="fill-action">{{ filling ? tr('填充中') : tr('填充') }}<m3e-icon name="arrow_forward" aria-hidden="true" /></span>
    </component>
    <span v-if="copyActions" class="row-actions">
      <m3e-icon-button :aria-label="tr('复制用户名')" :title="tr('复制用户名')" @click="emit('copy', item, 'username')"><m3e-icon name="content_copy" /></m3e-icon-button>
      <m3e-icon-button :aria-label="tr('复制密码')" :title="tr('复制密码')" @click="emit('copy', item, 'password')"><m3e-icon name="key" /></m3e-icon-button>
    </span>
  </div>
</template>
