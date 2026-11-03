import { sha256 } from "hash-wasm";
import { describe, expect, it } from "vitest";
import { Mdbx2OneDriveClient } from "./mdbx2-onedrive-client";

const DRIVE = "drive1";
const TOKEN = "test-token";
const FIELDS = "id,name,size,eTag,lastModifiedDateTime,parentReference,file,folder,deleted,remoteItem";

interface Entry {
  directory: boolean;
  bytes?: Uint8Array;
  etag: string;
  deleted?: boolean;
  remoteItem?: boolean;
}

function itemJson(path: string, entry: Entry, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const name = path.split("/").pop()!;
  return {
    id: `item-${path.replace(/\//g, "-")}`,
    name,
    size: entry.directory ? 0 : entry.bytes?.length || 0,
    eTag: entry.etag,
    lastModifiedDateTime: "2026-01-01T00:00:00.0000000Z",
    parentReference: { driveId: DRIVE },
    ...(entry.directory ? { folder: { childCount: 0 } } : { file: { mimeType: "application/octet-stream" } }),
    ...(entry.deleted ? { deleted: {} } : {}),
    ...(entry.remoteItem ? { remoteItem: { id: "remote" } } : {}),
    ...extra
  };
}

/** Minimal in-memory Graph drive covering only the shapes the MDBX2 transport issues. */
class MemoryGraph {
  readonly entries = new Map<string, Entry>([["", { directory: true, etag: '"root"' }]]);
  readonly puts: string[] = [];
  readonly foldersCreated: string[] = [];
  conflictNextPut = false;
  downloadUrlHost = "monica.files.1drv.com";
  omitPathDownloadUrl = false;
  private session?: { path: string; total: number; parts: Map<number, Uint8Array> };

