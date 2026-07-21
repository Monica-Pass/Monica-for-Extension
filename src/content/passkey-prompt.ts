import type { PasskeyPromptContext } from "../runtime/messages";
import { PROMPT_BASE_STYLES, promptIcon } from "./prompt-styles";

const HOST_ID = "monica-passkey-prompt-host";

export function renderPasskeyPrompt(context: PasskeyPromptContext, accept: (itemId?: string) => Promise<void>, dismiss: () => Promise<void>, rootDocument: Document = document): HTMLElement {
  rootDocument.getElementById(HOST_ID)?.remove();
  const host = rootDocument.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${PROMPT_BASE_STYLES}
    .choices { display:grid; gap:8px; }
    .choice { width:100%; min-height:64px; display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--monica-outline); color:var(--monica-text); background:var(--monica-surface); text-align:left; }
    .choice[aria-checked="true"] { border-color:var(--monica-primary); background:var(--monica-surface-container); box-shadow:inset 3px 0 0 var(--monica-primary); }
    .choice-copy { min-width:0; flex:1; display:grid; gap:2px; }
    .choice-copy strong,.choice-copy span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .source { flex:0 0 auto; padding:3px 7px; border-radius:8px; color:var(--monica-primary); background:var(--monica-surface-high); font-size:11px; }
  </style>`;

  const card = rootDocument.createElement("section");
  card.className = "card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "false");
  card.setAttribute("aria-labelledby", "monica-passkey-title");
  card.setAttribute("aria-describedby", "monica-passkey-description");
  const titleText = context.operation === "create" ? "创建 Monica Passkey？" : "使用 Monica Passkey 登录？";
  card.innerHTML = `<header class="header"><span class="brand-icon">${promptIcon("key")}</span><div class="heading"><strong id="monica-passkey-title" class="title">${titleText}</strong><span class="subtitle"></span></div><button class="icon-button" type="button" aria-label="取消 Passkey 操作">×</button></header>`;
  (card.querySelector(".subtitle") as HTMLElement).textContent = context.rpName || context.rpId;

  const summary = rootDocument.createElement("div");
  summary.className = "summary";
  summary.innerHTML = `<div class="summary-copy"><strong></strong><span class="muted supporting"></span></div>`;
  (summary.querySelector("strong") as HTMLElement).textContent = context.userName || "网站未提供用户名";
  (summary.querySelector(".supporting") as HTMLElement).textContent = context.operation === "create"
    ? `保存至 ${context.saveTargetName || "Monica 本地库"}`
    : `${context.credentials.length} 个可用凭据`;
  card.append(summary);

  let selected = context.credentials[0]?.itemId;
  if (context.operation === "get") {
    const choices = rootDocument.createElement("div");
    choices.className = "choices";
    choices.setAttribute("role", "radiogroup");
    choices.setAttribute("aria-label", "选择 Passkey");
    context.credentials.forEach((credential, index) => {
      const choice = rootDocument.createElement("button");
      choice.type = "button";
      choice.className = "choice";
      choice.setAttribute("role", "radio");
      choice.setAttribute("aria-checked", String(index === 0));
      choice.innerHTML = `<span class="choice-copy"><strong></strong><span class="supporting"></span></span><span class="source"></span>`;
      (choice.querySelector("strong") as HTMLElement).textContent = credential.title;
      (choice.querySelector(".supporting") as HTMLElement).textContent = credential.userName || "无用户名";
      (choice.querySelector(".source") as HTMLElement).textContent = credential.sourceMode === "bitwarden" ? "Bitwarden" : "浏览器本地";
      choice.onclick = () => {
        selected = credential.itemId;
        for (const item of Array.from(choices.children)) item.setAttribute("aria-checked", String(item === choice));
      };
      choices.append(choice);
    });
    card.append(choices);
  }

  const notice = rootDocument.createElement("p");
  notice.id = "monica-passkey-description";
  notice.className = "notice";
  notice.innerHTML = `${promptIcon("info")}<span></span>`;
  (notice.querySelector("span") as HTMLElement).textContent = context.operation === "create"
    ? "私钥会加密保存；Monica 不会把私钥发送给当前网站。"
    : "只有确认后才会使用所选私钥完成本次签名。";
  const status = rootDocument.createElement("p"); status.className = "status"; status.setAttribute("aria-live", "polite");
  const actions = rootDocument.createElement("footer"); actions.className = "actions";
  const cancel = rootDocument.createElement("button"); cancel.type = "button"; cancel.className = "secondary"; cancel.textContent = "取消";
  const confirm = rootDocument.createElement("button"); confirm.type = "button"; confirm.className = "primary"; confirm.textContent = context.operation === "create" ? "创建 Passkey" : "继续登录";
  actions.append(cancel, confirm); card.append(notice, status, actions); shadow.append(card); rootDocument.documentElement.append(host);

  let busy = false;
  const cleanup = () => { rootDocument.removeEventListener("keydown", onKeyDown, true); host.remove(); };
  const cancelPrompt = async () => { if (busy) return; busy = true; try { await dismiss(); } finally { cleanup(); } };
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); void cancelPrompt(); } };
  rootDocument.addEventListener("keydown", onKeyDown, true);
  cancel.onclick = () => void cancelPrompt();
  (card.querySelector(".icon-button") as HTMLButtonElement).onclick = () => void cancelPrompt();
  confirm.onclick = () => {
    if (busy) return;
    busy = true; confirm.disabled = true; cancel.disabled = true; status.textContent = context.operation === "create" ? "正在创建并加密保存…" : "正在完成安全签名…";
    void accept(selected).then(cleanup).catch((error) => { busy = false; confirm.disabled = false; cancel.disabled = false; status.className = "status error"; status.textContent = error instanceof Error ? error.message : "Passkey 操作失败，请重试。"; });
  };
  rootDocument.defaultView?.setTimeout(cleanup, Math.max(0, context.expiresAt - Date.now()) + 100);
  rootDocument.defaultView?.setTimeout(() => (context.operation === "get" ? shadow.querySelector<HTMLButtonElement>(".choice") : confirm)?.focus(), 0);
  return host;
}
