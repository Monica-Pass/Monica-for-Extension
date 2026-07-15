/**
 * Queries the light DOM plus every reachable open shadow root.
 *
 * Closed shadow roots intentionally remain outside this boundary: the browser
 * does not expose them through `Element.shadowRoot`, so claiming support would
 * be both misleading and brittle.
 */
export function queryComposedAll<T extends Element>(root: ParentNode, selector: string): T[] {
  const matches: T[] = [];
  const visited = new Set<ParentNode>();

  const visit = (current: ParentNode): void => {
    if (visited.has(current)) return;
    visited.add(current);
    matches.push(...Array.from(current.querySelectorAll<T>(selector)));
    for (const element of Array.from(current.querySelectorAll<HTMLElement>("*"))) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };

  visit(root);
  return matches;
}

export function elementByIdInRoot(element: Element, id: string): Element | null {
  const root = element.getRootNode();
  if (root instanceof element.ownerDocument.defaultView!.ShadowRoot) return root.getElementById(id);
  return element.ownerDocument.getElementById(id);
}
