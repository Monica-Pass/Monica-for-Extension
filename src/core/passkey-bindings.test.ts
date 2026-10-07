import { describe, expect, it } from "vitest";
import { addPasskeyBinding, patchPasskeyBinding, readPasskeyBindings, removePasskeyBinding } from "./passkey-bindings";

describe("Passkey binding metadata (not signing capability)", () => {
  it("edits known fields without losing future numbers, nulls, or missing fields", () => {
    const raw = '[ {"rpId":"example.test","future":9223372036854775807,"nullable":null} ]';
    expect(patchPasskeyBinding(raw, 0, { rpId: "example.test", userName: "" })).toBe(raw);
    const edited = patchPasskeyBinding(raw, 0, { userName: "renamed" });
    expect(edited).toContain('"future":9223372036854775807');
    expect(edited).toContain('"nullable":null');
    expect(readPasskeyBindings(edited)[0].userName).toBe("renamed");
    expect(readPasskeyBindings(edited)[0]).not.toHaveProperty("privateKeyPkcs8");
  });
  it("rejects malformed data without replacing it with empty data", () => {
    for (const raw of ['{', '{}', '[null]', '[{"credentialId":123}]']) expect(() => addPasskeyBinding(raw)).toThrow();
    expect(() => patchPasskeyBinding("[]", 0, { rpId: "x" })).toThrow();
    expect(readPasskeyBindings(removePasskeyBinding(addPasskeyBinding(""), 0))).toEqual([]);
  });
});
