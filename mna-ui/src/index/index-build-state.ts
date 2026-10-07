import type { BuildStep, IndexBuild, StepStatus } from "./index-build-client";

export function isActiveBuild(build: Pick<IndexBuild, "status"> | null | undefined) {
  return build?.status === "queued" || build?.status === "running";
}
export function stepPercent(step: BuildStep) {
  if (step.status === "done" || step.status === "skipped") return 100;
  if (step.status === "pending") return 0;
  return step.rows_total && step.rows_total > 0 ? Math.max(0, Math.min(100, 100 * step.rows_done / step.rows_total)) : 0;
}
export function overallPercent(steps: BuildStep[]) {
  const major: Record<string, number> = { store_rows: 50, keyword_index: 20, semantic_embeddings: 20 };
  const others = steps.filter(step => !(step.id in major)).length;
  return Math.round(steps.reduce((sum, step) => sum + stepPercent(step) * (major[step.id] ?? (others ? 10 / others : 0)) / 100, 0));
}
export function etaText(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return "under a minute left";
  return `about ${Math.ceil(seconds / 60)} min left`;
}
export function buildEtaText(build: IndexBuild) {
  const current = build.steps.find(step => step.id === build.current_step && step.status === "running")
    ?? build.steps.find(step => step.status === "running");
  return isActiveBuild(build) ? etaText(current?.eta_seconds) : "—";
}
export function elapsedText(start: string | null | undefined, end?: string | null, now = Date.now()) {
  if (!start) return "—";
  const seconds = Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  const safe = Math.max(0, seconds);
  return safe < 60 ? `${safe}s` : `${Math.floor(safe / 60)}m ${safe % 60}s`;
}
export function stepPresentation(status: StepStatus) {
  const states = {
    pending: { icon: "circle", label: "Waiting" }, running: { icon: "spinner", label: "Running" },
    done: { icon: "check", label: "Done" }, skipped: { icon: "minus", label: "Skipped" }, failed: { icon: "x", label: "Failed" },
  };
  return states[status];
}
export function defaultBundleName(filename: string, now = new Date()) {
  const name = filename.replace(/\.xlsx$/i, "").replace(/[_-]+/g, " ").trim();
  if (!name || /^(?:mid|data|export|workbook|book\d*|companies|index|sheet\d*)(?:\s*\(\d+\))?$/i.test(name)) {
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return `MID ${date}`;
  }
  return name.slice(0, 120);
}

/** Plain-English build status for finished builds. */
export function buildStatusText(status: string): string {
  return ({ queued: "Starting", running: "Running", succeeded: "Completed", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted by a restart" } as Record<string, string>)[status] ?? status;
}
