import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { createCurrentFieldContext, createFieldContextsForRoot } from "./field-signature";

function page(html: string) {
  return new JSDOM(html, { url: "https://Login.Example.com/account?secret=hidden", pretendToBeVisual: true });
}

function show(element: Element): void {
  (element as HTMLElement).getBoundingClientRect = () => ({ x: 0, y: 0, width: 240, height: 44, top: 0, right: 240, bottom: 44, left: 0, toJSON: () => ({}) });
}

function focus(dom: JSDOM, selector: string): void {
  const element = dom.window.document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  show(element);
  element.focus();
}

describe("autofill field signatures", () => {
  it("produces a stable lowercase SHA-256 signature without field values or page paths", async () => {
    const dom = page('<form><input id="account" autocomplete="username" value="private-user"><input id="password" type="password" value="private-password"></form>');
    for (const input of dom.window.document.querySelectorAll("input")) show(input);
    focus(dom, "#account");

    const first = await createCurrentFieldContext(dom.window.document, dom.window.location);
    (dom.window.document.querySelector("#account") as HTMLInputElement).value = "changed-user";
    (dom.window.document.querySelector("#password") as HTMLInputElement).value = "changed-password";
    const second = await createCurrentFieldContext(dom.window.document, dom.window.location);

    expect(first).toMatchObject({ hostname: "login.example.com", frameScope: "top-level", role: "username" });
    expect(first?.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/private-user|private-password|changed-user|changed-password|account\?secret/);
  });

  it("ignores labels and placeholders but changes when the structural target changes", async () => {
    const dom = page('<form><label for="user">Old label</label><input id="user" autocomplete="username" placeholder="Old placeholder"><input id="pass" type="password"></form>');
    for (const input of dom.window.document.querySelectorAll("input")) show(input);
    focus(dom, "#user");
    const before = await createCurrentFieldContext(dom.window.document, dom.window.location);
    dom.window.document.querySelector("label")!.textContent = "Dynamic translated label";
    (dom.window.document.querySelector("#user") as HTMLInputElement).placeholder = "Dynamic placeholder";
    const afterCopyChange = await createCurrentFieldContext(dom.window.document, dom.window.location);
    (dom.window.document.querySelector("form")!).prepend(dom.window.document.querySelector("#pass")!);
    const afterOrderChange = await createCurrentFieldContext(dom.window.document, dom.window.location);

    expect(afterCopyChange).toEqual(before);
    expect(afterOrderChange?.signature).not.toBe(before?.signature);
  });

  it("distinguishes the focused field and its visibility", async () => {
    const dom = page('<form><input id="user" autocomplete="username"><input id="pass" type="password"></form>');
    for (const input of dom.window.document.querySelectorAll("input")) show(input);
    focus(dom, "#user");
    const username = await createCurrentFieldContext(dom.window.document, dom.window.location);
    focus(dom, "#pass");
    const password = await createCurrentFieldContext(dom.window.document, dom.window.location);
    (dom.window.document.querySelector("#user") as HTMLElement).style.display = "none";
    const hiddenSibling = await createCurrentFieldContext(dom.window.document, dom.window.location);

    expect(password?.role).toBe("current-password");
    expect(password?.signature).not.toBe(username?.signature);
    expect(hiddenSibling?.signature).not.toBe(password?.signature);
  });

  it("supports open shadow roots and cannot cross a closed shadow root", async () => {
    const dom = page('<div id="open"></div><div id="closed"></div>');
    const openRoot = dom.window.document.querySelector("#open")!.attachShadow({ mode: "open" });
    openRoot.innerHTML = '<form><input id="shadow-user" autocomplete="username"></form>';
    const openInput = openRoot.querySelector("input")!;
    show(openInput);
    openInput.focus();
    expect(await createCurrentFieldContext(dom.window.document, dom.window.location)).toMatchObject({ role: "username" });

    const closedRoot = dom.window.document.querySelector("#closed")!.attachShadow({ mode: "closed" });
    closedRoot.innerHTML = '<input id="closed-password" type="password">';
    const closedInput = closedRoot.querySelector("input")!;
    show(closedInput);
    closedInput.focus();
    expect(await createCurrentFieldContext(dom.window.document, dom.window.location)).toBeUndefined();
  });

  it("recognises wallet fields and bounds structural processing", async () => {
    const dom = page(`<form>${Array.from({ length: 700 }, (_, index) => `<input id="field-${index}">`).join("")}<input id="card" autocomplete="cc-number"></form>`);
    for (const input of dom.window.document.querySelectorAll("input")) show(input);
    focus(dom, "#card");
    const context = await createCurrentFieldContext(dom.window.document, dom.window.location);

    expect(context).toMatchObject({ role: "wallet", hostname: "login.example.com" });
    expect(context?.signature).toMatch(/^[0-9a-f]{64}$/);
  }, 15_000);

  it("signs all credential fields in a submitted form without requiring focus", async () => {
    const dom = page('<form><input autocomplete="username" value="private-user"><input type="password" autocomplete="current-password" value="private-password"><button>Login</button></form>');
    for (const input of dom.window.document.querySelectorAll("input")) show(input);
    const contexts = await createFieldContextsForRoot(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location);
    expect(contexts.map((context) => context.role)).toEqual(["username", "current-password"]);
    expect(JSON.stringify(contexts)).not.toMatch(/private-user|private-password/);
  });
});
