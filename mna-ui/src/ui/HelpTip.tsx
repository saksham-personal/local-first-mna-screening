import { useCallback, useEffect, useId, useReducer, useRef } from "react";
import type { PointerEvent, ReactNode } from "react";
import { Popover } from "radix-ui";
import { CircleHelp } from "lucide-react";
import {
  helpTipClosed,
  helpTipDelay,
  helpTipIconSize,
  helpTipReduce,
  type HelpTipEvent,
  type HelpTipSize,
} from "./help-tip-state";

export type HelpTipProps = {
  /** Accessible name of the "?" button (for example "About source scores"). */
  label: string;
  /** Tip content. Plain text or rich markup; links and lists are fine. */
  children: ReactNode;
  /** Button size: "md" (default) is 26px, "sm" is 20px. */
  size?: HelpTipSize;
  /** Preferred side. The tip flips to the opposite side and shifts to stay inside the window. */
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Maximum content width in px (default 320, never wider than the window). */
  maxWidth?: number;
  /** Extra class for the trigger button, for placement such as right alignment. */
  className?: string;
  contentClassName?: string;
};

/**
 * A "?" button with a floating explanation.
 *
 * Hover or keyboard focus shows the tip; click, Enter/Space or a tap pins it open; Escape, a click
 * elsewhere or Tab closes it. The content renders in a portal above dialogs and is positioned by
 * Radix (collision-aware: flips and shifts near window edges). Focus is never moved into the tip.
 */
export default function HelpTip({
  label,
  children,
  size = "md",
  side = "bottom",
  align = "center",
  maxWidth = 320,
  className = "",
  contentClassName = "",
}: HelpTipProps) {
  const contentId = useId();
  const [state, dispatch] = useReducer(helpTipReduce, helpTipClosed);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const clear = useCallback(() => window.clearTimeout(timer.current), []);
  const send = useCallback(
    (event: HelpTipEvent) => {
      clear();
      const delay = helpTipDelay(event);
      if (delay > 0)
        timer.current = window.setTimeout(() => dispatch(event), delay);
      else dispatch(event);
    },
    [clear],
  );
  useEffect(() => clear, [clear]);

  // Touch has no hover; a tap arrives as focus plus click and pins the tip.
  const hover = (event: PointerEvent, type: "hover-in" | "hover-out") => {
    if (event.pointerType !== "touch") send(type);
  };

  return (
    <Popover.Root
      open={state.open}
      onOpenChange={(open) => {
        if (!open) send("dismiss");
      }}
    >
      <Popover.Anchor asChild>
        <button
          ref={trigger}
          type="button"
          className={`help-tip-trigger help-tip-${size} ${className}`.trim()}
          aria-label={label}
          aria-expanded={state.open}
          aria-describedby={state.open ? contentId : undefined}
          data-open={state.open || undefined}
          onPointerEnter={(event) => hover(event, "hover-in")}
          onPointerLeave={(event) => hover(event, "hover-out")}
          onFocus={(event) => {
            // Only keyboard focus opens the tip; a mouse press is handled by the click below.
            let visible = true;
            try {
              visible = event.currentTarget.matches(":focus-visible");
            } catch {
              /* older engines: treat every focus as visible */
            }
            if (visible) send("focus");
          }}
          onBlur={() => send("blur")}
          onClick={() => send("click")}
        >
          <CircleHelp size={helpTipIconSize[size]} aria-hidden="true" />
        </button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          id={contentId}
          role="tooltip"
          className={`help-tip-content ${contentClassName}`.trim()}
          style={{ maxWidth: `min(${maxWidth}px, calc(100vw - 24px))` }}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // The trigger toggles the tip itself; do not let the outside-press close then reopen it.
            if (trigger.current?.contains(event.target as Node))
              event.preventDefault();
          }}
          onPointerEnter={(event) => hover(event, "hover-in")}
          onPointerLeave={(event) => hover(event, "hover-out")}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
