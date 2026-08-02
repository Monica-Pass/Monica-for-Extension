import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Mdbx2NativePort, Mdbx2NativeRuntime } from "../../src/providers/mdbx2/native-client";
import { MDBX2_NATIVE_HOST_NAME } from "../../src/providers/mdbx2/native-contract";

const COMMAND_OUTPUT_LIMIT = 128 * 1024 * 1024;
const FIXTURE_PACKAGE = "takagi.ru.monica.mdbx.engine.test";
const FIXTURE_RUNNER = `${FIXTURE_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`;
const FIXTURE_ROOT = "files/mdbx2-extension-interop";

export interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Uint8Array;
  timeoutMs?: number;
  windowsHide?: boolean;
  shell?: boolean;
}

export async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      windowsHide: options.windowsHide ?? true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > COMMAND_OUTPUT_LIMIT) {
        child.kill();
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > COMMAND_OUTPUT_LIMIT) {
        child.kill();
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: exitCode ?? -1 };
      if (outputBytes > COMMAND_OUTPUT_LIMIT) {
        reject(new Error(`Command output exceeded ${COMMAND_OUTPUT_LIMIT} bytes: ${command}`));
        return;
      }
      if (result.exitCode !== 0) {
        reject(new Error(
          `Command failed (${result.exitCode}): ${command} ${args.join(" ")}\n${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`
        ));
        return;
      }
      resolvePromise(result);
    });
    if (options.input) child.stdin.end(Buffer.from(options.input));
    else child.stdin.end();
  });
}

