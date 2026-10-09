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

export function forgetWindowPosition(type: string, storage?: Pick<Storage, "removeItem">) {
  windowPositions.delete(type);
  try { (storage ?? window.sessionStorage).removeItem(`screening-window-${type}`); } catch { /* Nothing was stored, or storage is disabled. */ }
}

// Placement for windows the analyst has not moved (the intake dialog sits beside open document windows).
export type WindowPosition = { left: number; top: number };
const WINDOW_GAP = 16;
// Dispatched on window when a document window opens, closes, moves or resizes, so windows placed beside it can follow.
export const DOCUMENT_WINDOW_LAYOUT_EVENT = "document-window-layout";

export function announceDocumentWindowLayout() {
  window.dispatchEvent(new Event(DOCUMENT_WINDOW_LAYOUT_EVENT));
}

export function openDocumentWindowRects(root: ParentNode = document): WindowRect[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".document-window"), (element) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    return { left, top, width, height };
  });
}

function clampPosition(position: WindowPosition, size: { width: number; height: number }, viewport: ViewportSize): WindowPosition {
  return {
    left: clamp(position.left, 0, Math.max(0, viewport.width - size.width)),
    top: clamp(position.top, 0, Math.max(0, viewport.height - size.height)),
  };
}

function centreWindow(dialog: WindowRect, viewport: ViewportSize): WindowPosition {
  return clampPosition({ left: (viewport.width - dialog.width) / 2, top: (viewport.height - dialog.height) / 2 }, dialog, viewport);
}

function overlapArea(position: WindowPosition, size: { width: number; height: number }, other: WindowRect) {
  const width = Math.min(position.left + size.width, other.left + other.width) - Math.max(position.left, other.left);
  const height = Math.min(position.top + size.height, other.top + other.height) - Math.max(position.top, other.top);
  return width > 0 && height > 0 ? width * height : 0;
}

// Left of the document when there is room, otherwise right of it, otherwise above or below it. If every spot overlaps
// the document, the spot with the least overlap wins (earlier spots win ties). The result always stays in the viewport.
export function placeBeside(dialog: WindowRect, documentRect: WindowRect, viewport: ViewportSize, gap = WINDOW_GAP): WindowPosition {
  const top = (viewport.height - dialog.height) / 2;
  const centredLeft = documentRect.left + (documentRect.width - dialog.width) / 2;
  const candidates = [
    { left: documentRect.left - gap - dialog.width, top },
    { left: documentRect.left + documentRect.width + gap, top },
    { left: centredLeft, top: documentRect.top - gap - dialog.height },
    { left: centredLeft, top: documentRect.top + documentRect.height + gap },
  ].map((position) => clampPosition(position, dialog, viewport));
  return candidates.reduce((best, candidate) => (
    overlapArea(candidate, dialog, documentRect) < overlapArea(best, dialog, documentRect) ? candidate : best
  ));
}

function unionRect(rects: WindowRect[]): WindowRect {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

// A remembered position (the analyst dragged the window) is kept, clamped to the viewport. Otherwise the window sits
// beside the open document windows, or is centred when none is open.
export function placeWindow({ dialog, documents, viewport, remembered }: {
  dialog: WindowRect;
  documents: WindowRect[];
  viewport: ViewportSize;
  remembered?: WindowPosition;
}): WindowPosition {
  if (remembered) return clampPosition(remembered, dialog, viewport);
  return documents.length ? placeBeside(dialog, unionRect(documents), viewport) : centreWindow(dialog, viewport);
}
