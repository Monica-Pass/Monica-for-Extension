import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const WINDOWS_HELLO_PROTOCOL = 2;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function windowsHelloHostExecutable(profile = "debug") {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return path.resolve("native", "mdbx2-host", "target", profile, `monica-mdbx2-host${suffix}`);
}

export async function isolatedWindowsHelloRoot(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeIsolatedWindowsHelloRoot(root) {
  if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("Refusing to remove a non-temporary Windows Hello probe directory.");
  await rm(root, { recursive: true, force: true });
}

export async function requestWindowsHelloHost({ executable, localAppData, method, params, timeoutMs = 15_000 }) {
  const requestId = `hello-${randomUUID()}`;
  const body = Buffer.from(JSON.stringify({ protocol: WINDOWS_HELLO_PROTOCOL, requestId, method, params }), "utf8");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      env: { ...process.env, LOCALAPPDATA: localAppData, APPDATA: localAppData },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Windows Hello Host request timed out: ${method}`));
    }, timeoutMs);
    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RESPONSE_BYTES) {
        child.kill();
        finish(new Error("Windows Hello Host response exceeded the reviewed limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.reduce((total, item) => total + item.length, 0) < 16 * 1024) stderr.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      const output = Buffer.concat(stdout);
      if (code !== 0) return finish(new Error(`Windows Hello Host exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      if (output.length < 4) return finish(new Error("Windows Hello Host returned a truncated frame."));
      const length = output.readUInt32LE(0);
      if (length < 2 || length > MAX_RESPONSE_BYTES || output.length !== length + 4) return finish(new Error("Windows Hello Host returned an invalid frame boundary."));
      let response;
      try { response = JSON.parse(output.subarray(4).toString("utf8")); }
      catch { return finish(new Error("Windows Hello Host returned invalid JSON.")); }
      if (response.protocol !== WINDOWS_HELLO_PROTOCOL || response.requestId !== requestId || typeof response.ok !== "boolean") {
        return finish(new Error("Windows Hello Host returned an incompatible response envelope."));
      }
      finish(undefined, response);
    });
    child.stdin.end(frame);
  });
}

export function expectHostSuccess(response, method) {
  if (!response?.ok || !response.result || response.error) throw new Error(`${method} failed: ${response?.error?.code || "invalid-response"} ${response?.error?.message || ""}`.trim());
  return response.result;
}

export function expectHostError(response, expectedCode, method) {
  if (response?.ok || response?.error?.code !== expectedCode || response.result !== undefined) {
    throw new Error(`${method} did not fail with ${expectedCode}.`);
  }
  return response.error;
}

