<script setup lang="ts">
import { useId } from "vue";
import type { LoginItem } from "../core/model";
import type { PasswordDisplayStack } from "../core/password-display-stacks";
import { vaultRowDomId } from "../core/dom-id";
import { tr } from "../i18n";
import WebsiteIcon from "./WebsiteIcon.vue";

defineProps<{ stacks: PasswordDisplayStack[]; busy: boolean; sourceLabel: (item: LoginItem) => string }>();
const emit = defineEmits<{ open: [item: LoginItem]; cover: [item: LoginItem] }>();
const uid = useId();
const rowId = (id: string) => vaultRowDomId(`display-stack-${uid}-${id}`);
const representative = (project: LoginItem[]) => project.find(item => item.isGroupCover === true) || project[0];
</script>
<template>
  <div class="password-stacks" data-password-stacks>
    <details v-for="stack in stacks" :key="stack.key" class="password-stack" :open="stack.projects.length === 1">
      <summary :aria-label="tr('展开 {0}', {0: stack.label})">
        <WebsiteIcon :item="stack.representative" />
        <span class="stack-heading"><strong>{{ stack.label }}</strong><small>{{ sourceLabel(stack.representative) }} · {{ tr('{0} 个项目 · {1} 条密码', {0: stack.projects.length, 1: stack.passwordCount}) }}</small><small v-if="stack.setting">{{ stack.setting === 'manual' ? tr('手动堆叠') : stack.setting === 'never' ? tr('永不堆叠') : tr('内部字段格式不受支持') }}</small></span>
        <m3e-icon class="stack-chevron" name="expand_more" aria-hidden="true" />
      </summary>
      <div class="stack-projects">
        <div v-for="project in stack.projects" :key="project[0].id" class="stack-project" :data-stack-project="project[0].id">
          <m3e-list-action :id="rowId(project[0].id)" role="presentation" class="stack-project-action"
            v-list-action="tr('查看{0}详情', {0: representative(project).title})" @click="emit('open', representative(project))">
            <WebsiteIcon slot="leading" :item="representative(project)" />
            <span>{{ representative(project).title }}</span>
            <span slot="supporting-text">{{ representative(project).username || tr('未填写用户名') }} · {{ tr('{0} 条密码', {0: project.length}) }}</span>
            <m3e-focus-ring :for="rowId(project[0].id)" inward />
          </m3e-list-action>
          <m3e-icon-button v-if="representative(project).uris.some(uri => uri.trim())" :disabled="busy" class="stack-cover"
            :aria-label="representative(project).isGroupCover ? tr('取消 {0} 的封面', {0: representative(project).title}) : tr('将 {0} 设为封面', {0: representative(project).title})"
            :title="representative(project).isGroupCover ? tr('当前封面') : tr('设为相同网站的封面')"
            :class="{selected: representative(project).isGroupCover}" @click="emit('cover', representative(project))">
            <m3e-icon name="push_pin" />
          </m3e-icon-button>
        </div>
      </div>
    </details>
    <div v-if="!stacks.length" class="empty-state"><m3e-icon name="search" /><h2>{{ tr('没有匹配项目') }}</h2><p>{{ tr('调整分类或快捷筛选条件。') }}</p></div>
  </div>
</template>
<style scoped>
.password-stacks { display: grid; gap: 12px; padding: 0 12px; min-width: 0; }
.password-stack { min-width: 0; background: var(--app-surface); border-radius: 24px; overflow: hidden; }
summary { display: flex; align-items: center; gap: 12px; padding: 16px 12px; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary:focus-visible { outline: 2px solid var(--app-primary); outline-offset: -3px; border-radius: 24px; }
.stack-heading { display: grid; gap: 4px; min-width: 0; flex: 1; }
.stack-heading strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stack-heading strong { font-weight: 500; }
.stack-heading small { color: var(--app-muted); font-size: .8rem; line-height: 1.4; overflow-wrap: anywhere; }
.stack-chevron { flex-shrink: 0; }
details[open] .stack-chevron { transform: rotate(180deg); }
.stack-projects { display: grid; gap: 4px; padding: 0 8px 8px; }
.stack-project { display: flex; align-items: center; min-width: 0; gap: 4px; background: var(--app-bg); border-radius: 4px; }
.stack-project:first-child { border-radius: 16px 16px 4px 4px; }
.stack-project:last-child { border-radius: 4px 4px 16px 16px; }
.stack-project:only-child { border-radius: 16px; }
.stack-project-action { position: relative; flex: 1; min-width: 0; --m3e-list-item-two-line-height: 72px; --m3e-list-item-container-shape: 16px; --m3e-list-item-leading-space: 12px; --m3e-list-item-trailing-space: 4px; }
.stack-project-action > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stack-project-action [slot="supporting-text"] { font-size: .8rem; }
.stack-cover { flex-shrink: 0; margin-right: 4px; }
.stack-cover.selected { color: var(--app-primary); background: var(--app-selected); border-radius: 50%; }
</style>
