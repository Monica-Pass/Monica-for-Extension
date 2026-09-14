import "@m3e/web/form-field";
import "@m3e/web/select";
import "@m3e/web/search";
import type { M3eListActionElement } from "@m3e/web/list";
import type { M3eOptionElement } from "@m3e/web/option";
import type { App, ObjectDirective } from "vue";

// M3E's documented form-field composition uses native input/textarea controls.
// Its select adds a Popover option panel; older browsers keep the native select
// inside the same official form-field, with the same controlled option values.
export const materialSelectTag = typeof HTMLElement.prototype.showPopover === "function" ? "m3e-select" : "select";
export const materialOptionTag = materialSelectTag === "m3e-select" ? "m3e-option" : "option";

export function restoreMaterialSelection(control: HTMLElement, value: string) {
  // Select.value is read-only in M3E; selection is owned by its options.
  for (const option of control.querySelectorAll<HTMLElement & { value: string; selected: boolean }>("option, m3e-option")) option.selected = option.value === value;
}

let nextFieldId = 0;
function associateLabel(field: HTMLElement) {
  const control = field.querySelector<HTMLElement>("input, textarea, select, m3e-select");
  const label = field.querySelector<HTMLLabelElement>(":scope > label[slot='label']");
  if (!control || !label) return;
  control.id ||= `monica-field-${++nextFieldId}`;
  label.htmlFor = control.id;
  label.id ||= `${control.id}-label`;
  if (control.localName === "m3e-select" && !control.hasAttribute("aria-label")) control.setAttribute("aria-labelledby", label.id);
}
// M3E handles Esc on the select itself. Stop it after that handler, before the
// containing dialog's handler or the browser's dialog cancellation runs.
const pickerEscapes = new WeakSet<KeyboardEvent>();
function rememberSelectEscape(event: KeyboardEvent) {
  if (event.key === "Escape" && (event.currentTarget as HTMLElement).getAttribute("aria-expanded") === "true") pickerEscapes.add(event);
}
function containSelectEscape(event: KeyboardEvent) {
  if (!pickerEscapes.has(event)) return;
  event.stopPropagation();
  event.preventDefault();
}
function connectField(field: HTMLElement) {
  associateLabel(field);
  field.querySelector("m3e-select")?.addEventListener("keydown", rememberSelectEscape as EventListener, true);
  field.querySelector("m3e-select")?.addEventListener("keydown", containSelectEscape as EventListener);
  // Vue updates an existing text node when a translation or source name
  // changes. That does not emit slotchange, which M3E uses to cache labels.
  const options = [...field.querySelectorAll<M3eOptionElement>("m3e-option")];
  if (!options.length) return;
  void Promise.all(options.map(async option => {
      await option.updateComplete;
      if (option.isConnected && option.label.trim() !== option.textContent?.trim()) {
        option.shadowRoot?.querySelector("slot")?.dispatchEvent(new Event("slotchange"));
        return true;
      }
      return false;
    })).then(changes => {
      const select = field.querySelector("m3e-select");
      if (!select?.isConnected || !changes.some(Boolean)) return;
      // Select caches a cloned menu and observes childList, not characterData.
      // Notify that observer once, without replacing Vue-owned option nodes.
      const marker = document.createComment("refresh-option-labels");
      select.append(marker);
      marker.remove();
    });
}
const fieldLabel: ObjectDirective<HTMLElement> = {
  beforeMount: associateLabel,
  mounted: connectField,
  updated: connectField,
  beforeUnmount: field => {
    field.querySelector("m3e-select")?.removeEventListener("keydown", rememberSelectEscape as EventListener, true);
    field.querySelector("m3e-select")?.removeEventListener("keydown", containSelectEscape as EventListener);
  }
};

function associateChoice(label: HTMLLabelElement) {
  const control = label.querySelector<HTMLElement>("m3e-checkbox, m3e-radio");
  if (!control) return;
  control.id ||= `monica-choice-${++nextFieldId}`;
  label.id ||= `${control.id}-label`;
  label.htmlFor = control.id;
  if (!control.hasAttribute("aria-label")) control.setAttribute("aria-labelledby", label.id);
}
const choiceLabel: ObjectDirective<HTMLLabelElement> = { beforeMount: associateChoice, mounted: associateChoice, updated: associateChoice };

// List-action's focusable button lives in its shadow tree. Keep accessible
// names and expansion state on that button, rather than its structural host.
type ListActionSemantics = string | { label?: string; expanded: boolean };
async function associateAction(action: M3eListActionElement, semantics: ListActionSemantics) {
  await action.updateComplete;
  const label = typeof semantics === "string" ? semantics : semantics.label;
  if (label) action.button?.setAttribute("aria-label", label);
  if (typeof semantics !== "string") action.button?.setAttribute("aria-expanded", String(semantics.expanded));
}
const listAction: ObjectDirective<M3eListActionElement, ListActionSemantics> = {
  mounted: (action, binding) => { void associateAction(action, binding.value); },
  updated: (action, binding) => { void associateAction(action, binding.value); }
};

export function installMaterialControls(app: App) {
  app.directive("field-label", fieldLabel);
  app.directive("choice-label", choiceLabel);
  app.directive("list-action", listAction);
}
