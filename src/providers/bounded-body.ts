export async function readBoundedResponseBytes(response: Response, maximum: number, label: string): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error(`${label}安全上限无效。`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${label}超过安全上限。`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw new Error(`${label}超过安全上限。`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (!Number.isSafeInteger(total) || total > maximum) {
        await reader.cancel();
        throw new Error(`${label}超过安全上限。`);
      }
      chunks.push(value);
    }
  } finally {
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

export async function readBoundedResponseText(response: Response, maximum: number, label: string): Promise<string> {
  return new TextDecoder().decode(await readBoundedResponseBytes(response, maximum, label));
}

export async function readBoundedJsonObject(response: Response, maximum: number, label: string): Promise<Record<string, unknown>> {
  const text = await readBoundedResponseText(response, maximum, label);
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
