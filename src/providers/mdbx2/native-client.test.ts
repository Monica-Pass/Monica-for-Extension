import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MDBX2_CORE_REVISION,
  MDBX2_ENGINE_VERSION,
  MDBX2_FORMAT_VERSION,
  MDBX2_MAX_BINARY_CHUNK_BYTES,
  MDBX2_NATIVE_HOST_NAME,
  MDBX2_NATIVE_PROTOCOL_VERSION,
  MDBX2_SYNC_PROTOCOL_VERSION,
  Mdbx2NativeHostError,
  validateMdbx2HostCapabilities
} from "./native-contract";
import { Mdbx2NativeClient, type Mdbx2NativePort, type Mdbx2NativeRuntime } from "./native-client";

class FakeEvent<Listener extends (...args: never[]) => void> {
  readonly listeners = new Set<Listener>();
  addListener(listener: Listener): void { this.listeners.add(listener); }
  removeListener(listener: Listener): void { this.listeners.delete(listener); }
  emit(...args: Parameters<Listener>): void { for (const listener of this.listeners) listener(...args); }
}

class FakePort implements Mdbx2NativePort {
  readonly onMessage = new FakeEvent<(message: never) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly messages: unknown[] = [];
  disconnected = false;
  onPost?: (message: unknown) => void;

  postMessage(message: unknown): void {
    this.messages.push(message);
    this.onPost?.(message);
  }

  disconnect(): void { this.disconnected = true; }
}

class FakeRuntime implements Mdbx2NativeRuntime {
  lastError?: string;
  constructor(readonly port = new FakePort(), readonly connectError?: Error) {}
  connectNative(hostName: string): Mdbx2NativePort {
    expect(hostName).toBe(MDBX2_NATIVE_HOST_NAME);
    if (this.connectError) throw this.connectError;
    return this.port;
  }
  disconnectErrorMessage(): string | undefined { return this.lastError; }
}

const HELLO = {
  hostName: MDBX2_NATIVE_HOST_NAME,
  hostVersion: "0.1.0",
  protocolVersion: MDBX2_NATIVE_PROTOCOL_VERSION,
  mdbxCoreRevision: MDBX2_CORE_REVISION,
  mdbxEngineVersion: MDBX2_ENGINE_VERSION,
  mdbxFormatVersion: MDBX2_FORMAT_VERSION,
  supportsMdbx1: false,
  maxBinaryChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES,
  storageProfile: "full",
  syncProfile: "full",
  syncProtocolVersion: MDBX2_SYNC_PROTOCOL_VERSION,
  enabledStorageCapabilityIds: ["object-record-v2"],
  enabledSyncCapabilityIds: ["authenticated-state-delta-v8"]
} as const;

afterEach(() => vi.useRealTimers());

describe("MDBX2 Native Messaging client", () => {
  it("performs a pinned hello request and validates MDBX2-only capabilities", async () => {
    const runtime = new FakeRuntime();
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: HELLO
      } as never);
    };
    const client = new Mdbx2NativeClient(runtime, () => "request-1");

    await expect(client.hello()).resolves.toEqual(HELLO);
    expect(runtime.port.messages).toEqual([{
      protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
      requestId: "request-1",
      method: "host.hello",
      params: {}
    }]);
    client.close();
  });

  it("rejects a Host that claims MDBX1 support or a different chunk boundary", () => {
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, supportsMdbx1: true })).toThrowError(Mdbx2NativeHostError);
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, maxBinaryChunkBytes: 64 * 1024 })).toThrow("分块限制");
  });

  it("preserves stable Host error codes and retryability", async () => {
    const runtime = new FakeRuntime();
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: { code: "vault-locked", message: "Vault is locked.", retryable: true }
      } as never);
    };
    const client = new Mdbx2NativeClient(runtime, () => "request-2");

    await expect(client.hello()).rejects.toMatchObject({ code: "vault-locked", retryable: true });
    client.close();
  });

  it("bounds request time and closes the native port after a timeout", async () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    const client = new Mdbx2NativeClient(runtime, () => "request-3");
    const request = client.hello(100);
    const rejection = expect(request).rejects.toMatchObject({ code: "native-request-timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(101);

    await rejection;
    expect(runtime.port.disconnected).toBe(true);
  });

  it("reports a missing Host without exposing the browser error text", async () => {
    const runtime = new FakeRuntime(undefined, new Error("Specified native messaging host not found."));
    const client = new Mdbx2NativeClient(runtime, () => "request-4");

    await expect(client.probe()).resolves.toEqual({
      availability: "not-installed",
      hostName: MDBX2_NATIVE_HOST_NAME,
      message: "尚未安装 Monica MDBX2 Native Host。"
    });
  });
});
