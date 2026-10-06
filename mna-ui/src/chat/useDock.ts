import { useCallback, useEffect, useRef, useState } from "react";
import {
  collapseDock,
  dockColumnWidth,
  loadDockState,
  maxDockWidth,
  openDock,
  resizeDock,
  saveDockState,
  toggleExpandedDock,
  type DockState,
} from "./dock-state";

/**
 * State for the Workspace chat dock. `reservedWidth` is the space taken by the
 * navigation, so the workspace column always keeps room next to the dock.
 */
export function useDock(reservedWidth: number) {
  const [state, setState] = useState<DockState>(() => loadDockState());
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const first = useRef(true);
  useEffect(() => {
    const update = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = window.setTimeout(() => saveDockState(state), 180);
    return () => window.clearTimeout(timer);
  }, [state]);
  const open = useCallback(() => setState(openDock), []);
  const collapse = useCallback(() => setState(collapseDock), []);
  const toggleExpanded = useCallback(() => setState(toggleExpandedDock), []);
  const resize = useCallback(
    (width: number) =>
      setState(resizeDock(width, window.innerWidth, reservedWidth)),
    [reservedWidth],
  );
  return {
    state,
    open,
    collapse,
    toggleExpanded,
    resize,
    columnWidth: dockColumnWidth(state, windowWidth, reservedWidth),
    /** Width the dock takes when it is open (used to keep a hidden chat laid out). */
    openWidth: dockColumnWidth(
      { mode: "default", width: state.width },
      windowWidth,
      reservedWidth,
    ),
    maxWidth: maxDockWidth(windowWidth, reservedWidth),
  };
}
