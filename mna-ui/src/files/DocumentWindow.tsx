import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, X } from "lucide-react";
import type { StagedFile } from "../lib/chat-contract";
import Skeleton from "../ui/Skeleton";
import {
  announceDocumentWindowLayout,
  clampWindowRect,
  defaultDocumentWindowRect,
  resizeWindowRect,
  type WindowRect,
} from "./document-window-geometry";
import "./document-window.css";
import { useMovableWindow } from "../intake/use-movable-window";

const LazyPdfPreview = lazy(() => import("./PdfPreview"));

type Props = { file: StagedFile; url?: string; title?: string; onClose: () => void };
type DragState = { pointerId: number; x: number; y: number; rect: WindowRect };

function viewportSize() { return { width: window.innerWidth, height: window.innerHeight }; }

export default function DocumentWindow({ file, url, title, onClose }: Props) {
  const [rect, setRect] = useState<WindowRect>(() => typeof window === "undefined"
    ? { left: 0, top: 0, width: 560, height: 720 }
    : defaultDocumentWindowRect(viewportSize()));
  const [maximized, setMaximized] = useState(false);
  const [restoreRect, setRestoreRect] = useState<WindowRect | null>(null);
  const drag = useRef<DragState | null>(null);

  useEffect(() => {
    const onResize = () => setRect((current) => maximized
      ? clampWindowRect({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }, viewportSize())
      : clampWindowRect(current, viewportSize()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [maximized]);

  // Windows placed beside this document (the intake dialog) follow it as it opens, moves, resizes or closes.
  useEffect(() => { announceDocumentWindowLayout(); }, [rect, maximized]);
  useEffect(() => () => announceDocumentWindowLayout(), []);

  const toggleMaximized = () => {
    if (maximized) {
      setRect(clampWindowRect(restoreRect ?? defaultDocumentWindowRect(viewportSize()), viewportSize()));
      setRestoreRect(null);
      setMaximized(false);
    } else {
      setRestoreRect(rect);
      setRect(clampWindowRect({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }, viewportSize()));
      setMaximized(true);
    }
  };

  const movable = useMovableWindow("document", true, setRect, maximized);

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (maximized || event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setRect(resizeWindowRect(current.rect, { x: event.clientX - current.x, y: event.clientY - current.y }, viewportSize()));
  };
  const stopResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };
  const resizeByKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey) return;
    const delta = event.shiftKey ? 40 : 12;
    if (event.key === "ArrowRight") setRect((current) => resizeWindowRect(current, { x: delta, y: 0 }, viewportSize()));
    else if (event.key === "ArrowLeft") setRect((current) => resizeWindowRect(current, { x: -delta, y: 0 }, viewportSize()));
    else if (event.key === "ArrowDown") setRect((current) => resizeWindowRect(current, { x: 0, y: delta }, viewportSize()));
    else if (event.key === "ArrowUp") setRect((current) => resizeWindowRect(current, { x: 0, y: -delta }, viewportSize()));
    else return;
    event.preventDefault();
  };
  const onWindowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    movable.onKeyDown(event);
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  if (typeof document === "undefined") return null;
  const style: CSSProperties = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  return createPortal(
    <div ref={movable.windowRef} className={`document-window${maximized ? " is-maximized" : ""}`} style={style} role="region" aria-label={title ?? file.name} tabIndex={0} onKeyDown={onWindowKeyDown}>
      <div className="document-window__titlebar" title="Drag to move; double-click to reset; Alt+Arrow keys move 16px" {...movable.titlebarHandlers}>
        <span className="document-window__title" title={title ?? file.name}>{title ?? file.name}</span>
        <div className="document-window__actions">
          <button type="button" aria-label={maximized ? "Restore document window" : "Maximize document window"} title={maximized ? "Restore" : "Maximize"} onClick={toggleMaximized}>{maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button type="button" aria-label="Close document window" title="Close" onClick={onClose}><X size={17} /></button>
        </div>
      </div>
      <div className="document-window__preview">
        <Suspense fallback={<div className="document-window__loading"><Skeleton variant="drawer" label="Loading PDF preview" /></div>}>
          <LazyPdfPreview file={file} url={url} onClose={onClose} />
        </Suspense>
      </div>
      {!maximized && <button
        type="button"
        className="document-window__resize"
        aria-label="Resize document window"
        title="Resize window; use arrow keys for keyboard resizing"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onKeyDown={resizeByKeyboard}
      />}
    </div>,
    document.body,
  );
}
