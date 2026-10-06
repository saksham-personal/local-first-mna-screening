/**
 * Pure open/pin state for HelpTip, kept separate from the component so it can be unit-tested.
 *
 * Hover and keyboard focus open a tip temporarily. A click (or Enter/Space, or a tap) pins it open
 * until the next click, Escape, outside interaction, or Tab away. Hover-out and blur never close a
 * pinned tip, which is what makes it usable on touch screens and for selecting text.
 */
export type HelpTipState = { open: boolean; pinned: boolean };
export type HelpTipEvent =
  | "hover-in"
  | "hover-out"
  | "focus"
  | "blur"
  | "click"
  | "dismiss";

export const helpTipClosed: HelpTipState = { open: false, pinned: false };

/** Delay before a hover opens the tip, so moving the pointer across a page does not flash tips. */
export const helpTipOpenDelayMs = 140;
/** Grace period before a hover-out closes it, so the pointer can travel into the tip content. */
export const helpTipCloseDelayMs = 110;

export function helpTipReduce(
  state: HelpTipState,
  event: HelpTipEvent,
): HelpTipState {
  switch (event) {
    case "hover-in":
    case "focus":
      return state.open ? state : { ...state, open: true };
    case "hover-out":
    case "blur":
      return state.pinned || !state.open ? state : helpTipClosed;
    case "click":
      return state.pinned ? helpTipClosed : { open: true, pinned: true };
    case "dismiss":
      return state.open || state.pinned ? helpTipClosed : state;
  }
}

/** How long to wait before applying an event; clicks, focus and dismissals apply immediately. */
export function helpTipDelay(event: HelpTipEvent): number {
  if (event === "hover-in") return helpTipOpenDelayMs;
  if (event === "hover-out") return helpTipCloseDelayMs;
  return 0;
}

export type HelpTipSize = "sm" | "md";
export const helpTipIconSize: Record<HelpTipSize, number> = { sm: 13, md: 15 };
