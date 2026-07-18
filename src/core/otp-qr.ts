import QRCode from "qrcode";

export async function createOtpQrDataUrl(uri: string): Promise<string> {
  if (!uri.trim()) throw new Error("OTP URI 为空。");
  return QRCode.toDataURL(uri, { width: 240, margin: 2, errorCorrectionLevel: "M", color: { dark: "#111111ff", light: "#ffffffff" } });
}

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
