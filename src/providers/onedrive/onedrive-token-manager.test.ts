import { describe, expect, it, vi } from "vitest";
import { MONICA_ONEDRIVE_CLIENT_ID } from "./onedrive-auth";
import { OneDriveTokenManager, oneDriveConnectionBinding, parseOneDriveConnection, type OneDriveConnection } from "./onedrive-token-manager";

const connection = (): OneDriveConnection => ({ id: "login-1", clientId: MONICA_ONEDRIVE_CLIENT_ID, profile: { id: "user-1", displayName: "Test", username: "test@example.invalid" },
  tokens: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1000, scope: "User.Read Files.ReadWrite" } });
const replacement = { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 3601000, scope: "User.Read Files.ReadWrite" };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let stored: OneDriveConnection | undefined = connection();
  const store = {
    read: vi.fn(async () => structuredClone(stored)),
    rotate: vi.fn(async (_id: string, previous: OneDriveConnection, tokens: OneDriveConnection["tokens"], signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (!stored || JSON.stringify(stored) !== JSON.stringify(previous)) throw new Error("Connection replaced");
      stored = { ...stored, tokens: { ...tokens } };
    })
  };
  const refresh = vi.fn(async (_token: string, _signal?: AbortSignal) => replacement);
  const auth = vi.fn(() => ({ refresh }));
  const manager = new OneDriveTokenManager(store, auth, () => 1000);
  return { manager, store, refresh, auth, binding: oneDriveConnectionBinding(stored!), get: () => stored, set: (value: OneDriveConnection | undefined) => { stored = value; } };
}

describe("OneDrive background token lifecycle", () => {
  it("coalesces concurrent refreshes and persists rotation before returning tokens", async () => {
    const f = fixture();
    expect(await Promise.all([f.manager.accessToken("provider", f.binding), f.manager.accessToken("provider", f.binding)])).toEqual(["new-access", "new-access"]);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.refresh.mock.calls[0][0]).toBe("old-refresh");
    expect(f.store.rotate).toHaveBeenCalledTimes(1);
    expect(f.get()?.tokens).toEqual(replacement);
    expect(await f.manager.accessToken("provider", f.binding)).toBe("new-access");
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("uses the configured public client ID and does not refresh an unexpired token", async () => {
    const f = fixture();
    f.set({ ...connection(), tokens: { ...replacement, expiresAt: 100000 } });
    expect(await f.manager.accessToken("provider", f.binding)).toBe("new-access");
    expect(f.auth).not.toHaveBeenCalled();
    f.set(connection());
    await f.manager.accessToken("provider", f.binding);
    expect(f.auth).toHaveBeenCalledWith(MONICA_ONEDRIVE_CLIENT_ID);
  });

  it("never returns an unpersisted refresh result", async () => {
    const f = fixture();
    f.store.rotate.mockRejectedValueOnce(new Error("Encrypted storage failed"));
    await expect(f.manager.accessToken("provider", f.binding)).rejects.toThrow("Encrypted storage failed");
    expect(f.get()?.tokens.accessToken).toBe("old-access");
  });

  it("aborts pending work on lock even if the OAuth client ignores cancellation", async () => {
    const f = fixture(), started = deferred<void>(), response = deferred<typeof replacement>();
    f.refresh.mockImplementation(async (_token, signal) => { started.resolve(); const value = await response.promise; expect(signal?.aborted).toBe(true); return value; });
    const result = f.manager.accessToken("provider", f.binding);
    const rejected = expect(result).rejects.toThrow();
    await started.promise;
    f.manager.clear(); response.resolve(replacement);
    await rejected;
    expect(f.store.rotate).not.toHaveBeenCalled();
    expect(f.get()?.tokens.accessToken).toBe("old-access");
  });

  it("detects lock while the encrypted connection is being read", async () => {
    const f = fixture();
    f.store.read.mockImplementationOnce(async () => { f.manager.clear(); return connection(); });
    await expect(f.manager.accessToken("provider", f.binding)).rejects.toThrow();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("cancels one caller promptly without cancelling another caller's shared refresh", async () => {
    const f = fixture(), started = deferred<void>(), response = deferred<typeof replacement>();
    f.refresh.mockImplementation(async () => { started.resolve(); return response.promise; });
    const controller = new AbortController();
    const a = f.manager.accessToken("provider", f.binding, controller.signal);
    const rejected = expect(a).rejects.toThrow(/cancelled/);
    const b = f.manager.accessToken("provider", f.binding);
    await started.promise; controller.abort(); await rejected;
    response.resolve(replacement);
    expect(await b).toBe("new-access");
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects a replaced connection or removed source before and during refresh", async () => {
    const f = fixture();
    f.set({ ...connection(), id: "new-login" });
    await expect(f.manager.accessToken("provider", f.binding)).rejects.toThrow();
    expect(f.refresh).not.toHaveBeenCalled();
    f.set(connection());
    f.refresh.mockImplementationOnce(async () => { f.set(undefined); return replacement; });
    await expect(f.manager.accessToken("provider", f.binding)).rejects.toThrow("Connection replaced");
    expect(f.get()).toBeUndefined();
  });

  it("does not accept an account or client mismatch under the same connection ID", async () => {
    const f = fixture();
    await expect(f.manager.accessToken("provider", { ...f.binding, accountId: "other" })).rejects.toThrow();
    await expect(f.manager.accessToken("provider", { ...f.binding, clientId: "other" })).rejects.toThrow();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("does not read secret storage or start a refresh for an already cancelled caller", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.manager.accessToken("provider", f.binding, controller.signal)).rejects.toThrow();
    expect(f.store.read).not.toHaveBeenCalled();
  });

  it("drops unknown secret fields and rejects invalid persisted credentials", () => {
    const input = { ...connection(), clientSecret: "must-not-survive", tokens: { ...connection().tokens, extra: "must-not-survive" } };
    expect(parseOneDriveConnection(input)).toEqual(connection());
    expect(parseOneDriveConnection({ ...connection(), clientId: "bad" })).toBeUndefined();
    expect(parseOneDriveConnection({ ...connection(), tokens: { ...connection().tokens, scope: "User.Read" } })).toBeUndefined();
    expect(parseOneDriveConnection({ ...connection(), tokens: { ...connection().tokens, accessToken: "line\nbreak" } })).toBeUndefined();
  });
});
