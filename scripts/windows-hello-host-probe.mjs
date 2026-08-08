import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  expectHostError,
  expectHostSuccess,
  isolatedWindowsHelloRoot,
  removeIsolatedWindowsHelloRoot,
  requestWindowsHelloHost,
  windowsHelloHostExecutable
} from "./windows-hello-native-protocol.mjs";

const executable = windowsHelloHostExecutable("debug");
const root = await isolatedWindowsHelloRoot("monica-windows-hello-safe-probe-");
const bindingId = randomUUID();
const challengeBase64Url = randomBytes(32).toString("base64url");
const request = (method, params) => requestWindowsHelloHost({ executable, localAppData: root, method, params });

try {
  const initial = expectHostSuccess(await request("hello.status", {}), "hello.status");
  if (initial.version !== 1 || initial.rpId !== "monica-extension.local" || initial.supported !== (process.platform === "win32") || initial.bindingIdPresent !== false) {
    throw new Error("Windows Hello initial status is not truthful for this platform.");
  }
  const serializedInitial = JSON.stringify(initial);
  for (const forbidden of ["credentialId", "privateKey", "signature", "challenge"]) {
    if (serializedInitial.includes(forbidden)) throw new Error(`Windows Hello status exposed ${forbidden}.`);
  }

  const missing = expectHostSuccess(await request("hello.status", { bindingId }), "hello.status(binding)");
  if (missing.enrolled !== false || missing.bindingIdPresent !== true || !["windows-only", "platform-authenticator-unavailable", "not-enrolled"].includes(missing.reason)) {
    throw new Error("Windows Hello missing-binding status is invalid.");
  }
  expectHostError(await request("hello.enroll", { bindingId, displayName: "Monica 验收", confirmed: false }), "confirmation-required", "hello.enroll");
  expectHostError(await request("hello.revoke", { bindingId, confirmed: false }), "confirmation-required", "hello.revoke");
  expectHostError(await request("hello.verify", { bindingId, challengeBase64Url }), "hello-not-enrolled", "hello.verify");

  const recordDirectory = path.join(root, "Monica Extension", "MDBX2", "hello");
  const recordPath = path.join(recordDirectory, `${bindingId}.json`);
  await mkdir(recordDirectory, { recursive: true });
  await writeFile(recordPath, JSON.stringify({ version: 1, bindingId: randomUUID(), rpId: "monica-extension.local", credentialId: "AA", createdAtUnixSecs: 1 }), { flag: "wx" });
  const damaged = expectHostSuccess(await request("hello.status", { bindingId }), "hello.status(damaged)");
  if (damaged.enrolled !== false || damaged.reason !== "binding-record-invalid") throw new Error("Windows Hello damaged binding did not fail closed.");
  expectHostError(await request("hello.verify", { bindingId, challengeBase64Url }), "hello-record-invalid", "hello.verify(damaged)");
  await unlink(recordPath);
  const revoked = expectHostSuccess(await request("hello.revoke", { bindingId, confirmed: true }), "hello.revoke(missing)");
  if (revoked.revoked !== true || revoked.bindingId !== bindingId) throw new Error("Windows Hello missing-binding revoke is not idempotent.");

  console.log(`WINDOWS_HELLO_SAFE_PROBE ${JSON.stringify({ supported: initial.supported, available: initial.available, reason: initial.reason, damagedBindingRejected: true, promptFree: true })}`);
} finally {
  await removeIsolatedWindowsHelloRoot(root);
}

