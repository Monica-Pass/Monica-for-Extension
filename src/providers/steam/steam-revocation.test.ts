import { afterEach, describe, expect, it, vi } from "vitest";
import type { TotpItem } from "../../core/model";
import { encryptSteamPasswordPkcs1, revokeSteamAuthorizedDevice } from "./steam-revocation";

const item: TotpItem = {
  id: "steam-revoke",
  kind: "totp",
  title: "Steam",
  favorite: false,
  notes: "",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  providerRefs: [],
  secret: "MTIzNDU2Nzg=",
  accountName: "steam_user",
  steamId: "76561198000000000",
  steamSharedSecretBase64: "MTIzNDU2Nzg=",
  steamAccessToken: jwt(4_102_444_800),
  otpType: "STEAM",
  algorithm: "SHA1",
  digits: 5,
  period: 30
};

afterEach(() => vi.unstubAllGlobals());

describe("Steam authorized-device revocation", () => {
  it("creates PKCS#1 v1.5 output with the RSA modulus length", () => {
    const modulus = "ff".repeat(128);
    const encoded = encryptSteamPasswordPkcs1("password", modulus, "01");
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    expect(bytes).toHaveLength(128);
    expect(bytes[0]).toBe(0);
    expect(bytes[1]).toBe(2);
    expect(new TextDecoder().decode(bytes.slice(-8))).toBe("password");
  });

  it("runs the Android-compatible authentication and revokes the requested token", async () => {
    const modulus = "ff".repeat(128);
    const requestId = Uint8Array.from([1, 2, 3, 4]);
    const steamId = BigInt(item.steamId!);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: { publickey_mod: modulus, publickey_exp: "01", timestamp: "1700000000" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([...varintField(1, 123n), ...bytesField(2, requestId), ...fixed64Field(5, steamId)]), { status: 200, headers: { "x-eresult": "1" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(), { status: 200, headers: { "x-eresult": "1" } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([...stringField(3, "refresh-temp"), ...stringField(4, "access-temp")]), { status: 200, headers: { "x-eresult": "1" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(), { status: 200, headers: { "x-eresult": "1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const input = { accountName: "steam_user", password: "correct horse", tokenId: "42" };
    await expect(revokeSteamAuthorizedDevice(item, input, { now: () => 1_700_000_010_000, pollAttempts: 1, pollIntervalMs: 0 })).resolves.toEqual({ success: true, tokenId: "42" });
    expect(input.password).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain("GetPasswordRSAPublicKey");
    expect(urls.some((url) => url.includes("correct%20horse"))).toBe(false);
    const beginBody = String((fetchMock.mock.calls[1]?.[1] as RequestInit).body);
    expect(beginBody).not.toContain("correct horse");
    const pollBody = String((fetchMock.mock.calls[3]?.[1] as RequestInit).body);
    expect(pollBody).toContain("input_protobuf_encoded");
  });

  it("rejects invalid targets before sending credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(revokeSteamAuthorizedDevice(item, { accountName: "steam_user", password: "password", tokenId: "42/../1" })).rejects.toThrow("无效");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function stringField(field: number, value: string): number[] {
  return bytesField(field, new TextEncoder().encode(value));
}

function bytesField(field: number, value: Uint8Array): number[] {
  return [(field << 3) | 2, ...rawVarint(BigInt(value.length)), ...value];
}

function varintField(field: number, value: bigint): number[] {
  return [field << 3, ...rawVarint(value)];
}

function fixed64Field(field: number, value: bigint): number[] {
  const bytes: number[] = [];
  let current = value;
  for (let index = 0; index < 8; index++) { bytes.push(Number(current & 0xffn)); current >>= 8n; }
  return [(field << 3) | 1, ...bytes];
}

function rawVarint(value: bigint): number[] {
  const bytes: number[] = [];
  let current = value;
  while (current > 0x7fn) { bytes.push(Number((current & 0x7fn) | 0x80n)); current >>= 7n; }
  bytes.push(Number(current));
  return bytes;
}

function jwt(exp: number): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}
