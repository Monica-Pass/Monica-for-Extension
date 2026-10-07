<script setup lang="ts">
import { computed, useId } from 'vue';
import type { LoginItem } from '../core/model';
import { passwordProjectGroups } from '../core/password-project-view';
import { vaultRowDomId } from '../core/dom-id';
import { tr } from '../i18n';
const props = defineProps<{ itemId: string; members: LoginItem[] }>();
const emit = defineEmits<{ open: [item: LoginItem] }>();
const uid = useId();
const rowDomId = (id: string) => vaultRowDomId(`project-password-${uid}-${id}`);
const project = computed(() => passwordProjectGroups(props.members));
const groups = computed(() => project.value?.map((group, index) => ({
  id: group.id, label: group.label || tr('凭据组 {0}', {0: index + 1}), rows: group.rows.map(row => row.item)
})) ?? [{ id: 'legacy', label: tr('同一项目'), rows: props.members }]);
</script>
<template>
  <section class="detail-section project-navigation" data-project-navigation style="order:-3" :aria-label="tr('项目密码')">
    <p class="project-count">{{ project ? tr('{0} 个凭据组 · {1} 条密码', {0: project.length, 1: members.length}) : tr('{0} 条密码', {0: members.length}) }}</p>
    <div class="project-navigation-scroll">
    <section v-for="group in groups" :key="group.id" class="project-navigation-group" :data-project-group="group.id" :aria-label="group.label">
      <h3>{{ group.label }}</h3>
      <div class="project-navigation-rows">
        <m3e-list-action v-for="(row,index) in group.rows" :key="row.id" :id="rowDomId(row.id)"
          class="project-navigation-row" :class="{selected: row.id === itemId}" :data-password-member-id="row.id"
          v-list-action="{label: tr('{0} · 密码 {1}', {0: group.label, 1: index + 1}), current: row.id === itemId}"
          role="presentation" @click="emit('open', row)">
          <m3e-icon slot="leading" name="password" />
          <span>{{ tr('密码 {0}', {0: index + 1}) }}</span>
          <span slot="supporting-text" :title="row.username">{{ row.username || tr('未填写用户名') }}</span>
          <m3e-icon slot="trailing" :name="row.id === itemId ? 'check' : 'chevron_right'" />
          <m3e-focus-ring :for="rowDomId(row.id)" inward />
        </m3e-list-action>
      </div>
    </section>
    </div>
    <slot />
  </section>
</template>
<style scoped>
.project-navigation { display: grid; gap: 20px; }
.project-count { margin: 0; font-size: .875rem; color: var(--app-muted); }
.project-navigation-scroll { display: grid; gap: 20px; max-height: min(42dvh, 400px); overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scroll-padding-block: 8px; }
.project-navigation-group { min-width: 0; }
.project-navigation-group h3 { position: sticky; top: 0; z-index: 1; margin: 0; padding-bottom: 10px; background: var(--app-bg); font-size: 1rem; font-weight: 500; overflow-wrap: anywhere; }
.project-navigation-rows { display: grid; gap: 4px; }
.project-navigation-row { position: relative; width: 100%; min-width: 0;
  --m3e-list-item-two-line-height: 72px;
  --m3e-list-item-container-shape: 4px;
  --m3e-list-item-container-color: var(--app-surface);
  --m3e-list-item-leading-space: 12px;
  --m3e-list-item-trailing-space: 12px;
  --m3e-list-item-between-space: 12px;
}
.project-navigation-row:first-child { --m3e-list-item-container-shape: 24px 24px 4px 4px; }
.project-navigation-row:last-child { --m3e-list-item-container-shape: 4px 4px 24px 24px; }
.project-navigation-row:only-child { --m3e-list-item-container-shape: 24px; }
.project-navigation-row.selected { --m3e-list-item-container-color: var(--app-selected); }
.project-navigation-row [slot="supporting-text"] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
</style>
