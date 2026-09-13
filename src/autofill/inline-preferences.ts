/** Presentation preference for this browser installation, never a provider/vault field. */
export const INLINE_AUTOFILL_ENABLED_KEY = "monica.autofill.inline.enabled";

export function inlineAutofillEnabled(value: unknown): boolean {
  return value !== false;
}

export async function readInlineAutofillEnabled(): Promise<boolean> {
  const saved = await chrome.storage.local.get(INLINE_AUTOFILL_ENABLED_KEY);
  return inlineAutofillEnabled(saved[INLINE_AUTOFILL_ENABLED_KEY]);
}

export async function setInlineAutofillEnabled(enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") throw new Error("Invalid inline autofill preference.");
  await chrome.storage.local.set({ [INLINE_AUTOFILL_ENABLED_KEY]: enabled });
}
