import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";

const input = process.env.MONICA_315_IDENTITY_FIXTURE;
const root = process.env.MONICA_315_IDENTITY_OUTPUT;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it.skipIf(!input || !root)("authenticates the same vault identity after Native Host restart", async () => {
  if (!input || !root) throw new Error("Explicit synthetic fixture and isolated output required");
  await mkdir(root, { recursive: true });
  const hostRoot = await mkdtemp(join(root, "host-"));
  const executable = resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe");
  const connect = () => new Mdbx2NativeClient(new ProcessNativeRuntime(executable, hostRoot));
  let client = connect();
  const bytes = await readFile(input), originalHash = hash(bytes);
  const credential = { method: "password" as const, password: "Synthetic transfer fixture password" };
  try {
    const transfer = await client.beginInboundTransfer(bytes.length, originalHash);
    for (let offset = 0; offset < bytes.length;) {
      offset = (await client.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
    }
    const file = await client.finishInboundTransfer(transfer.transferId);
    const opened = await client.openVault({ kind: "file", handle: file.fileHandle }, credential);
    expect(opened.vaultId).toBeTruthy();
    expect(opened.vaultId).not.toBe(opened.vaultHandle);
    expect(await client.vaultStatus(opened.vaultHandle)).toMatchObject({ open: true, vaultId: opened.vaultId });
    await client.lockVault(opened.vaultHandle);
    expect(await client.vaultStatus(opened.vaultHandle)).toEqual({ open: false, available: true, vaultHandle: opened.vaultHandle });
    client.close();
    client = connect();
    expect(await client.vaultStatus(opened.vaultHandle)).toEqual({ open: false, available: true, vaultHandle: opened.vaultHandle });
    await expect(client.openVault({ kind: "vault", handle: opened.vaultHandle }, { ...credential, password: "synthetic-wrong-password" })).rejects.toThrow();
    expect((await client.vaultStatus(opened.vaultHandle)).vaultId).toBeUndefined();
    const reopened = await client.openVault({ kind: "vault", handle: opened.vaultHandle }, credential);
    expect(reopened.vaultId).toBe(opened.vaultId);
    expect((await client.vaultStatus(opened.vaultHandle)).vaultId).toBe(opened.vaultId);
    expect(hash(await readFile(input))).toBe(originalHash);
    await writeFile(join(root, "vault-identity-evidence.json"), JSON.stringify({
      status: "passed", inputSha256: originalHash, vaultId: opened.vaultId,
      lockedIdentityAbsent: true, wrongPasswordIdentityAbsent: true, restartIdentityStable: true,
      sourceFileUnchanged: true, scope: "Actual Native Messaging process identity; not end-to-end move recovery"
    }, null, 2));
  } finally { client.close(); }
});
