export const PROMPT_BASE_STYLES = `
  :host {
    color-scheme: light dark;
    --monica-primary: #006a64;
    --monica-on-primary: #ffffff;
    --monica-primary-container: #71f7ed;
    --monica-on-primary-container: #00201e;
    --monica-surface: #fff;
    --monica-surface-container: #f2f4f3;
    --monica-surface-high: #e6e9e7;
    --monica-text: #191c1c;
    --monica-muted: #3f4947;
    --monica-outline: #bec9c7;
    --monica-error: #ba1a1a;
    --monica-success: #146c3a;
    font: 14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  * { box-sizing: border-box; }
  .card {
    pointer-events: auto;
    position: fixed;
    top: 16px;
    right: 16px;
    width: min(390px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    display: grid;
    gap: 14px;
    padding: 16px;
    border: 1px solid var(--monica-outline);
    border-radius: 16px;
    color: var(--monica-text);
    background: var(--monica-surface);
    box-shadow: 0 10px 32px rgba(0,0,0,.22);
    animation: monica-prompt-in 180ms cubic-bezier(.2,.8,.2,1);
  }
  .header { display: flex; align-items: center; gap: 12px; }
  .brand-icon {
    width: 44px; height: 44px; flex: 0 0 44px; display: grid; place-items: center;
    border-radius: 8px; color: var(--monica-on-primary-container); background: var(--monica-primary-container);
  }
  .brand-icon svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .heading { min-width: 0; flex: 1; display: grid; gap: 2px; }
  .title { font-size: 16px; line-height: 1.3; }
  .subtitle, .supporting, .masked { color: var(--monica-muted); font-size: 12px; }
  .subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button, select { font: inherit; }
  button { min-height: 44px; border: 0; border-radius: 8px; padding: 0 14px; cursor: pointer; font-weight: 700; }
  button:focus-visible, select:focus-visible { outline: 3px solid var(--monica-primary); outline-offset: 2px; }
  button:disabled { cursor: wait; opacity: .62; }
  .icon-button { width: 44px; padding: 0; color: var(--monica-muted); background: transparent; font-size: 24px; }
  .icon-button:hover, .secondary:hover { background: var(--monica-surface-container); }
  .summary { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 10px 12px; border-radius: 8px; background: var(--monica-surface-container); }
  .summary-copy { min-width: 0; display: grid; gap: 2px; }
  .summary-copy strong, .summary-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notice { display: flex; gap: 10px; align-items: flex-start; margin: 0; padding: 10px 12px; border-radius: 8px; color: var(--monica-muted); background: var(--monica-surface-container); font-size: 12px; }
  .notice svg { width: 18px; height: 18px; flex: 0 0 18px; stroke: currentColor; fill: none; stroke-width: 2; }
  .status { min-height: 20px; margin: 0; color: var(--monica-muted); font-size: 12px; text-align: center; }
  .status.success { color: var(--monica-success); }
  .status.error { color: var(--monica-error); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .secondary { color: var(--monica-primary); background: transparent; }
  .primary { color: var(--monica-on-primary); background: var(--monica-primary); }
  .primary:hover { filter: brightness(.92); }
  @keyframes monica-prompt-in { from { opacity: 0; transform: translateY(-6px); } }
  @media (prefers-color-scheme: dark) {
    :host { --monica-primary: #4fdbd0; --monica-on-primary: #003733; --monica-primary-container: #00504b; --monica-on-primary-container: #71f7ed; --monica-surface: #191c1c; --monica-surface-container: #242827; --monica-surface-high: #2e3231; --monica-text: #e0e3e2; --monica-muted: #bec9c7; --monica-outline: #3f4947; --monica-error: #ffb4ab; --monica-success: #85d5a5; }
  }
  @media (max-width: 430px) { .card { top: 8px; right: 8px; width: calc(100vw - 16px); max-height: calc(100vh - 16px); } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
`;

export function promptIcon(kind: "key" | "save" | "info"): string {
  if (kind === "save") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h11l3 3v11H5z"></path><path d="M8 5v5h7V5M8 19v-6h8v6"></path></svg>';
  if (kind === "info") return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6M12 7h.01"></path></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="4"></circle><path d="M12 12h9m-3 0v3m-3-3v2"></path></svg>';
}
