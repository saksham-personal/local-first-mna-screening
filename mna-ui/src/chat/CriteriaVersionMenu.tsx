import { useEffect, useState } from "react";
import { DropdownMenu, Tooltip } from "radix-ui";
import { ChevronDown } from "lucide-react";
import type { ChatState } from "../lib/chat-contract";
import { readCriteriaHistory } from "../lib/review-client";
import { formatDateTime } from "../lib/format";
import Skeleton from "../ui/Skeleton";
import CriteriaVersionWindow from "./CriteriaVersionWindow";
import { mapCriteriaVersions, type CriteriaVersion } from "./criteria-versions";
import "./criteria.css";

export default function CriteriaVersionMenu({ state }: { state: ChatState }) {
  const [open, setOpen] = useState(false), [versions, setVersions] = useState<CriteriaVersion[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState<CriteriaVersion>();
  useEffect(() => {
    if (!open || !state.backendRunId) return;
    let cancelled = false;
    setLoading(true); setError(""); setVersions([]);
    void readCriteriaHistory(state.sessionId, state.backendRunId).then(result => {
      if (!Array.isArray(result.revisions)) throw new Error("Criteria history was unavailable.");
      if (!cancelled) setVersions(mapCriteriaVersions(result.revisions as Record<string, unknown>[]));
    }).catch(caught => { if (!cancelled) setError(String(caught)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, state.sessionId, state.backendRunId, state.revision, state.durableCriteria?.digest, state.approvedRevision]);
  return <>
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger className="cv-trigger" disabled={!state.backendRunId} aria-label={`Criteria versions, current v${state.revision}`}>v{state.revision}<ChevronDown size={13} /></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="cv-menu" sideOffset={6} collisionPadding={12}>
        {loading ? <Skeleton variant="list" label="Loading criteria versions" /> : error ? <p role="alert">{error}</p> : versions.length === 0 ? <p>No saved versions yet.</p> : <Tooltip.Provider delayDuration={250}>{versions.map(version => <Tooltip.Root key={version.revision}>
          <Tooltip.Trigger asChild><DropdownMenu.Item className="cv-item" onSelect={() => { setOpen(false); setSelected(version); }}>
            <span className="cv-item-title"><strong>v{version.revision}</strong><span className={`cv-status cv-status-${version.status.toLowerCase()}`}>{version.status}</span></span>
            <small>Started {formatDateTime(version.createdAt)}</small><small>Ended {version.endedAt ? formatDateTime(version.endedAt) : "current"}</small>
            {version.approvedAt && <small>{version.approvedBy} · Approved {formatDateTime(version.approvedAt)}</small>}
          </DropdownMenu.Item></Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Content className="cv-preview" side="right" sideOffset={8} collisionPadding={12}><strong>Criteria v{version.revision} · {version.status}</strong><p>{version.criteriaText}</p><Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal>
        </Tooltip.Root>)}</Tooltip.Provider>}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {selected && <CriteriaVersionWindow version={selected} sessionId={state.sessionId} onClose={() => setSelected(undefined)} />}
  </>;
}
