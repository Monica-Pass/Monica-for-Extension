import { describe, expect, it } from "vitest";
import { putGpgFields, readGpgFields, putApiKeyFields } from "./credential-fields";
import { createLoginItem } from "./model";
import { groupedPasswords, expandPasswordGroupSelection } from "./password-groups";

describe("explicit Android credential fields", () => {
  it("roundtrips GPG public chunks and never puts private bytes into public fields", () => {
    const value = { publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----\n" + "合成公钥\n".repeat(700), fingerprint: "synthetic", userId: "test@example.test" };
    const fields = putGpgFields([{ name: "future", value: "retained", protected: true }], value);
    expect(readGpgFields(fields)).toEqual(value);
    expect(putGpgFields(fields, value)).toBe(fields);
    expect(fields.filter(field => field.name.startsWith("monica_gpg_public_")).every(field => field.value.length <= 2000)).toBe(true);
    expect(() => putGpgFields(fields.filter(field => field.name !== "monica_gpg_public_0000"), value)).toThrow();
    expect(putApiKeyFields(fields, "https://example.test/api").find(field => field.name === "future")?.value).toBe("retained");
    expect(putApiKeyFields([], "/internal/service").find(field => field.name === "monica_api_key_url")?.value).toBe("/internal/service");
  });
  it("only groups explicitly related records in the same database and expands whole selection", () => {
    const base = createLoginItem({ title: "Same title", username: "same", password: "synthetic", uris: [] });
    const independent = { ...base, id: "independent" };
    const one = { ...base, id: "one", passwordGroupId: "group" };
    const two = { ...base, id: "two", passwordGroupId: "group" };
    const remote = { ...two, id: "remote", providerRefs: [{ providerId: "other-db" }] };
    expect(groupedPasswords([independent, one, two, remote]).map(group => group.map(item => item.id))).toEqual([["independent"], ["one", "two"], ["remote"]]);
    expect(expandPasswordGroupSelection(["one"], [independent, one, two, remote])).toEqual(["one", "two"]);
  });
});
