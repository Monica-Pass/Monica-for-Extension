import { expect, type BrowserContext, type Worker } from "@playwright/test";

/** Microsoft OAuth/Graph are simulated. The extension, browser, KDBX and storage are real. */
export class SyntheticOneDrive {
  bytes: Buffer;
  version = 1;
  puts = 0;
  reads = 0;
  signIns = 0;
  rejectAuth = false;
  readonly fileName = "Android 与浏览器共用的密码和 Passkey 数据库.kdbx";
  constructor(bytes: Uint8Array) { this.bytes = Buffer.from(bytes); }
  metadata() { return { id: "file1", name: this.fileName, size: this.bytes.length, eTag: `"v${this.version}"`, file: {}, parentReference: { driveId: "drive1" }, "@microsoft.graph.downloadUrl": "https://fixture.files.1drv.com/content" }; }

  async install(context: BrowserContext, worker: Worker) {
    await context.route("https://login.microsoftonline.com/**", async route => {
      this.signIns++;
      await route.fulfill({ json: { access_token: `synthetic-access-${this.signIns}`, refresh_token: `synthetic-refresh-${this.signIns}`, token_type: "Bearer", expires_in: 3600, scope: "Files.ReadWrite User.Read" } });
    });
    await context.route("https://graph.microsoft.com/**", async route => {
      const request = route.request();
      expect(request.headers().authorization).toMatch(/^Bearer synthetic-access-/);
      if (this.rejectAuth) { await route.fulfill({ status: 401, json: { error: { code: "InvalidAuthenticationToken" } } }); return; }
      const url = new URL(request.url());
      if (url.pathname.endsWith("/me")) { await route.fulfill({ json: { id: "account1", displayName: "Synthetic account", mail: "onedrive-interop@example.invalid" } }); return; }
      if (url.pathname.endsWith("/me/drive")) { await route.fulfill({ json: { id: "drive1", name: "OneDrive", driveType: "personal" } }); return; }
      if (url.pathname.endsWith("/children")) {
        await route.fulfill({ json: { value: url.pathname.includes("/root/") ? [{ id: "folder1", name: "Monica 数据库", size: 0, folder: {}, parentReference: { driveId: "drive1" } }] : [this.metadata()] } }); return;
      }
      if (request.method() === "PUT") {
        if (request.headers()["if-match"] !== `"v${this.version}"`) { await route.fulfill({ status: 412, body: "" }); return; }
        this.bytes = request.postDataBuffer()!; this.version++; this.puts++;
      }
      await route.fulfill({ json: this.metadata() });
    });
    await context.route("https://fixture.files.1drv.com/**", async route => {
      expect(route.request().headers().authorization).toBeUndefined();
      expect(route.request().headers().cookie).toBeUndefined();
      this.reads++; await route.fulfill({ body: this.bytes, contentType: "application/octet-stream" });
    });
    await worker.evaluate(() => {
      (globalThis as any).__oneDriveTest = { hold: false, held: undefined };
      Object.defineProperty(chrome.identity, "launchWebAuthFlow", { configurable: true, value: (options: { url: string }, callback: (url: string) => void) => {
        const params = new URL(options.url).searchParams;
        const finish = () => callback(`${params.get("redirect_uri")}?state=${params.get("state")}&code=synthetic-code`);
        if ((globalThis as any).__oneDriveTest.hold) (globalThis as any).__oneDriveTest.held = finish;
        else setTimeout(finish, 0);
      } });
    });
  }
}
