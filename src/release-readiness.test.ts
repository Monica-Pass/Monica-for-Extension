import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("release-facing localization", () => {
  it("resolves every MV3 store string through the declared zh-CN locale", async () => {
    const manifest = JSON.parse(await read("public/manifest.json")) as Record<string, any>;
    const messages = JSON.parse(await read("public/_locales/zh_CN/messages.json")) as Record<string, { message: string; description?: string }>;

    expect(manifest.default_locale).toBe("zh_CN");
    for (const field of [manifest.name, manifest.description, manifest.action.default_title]) {
      expect(field).toMatch(/^__MSG_[A-Za-z0-9_]+__$/);
      const key = field.slice(6, -2);
      expect(messages[key]?.message, `missing locale key ${key}`).toBeTruthy();
      expect(messages[key]?.description, `missing translator context ${key}`).toBeTruthy();
    }
    expect(messages.extensionName.message.length).toBeLessThanOrEqual(45);
    expect(messages.extensionDescription.message.length).toBeLessThanOrEqual(132);
  });

  it("declares the actual first-release interface language", async () => {
    const [readme, localePolicy] = await Promise.all([read("README.md"), read("docs/LOCALIZATION.md")]);
    expect(`${readme}\n${localePolicy}`).toContain("zh-CN");
    expect(localePolicy).toContain("首发");
    expect(localePolicy).not.toMatch(/完整英文|fully translated/i);
  });
});

describe("store-facing privacy and security artifacts", () => {
  it("documents every declared permission and host scope", async () => {
    const manifest = JSON.parse(await read("public/manifest.json")) as { permissions: string[]; host_permissions: string[] };
    const permissions = await read("docs/PERMISSIONS.md");
    for (const permission of [...manifest.permissions, ...manifest.host_permissions]) {
      expect(permissions, `missing permission disclosure for ${permission}`).toContain(`\`${permission}\``);
    }
    expect(permissions).toContain("MAIN world");
    expect(permissions).toContain("完整密码库");
  });

  it("discloses storage, exports, optional provider transmission and diagnostics consistently", async () => {
    const [privacy, dataSafety] = await Promise.all([read("docs/PRIVACY.md"), read("docs/DATA_SAFETY.md")]);
    const disclosure = `${privacy}\n${dataSafety}`;
    for (const term of ["IndexedDB", "chrome.storage.session", "WebDAV Basic Auth", "普通 ZIP", "Bitwarden", "明文", "加密整库备份", "脱敏诊断", "Passkey", "MAIN-world"]) {
      expect(disclosure, `missing disclosure: ${term}`).toContain(term);
    }
    expect(disclosure).toContain("不自动上传");
    expect(disclosure).not.toMatch(/零网络|不进行任何网络|no network transmission/i);
  });

  it("keeps listing metadata and security contact publishable", async () => {
    const [messages, listing, security] = await Promise.all([
      readJson<Record<string, { message: string }>>("public/_locales/zh_CN/messages.json"),
      read("docs/STORE_LISTING.zh-CN.md"),
      read("SECURITY.md")
    ]);
    expect(listing).toContain(messages.extensionName.message);
    expect(listing).toContain(messages.extensionDescription.message);
    expect(listing).toContain("zh-CN");
    expect(security).toContain("GitHub Security Advisories");
    expect(security).not.toMatch(/guarantee|保证在.*修复/i);
  });
});

describe("reproducible release contract", () => {
  it("keeps deterministic packaging and independent verification in the release gate", async () => {
    const [pkg, workflow, releaseGuide, packager, verifier] = await Promise.all([
      readJson<{ scripts: Record<string, string> }>("package.json"),
      read(".github/workflows/ci.yml"),
      read("docs/RELEASE.md"),
      read("scripts/package-release.mjs"),
      read("scripts/verify-release.mjs")
    ]);
    expect(pkg.scripts["package:verify"]).toContain("verify-release.mjs");
    expect(pkg.scripts["release:check"]).toContain("package:verify");
    expect(pkg.scripts["verify:supply-chain"]).toContain("verify:lockfile");
    expect(workflow).toContain("npm run package:verify");
    for (const term of ["SHA-256", "CycloneDX", "1980-01-01", "逐字节相同"]) expect(releaseGuide).toContain(term);
    expect(packager).toContain("RELEASE-METADATA.json");
    expect(packager).toContain("THIRD-PARTY-LICENSES.json");
    expect(verifier).toContain("byte-reproducible");
  });
});

async function read(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await read(path)) as T;
}
