import QRCode from "qrcode";

export async function createQrDataUrl(content: string): Promise<string> {
  if (!content.trim()) throw new Error("二维码内容为空。");
  return QRCode.toDataURL(content, { width: 240, margin: 2, errorCorrectionLevel: "M", color: { dark: "#111111ff", light: "#ffffffff" } });
}

export const createOtpQrDataUrl = createQrDataUrl;

export async function decodeOtpQrImage(file: Blob): Promise<string> {
  const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (!Detector) throw new Error("当前 Chromium 版本不支持图片二维码识别，请粘贴 OTP URI。");
  const detector = new Detector({ formats: ["qr_code"] });
  const bitmap = await createImageBitmap(file);
  try {
    const values = await detector.detect(bitmap);
    const content = values.find((value) => value.rawValue.trim())?.rawValue.trim();
    if (!content) throw new Error("图片中没有识别到 OTP 二维码。");
    return content;
  } finally { bitmap.close(); }
}

interface BarcodeDetectorConstructor { new(options?: { formats?: string[] }): { detect(source: ImageBitmap): Promise<Array<{ rawValue: string }>> }; }
