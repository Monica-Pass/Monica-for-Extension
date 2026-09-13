interface Rect { left: number; right: number; top: number; bottom: number; width: number; }
interface Viewport { left: number; top: number; width: number; height: number; }

export function inlineMenuPosition(anchor: Rect, viewport: Viewport, desiredHeight = 320) {
  const gap = 6;
  const margin = 8;
  if (anchor.width <= 0 || anchor.bottom <= viewport.top || anchor.top >= viewport.top + viewport.height
    || anchor.right <= viewport.left || anchor.left >= viewport.left + viewport.width || viewport.width < 240) return undefined;
  const width = Math.min(Math.max(anchor.width, 280), 360, viewport.width - margin * 2);
  const below = viewport.top + viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - viewport.top - gap - margin;
  const placement = below >= Math.min(desiredHeight, 180) || below >= above ? "below" : "above";
  const maxHeight = Math.min(360, placement === "below" ? below : above);
  if (maxHeight < 96) return undefined;
  const height = Math.min(desiredHeight, maxHeight);
  return {
    left: Math.max(viewport.left + margin, Math.min(anchor.left, viewport.left + viewport.width - width - margin)),
    top: placement === "below" ? anchor.bottom + gap : anchor.top - gap - height,
    width, maxHeight, placement
  };
}
