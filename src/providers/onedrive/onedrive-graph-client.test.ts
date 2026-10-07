import { describe, expect, it, vi } from "vitest";
import { OneDriveGraphClient, OneDriveKeePassFileClient } from "./onedrive-graph-client";

const identity = { driveId: "drive_1", itemId: "item!1" };
const itemUrl = "https://graph.microsoft.com/v1.0/drives/drive_1/items/item!1";
const downloadUrl = "https://public.dm.files.1drv.com/content?tempauth=synthetic-capability";
const bytes = new Uint8Array([3, 4, 5, 6]);
const metadata = (extra: Record<string, unknown> = {}) => ({ id: identity.itemId, name: "Vault.kdbx", size: bytes.length, eTag: '"v1"',
  parentReference: { driveId: identity.driveId }, file: {}, "@microsoft.graph.downloadUrl": downloadUrl, ...extra });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const content = (value = bytes) => new Response(value.slice());

function fixture(responses: Array<Response | Error | (() => Response)> = [], limit?: number) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const value = responses.shift();
    if (value === undefined) throw new Error("Unexpected request");
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value() : value;
  });
  const acquire = vi.fn(async () => "synthetic-bearer");
  const graph = new OneDriveGraphClient(acquire, fetcher, { maxAttempts: 1 }, limit);
  return { graph, file: new OneDriveKeePassFileClient(identity, graph), fetcher, acquire };
}
const readResponses = (extra: Record<string, unknown> = {}, value = bytes) => [json(metadata(extra)), content(value), json(metadata(extra))];

