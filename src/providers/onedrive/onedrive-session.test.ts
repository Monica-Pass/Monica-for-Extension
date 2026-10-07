import { describe, expect, it, vi } from "vitest";
import type { ProviderAccount } from "../../core/model";
import { OneDriveSessionService } from "./onedrive-session";
import { MONICA_ONEDRIVE_CLIENT_ID } from "./onedrive-auth";

const loginId = "00000000-0000-4000-8000-000000000001";
const redirect = `https://${"a".repeat(32)}.chromiumapp.org/onedrive`;
const profile = { id: "user1", displayName: "Synthetic", username: "test@example.invalid" };
const drive = { id: "drive1", name: "OneDrive", driveType: "personal" };
const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: 3601000, scope: "Files.ReadWrite User.Read" };
function fixture() {
  let sessionId: string | undefined = "session-1", now = 1000;
  const accounts = new Map<string, ProviderAccount>();
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const target = String(url);
    if (target.endsWith("/token")) return Response.json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, token_type: "Bearer", scope: tokens.scope, expires_in: 3600 });
    if (target.includes("/me?")) return Response.json({ ...profile, mail: profile.username });
    if (target.includes("/me/drive?")) return Response.json(drive);
    if (target.includes("/children")) return Response.json({ value: [{ id: "file1", name: "Vault.kdbx", size: 4, eTag: '"v1"', parentReference: { driveId: drive.id }, file: {} }] });
    throw new Error("Unexpected test request");
  });
  const vault = { sessionId: vi.fn(async () => sessionId), getProvider: vi.fn(async (id: string) => structuredClone(accounts.get(id))), rotateOneDriveTokens: vi.fn(async () => {}) };
  const service = new OneDriveSessionService(vault, fetcher, () => now);
  const launch = vi.fn(async (url: string) => `${redirect}?state=${new URL(url).searchParams.get("state")}&code=synthetic-code`);
  const account: ProviderAccount = { id: "provider1", kind: "keepass", name: "Test", enabled: true, isDefaultSaveTarget: false, config: { sourceMode: "onedrive", oneDriveDriveId: "drive1", oneDriveItemId: "file1",
    oneDriveConnection: { id: loginId, clientId: MONICA_ONEDRIVE_CLIENT_ID, profile, tokens } } };
  return { service, vault, fetcher, launch, account, accounts, setSession: (value?: string) => { sessionId = value; }, advance: () => { now += 11 * 60_000; } };
}

describe("OneDrive interactive session binding", () => {
  it("exposes only an expiring login handle, account display and file identities", async () => {
    const f = fixture();
    expect(await f.service.login(loginId, redirect, f.launch)).toEqual({ loginId, profile, drive });
    const page = await f.service.browse({ loginId });
    expect(page).toMatchObject({ profile, drive, items: [{ itemId: "file1", driveId: "drive1", name: "Vault.kdbx" }] });
    expect(JSON.stringify(page)).not.toMatch(/synthetic-access|synthetic-refresh|downloadUrl/);
    expect((await f.service.connectionForLogin(loginId)).tokens).toEqual(tokens);
    expect(f.vault.rotateOneDriveTokens).not.toHaveBeenCalled();
  });

  it("does not launch Microsoft sign-in while the password vault is locked", async () => {
    const f = fixture(); f.setSession();
    await expect(f.service.login(loginId, redirect, f.launch)).rejects.toThrow(/解锁/);
    expect(f.launch).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("rejects a callback after locking or switching vault sessions before exchanging its code", async () => {
    const f = fixture();
    const launch = async (url: string) => { f.service.clear(); f.setSession("new-session"); return f.launch(url); };
    await expect(f.service.login(loginId, redirect, launch)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(f.service.connectionForLogin(loginId)).rejects.toThrow();
  });

  it("discards a sign-in result if the vault session changes while Microsoft returns tokens", async () => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async () => {
      f.setSession("new-session");
      return Response.json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, expires_in: 3600, scope: tokens.scope, token_type: "Bearer" });
    });
    await expect(f.service.login(loginId, redirect, f.launch)).rejects.toThrow(/会话已变化/);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("invalidates cancelled and expired drafts and never persists them", async () => {
    const f = fixture();
    await f.service.login(loginId, redirect, f.launch);
    f.service.cancel(loginId);
    await expect(f.service.browse({ loginId })).rejects.toThrow();
    await f.service.login(loginId, redirect, f.launch);
    f.advance();
    await expect(f.service.connectionForLogin(loginId)).rejects.toThrow();
    expect(f.accounts.size).toBe(0);
  });

  it("prevents concurrent duplicate login IDs after asynchronous session inspection", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.service.login(loginId, redirect, f.launch), f.service.login(loginId, redirect, f.launch)]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });

  it("does not let an old cancelled callback delete a later login with the same handle", async () => {
    const f = fixture();
    let started!: () => void, finish!: (url: string) => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<string>(resolve => { finish = resolve; });
    let callback = "";
    const old = f.service.login(loginId, redirect, async url => { callback = await f.launch(url); started(); return gate; });
    const failed = expect(old).rejects.toThrow();
    await began; f.service.cancel(loginId);
    await f.service.login(loginId, redirect, f.launch);
    finish(callback); await failed;
    expect((await f.service.connectionForLogin(loginId)).profile).toEqual(profile);
  });

  it("restores a saved connection after worker restart without exposing tokens or launching login", async () => {
    const f = fixture(); f.accounts.set(f.account.id, f.account);
    const page = await f.service.browse({ providerId: f.account.id });
    expect(page.items).toHaveLength(1);
    expect(f.launch).not.toHaveBeenCalled();
    expect(JSON.stringify(page)).not.toMatch(/synthetic-access|synthetic-refresh/);
    expect(new Headers(f.fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer synthetic-access");
  });

  it("rejects ambiguous browse scope and pending files from another drive", async () => {
    const f = fixture();
    await expect(f.service.browse({})).rejects.toThrow();
    await expect(f.service.browse({ loginId, providerId: "provider1" })).rejects.toThrow();
    await f.service.login(loginId, redirect, f.launch);
    expect(() => f.service.fileClient(f.account, { driveId: "other", itemId: "file1" })).toThrow();
  });

  it("does not allow a file client captured before lock to access the next vault session", async () => {
    const f = fixture(); f.accounts.set(f.account.id, f.account);
    const file = f.service.fileClient(f.account, { driveId: "drive1", itemId: "file1" });
    f.service.clear(); f.setSession("new-session");
    await expect(file.stat()).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("aborts a saved-source response stream when the vault locks", async () => {
    const f = fixture(); f.accounts.set(f.account.id, f.account);
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const cancel = vi.fn();
    f.fetcher.mockImplementationOnce(async () => new Response(new ReadableStream({ start() { started(); }, cancel })));
    const result = f.service.browse({ providerId: f.account.id });
    const failure = expect(result).rejects.toMatchObject({ code: "cancelled" });
    await began; f.service.clear(); f.setSession(); await failure;
    expect(cancel).toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
