<script setup lang="ts">
import "@m3e/web/split-button";
import "@m3e/web/menu";
import type { M3eMenuElement } from "@m3e/web/menu";
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { tr } from "../i18n";
import { createItemGroups, type CreateItemType } from "../manager/create-items";

const props = defineProps<{ context: string; currentType?: CreateItemType; label: string }>();
const emit = defineEmits<{ primary: []; browse: []; select: [kind: CreateItemType] }>();
const supportsMenu = typeof HTMLElement.prototype.showPopover === "function";
const groups = computed(createItemGroups);
const currentItem = computed(() => groups.value.flatMap(group => group.items).find(item => item.kind === props.currentType));
const menu = ref<M3eMenuElement>();
const trigger = ref<HTMLElement>();
const menuId = `create-menu-${useId()}`;
let openFromEnd = false;

function createCurrent() {
  menu.value?.hide();
  emit("primary");
}

async function openWithKeyboard(event: KeyboardEvent) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  if (!supportsMenu) return emit("browse");
  sizeMenu();
  openFromEnd = event.key === "ArrowUp";
  await menu.value?.show(event.currentTarget as HTMLElement);
}

function finishKeyboardOpen() {
  if (!openFromEnd) return;
  openFromEnd = false;
  // Wait for the library's initial focus, then use its own keyboard manager.
  // Focusing early races its delayed first-item focus and steals later input.
  queueMicrotask(() => {
    if (menu.value?.isOpen) menu.value.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  });
}

function sizeMenu() {
  if (!trigger.value || !menu.value) return;
  const bounds = trigger.value.getBoundingClientRect();
  const above = bounds.top - 12;
  const below = window.innerHeight - bounds.bottom - 12;
  menu.value.positionY = below >= above ? "below" : "above";
  // M3E flips the anchor but does not constrain height to the available side.
  // Apply the constraint before positioning, so short windows can scroll it.
  menu.value.style.setProperty("--m3e-menu-container-max-height", `${Math.max(44, Math.max(above, below) - 4)}px`);
}

async function selectOther(kind: CreateItemType) {
  await menu.value?.hide(true);
  trigger.value?.focus({ preventScroll: true });
  emit("select", kind);
}

function resizeOpenMenu() {
  if (menu.value?.isOpen) sizeMenu();
}
onMounted(() => window.addEventListener("resize", resizeOpenMenu));

// Menus belong to their page context and cannot outlive it.
watch(() => props.context, () => menu.value?.hide());
onBeforeUnmount(() => {
  menu.value?.hide();
  window.removeEventListener("resize", resizeOpenMenu);
});
</script>

<template>
  <m3e-split-button class="create-split" variant="filled" size="small" :aria-label="tr('新建项目')">
    <m3e-button slot="leading-button" class="appbar-create" :aria-label="label" :title="currentItem ? `${tr('新建')} · ${currentItem.label}` : tr('新建项目')" @click="createCurrent">
      <m3e-icon slot="icon" name="add" />
      <span class="appbar-action-label">{{ tr('新建') }}<span v-if="currentItem" class="create-type-label">{{ currentItem.label }}</span></span>
    </m3e-button>
    <m3e-icon-button ref="trigger" slot="trailing-button" class="create-menu-trigger" :aria-label="tr('选择新建类型')" :aria-haspopup="supportsMenu ? 'menu' : 'dialog'" @click.capture="sizeMenu" @click="!supportsMenu && emit('browse')" @keydown="openWithKeyboard">
      <m3e-icon name="keyboard_arrow_down" />
      <m3e-menu-trigger v-if="supportsMenu" :for="menuId" />
    </m3e-icon-button>
  </m3e-split-button>
  <m3e-menu v-if="supportsMenu" :id="menuId" ref="menu" class="create-type-menu" position-x="before" :aria-label="tr('选择新建类型')" @focusin="finishKeyboardOpen" @toggle="($event as ToggleEvent).newState === 'closed' && (openFromEnd = false)">
    <m3e-menu-item-group v-for="group in groups" :key="group.label" :aria-label="group.label">
      <span class="m3-menu-group-label" aria-hidden="true">{{ group.label }}</span>
      <m3e-menu-item v-for="item in group.items" :key="item.kind" :aria-label="item.label" :data-create-type="item.kind" :aria-current="item.kind === currentType ? 'true' : undefined" @click="selectOther(item.kind)">
        <m3e-icon slot="icon" :name="item.icon" />{{ item.label }}
        <m3e-icon v-if="item.kind === currentType" slot="trailing-icon" name="check" />
      </m3e-menu-item>
    </m3e-menu-item-group>
  </m3e-menu>
</template>
