import { useMemo, useState } from "react";
import { formatDuration, recordedSpan } from "../lib/session-trajectory";
import SelectField from "../ui/SelectField";
import type { SessionEvent } from "../lib/session-contract";

type SessionTimingProps = {
  events: readonly SessionEvent[];
  selectedId?: string;
  onSelect: (event: SessionEvent) => void;
};
const clock = (value: number) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 1,
  });

export default function SessionTiming({
  events,
  selectedId,
  onSelect,
}: SessionTimingProps) {
  const [scope, setScope] = useState("turn");
  const turnId =
    events.find((event) => event.id === selectedId)?.turnId ??
    events.filter((event) => event.turnId).at(-1)?.turnId;
  const projection = useMemo(() => {
    const focused =
      scope === "turn" && turnId
        ? events.filter((event) => event.turnId === turnId)
        : events;
    const spans = focused
      .map(recordedSpan)
      .filter((span) => span !== undefined);
    if (!spans.length) return undefined;
    const first = Math.min(...spans.map((span) => span.start));
    const last = Math.max(...spans.map((span) => span.finish ?? span.start));
    const range = Math.max(last - first, 1);
    return { spans, first, last, range };
  }, [events, scope, turnId]);

  return (
    <section className="sl-timing" aria-label="Session timing overview">
      <div className="sl-timing-heading">
        <div>
          <strong>Timing overview</strong>
          <span>Recorded event times · select a span to inspect</span>
        </div>
        <SelectField
          label="Timing range"
          value={scope}
          onChange={setScope}
          options={[
            { value: "turn", label: "Selected turn" },
            { value: "all", label: "All events" },
          ]}
        />
      </div>
      <div className="sl-timing-legend" aria-label="Timing colors">
        {[
          ["message", "Messages"],
          ["tool", "Tools"],
          ["approval", "Approvals"],
          ["artifact", "Files and results"],
          ["error", "Errors"],
        ].map(([kind, label]) => (
          <span key={kind} className={`sl-legend-${kind}`}>
            <i aria-hidden="true" />
            {label}
          </span>
        ))}
      </div>
      {projection ? (
        <div className="sl-timing-scroll">
          <div className="sl-timing-axis" aria-hidden="true">
            <span>{clock(projection.first)}</span>
            <span>{clock(projection.first + projection.range / 2)}</span>
            <span>{clock(projection.last)}</span>
          </div>
          <div className="sl-timing-lanes">
            {projection.spans.map(({ event, start, finish, durationMs }) => {
              const left =
                ((start - projection.first) / projection.range) * 100;
              const width =
                durationMs === undefined
                  ? 0
                  : Math.max((durationMs / projection.range) * 100, 0.7);
              const unknown =
                event.status === "running"
                  ? "In progress"
                  : event.kind === "tool"
                    ? "Finish not recorded"
                    : "Recorded";
              const tooltip =
                durationMs === undefined
                  ? `${event.title} · ${clock(start)} · ${unknown.toLowerCase()}`
                  : `${event.title} · ${clock(start)}–${clock(finish!)} · ${formatDuration(durationMs)}`;
              return (
                <button
                  key={event.id}
                  type="button"
                  className={`sl-timing-lane sl-timing-${event.kind} sl-timing-status-${event.status}${selectedId === event.id ? " is-selected" : ""}`}
                  onClick={() => onSelect(event)}
                  title={tooltip}
                  aria-label={tooltip}
                  aria-pressed={selectedId === event.id}
                >
                  <span className="sl-timing-lane-label">
                    {event.toolName || event.title}
                  </span>
                  <span className="sl-timing-track">
                    <span
                      className={`sl-timing-span${durationMs === undefined ? " is-point" : ""}${event.status === "running" ? " is-running" : ""}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  </span>
                  <span className="sl-timing-duration">
                    {durationMs === undefined
                      ? unknown
                      : formatDuration(durationMs)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="sl-timing-empty">
          Recorded timing will appear when this session has events.
        </p>
      )}
    </section>
  );
}
