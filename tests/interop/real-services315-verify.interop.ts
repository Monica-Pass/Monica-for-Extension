import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ProviderAccount, VaultItem, LoginItem } from "../../src/core/model";
import { MonicaWebDavProvider } from "../../src/providers/webdav/monica-webdav-provider";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { BitwardenProvider } from "../../src/providers/bitwarden/bitwarden-provider";
import { BitwardenAttachmentDownloadService } from "../../src/providers/bitwarden/bitwarden-attachments";
import { KeePassWebDavClient } from "../../src/providers/keepass/keepass-webdav-client";
import { KeePassProvider } from "../../src/providers/keepass/keepass-provider";

const path = process.env.MONICA_315_REAL_EDGE_VERIFY;
it.skipIf(!path)("independently reopens actual Docker server state after real Edge UI commits", async () => {
  const input = JSON.parse(await readFile(resolve(path!), "utf8")) as { fixturePath: string; expected: Array<{ backend: string; title: string; fields: Pick<LoginItem, "loginType" | "username" | "password" | "notes" | "customFields">; attachmentName: string; attachmentSha256: string; attachmentSize: number }> };
  const fixtures = JSON.parse(await readFile(input.fixturePath, "utf8"));
  const results: unknown[] = [];
  for (const expected of input.expected) {
    try {
      const fixture = fixtures[expected.backend];
      let account: ProviderAccount = { id: `independent-${expected.backend}`, name: "Independent verification", kind: "monica-webdav", enabled: true, isDefaultSaveTarget: false, config: fixture };
      let items: VaultItem[];
      let readBytes: (item: VaultItem) => Promise<Uint8Array>;
      if (expected.backend === "webdav") {
        const provider = new MonicaWebDavProvider();
        items = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items;
        readBytes = async item => {
          const attachment = (await provider.listAttachments(account, item)).items.find(attachment => attachment.fileName === expected.attachmentName)!;
          expect(attachment).toBeDefined(); return (await provider.readAttachment(account, item, attachment.attachmentId)).bytes;
        };
      } else if (expected.backend === "keepass") {
        account = { ...account, kind: "keepass", config: { sourceMode: "webdav", databaseId: 315 } };
        const file = await new KeePassWebDavClient(fixture).read();
        const provider = new KeePassProvider();
        await provider.unlock(account, file.bytes, { password: fixture.databasePassword, sourceMode: "webdav" });
        items = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items;
        readBytes = async item => {
          const attachment = provider.listAttachments(account, item).find(attachment => attachment.fileName === expected.attachmentName)!;
          expect(attachment).toBeDefined(); return provider.readAttachment(account, item, attachment.attachmentId, 0).bytes;
        };
      } else {
        const client = new BitwardenClient();
        const login = await client.login({ vaultUrl: fixture.baseUrl, email: fixture.email, masterPassword: fixture.password, deviceId: randomUUID() });
        expect(login.status).toBe("authenticated"); if (login.status !== "authenticated") throw new Error("Verification session could not authenticate.");
        account = { ...account, kind: "bitwarden", config: login.session };
        items = (await new BitwardenProvider().sync(account, { now: new Date().toISOString(), localItems: [] })).items;
        readBytes = async item => {
          const ref = item.providerRefs.find(ref => ref.providerId === account.id)!;
          const raw = await client.getCipherDetails(login.session, ref.remoteId!); expect(raw.payload).toBeTruthy();
          const downloads = new BitwardenAttachmentDownloadService();
          const context = { providerId: account.id, itemId: item.id, session: raw.session, rawCipher: raw.payload! };
          const attachment = (await downloads.listAttachments(context)).items.find(attachment => attachment.fileName === expected.attachmentName)!;
          expect(attachment).toBeDefined(); const begun = await downloads.beginDownload({ ...context, attachmentId: attachment.attachmentId });
          return downloads.readChunk(account.id, begun.readHandle, 0, 262144).bytes;
        };
      }
      const matches = items.filter(item => item.title === expected.title);
      expect(matches).toHaveLength(1); const item = matches[0]; expect(item.kind).toBe("login");
      if (item.kind !== "login") throw new Error("Expected preserved GPG login item.");
      for (const field of ["loginType", "username", "password", "notes"] as const) expect(item[field]).toBe(expected.fields[field]);
      const content = (fields: LoginItem["customFields"]) => fields.map(field => ({ name: field.name, value: field.value, protected: field.protected })).sort((a, b) => a.name.localeCompare(b.name));
      expect(content(item.customFields)).toEqual(content(expected.fields.customFields));
      const bytes = await readBytes(item);
      expect(bytes.length).toBe(expected.attachmentSize);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.attachmentSha256);
      results.push({ backend: expected.backend, status: "passed", title: expected.title, exactLoginFieldsAndContent: true, attachmentBytes: bytes.length, attachmentSha256: expected.attachmentSha256 });
    } catch (error) { results.push({ backend: expected.backend, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
  }
  await writeFile(join(dirname(resolve(path!)), "real-services-independent-readback.json"), JSON.stringify({ layer: "fresh independent server authentication/read/decryption after real Edge UI writes; not extension cache", generatedAt: new Date().toISOString(), expectedCount: input.expected.length, results }, null, 2));
  expect(input.expected).toHaveLength(3);
  expect(results.filter(result => (result as { status: string }).status === "failed")).toEqual([]);
});
