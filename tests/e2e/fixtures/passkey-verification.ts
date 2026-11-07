import type { BrowserContext } from "@playwright/test";

/**
 * Monica verifies the user for every Passkey ceremony unless the relying party explicitly
 * discourages it, so confirming the in-page prompt opens a separate master-password window.
 * Pass `trigger` to perform the confirming key presses only after the popup listener is
 * attached; without it the caller must already have triggered the popup before calling.
 */
export async function completeUserVerification(context: BrowserContext, masterPassword: string, timeout = 10_000, trigger?: () => void | Promise<void>): Promise<boolean> {
  const pending = context.waitForEvent("page", { timeout }).catch(() => undefined);
  if (trigger) await trigger();
  const popup = await pending;
  if (!popup) return false;
  await popup.waitForSelector("#password", { timeout });
  await popup.locator("#password").fill(masterPassword);
  await popup.locator("#confirm").click();
  await popup.waitForEvent("close", { timeout }).catch(() => undefined);
  return true;
}
