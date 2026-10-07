import { M3eInteractivityChecker } from "@m3e/web/core/a11y";
import { M3eDialogElement } from "@m3e/web/dialog";
import { css } from "lit";
import type { App, ObjectDirective } from "vue";

// Dialog has no padding/close-button parts. Bound that geometry in pixels so
// enlarging text does not also double the chrome and push actions offscreen.
// Keep the library's native modal, scroll container, surface and transitions.
M3eDialogElement.elementStyles = [...M3eDialogElement.elementStyles, css`
  .base { box-sizing: border-box; max-height: calc(100dvh - 24px); }
  .header { padding: 24px 24px 16px; align-items: flex-start; min-width: 0; }
  ::slotted([slot="header"]) { min-width: 0; overflow-wrap: anywhere; }
  .content { min-width: 0; min-height: 0; flex: 1 1 auto; padding-inline: 24px; }
  .actions { flex: none; padding: 16px 24px 24px; }
  .close {
    width: 44px; height: 44px; min-width: 44px; min-height: 44px; flex: 0 0 44px;
    --m3e-icon-button-container-height: 44px;
    --m3e-icon-button-default-leading-space: 10px;
    --m3e-icon-button-default-trailing-space: 10px;
    --m3e-icon-button-icon-size: 24px;
  }
  @media (max-width: 600px), (max-height: 600px) {
    .header { padding: 16px 16px 12px; }
    .content { padding-inline: 16px; }
    .actions { padding: 12px 16px 16px; }
  }
  @media (max-width: 580px) {
    :host(.material-editor-dialog) .base {
      inset: 0; margin: 0; width: 100%; min-width: 0; max-width: 100%;
      height: 100dvh; max-height: 100dvh; border-radius: 0;
    }
    :host(.material-editor-dialog) .header { padding: 12px; align-items: center; }
    :host(.material-editor-dialog) .content { padding-inline: 12px; }
    :host(.material-editor-dialog) .actions { padding: 12px 12px max(12px, env(safe-area-inset-bottom)); }
  }
`];

// @m3e/web 2.6.1's focus trap skips slots directly inside a shadow root,
// including dialog content. Preserve its modal and focus behavior, correcting
// only Tab at either boundary with the actual composed-tree order.
function tabStops(root: Element | ShadowRoot, parents: Element[] = []): HTMLElement[] {
  const stops: HTMLElement[] = [];
  const children = root instanceof HTMLSlotElement ? root.assignedElements({ flatten: true }) : [...root.children];
  for (const element of children) {
    if (element.matches("[inert], [aria-hidden='true']")) continue;
    if (element instanceof HTMLElement && element.tabIndex >= 0 && M3eInteractivityChecker.isFocusable(element, parents)) stops.push(element);
    stops.push(...tabStops(element.shadowRoot ?? element, [...parents, element]));
  }
  return stops;
}

function wrapDialogFocus(event: KeyboardEvent) {
  if (event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const dialog = event.currentTarget as HTMLElement;
  const surface = dialog.shadowRoot?.querySelector("dialog[open]");
  if (!surface) return;
  const stops = tabStops(surface);
  const first = stops[0];
  const last = stops[stops.length - 1];
  const focused = event.composedPath()[0];
  const destination = event.shiftKey && focused === first ? last : !event.shiftKey && focused === last ? first : undefined;
  if (!destination) return;
  event.preventDefault();
  destination.focus();
}

const materialDialog: ObjectDirective<HTMLElement> = {
  mounted: dialog => dialog.addEventListener("keydown", wrapDialogFocus),
  beforeUnmount: dialog => dialog.removeEventListener("keydown", wrapDialogFocus)
};

export function installMaterialDialogs(app: App) {
  app.directive("material-dialog", materialDialog);
}
