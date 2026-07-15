import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { CredentialCaptureInput } from "../runtime/messages";
import { installCredentialCapture, OPEN_SHADOW_ROOT_EVENT } from "./content-lifecycle";

function page(html = '<main id="app"></main>') {
  return new JSDOM(html, { url: "https://accounts.example.com/login", pretendToBeVisual: true });
}

function click(dom: JSDOM, element: Element): void {
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, composed: true }));
}

function submit(dom: JSDOM, form: HTMLFormElement): void {
  form.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

async function settle(dom: JSDOM): Promise<void> {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
}

describe("dynamic credential capture lifecycle", () => {
  it("captures a form inserted after installation", async () => {
    const dom = page();
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    dom.window.document.querySelector("#app")!.innerHTML = '<form><input autocomplete="username" value="late-user"><input type="password" value="late-secret"><button type="submit">Login</button></form>';

    submit(dom, dom.window.document.querySelector("form")!);
    expect(candidates).toEqual([expect.objectContaining({ username: "late-user", password: "late-secret" })]);
    stop();
  });

  it("captures a non-composed submit exactly once inside a dynamically added open shadow root", async () => {
    const dom = page();
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const host = dom.window.document.createElement("login-shell");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<form><input autocomplete="username" value="shadow-user"><input type="password" value="shadow-secret"><button type="submit">Login</button></form>';
    dom.window.document.querySelector("#app")!.append(host);
    await settle(dom);

    submit(dom, shadow.querySelector("form")!);
    expect(candidates).toEqual([expect.objectContaining({ username: "shadow-user", password: "shadow-secret" })]);
    stop();
  });

  it("instruments an open root attached later when the main-world bridge announces it", async () => {
    const dom = page('<login-shell id="host"></login-shell>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const host = dom.window.document.querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<form><input autocomplete="username" value="announced-user"><input type="password" value="announced-secret"></form>';
    host.dispatchEvent(new dom.window.CustomEvent(OPEN_SHADOW_ROOT_EVENT, { bubbles: true, composed: true }));

    submit(dom, shadow.querySelector("form")!);
    expect(candidates).toEqual([expect.objectContaining({ username: "announced-user", password: "announced-secret" })]);
    stop();
  });

  it("carries only a recent username across a username-first password-second SPA flow", async () => {
    const dom = page();
    const app = dom.window.document.querySelector("#app")!;
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    app.innerHTML = '<form><input autocomplete="username" value="two-step-user"><button type="button">Continue</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);

    app.innerHTML = '<form><input type="password" value="two-step-secret"><button type="button">Sign in</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);

    expect(candidates).toEqual([expect.objectContaining({ username: "two-step-user", password: "two-step-secret" })]);
    stop();
  });

  it("does not reuse an expired username-step context", async () => {
    const dom = page();
    const app = dom.window.document.querySelector("#app")!;
    const candidates: CredentialCaptureInput[] = [];
    let clock = 1_000;
    const stop = installCredentialCapture({
      rootDocument: dom.window.document,
      pageLocation: dom.window.location,
      now: () => clock,
      usernameContextTtlMs: 500,
      onCandidate: (candidate) => { candidates.push(candidate); }
    });
    app.innerHTML = '<form><input autocomplete="username" value="expired-user"><button type="button">Continue</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);
    clock = 1_501;
    app.innerHTML = '<form><input type="password" value="fresh-secret"><button type="button">Sign in</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);

    expect(candidates).toEqual([expect.objectContaining({ username: "", password: "fresh-secret" })]);
    stop();
  });

  it("does not claim or instrument a closed shadow root", async () => {
    const dom = page('<login-shell id="host"></login-shell>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const host = dom.window.document.querySelector("#host")!;
    const closed = host.attachShadow({ mode: "closed" });
    closed.innerHTML = '<form><input autocomplete="username" value="closed-user"><input type="password" value="closed-secret"></form>';
    host.dispatchEvent(new dom.window.CustomEvent(OPEN_SHADOW_ROOT_EVENT, { bubbles: true, composed: true }));
    await settle(dom);

    submit(dom, closed.querySelector("form")!);
    expect(candidates).toEqual([]);
    stop();
  });

  it("cancels the click fallback when the same action also submits a form", async () => {
    const dom = page('<form><input autocomplete="username" value="single-user"><input type="password" value="single-secret"><button type="button">Login</button></form>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const form = dom.window.document.querySelector("form")!;
    click(dom, form.querySelector("button")!);
    submit(dom, form);
    await settle(dom);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ username: "single-user", password: "single-secret" });
    stop();
  });
});
