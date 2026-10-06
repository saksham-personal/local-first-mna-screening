import { useState, useSyncExternalStore } from "react";
import { Check } from "lucide-react";
import type { ArtifactAction } from "../lib/chat-contract";
import {
  getBackgroundJobForPlan,
  subscribeBackground,
  type BackgroundJob,
} from "../lib/background-client";
import { plural } from "../lib/format";
import type { PreparedScreening } from "../lib/screening-contract";
import "./start-in-background.css";

const stateLabels: Record<BackgroundJob["state"], string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  error: "Needs attention",
  blocked: "Blocked",
};

/** What the saved setup's run is doing, in a few words. */
function describe(job: BackgroundJob): string {
  if (job.state === "blocked")
    return job.message || "Provider unavailable. Nothing was sent.";
  const label = stateLabels[job.state];
  return job.total > 0
    ? `${label} · ${job.completed} of ${plural(job.total, "batch", "batches")}`
    : label;
}

/**
 * "Start in background" for a saved screening setup. Once the run exists the
 * button turns into a disabled "Started" and the run's status shows beside it;
 * pausing, resuming and staging stay in the Activity dock.
 */
export default function StartInBackground({
  artifactId,
  prepared,
  onAction,
}: {
  artifactId: string;
  prepared: PreparedScreening;
  onAction: (action: ArtifactAction) => void | Promise<void>;
}) {
  const planId = prepared.planId ?? prepared.id;
  const job = useSyncExternalStore(
    subscribeBackground,
    () => getBackgroundJobForPlan(planId),
    () => undefined,
  );
  const [starting, setStarting] = useState(false);
  const label = starting
    ? "Starting…"
    : job
      ? job.state === "blocked"
        ? "Blocked"
        : "Started"
      : "Start in background";
  return (
    <div className="ca-action-row ca-start-row">
      <button
        type="button"
        className="ca-primary-action"
        disabled={starting || !!job}
        onClick={() => {
          setStarting(true);
          void Promise.resolve(
            onAction({ type: "start-screening", artifactId }),
          ).finally(() => setStarting(false));
        }}
      >
        {job && job.state !== "blocked" && <Check size={13} aria-hidden="true" />}
        {label}
      </button>
      {(starting || job) && (
        <span
          className={`ca-run-status ca-run-${job?.state ?? "queued"}`}
          role="status"
        >
          <i aria-hidden="true" />
          {job ? describe(job) : "Sending to the background runner"}
        </span>
      )}
    </div>
  );
}
