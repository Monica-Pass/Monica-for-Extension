/**
 * Keep numeric lexemes at the JSON boundary. These native raw values are confined
 * to provider records; UI/vault models carry exact counters as decimal strings.
 * No marker key is reserved in user JSON. Node 22 / Edge 123+ implement this API.
 */
interface RawJson { readonly rawJSON: string }
const nativeJson = JSON as typeof JSON & {
  rawJSON?: (text: string) => RawJson;
  isRawJSON?: (value: unknown) => value is RawJson;
};

export function parseLosslessJson(text: string): unknown {
  if (!nativeJson.rawJSON || !nativeJson.isRawJSON) throw new Error("此浏览器不支持无损 JSON 读取，请升级浏览器。");
  try { return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    const source = context?.source;
    if (!source) throw new Error("此浏览器不能保留 JSON 数字精度。");
    if (/^-?(?:0|[1-9]\d*)$/.test(source) && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
    return nativeJson.rawJSON!(source);
  }); } catch (error) {
    // Native SyntaxErrors can quote decrypted passwords/tokens from the input.
    // Preserve feature-support failures but never propagate source snippets.
    // eslint-disable-next-line preserve-caught-error -- the original SyntaxError message can quote decrypted secrets; attaching it as cause would defeat the redaction
    if (error instanceof SyntaxError) throw new SyntaxError('JSON 数据无效。');
    throw error;
  }
}

export function jsonScalarText(value: unknown): string {
  if (nativeJson.isRawJSON?.(value)) return value.rawJSON;
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function jsonNumber(text: string): number | RawJson {
  if (!/^-?(?:0|[1-9]\d*)$/.test(text)) throw new Error("无效的 JSON 整数。");
  const number = Number(text);
  if (Number.isSafeInteger(number)) return number;
  if (!nativeJson.rawJSON) throw new Error("此浏览器不支持无损 JSON 写入。");
  return nativeJson.rawJSON(text);
}

/** Unlike structuredClone, JSON roundtripping preserves native raw-number values. */
export function cloneLosslessJson<T>(value: T): T {
  return parseLosslessJson(JSON.stringify(value)) as T;
}
