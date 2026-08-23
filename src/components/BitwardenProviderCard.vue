<script setup lang="ts">
import { computed, ref } from "vue";
import type { ProviderAccount, ProviderConflictResolution, ProviderConflictSummary } from "../core/model";

interface ProviderQueueStatus {
  providerId: string;
  pending: number;
  failed: number;
  recovering?: number;
  maxAttempts: number;
  lastError?: string;
}

const props = defineProps<{
  provider: ProviderAccount;
  queue?: ProviderQueueStatus;
  conflicts: ProviderConflictSummary[];
  activeSync: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{
  sync: [provider: ProviderAccount];
  cancel: [provider: ProviderAccount];
  emptyRemote: [provider: ProviderAccount];
  resolveConflict: [conflict: ProviderConflictSummary, resolution: ProviderConflictResolution];
  folders: [provider: ProviderAccount];
  collections: [provider: ProviderAccount];
  relogin: [provider: ProviderAccount];
  logout: [provider: ProviderAccount];
  remove: [provider: ProviderAccount];
}>();

const conflictsExpanded = ref(false);

const conflictCount = computed(() => props.conflicts.length);
const compatibilityCount = computed(() => (props.provider.compatibility?.preservedUnsupportedRecords || 0) + (props.provider.compatibility?.unreadableRecords || 0));
const errors = computed(() => {
  const values = [props.provider.lastError, props.queue?.lastError]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim().replace(/\s+/g, " "));
  return [...new Set(values)].map((value) => value.length > 240 ? `${value.slice(0, 237)}…` : value);
});
const queuePending = computed(() => Math.max(0, props.queue?.pending || 0));
const queueFailed = computed(() => Math.max(0, props.queue?.failed || 0));
const queueRecovering = computed(() => Math.max(0, props.queue?.recovering || 0));
const queueHasActivity = computed(() => queuePending.value > 0 || queueFailed.value > 0 || queueRecovering.value > 0);
const authenticated = computed(() => props.provider.config.authenticated === true);
const accountState = computed(() => {
  const value = props.provider.config.accountState;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
});
const organizationCount = computed(() => Array.isArray(accountState.value?.organizations) ? accountState.value?.organizations.length : 0);
const policyCount = computed(() => Array.isArray(accountState.value?.policies) ? accountState.value?.policies.length : 0);

const stateClass = computed(() => {
  if (!authenticated.value) return "state-attention";
  if (props.activeSync) return "state-local-only";
  if (conflictCount.value > 0) return "state-conflict";
  if (props.provider.requiresEmptyRemoteConfirmation) return "state-attention";
  if (errors.value.length || queueFailed.value > 0) return "state-failed";
  if (compatibilityCount.value > 0 || queueHasActivity.value) return "state-attention";
  return "state-healthy";
});

const stateLabel = computed(() => {
  if (!authenticated.value) return "已退出";
  if (props.activeSync) return "正在同步";
  if (conflictCount.value > 0) return `${conflictCount.value} 个冲突`;
  if (props.provider.requiresEmptyRemoteConfirmation) return "等待空库确认";
  if (errors.value.length || queueFailed.value > 0) return "需要处理";
  if (queueRecovering.value > 0) return "正在恢复";
  if (queuePending.value > 0) return `${queuePending.value} 项待同步`;
  if (compatibilityCount.value > 0) return "兼容模式";
  return props.provider.lastSyncAt ? "已同步" : "已连接";
});

const lastSyncLabel = computed(() => {
  if (!props.provider.lastSyncAt) return "尚未同步";
  const timestamp = new Date(props.provider.lastSyncAt);
  return Number.isNaN(timestamp.getTime()) ? "时间不可用" : timestamp.toLocaleString();
});

