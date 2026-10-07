import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLoginItem, type ProviderAccount } from "../../src/core/model";
import { MonicaWebDavProvider } from "../../src/providers/webdav/monica-webdav-provider";
import { WebDavClient } from "../../src/providers/webdav/webdav-client";
import { BitwardenClient, type BitwardenSessionConfig } from "../../src/providers/bitwarden/bitwarden-client";
import { BitwardenProvider } from "../../src/providers/bitwarden/bitwarden-provider";
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey } from "../../src/providers/bitwarden/bitwarden-crypto";
import { MemoryBitwardenAttachmentMutationStore } from "../../src/providers/bitwarden/bitwarden-attachment-mutation-store";
import { BitwardenAttachmentMutationService } from "../../src/providers/bitwarden/bitwarden-attachment-mutations";
import { KeePassWebDavClient } from "../../src/providers/keepass/keepass-webdav-client";
import { KeePassProvider } from "../../src/providers/keepass/keepass-provider";
import { buildKeePassFixture } from "../../src/providers/keepass/keepass-fixture";

interface Config { webdav: { baseUrl: string; username: string; password: string }; vaultwarden: { baseUrl: string; email?: string; password: string }; [key: string]: unknown }
const configured = Boolean(process.env.MONICA_315_REAL_SERVICES_CONFIG) && !process.env.MONICA_315_REAL_EDGE_VERIFY;
const evidence: Record<string, unknown> = { layer: "actual loopback Docker services; real fetch, no HTTP mocks; adapter acceptance, not Android/Edge UI", checks: [], startedAt: new Date().toISOString() };
let config: Config;
let output: string;
let webdav: Config["webdav"];
let accountEmail: string;
let webdavSetupError: string | undefined;
const fixtures: Record<string, unknown> = {};
const archivePassword = "synthetic archive password";
const dbPassword = "Synthetic real service KDBX password";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const now = () => new Date().toISOString();

beforeAll(async () => {
  if (!configured) return;
  config = JSON.parse(await readFile(resolve(process.env.MONICA_315_REAL_SERVICES_CONFIG!), "utf8")) as Config;
  for (const address of [config.webdav.baseUrl, config.vaultwarden.baseUrl]) expect(new URL(address).hostname).toBe("127.0.0.1");
  const parent = resolve(".tmp/interop-315-real-services");
  await mkdir(parent, { recursive: true }); output = await mkdtemp(join(parent, "run-"));
  const runId = `monica315-${randomUUID()}`;
  const baseUrl = `${config.webdav.baseUrl.replace(/\/$/, "")}/${runId}`;
  webdav = { ...config.webdav, baseUrl };
  accountEmail = config.vaultwarden.email || `${runId}@example.invalid`;
  evidence.endpoints = { webdav: baseUrl, vaultwarden: config.vaultwarden.baseUrl };
  evidence.sourceConfig = resolve(process.env.MONICA_315_REAL_SERVICES_CONFIG!);
  evidence.output = output;
  const response = await fetch(baseUrl, { method: "MKCOL", headers: authorization(config.webdav) });
  if (response.status !== 201) { webdavSetupError = `Independent WebDAV directory MKCOL returned ${response.status}: ${await response.text()}`; evidence.webdavSetupError = webdavSetupError; }
});
afterAll(async () => {
  if (!configured) return;
  evidence.finishedAt = now();
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(join(output, "edge-fixtures.json"), JSON.stringify(fixtures, null, 2));
  process.stdout.write(`REAL_SERVICES315_EVIDENCE ${join(output, "evidence.json")}\n`);
});

