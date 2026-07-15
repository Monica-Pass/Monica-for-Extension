import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("commercial installability and least privilege", () => {
  it("ships a complete GPLv3 license and repository identity", async () => {
    const [license, pkg] = await Promise.all([read("LICENSE"), readJson<{ license: string; repository: { url: string }; scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> }>("package.json")]);
    expect(pkg.license).toBe("GPL-3.0-only");
    expect(pkg.repository.url).toBe("https://github.com/Monica-Pass/Monica-for-Extension.git");
    expect(license).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 29 June 2007");
    expect(license.length).toBeGreaterThan(30_000);
    expect(pkg.scripts["audit:production"]).toContain("registry.npmjs.org");
    expect(pkg.scripts["release:check"]).toContain("audit:production");
    expect(pkg.dependencies).not.toHaveProperty("vite");
    expect(pkg.dependencies).not.toHaveProperty("@vitejs/plugin-vue");
    expect(pkg.devDependencies).toHaveProperty("vite");
    expect(pkg.devDependencies).toHaveProperty("@vitejs/plugin-vue");
  });

  it("uses only required named permissions and explicit HTTP/HTTPS host scopes", async () => {
    const manifest = await readJson<{ permissions: string[]; host_permissions: string[]; content_scripts: Array<{ matches: string[]; world?: string }> }>("public/manifest.json");
    expect([...manifest.permissions].sort()).toEqual(["alarms", "storage", "webNavigation"]);
    expect(manifest.permissions).not.toContain("activeTab");
    expect(manifest.permissions).not.toContain("tabs");
    expect([...manifest.host_permissions].sort()).toEqual(["http://*/*", "https://*/*"]);
    expect(manifest.content_scripts.some((script) => script.world === "MAIN")).toBe(true);
  });

  it("ships exact square PNGs for every declared browser icon size", async () => {
    const manifest = await readJson<{ icons: Record<string, string>; action: { default_icon: Record<string, string> } }>("public/manifest.json");
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    expect(Object.keys(manifest.icons).sort()).toEqual(["128", "16", "32", "48"]);
    for (const [declaredSize, path] of Object.entries(manifest.icons)) {
      const bytes = await readBytes(`public/${path}`);
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(bytes.readUInt32BE(16), `${path} width`).toBe(Number(declaredSize));
      expect(bytes.readUInt32BE(20), `${path} height`).toBe(Number(declaredSize));
    }
    const brand = await readBytes("public/icons/logo-256.png");
    expect(brand.readUInt32BE(16)).toBe(256);
    expect(brand.readUInt32BE(20)).toBe(256);
    expect(await exists("public/monica-logo.png")).toBe(false);
  });

  it("keeps MV3 extension code self-contained and blocks remote scripts", async () => {
    const [manifest, readme, appearance] = await Promise.all([readJson<any>("public/manifest.json"), read("README.md"), read("src/components/AppearancePanel.vue")]);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(manifest.options_page).toBe("index.html");
    expect(manifest.content_security_policy.extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest.web_accessible_resources).toEqual([{ resources: ["icons/logo-256.png"], matches: ["http://*/*", "https://*/*"], use_dynamic_url: true }]);
    expect(readme).toContain("运行时不依赖 Monica Server WebUI");
    expect(appearance).not.toContain("../i18n");
    expect(appearance).not.toContain("setLocale");
    expect(await read("scripts/package-release.mjs")).toContain('packagedEntries.set("LICENSE"');
  });

  it("ships five sanitized Chrome/Edge store screenshots at the required size", async () => {
    const names = ["01-vault-overview.png", "02-login-items.png", "03-password-sources.png", "04-explicit-autofill-popup.png", "05-save-password-prompt.png"];
    const captureScript = await read("scripts/capture-store-assets.mjs");
    expect(captureScript).toContain("example.test");
    expect(captureScript).not.toMatch(/joyins|correct horse|client-secret|server-secret/i);
    for (const name of names) {
      const bytes = await readBytes(`store-assets/${name}`);
      expect(bytes.readUInt32BE(16), `${name} width`).toBe(1280);
      expect(bytes.readUInt32BE(20), `${name} height`).toBe(800);
    }
  });
});

describe("commercial requirement traceability", () => {
  it("maps every required vertical slice to durable implementation and test evidence", async () => {
    const report = await read("docs/COMMERCIAL_ACCEPTANCE.md");
    const requiredTerms = [
      "Monica Server WebUI", "Popup", "WebDAV", "Bitwarden", "组织共享", "TOTP", "SPA", "ShadowRoot",
      "证件", "支付方式", "Passkey", "自动锁", "备份恢复", "冲突", "诊断脱敏", "图标居中",
      "reduced-motion", "zh-CN", "隐私", "SBOM", "LICENSE", "origin/main"
    ];
    for (const term of requiredTerms) expect(report, `missing acceptance evidence for ${term}`).toContain(term);
    for (const path of [
      "tests/e2e/login.spec.ts", "tests/e2e/save.spec.ts", "tests/e2e/wallet.spec.ts", "tests/e2e/passkey.spec.ts",
      "tests/e2e/dynamic-autofill.spec.ts", "tests/e2e/provider-resilience.spec.ts", "tests/e2e/visual-polish.spec.ts",
      "tests/e2e/accessibility.spec.ts", "src/providers/webdav/android-backup-codec.test.ts",
      "src/providers/bitwarden/bitwarden-provider.test.ts", "src/security/secure-vault-service.test.ts"
    ]) expect(await exists(path), `missing evidence file ${path}`).toBe(true);
    expect(report).toContain("当前状态：通过");
    expect(report).not.toMatch(/待最终门禁|待生成\/复核|REQUIRED GAP/i);
    expect(report).not.toMatch(/完整英文 UI|closed ShadowRoot.*通过|零网络数据/i);
  });
});

async function read(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

async function readBytes(path: string) {
  return readFile(new URL(path, root));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await read(path)) as T;
}

async function exists(path: string): Promise<boolean> {
  try { await readBytes(path); return true; } catch { return false; }
}
