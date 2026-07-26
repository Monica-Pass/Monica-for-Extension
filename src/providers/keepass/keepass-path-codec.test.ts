import { describe, expect, it } from "vitest";
import {
  buildKeePassPathKey,
  decodeKeePassPathForDisplay,
  decodeKeePassPathSegments,
  encodeKeePassPathSegment,
  isKeePassRecycleBinPath
} from "./keepass-path-codec";

/** Assertion semantics translated from Android `KeePassPathCodec.kt`. */
describe("keePass path codec", () => {
  it("percent-encodes a segment so a group name containing a slash survives", () => {
    expect(encodeKeePassPathSegment("Work / Home")).toBe("Work%20%2F%20Home");
    expect(decodeKeePassPathSegments("Work%20%2F%20Home")).toEqual(["Work / Home"]);
  });

  it("leaves the root group out of the path", () => {
    expect(buildKeePassPathKey(undefined, "Email")).toBe("Email");
    expect(buildKeePassPathKey("", "Email")).toBe("Email");
    expect(buildKeePassPathKey("Email", "Work")).toBe("Email/Work");
  });

  it("round-trips a multi-level path", () => {
    const path = buildKeePassPathKey(buildKeePassPathKey(undefined, "银行"), "储蓄卡");

    expect(decodeKeePassPathSegments(path)).toEqual(["银行", "储蓄卡"]);
  });

  it("renders a display path with the Android separator", () => {
    expect(decodeKeePassPathForDisplay("A/B%2FC")).toBe("A > B/C");
  });

  it("returns the raw key when there is nothing to decode", () => {
    expect(decodeKeePassPathForDisplay("")).toBe("");
    expect(decodeKeePassPathSegments(undefined)).toEqual([]);
  });

  it("does not throw on a stray percent that is not an escape", () => {
    expect(decodeKeePassPathSegments("100%25/50%")).toEqual(["100%", "50%"]);
  });

  it("recognises the recycle bin by name in any of the three spellings", () => {
    expect(isKeePassRecycleBinPath("Recycle%20Bin")).toBe(true);
    expect(isKeePassRecycleBinPath("trash")).toBe(true);
    expect(isKeePassRecycleBinPath("%E5%9B%9E%E6%94%B6%E7%AB%99")).toBe(true);
    expect(isKeePassRecycleBinPath("Email/Work")).toBe(false);
  });
});
