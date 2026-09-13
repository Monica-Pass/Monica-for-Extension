import "@m3e/web/button";
import "@m3e/web/icon-button";
import { css, type LitElement } from "lit";

// Install before Vue mounts either extension page. M3E exposes no CSS parts for
// its fixed-height, ellipsized label. Extend Lit's finalized styles once so long
// translations can wrap without replacing the component's form/keyboard logic.
const ActionButton = customElements.get("m3e-button") as typeof LitElement;
const IconButton = customElements.get("m3e-icon-button") as typeof LitElement;
// The library's 3rem invisible touch target grows to 96px at 200% text and
// overlaps adjacent actions. Our visible controls already provide a 44px target.
const controlGeometry = css`
  .base { display: flex; }
  .touch { inset: 0; width: 100%; height: 100%; aspect-ratio: auto; }
`;
IconButton.elementStyles = [...IconButton.elementStyles, controlGeometry];
ActionButton.elementStyles = [...ActionButton.elementStyles, controlGeometry, css`
  :host { min-inline-size: 44px; max-inline-size: 100%; white-space: normal; }
  :host([size]) .base {
    height: auto;
    min-height: var(--app-control-height, 44px);
    box-sizing: border-box;
  }
  .wrapper {
    box-sizing: border-box;
    min-width: 0;
    padding-block: 10px;
  }
  .label {
    min-width: 0;
    white-space: normal;
    overflow: visible;
    overflow-wrap: anywhere;
    text-align: center;
  }
`];
