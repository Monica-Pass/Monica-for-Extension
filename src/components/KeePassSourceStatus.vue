<script setup lang="ts">
import { computed } from 'vue';
import { tr } from '../i18n';
import type { KeePassRemoteManagerStatus } from '../providers/keepass/keepass-remote-session';
const props = defineProps<{ status?: KeePassRemoteManagerStatus }>();
const rows = computed(() => {
  const status = props.status;
  return [
    { label: '连接状态', icon: status?.sessionState === 'unlocked' ? 'lock_open' : 'lock', value: status?.sessionState === 'unlocked' ? '已解锁' : status?.sessionState === 'restorable' ? '可恢复' : '需重新连接' },
    { label: '离线访问', icon: 'offline_pin', value: status?.workingCopyState === 'ready' && status.sessionState !== 'reconnect-required' ? '可用' : '需重新连接' },
    { label: '云端保存', icon: status?.publicationState === 'clean' && status.remoteBaselineState === 'available' ? 'cloud_done' : 'cloud_upload', value: status?.publicationState === 'pending-confirmation' ? '结果待确认' : status?.publicationState === 'local-changes' ? '本机有修改' : status?.remoteBaselineState === 'available' && status.workingCopyState === 'ready' ? '已同步' : '尚未同步' }
  ];
});
</script>

<template>
  <dl class="keepass-source-status" :aria-label="status?.sourceMode === 'onedrive' ? tr('KeePass OneDrive 状态摘要') : tr('KeePass WebDAV 状态摘要')" aria-live="polite">
    <div v-for="row in rows" :key="row.label" class="keepass-source-status-row">
      <dt><m3e-icon :name="row.icon" aria-hidden="true" /><span>{{ tr(row.label) }}</span></dt>
      <dd>{{ tr(row.value) }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.keepass-source-status { display: grid; gap: 4px; margin: 0; }
.keepass-source-status-row { display: grid; align-items: center; grid-template-columns: 40px minmax(0, 1fr); column-gap: 12px; min-height: 64px; padding: 12px 16px; border-radius: 4px; background: var(--md-sys-color-surface-container-high, var(--app-surface-2)); }
.keepass-source-status-row:first-child { border-start-start-radius: 24px; border-start-end-radius: 24px; }
.keepass-source-status-row:last-child { border-end-start-radius: 24px; border-end-end-radius: 24px; }
dt { display: contents; font-size: 14px; color: var(--app-muted); }
dt > m3e-icon { grid-column: 1; grid-row: 1 / 3; height: 40px; display: grid; place-items: center; border-radius: 14px; color: var(--md-sys-color-on-secondary-container); background: var(--md-sys-color-secondary-container); }
dt > span, dd { grid-column: 2; overflow-wrap: anywhere; }
dd { margin: 2px 0 0; font-size: 16px; font-weight: 550; }
</style>
