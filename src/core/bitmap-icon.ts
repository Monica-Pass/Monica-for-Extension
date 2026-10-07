import { base64ToBytes } from '../security/encoding';
export const KEEPASS_CUSTOM_ICON_TYPE = 'KEEPASS_CUSTOM_ICON';
export const MAX_ICON_BYTES = 2 * 1024 * 1024;
/** Only raster images may become a preview URL. Unknown KDBX bytes remain in the model. */
export function bitmapIconDataUrl(value: string | undefined): string | undefined {
  if (!value || value.length > Math.ceil(MAX_ICON_BYTES / 3) * 4) return undefined;
  try {
    const bytes = base64ToBytes(value);
    if (bytes.length > MAX_ICON_BYTES) return undefined;
    const ascii = (start: number, text: string) => [...text].every((char, offset) => bytes[start + offset] === char.charCodeAt(0));
    const mime = bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte) && ascii(12,'IHDR') ? 'image/png'
      : bytes.length >= 4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 ? 'image/jpeg'
      : bytes.length >= 12 && ascii(0,'RIFF') && ascii(8,'WEBP') ? 'image/webp' : undefined;
    return mime ? `data:${mime};base64,${value}` : undefined;
  } catch { return undefined; }
}