describe("OneDrive Graph read boundaries", () => {
  it("downloads an exact drive/item snapshot without forwarding a bearer to the capability URL", async () => {
    const f = fixture(readResponses());
    const snapshot = await f.file.read();
    expect(snapshot).toMatchObject({ url: itemUrl, fileName: "Vault.kdbx", etag: '"v1"', sizeBytes: 4, bytes });
    expect(snapshot.sha256).toBe(Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"));
    expect(JSON.stringify({ ...snapshot, bytes: undefined })).not.toContain("tempauth");
    expect(f.acquire).toHaveBeenCalledTimes(2);
    for (const [url, init] of f.fetcher.mock.calls) {
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
      if (String(url) === downloadUrl) {
        expect(new Headers(init!.headers).has("Authorization")).toBe(false);
        expect(new Headers(init!.headers).has("If-Match")).toBe(false);
      } else expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer synthetic-bearer");
    }
  });

  it.each([
    { eTag: '"changed"' }, { size: 3 }, { id: "different" }, { parentReference: { driveId: "different" } }
  ])("rejects a changed identity/version after download", async extra => {
    const f = fixture([json(metadata()), content(), json(metadata(extra))]);
    await expect(f.file.read()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects truncated bytes even when both metadata reads agree", async () => {
    await expect(fixture([json(metadata()), content(bytes.subarray(0, 3)), json(metadata())]).file.read()).rejects.toMatchObject({ code: "conflict" });
  });

  it("reports missing files without using a path fallback", async () => {
    const f = fixture([json({}, 404), json({}, 404)]);
    expect(await f.file.stat()).toBeUndefined();
    await expect(f.file.read()).rejects.toMatchObject({ code: "not-found" });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["http://public.dm.files.1drv.com/file", "https://evil.example/file", "https://files.1drv.com.evil.example/file",
    "https://a.sharepoint.com@evil.example/file", "https://a.sharepoint.com:444/file", "https://a.sharepoint.com/file#secret", "https://127.0.0.1/file"])("rejects invalid capability URL %s without making a file request", async url => {
    const f = fixture([json(metadata({ "@microsoft.graph.downloadUrl": url }))]);
    await expect(f.file.read()).rejects.toMatchObject({ code: "client" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts SharePoint download capabilities without bearer credentials", async () => {
    const url = "https://tenant-my.sharepoint.com/personal/test/_layouts/15/download.aspx?authkey=synthetic";
    const f = fixture(readResponses({ "@microsoft.graph.downloadUrl": url }));
    await f.file.read();
    expect(String(f.fetcher.mock.calls[1][0])).toBe(url);
    expect(new Headers(f.fetcher.mock.calls[1][1]!.headers).has("Authorization")).toBe(false);
  });

  it.each([{ remoteItem: { id: "redirect" } }, { deleted: {} }, { file: undefined, folder: {} }, { name: "other.txt" },
    { eTag: 'W/"v1"' }, { eTag: "*" }, { eTag: undefined }, { size: -1 }, { size: 1.5 }])("rejects unsupported file metadata", async extra => {
    const f = fixture([json(metadata(extra))]);
    await expect(f.file.read()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds declared and streamed database size", async () => {
    const declared = fixture([json(metadata({ size: 5 }))], 4);
    await expect(declared.file.read()).rejects.toThrow(/上限/);
    expect(declared.fetcher).toHaveBeenCalledTimes(1);
    const streamed = fixture([json(metadata()), content(new Uint8Array(5))], 4);
    await expect(streamed.file.read()).rejects.toThrow(/上限/);
    expect(streamed.fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not expose Microsoft error bodies or capability secrets", async () => {
    const f = fixture([json(metadata()), json({ error: "secret synthetic-capability" }, 403)]);
    await expect(f.file.read()).rejects.toThrow("OneDrive 文件下载失败（HTTP 403）。");
  });

  it("honors cancellation before token acquisition and between download and verification", async () => {
    const controller = new AbortController(), f = fixture();
    controller.abort();
    await expect(f.file.read(controller.signal)).rejects.toThrow();
    expect(f.acquire).not.toHaveBeenCalled();
    const during = new AbortController();
    const g = fixture([json(metadata()), () => { during.abort(); return content(); }]);
    await expect(g.file.read(during.signal)).rejects.toThrow();
    expect(g.fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not send a request if cancellation occurs during token acquisition", async () => {
    const controller = new AbortController(), fetcher = vi.fn();
    const graph = new OneDriveGraphClient(async () => { controller.abort(); return "synthetic"; }, fetcher);
    await expect(graph.profile(controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("OneDrive file selection", () => {
  it("returns account and drive identity without returning tokens", async () => {
    const f = fixture([json({ id: "user_1", displayName: "Test", mail: null, userPrincipalName: "test@example.invalid" }), json({ id: "drive_1", name: "Files", driveType: "personal" })]);
    expect(await f.graph.profile()).toEqual({ id: "user_1", displayName: "Test", username: "test@example.invalid" });
    expect(await f.graph.defaultDrive()).toEqual({ id: "drive_1", name: "Files", driveType: "personal" });
  });

  it("follows bounded same-folder pages, filters non-KDBX files/shortcuts and redacts capabilities", async () => {
    const next = "https://graph.microsoft.com/v1.0/drives/drive_1/root/children?$skiptoken=next";
    const folder = metadata({ id: "folder", file: undefined, folder: {}, name: "Folder" });
    const f = fixture([json({ value: [metadata(), folder, metadata({ id: "text", name: "notes.txt" }), metadata({ remoteItem: { id: "shared" } })], "@odata.nextLink": next }),
      json({ value: [metadata({ id: "item2", name: "Other.KDBX" })] })]);
    const result = await f.graph.children(identity.driveId);
    expect(result.map(item => item.itemId)).toEqual([identity.itemId, "folder", "item2"]);
    expect(JSON.stringify(result)).not.toContain("capability");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["https://evil.example/folder", "https://graph.microsoft.com/v1.0/me/messages", "https://graph.microsoft.com/v1.0/drives/other/root/children",
    "https://graph.microsoft.com/v1.0/drives/drive_1/root/children?$expand=children", "https://graph.microsoft.com/v1.0/drives/drive_1/root/children?$top=2&$top=3"])("rejects an untrusted pagination target", async next => {
    const f = fixture([json({ value: [], "@odata.nextLink": next })]);
    await expect(f.graph.children(identity.driveId)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects looping pages and duplicate items", async () => {
    const next = "https://graph.microsoft.com/v1.0/drives/drive_1/root/children?$skiptoken=loop";
    const loop = fixture([json({ value: [], "@odata.nextLink": next }), json({ value: [], "@odata.nextLink": next })]);
    await expect(loop.graph.children(identity.driveId)).rejects.toThrow();
    expect(loop.fetcher).toHaveBeenCalledTimes(2);
    const duplicate = fixture([json({ value: [metadata(), metadata()] })]);
    await expect(duplicate.graph.children(identity.driveId)).rejects.toMatchObject({ code: "conflict" });
  });

  it("bounds JSON responses and rejects malformed objects", async () => {
    await expect(fixture([new Response("{" + " ".repeat(512 * 1024))]).graph.profile()).rejects.toThrow(/上限/);
    await expect(fixture([json({ value: null })]).graph.children(identity.driveId)).rejects.toThrow();
  });

  it.each(["../escape", "a/b", "a?query", "a%2fescape", "a#fragment", ""])("rejects path injection in drive/item identifiers", async id => {
    const f = fixture();
    await expect(f.graph.children(id)).rejects.toThrow();
    expect(() => new OneDriveKeePassFileClient({ ...identity, itemId: id }, f.graph)).toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("OneDrive conditional KDBX publication", () => {
  it("sends an exact If-Match and verifies uploaded bytes from the same file", async () => {
    const f = fixture([json(metadata({ eTag: '"v2"' })), ...readResponses({ eTag: '"v2"' })]);
    const result = await f.file.write(bytes, '"v1"');
    expect(result).toMatchObject({ bytes, etag: '"v2"', alreadyApplied: false });
    const [url, init] = f.fetcher.mock.calls[0];
    expect(String(url)).toBe(`${itemUrl}/content`);
    expect(init).toMatchObject({ method: "PUT", body: bytes, redirect: "error" });
    expect(new Headers(init!.headers).get("If-Match")).toBe('"v1"');
  });

  it.each([null, "*", 'W/"v1"', ' "v1"', '"v1"\r\nOther: header', ""])("rejects an absent or unsafe write precondition", async etag => {
    const f = fixture();
    await expect(f.file.write(bytes, etag)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([new TypeError("request contains secret"), json({}, 503), json({}, 412)])("reconciles ambiguous/already applied writes without replaying PUT", async failure => {
    const f = fixture([failure, ...readResponses({ eTag: '"v2"' })]);
    const result = await f.file.write(bytes, '"v1"');
    expect(result).toMatchObject({ bytes, alreadyApplied: true });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("keeps a conflicting file unchanged when its bytes differ", async () => {
    const f = fixture([json({}, 412), ...readResponses({ eTag: '"v2"' }, new Uint8Array([6, 5, 4, 3]))]);
    await expect(f.file.write(bytes, '"v1"')).rejects.toMatchObject({ code: "conflict", status: 412 });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("does not accept an HTTP success without matching read-back bytes", async () => {
    const f = fixture([json(metadata({ eTag: '"v2"' })), ...readResponses({ eTag: '"v2"' }, new Uint8Array([1, 1, 1, 1]))]);
    await expect(f.file.write(bytes, '"v1"')).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a response identifying another file and does not overwrite a missing file", async () => {
    const wrong = fixture([json(metadata({ id: "wrong" }))]);
    await expect(wrong.file.write(bytes, '"v1"')).rejects.toThrow();
    expect(wrong.fetcher).toHaveBeenCalledTimes(1);
    const missing = fixture([json({}, 404)]);
    await expect(missing.file.write(bytes, '"v1"')).rejects.toMatchObject({ code: "not-found" });
    expect(missing.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile a cancelled write or authentication failure", async () => {
    const controller = new AbortController();
    const cancelled = fixture([() => { controller.abort(); return json({}, 503); }]);
    await expect(cancelled.file.write(bytes, '"v1"', controller.signal)).rejects.toThrow();
    expect(cancelled.fetcher).toHaveBeenCalledTimes(1);
    const unauthorized = fixture([json({ error: "secret" }, 401)]);
    await expect(unauthorized.file.write(bytes, '"v1"')).rejects.toMatchObject({ code: "authentication" });
    expect(unauthorized.fetcher).toHaveBeenCalledTimes(1);
  });
});
