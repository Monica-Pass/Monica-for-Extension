/** A stream read failed after response headers were received. */
export class ProviderBodyReadNetworkError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Provider response body read failed.");
    this.name = "ProviderBodyReadNetworkError";
    this.cause = cause;
  }
}

export async function readBoundedResponseBytes(response: Response, maximum: number, label: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error(`${label}安全上限无效。`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`${label}超过安全上限。`);
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw new Error(`${label}超过安全上限。`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (cause) {
        // Keep a stream interruption distinct from a consumer's validation or
        // parsing error so the transport can safely apply its retry policy.
        if (signal?.aborted) throw cause;
        throw new ProviderBodyReadNetworkError(cause);
      }
      const { done, value } = result;
      if (done) break;
      total += value.length;
      if (!Number.isSafeInteger(total) || total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label}超过安全上限。`);
      }
      chunks.push(value);
    }
    if (signal?.aborted) throw signal.reason || new DOMException("Response body read aborted", "AbortError");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function readBoundedResponseText(response: Response, maximum: number, label: string, signal?: AbortSignal): Promise<string> {
  return new TextDecoder().decode(await readBoundedResponseBytes(response, maximum, label, signal));
}

export async function readBoundedJsonObject(response: Response, maximum: number, label: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const text = await readBoundedResponseText(response, maximum, label, signal);
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
