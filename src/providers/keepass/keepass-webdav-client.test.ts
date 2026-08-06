import { describe, expect, it, vi } from "vitest";
import { ProviderTransportError } from "../provider-transport";
import {
  KeePassWebDavClient,
  KeePassWebDavError,
  keePassRemoteUrl,
  normalizeKeePassRemotePath
} from "./keepass-webdav-client";

const CONFIG = {
  baseUrl: "http://127.0.0.1:8787/dav/files/demo",
  username: "demo",
  password: "secret",
  remotePath: "Vaults/Monica main.kdbx"
};
const TARGET = "http://127.0.0.1:8787/dav/files/demo/Vaults/Monica%20main.kdbx";

describe("KeePass WebDAV client", () => {
  it("normalizes and confines the configured remote path", () => {
    expect(normalizeKeePassRemotePath("/Vaults//Monica main.kdbx/")).toBe("Vaults/Monica main.kdbx");
    expect(keePassRemoteUrl(CONFIG.baseUrl, CONFIG.remotePath)).toBe(TARGET);
    for (const invalid of ["", "../vault.kdbx", "Vaults/%2e%2e/vault.kdbx", "Vaults/%2Froot.kdbx", "Vaults\\..\\root.kdbx"]) {
      expect(() => normalizeKeePassRemotePath(invalid)).toThrowError(KeePassWebDavError);
    }
  });

  it("reads bounded depth-zero metadata with exact Basic authentication", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(TARGET);
      expect(init?.method).toBe("PROPFIND");
      expect(new Headers(init?.headers).get("Depth")).toBe("0");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Basic ZGVtbzpzZWNyZXQ=");
      expect(init?.redirect).toBe("error");
      return new Response(multistatus('"etag-1"', 123), { status: 207, headers: { "Content-Type": "application/xml" } });
    });
    const client = new KeePassWebDavClient(CONFIG, fetcher as typeof fetch, { maxAttempts: 1 });

    await expect(client.stat()).resolves.toEqual({
      url: TARGET,
      fileName: "Monica main.kdbx",
      etag: '"etag-1"',
      lastModified: "Wed, 15 Jul 2026 02:02:02 GMT",
      sizeBytes: 123
    });
  });

  it("refuses oversized downloads before GET", async () => {
    const fetcher = vi.fn(async () => new Response(multistatus('"etag-1"', 9), { status: 207 }));
    const client = new KeePassWebDavClient(CONFIG, fetcher as typeof fetch, { maxAttempts: 1 }, { maxDownloadBytes: 8 });

    await expect(client.read()).rejects.toMatchObject({ code: "remote-download-too-large" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("creates with If-None-Match and verifies the uploaded bytes", async () => {
    const bytes = new TextEncoder().encode("new kdbx");
    const fetcher = sequenceFetcher([
      (init) => {
        const headers = new Headers(init?.headers);
        expect(init?.method).toBe("PUT");
        expect(headers.get("If-None-Match")).toBe("*");
        expect(headers.get("If-Match")).toBeNull();
        return new Response(null, { status: 201 });
      },
      () => new Response(multistatus('"etag-created"', bytes.length), { status: 207 }),
      (init) => {
        expect(init?.method).toBe("GET");
        return new Response(bytes, { status: 200, headers: { ETag: '"etag-created"' } });
      }
    ]);
    const client = new KeePassWebDavClient(CONFIG, fetcher, { maxAttempts: 1 });

    const result = await client.write(bytes, null);

    expect(result).toMatchObject({ etag: '"etag-created"', alreadyApplied: false, sizeBytes: bytes.length });
    expect(result.bytes).toEqual(bytes);
  });

  it("replaces with the exact ETag and refuses an absent token", async () => {
    const bytes = new TextEncoder().encode("replacement");
    const fetcher = sequenceFetcher([
      (init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("If-Match")).toBe('W/"etag-7"');
        expect(headers.get("If-None-Match")).toBeNull();
        return new Response(null, { status: 204 });
      },
      () => new Response(multistatus('"etag-8"', bytes.length), { status: 207 }),
      () => new Response(bytes, { status: 200 })
    ]);
    const client = new KeePassWebDavClient(CONFIG, fetcher, { maxAttempts: 1 });

    await expect(client.write(bytes, 'W/"etag-7"')).resolves.toMatchObject({ etag: '"etag-8"' });
    await expect(client.write(bytes, "")).rejects.toMatchObject({ code: "remote-etag-required" });
  });

  it("treats a lost write response as applied only when the remote digest matches", async () => {
    const bytes = new TextEncoder().encode("committed before disconnect");
    let stored = new Uint8Array();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        stored = new Uint8Array(await new Response(init.body).arrayBuffer());
        throw new TypeError("connection lost");
      }
      if (init?.method === "PROPFIND") return new Response(multistatus('"etag-after"', stored.length), { status: 207 });
      return new Response(stored, { status: 200, headers: { ETag: '"etag-after"' } });
    });
    const client = new KeePassWebDavClient(CONFIG, fetcher as typeof fetch, { maxAttempts: 1 });

    await expect(client.write(bytes, '"etag-before"')).resolves.toMatchObject({
      etag: '"etag-after"',
      alreadyApplied: true
    });
  });

  it("keeps a real precondition conflict when the remote content differs", async () => {
    const local = new TextEncoder().encode("local");
    const remote = new TextEncoder().encode("remote");
    const fetcher = sequenceFetcher([
      () => new Response(null, { status: 412 }),
      () => new Response(multistatus('"etag-remote"', remote.length), { status: 207 }),
      () => new Response(remote, { status: 200 })
    ]);
    const client = new KeePassWebDavClient(CONFIG, fetcher, { maxAttempts: 1 });

    await expect(client.write(local, '"etag-base"')).rejects.toBeInstanceOf(ProviderTransportError);
  });
});

function multistatus(etag: string, size: number): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/files/demo/Vaults/Monica%20main.kdbx</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag><d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Wed, 15 Jul 2026 02:02:02 GMT</d:getlastmodified></d:prop></d:propstat></d:response></d:multistatus>`;
}

function sequenceFetcher(
  responders: Array<(init?: RequestInit) => Response | Promise<Response>>
): typeof fetch {
  let index = 0;
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const responder = responders[index++];
    if (!responder) throw new Error(`Unexpected request ${index}`);
    return responder(init);
  }) as unknown as typeof fetch;
}
