import "@m3e/web/menu";
import { css, type LitElement } from "lit";

// Keep Material's focus and positioning behavior while allowing long labels
// and enlarged text. The library does not expose parts for its content wrapper.
for (const name of ["m3e-menu-item", "m3e-menu-item-radio", "m3e-menu-item-checkbox"]) {
  const MenuItem = customElements.get(name) as typeof LitElement;
  MenuItem.elementStyles = [...MenuItem.elementStyles, css`
    :host { height: auto; min-height: var(--m3e-menu-item-container-height, 44px); }
    .base { min-height: var(--m3e-menu-item-container-height, 44px); }
    .wrapper { min-width: 0; padding-block: 10px; }
    .content { white-space: normal; overflow: visible; overflow-wrap: anywhere; }
    .touch { inset: 0; height: 100%; }
  `];
}
const Menu = customElements.get("m3e-menu") as typeof LitElement;
Menu.elementStyles = [...Menu.elementStyles, css`
  @media (prefers-reduced-motion: reduce) {
    :host, :host(:popover-open) { animation: none !important; transition: none !important; }
  }
`];
