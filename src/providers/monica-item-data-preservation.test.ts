import { describe, expect, it } from "vitest";
import { parseLosslessJson } from "../core/lossless-json";
import { mergeMonicaItemData, monicaItemDataToVaultItem, vaultItemToMonicaItemData } from "./monica-item-data";

const base = { id: "synthetic-note", title: "note", notes: "", favorite: false, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", providerRefs: [] };
describe("SecureItem custom field surgical edits", () => {
  it("preserves untouched null, absent, large numeric and unprojected array members", () => {
    const raw = '{"content":"note","customFields":[{"label":"A","value":"old","type":"TEXT","future":9007199254740993},{"label":"B","value":null},{"label":"C","value":9223372036854775807},{"label":"","value":"kept","type":"TEXT"},null,{"label":"future","type":"FUTURE","value":"kept"}]}';
    const source = parseLosslessJson(raw) as Record<string, unknown>;
    const item = monicaItemDataToVaultItem("NOTE", source, base)!;
    if (item.kind !== "secure-note") throw new Error("fixture");
    const result = vaultItemToMonicaItemData({ ...item, customFields: item.customFields!.map((field, index) => index === 0 ? { ...field, value: "changed" } : field) }, raw, item)!;
    expect(result).toBe(raw.replace('"value":"old"', '"value":"changed"'));
  });

  it("retains future member metadata on a rename and honors a visible deletion", () => {
    const source = { customFields: [{ label: "A", value: "old", type: "TEXT", future: { keep: null } }, { futureOnly: true }, { label: "B", value: "b", type: "HIDDEN" }] };
    const renamed = mergeMonicaItemData(source, { customFields: [{ label: "Renamed", value: "new", type: "TEXT" }, { label: "B", value: "b", type: "HIDDEN" }] });
    expect(renamed.customFields).toEqual([{ label: "Renamed", value: "new", type: "TEXT", future: { keep: null } }, { futureOnly: true }, { label: "B", value: "b", type: "HIDDEN" }]);
    expect(mergeMonicaItemData(source, { customFields: [{ label: "B", value: "b", type: "HIDDEN" }] }).customFields).toEqual([{ label: "B", value: "b", type: "HIDDEN" }, { futureOnly: true }]);
  });

  it("keeps duplicate-label identities and does not duplicate full raw future members", () => {
    const source = { customFields: [{ label: "same", value: "a", type: "TEXT", id: 1 }, { label: "same", value: "b", type: "TEXT", id: 2 }, { label: "future", type: "FUTURE", id: 3 }] };
    const result = mergeMonicaItemData(source, { customFields: [{ label: "same", value: "changed", type: "TEXT" }, { label: "same", value: "b", type: "TEXT" }] });
    expect(result.customFields).toEqual([{ label: "same", value: "changed", type: "TEXT", id: 1 }, source.customFields[1], source.customFields[2]]);
    expect(mergeMonicaItemData(source, result)).toEqual(result);
  });
});
