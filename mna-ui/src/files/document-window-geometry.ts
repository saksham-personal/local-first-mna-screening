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

export function moveWindowRect(rect: WindowRect, delta: { x: number; y: number }, viewport: ViewportSize): WindowRect {
  return clampWindowRect({ ...rect, left: rect.left + delta.x, top: rect.top + delta.y }, viewport, { width: 1, height: 1 });
}

// Different documents share the document-window position for this tab session.
export const windowPositions = new Map<string, { left: number; top: number }>();

export function readWindowPosition(type: string, storage?: Pick<Storage, "getItem">) {
  const cached = windowPositions.get(type);
  if (cached) return cached;
  try {
    const position = JSON.parse((storage ?? window.sessionStorage).getItem(`screening-window-${type}`) ?? "null");
    if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
      return { left: position.left as number, top: position.top as number };
    }
  } catch { /* Session storage may be disabled or contain an older value. */ }
  return undefined;
}

export function rememberWindowPosition(type: string, rect: WindowRect, storage?: Pick<Storage, "setItem">) {
  const position = { left: rect.left, top: rect.top };
  windowPositions.set(type, position);
  try { (storage ?? window.sessionStorage).setItem(`screening-window-${type}`, JSON.stringify(position)); } catch { /* In-memory fallback remains available. */ }
}
