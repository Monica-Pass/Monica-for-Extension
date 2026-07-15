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
    const rootElement = asElement(current);
    if (rootElement?.shadowRoot) visit(rootElement.shadowRoot);
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

export function openShadowRoots(root: ParentNode): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const visited = new Set<ShadowRoot>();
  const visit = (current: ParentNode): void => {
    const rootShadow = asElement(current)?.shadowRoot;
    if (rootShadow && !visited.has(rootShadow)) {
      visited.add(rootShadow);
      roots.push(rootShadow);
      visit(rootShadow);
    }
    for (const element of Array.from(current.querySelectorAll<HTMLElement>("*"))) {
      const shadowRoot = element.shadowRoot;
      if (!shadowRoot || visited.has(shadowRoot)) continue;
      visited.add(shadowRoot);
      roots.push(shadowRoot);
      visit(shadowRoot);
    }
  };
  visit(root);
  return roots;
}

function asElement(root: ParentNode): Element | null {
  const ownerDocument = "defaultView" in root ? root as Document : root.ownerDocument;
  const view = ownerDocument?.defaultView;
  return view && root instanceof view.Element ? root : null;
}
