import { fillCredential, scanPage, type FillCredentialInput } from "./dom";

chrome.runtime.onMessage.addListener((message: { type?: string; credential?: FillCredentialInput }, _sender, sendResponse) => {
  if (message?.type === "MONICA_SCAN_PAGE") {
    sendResponse(scanPage());
    return false;
  }
  if (message?.type === "MONICA_FILL_CREDENTIAL") {
    sendResponse(fillCredential(message.credential || {}));
    return false;
  }
  return false;
});
