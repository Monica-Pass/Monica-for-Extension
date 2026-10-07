import type { BrowserContext } from "@playwright/test";

/**
 * Monica verifies the user for every Passkey ceremony unless the relying party explicitly
 * discourages it, so confirming the in-page prompt opens a separate master-password window.
 */
export async function completeUserVerification(context: BrowserContext, masterPassword: string, timeout = 10_000): Promise<boolean> {
  const popup = await context.waitForEvent("page", { timeout }).catch(() => undefined);
  if (!popup) return false;
  await popup.waitForSelector("#password", { timeout });
  await popup.locator("#password").fill(masterPassword);
  await popup.locator("#confirm").click();
  await popup.waitForEvent("close", { timeout }).catch(() => undefined);
  return true;
}
