import { describe, expect, it, vi } from "vitest";
import { backupFolderUrl, normalizeServerUrl, parseMultiStatus, WebDavClient } from "./webdav-client";

const MULTISTATUS = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/Monica_Backups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/Monica_Backups/monica_backup_20260715_010101.zip</d:href><d:propstat><d:prop><d:getetag>"old"</d:getetag><d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Wed, 15 Jul 2026 01:01:01 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/Monica_Backups/monica_backup_20260715_020202.enc.zip</d:href><d:propstat><d:prop><d:getetag>"new"</d:getetag><d:getcontentlength>34</d:getcontentlength><d:getlastmodified>Wed, 15 Jul 2026 02:02:02 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
</d:multistatus>`;

describe("WebDAV client", () => {
  it("reconciles a lost upload response under the default retry policy with exactly one PUT", async () => {
    const bytes = Uint8Array.of(9, 7, 5);
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      methods.push(init?.method || "GET");
      if (init?.method === "PROPFIND") return new Response(null, { status: 207 });
      if (init?.method === "PUT") throw new TypeError("Synthetic lost response");
      return new Response(bytes, { headers: { etag: '"confirmed"' } });
    };
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav", username: "synthetic", password: "synthetic" }, fetcher);
    await expect(client.upload(bytes, true)).resolves.toMatchObject({ etag: '"confirmed"', encrypted: true });
    expect(methods).toEqual(["PROPFIND", "PUT", "GET"]);
  });

  it.each(["different-bytes", "missing-file"] as const)("does not acknowledge a lost upload when readback has %s", async mode => {
    let puts = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method === "PROPFIND") return new Response(null, { status: 207 });
      if (init?.method === "PUT") { puts++; throw new TypeError("Synthetic lost response"); }
      return mode === "missing-file" ? new Response(null, { status: 404 }) : new Response(Uint8Array.of(9, 7, 4));
    };
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav", username: "synthetic", password: "synthetic" }, fetcher);
    await expect(client.upload(Uint8Array.of(9, 7, 5), true)).rejects.toMatchObject({ code: "network", attempts: 1 });
    expect(puts).toBe(1);
  });

  it("rejects mismatched bytes even after the server reports a successful upload", async () => {
    const fetcher: typeof fetch = async (_input, init) => init?.method === "PROPFIND" ? new Response(null, { status: 207 })
      : init?.method === "PUT" ? new Response(null, { status: 201 }) : new Response(Uint8Array.of(9, 7, 4));
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav", username: "synthetic", password: "synthetic" }, fetcher);
    await expect(client.upload(Uint8Array.of(9, 7, 5), true)).rejects.toThrow("内容校验失败");
  });

  it("does not confirm a cancelled upload or reconcile using a new uncancelled request", async () => {
    const controller = new AbortController(); const methods: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      methods.push(init?.method || "GET");
      if (init?.method === "PROPFIND") return new Response(null, { status: 207 });
      controller.abort(); throw new TypeError("Synthetic lost response");
    };
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav", username: "synthetic", password: "synthetic" }, fetcher);
    await expect(client.upload(Uint8Array.of(1), true, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(methods).toEqual(["PROPFIND", "PUT"]);
  });

  it("accepts Apache weak-to-strong read validation without ever using the weak tag in If-Match", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("If-Match")).toBeNull();
      return new Response(Uint8Array.of(1), { headers: { ETag: '"same"' } });
    });
    const client = new WebDavClient({ baseUrl: "https://example.test/dav", username: "test", password: "synthetic" }, fetcher as typeof fetch);
    const file = { name: "monica_backup_20260715_020202.zip", url: "https://example.test/dav/Monica_Backups/monica_backup_20260715_020202.zip", etag: 'W/"same"', encrypted: false };
    await expect(client.download(file)).resolves.toEqual(Uint8Array.of(1));
    await expect(client.download({ ...file, etag: 'W/"changed"' })).rejects.toThrow("发生变化");
  });
  it("uses canonical collection paths without permitting credentialed redirects", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || "GET";
      requests.push({ url: String(url), method });
      expect(init?.redirect).toBe("error");
      if (method === "PROPFIND") {
        expect(new URL(String(url)).pathname.endsWith("/")).toBe(true);
        return new Response(MULTISTATUS, { status: 207 });
      }
      expect(new URL(String(url)).pathname.endsWith("/")).toBe(false);
      if (method === "GET") return new Response(Uint8Array.of(1));
      return new Response(null, { status: 201 });
    });
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav/", username: "joy", password: "secret" }, fetcher as typeof fetch, { maxAttempts: 1 });
    await client.testConnection();
    await client.listBackups();
    await client.upload(Uint8Array.of(1), false);
    expect(requests.slice(0, 3)).toEqual([
      { url: "https://cloud.example.com/dav/", method: "PROPFIND" },
      { url: "https://cloud.example.com/dav/Monica_Backups/", method: "PROPFIND" },
      { url: "https://cloud.example.com/dav/Monica_Backups/", method: "PROPFIND" }
    ]);
  });

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

  it("requires HTTPS except for explicit loopback development endpoints", () => {
    expect(normalizeServerUrl("cloud.example.com/dav")).toBe("https://cloud.example.com/dav");
    expect(normalizeServerUrl("http://127.0.0.1:8080/dav")).toBe("http://127.0.0.1:8080/dav");
    expect(() => normalizeServerUrl("http://cloud.example.com/dav")).toThrow("必须使用 HTTPS");
    expect(() => normalizeServerUrl("https://joy:secret@cloud.example.com/dav")).toThrow("不能包含用户名或密码");
    expect(() => normalizeServerUrl("https://cloud.example.com/dav?token=secret")).toThrow("不能包含查询参数或片段");
  });

  it("rejects cross-origin and out-of-folder multistatus hrefs", () => {
    const crossOrigin = MULTISTATUS.replace(
      "/dav/Monica_Backups/monica_backup_20260715_020202.enc.zip",
      "https://attacker.example/steal.zip"
    );
    expect(() => parseMultiStatus(crossOrigin, "https://cloud.example.com/dav/Monica_Backups")).toThrow("越过 WebDAV 备份目录边界");

    const outsideFolder = MULTISTATUS.replace(
      "/dav/Monica_Backups/monica_backup_20260715_020202.enc.zip",
      "/dav/other/monica_backup_20260715_020202.enc.zip"
    );
    expect(() => parseMultiStatus(outsideFolder, "https://cloud.example.com/dav/Monica_Backups")).toThrow("越过 WebDAV 备份目录边界");
  });

  it("never sends credentials to a caller-supplied cross-origin backup URL", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav", username: "joy", password: "secret" }, fetcher);

    await expect(client.download({
      name: "monica_backup_20260715_020202.zip",
      url: "https://attacker.example/steal.zip",
      encrypted: false
    })).rejects.toThrow("越过 WebDAV 备份目录边界");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("caps multistatus and backup response bodies even when Content-Length is absent", async () => {
    const xmlFetcher = vi.fn().mockResolvedValue(new Response(MULTISTATUS, { status: 207 })) as unknown as typeof fetch;
    const xmlClient = new WebDavClient(
      { baseUrl: "https://cloud.example.com/dav", username: "joy", password: "secret" },
      xmlFetcher,
      {},
      { maxMultiStatusBytes: 32 }
    );
    await expect(xmlClient.listBackups()).rejects.toThrow("WebDAV 目录响应超过安全上限");

    const downloadFetcher = vi.fn().mockResolvedValue(new Response(Uint8Array.of(1, 2, 3, 4), { status: 200 })) as unknown as typeof fetch;
    const downloadClient = new WebDavClient(
      { baseUrl: "https://cloud.example.com/dav", username: "joy", password: "secret" },
      downloadFetcher,
      {},
      { maxDownloadBytes: 3 }
    );
    await expect(downloadClient.download({
      name: "monica_backup_20260715_020202.zip",
      url: "https://cloud.example.com/dav/Monica_Backups/monica_backup_20260715_020202.zip",
      encrypted: false
    })).rejects.toThrow("WebDAV 备份下载超过安全上限");
  });

  it("disables redirects on every credentialed WebDAV request", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response(MULTISTATUS, { status: 207 });
    }) as unknown as typeof fetch;
    const client = new WebDavClient({ baseUrl: "https://cloud.example.com/dav", username: "joy", password: "secret" }, fetcher);
    await client.listBackups();
  });
});
