import { sha256 } from "hash-wasm";
import { describe, expect, it } from "vitest";
import { ProviderTransportError } from "../provider-transport";
import { Mdbx2WebDavClient, parseMdbx2MultiStatus } from "./mdbx2-webdav-client";

interface MemoryEntry {
  directory: boolean;
  bytes?: Uint8Array;
  version: number;
}

class MemoryWebDav {
  readonly entries = new Map<string, MemoryEntry>([["", { directory: true, version: 1 }]]);
  readonly requests: Array<{ method: string; path: string; headers: Headers }> = [];
  raceNextPut = false;
  putCount = 0;

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const path = this.remotePath(url.pathname);
    this.requests.push({ method, path, headers });
    if (method === "PROPFIND") return this.propfind(path, headers.get("depth") || "0");
    if (method === "MKCOL") return this.mkcol(path);
    if (method === "GET") return this.get(path);
    if (method === "PUT") return this.put(path, headers, init.body);
    return new Response(null, { status: 405 });
  };

  private propfind(path: string, depth: string): Response {
    const entry = this.entries.get(path);
    if (!entry) return new Response(null, { status: 404 });
    const objects = [path];
    if (depth === "1") {
      const prefix = path ? `${path}/` : "";
      for (const candidate of this.entries.keys()) {
        if (candidate !== path && candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/")) objects.push(candidate);
      }
    }
    const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${objects.map((candidate) => this.responseXml(candidate)).join("")}</d:multistatus>`;
    return new Response(body, { status: 207, headers: { "content-type": "application/xml" } });
  }

  private mkcol(path: string): Response {
    if (this.entries.has(path)) return new Response(null, { status: 405 });
    const parent = path.split("/").slice(0, -1).join("/");
    if (!this.entries.get(parent)?.directory) return new Response(null, { status: 409 });
    this.entries.set(path, { directory: true, version: 1 });
    return new Response(null, { status: 201 });
  }

  private get(path: string): Response {
    const entry = this.entries.get(path);
    if (!entry || entry.directory || !entry.bytes) return new Response(null, { status: 404 });
    return new Response(entry.bytes.slice(), {
      status: 200,
      headers: {
        "content-length": String(entry.bytes.length),
        etag: this.etag(entry),
        "last-modified": "Sat, 02 Aug 2026 00:00:00 GMT"
      }
    });
  }

  private async put(path: string, headers: Headers, body: BodyInit | null | undefined): Promise<Response> {
    const existing = this.entries.get(path);
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (headers.get("if-none-match") === "*" && existing) return new Response(null, { status: 412 });
    if (headers.has("if-match") && (!existing || headers.get("if-match") !== this.etag(existing))) return new Response(null, { status: 412 });
    const parent = path.split("/").slice(0, -1).join("/");
    if (!this.entries.get(parent)?.directory) return new Response(null, { status: 409 });
    this.putCount += 1;
    const next = { directory: false, bytes, version: (existing?.version || 0) + 1 };
    this.entries.set(path, next);
    if (this.raceNextPut) {
      this.raceNextPut = false;
      return new Response(null, { status: 412 });
    }
    return new Response(null, { status: existing ? 204 : 201, headers: { etag: this.etag(next) } });
  }

  private responseXml(path: string): string {
    const entry = this.entries.get(path)!;
    const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const href = `/dav/${encoded}${entry.directory && encoded ? "/" : ""}`;
    return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${entry.directory ? "<d:collection/>" : ""}</d:resourcetype>${entry.directory ? "" : `<d:getcontentlength>${entry.bytes?.length || 0}</d:getcontentlength>`}<d:getetag>${this.etag(entry)}</d:getetag><d:getlastmodified>Sat, 02 Aug 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }

  private remotePath(pathname: string): string {
    const prefix = "/dav/";
    if (pathname === "/dav" || pathname === "/dav/") return "";
    if (!pathname.startsWith(prefix)) throw new Error("test request escaped base");
    return pathname.slice(prefix.length).replace(/\/$/, "").split("/").filter(Boolean).map(decodeURIComponent).join("/");
  }

  private etag(entry: MemoryEntry): string {
    return `"v${entry.version}"`;
  }
}

const credentials = { baseUrl: "https://vault.test/dav", username: "joyins", password: "secret" };

describe("MDBX2 WebDAV object transport", () => {
  it("parses only same-origin objects below the configured directory", () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/vaults/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>https://vault.test/dav/vaults/main.mdbx</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength><d:getetag>&quot;v1&quot;</d:getetag></d:prop></d:propstat></d:response>
    </d:multistatus>`;
    expect(parseMdbx2MultiStatus(xml, credentials.baseUrl)).toEqual([
      { path: "vaults", isDirectory: true, sizeBytes: undefined, etag: undefined, lastModified: undefined },
      { path: "vaults/main.mdbx", isDirectory: false, sizeBytes: 12, etag: '"v1"', lastModified: undefined }
    ]);
    expect(() => parseMdbx2MultiStatus(xml.replace("https://vault.test", "https://evil.test"), credentials.baseUrl)).toThrow("安全边界");
  });

  it("streams bounded downloads into Native-sized chunks and hashes the complete object", async () => {
    const server = new MemoryWebDav();
    server.entries.set("vaults", { directory: true, version: 1 });
    server.entries.set("vaults/main.mdbx", { directory: false, version: 1, bytes: new TextEncoder().encode("Monica MDBX2") });
    const client = new Mdbx2WebDavClient(credentials, server.fetch, {}, { downloadChunkBytes: 4 });
    const chunks: Array<{ offset: number; text: string }> = [];
    const result = await client.download("vaults/main.mdbx", 64, (chunk, offset) => {
      chunks.push({ offset, text: new TextDecoder().decode(chunk) });
    });
    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 4, 8]);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("Monica MDBX2");
    expect(result.sha256).toBe(await sha256("Monica MDBX2"));
    expect(server.requests.every((request) => request.headers.get("authorization")?.startsWith("Basic "))).toBe(true);
  });

  it("publishes immutable objects, accepts byte-identical races and rejects collisions", async () => {
    const server = new MemoryWebDav();
    const client = new Mdbx2WebDavClient(credentials, server.fetch);
    const bytes = new TextEncoder().encode("encrypted-object");
    const digest = await sha256(bytes);
    const path = `vaults/main.mdbx.sync/blobs/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
    server.raceNextPut = true;
    await expect(client.putImmutable(path, new Blob([bytes]), digest)).resolves.toMatchObject({ path, sizeBytes: bytes.length });
    expect(server.putCount).toBe(1);
    await expect(client.putImmutable(path, new Blob([bytes]), digest)).resolves.toMatchObject({ path });
    expect(server.putCount).toBe(1);
    await expect(client.putImmutable(path, new Blob([new TextEncoder().encode("different")]), await sha256("different"))).rejects.toThrow("内容碰撞");
    expect(server.requests.some((request) => request.method === "PUT" && request.headers.get("if-none-match") === "*")).toBe(true);
  });

  it("uses ETag guarded replacement and reports stale writers as conflicts", async () => {
    const server = new MemoryWebDav();
    const client = new Mdbx2WebDavClient(credentials, server.fetch);
    await client.put("vaults/main.mdbx", new Blob(["first"]), { mode: "replace" });
    await expect(client.put("vaults/main.mdbx", new Blob(["second"]), { mode: "if-match", expectedEtag: '"stale"' }))
      .rejects.toMatchObject({ code: "conflict", status: 412 } satisfies Partial<ProviderTransportError>);
    await expect(client.put("vaults/main.mdbx", new Blob(["second"]), { mode: "if-match", expectedEtag: '"v1"' }))
      .resolves.toMatchObject({ sizeBytes: 6, etag: '"v2"' });
  });

  it("rejects downloads whose declared size exceeds the caller bound", async () => {
    const server = new MemoryWebDav();
    server.entries.set("large.bin", { directory: false, version: 1, bytes: new Uint8Array(32) });
    const client = new Mdbx2WebDavClient(credentials, server.fetch);
    await expect(client.download("large.bin", 16, () => undefined)).rejects.toThrow("安全上限");
  });
});
