<script setup lang="ts">
defineProps<{
  title: string;
  message: string;
  context: string;
  confirmLabel: string;
  busy: boolean;
  error?: string;
  tone: "attention" | "danger";
}>();

const emit = defineEmits<{
  close: [];
  confirm: [];
}>();
</script>

<template>
  <div class="modal-backdrop provider-confirm-backdrop" role="presentation" @mousedown.self="!busy && emit('close')">
    <section class="editor-dialog provider-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-confirm-title" aria-describedby="provider-confirm-description">
      <header>
        <div><h2 id="provider-confirm-title">{{ title }}</h2><p id="provider-confirm-description">{{ message }}</p></div>
        <m3e-icon-button data-dialog-close aria-label="关闭确认对话框" :disabled="busy" @click="emit('close')"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>
      <div class="provider-confirm-impact" :class="tone" role="status">
        <m3e-icon :name="tone === 'danger' ? 'warning' : 'sync_problem'" aria-hidden="true"></m3e-icon>
        <div><strong>影响范围</strong><p>{{ context }}</p></div>
      </div>
      <p v-if="error" class="provider-confirm-error" role="alert"><m3e-icon name="error" aria-hidden="true"></m3e-icon><span>{{ error }}</span></p>
      <footer>
        <m3e-button data-dialog-close autofocus variant="text" type="button" :disabled="busy" @click="emit('close')">取消</m3e-button>
        <m3e-button variant="filled" type="button" :disabled="busy" @click="emit('confirm')">{{ busy ? '正在处理…' : confirmLabel }}</m3e-button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.provider-confirm-dialog { width: min(100%, 500px); }
.provider-confirm-dialog header > div { min-width: 0; }
.provider-confirm-dialog :deep(m3e-icon-button) { --m3e-icon-button-icon-size: 20px; flex: 0 0 44px; overflow: hidden; }
.provider-confirm-dialog :deep(m3e-button) { min-height: 44px; }
.provider-confirm-impact { min-width: 0; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: start; gap: 10px; border-radius: 8px; padding: 12px; line-height: 1.5; }
.provider-confirm-impact.attention { color: var(--md-sys-color-on-tertiary-container, var(--app-text)); background: var(--md-sys-color-tertiary-container, var(--app-surface-high)); }
.provider-confirm-impact.danger { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); border: 1px solid var(--md-sys-color-error, #ba1a1a); }
.provider-confirm-impact > m3e-icon, .provider-confirm-error > m3e-icon { --m3e-icon-size: 20px; }
.provider-confirm-impact > div { min-width: 0; display: grid; gap: 4px; }
.provider-confirm-impact p { color: inherit; overflow-wrap: anywhere; }
.provider-confirm-error { min-height: 48px; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 10px; border-radius: 8px; padding: 10px 12px; color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); }
.provider-confirm-dialog footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 20px; }
@media (max-width: 700px) {
  .provider-confirm-backdrop { align-items: center; padding: 8px; }
  .editor-dialog.provider-confirm-dialog { width: 100%; max-height: calc(100dvh - 16px); border-radius: 16px; padding: 16px; }
}
@media (max-width: 420px) {
  .provider-confirm-dialog footer { align-items: stretch; flex-direction: column-reverse; }
  .provider-confirm-dialog footer m3e-button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .provider-confirm-dialog * { transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
</style>
