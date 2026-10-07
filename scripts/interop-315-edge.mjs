import { runProjectCredentialUi, verifyProjectCredentialUi } from './interop-316-edge-project-credentials.mjs';
import { runNativeRestoreUi, verifyNativeRestoreUi } from './interop-317-edge-native-restore.mjs';
import { runMixedRestoreUi, verifyMixedRestoreUi } from './interop-317-edge-mixed-restore.mjs';
import { runRemovalRuntime, verifyRemovalRuntime } from './interop-317-edge-removal-runtime.mjs';
import { runRemovalUi, verifyRemovalUi } from './interop-317-edge-removal-ui.mjs';
import { runProjectSingletonUi, verifyProjectSingletonUi } from './interop-317-edge-project-singleton.mjs';
import { runProjectDetailUi } from './interop-317-edge-project-detail.mjs';
import { runProjectCredentialReturn, verifyProjectCredentialReturn } from './interop-317-edge-project-return.mjs';
import { runBitwardenProjectUi, verifyBitwardenProjectUi, runBitwardenProjectAndroidReturnUi } from './interop-317-edge-bitwarden-projects.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, stat, cp } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { runFeatureChecks, runAndroidUiReturnCheck, runAndroidUiReopenCheck, verifyFeaturePersistence } from "./interop-315-edge-features.mjs";
import { runRealServiceUiChecks } from "./interop-315-edge-real-services.mjs";
import { runLayoutReview } from "./interop-315-layout.mjs";
import { runRecoveryUiCheck } from "./interop-315-edge-recovery.mjs";
import { runIconUiCheck, verifyIconPersistence } from './interop-315-edge-icons.mjs';
import { runSsoUiCheck } from './interop-315-edge-sso.mjs';
import { runSourceStatusUi } from './interop-315-edge-source-status.mjs';
import { runNavigationReview } from './interop-315-edge-navigation.mjs';
import { runSsoBackendUi } from './interop-315-edge-sso-backends.mjs';
import { runNativeIconUi } from './interop-315-edge-native-icons.mjs';
import { runWebDavNoteUi, verifyWebDavNoteReturn } from './interop-315-edge-webdav-notes.mjs';
import { runKeePassTextUi, verifyKeePassTextPersistence, verifyKeePassTextSidePanel } from './interop-315-edge-keepass-text.mjs';
import { runApiAddressUi, verifyApiAddressPersistence } from './interop-316-edge-api-address.mjs';
import { runGpgFieldUi, verifyGpgFieldPersistence } from './interop-316-edge-gpg-fields.mjs';

// Real Edge only. No Vite server, Chromium fallback, mocked native API or user profile.
const root = resolve(import.meta.dirname, "..");
const artifactsRoot = resolve(root, ".tmp/interop-315-edge");
await mkdir(artifactsRoot, { recursive: true });
const output = await mkdtemp(join(artifactsRoot, "run-"));
const profile = join(output, "edge-profile");
const isolatedAppData = join(output, "host-appdata");
await mkdir(isolatedAppData);
const recoveryFixture = process.env.MONICA_315_RECOVERY_FIXTURE ? JSON.parse(await readFile(process.env.MONICA_315_RECOVERY_FIXTURE, "utf8")) : undefined;
if (recoveryFixture) {
  assert.equal(recoveryFixture.synthetic, true);
  await cp(join(recoveryFixture.appData, "Monica Extension", "MDBX2"), join(isolatedAppData, "Monica Extension", "MDBX2"), { recursive: true });
}
const extensionPath = resolve(root, "dist");
const edgeExecutable = process.env.MONICA_315_EDGE_EXECUTABLE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
assert.equal(basename(edgeExecutable).toLowerCase(), "msedge.exe", "Only Microsoft Edge executable is permitted.");
await stat(edgeExecutable);
const manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8"));
const hostExecutable = resolve(process.env.MONICA_315_HOST_EXECUTABLE || join(root, "native/mdbx2-host/target/debug/monica-mdbx2-host.exe"));
const hostName = "com.monica_pass.mdbx2";
const hostRegistry = `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`;
const vaultPassword = "Synthetic-Edge-315-fixture-password";
const loadOnly = process.argv.includes("--load-only");
const headless = process.argv.includes("--headless");
const features = process.argv.includes("--features");
const androidUiReturn = process.argv.includes("--android-ui-return");
const androidUiReopen = process.argv.includes("--android-ui-reopen");
const realServices = process.argv.includes("--real-services");
const evidence = {
  startedAt: new Date().toISOString(), output, profile, isolatedAppData,
  browser: { channel: "msedge", executable: edgeExecutable, headless },
  extension: { path: extensionPath, version: manifest.version, manifestSha256: sha256(await readFile(join(extensionPath, "manifest.json"))) },
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceDiffSha256: sha256(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })),
  mode: loadOnly ? "real-extension-load-only" : "real-extension-ui-and-native",
  checks: [], limitations: [], screenshots: [], consoleErrors: []
};
let owner;
let attached;
let restoreHost;
let debuggingPort;
let manager;
let currentWorker;

