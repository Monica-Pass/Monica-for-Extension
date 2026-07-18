import { afterEach, describe, expect, it, vi } from "vitest";
import type { TotpItem } from "../../core/model";
import { listSteamAuthorizedDevices, listSteamConfirmations, respondToSteamConfirmation, respondToSteamLogin } from "./steam-network";

const item: TotpItem = {
  id: "steam-item",
  kind: "totp",
  title: "Steam",
  favorite: false,
  notes: "",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  providerRefs: [],
  secret: "MTIzNDU2Nzg=",
  steamSharedSecretBase64: "MTIzNDU2Nzg=",
  steamIdentitySecret: "MTIzNDU2Nzg=",
  steamDeviceId: "android:test-device",
  steamId: "76561198000000000",
  steamAccessToken: jwt(4_102_444_800),
  otpType: "STEAM",
  algorithm: "SHA1",
  digits: 5,
  period: 30
};

afterEach(() => vi.unstubAllGlobals());

describe("Steam network services", () => {
  it("fetches mobile confirmations with the Android confirmation signature", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, conf: [{ id: "42", nonce: "nonce", headline: "Market listing", summary: ["Item", "$1.00"], creation_time: 123 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSteamConfirmations(item, 1_700_000_000)).resolves.toEqual([expect.objectContaining({ id: "42", nonce: "nonce", headline: "Market listing", summary: "Item\n$1.00" })]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/mobileconf/getlist");
    expect(parsed.searchParams.get("a")).toBe(item.steamId);
    expect(parsed.searchParams.get("p")).toBe(item.steamDeviceId);
    expect(parsed.searchParams.get("k")).toBeTruthy();
    expect((init.headers as Record<string, string>).Cookie).toContain("steamLoginSecure");
  });

  it("allows or cancels a selected transaction confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(respondToSteamConfirmation(item, { id: "42", nonce: "nonce", type: "2", headline: "Trade", summary: "", imageUrl: "", creationTime: 0 }, true, 1_700_000_000)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/mobileconf/ajaxop");
    expect(String(init.body)).toContain("op=allow");
    expect(String(init.body)).toContain("cid=42");
  });

  it("submits the signed mobile login approval protobuf", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(), { status: 200, headers: { "x-eresult": "1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(respondToSteamLogin(item, { clientId: 123456, version: 2 }, true)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toContain("UpdateAuthSessionWithMobileConfirmation");
    const body = init.body as URLSearchParams;
    expect(body.get("input_protobuf_encoded")).toBeTruthy();
    expect(body.get("input_protobuf_encoded")).not.toContain(item.steamAccessToken || "");
  });

  it("refreshes an expired Steam session and updates the in-memory vault item for persistence", async () => {
    const expired = { ...item, steamAccessToken: jwt(1), steamRefreshToken: "refresh-old" };
    const refreshedToken = `${jwt(4_102_444_800)}-refreshed`;
    const tokenBytes = Uint8Array.from([...protoStringField(1, refreshedToken), ...protoStringField(2, "refresh-new")]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(tokenBytes, { status: 200, headers: { "x-eresult": "1" } }))
      .mockResolvedValueOnce(new Response('{"success":true,"conf":[]}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listSteamConfirmations(expired, 1_700_000_000)).resolves.toEqual([]);
    expect(expired.steamAccessToken).toBe(refreshedToken);
    expect(expired.steamRefreshToken).toBe("refresh-new");
    expect(expired.steamLoginSecure).toContain(expired.steamAccessToken || "");
    expect(expired.steamRawJson).toContain("refresh-new");
  });

  it("lists authorized devices and marks the requesting token as current", async () => {
    const currentToken = 18_446_744_073_709_551_614n;
    const usage = protoMessage([
      ...protoVarintField(1, 1_700_000_000n),
      ...protoStringField(4, "CN"),
      ...protoStringField(5, "Shanghai"),
      ...protoStringField(6, "Shanghai")
    ]);
    const currentDevice = protoMessage([
      ...protoFixed64Field(1, currentToken),
      ...protoStringField(2, "Chrome on Windows"),
      ...protoVarintField(4, 3n),
      ...protoVarintField(5, 1n),
      ...protoBytesField(10, usage)
    ]);
    const oldDevice = protoMessage([
      ...protoFixed64Field(1, 42n),
      ...protoStringField(2, "Old phone")
    ]);
    const payload = Uint8Array.from([
      ...protoBytesField(1, currentDevice),
      ...protoBytesField(1, oldDevice),
      ...protoFixed64Field(2, currentToken)
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(payload, { status: 200, headers: { "x-eresult": "1" } })));

    await expect(listSteamAuthorizedDevices(item)).resolves.toEqual([
      expect.objectContaining({ tokenId: currentToken.toString(), description: "Chrome on Windows", loggedIn: true, isCurrent: true, lastSeen: expect.objectContaining({ location: "Shanghai, Shanghai, CN" }) }),
      expect.objectContaining({ tokenId: "42", description: "Old phone", isCurrent: false })
    ]);
  });
});

function jwt(exp: number): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}

function protoStringField(field: number, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [(field << 3) | 2, bytes.length, ...bytes];
}

function protoBytesField(field: number, value: number[]): number[] {
  return [(field << 3) | 2, value.length, ...value];
}

function protoMessage(value: number[]): number[] {
  return value;
}

function protoVarintField(field: number, value: bigint): number[] {
  return [(field << 3), ...rawVarint(value)];
}

function protoFixed64Field(field: number, value: bigint): number[] {
  const bytes: number[] = [];
  let current = value;
  for (let index = 0; index < 8; index++) {
    bytes.push(Number(current & 0xffn));
    current >>= 8n;
  }
  return [(field << 3) | 1, ...bytes];
}

function rawVarint(value: bigint): number[] {
  const bytes: number[] = [];
  let current = value;
  while (current > 0x7fn) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  bytes.push(Number(current));
  return bytes;
}