describe.skipIf(!configured)("actual Docker service Android315 adapters", () => {
  it("exchanges actual Android ZIP, complete metadata and attachment bytes with a real WebDAV server", async () => recorded("real-webdav-android-zip", async () => {
    if (webdavSetupError) throw new Error(webdavSetupError);
    const fixture = resolve(process.env.MONICA_315_ANDROID_ZIP || ".tmp/android-app-interop-315/android.zip");
    const original = await readFile(fixture);
    const client = new WebDavClient(webdav);
    await client.testConnection();
    const seeded = await client.upload(original, true);
    let account: ProviderAccount = { id: "real-webdav-315", kind: "monica-webdav", name: "Docker Android ZIP315", enabled: true, isDefaultSaveTarget: false, config: { ...webdav, backupPassword: archivePassword } };
    const provider = new MonicaWebDavProvider();
    const baseline = await provider.sync(account, { now: now(), localItems: [] });
    account = patch(account, baseline.accountPatch);
    expect(baseline.items).toHaveLength(20);
    const group = baseline.items.filter(item => item.kind === "login" && item.title.endsWith("-group"));
    expect(group).toHaveLength(3);
    const owner = group.find(item => item.kind === "login" && item.customFields.some(field => field.name === "monica.content.wallet.bank_card"))!;
    expect(owner).toBeDefined();
    const preserved = owner.kind === "login" ? owner.customFields : [];
    const attachments = [];
    for (const item of baseline.items) for (const attachment of (await provider.listAttachments(account, item)).items) {
      const read = await provider.readAttachment(account, item, attachment.attachmentId);
      expect(read.bytes.length).toBe(attachment.sizeBytes);
      attachments.push({ itemId: item.id, name: attachment.fileName, sha256: sha256(read.bytes) });
    }
    expect(attachments).toHaveLength(3);
    const changed = baseline.items.map(item => item.id === owner.id ? { ...item, notes: `${item.notes}\nEdited through real WebDAV`, updatedAt: new Date(Date.now() + 1000).toISOString() } : item);
    const updated = await provider.sync(account, { now: now(), localItems: changed });
    expect(updated.conflicts).toEqual([]);
    account = patch(account, updated.accountPatch);
    const reopened = await new MonicaWebDavProvider().sync(account, { now: now(), localItems: [] });
    expect(reopened.items).toHaveLength(20);
    const savedOwner = reopened.items.find(item => item.providerRefs[0].remoteId === owner.providerRefs[0].remoteId)!;
    expect(savedOwner.notes).toContain("Edited through real WebDAV");
    expect(savedOwner.kind === "login" && savedOwner.customFields).toEqual(preserved);
    const bytes = new TextEncoder().encode("real WebDAV attachment\n中文\u0000exact");
    const uploaded = await provider.addAttachment(account, savedOwner, { fileName: "real-service.txt", mediaType: "text/plain", sizeBytes: bytes.length, sha256Hex: sha256(bytes) }, bytes);
    expect(uploaded.mediaType).toBe("text/plain");
    expect(sha256((await provider.readAttachment(account, savedOwner, uploaded.attachmentId)).bytes)).toBe(sha256(bytes));
    const allFilesBeforeFailure = await snapshotBackups(client);
    await expect(provider.sync({ ...account, config: { ...account.config, backupPassword: "incorrect synthetic" } }, { now: now(), localItems: reopened.items })).rejects.toThrow();
    const abort = new AbortController(); abort.abort();
    await expect(provider.sync(account, { now: now(), localItems: reopened.items, signal: abort.signal })).rejects.toThrow();
    expect(await snapshotBackups(client)).toEqual(allFilesBeforeFailure);
    const [latest] = await client.listBackups();
    const returned = await client.download(latest);
    await writeFile(join(output, "real-webdav-return.zip"), returned);
    expect(sha256(await readFile(fixture))).toBe(sha256(original));
    fixtures.webdav = { ...webdav, backupPassword: archivePassword, name: "Docker Android ZIP315", itemCount: 20, ownerTitle: owner.title, ownerUsername: owner.kind === "login" ? owner.username : "", sourceFixture: fixture, latestFileName: latest.name };
    return { recordCount: 20, existingAttachments: attachments, newAttachmentSha256: sha256(bytes), fullWalletFieldsUnchanged: true, wrongPasswordAndCancelPreservedRemote: true, seededSha256: sha256(await client.download(seeded)), outputSha256: sha256(returned) };
  }));

  it("uses a real WebDAV KDBX file, actual encryption and conditional writes", async () => recorded("real-webdav-keepass", async () => {
    if (webdavSetupError) throw new Error(webdavSetupError);
    const bytes = await buildKeePassFixture({ password: dbPassword, name: "Docker KDBX315", entries: [{ title: "Docker KDBX GPG315", fields: { UserName: "synthetic-kdbx", monica_gpg_type: "GPG_KEY" }, protectedFields: { Password: "SYNTHETIC-GPG-PRIVATE", "monica.content.future": '{"exact":9007199254740993,"nil":null}' }, binaries: { "synthetic-kdbx.txt": new TextEncoder().encode("actual KDBX attachment 中文") } }] });
    const remotePath = "synthetic315.kdbx";
    const response = await fetch(`${webdav.baseUrl}/${remotePath}`, { method: "PUT", headers: { ...authorization(webdav), "If-None-Match": "*" }, body: bytes as BodyInit });
    expect(response.status, await response.text()).toBe(201);
    const client = new KeePassWebDavClient({ ...webdav, remotePath });
    await client.testConnection();
    const snapshot = await client.read();
    expect(snapshot.sha256).toBe(sha256(bytes));
    const provider = new KeePassProvider();
    const account: ProviderAccount = { id: "real-kdbx315", kind: "keepass", name: "Docker KDBX315", enabled: true, isDefaultSaveTarget: false, config: { sourceMode: "webdav", databaseId: 315 } };
    await provider.unlock(account, snapshot.bytes, { password: dbPassword, sourceMode: "webdav" });
    const result = await provider.sync(account, { now: now(), localItems: [] });
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.kind === "login" && item.loginType).toBe("GPG_KEY");
    await provider.update(account, { ...item, notes: "Real WebDAV adapter edit" });
    const modified = await provider.exportFile(account.id);
    expect(snapshot.etag).toBeTruthy();
    await client.write(modified, snapshot.etag!);
    const latest = await client.read();
    expect(latest.sha256).toBe(sha256(modified));
    await expect(client.write(bytes, snapshot.etag!)).rejects.toThrow();
    expect((await client.read()).sha256).toBe(latest.sha256);
    await expect(new KeePassProvider().unlock(account, latest.bytes, { password: "incorrect synthetic" })).rejects.toThrow();
    fixtures.keepass = { ...webdav, remotePath, databasePassword: dbPassword, name: "Docker KDBX315", title: item.title };
    return { title: item.title, inputSha256: snapshot.sha256, outputSha256: latest.sha256, staleEtagRejected: true, wrongPasswordRejected: true, fixtureOrigin: "kdbxweb synthetic; not Android application export" };
  }));

  it("registers and roundtrips cipher fields and attachment bytes against real Vaultwarden", async () => recorded("real-vaultwarden", async () => {
    const client = new BitwardenClient();
    if (!config.vaultwarden.email) {
      const kdf = { type: 0 as const, iterations: 600000 };
      const master = await deriveBitwardenMasterKey(config.vaultwarden.password, accountEmail, kdf);
      const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
      const body = { email: accountEmail, name: "Monica synthetic315", masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, config.vaultwarden.password), key: await client.protectVaultKey(key, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: kdf.iterations };
      // Vaultwarden 1.37.3 src/api/identity.rs::identity_register uses identity,
      // not the old /api registration mount.
      const response = await fetch(`${config.vaultwarden.baseUrl}/identity/accounts/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.ok, `${response.status}: ${await response.text()}`).toBe(true);
      master.fill(0); key.encKey.fill(0); key.macKey.fill(0);
    }
    const login = await client.login({ vaultUrl: config.vaultwarden.baseUrl, email: accountEmail, masterPassword: config.vaultwarden.password, deviceId: randomUUID() });
    expect(login.status).toBe("authenticated");
    if (login.status !== "authenticated") throw new Error("Real Vaultwarden authentication was not completed.");
    let account: ProviderAccount = { id: "real-vaultwarden315", kind: "bitwarden", name: "Docker Vaultwarden315", enabled: true, isDefaultSaveTarget: false, config: login.session };
    const provider = new BitwardenProvider();
    const initial = await provider.sync(account, { now: now(), localItems: [] });
    expect(initial.items).toEqual([]);
    account = patch(account, initial.accountPatch);
    const created = ["GPG_KEY", "API_KEY"].map(kind => ({ ...createLoginItem({ title: `Docker ${kind}315`, username: "synthetic-vaultwarden", password: `synthetic-${kind}-secret`, providerRefs: [{ providerId: account.id }] }), loginType: kind as "GPG_KEY" | "API_KEY", customFields: [{ name: "monica.content.future", value: '{"exact":9007199254740993,"nil":null,"empty":""}', protected: true }], totpSecret: "otpauth://hotp/Synthetic?secret=JBSWY3DPEHPK3PXP&counter=9007199254740993" }));
    const written = await provider.sync(account, { now: now(), localItems: created });
    expect(written.conflicts).toEqual([]); account = patch(account, written.accountPatch);
    const reread = await new BitwardenProvider().sync(account, { now: now(), localItems: [] });
    expect(reread.items.filter(item => item.kind === "login")).toHaveLength(2);
    expect(reread.items.filter(item => item.kind === "totp")).toHaveLength(2);
    for (const item of reread.items) {
      if (item.kind === "totp") { expect(item.counter).toBe("9007199254740993"); continue; }
      expect(item.kind).toBe("login"); if (item.kind !== "login") continue;
      expect(item.customFields.find(field => field.name === "monica.content.future")?.value).toBe(created[0].customFields[0].value);
      expect(item.totpSecret).toContain("counter=9007199254740993");
    }
    const target = reread.items.find(item => item.kind === "login")!; const ref = target.providerRefs[0];
    const raw = await client.getCipherDetails(account.config as BitwardenSessionConfig, ref.remoteId!);
    expect(raw.payload).toBeTruthy();
    const attachmentHttp: unknown[] = [];
    evidence.vaultwardenAttachmentHttp = attachmentHttp;
    const observedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.includes("attachment")) {
        // Keep protocol diagnostics, not signed download URLs or cipher contents.
        const body = await response.clone().arrayBuffer();
        let shape: unknown;
        if (response.headers.get("content-type")?.includes("json")) {
          const payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
          shape = { keys: Object.keys(payload), fileUploadType: payload.fileUploadType,
            uploadPath: typeof payload.url === "string" ? new URL(payload.url, url).pathname : undefined };
        }
        attachmentHttp.push({ path: url.pathname, method: init?.method || "GET", status: response.status,
          responseBytes: body.byteLength, responseSha256: sha256(new Uint8Array(body)), shape });
      }
      return response;
    };
    const attachments = new BitwardenAttachmentMutationService({ fetcher: observedFetch, store: new MemoryBitwardenAttachmentMutationStore() });
    const bytes = new TextEncoder().encode("actual Vaultwarden attachment 中文\u0000");
    const uploaded = await attachments.upload({ providerId: account.id, itemId: target.id, session: raw.session, rawCipher: raw.payload!, operationId: randomUUID(), fileName: "synthetic-real.txt", bytes: bytes.slice(), sha256: sha256(bytes) });
    expect(uploaded.attachment?.sizeBytes).toBe(bytes.length);
    // Upload service performs authenticated download/hash verification before its receipt.
    expect(uploaded.changed).toBe(true);
    const beforeWrong = await client.sync(uploaded.session);
    await expect(client.login({ vaultUrl: config.vaultwarden.baseUrl, email: accountEmail, masterPassword: "incorrect synthetic", deviceId: randomUUID() })).rejects.toThrow();
    const afterWrong = await client.sync(beforeWrong.session);
    expect((afterWrong.payload.ciphers || afterWrong.payload.Ciphers) as unknown[]).toHaveLength(2);
    fixtures.vaultwarden = { baseUrl: config.vaultwarden.baseUrl, email: accountEmail, password: config.vaultwarden.password, name: "Docker Vaultwarden315", titles: created.map(item => item.title), itemCount: reread.items.length };
    return { ciphers: 2, kinds: reread.items.map(item => item.kind === "login" ? item.loginType : item.kind), futureFieldAndHotpExact: true, attachmentBytes: bytes.length, attachmentSha256: sha256(bytes), wrongPasswordRejected: true, server: "self-hosted Vaultwarden; not official Bitwarden cloud" };
  }));
});

async function recorded(name: string, body: () => Promise<unknown>) { try { const details = await body(); (evidence.checks as unknown[]).push({ name, status: "passed", details }); } catch (error) { (evidence.checks as unknown[]).push({ name, status: "failed", error: error instanceof Error ? error.message : String(error) }); throw error; } }
function authorization(value: Config["webdav"]) { return { Authorization: `Basic ${Buffer.from(`${value.username}:${value.password}`).toString("base64")}` }; }
function patch(account: ProviderAccount, update?: Partial<ProviderAccount>): ProviderAccount { return { ...account, ...update, config: { ...account.config, ...update?.config } }; }
async function snapshotBackups(client: WebDavClient) { return Promise.all((await client.listBackups()).map(async file => ({ name: file.name, sha256: sha256(await client.download(file)) }))); }
