import { randomBytes, randomUUID } from "node:crypto";
import {
  expectHostSuccess,
  isolatedWindowsHelloRoot,
  removeIsolatedWindowsHelloRoot,
  requestWindowsHelloHost,
  windowsHelloHostExecutable
} from "./windows-hello-native-protocol.mjs";

const acknowledgement = "I_ACCEPT_WINDOWS_HELLO_PROMPTS";
if (process.env.MONICA_WINDOWS_HELLO_HARDWARE_ACCEPT !== acknowledgement) {
  throw new Error(`Set MONICA_WINDOWS_HELLO_HARDWARE_ACCEPT=${acknowledgement} to run interactive enrollment, verification, and revocation acceptance.`);
}

const executable = windowsHelloHostExecutable("debug");
const root = await isolatedWindowsHelloRoot("monica-windows-hello-hardware-");
const bindingId = randomUUID();
const request = (method, params, timeoutMs = 150_000) => requestWindowsHelloHost({ executable, localAppData: root, method, params, timeoutMs });
let enrolled = false;

try {
  const initial = expectHostSuccess(await request("hello.status", {}, 15_000), "hello.status");
  if (!initial.supported || !initial.available) throw new Error(`Windows Hello platform authenticator is unavailable: ${initial.reason}`);
  console.log("Windows Hello will display system enrollment and verification prompts for an isolated Monica test credential.");
  const enrollment = expectHostSuccess(await request("hello.enroll", { bindingId, displayName: "Monica Hardware Acceptance", confirmed: true }), "hello.enroll");
  enrolled = true;
  if (enrollment.bindingId !== bindingId || enrollment.verified !== true) throw new Error("Windows Hello enrollment response is inconsistent.");
  const ready = expectHostSuccess(await request("hello.status", { bindingId }, 15_000), "hello.status(ready)");
  if (!ready.enrolled || ready.reason !== "ready") throw new Error("Windows Hello credential is not ready after enrollment.");
  const verification = expectHostSuccess(await request("hello.verify", { bindingId, challengeBase64Url: randomBytes(32).toString("base64url") }), "hello.verify");
  if (!verification.verified || verification.bindingId !== bindingId) throw new Error("Windows Hello verification response is inconsistent.");
  const revoked = expectHostSuccess(await request("hello.revoke", { bindingId, confirmed: true }, 60_000), "hello.revoke");
  enrolled = false;
  if (!revoked.revoked) throw new Error("Windows Hello revocation failed.");
  const finalStatus = expectHostSuccess(await request("hello.status", { bindingId }, 15_000), "hello.status(final)");
  if (finalStatus.enrolled) throw new Error("Windows Hello credential remained enrolled after revocation.");
  console.log(`WINDOWS_HELLO_HARDWARE_ACCEPTANCE ${JSON.stringify({ enrolled: true, verified: true, revoked: true, rpId: enrollment.rpId })}`);
} finally {
  if (enrolled) {
    try { await request("hello.revoke", { bindingId, confirmed: true }, 60_000); }
    catch (error) { console.error(`Windows Hello cleanup failed for ${bindingId}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  await removeIsolatedWindowsHelloRoot(root);
}

