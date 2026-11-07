import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const count = Number(arg('--items', '2000'));
if (!Number.isInteger(count) || count < 100 || count > 10000) throw new Error('Expected 100–10000 items');
const output = path.resolve(arg('--output', '.artifacts/performance/interaction.json'));
const extension = path.resolve(arg('--extension', 'dist'));
const root = path.resolve(import.meta.dirname, '..');
// A short profile path avoids Windows IndexedDB path limits. Retained for diagnosis.
const profile = path.resolve(arg('--profile', process.env.MONICA_PERF_PROFILE_DIR || path.join(root, '.tmp/perf-profile')));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, locale: 'en-US', reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send('Target.getTargets');
  const target = targetInfos.find(target => target.type === 'service_worker' && target.url === worker.url());
  const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: target.targetId });
  let sequence = 0;
  const pending = new Map();
  browserCdp.on('Target.receivedMessageFromTarget', ({ sessionId: source, message }) => {
    if (source !== sessionId) return;
    const data = JSON.parse(message);
    const resolve = pending.get(data.id);
    if (resolve) { pending.delete(data.id); resolve(data.result); }
  });
  const workerCdp = (method, params = {}) => new Promise(resolve => {
    const id = ++sequence; pending.set(id, resolve);
    void browserCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  const send = request => page.evaluate(async request => {
    const response = await chrome.runtime.sendMessage(request);
    if (!response.ok) throw new Error(response.error);
    return undefined;
  }, request);
  await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
  await send({ type: 'VAULT_SETUP', masterPassword: 'Synthetic latency measurement password' });
  const now = new Date().toISOString();
  await send({ type: 'VAULT_IMPORT_ITEMS', items: Array.from({ length: count }, (_, index) => ({
    id: `latency-${index}`, kind: 'login', title: `Latency account ${index}`, username: `user${index}`, password: 'synthetic',
    uris: [`https://account${index}.example.test`], notes: '', favorite: false, createdAt: now, updatedAt: now,
    providerRefs: [], customFields: []
  })) });
  await page.evaluate(async () => {
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const encode = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const now = new Date().toISOString();
    const response = await chrome.runtime.sendMessage({ type: 'VAULT_IMPORT_ITEMS', items: [{
      id: 'latency-passkey', kind: 'passkey', title: 'Latency Passkey', favorite: false, notes: '',
      createdAt: now, updatedAt: now, providerRefs: [], credentialId: 'AAECAwQFBgcICQoLDA0ODw',
      rpId: 'account1.example.test', rpName: 'Latency', userName: 'synthetic', userDisplayName: 'Synthetic',
      userHandle: 'dXNlcg', privateKeyPkcs8: encode(await crypto.subtle.exportKey('pkcs8', key.privateKey)),
      publicKey: encode(await crypto.subtle.exportKey('spki', key.publicKey)), algorithm: -7, signCount: 0,
      sourceMode: 'browser-local', discoverable: true
    }] });
    if (!response.ok) throw new Error(response.error);
  });
  // Keep renderer work out of the background-command baseline.
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/passkey-verify.html`);
  await worker.evaluate(() => {
    globalThis.__latencyCrypto = { decrypts: 0, encrypts: 0, decryptMs: 0, encryptMs: 0 };
    for (const op of ['decrypt', 'encrypt']) {
      const original = crypto.subtle[op].bind(crypto.subtle);
      crypto.subtle[op] = async (...args) => {
        const start = performance.now();
        try { return await original(...args); }
        finally { globalThis.__latencyCrypto[`${op}s`]++; globalThis.__latencyCrypto[`${op}Ms`] += performance.now() - start; }
      };
    }
  });
  const result = { items: count, profile, units: 'milliseconds', samples: [] };
  await workerCdp('Profiler.enable');
  await workerCdp('Profiler.start');
  for (const request of [
    { type: 'VAULT_STATUS' }, { type: 'VAULT_LIST_ITEMS' },
    { type: 'VAULT_MATCH_LOGINS', pageUrl: 'https://account1.example.test/login' },
    { type: 'VAULT_MATCH_PASSKEYS', pageUrl: 'https://github.com/login' }
  ]) {
    for (let run = 0; run < 3; run++) {
      const before = await worker.evaluate(() => ({ ...globalThis.__latencyCrypto }));
      const ms = await page.evaluate(async request => {
        const start = performance.now();
        const response = await chrome.runtime.sendMessage(request);
        if (!response.ok) throw new Error(response.error);
        return performance.now() - start;
      }, request);
      const after = await worker.evaluate(() => globalThis.__latencyCrypto);
      const sample = { command: request.type, run, ms, ...Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]])) };
      result.samples.push(sample); console.log(JSON.stringify(sample));
    }
  }
  await mkdir(path.dirname(output), { recursive: true });
  const { profile: cpu } = await workerCdp('Profiler.stop');
  await writeFile(output.replace(/\.json$/, '.cpuprofile'), JSON.stringify(cpu));
  const hot = cpu.nodes.filter(node => node.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 18)
    .map(node => ({ function: node.callFrame.functionName, hits: node.hitCount, url: node.callFrame.url, line: node.callFrame.lineNumber, column: node.callFrame.columnNumber }));
  console.log(JSON.stringify({ hot }));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await page.locator('.sidebar .nav-item').nth(1).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const render = await page.evaluate(async () => {
    const start = performance.now();
    document.querySelectorAll('.sidebar .nav-item')[1].click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { ms: performance.now() - start, rows: document.querySelectorAll('.vault-list-card .item-card').length };
  });
  result.managerLogins = render;
  console.log(JSON.stringify({ managerLogins: render }));
  const search = page.getByRole('searchbox').first();
  const searches = [];
  for (const query of ['Latency account 177', '', 'Latency account 3', '']) {
    const ms = await search.evaluate(async (element, value) => {
      const start = performance.now();
      element.value = value; element.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - start;
    }, query);
    searches.push(ms);
  }
  result.managerSearch = searches;
  console.log(JSON.stringify({ managerSearch: searches }));
  await page.close();
  await context.route('https://account1.example.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <form><label>Username<input id="username" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label></form>
    <button id="authenticate">Use Passkey</button><output id="result"></output>
    <script>
    window.timings = {}; let focusedAt = 0, fillAt = 0, beginAt = 0, acceptedAt = 0;
    username.addEventListener('focus', () => { focusedAt = performance.now(); });
    password.addEventListener('input', () => { if (fillAt) timings.inlineFillMs = performance.now() - fillAt; });
    document.addEventListener('keydown', event => {
      if (event.key === 'Enter' && document.activeElement?.id === 'monica-inline-autofill-host') fillAt = performance.now();
      if (event.key === 'Enter' && document.activeElement?.id === 'monica-passkey-prompt-host') acceptedAt = performance.now();
    }, true);
    document.addEventListener('pointerdown', event => {
      if (event.target?.id === 'monica-passkey-prompt-host') acceptedAt = performance.now();
    }, true);
    new MutationObserver(() => {
      if (focusedAt && document.getElementById('monica-inline-autofill-host')) { timings.inlineMenuMs = performance.now() - focusedAt; focusedAt = 0; }
      if (beginAt && document.getElementById('monica-passkey-prompt-host')) { timings.passkeyPromptMs = performance.now() - beginAt; beginAt = 0; }
    }).observe(document.documentElement, { childList: true, subtree: true });
    authenticate.onclick = async () => {
      beginAt = performance.now();
      try {
        const credential = await navigator.credentials.get({ publicKey: { rpId: 'account1.example.test', challenge: new Uint8Array(32).fill(5), userVerification: 'discouraged' } });
        timings.passkeyCompleteMs = performance.now() - acceptedAt;
        result.textContent = credential.id;
      } catch (error) { result.textContent = error.name + ': ' + error.message; }
    };
    </script>` }));
  const site = await context.newPage();
  await site.goto('https://account1.example.test/login');
  await site.locator('#username').click();
  await site.locator('#monica-inline-autofill-host').waitFor();
  await site.keyboard.press('ArrowDown');
  await site.keyboard.press('Enter');
  await site.waitForFunction(() => document.getElementById('password').value === 'synthetic');
  // Benchmark each action independently; the overlapping save/Passkey prompt
  // regression is covered separately in passkey-bitwarden-counter.spec.ts.
  await site.evaluate(() => document.querySelector('form').remove());
  await site.locator('#authenticate').click();
  await site.locator('#monica-passkey-prompt-host').waitFor();
  await site.waitForFunction(() => document.activeElement?.id === 'monica-passkey-prompt-host');
  const siteCdp = await context.newCDPSession(site);
  const { root } = await siteCdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const flatten = node => [node, ...(node.children || []).flatMap(flatten), ...(node.shadowRoots || []).flatMap(flatten)];
  const host = flatten(root).find(node => node.attributes?.includes('monica-passkey-prompt-host'));
  const { object } = await siteCdp.send('DOM.resolveNode', { nodeId: host.shadowRoots[0].nodeId });
  const { result: bounds } = await siteCdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true,
    functionDeclaration: 'function(){const r=this.querySelector(".primary").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}' });
  await site.mouse.click(bounds.value.x, bounds.value.y);
  await siteCdp.detach();
  await site.waitForFunction(() => document.getElementById('result').textContent);
  const assertionId = await site.locator('#result').textContent();
  if (assertionId !== 'AAECAwQFBgcICQoLDA0ODw') throw new Error(assertionId);
  result.website = await site.evaluate(() => window.timings);
  console.log(JSON.stringify({ website: result.website }));
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
} finally { await context.close(); }
