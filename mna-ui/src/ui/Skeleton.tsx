import type { CSSProperties } from "react";

export type SkeletonVariant =
  | "line"
  | "block"
  | "table"
  | "card"
  | "list"
  | "drawer";

export type SkeletonProps = {
  /** Shape of the placeholder. Defaults to "block". */
  variant?: SkeletonVariant;
  /** Text announced to screen readers while loading (visually hidden). */
  label?: string;
  /** table and list: number of body rows. Defaults: table 6, list 4. */
  rows?: number;
  /** table: number of columns (default 5). */
  cols?: number;
  /** line and card: number of text lines. Defaults: line 1, card 3. */
  lines?: number;
  /** line and block: CSS width (default 100%). */
  width?: CSSProperties["width"];
  /** block: CSS height (default 120px). */
  height?: CSSProperties["height"];
  className?: string;
};

// Fixed width cycles keep the placeholders looking like text without random per-render jitter.
const lineWidths = [92, 78, 86, 64, 72];
const cellWidths = [78, 54, 66, 42, 72, 58];
const clampCount = (value: number | undefined, fallback: number, max: number) =>
  Math.min(max, Math.max(1, Math.floor(value ?? fallback)));

function Bone({ w, h }: { w?: string; h?: number }) {
  const style: CSSProperties = {};
  if (w) style.width = w;
  if (h) style.height = h;
  return <i className="ui-skeleton-bone" style={style} aria-hidden="true" />;
}

function Lines({ count, last = 62 }: { count: number; last?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <Bone
          key={index}
          w={`${index === count - 1 && count > 1 ? last : lineWidths[index % lineWidths.length]}%`}
        />
      ))}
    </>
  );
}

/**
 * Loading placeholder with a gentle opacity pulse (no shimmer, gradients, blur or shadows, so it
 * is cheap on CPU-only machines). The pulse is disabled by the global reduced-motion rule.
 * Renders `role="status"` with `aria-busy` and a visually hidden label.
 */
export default function Skeleton({
  variant = "block",
  label = "Loading",
  rows,
  cols,
  lines,
  width,
  height,
  className = "",
}: SkeletonProps) {
  let body;
  if (variant === "line") {
    body = <Lines count={clampCount(lines, 1, 12)} />;
  } else if (variant === "table") {
    const columns = clampCount(cols, 5, 12);
    const grid: CSSProperties = {
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    };
    body = (
      <>
        <div className="ui-skeleton-row ui-skeleton-head" style={grid}>
          {Array.from({ length: columns }, (_, column) => (
            <Bone key={column} w="52%" />
          ))}
        </div>
        {Array.from({ length: clampCount(rows, 6, 40) }, (_, row) => (
          <div className="ui-skeleton-row" style={grid} key={row}>
            {Array.from({ length: columns }, (_, column) => (
              <Bone
                key={column}
                w={`${cellWidths[(row + column * 2) % cellWidths.length]}%`}
              />
            ))}
          </div>
        ))}
      </>
    );
  } else if (variant === "card") {
    body = (
      <>
        <Bone w="42%" h={14} />
        <Lines count={clampCount(lines, 3, 12)} />
        <Bone w="96px" h={30} />
      </>
    );
  } else if (variant === "list") {
    body = Array.from({ length: clampCount(rows, 4, 40) }, (_, row) => (
      <div className="ui-skeleton-item" key={row}>
        <i className="ui-skeleton-bone ui-skeleton-dot" aria-hidden="true" />
        <div>
          <Bone w={`${lineWidths[(row + 1) % lineWidths.length] - 18}%`} />
          <Bone w={`${cellWidths[row % cellWidths.length]}%`} h={8} />
        </div>
      </div>
    ));
  } else if (variant === "drawer") {
    body = (
      <>
        <div className="ui-skeleton-drawer-head">
          <Bone w="48%" h={18} />
          <Bone w="30%" h={10} />
        </div>
        <div className="ui-skeleton-tabs">
          <Bone w="74px" h={14} />
          <Bone w="104px" h={14} />
          <Bone w="64px" h={14} />
        </div>
        <Bone h={92} />
        <Lines count={4} />
        <Bone h={64} />
        <Lines count={3} />
      </>
    );
  } else {
    body = <Bone />;
  }
  const style: CSSProperties = {};
  if (variant === "line" || variant === "block") {
    if (width !== undefined) style.width = width;
  }
  if (variant === "block") style.height = height ?? 120;
  return (
    <div
      className={`ui-skeleton ui-skeleton-${variant} ${className}`.trim()}
      style={style}
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">{label}</span>
      {body}
    </div>
  );
}
