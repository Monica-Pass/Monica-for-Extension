import {
  MDBX2_NATIVE_HOST_NAME,
  MDBX2_NATIVE_PROTOCOL_VERSION,
  Mdbx2NativeHostError,
  mdbx2NativeConnectionError,
  parseMdbx2NativeResponse,
  validateMdbx2HostCapabilities,
  type Mdbx2HostCapabilities,
  type Mdbx2HostStatus,
  type Mdbx2NativeMethod,
  type Mdbx2NativeRequest
} from "./native-contract";

interface NativeEvent<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export interface Mdbx2NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: NativeEvent<(message: never) => void>;
  onDisconnect: NativeEvent<() => void>;
}

export interface Mdbx2NativeRuntime {
  connectNative(hostName: string): Mdbx2NativePort;
  disconnectErrorMessage(): string | undefined;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class Mdbx2NativeClient {
  private port?: Mdbx2NativePort;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly runtime: Mdbx2NativeRuntime,
    private readonly createRequestId: () => string = () => crypto.randomUUID()
  ) {}

  async hello(timeoutMs = 5_000): Promise<Mdbx2HostCapabilities> {
    return validateMdbx2HostCapabilities(await this.request("host.hello", {}, timeoutMs));
  }

  async probe(timeoutMs = 5_000): Promise<Mdbx2HostStatus> {
    try {
      const capabilities = await this.hello(timeoutMs);
      return {
        availability: "ready",
        hostName: MDBX2_NATIVE_HOST_NAME,
        message: "Monica MDBX2 Native Host 已安装并通过版本检查。",
        capabilities
      };
    } catch (error) {
      const nativeError = error instanceof Mdbx2NativeHostError ? error : mdbx2NativeConnectionError(error);
      return {
        availability: nativeError.code === "native-host-not-installed"
          ? "not-installed"
          : nativeError.code === "native-host-incompatible" || nativeError.code === "native-host-forbidden"
            ? "incompatible"
            : "unavailable",
        hostName: MDBX2_NATIVE_HOST_NAME,
        message: nativeError.message
      };
    } finally {
      this.close();
    }
  }

  async request(method: Mdbx2NativeMethod, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 5 * 60_000) {
      throw new Mdbx2NativeHostError("native-timeout-invalid", "Native Host 请求超时设置无效。", false);
    }
    const port = this.ensurePort();
    const requestId = this.createRequestId();
    const request: Mdbx2NativeRequest = { protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId, method, params };
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Mdbx2NativeHostError("native-request-timeout", "Native Host 请求超时。", true));
        this.close();
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeoutId });
      try {
        port.postMessage(request);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(requestId);
        reject(mdbx2NativeConnectionError(error));
        this.close();
      }
    });
  }

  close(): void {
    const port = this.port;
    this.port = undefined;
    if (port) {
      port.onMessage.removeListener(this.onMessage);
      port.onDisconnect.removeListener(this.onDisconnect);
      try { port.disconnect(); } catch { /* Port may already be closed. */ }
    }
    this.rejectPending(new Mdbx2NativeHostError("native-host-closed", "Native Host 会话已关闭。", true));
  }

  private ensurePort(): Mdbx2NativePort {
    if (this.port) return this.port;
    try {
      const port = this.runtime.connectNative(MDBX2_NATIVE_HOST_NAME);
      port.onMessage.addListener(this.onMessage);
      port.onDisconnect.addListener(this.onDisconnect);
      this.port = port;
      return port;
    } catch (error) {
      throw mdbx2NativeConnectionError(error);
    }
  }

  private readonly onMessage = (message: never): void => {
    let response;
    try {
      response = parseMdbx2NativeResponse(message);
    } catch (error) {
      this.rejectPending(error instanceof Error ? error : new Error("Native Host 响应无效。"));
      this.close();
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timeoutId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Mdbx2NativeHostError(response.error.code, response.error.message, response.error.retryable));
  };

  private readonly onDisconnect = (): void => {
    const message = this.runtime.disconnectErrorMessage();
    const port = this.port;
    this.port = undefined;
    if (port) {
      port.onMessage.removeListener(this.onMessage);
      port.onDisconnect.removeListener(this.onDisconnect);
    }
    this.rejectPending(mdbx2NativeConnectionError(message || "Native Host 连接已断开。"));
  };

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createChromeMdbx2NativeRuntime(): Mdbx2NativeRuntime {
  return {
    connectNative: (hostName) => chrome.runtime.connectNative(hostName) as unknown as Mdbx2NativePort,
    disconnectErrorMessage: () => chrome.runtime.lastError?.message
  };
}
