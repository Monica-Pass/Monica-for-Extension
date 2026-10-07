import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { BitwardenClient } from "../src/providers/bitwarden/bitwarden-client";

// All account material belongs to previous, isolated synthetic acceptance runs.
const root = resolve(process.cwd());
const out = join(root, ".tmp/android-cm-backends-317");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const sources: { path: string; sha256: string }[] = [];
async function input(path: string) {
  const bytes = await readFile(join(root, path));
  sources.push({ path, sha256: hash(bytes) });
  return bytes;
}
await mkdir(out, { recursive: true });
const config: Record<string, unknown> = { syntheticFreshInstallation: true };
const expected = [];
const services = await json(join(root, ".tmp/interop-315-docker/services.json"));
assert.equal(services.webdav.baseUrl, "http://127.0.0.1:18315");
const authorization = `Basic ${Buffer.from(`${services.webdav.username}:${services.webdav.password}`).toString("base64")}`;
for (const tag of ["kdbx", "webdav"]) {
  const directory = `.tmp/android-${tag}-passkeys-317`;
  const metadata = JSON.parse((await input(`${directory}/extension-passkeys-expected.json`)).toString());
  const bytes = await input(`${directory}/extension-passkeys.kdbx`);
  assert.equal(metadata.synthetic, true);
  assert.equal(metadata.inputSha256, hash(bytes));
  assert.equal(metadata.passkeys.length, 1);
  expected.push({ ...metadata.passkeys[0], tag });
  const source = { inputSha256: hash(bytes), databasePassword: metadata.password, expected: metadata.passkeys[0] };
  if (tag === "kdbx") {
    // This file is the exact previous RSA registration export, not a reconstruction.
    const edgeBytes = await input(".tmp/kdbx-passkey-edge-input/passkey-registration-algor-c4f1c-s-portable-signing-material/extension-passkeys.kdbx");
    assert.deepEqual(bytes, edgeBytes);
    await writeFile(join(out, "edge-local.kdbx"), bytes);
    config[tag] = source;
  } else {
    const remotePath = `passkey-${randomUUID()}/vault.kdbx`;
    const remoteUrl = `${services.webdav.baseUrl}/${remotePath}`;
    const folder = await fetch(remoteUrl.slice(0, remoteUrl.lastIndexOf("/")), { method: "MKCOL", headers: { authorization }, redirect: "error" });
    assert.equal(folder.status, 201);
    // A new synthetic directory preserves all earlier Android return evidence.
    const put = await fetch(remoteUrl, { method: "PUT", headers: { authorization, "If-None-Match": "*" }, body: bytes, redirect: "error" });
    assert.equal(put.status, 201);
    const get = await fetch(remoteUrl, { headers: { authorization }, redirect: "error" });
    assert.equal(get.status, 200);
    assert.equal(hash(new Uint8Array(await get.arrayBuffer())), hash(bytes));
    config[tag] = { ...source, baseUrl: "http://10.0.2.2:18315", username: services.webdav.username, password: services.webdav.password, remotePath };
    await writeFile(join(out, "webdav-transport.json"), JSON.stringify({ remotePath, inputSha256: hash(bytes), etag: get.headers.get("etag"), exactHistoricalEdgeExport: true }, null, 2));
  }
}
const account = await json(join(root, ".tmp/android-bitwarden-uuid-passkeys-317/bitwarden-account.json"));
assert.equal(account.synthetic, true);
assert.equal(account.baseUrl, "http://127.0.0.1:18316");
assert.match(account.email, /^passkey-[0-9a-f-]{36}@example\.invalid$/);
const registration = JSON.parse((await input(".tmp/android-bitwarden-uuid-passkeys-317/extension-passkey-expected.json")).toString());
const login = await new BitwardenClient().login({ vaultUrl: account.baseUrl, email: account.email, masterPassword: account.password, deviceId: randomUUID() });
assert.equal(login.status, "authenticated");
if (login.status !== "authenticated") throw new Error("Synthetic login needs attention");
config.bitwarden = { synthetic: true, baseUrl: "http://10.0.2.2:18316", email: account.email,
  accessToken: login.session.accessToken, vaultKeyEnc: login.session.vaultKeyEnc, vaultKeyMac: login.session.vaultKeyMac, expected: registration };
expected.push({ ...registration, tag: "bitwarden", backupEligible: true, backupState: true });
await writeFile(join(out, "backend-config.json"), JSON.stringify(config, null, 2));
await writeFile(join(out, "expected.json"), JSON.stringify(expected, null, 2));
await writeFile(join(out, "input-provenance.json"), JSON.stringify({ at: new Date().toISOString(), sources,
  scope: "Exact historical Edge KDBX exports and live synthetic Vaultwarden account with original registered credential; no new registration or source rewriting" }, null, 2));
console.log("Three synthetic backend inputs prepared; credentials remain in ignored local config.");