export async function runText(command: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return (await runCommand(command, args, options)).stdout.toString("utf8").trim();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface AndroidEnvironment {
  adb: string;
  emulator: string;
  serial: string;
  startedEmulator: boolean;
}

export async function buildInjectedAndroidTest(extensionRoot: string, androidRepository: string): Promise<string> {
  const androidProject = join(androidRepository, "Monica for Android");
  const gradlew = join(androidProject, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const initScript = join(extensionRoot, "tests", "interop", "android-mdbx2", "interop.init.gradle");
  const sourceDirectory = join(extensionRoot, "tests", "interop", "android-mdbx2", "src");
  if (!existsSync(gradlew) || !existsSync(initScript) || !existsSync(sourceDirectory)) {
    throw new Error("Android MDBX2 interoperability build inputs are missing.");
  }
  const before = await runText("git", ["status", "--porcelain=v1", "-uall"], { cwd: androidRepository });
  const gradleArgs = [
    "-I",
    initScript,
    ":mdbx-engine:assembleDebugAndroidTest",
    "--no-daemon",
    "--console=plain"
  ];
  await runCommand(process.platform === "win32" ? ".\\gradlew.bat" : gradlew, gradleArgs, {
    cwd: androidProject,
    env: { ...process.env, MONICA_MDBX2_INTEROP_SOURCE_DIR: sourceDirectory },
    timeoutMs: 10 * 60_000,
    shell: process.platform === "win32"
  });
  const after = await runText("git", ["status", "--porcelain=v1", "-uall"], { cwd: androidRepository });
  if (after !== before) throw new Error("Android repository state changed while compiling the injected MDBX2 fixture.");
  const apk = join(androidProject, "mdbx-engine", "build", "outputs", "apk", "androidTest", "debug", "mdbx-engine-debug-androidTest.apk");
  if (!existsSync(apk)) throw new Error("Injected Android MDBX2 instrumentation APK was not produced.");
  return apk;
}

export async function ensureAndroidEnvironment(androidRepository: string): Promise<AndroidEnvironment> {
  if (process.platform !== "win32") throw new Error("The current Android MDBX2 interoperability runner is Windows-only.");
  const androidProject = join(androidRepository, "Monica for Android");
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || readAndroidSdkFromLocalProperties(androidProject);
  const adb = join(sdkRoot, "platform-tools", "adb.exe");
  const primaryEmulator = join(sdkRoot, "emulator", "emulator.exe");
  const fallbackEmulator = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Android", "Sdk", "emulator", "emulator.exe")
    : primaryEmulator;
  const emulator = existsSync(primaryEmulator) ? primaryEmulator : fallbackEmulator;
  if (!existsSync(adb) || !existsSync(emulator)) throw new Error("Android adb or emulator executable is unavailable.");
  await runText(adb, ["start-server"], { timeoutMs: 30_000 });
  const existing = await connectedDevices(adb);
  const requestedSerial = process.env.MONICA_MDBX2_INTEROP_SERIAL?.trim();
  if (requestedSerial) {
    if (!existing.includes(requestedSerial)) throw new Error(`Requested Android device is unavailable: ${requestedSerial}`);
    await waitForBoot(adb, requestedSerial);
    return { adb, emulator, serial: requestedSerial, startedEmulator: false };
  }

  const avd = process.env.MONICA_MDBX2_INTEROP_AVD || "Pixel_Fold_API_35";
  const availableAvds = (await runText(emulator, ["-list-avds"], { timeoutMs: 30_000 })).split(/\r?\n/).filter(Boolean);
  if (!availableAvds.includes(avd)) throw new Error(`Android AVD ${avd} is unavailable.`);
  const configuredPort = process.env.MONICA_MDBX2_INTEROP_EMULATOR_PORT?.trim();
  const port = configuredPort || [5580, 5582, 5584, 5586, 5588]
    .map(String)
    .find((candidate) => !existing.includes(`emulator-${candidate}`));
  const portNumber = Number(port);
  if (!port || !Number.isInteger(portNumber) || portNumber < 5554 || portNumber > 5682 || portNumber % 2 !== 0) {
    throw new Error("No reviewed Android emulator port is available.");
  }
  const serial = `emulator-${port}`;
  const child = spawn(emulator, [
    "-avd", avd,
    "-port", port,
    "-read-only",
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-no-snapshot-load",
    "-no-snapshot-save",
    "-gpu", "swiftshader_indirect"
  ], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
  try {
    await waitForDevice(adb, serial);
    await waitForBoot(adb, serial);
  } catch (error) {
    await runCommand(adb, ["-s", serial, "emu", "kill"], { timeoutMs: 30_000 }).catch(() => undefined);
    throw error;
  }
  return { adb, emulator, serial, startedEmulator: true };
}

export async function stopAndroidEnvironment(environment: AndroidEnvironment): Promise<void> {
  if (!environment.startedEmulator) return;
  await runCommand(environment.adb, ["-s", environment.serial, "emu", "kill"], { timeoutMs: 30_000 }).catch(() => undefined);
}

export async function installAndroidFixture(environment: AndroidEnvironment, apk: string): Promise<void> {
  await runCommand(environment.adb, ["-s", environment.serial, "install", "-r", "-t", apk], { timeoutMs: 180_000 });
}

export async function clearAndroidFixture(environment: AndroidEnvironment): Promise<void> {
  await runCommand(environment.adb, ["-s", environment.serial, "shell", "pm", "clear", FIXTURE_PACKAGE], { timeoutMs: 30_000 });
}

export async function runAndroidFixtureMethod(environment: AndroidEnvironment, method: string): Promise<string> {
  const testName = `takagi.ru.monica.mdbx.engine.Mdbx2ExtensionInteropTest#${method}`;
  const output = await runText(environment.adb, [
    "-s", environment.serial,
    "shell", "am", "instrument", "-w", "-r",
    "-e", "class", testName,
    FIXTURE_RUNNER
  ], { timeoutMs: 10 * 60_000 });
  if (!/OK \(1 test\)/.test(output) || /FAILURES|INSTRUMENTATION_FAILED|Process crashed/i.test(output)) {
    throw new Error(`Android MDBX2 instrumentation failed:\n${output}`);
  }
  return output;
}

export async function pullAndroidFixtureFile(
  environment: AndroidEnvironment,
  relativePath: string,
  localPath: string
): Promise<void> {
  const remotePath = safeFixturePath(relativePath);
  const result = await runCommand(environment.adb, [
    "-s", environment.serial,
    "exec-out", "run-as", FIXTURE_PACKAGE, "cat", remotePath
  ], { timeoutMs: 120_000 });
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, result.stdout);
}

export async function pullAndroidFixtureTree(
  environment: AndroidEnvironment,
  relativeRoot: string,
  localRoot: string
): Promise<void> {
  const remoteRoot = safeFixturePath(relativeRoot);
  const output = await runText(environment.adb, [
    "-s", environment.serial,
    "shell", "run-as", FIXTURE_PACKAGE, "find", remoteRoot, "-type", "f"
  ], { timeoutMs: 60_000 });
  const paths = output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (!paths.length) throw new Error(`Android fixture tree is empty: ${relativeRoot}`);
  for (const remotePath of paths) {
    if (!remotePath.startsWith(`${remoteRoot}/`) && remotePath !== remoteRoot) throw new Error("Android fixture find escaped its root.");
    const suffix = remotePath === remoteRoot ? remotePath.split("/").at(-1)! : remotePath.slice(remoteRoot.length + 1);
    await pullAndroidFixtureFile(environment, remotePath.slice(`${FIXTURE_ROOT}/`.length), join(localRoot, ...suffix.split("/")));
  }
}

export async function pushAndroidFixtureFile(
  environment: AndroidEnvironment,
  relativePath: string,
  bytes: Uint8Array
): Promise<void> {
  const remotePath = safeFixturePath(relativePath);
  const packageRoot = (await runText(environment.adb, [
    "-s", environment.serial,
    "shell", "run-as", FIXTURE_PACKAGE, "pwd"
  ], { timeoutMs: 30_000 })).replace(/\\/g, "/").replace(/\/$/, "");
  if (!packageRoot.startsWith("/data/")) throw new Error(`Unexpected Android package root: ${packageRoot}`);
  const target = `${packageRoot}/${remotePath}`;
  const parent = target.slice(0, target.lastIndexOf("/"));
  const localRoot = await mkdtemp(join(tmpdir(), "monica-mdbx2-push-"));
  const localFile = join(localRoot, "payload.bin");
  const staging = `/data/local/tmp/monica-mdbx2-${randomUUID()}.bin`;
  try {
    await writeFile(localFile, bytes);
    await runCommand(environment.adb, ["-s", environment.serial, "push", localFile, staging], { timeoutMs: 120_000 });
    await runCommand(environment.adb, [
      "-s", environment.serial,
      "shell", "run-as", FIXTURE_PACKAGE, "mkdir", "-p", parent
    ], { timeoutMs: 30_000 });
    await runCommand(environment.adb, [
      "-s", environment.serial,
      "shell", "run-as", FIXTURE_PACKAGE, "cp", staging, target
    ], { timeoutMs: 120_000 });
  } finally {
    await runCommand(environment.adb, ["-s", environment.serial, "shell", "rm", "-f", staging], { timeoutMs: 30_000 }).catch(() => undefined);
    await rm(localRoot, { recursive: true, force: true });
  }
}

function safeFixturePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((component) => !component || component === "." || component === ".." || !/^[A-Za-z0-9._-]+$/.test(component))) {
    throw new Error(`Unsafe Android fixture path: ${relativePath}`);
  }
  return normalized.startsWith(`${FIXTURE_ROOT}/`) || normalized === FIXTURE_ROOT
    ? normalized
    : `${FIXTURE_ROOT}/${normalized}`;
}

