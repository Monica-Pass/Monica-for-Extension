import { describe, expect, it } from "vitest";
import { createLoginItem } from "../core/model";
import { preserveLoginFormSource } from "./login-edit-projection";
describe("login form source preservation", () => {
  it("preserves a stable SSO account on unrelated edits", () => {
    const original = { ...createLoginItem({ title: "old" }), ssoRefLogicalId: "password:account" };
    const before = { name: "old", loginType: "SSO", ssoRefEntryId: "" };
    const result = preserveLoginFormSource(original, { ...original, title: "new", ssoRefLogicalId: undefined }, JSON.stringify(before), { ...before, name: "new" });
    expect(result.ssoRefLogicalId).toBe("password:account");
  });
  it("retains absent application metadata on unrelated edits and permits explicit clearing", () => {
    const original = createLoginItem({ title: "old" });
    const before = { name: "old", appName: "", appPackageName: "" };
    const result = preserveLoginFormSource(original, { ...original, title: "new", appName: "", appPackageName: "" }, JSON.stringify(before), { ...before, name: "new" });
    expect(result).not.toHaveProperty("appName");
    expect(result).not.toHaveProperty("appPackageName");
    const bound = { ...original, appName: "App", appPackageName: "com.example.app" };
    const cleared = preserveLoginFormSource(bound, { ...bound, appPackageName: "" }, JSON.stringify({ ...before, appName: "App", appPackageName: "com.example.app" }), { ...before, appName: "App" });
    expect(cleared.appName).toBe("App");
    expect(cleared.appPackageName).toBe("");
  });
  it("does not normalize unrelated values when just the title changes", () => {
    const original = { ...createLoginItem({ title: "old", uris: [" https://example.test/a;b "] }), customFields: [{ name: "", value: "", protected: true }], email: null } as unknown as ReturnType<typeof createLoginItem>;
    const before = { name: "old", email: "", uriRules: [{ uri: " https://example.test/a;b " }], customFields: original.customFields, totpSecret: "" };
    const candidate = { ...original, title: "new", email: "", uris: ["https://example.test/a;b"], customFields: [], totpSecret: undefined };
    const result = preserveLoginFormSource(original, candidate, JSON.stringify(before), { ...before, name: "new" });
    expect(result.title).toBe("new"); expect(result.email).toBeNull(); expect(result.uris).toEqual(original.uris); expect(result.customFields).toEqual(original.customFields);
    expect(Object.prototype.hasOwnProperty.call(result, "totpSecret")).toBe(Object.prototype.hasOwnProperty.call(original, "totpSecret"));
  });
});
