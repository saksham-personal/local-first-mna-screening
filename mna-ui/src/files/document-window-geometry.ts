export type WindowRect = { left: number; top: number; width: number; height: number };
export type ViewportSize = { width: number; height: number };
export type WindowMinimum = { width: number; height: number };

export const DOCUMENT_WINDOW_MINIMUM: WindowMinimum = { width: 360, height: 420 };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function clampWindowRect(
  rect: WindowRect,
  viewport: ViewportSize,
  minimum: WindowMinimum = DOCUMENT_WINDOW_MINIMUM,
): WindowRect {
  const viewportWidth = Math.max(1, viewport.width);
  const viewportHeight = Math.max(1, viewport.height);
  const width = clamp(rect.width, Math.min(minimum.width, viewportWidth), viewportWidth);
  const height = clamp(rect.height, Math.min(minimum.height, viewportHeight), viewportHeight);
  return {
    left: clamp(rect.left, 0, Math.max(0, viewportWidth - width)),
    top: clamp(rect.top, 0, Math.max(0, viewportHeight - height)),
    width,
    height,
  };
}

export function resizeWindowRect(
  rect: WindowRect,
  delta: { x: number; y: number },
  viewport: ViewportSize,
  minimum: WindowMinimum = DOCUMENT_WINDOW_MINIMUM,
): WindowRect {
  const viewportWidth = Math.max(1, viewport.width);
  const viewportHeight = Math.max(1, viewport.height);
  const left = clamp(rect.left, 0, viewportWidth - 1);
  const availableWidth = viewportWidth - left;
  const width = clamp(rect.width + delta.x, Math.min(minimum.width, availableWidth), availableWidth);
  const height = clamp(rect.height + delta.y, Math.min(minimum.height, viewportHeight), viewportHeight);
  const top = clamp(rect.top, 0, Math.max(0, viewportHeight - height));
  return { left, top, width, height };
}

export function defaultDocumentWindowRect(viewport: ViewportSize): WindowRect {
  const rect = clampWindowRect({
    left: viewport.width - 560 - 24,
    top: 24,
    width: 560,
    height: 720,
  }, viewport);
  return rect;
}
