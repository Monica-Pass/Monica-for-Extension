/** All webpage prompts use the bundled, original Monica artwork. */
export function createMonicaLogo(rootDocument: Document, size = 44): HTMLImageElement {
  const logo = rootDocument.createElement("img");
  logo.className = "brand-logo";
  logo.src = chrome.runtime.getURL("icons/logo-256.png");
  logo.alt = "";
  logo.width = logo.height = size;
  return logo;
}
