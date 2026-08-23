import { describe, expect, it } from "vitest";
import { parseSteamQrChallenge } from "./steam-qr";

describe("Steam QR challenge", () => {
  it("parses the Android challenge URL", () => {
    expect(parseSteamQrChallenge("https://s.team/q/2/123456789")).toEqual({ version: 2, clientId: 123456789 });
  });

  it("accepts wrapped and URL encoded Steam links", () => {
    expect(parseSteamQrChallenge("steam://openurl/https%3A%2F%2Fsteamcommunity.com%2Fq%2F1%2F42")).toEqual({ version: 1, clientId: 42 });
    expect(parseSteamQrChallenge("prefix https://s.team/q/3/99 suffix")).toEqual({ version: 3, clientId: 99 });
  });

  it("supports unsigned 64-bit client ids without precision loss", () => {
    expect(parseSteamQrChallenge("https://s.team/q/1/18446744073709551615")).toEqual({ version: 1, clientId: -1 });
  });

  it("rejects non-Steam, malformed, and oversized payloads", () => {
    expect(parseSteamQrChallenge("https://example.com/q/1/42")).toBeUndefined();
    expect(parseSteamQrChallenge("https://s.team/q/x/42")).toBeUndefined();
    expect(parseSteamQrChallenge("https://s.team/q/1/0")).toBeUndefined();
    expect(parseSteamQrChallenge("x".repeat(20000))).toBeUndefined();
  });
});
