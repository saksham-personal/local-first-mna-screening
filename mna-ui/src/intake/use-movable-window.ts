import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { moveWindowRect, readWindowPosition, rememberWindowPosition, type WindowRect } from "../files/document-window-geometry";

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
const bounds = (element: HTMLElement): WindowRect => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

export function useMovableWindow(type: string, open: boolean, onCommit?: (rect: WindowRect) => void, disabled = false) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const attachWindow = useCallback((node: HTMLDivElement | null) => {
    windowRef.current = node;
    setElement(node);
  }, []);
  const initial = useRef<WindowRect | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; rect: WindowRect; next: WindowRect } | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const commit = (rect: WindowRect) => {
    const element = windowRef.current;
    if (!element) return;
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.transform = "none";
    rememberWindowPosition(type, rect);
    commitRef.current?.(rect);
  };
  useLayoutEffect(() => {
    if (!open || !element || disabled) return;
    initial.current ??= bounds(element);
    const remembered = readWindowPosition(type);
    commit(moveWindowRect({ ...bounds(element), ...remembered }, { x: 0, y: 0 }, viewport()));
    const resize = () => { if (!disabled) commit(moveWindowRect(bounds(element), { x: 0, y: 0 }, viewport())); };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [element, open, disabled, type]);
  const cancel = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (windowRef.current) windowRef.current.style.transform = "none";
  };
  return {
    windowRef: attachWindow,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (disabled || !event.altKey || !windowRef.current) return;
      const delta = { ArrowLeft: { x: -16, y: 0 }, ArrowRight: { x: 16, y: 0 }, ArrowUp: { x: 0, y: -16 }, ArrowDown: { x: 0, y: 16 } }[event.key];
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      commit(moveWindowRect(bounds(windowRef.current), delta, viewport()));
    },
    titlebarHandlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (disabled || event.button !== 0 || (event.target as HTMLElement).closest("button, input, a, select") || !windowRef.current) return;
        event.preventDefault();
        windowRef.current.focus({ preventScroll: true });
        const rect = bounds(windowRef.current);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, rect, next: rect };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId || !windowRef.current) return;
        current.next = moveWindowRect(current.rect, { x: event.clientX - current.x, y: event.clientY - current.y }, viewport());
        windowRef.current.style.transform = `translate(${current.next.left - current.rect.left}px, ${current.next.top - current.rect.top}px)`;
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        if (drag.current?.id !== event.pointerId) return;
        const next = drag.current.next;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        commit(next);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onDoubleClick: (event: React.MouseEvent<HTMLElement>) => {
        if (disabled || (event.target as HTMLElement).closest("button") || !initial.current || !windowRef.current) return;
        const rect = { ...bounds(windowRef.current), left: initial.current.left, top: initial.current.top };
        commit(moveWindowRect(rect, { x: 0, y: 0 }, viewport()));
      },
    },
  };
}
