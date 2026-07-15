import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("commercial installability and least privilege", () => {
  it("ships a complete GPLv3 license and repository identity", async () => {
    const [license, pkg] = await Promise.all([read("LICENSE"), readJson<{ license: string; repository: { url: string } }>("package.json")]);
    expect(pkg.license).toBe("GPL-3.0-only");
    expect(pkg.repository.url).toBe("https://github.com/Monica-Pass/Monica-for-Extension.git");
    expect(license).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 29 June 2007");
    expect(license.length).toBeGreaterThan(30_000);
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
  });

  it("keeps MV3 extension code self-contained and blocks remote scripts", async () => {
    const [manifest, readme, appearance] = await Promise.all([readJson<any>("public/manifest.json"), read("README.md"), read("src/components/AppearancePanel.vue")]);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(manifest.options_page).toBe("index.html");
    expect(manifest.content_security_policy.extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(readme).toContain("运行时不依赖 Monica Server WebUI");
    expect(appearance).not.toContain("../i18n");
    expect(appearance).not.toContain("setLocale");
    expect(await read("scripts/package-release.mjs")).toContain('packagedEntries.set("LICENSE"');
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