const serverLabel = computed(() => {
  const raw = typeof props.provider.config.vaultUrl === "string" ? props.provider.config.vaultUrl.trim() : "";
  if (!raw) return "Bitwarden 服务";
  try {
    const url = new URL(raw);
    return url.host || "Bitwarden 服务";
  } catch {
    return raw.replace(/^https?:\/\//i, "").split("/")[0] || "Bitwarden 服务";
  }
});

const emailLabel = computed(() => {
  const value = typeof props.provider.config.email === "string" ? props.provider.config.email.trim() : "";
  return value || "未显示账号邮箱";
});

const visibleConflicts = computed(() => conflictsExpanded.value ? props.conflicts : props.conflicts.slice(0, 2));

function queueLabel(): string {
  if (!props.queue) return "队列状态不可用";
  if (!queueHasActivity.value) return "没有待处理操作";
  const parts: string[] = [];
  if (queuePending.value) parts.push(`${queuePending.value} 待同步`);
  if (queueRecovering.value) parts.push(`${queueRecovering.value} 恢复中`);
  if (queueFailed.value) parts.push(`${queueFailed.value} 失败`);
  return parts.join(" · ");
}

function queueDetail(): string {
  if (!props.queue) return "后台未返回队列详情";
  if (queueFailed.value) return `失败操作最高已尝试 ${Math.max(1, props.queue.maxAttempts || 1)} 次；失败项会保留并等待手动重试，不会静默覆盖远端数据。`;
  if (queueRecovering.value) return "正在核对远端响应，避免 MV3 Service Worker 重启造成重复写入。";
  if (queuePending.value) return "本地修改已加密排队，完成确认前不会宣称同步成功。";
  return "队列已清空";
}

function conflictSides(conflict: ProviderConflictSummary): string {
  if (conflict.local && conflict.remote) return "浏览器版本与 Bitwarden 版本都存在";
  if (conflict.local) return "浏览器版本存在；远端已删除";
  if (conflict.remote) return "Bitwarden 版本存在；浏览器版本已删除";
  return "仅保留冲突元数据，无法安全选择版本";
}

function toggleConflicts() {
  conflictsExpanded.value = !conflictsExpanded.value;
}
</script>

<template>
  <section class="motion-card source-card bitwarden-provider-card" :aria-label="`${provider.name} Bitwarden 密码源`">
    <div class="stack">
      <div class="bitwarden-source-heading">
        <div class="bitwarden-source-title">
          <span class="source-icon" aria-hidden="true"><m3e-icon name="shield"></m3e-icon></span>
          <div class="bitwarden-source-copy">
            <h2>{{ provider.name }}</h2>
            <p><span>{{ emailLabel }}</span><span aria-hidden="true"> · </span><span>{{ serverLabel }}</span></p>
          </div>
        </div>
        <span class="state" :class="stateClass" role="status">{{ stateLabel }}</span>
      </div>

      <div class="bitwarden-status-grid" aria-label="Bitwarden 状态摘要">
        <div><span>最近同步</span><strong>{{ lastSyncLabel }}</strong><small>{{ props.provider.lastSyncAt ? '已收到服务器确认' : '连接成功后首次同步' }}</small></div>
        <div><span>本地队列</span><strong>{{ queueLabel() }}</strong><small>{{ queue?.maxAttempts ? `最高已尝试 ${queue.maxAttempts} 次` : '后台加密队列' }}</small></div>
        <div><span>组织</span><strong>{{ organizationCount }} 个</strong><small>Collection 路由按权限处理</small></div>
        <div><span>策略</span><strong>{{ policyCount }} 个</strong><small>仅保存非敏感摘要</small></div>
      </div>

      <div v-if="errors.length" class="bitwarden-error-panel" role="alert">
        <m3e-icon name="error" aria-hidden="true"></m3e-icon>
        <div><strong>同步需要处理</strong><ul><li v-for="message in errors" :key="message">{{ message }}</li></ul><p>敏感字段、令牌和附件内容不会出现在此状态中。</p></div>
        <m3e-button v-if="!activeSync" variant="tonal" type="button" :disabled="busy" @click="emit('sync', provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>重试同步</m3e-button>
      </div>

      <div v-if="provider.requiresEmptyRemoteConfirmation" class="bitwarden-empty-warning" role="alert">
        <m3e-icon name="cloud_off" aria-hidden="true"></m3e-icon>
        <div><strong>服务器返回空密码库</strong><p>本地已有同步基线。只有确认服务器确实被清空后，才会采用空库结果；未确认前不会移除本地项目。</p></div>
        <m3e-button variant="tonal" type="button" :disabled="busy || activeSync" @click="emit('emptyRemote', provider)">查看并确认空库</m3e-button>
      </div>

      <div v-if="compatibilityCount" class="bitwarden-compatibility-panel" role="status">
        <m3e-icon name="info" aria-hidden="true"></m3e-icon>
        <div><strong>兼容模式保留 {{ compatibilityCount }} 个项目</strong><p><template v-if="provider.compatibility?.preservedUnsupportedRecords">{{ provider.compatibility.preservedUnsupportedRecords }} 个未来类型仅保存原始 Cipher。</template><template v-if="provider.compatibility?.unreadableRecords">{{ provider.compatibility?.preservedUnsupportedRecords ? ' ' : '' }}{{ provider.compatibility.unreadableRecords }} 个项目暂时无法解密。</template>这些记录不会自动填充或改写。</p></div>
      </div>

      <div v-if="queueHasActivity" class="bitwarden-recovery-panel" :class="{ failed: queueFailed > 0 }" role="status" aria-live="polite">
        <m3e-icon :name="queueFailed ? 'sync_problem' : queueRecovering ? 'restore' : 'sync'" aria-hidden="true"></m3e-icon>
        <div><strong>{{ activeSync ? '正在同步 Bitwarden' : queueFailed ? '有同步操作需要恢复' : '修改正在安全排队' }}</strong><p>{{ queueDetail() }}</p></div>
        <m3e-button v-if="!activeSync" variant="tonal" type="button" :disabled="busy" @click="emit('sync', provider)">{{ queueFailed ? '重试失败操作' : '立即同步' }}</m3e-button>
        <m3e-button v-else variant="text" type="button" @click="emit('cancel', provider)"><m3e-icon slot="icon" name="cancel"></m3e-icon>取消同步</m3e-button>
      </div>

      <section v-if="conflicts.length" class="bitwarden-conflict-group" :aria-label="`${provider.name} 同步冲突`">
        <div class="bitwarden-conflict-heading"><div><strong>同步冲突</strong><p>选择一个明确版本；敏感字段不会在此处显示。</p></div><span class="state state-conflict">{{ conflicts.length }} 个</span></div>
        <div class="bitwarden-conflict-list">
          <article v-for="conflict in visibleConflicts" :key="conflict.id" class="provider-conflict">
            <div class="bitwarden-conflict-copy"><strong>{{ conflict.local?.title || conflict.remote?.title || '密码源级冲突' }}</strong><p>{{ conflict.reason }}</p><small>{{ conflictSides(conflict) }} · 检测于 {{ new Date(conflict.detectedAt).toLocaleString() }}</small></div>
            <div v-if="conflict.local || conflict.remote" class="conflict-actions">
              <m3e-button v-if="conflict.local" variant="tonal" type="button" :disabled="busy || activeSync" @click="emit('resolveConflict', conflict, 'keep-local')">保留浏览器版本</m3e-button>
              <m3e-button variant="text" type="button" :disabled="busy || activeSync" @click="emit('resolveConflict', conflict, 'use-remote')">{{ conflict.remote ? '采用 Bitwarden 版本' : '接受远端删除' }}</m3e-button>
            </div>
          </article>
        </div>
        <m3e-button v-if="conflicts.length > 2" class="bitwarden-conflict-toggle" variant="text" type="button" :aria-expanded="conflictsExpanded" @click="toggleConflicts">{{ conflictsExpanded ? '收起其余冲突' : `查看其余 ${conflicts.length - 2} 个冲突` }}</m3e-button>
      </section>

      <details class="bitwarden-capability-details">
        <summary><m3e-icon name="info" aria-hidden="true"></m3e-icon><span>支持范围与安全边界</span><m3e-icon class="details-chevron" name="expand_more" aria-hidden="true"></m3e-icon></summary>
        <p>支持登录、卡片、身份、笔记、TOTP、Passkey、SSH、加密附件与安全发送；归档和回收站项目不会进入自动填充。Popup 与内容脚本只收到候选摘要，密钥、令牌、原始 Cipher 和附件只在后台管理边界内解密。</p>
      </details>

      <div class="bitwarden-source-actions">
        <div class="source-actions-primary">
          <m3e-button v-if="activeSync" variant="text" type="button" @click="emit('cancel', provider)"><m3e-icon slot="icon" name="cancel"></m3e-icon>取消同步</m3e-button>
          <m3e-button v-else variant="filled" type="button" :disabled="busy || !authenticated" @click="emit('sync', provider)"><m3e-icon slot="icon" name="sync"></m3e-icon>{{ queueFailed ? '重试同步' : '立即同步' }}</m3e-button>
        </div>
        <div class="source-actions-routing" aria-label="Bitwarden 路由管理">
          <m3e-button variant="tonal" type="button" :disabled="busy || activeSync" @click="emit('folders', provider)"><m3e-icon slot="icon" name="folder_managed"></m3e-icon>管理文件夹</m3e-button>
          <m3e-button variant="tonal" type="button" :disabled="busy || activeSync" @click="emit('collections', provider)"><m3e-icon slot="icon" name="folder_shared"></m3e-icon>管理 Collection</m3e-button>
        </div>
        <div class="source-actions-account" aria-label="Bitwarden 账号操作">
          <m3e-icon-button aria-label="重新登录 Bitwarden" :disabled="activeSync" @click="emit('relogin', provider)"><m3e-icon name="login"></m3e-icon></m3e-icon-button>
          <m3e-icon-button v-if="authenticated" aria-label="退出 Bitwarden 账户" :disabled="activeSync" @click="emit('logout', provider)"><m3e-icon name="lock"></m3e-icon></m3e-icon-button>
          <m3e-icon-button aria-label="移除 Bitwarden" :disabled="activeSync" @click="emit('remove', provider)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bitwarden-provider-card { min-width: 0; border-radius: 8px; padding: 20px; overflow: hidden; color: var(--md-sys-color-on-surface, var(--app-text)); background: color-mix(in srgb, var(--md-sys-color-surface-container, var(--app-surface)) 88%, var(--app-bg)); }
.bitwarden-provider-card > .stack { min-width: 0; width: 100%; grid-template-columns: minmax(0, 1fr); }
.bitwarden-source-heading { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.bitwarden-source-title { min-width: 0; display: flex; align-items: flex-start; gap: 12px; }
.bitwarden-source-copy { min-width: 0; display: grid; gap: 4px; }
.bitwarden-source-copy h2 { overflow-wrap: anywhere; }
.bitwarden-source-copy p { display: flex; flex-wrap: wrap; gap: 0 4px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); line-height: 1.45; }
.bitwarden-source-copy p span { overflow-wrap: anywhere; }
.bitwarden-provider-card :deep(.source-icon) { flex: 0 0 48px; }
.bitwarden-provider-card :deep(.source-icon m3e-icon) { --m3e-icon-size: 24px; }
.bitwarden-provider-card :deep(m3e-icon-button) { --m3e-icon-button-icon-size: 20px; }
.bitwarden-provider-card :deep(m3e-button) { --m3e-button-icon-size: 20px; min-height: 44px; }
.bitwarden-status-grid { min-width: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-radius: 8px; overflow: hidden; }
.bitwarden-status-grid > div { min-width: 0; display: grid; gap: 3px; padding: 10px 12px; }
.bitwarden-status-grid > div + div { border-left: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); }
.bitwarden-status-grid span, .bitwarden-status-grid small { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.bitwarden-status-grid strong, .bitwarden-status-grid small { overflow-wrap: anywhere; }
.bitwarden-status-grid strong { line-height: 1.35; }
.bitwarden-error-panel, .bitwarden-empty-warning, .bitwarden-compatibility-panel, .bitwarden-recovery-panel { min-width: 0; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: start; gap: 10px; border-radius: 8px; padding: 12px; line-height: 1.5; }
.bitwarden-error-panel { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); border: 1px solid var(--md-sys-color-error, #ba1a1a); }
.bitwarden-empty-warning, .bitwarden-recovery-panel { color: var(--md-sys-color-on-tertiary-container, var(--app-text)); background: var(--md-sys-color-tertiary-container, var(--app-surface-high)); border: 1px solid color-mix(in srgb, var(--md-sys-color-tertiary, var(--app-primary)) 40%, transparent); }
.bitwarden-compatibility-panel { color: var(--md-sys-color-on-secondary-container, var(--app-text)); background: var(--md-sys-color-secondary-container, var(--app-selected)); }
.bitwarden-recovery-panel.failed { color: var(--md-sys-color-on-error-container, var(--app-text)); background: var(--md-sys-color-error-container, var(--app-surface-high)); border-color: var(--md-sys-color-error, #ba1a1a); }
.bitwarden-error-panel > m3e-icon, .bitwarden-empty-warning > m3e-icon, .bitwarden-compatibility-panel > m3e-icon, .bitwarden-recovery-panel > m3e-icon { --m3e-icon-size: 20px; }
.bitwarden-error-panel > div, .bitwarden-empty-warning > div, .bitwarden-compatibility-panel > div, .bitwarden-recovery-panel > div { min-width: 0; display: grid; gap: 4px; }
.bitwarden-error-panel p, .bitwarden-empty-warning p, .bitwarden-compatibility-panel p, .bitwarden-recovery-panel p { color: inherit; }
.bitwarden-error-panel ul { margin: 0; padding-left: 18px; }
.bitwarden-error-panel li { overflow-wrap: anywhere; }
.bitwarden-conflict-group { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; border: 1px solid color-mix(in srgb, var(--md-sys-color-tertiary, var(--app-primary)) 36%, var(--md-sys-color-outline-variant, var(--app-outline))); border-radius: 8px; padding: 12px; background: color-mix(in srgb, var(--md-sys-color-tertiary-container, var(--app-surface-high)) 34%, transparent); }
.bitwarden-conflict-heading { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.bitwarden-conflict-heading > div { min-width: 0; display: grid; gap: 3px; }
.bitwarden-conflict-heading p { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.bitwarden-conflict-list { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.bitwarden-conflict-list .provider-conflict { min-width: 0; grid-template-columns: minmax(0, 1fr); border: 1px solid color-mix(in srgb, var(--md-sys-color-tertiary, var(--app-primary)) 30%, var(--md-sys-color-outline-variant, var(--app-outline))); background: var(--md-sys-color-surface-container-lowest, var(--app-surface)); }
.bitwarden-conflict-copy { min-width: 0; display: grid; gap: 5px; }
.bitwarden-conflict-copy p, .bitwarden-conflict-copy small { color: var(--md-sys-color-on-surface-variant, var(--app-muted)); overflow-wrap: anywhere; }
.bitwarden-conflict-copy small { line-height: 1.4; }
.bitwarden-conflict-toggle { justify-self: start; }
.bitwarden-capability-details { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); padding-top: 2px; color: var(--md-sys-color-on-surface-variant, var(--app-muted)); }
.bitwarden-capability-details summary { min-height: 44px; display: grid; grid-template-columns: 20px minmax(0, 1fr) 20px; align-items: center; gap: 8px; cursor: pointer; list-style: none; font-weight: 600; }
.bitwarden-capability-details summary::-webkit-details-marker { display: none; }
.bitwarden-capability-details summary:focus-visible { outline: 3px solid var(--app-primary); outline-offset: 3px; border-radius: 8px; }
.bitwarden-capability-details summary > m3e-icon { --m3e-icon-size: 20px; }
.bitwarden-capability-details p { padding: 0 28px 8px; line-height: 1.5; }
.bitwarden-source-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.source-actions-primary, .source-actions-routing, .source-actions-account { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.source-actions-account { margin-left: auto; }
@media (max-width: 700px) {
  .bitwarden-source-heading { flex-wrap: wrap; }
  .bitwarden-source-heading > .state { margin-left: 60px; }
  .bitwarden-status-grid { grid-template-columns: 1fr; }
  .bitwarden-status-grid > div + div { border-top: 1px solid var(--md-sys-color-outline-variant, var(--app-outline)); border-left: 0; }
  .bitwarden-error-panel, .bitwarden-empty-warning, .bitwarden-compatibility-panel, .bitwarden-recovery-panel { grid-template-columns: 24px minmax(0, 1fr); }
  .bitwarden-error-panel > m3e-button, .bitwarden-empty-warning > m3e-button, .bitwarden-recovery-panel > m3e-button { grid-column: 1 / -1; width: 100%; }
  .bitwarden-conflict-list .conflict-actions { display: grid; grid-template-columns: minmax(0, 1fr); justify-content: stretch; }
  .bitwarden-conflict-list .conflict-actions m3e-button { min-width: 0; width: 100%; white-space: normal; }
  .bitwarden-source-actions { align-items: stretch; flex-direction: column; }
  .source-actions-primary, .source-actions-routing { width: 100%; }
  .source-actions-primary m3e-button, .source-actions-routing m3e-button { flex: 1 1 180px; }
  .source-actions-account { width: 100%; justify-content: flex-end; margin-left: 0; }
}
@media (max-width: 420px) {
  .bitwarden-source-title { gap: 8px; }
  .bitwarden-provider-card :deep(.source-icon) { flex-basis: 40px; width: 40px; height: 40px; }
  .bitwarden-source-heading > .state { margin-left: 48px; }
  .bitwarden-capability-details p { padding-inline: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .bitwarden-provider-card * { transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
</style>
