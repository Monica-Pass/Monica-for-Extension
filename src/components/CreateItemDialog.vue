<script setup lang="ts">
import { computed } from "vue";
import { tr } from "../i18n";
import { createItemGroups, type CreateItemType } from "../manager/create-items";

const emit = defineEmits<{ cancel: []; select: [kind: CreateItemType] }>();
const groups = computed(createItemGroups);
</script>

<template>
  <m3e-dialog v-material-dialog open class="material-dialog material-editor-dialog" dismissible :close-label="tr('关闭')" @closed.self="emit('cancel')">
    <span slot="header">{{ tr('新建项目') }}</span>
    <p class="editor-hint">{{ tr('选择要保存的内容') }}</p>
    <div class="create-type-groups">
      <section v-for="group in groups" :key="group.label">
        <h3>{{ group.label }}</h3>
        <m3e-action-list variant="segmented">
          <m3e-list-action v-for="item in group.items" :key="item.kind" @click="emit('select', item.kind as CreateItemType)">
            <m3e-icon slot="leading" :name="item.icon" aria-hidden="true" />
            {{ item.label }}
            <span slot="supporting-text">{{ item.description }}</span>
            <m3e-icon slot="trailing" name="chevron_right" aria-hidden="true" />
          </m3e-list-action>
        </m3e-action-list>
      </section>
    </div>
  </m3e-dialog>
</template>
