export const INLINE_AUTOFILL_STYLES = `
  :host { color-scheme:light dark; --surface:#fff; --surface-hover:#f3f3ef; --text:#1a1a1a; --muted:#62625e; --line:#cdcdc7; font:400 14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
  *,*::before,*::after { box-sizing:border-box; min-width:0; }
  .panel { pointer-events:auto; width:100%; overflow:auto; overscroll-behavior:contain; background:var(--surface); color:var(--text); border:1px solid var(--line); border-radius:10px; }
  header { display:flex; align-items:center; gap:8px; min-height:48px; padding:0 6px 0 12px; border-bottom:1px solid var(--line); }
  header img { width:24px; height:24px; flex:0 0 24px; object-fit:contain; }
  header strong { font-size:14px; font-weight:600; letter-spacing:-.02em; }
  .label { flex:1; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
  button { font:inherit; color:inherit; cursor:pointer; background:transparent; border:0; margin:0; text-align:start; }
  button:focus-visible { outline:2px solid var(--text); outline-offset:-3px; }
  button:hover { background:var(--surface-hover); }
  button:disabled { cursor:wait; opacity:.55; }
  .close { width:44px; height:44px; flex:0 0 44px; padding:0; text-align:center; font-size:24px; font-weight:400; border-radius:6px; }
  .suggestions { display:grid; }
  .suggestion { display:flex; align-items:center; gap:12px; width:100%; min-height:60px; padding:10px 12px; }
  .suggestion + .suggestion { border-top:1px solid var(--line); }
  .account { display:grid; flex:1; gap:2px; overflow:hidden; }
  .account strong,.account small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .account strong { font-size:14px; font-weight:500; }
  .account small { font-size:12px; color:var(--muted); }
  .hint { color:var(--muted); font-size:11px; max-width:80px; overflow-wrap:anywhere; }
  .empty,.count,.status { margin:0; padding:12px; font-size:12px; line-height:1.6; color:var(--muted); overflow-wrap:anywhere; }
  .empty { min-height:64px; display:flex; align-items:center; }
  .status { color:#ba151c; }
  [hidden] { display:none!important; }
  .open-manager { width:100%; min-height:44px; padding:10px 12px; border-top:1px solid var(--line); font-size:12px; font-weight:500; }
  @media(prefers-color-scheme:dark) { :host { --surface:#111; --surface-hover:#252525; --text:#eee; --muted:#aaa; --line:#414141; } .status { color:#ff7478; } }
`;
