import { bitmapIconDataUrl, KEEPASS_CUSTOM_ICON_TYPE, MAX_ICON_BYTES } from '../core/bitmap-icon';
import { brandIconPath, normalizeEmojiIcon } from '../core/custom-icon';
import { bytesToBase64 } from '../security/encoding';

function canvasIcon(): HTMLCanvasElement { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128; return canvas; }
async function rasterize(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 8192 || bitmap.height > 8192) throw new Error('图片尺寸过大，请选择较小的图片。');
    const canvas = canvasIcon();
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法读取图片。');
    const ratio = Math.min(128 / bitmap.width, 128 / bitmap.height);
    const width = bitmap.width * ratio, height = bitmap.height * ratio;
    context.drawImage(bitmap, (128 - width) / 2, (128 - height) / 2, width, height);
    return canvas.toDataURL('image/png').split(',')[1];
  } finally { bitmap.close(); }
}
export async function uploadedKeePassIcon(file: File): Promise<string> {
  if (file.size > MAX_ICON_BYTES) throw new Error('请选择不超过 2 MB 的图片。');
  const raw = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  if (!bitmapIconDataUrl(raw)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  return rasterize(file);
}
export async function nativeKeePassIcon(item: {customIconType?: string; customIconValue?: string}): Promise<{customIconType?: string; customIconValue?: string}> {
  if (item.customIconType === 'SIMPLE_ICON') {
    const path = brandIconPath(item.customIconValue);
    if (!path) throw new Error('图标不存在，请重新选择。');
    const response = await fetch(new URL(path, document.baseURI));
    if (!response.ok) throw new Error('无法读取图标，请重新选择。');
    return {customIconType:KEEPASS_CUSTOM_ICON_TYPE, customIconValue:await rasterize(await response.blob())};
  }
  if (item.customIconType === 'EMOJI') {
    const emoji = normalizeEmojiIcon(item.customIconValue);
    if (!emoji) throw new Error('请输入一个有效的 Emoji');
    const canvas = canvasIcon(); const context = canvas.getContext('2d');
    if (!context) throw new Error('无法生成图标。');
    context.font = '88px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(emoji,64,68,120);
    return {customIconType:KEEPASS_CUSTOM_ICON_TYPE,customIconValue:canvas.toDataURL('image/png').split(',')[1]};
  }
  return {customIconType:item.customIconType,customIconValue:item.customIconValue};
}
