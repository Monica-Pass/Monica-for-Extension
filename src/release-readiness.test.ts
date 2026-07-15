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

async function read(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}
