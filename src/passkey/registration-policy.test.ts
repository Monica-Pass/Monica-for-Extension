import { describe, expect, it } from "vitest";
import { selectPasskeyRegistrationAlgorithm } from "./registration-policy";

describe("Passkey registration negotiation", () => {
  it.each(["local", "mdbx2", "keepass"])("honors RP preference for %s", source => {
    expect(selectPasskeyRegistrationAlgorithm([-999, -257, -7], source)).toBe(-257);
    expect(selectPasskeyRegistrationAlgorithm([-7, -257], source)).toBe(-7);
    expect(selectPasskeyRegistrationAlgorithm([-257], source)).toBe(-257);
    expect(selectPasskeyRegistrationAlgorithm([-8, -37], source)).toBeUndefined();
  });
  it("offers Bitwarden only when the RP permits its standard ES256 format", () => {
    expect(selectPasskeyRegistrationAlgorithm([-257, -7], "bitwarden")).toBe(-7);
    expect(selectPasskeyRegistrationAlgorithm([-257], "bitwarden")).toBeUndefined();
    expect(selectPasskeyRegistrationAlgorithm([-7], "monica-webdav")).toBeUndefined();
    expect(selectPasskeyRegistrationAlgorithm([], "local")).toBeUndefined();
  });
});
