import { describe, expect, it, vi } from "vitest";
import { backupFolderUrl, parseMultiStatus, WebDavClient } from "./webdav-client";

const MULTISTATUS = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/Monica_Backups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/Monica_Backups/monica_backup_20260715_010101.zip</d:href><d:propstat><d:prop><d:getetag>"old"</d:getetag><d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Wed, 15 Jul 2026 01:01:01 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/Monica_Backups/monica_backup_20260715_020202.enc.zip</d:href><d:propstat><d:prop><d:getetag>"new"</d:getetag><d:getcontentlength>34</d:getcontentlength><d:getlastmodified>Wed, 15 Jul 2026 02:02:02 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
</d:multistatus>`;

describe("WebDAV client", () => {
  it("normalizes the Android backup folder and parses namespace-prefixed multistatus", () => {
    expect(backupFolderUrl("cloud.example.com/dav/")).toBe("https://cloud.example.com/dav/Monica_Backups");
    const files = parseMultiStatus(MULTISTATUS, "https://cloud.example.com/dav/Monica_Backups");
    expect(files).toHaveLength(2);
    expect(files[1]).toMatchObject({ name: "monica_backup_20260715_020202.enc.zip", etag: '"new"', encrypted: true, size: 34 });
  });

  it("lists newest backups first and sends preemptive Basic auth", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("PROPFIND");
      expect(headers.get("Depth")).toBe("1");
      expect(headers.get("Authorization")).toBe(`Basic ${btoa("joy:secret")}`);
      return new Response(MULTISTATUS, { status: 207 });
    }) as unknown as typeof fetch;
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav", username: "joy", password: "secret" }, fetcher);
    const files = await client.listBackups();
    expect(files.map((file) => file.name)).toEqual(["monica_backup_20260715_020202.enc.zip", "monica_backup_20260715_010101.zip"]);
  });

  it("retries a transient idempotent WebDAV list without exposing credentials", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("temporary password=server-echo", { status: 503 }))
      .mockResolvedValueOnce(new Response(MULTISTATUS, { status: 207 })) as unknown as typeof fetch;
    const client = new WebDavClient(
      { baseUrl: "https://cloud.example.com/dav", username: "joy", password: "client-secret" },
      fetcher,
      { baseDelayMs: 0, jitterRatio: 0 }
    );

    await expect(client.listBackups()).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns a typed safe WebDAV error without the untrusted response body", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("password=hunter2 token=server-secret https://private.example", { status: 401 })) as unknown as typeof fetch;
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav", username: "joy", password: "client-secret" }, fetcher, { baseDelayMs: 0 });

    const error = await client.listBackups().catch((cause) => cause);
    expect(error).toMatchObject({ name: "ProviderTransportError", code: "authentication", status: 401, retryable: false });
    expect(error.message).toBe("读取 Monica_Backups 失败（HTTP 401）。");
    expect(JSON.stringify(error)).not.toMatch(/hunter2|server-secret|private\.example|client-secret/);
  });

  it("honors cancellation before starting a WebDAV request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn() as unknown as typeof fetch;
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav", username: "joy", password: "secret" }, fetcher);

    await expect(client.listBackups(controller.signal)).rejects.toMatchObject({ code: "cancelled", retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