  add(path: string, bytes: Uint8Array): void {
    const components = path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const directory = components.slice(0, index).join("/");
      if (!this.entries.has(directory)) this.entries.set(directory, { directory: true, etag: '"dir"' });
    }
    this.entries.set(path, { directory: false, bytes: bytes.slice(), etag: `"v${this.entries.size}"` });
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.origin !== "https://graph.microsoft.com") return this.capability(url, init);
    const method = (init.method || "GET").toUpperCase();
    if (new Headers(init.headers).get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 });
    }
    if (method === "GET" && url.pathname === `/v1.0/drives/${DRIVE}`) {
      return Response.json({ id: DRIVE, name: "OneDrive", driveType: "personal" });
    }
    if (url.pathname === `/v1.0/drives/${DRIVE}/root/children`) {
      if (method !== "POST") return new Response(null, { status: 405 });
      return this.createFolder("", init);
    }
    const itemMatch = url.pathname.match(/^\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)$/);
    if (itemMatch && method === "GET" && decodeURIComponent(itemMatch[1]) === DRIVE) {
      const wanted = decodeURIComponent(itemMatch[2]);
      for (const [path, entry] of this.entries.entries()) {
        if (`item-${path.replace(/\//g, "-")}` !== wanted) continue;
        const extra: Record<string, unknown> = {};
        if ((url.searchParams.get("$select") || "").includes("@microsoft.graph.downloadUrl") && !entry.directory) {
          extra["@microsoft.graph.downloadUrl"] = `https://${this.downloadUrlHost}/capability/${path.split("/").map(encodeURIComponent).join("/")}`;
        }
        return Response.json(itemJson(path, entry, extra));
      }
      return Response.json({ error: { code: "itemNotFound" } }, { status: 404 });
    }
    const contentMatch = url.pathname.match(/^\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)\/content$/);
    if (contentMatch && method === "GET" && decodeURIComponent(contentMatch[1]) === DRIVE) {
      const wanted = decodeURIComponent(contentMatch[2]);
      for (const [path, entry] of this.entries.entries()) {
        if (`item-${path.replace(/\//g, "-")}` !== wanted) continue;
        if (!entry.bytes) return new Response(null, { status: 404 });
        return new Response(entry.bytes.slice(), { status: 200, headers: { "content-length": String(entry.bytes.length) } });
      }
      return new Response(null, { status: 404 });
    }
    const target = this.target(url);
    if (!target) return Response.json({ error: { code: "itemNotFound" } }, { status: 404 });
    const { path, suffix } = target;
    if (method === "GET" && suffix === "children") return this.children(path, url);
    if (method === "GET") return this.stat(path, url);
    if (method === "POST" && suffix === "children") return this.createFolder(path, init);
    if (method === "POST" && suffix === "createUploadSession") return this.createUploadSession(path);
    if (method === "PUT" && suffix === "content") return this.simplePut(path, init);
    return new Response(null, { status: 405 });
  };

  private async capability(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method || "GET").toUpperCase();
    if (method === "PUT" && this.session) {
      const range = new Headers(init.headers).get("content-range")!;
      const [, start, end, total] = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/)!.map(Number) as unknown as number[];
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      this.session.parts.set(start, bytes);
      if (end + 1 === total) {
        const assembled = new Uint8Array(total);
        let offset = 0;
        for (const part of [...this.session.parts.entries()].sort(([a], [b]) => a - b)) {
          assembled.set(part[1], offset);
          offset += part[1].length;
        }
        this.add(this.session.path, assembled);
        this.session = undefined;
        return Response.json(itemJson("assembled", { directory: false, bytes: assembled, etag: '"up"' }), { status: 201 });
      }
      return Response.json({ nextExpectedRanges: [String(end + 1)] }, { status: 202 });
    }
    const entry = this.entries.get(decodeURIComponent(url.pathname.slice("/capability/".length)));
    if (!entry?.bytes) return new Response(null, { status: 404 });
    return new Response(entry.bytes.slice(), { status: 200, headers: { "content-length": String(entry.bytes.length) } });
  }

  private target(url: URL): { path: string; suffix: string } | undefined {
    const match = url.pathname.match(/^\/v1\.0\/drives\/([^/]+)\/root:\/(.*)$/);
    if (!match || decodeURIComponent(match[1]) !== DRIVE) return undefined;
    const rest = match[2];
    for (const suffix of ["children", "content", "createUploadSession"]) {
      if (rest.endsWith(`:/${suffix}`)) {
        return { path: decodePath(rest.slice(0, -suffix.length - 2)), suffix };
      }
    }
    if (rest.endsWith(":")) return { path: decodePath(rest.slice(0, -1)), suffix: "" };
    return undefined;
  }

  private stat(path: string, url: URL): Response {
    const entry = this.entries.get(path);
    if (!entry) return Response.json({ error: { code: "itemNotFound" } }, { status: 404 });
    const extra: Record<string, unknown> = {};
    if (!this.omitPathDownloadUrl && (url.searchParams.get("$select") || "").includes("@microsoft.graph.downloadUrl") && !entry.directory) {
      extra["@microsoft.graph.downloadUrl"] = `https://${this.downloadUrlHost}/capability/${path.split("/").map(encodeURIComponent).join("/")}`;
    }
    return Response.json(itemJson(path, entry, extra));
  }

  private children(path: string, url: URL): Response {
    const prefix = path ? `${path}/` : "";
    const all = [...this.entries.entries()]
      .filter(([candidate]) => candidate !== path && candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map(([candidate, entry]) => itemJson(candidate, entry));
    if (url.searchParams.has("$skiptoken")) return Response.json({ value: all.slice(1) });
    if (all.length < 2) return Response.json({ value: all });
    return Response.json({
      value: all.slice(0, 1),
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root:/${path.split("/").map(encodeURIComponent).join("/")}:/children?$select=${FIELDS}&$top=200&$skiptoken=page2`
    });
  }

  /** POST {parent}/children creates `parent/name`; the URL addresses the parent, the body the name. */
  private async createFolder(parent: string, init: RequestInit): Promise<Response> {
    const body = JSON.parse(await new Response(init.body).text()) as { name: string };
    const path = parent ? `${parent}/${body.name}` : body.name;
    if (this.entries.has(path)) return Response.json({ error: { code: "nameAlreadyExists" } }, { status: 409 });
    if (!this.entries.get(parent)?.directory) return Response.json({ error: { code: "parentNotFound" } }, { status: 404 });
    this.entries.set(path, { directory: true, etag: '"dir"' });
    this.foldersCreated.push(path);
    return Response.json(itemJson(path, this.entries.get(path)!), { status: 201 });
  }

  private async simplePut(path: string, init: RequestInit): Promise<Response> {
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    if (this.conflictNextPut) {
      // Simulates another device winning the create race: the immutable object
      // exists by the time the client re-stats.
      this.conflictNextPut = false;
      this.add(path, bytes);
      return Response.json({ error: { code: "nameAlreadyExists" } }, { status: 409 });
    }
    const existing = this.entries.get(path);
    if (existing) return Response.json({ error: { code: "nameAlreadyExists" } }, { status: 409 });
    this.add(path, bytes);
    this.puts.push(path);
    return Response.json(itemJson(path, this.entries.get(path)!), { status: 201 });
  }

  private createUploadSession(path: string): Response {
    this.session = { path, total: 0, parts: new Map() };
    return Response.json({ uploadUrl: `https://monica.sharepoint.com/upload/${path.split("/").map(encodeURIComponent).join("/")}` });
  }

  registerUploadSize(total: number): void {
    if (this.session) this.session.total = total;
  }
}

function decodePath(value: string): string {
  return value.split("/").map(decodeURIComponent).join("/");
}

async function digest(bytes: Uint8Array): Promise<string> {
  return sha256(bytes);
}

function client(graph: MemoryGraph, simpleUploadMaxBytes?: number): Mdbx2OneDriveClient {
  return new Mdbx2OneDriveClient(DRIVE, async () => TOKEN, graph.fetch, {}, simpleUploadMaxBytes);
}

describe("MDBX2 OneDrive transport", () => {
  it("rejects a successful upload whose stored bytes differ from the expected digest", async () => {
    const graph = new MemoryGraph();
    const bytes = new TextEncoder().encode("segment");
    await expect(client(graph).putImmutable("sync/segment", new Blob([bytes]), await digest(new Uint8Array(bytes.length))))
      .rejects.toThrow("内容碰撞");
    expect(graph.puts).toEqual(["sync/segment"]);
  });

  it("aborts an active capability stream when the owning vault locks", async () => {
    const graph = new MemoryGraph();
    graph.add("vaults/main.mdbx", new Uint8Array(64));
    const scope = new AbortController();
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let cancelled = false;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes("/capability/")) return new Response(new ReadableStream({ start() { started(); }, cancel() { cancelled = true; } }));
      return graph.fetch(url, init);
    };
    const transport = new Mdbx2OneDriveClient(DRIVE, async () => TOKEN, fetcher, {}, undefined, scope.signal);
    const download = transport.download("vaults/main.mdbx", 64, () => undefined);
    const failure = expect(download).rejects.toMatchObject({ code: "cancelled" });
    await began; scope.abort(); await failure;
    expect(cancelled).toBe(true);
  });

  it("does not replay streamed chunks after a response body fails", async () => {
    const graph = new MemoryGraph();
    const bytes = new Uint8Array(1024 * 1024);
    graph.add("vaults/main.mdbx", bytes);
    let downloads = 0;
    const offsets: number[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      if (!String(url).includes("/capability/")) return graph.fetch(url, init);
      downloads++;
      let pulls = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (pulls++ === 0) controller.enqueue(bytes);
        else controller.error(new TypeError("synthetic stream interruption"));
      } }));
    };
    const transport = new Mdbx2OneDriveClient(DRIVE, async () => TOKEN, fetcher);
    await expect(transport.download("vaults/main.mdbx", bytes.length, (_chunk, offset) => { offsets.push(offset); })).rejects.toMatchObject({ code: "network" });
    expect(downloads).toBe(1);
    expect(offsets.length).toBeGreaterThan(0);
    expect(new Set(offsets).size).toBe(offsets.length);
  });
  it("stats files and folders and treats missing or foreign items as absent", async () => {
    const graph = new MemoryGraph();
    const bytes = new TextEncoder().encode("vault-bytes");
    graph.add("vaults/main.mdbx", bytes);
    const transport = client(graph);
    await expect(transport.testConnection()).resolves.toBeUndefined();
    const file = await transport.stat("vaults/main.mdbx");
    expect(file).toMatchObject({ path: "vaults/main.mdbx", isDirectory: false, sizeBytes: bytes.length });
    expect(await transport.stat("vaults/missing.mdbx")).toBeUndefined();
    graph.entries.set("vaults/shared", { directory: true, etag: '"x"', remoteItem: true });
    expect(await transport.stat("vaults/shared")).toBeUndefined();
  });

  it("lists children across pages with full paths and skips deleted or remote entries", async () => {
    const graph = new MemoryGraph();
    graph.add("sync/one", new TextEncoder().encode("1"));
    graph.add("sync/two", new TextEncoder().encode("2"));
    graph.entries.set("sync/gone", { directory: false, etag: '"d"', deleted: true });
    graph.entries.set("sync/shortcut", { directory: true, etag: '"r"', remoteItem: true });
    const items = await client(graph).list("sync");
    expect(items.map(item => item.path)).toEqual(["sync/one", "sync/two"]);
  });

  it("creates missing folders and reconciles races by re-statting", async () => {
    const graph = new MemoryGraph();
    const transport = client(graph);
    await transport.ensureDirectory("vaults/main.mdbx.sync/streams");
    expect(graph.foldersCreated).toEqual(["vaults", "vaults/main.mdbx.sync", "vaults/main.mdbx.sync/streams"]);
    await transport.ensureDirectory("vaults/main.mdbx.sync/streams");
    expect(graph.foldersCreated).toHaveLength(3);
    graph.add("occupied/file", new TextEncoder().encode("x"));
    await expect(transport.ensureDirectory("occupied/file")).rejects.toThrow("已被文件占用");
  });

  it("uploads immutably: creates once, verifies identical existing content, and reconciles conflicts", async () => {
    const graph = new MemoryGraph();
    const bytes = new TextEncoder().encode("segment-payload");
    const transport = client(graph);
    await transport.putImmutable("streams/a/segments/0.mdbxsync", new Blob([bytes]), await digest(bytes));
    expect(graph.puts).toEqual(["streams/a/segments/0.mdbxsync"]);
    // Existing identical content: stat + verified download, no second PUT.
    await transport.putImmutable("streams/a/segments/0.mdbxsync", new Blob([bytes]), await digest(bytes));
    expect(graph.puts).toHaveLength(1);
    // Different digest for same-size content is a collision.
    await expect(transport.putImmutable("streams/a/segments/0.mdbxsync", new Blob([new Uint8Array(15).fill(1)]), await digest(new Uint8Array(15).fill(1))))
      .rejects.toThrow("内容碰撞");
    // A 409 race resolves through stat + identical verification.
    graph.conflictNextPut = true;
    await transport.putImmutable("streams/b/segments/0.mdbxsync", new Blob([bytes]), await digest(bytes));
    expect(graph.puts).toEqual(["streams/a/segments/0.mdbxsync"]);
    expect((await transport.stat("streams/b/segments/0.mdbxsync"))?.sizeBytes).toBe(bytes.length);
  });

  it("falls back to resumable upload sessions above the simple-upload ceiling", async () => {
    const graph = new MemoryGraph();
    const bytes = new Uint8Array(3000).fill(7);
    const transport = client(graph, 1024);
    await transport.putImmutable("vaults/main.mdbx", new Blob([bytes]), await digest(bytes));
    expect(graph.puts).toEqual([]);
    expect((await transport.stat("vaults/main.mdbx"))?.sizeBytes).toBe(bytes.length);
  });

  it("downloads through the preauthenticated capability URL with hashing and chunk callbacks", async () => {
    const graph = new MemoryGraph();
    const bytes = new Uint8Array(700).fill(3);
    graph.add("vaults/main.mdbx", bytes);
    const chunks: Array<{ offset: number; length: number }> = [];
    const result = await client(graph).download("vaults/main.mdbx", bytes.length, (chunk, offset) => {
      chunks.push({ offset, length: chunk.length });
    });
    expect(result).toMatchObject({ path: "vaults/main.mdbx", sizeBytes: bytes.length, sha256: await digest(bytes) });
    expect(chunks).toEqual([{ offset: 0, length: bytes.length }]);
    graph.downloadUrlHost = "evil.example.com";
    await expect(client(graph).download("vaults/main.mdbx", bytes.length, () => undefined)).rejects.toThrow();
  });

  it("streams /content by item id when the drive omits the capability annotation entirely", async () => {
    const graph = new MemoryGraph();
    const bytes = new Uint8Array(64).fill(9);
    graph.add("vaults/main.mdbx", bytes);
    graph.omitPathDownloadUrl = true;
    const result = await client(graph).download("vaults/main.mdbx", bytes.length, () => undefined);
    expect(result).toMatchObject({ path: "vaults/main.mdbx", sizeBytes: bytes.length, sha256: await digest(bytes) });
  });
});
