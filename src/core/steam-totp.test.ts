import { describe, expect, it } from "vitest";
import { generateSteamCode, steamSecondsRemaining } from "./steam-totp";

describe("Steam Guard TOTP", () => {
  it("matches the Android Steam alphabet and counter encoding", async () => {
    await expect(generateSteamCode("MTIzNDU2Nzg=", 0)).resolves.toBe("K784R");
  });

  it("reports the same 30-second boundary as Android", () => {
    expect(steamSecondsRemaining(0)).toBe(30);
    expect(steamSecondsRemaining(29_000)).toBe(1);
    expect(steamSecondsRemaining(30_000)).toBe(30);
  });
});
