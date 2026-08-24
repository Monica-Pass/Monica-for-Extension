import { bytesToBase64 } from "../security/encoding";

const MAX_BARCODE_PAYLOAD_LENGTH = 4_096;

export async function createCode128DataUrl(content: string): Promise<string> {
  if (!content.trim()) throw new Error("条码内容为空。");
  if (content.length > MAX_BARCODE_PAYLOAD_LENGTH) throw new Error("条码内容过长。");
  const { default: bwipjs } = await import("bwip-js");
  const svg = bwipjs.toSVG({
    bcid: "code128",
    text: content,
    scale: 3,
    height: 18,
    includetext: true,
    textxalign: "center",
    paddingwidth: 8,
    paddingheight: 6,
    backgroundcolor: "ffffff",
    barcolor: "111111",
    textcolor: "111111"
  });
  return `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(svg))}`;
}
