import { expect, type Locator, type Page } from "@playwright/test";

/** M3E slots content into a native dialog in its shadow root. Scope interactions
 * to the host so Playwright can reach both slotted fields and internal actions. */
export function dialogContent(scope: Pick<Page, "getByRole" | "locator">, options?: Parameters<Page["getByRole"]>[1]) {
  const dialog = scope.getByRole("dialog", options);
  return scope.locator("m3e-dialog").filter({ has: dialog }).or(scope.locator('[role="dialog"]').and(dialog));
}

/** Read actual rendered geometry, rather than the display:contents host. */
export function dialogSurface(content: Locator) {
  return content.locator("dialog").or(content.and(content.page().locator(":not(m3e-dialog)")));
}

/** Exercise the actual option panel, including its focus and input events. */
export async function chooseOption(control: Locator, choice: string | { label: string }) {
  if (await control.evaluate(node => node.localName) === "select") {
    await control.selectOption(choice);
    return;
  }
  // Selecting a language changes the control's accessible name immediately.
  // Keep the same DOM control for the post-selection assertions.
  const id = await control.getAttribute("id");
  if (id) control = control.page().locator(`[id=${JSON.stringify(id)}]`);
  const options = await control.locator("m3e-option").evaluateAll(nodes => nodes.map(node => ({
    value: (node as HTMLElement & { value: string }).value,
    label: node.textContent?.replace(/\s+/g, " ").trim() || ""
  })));
  const option = options.find(option => typeof choice === "string" ? option.value === choice : option.label === choice.label);
  expect(option, `Available choices: ${options.map(option => option.label).join(", ")}`).toBeDefined();
  await control.click();
  const panelId = await control.getAttribute("aria-controls");
  expect(panelId).toBeTruthy();
  const panel = control.page().locator(`[id="${panelId}"]`);
  await panel.getByRole("option", { name: option!.label, exact: true }).click();
  await expect(control).toHaveJSProperty("value", option!.value);
  // The library collapses before destroying its animated option panel. Wait
  // for disposal so a subsequent click cannot land during the closing phase.
  await expect(panel).toHaveCount(0);
}