try {
  const launched = await launch();
  manager = launched.manager;
  evidence.extension.id = launched.extensionId;
  evidence.browser.version = owner.browser()?.version();
  evidence.browser.userAgent = await manager.evaluate(() => navigator.userAgent);
  assert.match(evidence.browser.userAgent, /Edg\//, "The running browser is not Edge.");
  assert.match(manager.url(), /^chrome-extension:\/\//);
  await manager.getByRole("heading", { name: "创建加密密码库", exact: true }).waitFor();
  await screenshot(manager, "01-manager-setup.png");
  pass("real-unpacked-extension-load", { serviceWorker: launched.worker.url(), managerUrl: manager.url() });
  if (!loadOnly) {
    if (recoveryFixture) {
      if (recoveryFixture.kind === 'mixed-restore') await manager.evaluate(()=>chrome.storage.local.set({'monica.sync.preferences.v1':{enabled:false}}));
      await manager.getByLabel("选择加密整库备份", { exact: true }).setInputFiles(recoveryFixture.backup);
      await manager.getByLabel("备份密码", { exact: true }).fill(vaultPassword);
      await manager.getByRole("button", { name: "恢复并解锁", exact: true }).click();
    } else {
    await manager.getByLabel("主密码", { exact: true }).fill(vaultPassword);
    await manager.locator('input[autocomplete="new-password"]').fill(vaultPassword);
    await manager.getByRole("button", { name: "创建并解锁", exact: true }).click();
    await manager.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
    pass("vault-ui-setup");
    }
    await manager.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
    await screenshot(manager, "02-manager-unlocked.png");

    restoreHost = await temporaryEdgeHost(launched.extensionId);
    const nativeHello = await launched.worker.evaluate(async host => {
      const port = chrome.runtime.connectNative(host);
      return await new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => { port.disconnect(); reject(new Error("Native Messaging hello timed out")); }, 15000);
        port.onMessage.addListener(message => { clearTimeout(timer); port.disconnect(); resolveResult(message); });
        port.onDisconnect.addListener(() => { const error = chrome.runtime.lastError?.message; if (error) { clearTimeout(timer); reject(new Error(error)); } });
        port.postMessage({ protocol: 2, requestId: "edge315-synthetic-hello", method: "host.hello", params: {} });
      });
    }, hostName);
    assert.equal(nativeHello.ok, true, JSON.stringify(nativeHello));
    assert.equal(nativeHello.result.mdbxFormatVersion, "MDBX-2");
    pass("real-native-host-hello", { capabilities: nativeHello.result });
    const uiHostStatus = await manager.evaluate(() => chrome.runtime.sendMessage({ type: "MDBX2_HOST_STATUS" }));
    assert.equal(uiHostStatus.ok, true, JSON.stringify(uiHostStatus));
    assert.equal(uiHostStatus.data?.availability, "ready", JSON.stringify(uiHostStatus));
    pass("real-native-messaging", { hello: nativeHello.result, uiHostStatus: uiHostStatus.data });

    if (process.argv.includes("--layout")) await runLayoutReview({ page: manager, evidence, screenshot });
    if (process.argv.includes('--source-status')) await runSourceStatusUi({page:manager,evidence,screenshot});
    if (process.argv.includes('--navigation')) await runNavigationReview({page:manager,evidence,screenshot});
    if (process.argv.includes('--sso-backends')) await runSsoBackendUi({page:manager,evidence,screenshot});
    if (process.argv.includes('--webdav-notes')) await runWebDavNoteUi({page:manager,evidence,screenshot});
    if (process.argv.includes('--keepass-text')) await runKeePassTextUi({page:manager,evidence,screenshot,output});
    if (process.argv.includes('--api-address') || process.argv.includes('--api-address-return')) await runApiAddressUi({page:manager,evidence,screenshot,output,returned:process.argv.includes('--api-address-return')});
    if (process.argv.includes('--gpg-fields')) await runGpgFieldUi({page:manager,evidence,screenshot,output});
    if (process.argv.includes('--webdav-note-return')) {
      await runWebDavNoteUi({page:manager,evidence,screenshot,readOnly:true});
      await manager.setViewportSize({width:1280,height:860});
    }
    if (process.argv.includes('--project-credentials')) await runProjectCredentialUi({page:manager,evidence,screenshot});
    if (process.argv.includes('--project-singleton')) await runProjectSingletonUi({page:manager,evidence,screenshot});
    if (process.argv.includes('--native-restore')) await runNativeRestoreUi({page:manager,evidence,screenshot,output});
    if (process.argv.includes('--group-restore')) await runNativeRestoreUi({page:manager,evidence,screenshot,output,groupRestore:true});
    if (process.argv.includes('--removal-runtime')) await runRemovalRuntime({page:manager,evidence});
    if (process.argv.includes('--removal-ui')) await runRemovalUi({page:manager,evidence,screenshot});
    if (process.argv.includes('--project-credentials-return')) await runProjectCredentialReturn({page:manager,evidence,screenshot});
    if (process.argv.includes('--project-detail')) await runProjectDetailUi({page:manager,evidence,screenshot});
    if (process.argv.includes('--bitwarden-projects')) await runBitwardenProjectUi({page:manager,evidence,screenshot,output});
    if (process.argv.includes('--bitwarden-project-return')) await runBitwardenProjectAndroidReturnUi({page:manager,evidence,screenshot});
    if (features) await runFeatureChecks({ page: manager, evidence, screenshot });
    if (process.argv.includes('--icons')) await runIconUiCheck({page:manager,evidence,screenshot});
    if (process.argv.includes('--native-icons')) await runNativeIconUi({page:manager,evidence,screenshot,output});
    if (process.argv.includes('--sso')) await runSsoUiCheck({page:manager,evidence,screenshot});
    if (recoveryFixture?.kind === 'mixed-restore') await runMixedRestoreUi({page:manager,fixture:recoveryFixture,evidence,screenshot,output});
    else if (recoveryFixture) await runRecoveryUiCheck({ page: manager, fixture: recoveryFixture, evidence, screenshot });
    if (androidUiReturn) { await runAndroidUiReturnCheck({ page: manager, evidence, screenshot, output }); pass("real-android-ui-edge-ui-return-export", evidence.androidUiReturn); }
    if (androidUiReopen) { await runAndroidUiReopenCheck({ page: manager, evidence, screenshot }); pass("real-android-ui-four-leg-final-reopen", evidence.androidUiReopen); }
    if (realServices) await runRealServiceUiChecks({ page: manager, evidence, screenshot, output });

    // The icon scenario exports through the background API, so the UI can still
    // consider the local KDBX dirty. Explicitly acknowledge its real confirmation.
    const confirmIconLock = async dialog => {
      assert.equal(dialog.type(), 'confirm');
      assert.match(dialog.message(), /KeePass 数据库还有未导出的修改/);
      await dialog.accept();
      evidence.nativeIconUi.lockConfirmedAfterExport = true;
    };
    if (process.argv.includes('--native-icons')) manager.on('dialog', confirmIconLock);
    try {
      await manager.getByRole("button", { name: "立即锁定", exact: true }).click();
      await manager.getByRole("heading", { name: "解锁 Monica", exact: true }).waitFor();
    } finally { manager.off('dialog', confirmIconLock); }
    const locked = await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
    assert.equal(locked.ok, false, "Locked manager must not expose vault contents.");
    pass("vault-ui-lock-denies-read");
    const target = await owner.newPage();
    await target.goto("https://edge315.synthetic.invalid/login");
    await target.bringToFront();
    await launched.worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: "https://edge315.synthetic.invalid/*" });
      const tab = tabs.find(candidate => candidate.active) || tabs[0];
      if (!tab?.windowId) throw new Error("Synthetic Edge target window is missing.");
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.action.openPopup({ windowId: tab.windowId });
    });
    attached = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
    const popup = await extensionSurface(page => page.url().endsWith("/popup.html"));
    await popup.getByText("密码库已锁定", { exact: true }).waitFor();
    assert.equal(await popup.evaluate(() => chrome.runtime.id), launched.extensionId);
    await screenshot(popup, "03-real-action-popup-locked.png");
    pass("real-action-popup", { url: popup.url(), dimensions: await dimensions(popup) });
    await largeTextCheck(popup, "04-real-popup-200pct.png");

    if (!manifest.permissions?.includes("sidePanel") || !manifest.side_panel?.default_path) {
      evidence.limitations.push("Real side panel skipped: dist manifest does not declare sidePanel and side_panel. A narrow manager tab is not counted as a browser side panel.");
    } else {
      await popup.getByRole("button", { name: "在侧栏打开密码库", exact: true }).click();
      // Edge publishes SIDE_PANEL as a page target outside Playwright's existing
      // auto-attach session. Re-discover the real target after the UI click.
      attached = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
      const sidePanel = await extensionSurface(page => page.url().includes("surface=sidepanel"));
      const sideContexts = await currentWorker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }));
      assert.ok(sideContexts.some(context => context.documentUrl === sidePanel.url()), "A normal tab must not be counted as SIDE_PANEL.");
      await sidePanel.getByRole("heading", { name: "解锁 Monica", exact: true }).waitFor();
      await screenshot(sidePanel, "05-real-side-panel-locked.png");
      await sidePanel.getByLabel("主密码", { exact: true }).fill(vaultPassword);
      await sidePanel.getByRole("button", { name: "解锁", exact: true }).click();
      await sidePanel.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
      await screenshot(sidePanel, "06-real-side-panel-unlocked.png");
      await largeTextCheck(sidePanel, "07-real-side-panel-200pct.png");
      pass("real-side-panel-ui-unlock", { url: sidePanel.url(), dimensions: await dimensions(sidePanel) });
      if (evidence.webdavNoteReturn) await verifyWebDavNoteReturn({page:sidePanel,evidence,screenshot,phase:'real side panel',preserveViewport:true});
      if (evidence.keePassText) await verifyKeePassTextSidePanel({page:sidePanel,evidence,screenshot});
    }

    // Close the owning Edge process, retaining only this synthetic test profile, then restart it.
    await owner.close();
    owner = undefined;
    attached = undefined;
    const restarted = await launch();
    manager = restarted.manager;
    assert.equal(restarted.extensionId, evidence.extension.id);
    await manager.getByRole("heading", { name: "解锁 Monica", exact: true }).waitFor();
    await screenshot(manager, "08-manager-browser-restart-locked.png");
    await manager.getByLabel("主密码", { exact: true }).fill("Synthetic-wrong-password");
    await manager.getByRole("button", { name: "解锁", exact: true }).click();
    await manager.getByRole("alert").waitFor();
    assert.equal((await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }))).ok, false);
    await manager.getByLabel("主密码", { exact: true }).fill(vaultPassword);
    await manager.getByRole("button", { name: "解锁", exact: true }).click();
    await manager.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
    await screenshot(manager, "09-manager-restarted-unlocked.png");
    pass("real-browser-restart-and-wrong-password-fail-closed");
    if (evidence.customIcons) await verifyIconPersistence(manager,evidence);
    if (evidence.keePassText) await verifyKeePassTextPersistence(manager,evidence);
    if (evidence.apiAddress) await verifyApiAddressPersistence(manager,evidence);
    if (evidence.projectCredentials) await verifyProjectCredentialUi(manager,evidence);
    if (evidence.projectSingleton) await verifyProjectSingletonUi(manager,evidence);
    if (evidence.projectCredentialReturn) await verifyProjectCredentialReturn(manager,evidence);
    if (evidence.nativeRestore) await verifyNativeRestoreUi(manager,evidence,screenshot);
    if (evidence.mixedRestore) await verifyMixedRestoreUi({page:manager,fixture:recoveryFixture,evidence,screenshot,output});
    if (evidence.removalUi) await verifyRemovalUi(manager,evidence,screenshot);
    else if (evidence.removalRuntime) await verifyRemovalRuntime(manager,evidence);
    if (evidence.bitwardenProjects) await verifyBitwardenProjectUi(manager,evidence);
    if (evidence.gpgFields) await verifyGpgFieldPersistence(manager,evidence);
    if (evidence.webdavNoteReturn) {
      await verifyWebDavNoteReturn({page:manager,evidence,screenshot,phase:'browser restart'});
      assert.equal(evidence.webdavNoteReturn.checks.length,4,'All note-return surfaces must complete');
      evidence.webdavNoteReturn.status='passed';
    }
    if (features || realServices) { await verifyFeaturePersistence(manager, evidence); pass("real-feature-persistence-after-restart", { itemCount: evidence.featurePersistence.length }); }
    else if (!androidUiReturn && !androidUiReopen && !evidence.webdavNoteReturn && !evidence.webdavNotes && !evidence.keePassText && !evidence.apiAddress && !evidence.nativeRestore && !evidence.removalRuntime && !evidence.mixedRestore) evidence.limitations.push("Synthetic setup/lifecycle and native handshake only: Android application fixtures and cross-device data matrix are not inferred from these smoke checks.");
    if (evidence.mixedRestore) evidence.limitations.push('Actual encrypted backup import and mixed four-member restoration through Edge UI, Native Messaging and restart. Partial acknowledgement was prepared using actual Native writes outside the browser. Current Android return and natural browser partial-sync failure remain separate acceptance work.');
    if (evidence.removalRuntime) evidence.limitations.push(evidence.removalUi ? 'Actual removal/undo/review/pending UI, Native writes and browser-restart recovery with synthetic rich fields/attachments. Current Android return remains separate.' : 'Actual manager runtime/Native member removal, preparation cancellation and browser-restart recovery with synthetic rich password projects and attachments. This mode does not exercise member-removal UI or current Android return.');
    if (evidence.nativeRestore) evidence.limitations.push('Historical synthetic Android input; current Edge/Native group deletion/restoration verified. Complete export correctly refuses this standalone fixture because its referenced ciphertext is missing. Valid complete archives are covered separately. Current Android return and the full lifecycle matrix remain pending.');
    if (evidence.apiAddress) evidence.limitations.push('API address fields verified using actual Android draft/repository/Room fixtures and Edge UI. Android screen interaction and other field/backend matrices remain separate.');
    if (evidence.keePassText) evidence.limitations.push('Exact SSH text imported from Android core/Kotpass fixture, edited/exported/reopened through actual Edge; Android application UI and unknown SSH JSON transport are separate, incomplete work.');
    if (evidence.webdavNoteReturn) evidence.limitations.push('Exact eight-record Android-return ZIP reopened through WebDAV; 420/320 manager tabs and the actual Edge side panel checked separately. Android import/export was separately verified through the application repositories, not screen automation. Other fields/backends are not inferred.');
    if (androidUiReturn) evidence.limitations.push("One actual Android-UI-created login was edited and exported through Edge UI with Native readback. Android reopening is a separate pending step; other types and services are not inferred.");
    if (androidUiReopen) evidence.limitations.push("This final UI reopen covers exactly one Android-UI-created password record and its preserved password/group; it does not prove the complete type/backend matrix.");
  }
  if (evidence.projectDetail || evidence.nativeRestore || evidence.removalRuntime || evidence.mixedRestore) assert.deepEqual(evidence.consoleErrors, [], 'Project detail and recovery must not produce browser errors');
  evidence.status = evidence.featureChecks?.some(check => check.status === "failed") ? "failed" : "passed";
  if (evidence.status === "failed") process.exitCode = 1;
} catch (error) {
  evidence.status = "failed";
  evidence.error = { message: error.message, stack: error.stack };
  if (manager && !manager.isClosed()) await screenshot(manager, "failure-manager.png").catch(() => undefined);
  process.exitCode = 1;
} finally {
  await owner?.close().catch(() => undefined);
  if (restoreHost) {
    try { restoreHost(); evidence.nativeRegistryRestored = true; }
    catch (error) { evidence.nativeRegistryRestored = false; evidence.registryRestoreError = error.message; process.exitCode = 1; }
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.profileRetained = "Synthetic profile and isolated Host state are retained under this run directory for reproducibility; no user profile/library was opened.";
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.map(item => item.name), featureChecks: evidence.featureChecks, limitations: evidence.limitations, error: evidence.error?.message, evidence: join(output, "evidence.json") }, null, 2));
}

