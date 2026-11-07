import { expect, type Locator } from "@playwright/test";

/**
 * Shared horizontal-overflow assertion: compensates a vertical scrollbar on the container and,
 * when the assertion fails, reports every descendant (including open shadow roots) that crosses
 * the container boundary or scrolls internally.
 */
export async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const report = await locator.evaluate((element: HTMLElement) => {
    const root = element.getBoundingClientRect();
    const descendants: HTMLElement[] = [];
    const visit = (node: ParentNode) => {
      for (const child of node.querySelectorAll<HTMLElement>(":scope > *")) {
        descendants.push(child);
        visit(child);
        if (child.shadowRoot) visit(child.shadowRoot);
      }
    };
    visit(element);
    const offenders = descendants.flatMap((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const boundaryOverflow = Math.max(0, root.left - rect.left, rect.right - root.right);
      const contentOverflow = Math.max(0, candidate.scrollWidth - candidate.clientWidth);
      const overflow = Math.max(boundaryOverflow, contentOverflow);
      return overflow > 1 ? [{ tag: candidate.tagName.toLowerCase(), className: candidate.className, overflow: Math.round(overflow * 10) / 10, width: Math.round(rect.width * 10) / 10, contentOverflow }] : [];
    }).slice(0, 12);
    const style = getComputedStyle(element);
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const verticalScrollbar = Math.max(0, element.offsetWidth - element.clientWidth - borders);
    return {
      overflow: Math.max(0, element.scrollWidth - element.clientWidth - verticalScrollbar),
      rawOverflow: element.scrollWidth - element.clientWidth,
      verticalScrollbar,
      clientWidth: element.clientWidth,
      offsetWidth: element.offsetWidth,
      scrollWidth: element.scrollWidth,
      offenders
    };
  });
  expect(report.overflow, JSON.stringify(report)).toBeLessThanOrEqual(1);
}
