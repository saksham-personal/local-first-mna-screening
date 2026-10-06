import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowRight,
  GripVertical,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { DOCK_MIN_WIDTH } from "./dock-state";
import "./dock.css";

/** The 44 px strip shown when the Workspace chat dock is collapsed. */
export function DockRail({
  busy,
  onOpen,
}: {
  busy: boolean;
  onOpen: () => void;
}) {
  return (
    <aside className="ct-dock-rail" aria-label="Screening assistant, collapsed">
      <button
        className="ct-icon-button"
        type="button"
        onClick={onOpen}
        aria-label="Open screening assistant"
        title="Open screening assistant"
      >
        <PanelRightOpen size={17} />
      </button>
      <button
        className="ct-dock-rail-chat"
        type="button"
        onClick={onOpen}
        aria-label={
          busy
            ? "Open screening assistant, working"
            : "Open screening assistant"
        }
        title={busy ? "Assistant is working" : "Screening assistant"}
      >
        <MessageSquare size={18} />
        {busy && <span className="ct-dock-rail-dot" aria-hidden="true" />}
      </button>
    </aside>
  );
}

/** Header of the docked chat: collapse to the rail, expand, or open the full chat. */
export function DockHead({
  expanded,
  busy,
  onCollapse,
  onToggleExpanded,
  onOpenFullChat,
}: {
  expanded: boolean;
  busy: boolean;
  onCollapse: () => void;
  onToggleExpanded: () => void;
  onOpenFullChat: () => void;
}) {
  return (
    <div className="ct-docked-head">
      <span>
        <MessageSquare size={15} />
        Screening assistant
        {busy && (
          <span className="ct-dock-head-busy" role="status">
            <i aria-hidden="true" />
            Working
          </span>
        )}
      </span>
      <div>
        <button
          className="ct-icon-button"
          type="button"
          onClick={onCollapse}
          aria-label="Collapse chat to the side"
          title="Collapse chat to the side"
        >
          <PanelRightClose size={15} />
        </button>
        <button
          className="ct-icon-button"
          type="button"
          onClick={onToggleExpanded}
          aria-label={expanded ? "Restore side chat" : "Expand side chat"}
          title={expanded ? "Restore side chat" : "Expand side chat"}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          className="ct-icon-button"
          type="button"
          onClick={onOpenFullChat}
          aria-label="Open full chat"
          title="Open full chat"
        >
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

/**
 * Drag handle on the dock's left edge. Dragging left widens the dock; the arrow
 * keys, Home and End work too (same behaviour as the navigation handles).
 */
export function DockResizeHandle({
  width,
  max,
  onResize,
}: {
  width: number;
  max: number;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number }>(
    undefined,
  );
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    onResize(active.startWidth - (event.clientX - active.startX));
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 20;
    let next = width;
    if (event.key === "Home") next = DOCK_MIN_WIDTH;
    else if (event.key === "End") next = max;
    else if (event.key === "ArrowLeft") next += step;
    else if (event.key === "ArrowRight") next -= step;
    else return;
    event.preventDefault();
    onResize(next);
  };
  return (
    <div
      className="ct-resize-handle ct-resize-dock"
      role="separator"
      aria-label="Resize assistant panel"
      aria-orientation="vertical"
      aria-valuemin={DOCK_MIN_WIDTH}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize the assistant, or use the arrow keys"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    >
      <GripVertical size={14} />
    </div>
  );
}
