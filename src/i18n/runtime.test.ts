import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import english from "./ui-en.json";
import { localeOptions } from "./locales";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function browser(language: string, stored?: unknown) {
  let changed: (changes: Record<string, { newValue?: unknown }>, area: string) => void = () => undefined;
  const set = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { language });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(readFileSync(path.resolve("public/locales", new URL(url).pathname.split("/").pop()!), "utf8"))));
  vi.stubGlobal("chrome", {
    runtime: { getURL: (resource: string) => `chrome-extension://localization-test/${resource}` },
    storage: {
      local: { get: vi.fn(async () => ({ "monica.locale": stored })), set },
      onChanged: { addListener: vi.fn((listener) => { changed = listener; }) }
    }
  });
  return { set, change: (value: unknown) => changed({ "monica.locale": { newValue: value } }, "local") };
}

describe("shared interface language", () => {
  it.each([["zh-TW", "zh-CN"], ["en-GB", "en"], ["de-AT", "de"], ["ja-JP", "ja"], ["ko-KR", "ko"], ["es-MX", "es"], ["ru-RU", "ru"], ["vi-VN", "vi"], ["fr-FR", "en"]])("defaults %s to %s", async (language, expected) => {
    browser(language);
    const runtime = await import("./runtime");
    await runtime.initializeUiLocale();
    expect(runtime.getUiLocale()).toBe(expected);
    expect(runtime.getUiLocalePreference()).toBe("system");
  });

  it("uses the saved preference and follows changes from other extension surfaces", async () => {
    const storage = browser("en-US", "zh-CN");
    const runtime = await import("./runtime");
    await runtime.initializeUiLocale();
    expect(runtime.tr("解锁 Monica")).toBe("解锁 Monica");
    storage.change("en");
    await vi.waitFor(() => expect(runtime.tr("解锁 Monica")).toBe("Unlock Monica"));
    storage.change(undefined);
    await vi.waitFor(() => expect(runtime.getUiLocalePreference()).toBe("system"));
    expect(runtime.getUiLocale()).toBe("en");
  });

  it("migrates an explicitly supplied legacy extension preference only when none is saved", async () => {
    const storage = browser("en-US");
    const runtime = await import("./runtime");
    await runtime.initializeUiLocale("zh-CN");
    expect(runtime.getUiLocale()).toBe("zh-CN");
    expect(storage.set).toHaveBeenCalledWith({ "monica.locale": "zh-CN" });
  });

  it("does not read preferences from a website’s localStorage", async () => {
    browser("en-US");
    const getItem = vi.fn(() => "zh-CN");
    vi.stubGlobal("localStorage", { getItem });
    const runtime = await import("./runtime");
    await runtime.initializeUiLocale();
    expect(getItem).not.toHaveBeenCalled();
    expect(runtime.getUiLocale()).toBe("en");
  });

  it("preserves user content and substituted values verbatim", async () => {
    const runtime = await import("./runtime");
    runtime.updateUiLocale("en");
    const title = "我的账户 <script> $& {password}";
    expect(runtime.tr("编辑{0}", { 0: title })).toBe(`Edit ${title}`);
    expect(runtime.tr(title)).toBe(title);
    expect(runtime.translateRuntimeError(`项目「${title}」在传输期间发生变化，请重新读取后重试。`))
      .toBe(`Item “${title}” changed during the transfer. Read it again and retry.`);
    expect(runtime.translateRuntimeError("Unrecognized upstream error 741")).toBe("Unrecognized upstream error 741");
  });

  it("reactively updates labels in provider presenters", async () => {
    const { computed } = await import("vue");
    const runtime = await import("./runtime");
    const { mdbx2HealthCategoryLabel } = await import("../providers/mdbx2/mdbx2-diagnostics");
    const label = computed(() => mdbx2HealthCategoryLabel("attachment-chunks"));
    runtime.updateUiLocale("zh-CN");
    expect(label.value).toBe("附件分片");
    runtime.updateUiLocale("en");
    expect(label.value).toBe("Attachment chunks");
  });

  it("uses the first supported browser preference and loads only that offline catalog", async () => {
    browser("fr-FR");
    vi.stubGlobal("navigator", { language: "fr-FR", languages: ["fr-FR", "es-MX", "en-US"] });
    const runtime = await import("./runtime");
    await runtime.initializeUiLocale();
    expect(runtime.getUiLocale()).toBe("es");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("chrome-extension://localization-test/locales/ui-es.json");
    await runtime.selectUiLocale("es");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows browser changes only while the browser preference is selected", async () => {
    browser("en-US");
    const events = new EventTarget();
    const languages = { language: "en-US", languages: ["en-US"] };
    vi.stubGlobal("window", events);
    vi.stubGlobal("navigator", languages);
    const runtime = await import("./runtime");
    await runtime.initializeUiLocale();
    await runtime.selectUiLocale("de");
    languages.languages = ["vi-VN"];
    events.dispatchEvent(new Event("languagechange"));
    expect(runtime.getUiLocale()).toBe("de");
    await runtime.selectUiLocale("system");
    expect(runtime.getUiLocale()).toBe("vi");
    languages.languages = ["es-ES"];
    events.dispatchEvent(new Event("languagechange"));
    await vi.waitFor(() => expect(runtime.getUiLocale()).toBe("es"));
    expect(runtime.getUiLocalePreference()).toBe("system");
  });

  it("bounds inactive language caches and reloads an evicted language offline", async () => {
    browser("en-US");
    const runtime = await import("./runtime");
    await runtime.initializeUiLocale();
    for (const language of ["ja", "de", "ko", "es", "vi", "ru"] as const) await runtime.selectUiLocale(language);
    expect(fetch).toHaveBeenCalledTimes(6);
    await runtime.selectUiLocale("ja");
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(runtime.tr("解锁")).toBe("ロック解除");
  });

  it("does not let a delayed language load replace a newer selection", async () => {
    browser("en-US");
    const runtime = await import("./runtime");
    await runtime.initializeUiLocale();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const earlier = runtime.selectUiLocale("ja");
    await runtime.selectUiLocale("de");
    finish(new Response(readFileSync("public/locales/ui-ja.json", "utf8")));
    expect(await earlier).toBe(false);
    expect(runtime.getUiLocale()).toBe("de");
    expect(runtime.getUiLocalePreference()).toBe("de");
  });

  it("retains a usable language after a broken catalog and can retry", async () => {
    browser("en-US");
    const runtime = await import("./runtime");
    await runtime.initializeUiLocale();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ "解锁": "Unlock" })));
    await expect(runtime.selectUiLocale("ja")).rejects.toThrow("Incomplete language catalog");
    expect(runtime.getUiLocale()).toBe("en");
    await runtime.selectUiLocale("ja");
    expect(runtime.getUiLocale()).toBe("ja");
  });

  it("treats prototype names as plain, untranslated strings", async () => {
    const runtime = await import("./runtime");
    runtime.updateUiLocale("en");
    expect(runtime.tr("toString")).toBe("toString");
    expect(runtime.translateRuntimeError("__proto__")).toBe("__proto__");
  });
});