function readAndroidSdkFromLocalProperties(androidProject: string): string {
  const propertiesPath = join(androidProject, "local.properties");
  if (!existsSync(propertiesPath)) throw new Error("Android SDK location is unavailable.");
  const text = requireTextFile(propertiesPath);
  const match = text.match(/^sdk\.dir=(.+)$/m);
  if (!match) throw new Error("Android local.properties has no sdk.dir.");
  return match[1].replace(/\\:/g, ":").replace(/\\\\/g, "\\").trim();
}

function requireTextFile(path: string): string {
  return Buffer.from(requireBinaryFile(path)).toString("utf8");
}

function requireBinaryFile(path: string): Uint8Array {
  return readFileSync(path);
}

async function connectedDevices(adb: string): Promise<string[]> {
  const output = await runText(adb, ["devices"], { timeoutMs: 30_000 });
  return output.split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0]);
}

async function waitForDevice(adb: string, serial: string): Promise<void> {
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    const devices = await connectedDevices(adb).catch((): string[] => []);
    if (devices.includes(serial)) return;
    await delay(2_000);
  }
  throw new Error(`Android emulator ${serial} did not connect.`);
}

async function waitForBoot(adb: string, serial: string): Promise<void> {
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const booted = await runText(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 15_000 }).catch(() => "");
    if (booted.trim() === "1") {
      await runCommand(adb, ["-s", serial, "shell", "input", "keyevent", "82"], { timeoutMs: 15_000 }).catch(() => undefined);
      return;
    }
    await delay(2_000);
  }
  throw new Error(`Android emulator ${serial} did not finish booting.`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

interface RemoteEntry {
  directory: boolean;
  bytes?: Buffer;
  version: number;
}

export interface WebDavRequestLog {
  method: string;
  path: string;
  ifNoneMatch?: string;
  ifMatch?: string;
}

export class LocalWebDavServer {
  private readonly entries = new Map<string, RemoteEntry>([["", { directory: true, version: 1 }]]);
  readonly requests: WebDavRequestLog[] = [];
  private server?: Server;
  private baseUrlValue = "";

  constructor(
    readonly username: string,
    readonly password: string
  ) {}

  get baseUrl(): string {
    if (!this.baseUrlValue) throw new Error("WebDAV server has not started.");
    return this.baseUrlValue;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolvePromise, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("WebDAV server did not expose a TCP address.");
    this.baseUrlValue = `http://127.0.0.1:${address.port}/dav`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  }

  async loadDirectory(localRoot: string): Promise<void> {
    await this.loadDirectoryRecursive(localRoot, "");
  }

  filePaths(): string[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => !entry.directory)
      .map(([path]) => path)
      .sort();
  }

  file(path: string): Buffer {
    const entry = this.entries.get(normalizeRemotePath(path));
    if (!entry?.bytes || entry.directory) throw new Error(`Remote file is unavailable: ${path}`);
    return Buffer.from(entry.bytes);
  }

  version(path: string): number {
    const entry = this.entries.get(normalizeRemotePath(path));
    if (!entry) throw new Error(`Remote object is unavailable: ${path}`);
    return entry.version;
  }

  private async loadDirectoryRecursive(localRoot: string, prefix: string): Promise<void> {
    for (const item of await readdir(join(localRoot, prefix), { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        this.ensureDirectory(relativePath);
        await this.loadDirectoryRecursive(localRoot, relativePath);
      } else if (item.isFile()) {
        this.addFile(relativePath, await readFile(join(localRoot, ...relativePath.split("/"))));
      }
    }
  }

  private addFile(path: string, bytes: Uint8Array): void {
    const normalized = normalizeRemotePath(path);
    this.ensureDirectory(parentRemotePath(normalized));
    const existing = this.entries.get(normalized);
    if (existing) {
      if (existing.directory || !existing.bytes?.equals(Buffer.from(bytes))) throw new Error(`Immutable fixture collision: ${normalized}`);
      return;
    }
    this.entries.set(normalized, { directory: false, bytes: Buffer.from(bytes), version: 1 });
  }

  private ensureDirectory(path: string): void {
    const normalized = path ? normalizeRemotePath(path) : "";
    let current = "";
    for (const component of normalized.split("/").filter(Boolean)) {
      current = current ? `${current}/${component}` : component;
      const existing = this.entries.get(current);
      if (existing && !existing.directory) throw new Error(`Remote directory is occupied by a file: ${current}`);
      if (!existing) this.entries.set(current, { directory: true, version: 1 });
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const expectedAuthorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401, { "WWW-Authenticate": "Basic realm=Monica MDBX2" });
        response.end();
        return;
      }
      const method = (request.method || "GET").toUpperCase();
      const path = requestPath(request.url || "/");
      this.requests.push({
        method,
        path,
        ifNoneMatch: headerValue(request.headers["if-none-match"]),
        ifMatch: headerValue(request.headers["if-match"])
      });
      if (method === "PROPFIND") {
        this.respondPropfind(response, path, headerValue(request.headers.depth) || "0");
        return;
      }
      if (method === "MKCOL") {
        if (this.entries.has(path)) {
          response.writeHead(405);
          response.end();
          return;
        }
        const parent = parentRemotePath(path);
        if (!this.entries.get(parent)?.directory) {
          response.writeHead(409);
          response.end();
          return;
        }
        this.entries.set(path, { directory: true, version: 1 });
        response.writeHead(201);
        response.end();
        return;
      }
      if (method === "GET") {
        const entry = this.entries.get(path);
        if (!entry?.bytes || entry.directory) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": entry.bytes.length,
          ETag: etag(entry),
          "Last-Modified": new Date(0).toUTCString()
        });
        response.end(entry.bytes);
        return;
      }
      if (method === "PUT") {
        const parent = parentRemotePath(path);
        if (!this.entries.get(parent)?.directory) {
          response.writeHead(409);
          response.end();
          return;
        }
        const existing = this.entries.get(path);
        const ifNoneMatch = headerValue(request.headers["if-none-match"]);
        const ifMatch = headerValue(request.headers["if-match"]);
        if (ifNoneMatch === "*" && existing) {
          response.writeHead(412);
          response.end();
          return;
        }
        if (ifMatch && (!existing || ifMatch !== etag(existing))) {
          response.writeHead(412);
          response.end();
          return;
        }
        const bytes = await readRequestBody(request);
        if (!bytes.length) {
          response.writeHead(400);
          response.end();
          return;
        }
        const version = (existing?.version || 0) + 1;
        this.entries.set(path, { directory: false, bytes, version });
        response.writeHead(existing ? 204 : 201, { ETag: `"v${version}"` });
        response.end();
        return;
      }
      response.writeHead(405);
      response.end();
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  }

  private respondPropfind(response: ServerResponse, path: string, depth: string): void {
    const entry = this.entries.get(path);
    if (!entry) {
      response.writeHead(404);
      response.end();
      return;
    }
    const paths = [path];
    if (depth === "1") {
      const prefix = path ? `${path}/` : "";
      for (const candidate of this.entries.keys()) {
        if (candidate !== path && candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/")) paths.push(candidate);
      }
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${paths.sort().map((candidate) => this.xmlEntry(candidate)).join("")}</d:multistatus>`;
    response.writeHead(207, { "Content-Type": "application/xml; charset=utf-8", "Content-Length": Buffer.byteLength(xml) });
    response.end(xml);
  }

  private xmlEntry(path: string): string {
    const entry = this.entries.get(path)!;
    const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const href = `/dav${encoded ? `/${encoded}` : ""}${entry.directory ? "/" : ""}`;
    return `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop><d:resourcetype>${entry.directory ? "<d:collection/>" : ""}</d:resourcetype>${entry.directory ? "" : `<d:getcontentlength>${entry.bytes?.length || 0}</d:getcontentlength>`}<d:getetag>${escapeXml(etag(entry))}</d:getetag><d:getlastmodified>${new Date(0).toUTCString()}</d:getlastmodified></d:prop></d:propstat></d:response>`;
  }
}

function requestPath(value: string): string {
  const url = new URL(value, "http://127.0.0.1");
  if (url.pathname === "/dav" || url.pathname === "/dav/") return "";
  if (!url.pathname.startsWith("/dav/")) throw new Error("WebDAV request escaped the fixture root.");
  const components = url.pathname.slice("/dav/".length).replace(/\/$/, "").split("/").filter(Boolean).map((component) => {
    const decoded = decodeURIComponent(component);
    if (!/^[A-Za-z0-9._-]+$/.test(decoded)) throw new Error("WebDAV request contains an unsafe component.");
    return decoded;
  });
  return normalizeRemotePath(components.join("/"));
}

function normalizeRemotePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (normalized && normalized.split("/").some((component) => !component || component === "." || component === "..")) {
    throw new Error(`Unsafe remote path: ${path}`);
  }
  return normalized;
}

function parentRemotePath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function etag(entry: RemoteEntry): string {
  return `"v${entry.version}"`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Buffer);
    total += bytes.length;
    if (total > COMMAND_OUTPUT_LIMIT) throw new Error("WebDAV upload exceeds the fixture limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

type MessageListener = (message: never) => void;
type DisconnectListener = () => void;

class NativeEvent<Listener extends (...args: never[]) => void> {
  private readonly listeners = new Set<Listener>();

  addListener(listener: Listener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: Listener): void {
    this.listeners.delete(listener);
  }

  emit(...args: Parameters<Listener>): void {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

class ProcessNativePort implements Mdbx2NativePort {
  readonly onMessage = new NativeEvent<MessageListener>();
  readonly onDisconnect = new NativeEvent<DisconnectListener>();
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private disconnected = false;
  private stderr = "";

  constructor(executable: string, localAppData: string, onFailure: (message: string) => void) {
    this.child = spawn(executable, [], {
      env: { ...process.env, LOCALAPPDATA: localAppData, APPDATA: localAppData },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(Buffer.from(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
    this.child.once("error", (error) => {
      onFailure(error.message);
      this.signalDisconnect();
    });
    this.child.once("close", (code) => {
      if (!this.disconnected) onFailure(this.stderr.trim() || `Native Host exited with code ${code ?? -1}.`);
      this.signalDisconnect();
    });
  }

  postMessage(message: unknown): void {
    if (this.disconnected) throw new Error("Native Host process is closed.");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    this.child.stdin.write(frame);
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.child.stdin.end();
    this.child.kill();
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > 900 * 1024) {
        this.stderr += "Invalid Native Host frame length.";
        this.disconnect();
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let value: unknown;
      try {
        value = JSON.parse(body.toString("utf8"));
      } catch {
        this.stderr += "Invalid Native Host response JSON.";
        this.disconnect();
        return;
      }
      this.onMessage.emit(value as never);
    }
  }

  private signalDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  }
}

export class ProcessNativeRuntime implements Mdbx2NativeRuntime {
  private lastError?: string;

  constructor(
    private readonly executable: string,
    private readonly localAppData: string
  ) {}

  connectNative(hostName: string): Mdbx2NativePort {
    if (hostName !== MDBX2_NATIVE_HOST_NAME) throw new Error(`Unexpected Native Host name: ${hostName}`);
    this.lastError = undefined;
    return new ProcessNativePort(this.executable, this.localAppData, (message) => { this.lastError = message; });
  }

  disconnectErrorMessage(): string | undefined {
    return this.lastError;
  }
}
