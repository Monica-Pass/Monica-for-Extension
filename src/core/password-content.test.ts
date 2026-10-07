import { describe, expect, it } from "vitest";
import type { SecureCustomField } from "./model";
import { parseLosslessJson } from "./lossless-json";
import { BLOCK_PREFIX, CONTENT_ORDER, WALLET_PREFIX, contentOrder, createContentBlock, createWalletContent, editContentBlock, editWalletContent, putContentBlock, putWalletContent, readContentBlocks, readWalletContents, removeContentBlock, renderQrTemplate, withContentOrder } from "./password-content";

describe("Android 315 password content wire contract", () => {
  it("roundtrips all five kinds, repeated kinds, Unicode and 1600-char segments", async () => {
    let fields: SecureCustomField[] = [];
    for (const kind of ["API_KEY", "API_TOKEN", "SSH_KEY", "GPG_KEY", "QR_CODE", "API_KEY"] as const) {
      const block = editContentBlock(createContentBlock(kind), "合成 " + kind, { notes: "长行\n🔑".repeat(800) });
      fields = await putContentBlock(fields, block);
    }
    const blocks = await readContentBlocks(fields);
    expect(blocks).toHaveLength(6);
    expect(blocks.every(block => block.value?.data.notes === "长行\n🔑".repeat(800))).toBe(true);
    expect(fields.filter(field => /\.\d{4}$/.test(field.name)).every(field => field.protected && field.value.length <= 1600)).toBe(true);
    expect(contentOrder(fields)).toHaveLength(6);
  });

  it("patches known fields without rounding future values or removing nulls", async () => {
    const block = createContentBlock("API_KEY");
    block.raw = parseLosslessJson(`{"version":1,"id":"${block.id}","kind":"API_KEY","title":"","future":null,"data":{"key":"old","future":9223372036854775807,"decimal":1.234567890123456789}}`) as Record<string, unknown>;
    block.data = block.raw.data as Record<string, unknown>;
    const fields = await putContentBlock([], editContentBlock(block, "new title", { key: "new" }));
    const decoded = (await readContentBlocks(fields))[0].value!;
    expect(JSON.stringify(decoded.raw)).toContain('"future":9223372036854775807');
    expect(JSON.stringify(decoded.raw)).toContain('"decimal":1.234567890123456789');
    expect(decoded.raw.future).toBeNull();
    expect(decoded.data.key).toBe("new");
  });

  it.each(["missing", "duplicate", "checksum", "future"])("keeps %s blocks read-only and refuses replacement/deletion", async fault => {
    const block = createContentBlock("QR_CODE");
    const fields = await putContentBlock([], block);
    const name = BLOCK_PREFIX + block.id;
    if (fault === "missing") fields.splice(fields.findIndex(field => field.name === name + ".0000"), 1);
    if (fault === "duplicate") fields.push({ ...fields.find(field => field.name === name + ".0000")! });
    if (fault === "checksum") fields.find(field => field.name === name + ".0000")!.value = "e30=";
    if (fault === "future") fields.find(field => field.name === name)!.value = fields.find(field => field.name === name)!.value.replace('"version":1', '"version":2');
    const before = JSON.stringify(fields);
    const decoded = (await readContentBlocks(fields))[0];
    expect(decoded.value).toBeUndefined();
    expect(decoded.reason).toEqual(expect.any(String));
    await expect(putContentBlock(fields, block)).rejects.toThrow();
    await expect(removeContentBlock(fields, `BLOCK:${block.id}`)).rejects.toThrow();
    expect(JSON.stringify(fields)).toBe(before);
  });

  it("rejects oversize content and only removes the explicitly selected known block", async () => {
    const first = createContentBlock("API_KEY"), second = createContentBlock("API_KEY");
    let fields = await putContentBlock(await putContentBlock([], first), second);
    fields = withContentOrder(fields, ["PASSWORD", "FUTURE_SECTION", `BLOCK:${first.id}`, `BLOCK:${second.id}`]);
    await expect(putContentBlock(fields, editContentBlock(first, "", { key: "x".repeat(262144) }))).rejects.toThrow("256 KiB");
    const remaining = await removeContentBlock(fields, `BLOCK:${first.id}`);
    expect((await readContentBlocks(remaining)).map(block => block.value?.id)).toEqual([second.id]);
    expect(contentOrder(remaining)).toContain("FUTURE_SECTION");
    expect(contentOrder(remaining)).not.toContain(`BLOCK:${first.id}`);
  });

  it("preserves full wallet data, card face, assets, unknown custom fields and numeric tokens", () => {
    const raw = `{"version":1,"id":"copy-id","kind":"BANK_CARD","title":"Card","notes":"note","favorite":true,"future":false,"data":{"cardNumber":"4111111111111111","cardFace":{"imageAttachmentName":"wallet-image","displayMode":"ALL","showBrandIcon":false,"future":9223372036854775807},"customFields":[{"label":"legacy","value":"old","type":"TEXT","extra":null},{"label":"future","type":"FUTURE","value":"kept"}]},"assets":[{"name":"wallet-image","displayName":"Card.png","mimeType":"image/png","role":"CARD_FACE","size":68,"sha256":"${"a".repeat(64)}","extra":null}]}`;
    const fields = [{ name: WALLET_PREFIX + "bank_card", value: raw, protected: true }];
    const original = readWalletContents(fields)[0].value!;
    const changed = editWalletContent(original, { title: "Edited", data: { customFields: [{ label: "legacy", value: "new", type: "TEXT" }] } });
    const saved = putWalletContent(fields, changed)[0].value;
    expect(saved).toContain('"future":9223372036854775807');
    expect(saved).toContain('"type":"FUTURE"');
    expect(saved).toContain('"extra":null');
    expect(readWalletContents(putWalletContent(fields, changed))[0].value?.assets).toEqual(original.assets);
    expect(original.title).toBe("Card");
  });

  it("creates all wallet copies and refuses duplicate/future snapshot replacement", () => {
    let fields: SecureCustomField[] = [];
    for (const kind of ["BANK_CARD", "DOCUMENT", "ADDRESS", "NOTE"] as const) fields = putWalletContent(fields, createWalletContent(kind, kind, {}));
    expect(readWalletContents(fields).every(value => value.value)).toBe(true);
    const note = fields.find(field => field.name.endsWith(".note"))!;
    fields.push({ ...note });
    expect(readWalletContents(fields).find(value => value.originalFields.length === 2)?.reason).toBeTruthy();
    expect(() => putWalletContent(fields, createWalletContent("NOTE", "", {}))).toThrow();
    expect(() => withContentOrder([{ name: CONTENT_ORDER, value: "", protected: true }, { name: CONTENT_ORDER, value: "", protected: true }], [])).toThrow();
  });

  it("expands QR tokens once, escapes WiFi substitutions and rejects ambiguous references", () => {
    const item = { username: "a;b", password: "%ACCOUNT%", title: "test", uris: ["https://example.test/"], notes: "", customFields: [{ name: "token", value: "synthetic", protected: true }] };
    expect(renderQrTemplate("%PASSWORD% %% %FIELD:dG9rZW4%", item)).toBe("%ACCOUNT% % synthetic");
    expect(renderQrTemplate("WIFI:S:%ACCOUNT%;P:%PASSWORD%;;", item)).toBe("WIFI:S:a\\;b;P:%ACCOUNT%;;");
    expect(() => renderQrTemplate("%UNKNOWN%", item)).toThrow();
    expect(() => renderQrTemplate("%FIELD:dG9rZW4%", { ...item, customFields: [...item.customFields, ...item.customFields] })).toThrow();
  });
});
