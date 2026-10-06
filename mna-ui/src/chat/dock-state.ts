/**
 * Pure state for the Workspace chat dock: a 44 px rail, the default side panel,
 * or an expanded panel. Kept free of React so the persistence and sizing rules
 * can be tested without a browser.
 */
export type DockMode = "rail" | "default" | "expanded";
export type DockState = {
  mode: DockMode;
  /** The analyst's dragged width. Undefined means "use the responsive default". */
  width?: number;
};

export const DOCK_STORAGE_KEY = "screening-dock-v1";
export const DOCK_RAIL_WIDTH = 44;
export const DOCK_MIN_WIDTH = 320;
/** The dock never takes more than this share of the window. */
export const DOCK_MAX_SHARE = 0.6;
/** The workspace column keeps at least this much room next to the dock. */
export const DOCK_WORKSPACE_MIN = 320;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export const defaultDockState: DockState = { mode: "default" };

export function defaultDockWidth(windowWidth: number): number {
  return windowWidth <= 1280 ? 350 : 390;
}

/** Largest width the dock may take: 60% of the window, leaving the workspace usable. */
export function maxDockWidth(windowWidth: number, reservedWidth = 0): number {
  const share = Math.floor(windowWidth * DOCK_MAX_SHARE);
  const room = Math.floor(windowWidth - reservedWidth - DOCK_WORKSPACE_MIN);
  return Math.max(DOCK_MIN_WIDTH, Math.min(share, room));
}

export function clampDockWidth(
  value: number,
  windowWidth: number,
  reservedWidth = 0,
): number {
  const max = maxDockWidth(windowWidth, reservedWidth);
  return Math.round(Math.min(Math.max(value, DOCK_MIN_WIDTH), max));
}

/** The column width, in px, that a dock state takes at this window size. */
export function dockColumnWidth(
  state: DockState,
  windowWidth: number,
  reservedWidth = 0,
): number {
  if (state.mode === "rail") return DOCK_RAIL_WIDTH;
  if (state.mode === "expanded") return maxDockWidth(windowWidth, reservedWidth);
  return clampDockWidth(
    state.width ?? defaultDockWidth(windowWidth),
    windowWidth,
    reservedWidth,
  );
}

export function parseDockState(raw: string | null | undefined): DockState {
  if (!raw) return defaultDockState;
  try {
    const value = JSON.parse(raw) as { mode?: unknown; width?: unknown };
    const mode: DockMode =
      value.mode === "rail" || value.mode === "expanded" ? value.mode : "default";
    const width =
      typeof value.width === "number" &&
      Number.isFinite(value.width) &&
      value.width >= DOCK_MIN_WIDTH &&
      value.width <= 4000
        ? Math.round(value.width)
        : undefined;
    return width === undefined ? { mode } : { mode, width };
  } catch {
    return defaultDockState;
  }
}

export function loadDockState(
  storage: Storage | undefined = safeStorage(),
): DockState {
  try {
    return parseDockState(storage?.getItem(DOCK_STORAGE_KEY));
  } catch {
    return defaultDockState;
  }
}

export function saveDockState(
  state: DockState,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(DOCK_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* The dock still works without a saved preference. */
  }
}

/** The state to restore when the analyst opens the dock from the rail. */
export function openDock(state: DockState): DockState {
  return state.mode === "rail" ? { ...state, mode: "default" } : state;
}

/** Collapse to the rail, remembering the dragged width for the next open. */
export function collapseDock(state: DockState): DockState {
  return { ...state, mode: "rail" };
}

export function toggleExpandedDock(state: DockState): DockState {
  return { ...state, mode: state.mode === "expanded" ? "default" : "expanded" };
}

/** Dragging or keyboard resizing always lands in the default mode at the new width. */
export function resizeDock(
  width: number,
  windowWidth: number,
  reservedWidth = 0,
): DockState {
  return {
    mode: "default",
    width: clampDockWidth(width, windowWidth, reservedWidth),
  };
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
