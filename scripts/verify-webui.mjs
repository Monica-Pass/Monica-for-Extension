const endpoint = "http://127.0.0.1:9223";
const targetUrl = "http://127.0.0.1:5173/";

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      for (const handler of this.handlers) handler(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  session(sessionId) {
    return {
      send: (method, params = {}) => {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, sessionId, method, params }));
        return new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
        });
      }
    };
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  close() {
    this.ws.close();
  }
}

const version = await fetch(`${endpoint}/json/version`).then((res) => res.json());
const browser = new Cdp(version.webSocketDebuggerUrl);
await browser.ready;

const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
const page = browser.session(sessionId);
const logs = [];

await page.send("Runtime.enable");
await page.send("Page.enable");
await page.send("DOM.enable");
await page.send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false
});

browser.onMessage((message) => {
  if (message.sessionId !== sessionId) return;
  if (message.method === "Runtime.exceptionThrown") {
    logs.push(`exception: ${message.params.exceptionDetails?.text ?? "runtime exception"}`);
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const level = message.params.type;
    if (level === "error" || level === "warning") {
      const text = message.params.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ") ?? "";
      if (!text.includes("Lit is in dev mode")) {
        logs.push(`${level}: ${text}`);
      }
    }
  }
});

await page.send("Page.navigate", { url: targetUrl });
await delay(900);
await screenshot(page, "screenshots-login-material.png");

await evalPage(page, `document.querySelector("form")?.requestSubmit()`);
await delay(300);
const loginBlocked = await evalPage(page, `Boolean(document.querySelector(".form-error"))`);
if (!loginBlocked.result.value) {
  throw new Error("empty login was not blocked");
}

await evalPage(page, `
  document.querySelector('input[type="password"]').value = "monica-preview";
  document.querySelector('input[type="password"]').dispatchEvent(new Event("input", { bubbles: true }));
`);
await evalPage(page, `document.querySelector("form")?.requestSubmit()`);
await delay(900);
await screenshot(page, "screenshots-dashboard-material.png");

for (const section of ["wallet", "sends", "mdbx", "api"]) {
  await evalPage(page, `document.querySelector(${JSON.stringify(`.nav-item[data-section="${section}"]`)})?.click()`);
  await delay(500);
}
await screenshot(page, "screenshots-api-material.png");

await evalPage(page, `document.querySelector('.nav-item[data-section="settings"]')?.click()`);
await delay(500);
const hasAppearance = await evalPage(page, `document.body.textContent.includes("外观") || document.body.textContent.includes("Appearance")`);
if (!hasAppearance.result.value) {
  throw new Error("appearance settings did not render");
}

await page.send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true
});
await delay(500);
await screenshot(page, "screenshots-mobile-material.png");

await browser.send("Target.closeTarget", { targetId });
browser.close();

if (logs.length) {
  console.error(logs.join("\n"));
  process.exit(1);
}

console.log("verified");

async function evalPage(page, expression) {
  return page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
}

async function screenshot(page, fileName) {
  const result = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await import("node:fs/promises").then((fs) => fs.writeFile(fileName, Buffer.from(result.data, "base64")));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
