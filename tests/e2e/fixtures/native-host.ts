import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const hostName = "com.monica_pass.mdbx2";
const registry = `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`;

function snapshot() {
  // Same ownership checks as scripts/interop-315-edge.mjs. Never expand an existing value.
  const command = `$key = Get-Item -LiteralPath 'Registry::${registry}' -ErrorAction SilentlyContinue; if ($null -eq $key) { @{ exists=$false; hasDefault=$false; value=$null; kind=$null; valueNames=@(); subKeys=@() } | ConvertTo-Json -Compress } else { $hasDefault=$key.GetValueNames() -contains ''; @{ exists=$true; hasDefault=$hasDefault; valueNames=@($key.GetValueNames() | Sort-Object); subKeys=@($key.GetSubKeyNames() | Sort-Object); value=if($hasDefault){$key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null}; kind=if($hasDefault){$key.GetValueKind('').ToString()}else{$null} } | ConvertTo-Json -Compress }`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true }));
}

/** Real Native Messaging; caller must give Edge an isolated LOCALAPPDATA and close it before restore. */
export async function temporaryNativeHost(extensionId: string, output: string) {
  const executable = path.resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe");
  await stat(executable);
  await mkdir(output, { recursive: true });
  const before = snapshot();
  assert.ok(!before.hasDefault || ["String", "ExpandString"].includes(before.kind));
  await writeFile(path.join(output, "native-registry-before.json"), JSON.stringify(before, null, 2));
  const manifest = path.join(output, `${hostName}.json`);
  await writeFile(manifest, JSON.stringify({ name: hostName, description: "Monica synthetic Edge interoperability acceptance", path: executable, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2));
  const evidence = { executable, sha256: createHash("sha256").update(await readFile(executable)).digest("hex"), manifest, registry, restored: false };
  execFileSync("reg.exe", ["add", registry, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { windowsHide: true, stdio: "pipe" });
  return {
    evidence,
    async restore() {
      const current = snapshot();
      assert.equal(current.value, manifest, "Native registration changed concurrently; refusing to overwrite it.");
      if (before.hasDefault) execFileSync("reg.exe", ["add", registry, "/ve", "/t", before.kind === "ExpandString" ? "REG_EXPAND_SZ" : "REG_SZ", "/d", before.value, "/f"], { windowsHide: true, stdio: "pipe" });
      else {
        if (!before.exists) { assert.deepEqual(current.valueNames, [""]); assert.deepEqual(current.subKeys, []); }
        execFileSync("reg.exe", before.exists ? ["delete", registry, "/ve", "/f"] : ["delete", registry, "/f"], { windowsHide: true, stdio: "pipe" });
      }
      assert.deepEqual(snapshot(), before);
      evidence.restored = true;
      await writeFile(path.join(output, "native-host-evidence.json"), JSON.stringify(evidence, null, 2));
    }
  };
}