describe("translation catalog completeness", () => {
  for (const option of localeOptions.filter((option) => option.value !== "zh-CN" && option.value !== "en")) {
    it(`${option.label} covers every message, preserves parameters and has browser metadata`, () => {
      const catalog = JSON.parse(readFileSync(`public/locales/ui-${option.value}.json`, "utf8")) as Record<string, string>;
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(english).sort());
      const parameters = (value: string) => (value.match(/\{\w+\}/g) || []).sort();
      for (const [source, translated] of Object.entries(catalog)) {
        expect(typeof translated, source).toBe("string");
        expect(translated.trim(), source).not.toBe("");
        expect(parameters(translated), source).toEqual(parameters(source));
        expect(translated, source).not.toMatch(/<2[a-z]+>|<unk>|<pad>|<\/s>/);
      }
      const manifest = JSON.parse(readFileSync(`public/_locales/${option.manifest}/messages.json`, "utf8"));
      for (const key of ["extensionName", "extensionDescription", "actionTitle"]) expect(manifest[key].message.length).toBeGreaterThan(0);
      expect(manifest.extensionDescription.message.length).toBeLessThanOrEqual(132);
    });
  }

  it("preserves all parameters and has no untranslated Chinese in English messages", () => {
    const parameters = (value: string) => (value.match(/\{\w+\}/g) || []).sort();
    for (const [source, translated] of Object.entries(english)) {
      expect(parameters(translated), source).toEqual(parameters(source));
      expect(translated, source).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it("covers every literal passed to the UI translator", () => {
    const dictionary = english as Record<string, string>;
    const missing: string[] = [];
    function inspect(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { inspect(file); continue; }
        if (!/\.(vue|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) continue;
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/\btr\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)) {
          const parsed = ts.createSourceFile("message.ts", match[1], ts.ScriptTarget.Latest, true);
          const statement = parsed.statements[0];
          if (!statement || !ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) continue;
          const key = statement.expression.text;
          if (/[\u3400-\u9fff]/.test(key) && !dictionary[key]) missing.push(`${file}: ${key}`);
        }
      }
    }
    inspect(path.resolve("src"));
    expect(missing).toEqual([]);
  });
});
