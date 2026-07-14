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
});