async function launch() {
  debuggingPort = await reservePort();
  owner = await chromium.launchPersistentContext(profile, {
    channel: "msedge", executablePath: edgeExecutable, headless, locale: "zh-CN", viewport: { width: 1280, height: 860 },
    // Process-local only. Native child processes inherit this isolated test root;
    // no machine/user environment is changed and production Host data is not opened.
    env: { ...process.env, LOCALAPPDATA: isolatedAppData },
    args: ["--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${debuggingPort}`, `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  owner.setDefaultTimeout(15000);
  owner.on("page", page => page.on("pageerror", error => evidence.consoleErrors.push(error.message)));
  await owner.route("https://edge315.synthetic.invalid/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><html lang="zh-CN"><title>Synthetic Edge 315</title><label>Username<input autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label></html>' }));
  const worker = owner.serviceWorkers().find(candidate => candidate.url().startsWith("chrome-extension://")) || await owner.waitForEvent("serviceworker");
  currentWorker = worker;
  const extensionId = new URL(worker.url()).host;
  const page = await owner.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  return { worker, extensionId, manager: page };
}

async function temporaryEdgeHost(extensionId) {
  await stat(hostExecutable);
  const snapshot = registrySnapshot();
  assert.ok(!snapshot.hasDefault || ["String", "ExpandString"].includes(snapshot.kind), "Unexpected registry value kind; refusing to replace it.");
  await writeFile(join(output, "native-registry-before.json"), JSON.stringify(snapshot, null, 2));
  const path = join(output, `${hostName}.json`);
  await writeFile(path, JSON.stringify({ name: hostName, description: "Monica real Edge 315 synthetic interoperability test", path: hostExecutable, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2));
  evidence.nativeHost = { executable: hostExecutable, sha256: sha256(await readFile(hostExecutable)), manifest: path, registryKey: hostRegistry };
  execFileSync("reg.exe", ["add", hostRegistry, "/ve", "/t", "REG_SZ", "/d", path, "/f"], { windowsHide: true, stdio: "pipe" });
  return () => {
    const current = registrySnapshot();
    assert.equal(current.value, path, "Native registration changed concurrently; refusing to overwrite someone else's update.");
    if (snapshot.hasDefault) execFileSync("reg.exe", ["add", hostRegistry, "/ve", "/t", snapshot.kind === "ExpandString" ? "REG_EXPAND_SZ" : "REG_SZ", "/d", snapshot.value, "/f"], { windowsHide: true, stdio: "pipe" });
    else {
      if (!snapshot.exists) {
        assert.deepEqual(current.valueNames, [""], "Native registry key gained other values; refusing to delete it.");
        assert.deepEqual(current.subKeys, [], "Native registry key gained subkeys; refusing to delete it.");
      }
      execFileSync("reg.exe", snapshot.exists ? ["delete", hostRegistry, "/ve", "/f"] : ["delete", hostRegistry, "/f"], { windowsHide: true, stdio: "pipe" });
    }
    assert.deepEqual(registrySnapshot(), snapshot, "Native registration did not return to its prior value.");
  };
}

function registrySnapshot() {
  const command = `$key = Get-Item -LiteralPath 'Registry::${hostRegistry}' -ErrorAction SilentlyContinue; if ($null -eq $key) { @{ exists=$false; hasDefault=$false; value=$null; kind=$null; valueNames=@(); subKeys=@() } | ConvertTo-Json -Compress } else { $hasDefault=$key.GetValueNames() -contains ''; @{ exists=$true; hasDefault=$hasDefault; valueNames=@($key.GetValueNames() | Sort-Object); subKeys=@($key.GetSubKeyNames() | Sort-Object); value=if($hasDefault){$key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null}; kind=if($hasDefault){$key.GetValueKind('').ToString()}else{$null} } | ConvertTo-Json -Compress }`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true }));
}

async function extensionSurface(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pages = [...owner.pages(), ...(attached?.contexts().flatMap(context => context.pages()) || [])];
    const page = pages.find(candidate => !candidate.isClosed() && predicate(candidate));
    if (page) return page;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  if (attached) {
    const cdp = await attached.newBrowserCDPSession();
    evidence.surfaceTargets = await cdp.send("Target.getTargets");
    await cdp.detach();
  }
  evidence.extensionContexts = await currentWorker.evaluate(() => chrome.runtime.getContexts({}));
  throw new Error("Real Edge extension surface did not appear; no tab-page fallback is counted.");
}

async function screenshot(page, name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))); });
  const path = join(output, name);
  await page.screenshot({ path, animations: "disabled" });
  evidence.screenshots.push(path);
}

async function dimensions(page) {
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
}

async function largeTextCheck(page, screenshotName) {
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await screenshot(page, screenshotName);
  const size = await dimensions(page);
  assert.ok(size.scrollWidth <= size.clientWidth + 1, `Horizontal overflow at 200% text: ${JSON.stringify(size)}`);
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
}

function pass(name, details = {}) { evidence.checks.push({ name, status: "passed", at: new Date().toISOString(), ...details }); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return address.port;
}
