import { observeUiLocale } from "../i18n/runtime";

/** Update application labels without replacing controls or resetting a user's choice. */
export function createPromptI18n() {
  const texts = new Map<Node, () => string>();
  const attributes = new Map<Element, Map<string, () => string>>();
  const stop = observeUiLocale(() => {
    for (const [node, value] of texts) node.textContent = value();
    for (const [node, values] of attributes) {
      for (const [name, value] of values) node.setAttribute(name, value());
    }
  });
  return {
    text(node: Node, value: () => string) { texts.set(node, value); node.textContent = value(); },
    attribute(node: Element, name: string, value: () => string) {
      if (!attributes.has(node)) attributes.set(node, new Map());
      attributes.get(node)!.set(name, value);
      node.setAttribute(name, value());
    },
    dispose() { stop(); texts.clear(); attributes.clear(); }
  };
}
